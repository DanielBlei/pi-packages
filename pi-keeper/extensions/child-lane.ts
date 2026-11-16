/**
 * The lane line: a short, concrete statement of what THIS subagent child can
 * and cannot do, appended to the child prompt (index.ts, before_agent_start).
 *
 * The split, locked by tests/unit/child-prompts.test.ts and
 * tests/integration/child-lanes.test.ts:
 * - the child prompt (prompts/child-<mode>.md) holds only what is true in
 *   every lane of its mode: what runs freely and which actions are gated;
 * - this line holds everything that depends on the relay or the tools: what
 *   happens to a gated action (asked through the parent's user, by relay or
 *   by the parent's mailbox for a background child, or denied),
 *   the retry guidance, and the mutation tools the child actually has.
 * The deny messages (ask() without a relay, denyReason for a child) reuse the
 * same lane names and phrases, so a denial reads like the lane line made
 * specific to one call, and the model stops after one attempt instead of
 * probing edit -> bash -> write -> path variants.
 *
 * Free of pi types so it is testable (like config.ts).
 */

import type { ChildMode } from "./modes.ts";

/** Tools that change things; the lane line names the ones the child has. */
const MUTATION_TOOLS = ["edit", "write", "bash", "powershell"] as const;

export interface LaneOptions {
	/** The child's effective mode (already resolved: child-auto.ts / child-default.ts may have picked it). */
	readonly mode: ChildMode;
	/** Whether the child's asks can reach the parent's user through a UI relay (a foreground child). */
	readonly relay: boolean;
	/** Whether a relay-less (background) child files its asks in the parent's mailbox instead (ask-mailbox.ts). Default false. */
	readonly parentAsks?: boolean;
	/** The tools active in the child session (pi.getActiveTools()). */
	readonly activeTools: readonly string[];
}

/** The mutation tools the child actually has, in a stable order. */
export function mutationToolsOf(activeTools: readonly string[]): string[] {
	return MUTATION_TOOLS.filter((tool) => activeTools.includes(tool));
}

/** "edit, write and bash" / "edit and write" / "edit" — named tools for the deny sentences. */
function listNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The lane name, shared by the lane line and the deny messages. */
export function childLaneName(mode: ChildMode, relay: boolean, parentAsks = false): string {
	if (mode === "plan") return "read-only plan child";
	if (relay) return `${mode} child with a relay`;
	return parentAsks ? `${mode} background child` : `${mode} child with no relay`;
}

/** How a denied action is escalated: report or contact_supervisor (never a retry, never a probe). */
const ESCALATION =
	'Put what you needed in your final report, or ask the parent with contact_supervisor (reason "need_decision") if it is available.';

/** "do not probe" — the sentence that stops edit -> bash -> write -> path probing after a denial. */
const NO_PROBE = "do not retry, and do not probe another tool or another path, the gate is the same for all of them";

/** What a relayed rejection means: the relay lanes' counterpart of NO_PROBE. */
const REJECTED = "The user may approve or decline each ask. If an ask is rejected, do not retry it or probe variants; if the rejection has a note, follow the note, otherwise continue without that call.";

/** The same for a background child: no note comes back, and an ask nobody answers in time is denied. */
const DECLINED = "The user may approve or decline each ask. If one is declined or goes unanswered, continue without that call: do not retry it or probe variants, and say in your report what you skipped.";

/**
 * The lane line for a subagent child, or "" when the inputs say nothing
 * (a mode with no tools that change anything still gets its read-only lane).
 */
