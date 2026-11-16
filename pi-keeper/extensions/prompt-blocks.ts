/**
 * The two channels of model-facing text, composed here so index.ts stays wiring
 * and so the strings can be unit-tested without pi (like rules-line.ts).
 *
 * Why two channels (docs/design.md, "Why the prefix is frozen"): the prompt must be
 * byte-identical on every run, or the prompt cache is flushed and, behind some
 * gateways, every later request of a session with signed thinking fails.
 * pi composes it from named sections and appends a delta when a section differs,
 * so anything that varies per mode or per grant cannot live there. It goes into
 * the conversation instead, as a hidden (`display: false`) custom message that
 * pi persists and providers render as a user turn:
 *
 * - `pi-keeper-mode`: prompts/<mode>-mode.md, the plan-file line, the parent
 *   lane hint, the mode's closing instruction and the user's rules line. Re-sent
 *   whole when any of it changes, a session grant included: the contract says the
 *   newest mode message wins, so a message must never carry only part of it.
 * - `pi-keeper-rules`: the rules line on its own, for a subagent child only
 *   (its mode text is in its forced prompt).
 *
 * Both are also re-sent when a compaction swallowed them: a custom message can be
 * summarized away, the system message cannot (pi snapshots it into the compaction
 * entry). index.ts compares against the branch to decide; nothing is persisted.
 */

import { CONTRACT, RTK_INSTALLED, searchHint, type ModeName } from "./modes.ts";

/**
 * A rough token count for prompt text, for `scripts/prompt-weight.ts` and its cap
 * test. pi sizes its own context with the same characters/4 rule, so this is a
 * comparable number rather than a second truth; anything it prints is labelled as
 * an estimate.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** `customType` of the mode message. */
export const MODE_MESSAGE = "pi-keeper-mode";
/** `customType` of the user-rules message. */
export const RULES_MESSAGE = "pi-keeper-rules";

/**
 * The todo path: the same sentence for every model, parent and child. One home —
 * contractSection() appends it for parents, childTail() for subagents — so it is
 * not restated in prompts/*.md. Hedged rather than conditional: rpiv-todo's `todo`
 * tool is active wherever it is installed, but checking for it would make the
 * constant section depend on the tool set.
 */
export const TODO_PATH =
	"If you have a `todo` tool: for a task with more than one step, write the steps with it before you start, keep exactly one in progress, and mark each done as you finish it. That list is how the user follows you.\nA subagent builds its own list from its brief, not from its parent's.";

/** One line instead of nothing, if prompts/contract.md cannot be read (an empty section is itself a prompt change). */
export const CONTRACT_FALLBACK = "You work under pi-keeper, a permission layer around pi. The newest `pi-keeper` message in this conversation states your current mode and your user's rules.";

/** One line instead of nothing, if prompts/<mode>-mode.md cannot be read. */
export function fallbackModeText(mode: ModeName): string {
	return `You are in ${mode} mode. The rules in this message are the current ones.`;
}

/** Where the mode text and the user's rules live (config `modeInstructions`, fixed per session). */
export type Placement = "message" | "prompt";

/** The contract's `{{placement}}` paragraph: where the varying text arrives and which copy counts. */
export const PLACEMENT_TEXT: Record<Placement, string> = {
	message:
		"Your current mode and your user's rules arrive as `pi-keeper` messages in\nthis conversation, not in this prompt. The newest one that states a mode (it\nstarts with a `# … mode` heading) sets your mode; earlier mode text is void.",
	prompt:
		"Your current mode and your user's rules are below, in this prompt. A later\n`pi-keeper` message in the conversation that states a mode overrides them.",
};

/**
 * The constant part: our only addition to the system prompt (pi appends it as a section after its own).
 * `rtk` picks the search nudge (see `searchHint`); it defaults to whether rtk is installed, read
 * once per process, so the section stays byte-identical for the session.
 */
export function contractSection(placement: Placement = "message", rtk: boolean = RTK_INSTALLED): string {
	const contract = CONTRACT === "" ? CONTRACT_FALLBACK : CONTRACT.replace("{{placement}}", PLACEMENT_TEXT[placement]);
	return [contract, searchHint(rtk), TODO_PATH].join("\n\n");
}

/** What a subagent child gets appended to its own prompt (it has no system-prompt section). */
export function childTail(rtk: boolean = RTK_INSTALLED): string {
	return [searchHint(rtk), TODO_PATH].join("\n\n");
}

/** The one statement of the plan path and the write rule; the plan prompt points at "the plan file line". */
export function planFileLine(path: string): string {
	return `Plan file: ${path}\nThis is the ONLY project file you may edit or write. If it does not exist yet, create it with the \`write\` tool (do not read it first).`;
}

export interface ModeBlockInput {
	readonly modeText: string;
	readonly mode: ModeName;
	/** Plan mode only. */
	readonly planFile?: string;
	/** Parent with the `subagent` tool active; one sentence about the roles and lanes. */
	readonly laneHint?: string;
	/** The session's scratch dir (the contract refers to it). */
	readonly scratch?: string;
	/** The re-entry or left-plan note, set by the switch that produced it. */
	readonly notes?: string;
	/** The closing instruction of the mode (MODE_ANNOUNCEMENTS). */
	readonly tail: string;
}

/** The mode message: everything that changes when the mode changes. */
export function modeBlock({ modeText, mode, planFile, laneHint, scratch, notes, tail }: ModeBlockInput): string {
	return [
		modeText === "" ? fallbackModeText(mode) : modeText,
		planFile === undefined ? "" : planFileLine(planFile),
		laneHint ?? "",
		scratch ?? "",
		notes ?? "",
		tail,
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** The rules message, or "" when the user has no rules in this mode (nothing is sent then). */
export function rulesBlock(rulesLine: string): string {
	return rulesLine;
}

/** What the last delivered message already told the model, stored on the entry (`details`). */
export interface DeliveryDetails {
	/** Fingerprint of the mode part: mode text + plan file + lane hint + note + tail. */
	mode: string;
	/** The rules line that was delivered with it, "" when the user had none. */
	rules: string;
}

export interface Delivery {
	customType: string;
	content: string;
	/** `display: false`: the model reads it, the transcript UI does not show it. */
	display: false;
	details: DeliveryDetails;
}

export interface NextDeliveryInput {
	/** The mode part. Empty for a subagent child, whose mode text is in its own prompt. */
	readonly mode: string;
	/** The user-rules line for this session, "" when there is none. */
	readonly rules: string;
	/** What the newest delivered message carried, if any survived the latest compaction. */
	readonly last: DeliveryDetails | undefined;
}

/**
 * What (if anything) to append: nothing while the model already has the current text,
 * else the whole block — a session grant included, so the newest mode message always
 * carries the mode. A child (no mode text) only ever gets the rules line. Pure, so the
 * change tracking is unit-tested rather than inferred from the transcript.
 */
export function nextDelivery({ mode, rules, last }: NextDeliveryInput): Delivery | undefined {
	if (last !== undefined && last.mode === mode && last.rules === rules) return undefined;
	// a subagent child has no mode text of its own: anything it gets is the user's rules
	if (mode === "") return rules === "" ? undefined : { customType: RULES_MESSAGE, content: rules, display: false, details: { mode, rules } };
	const content = [mode, rules].filter((part) => part !== "").join("\n\n");
	if (content === "") return undefined;
	return { customType: MODE_MESSAGE, content, display: false, details: { mode, rules } };
}