export function childLaneLine({ mode, relay, parentAsks = false, activeTools }: LaneOptions): string {
	const relayed = relay || parentAsks;
	const outcome = relay ? REJECTED : DECLINED;
	const name = childLaneName(mode, relay, parentAsks);
	const tools = mutationToolsOf(activeTools);
	const writeTools = tools.filter((tool) => tool === "edit" || tool === "write");
	const shellTools = tools.filter((tool) => tool === "bash" || tool === "powershell");
	const shell = shellTools[0] ?? "commands";
	const writesLine =
		writeTools.length > 0
			? `File edits and writes (${listNames(writeTools)}) are denied everywhere except the scratch dir named below and your own report artifact.`
			: "You have no file-writing tools.";

	if (mode === "plan") {
		const asks = relayed
			? `Non-read-only ${shell}, first reads outside the working directory and secrets ask, relayed to the parent's user, who is told to approve only what gathers context for the plan. ${outcome}`
			: `Non-read-only ${shell}, first reads outside the working directory and secrets are denied too (no interactive user): ${NO_PROBE}. ${ESCALATION}`;
		return `Your lane: ${name}. Reading, searching and read-only ${shell} run freely. ${writesLine} ${asks}`;
	}

	if (mode === "default") {
		if (relayed) {
			return `Your lane: ${name}. Mutations, secrets and first reads outside the working directory ask first: the permission dialog is relayed to the parent's user, exactly as if the parent had called the tool. ${outcome} What runs without asking: reading, searching, read-only ${shell}, project-allowed commands, session-remembered prefixes, the scratch dir named below and your own report artifact. Name files from the working directory instead of \`cd\`-ing into it; for a second tree ask once for its directory, and that answer covers every command in it.`;
		}
		const mutations =
			writeTools.length > 0 && shellTools.length > 0
				? `Every mutation — ${writeTools.join(", ")} and non-read-only ${shell} — is denied, for every path: ${NO_PROBE}.`
				: writeTools.length > 0 || shellTools.length > 0
					? `Every mutation (${writeTools.length > 0 ? listNames(writeTools) : `non-read-only ${shell}`}) is denied, for every path: ${NO_PROBE}.`
					: "";
		const opening = [`Your lane: ${name}.`, mutations].filter((part) => part !== "").join(" ");
		const reads = mutations === ""
			? "First reads outside the working directory and secrets are denied: do not retry them."
			: "First reads outside the working directory and secrets are denied too.";
		return `${opening} ${reads} What still runs: reading, searching, read-only ${shell}, project-allowed commands, the scratch dir named below and your own report artifact. Stage deliverables in the scratch dir and list them in your report. ${ESCALATION}`;
	}

	// auto
	const guarded = relayed
		? "Dangerous commands, secrets, protected paths (.git, .pi, shell rc files, tool configuration), writes and destructive commands outside the working directory, and first reads outside it still ask, relayed to the parent's user. " + outcome
		: `Dangerous commands, secrets, protected paths (.git, .pi, shell rc files, tool configuration), writes and destructive commands outside the working directory, and first reads outside it are denied instead (fail-closed): do not retry, and do not probe variants, the gate is the same for all of them. ${ESCALATION}`;
	return `Your lane: ${name}. Edits and commands inside the working directory run without asking — inside it, deleting and overwriting has no undo. ${guarded}`;
}

/**
 * The one-sentence parent hint: what the children this session can launch
 * can and cannot do, appended to the parent's mode prompt when the subagent
 * tool is active. Kept to a single sentence per mode so it never bloats the
 * prompt; the lane line carries the details inside each child.
 */
export function parentLaneHint(mode: "plan" | "default" | "auto", backgroundAuto: boolean, backgroundAsks = false): string {
	// One sentence on purpose (a test pins the single period): what a child may do, then how to fan out.
	const fanOut = 'for a scripted fan-out pass the source inline as `options: { script: "…" }` — a fenced ```js workflow block is dropped once the reply has already made a tool call';
	if (mode === "plan") {
		return `Subagents you launch stay read-only like you (scout = explorer, worker = implementer), whatever tools their agent lists; their findings come back in their reports, and ${fanOut}.`;
	}
	const background = backgroundAsks
		? "background (async) children ask the user through this session like foreground ones, so a gated call may wait for an answer"
		: backgroundAuto
			? "background (async) children run in the auto lane and can write inside this directory"
			: "background (async) children have every mutation denied (no relay): they stage work in their scratch dir and report it, so copy it in yourself or launch them foreground";
	return `Subagents you launch: scout = explorer, worker = implementer, reviewer = checker; each runs in its lane below whatever tools its agent lists, and ${background}; ${fanOut}.`;
}
