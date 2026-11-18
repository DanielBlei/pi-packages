/**
 * pi-keeper
 *
 * Permission modes for Pi, cycled with Ctrl+Shift+M (or
 * Alt+M):  default -> auto -> plan -> default
 *
 * - default: reads, read-only bash and read-only (MCP-annotated) tools run;
 *            everything else asks (Yes / Yes, and don't ask again this session /
 *            Yes, and always allow in this project / No, more under "More…")
 * - auto:    everything runs, except dangerous commands, protected paths,
 *            and paths outside the cwd, which ask
 * - plan:    read-only allowlist; only the session plan file is writable;
 *            the model calls exit_plan_mode to ask for approval
 *
 * Privilege escalation (sudo, su, doas, ...) is denied in every mode.
 * Rules and command lists live in modes.ts; evaluation in rules.ts;
 * command analysis in utils.ts.
 *
 * The model is kept mode-aware by a hidden mode message in the conversation
 * (prompts/<mode>.md, the plan file line, the user's rules, the lane hint),
 * appended when it changes and steered on a switch in the middle of a run, so
 * earlier denials are explicitly superseded. The system prompt itself is
 * constant (prompts/contract.md only): a change there flushes the prompt cache
 * and, behind some gateways, fails every later request of a session with
 * signed thinking (docs/design.md, "Why the prefix is frozen").
 *
 * pi-subagents children: the parent registers child-plan.ts or
 * child-default.ts as a required child extension (subagents-bridge.ts), which
 * loads this file with `childMode` set. A child has a forced mode (plan or
 * default; the background-auto-fallback setting can make a relay-less child auto), no
 * switching, no plan file and no prompts. A child has
 * no UI of its own: its asks are relayed to the parent's user through the UI
 * relay (ui-relay.ts) when the parent has one, and denied when it doesn't (a
 * background child runs in another process and never sees the relay; it files
 * its asks in the session's mailbox instead, which the parent answers with its
 * own rules and dialogs, see ask-server.ts). The `subagent` tool is denied
 * unless that bridge works.
 */

import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
	BUILTIN_SEARCH_TOOLS,
	BUILTIN_TOOLS_FLAG,
	CHILD_PROMPTS,
	CONTRACT,
	EXIT_PLAN_TOOL,
	GLOBAL_RULES,
	MANAGED_TOOLS,
	MODE_ANNOUNCEMENTS,
	CHILD_PROTOCOL_TOOLS,
	MODE_CHANGE_NOTICES,
	MODE_CYCLE,
	MODES,
	PRIVILEGE_REASON,
	formatModeStatus,
	LAUNCH_TOOLS,
	SUBAGENT_LAUNCH_TOOL,
	type ChildMode,
	type ModeName,
} from "./modes.ts";
import { childLaneLine, childLaneName, parentLaneHint } from "./child-lane.ts";
import { childThinkingLevel, isThinkingLevel, SUBAGENT_THINKING_MODES, type SubagentThinkingMode, type ThinkingLevelName } from "./thinking.ts";
import {
	contractSection,
	childTail,
	modeBlock,
	planFileLine,
	MODE_MESSAGE,
	nextDelivery,
	rulesBlock,
	RULES_MESSAGE,
	type Delivery,
	type DeliveryDetails,
} from "./prompt-blocks.ts";
import {
	commandOf,
	coveringPatterns,
	evaluate,
	launchNestedCalls,
	launchNestedHazards,
	LOCKABLE_TOOLS,
	lockApprovedInput,
	pathOf,
	patternString,
	SEVERITY,
	type Decision,
	type EvalContext,
	type ToolHints,
	type ToolCall,
	verbatimKey,
} from "./rules.ts";
import {
	approvalBreakdown,
	commandEffects,
	createScratchDir,
	deriveCommandPrefixes,
	exactRuleTokens,
	formatBreakdown,
	isCoveredByPrefixes,
	outsideCwdReadPaths,
	readGrantDir,
	fetchGrantHosts,
	hasRemoval,
	gitGrantRoots,
	gitRepoRootOf,
	isSubagentOutputPath,
	patternLadder,
	scopeSuffix,
	secretSearchHits,
	secretUploads,
	planCommandPrefixes,
	skillDirsFromPrompt,
	viaRtkToo,
	type CoverSource,
	type PathContext,
	type PatternChoice,
} from "./utils.ts";
import {
	compilePermissions,
	exactRuleFor,
	readDirRuleFor,
	fetchRuleFor,
	parseFetchHost,
	parseVerbatim,
	verbatimRuleFor,
	fileSignature,
	findMatchingRule,
	loadProjectRules,
	parseAllowedTools,
	parsePattern,
	parseRule,
	recordTrust,
	removeRule,
	ruleFor,
	RULES_FILE,
	rulesPath,
	saveRules,
	isInsideDir,
	sha256,
	trustedHash,
	type LoadedRules,
	type ParsedRule,
	type ProjectPermissions,
	type RuleList,
} from "./project-rules.ts";
import {
	correctionText,
	firedFromBranch,
	loadRulebook,
	matchRules,
	ruleKey,
	userRuleDir,
	ensureUserRuleDir,
	RULE_FIRED_ENTRY,
	RULE_MESSAGE,
	RULES_PER_RUN_CAP,
	type LoadedRulebook,
	type RulebookRule,
	type RuleFireRecord,
} from "./rulebook.ts";
import { rulesPanel, rulesText } from "./rules-view.ts";
import { childModeFor, registerChildMode, type BridgeRegistration } from "./subagents-bridge.ts";
import { askDirFor, type AskRequest } from "./ask-mailbox.ts";
import { askParent, canAskParent, parentListening, type AskParentOptions, type RelayResult } from "./remote-relay.ts";
import { askTtlMs, backgroundChildMode, badgeText, startAskServer, stricterMode, type AskServer, type AskServerOptions, type ServerEvent, type Verdict } from "./ask-server.ts";
import { createRtkRewriter, type CommandRewriter } from "./rtk-rewrite.ts";
import { countWork } from "./perf.ts";
import { isDialogLocked, withDialogLock } from "./dialog-lock.ts";
import { permissionDialog, selectModeDialog, setPreviewTextColor } from "./dialog.ts";
import { ccExtensionsStatus, ccSettingsPath, excludeExitPlanMode, type CcExtensionsStatus } from "./cc-extensions-compat.ts";
import { commandHighlighter } from "./shell-highlight-bridge.ts";
import { backgroundAsksEnabled, CONFIG_FILE, effectiveCommandColors, formatDuration, loadConfig, MAX_BACKGROUND_ASK_TIMEOUT_MS, MIN_BACKGROUND_ASK_TIMEOUT_MS, parseDuration, POPUP_MODES, PREVIEW_TEXT_COLORS, saveConfig, type BackgroundAskPopup, type KeeperConfig, type PreviewTextColor } from "./config.ts";
import { settingsPanel, type PanelItem, type PanelResult, type PanelSection } from "./settings-panel.ts";
import { asPlanDetails, PLAN_KEEP, PlanView, selectPlanAction, type PlanChoice, type PlanDetails } from "./plan-approval.ts";
import { childCwdProblem } from "./child-cwd.ts";
import { rulesLine } from "./rules-line.ts";
import { PARENT_SESSION_ENV, publishGrants, readParentGrants, sweepStaleGrants, withdrawGrants, type SessionGitRules } from "./session-grants.ts";
import { SessionGrants } from "./session-grant-store.ts";
import { findUiRelay, registerUiRelay, type UiRelay, type UiRelaySessionRules } from "./ui-relay.ts";
import {
	blankLine,
	commandLines,
	dialogTitle,
	prefixTitle,
	seg,
	titleFromPlain,
	type DialogTitle,
	type TitleSegment,
} from "./title.ts";
import { attentionSequence, type AttentionLabel } from "./attention.ts";
import {
	type ChoiceEvent,
	type ChoiceOutcome,
	logChoice,
	logDecision,
	logPattern,
	logPlanApproval,
	logRemoteMode,
	logRulesReview,
	logSession,
	redactCommand,
	targetOf,
} from "./telemetry.ts";
import {
	ALLOW_EDITS,
	ALLOW_EDITS_SHARED,
	ALLOW_ONCE,
	ALLOW_OUTSIDE_READS,
	dialogOptions,
	MORE,
	OTHER_PATTERN,
	REJECT_WITH_FEEDBACK,
	REMEMBER_EXACT,
	REMEMBER_EXACT_SHARED,
	PROJECT_EXACT,
	readGrantLabel,
	projectReadGrantLabel,
	fetchGrantLabel,
	projectFetchGrantLabel,
	gitGrantLabel,
	SWITCH_TO_AUTO,
} from "./options.ts";
import { DESCRIBE_COMMAND_LIMIT, previewFor, sanitizeForTerminal, type Preview } from "./preview.ts";

interface KeeperState {
	mode: ModeName;
	/** Session plan file (created on first entry into plan mode). */
	planFilePath?: string;
}

interface ToolCallBlock {
	block: true;
	reason: string;
	terminate?: boolean;
}

/** A command pattern to remember: a token prefix, or the whole command when `exact`. */
interface Pattern {
	tokens: readonly string[];
	exact: boolean;
}

/** `git commit *`, or `npm test (exact)`. */
function patternText(p: Pattern): string {
	return p.exact ? `${p.tokens.join(" ")} (exact)` : `${p.tokens.join(" ")} *`;
}

/**
 * The text blocks of an assistant message, joined. pi exposes no extractor, so
 * this is the one place a `turn_end` payload turns into the text the rulebook
 * matches; anything that is not an assistant message yields "".
 */
function assistantText(message: unknown): string {
	const content = (message as { role?: unknown; content?: unknown }).role === "assistant" ? (message as { content?: unknown }).content : undefined;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** A project rules file as last read, with the permissions it yields. */
interface ProjectState {
	file: string;
	/** Stat signature when read; a change triggers a re-read. */
	signature: string;
	loaded: LoadedRules;
	permissions: ProjectPermissions;
}

/**
 * Trusted rtk rewriter for approved bash commands, probed once at load.
 * Null when rtk is unavailable — approved commands then run unrewritten.
 */
let rewriter: CommandRewriter | null = null;

/**
 * Short hash of the text the model is told about modes and permissions (the
 * contract plus every mode prompt). Recorded once per session in the
 * telemetry, so two runs can be told apart after a prompt edit: challenges.md
 * asks for exactly this, and a prompt change is also a prompt-cache event.
 */
const PROMPT_VERSION = sha256([CONTRACT, ...MODE_CYCLE.map((mode) => MODES[mode].prompt), ...Object.values(CHILD_PROMPTS)].join("\n")).slice(0, 12);

/**
 * The system prompt of the current run, captured in `before_agent_start` (a
 * run can rebuild it). Its `<available_skills>` block names the skill files
 * the model was told to read, so those directories are readable
 * (`skillDirsFromPrompt`, `utils.ts`). Undefined outside a run: a read then
 * falls back to `ctx.getSystemPrompt()` once.
 */
let runSystemPrompt: string | undefined;
/** The parsed skill directories, cached by the prompt text they came from. */
let runSkillDirs: { prompt: string; dirs: string[] } | undefined;

/**
 * This session's thinking level, as published to children
 * (`subagent-thinking: follow` runs a child at the higher of its own level
 * and this one). Undefined until a level is known.
 */
let parentThinking: ThinkingLevelName | undefined;

/** The skill directories named by `prompt`, recomputed only when the prompt text changes. */
function skillDirsOf(prompt: string): readonly string[] {
	if (runSkillDirs?.prompt !== prompt) runSkillDirs = { prompt, dirs: skillDirsFromPrompt(prompt) };
	return runSkillDirs.dirs;
}

/** The current run's system prompt, or the harness's current one when no run has started yet. */
function currentSystemPrompt(ctx: ExtensionContext): string {
	if (runSystemPrompt !== undefined) return runSystemPrompt;
	try {
		return ctx.getSystemPrompt();
	} catch {
		// no prompt to read means no skill exemption: the read asks, which is the safe direction
		return "";
	}
}

const STATUS_KEY = "pi-keeper-mode";
/** The widget that shows the mode for a moment after a switch (above the prompt). */
const FLASH_KEY = "pi-keeper-mode-flash";
const STATE_ENTRY = "pi-keeper";
/** Status line showing how many background approvals wait. */
const ASKS_STATUS_KEY = "pi-keeper-asks";

const LOAD_RULES = "Load them";
const IGNORE_RULES = "Ignore for this session";

const PLAN_AUTO = "Yes, in auto mode";
const PLAN_MANUAL = "Yes, approving each edit";

const TYPE_PATTERN = "Type a pattern\u2026";
const SCOPE_SESSION = "For this session";
const SCOPE_PROJECT = "Always in this project";
const WAITING_MESSAGE = "Waiting for approval\u2026";
/** Most remembered "why it ran" notes (tool rows older than this lose their badge). */
const MAX_CALL_NOTES = 200;
const REMOVE = "Remove";
const CANCEL = "Cancel";
/** Most commands read from one exit_plan_mode call. */
const MAX_PLAN_COMMANDS = 50;
/** Longest list of commands in the plan-approval option label (the title has all of them). */
const PLAN_LABEL_COMMANDS_LIMIT = 70;
/** Most plan characters echoed to the model in the approval result (the plan file has the rest). */
const PLAN_ECHO_LIMIT = 100_000;
const PLAN_REJECTED_TEXT =
	"The user turned the plan down without comment. It was NOT approved and plan mode is still active. Stop here and wait for the user's next instruction.";
const PLAN_ABORTED_TEXT =
	"The plan review was cut off before the user decided. The plan was NOT approved and plan mode is still active. Stop here and wait for the user's next instruction.";
/** One sentence on how edits behave after approval, by the mode the plan runs in. */
const APPROVED_MODE_NOTE: Record<"auto" | "default", string> = {
	auto: "Edits and commands run without asking; only dangerous commands, protected paths, outside-the-project changes and secrets still ask.",
	default: "Each file edit or command outside the pre-approved ones shows the user a prompt; that is expected, so keep going.",
};
const NOT_IN_PLAN_MODE =
	"Plan mode is not active, so there is nothing to exit. This tool only ends plan mode once a plan is written. If a plan was already approved, carry on with the work.";
/** Appended to the plan-mode announcement when the plan file already has a plan (a second /plan in the session). */
const PLAN_REENTRY_NOTE =
	"This session already has a plan file with content. Read it first. Same task: update it and drop stale or done sections (some checkboxes may be ticked). Different task: overwrite it with a fresh plan. Edit the plan file before every exit_plan_mode call.";

const ASK_HINTS: Partial<Record<string, string>> = {
	dangerousBash: "Flagged as a potentially dangerous command.",
	protectedPath: "Protected path (repository or tool configuration).",
	outsideCwd: "Outside the working directory.",
	outsideCwdRead: "Reads outside the working directory.",
	outsideCwdBashWrite: "Writes outside the working directory.",
	outsideCwdDestructive: "Deletes or overwrites outside the working directory, or a target that can't be checked.",
	secretSearch: "A recursive search could read secret files (.env, private keys, credential files) that git does not track.",
	secretUpload: "Uploads a secret file (.env, private key, credential file).",
	unapprovedBash: "Plan mode: approve only if it is needed to gather context for the plan.",
	projectAsk: `Matches an ask rule in ${RULES_FILE}, or the file cannot be read or is not valid JSON (then every shell command asks until it is fixed).`,
	secretFile: "May expose secrets (.env, private keys, credential files).",
	secretBash: "May expose secrets (.env, private keys, credential files).",
};

/** Whether a file exists and holds more than whitespace. */
/** Tells the model a plan file that is not on disk yet must be created, not read (a read of it fails with ENOENT). */
function hasContent(file: string): boolean {
	try {
		return readFileSync(file, "utf8").trim() !== "";
	} catch {
		return false;
	}
}

function plansDir(): string {
	return join(getAgentDir(), "plans");
}

/** `<project>-<date>-<time>-<rand>.md` under ~/.pi/agent/plans. */
function makePlanFilePath(cwd: string): string {
	const now = new Date();
	const pad = (n: number): string => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const rand = Math.random().toString(16).slice(2, 6);
	const project = basename(cwd).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
	return join(plansDir(), `${project}-${date}-${time}-${rand}.md`);
}

/** The ask hint for a matcher; names the file for the secret searches and uploads. */
function askHint(match: string | undefined, command: string, paths: PathContext, detail?: string): string | undefined {
	if (match === undefined) return undefined;
	// a launch call that will run a command or write a file: name it, the call description does not
	if (match === "launchNested") return detail === undefined ? undefined : `The child leaves this behind: ${detail}.`;
	if (match === "secretSearch") {
		const hit = secretSearchHits(command, paths)[0];
		if (hit?.why === "secret") return `A recursive search would read the secret file \`${hit.path}\`.`;
		if (hit?.why === "limit") return `A recursive search over \`${hit.path}\` is too large to check for secret files.`;
		if (hit?.why === "unchecked") return "A recursive search path can't be checked for secret files.";
	}
	if (match === "secretUpload") {
		const file = secretUploads(command, paths)[0];
		if (file !== undefined) return `Uploads the secret file \`${file}\`.`;
	}
	return ASK_HINTS[match];
}

/**
 * Label, main part and — when the main part is a whole shell command — its language.
 * The main part (command, path, arguments) is what the dialog styles as a command; only a
 * real command gets a language, so the placeholder for a truncated command stays prose.
 */
function describeParts(call: ToolCall): { label: string; main: string; lang?: string } {
	if (call.toolName === "bash" || call.toolName === "powershell") {
		const command = commandOf(call.input);
		const lang = call.toolName === "powershell" ? "powershell" : "bash";
		return command.length > DESCRIBE_COMMAND_LIMIT
			? { label: `${call.toolName}: `, main: "(full command shown below)" }
			: { label: `${call.toolName}: `, main: command, lang };
	}
	// a workflow child: name the agent and the first line of its task, not the whole call input
	if (call.toolName === SUBAGENT_LAUNCH_TOOL) {
		const input = call.input as { key?: unknown; agent?: unknown; task?: unknown } | undefined;
		const key = typeof input?.key === "string" && input.key !== "" ? input.key : "child";
		const agent = typeof input?.agent === "string" && input.agent !== "" ? input.agent : "";
		const task = typeof input?.task === "string" ? input.task.trim().split("\n")[0] : "";
		const what = [agent, task].filter((part) => part !== "").join(" · ");
		return { label: `${key} (${agent === "" ? "subagent" : agent}): `, main: what.length > DESCRIBE_COMMAND_LIMIT ? `${what.slice(0, DESCRIBE_COMMAND_LIMIT)}\u2026` : what };
	}
	const path = pathOf(call.input);
	if (path !== "") return { label: `${call.toolName} `, main: path };
	const args = JSON.stringify(call.input ?? {});
	return { label: `${call.toolName} `, main: args.length > 200 ? `${args.slice(0, 200)}…` : args };
}
/** The directories an outside read would grant: one per path the call reads. Undefined when none can be named or any is too broad ("/", the home dir). */
function readGrantDirsOf(call: ToolCall, paths: PathContext): string[] | undefined {
	const targets = call.toolName === "bash" ? outsideCwdReadPaths(commandOf(call.input), paths) : [pathOf(call.input)];
	if (targets.length === 0) return undefined;
	const dirs = new Set<string>();
	for (const target of targets) {
		const dir = readGrantDir(target, paths.cwd);
		if (dir === undefined) return undefined;
		dirs.add(dir);
	}
	return [...dirs];
}

/** Short human-readable description of a tool call, for dialogs and reasons. */
function describe(call: ToolCall): string {
	const { label, main } = describeParts(call);
	return `${label}${main}`;
}

function parseMode(value: unknown): ModeName | undefined {
	if (value === "accept-edits") return "auto"; // renamed; migrate old sessions
	return typeof value === "string" && Object.hasOwn(MODES, value) ? (value as ModeName) : undefined;
}

/** Options of the child entry files (child-plan.ts, child-default.ts); pi itself calls the extension with just `pi`. */
export interface ExtensionOptions {
	/** Run as a pi-subagents child, forced into this mode. */
	childMode?: ChildMode;
	/** Test seams of the background-ask server: its timer, clock and pid check (parent only). */
	askServer?: Pick<AskServerOptions, "setTimer" | "now" | "alive" | "ttlMs">;
	/** Test seams of a background child's wait for its parent: poll interval, timeout and the parent liveness check. */
	remoteRelay?: Partial<Pick<AskParentOptions, "pollMs" | "timeoutMs" | "parentAlive">>;
}

/**
 * Set on globalThis by a child entry (child-*.ts). In a pi-subagents runner
 * process (PI_SUBAGENT_CHILD=1) pi also loads this package's index.ts as an
 * ambient extension when it is installed globally: that copy would gate the
 * child's calls a second time as a UI-less default-mode parent (denying
 * contact_supervisor, and every edit in a background-auto-fallback child). It stands
 * down while a child entry is loaded; without one it keeps gating (fail-closed).
 */
export const CHILD_GATE_KEY = Symbol.for("pi-keeper.child-gate.v1");

/** True for the ambient top-level copy in a runner process that has a child entry loaded. */
export function ambientCopyStandsDown(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1" && (globalThis as Record<symbol, unknown>)[CHILD_GATE_KEY] === true;
}

export default function keeperExtension(pi: ExtensionAPI, { childMode, askServer: askServerSeams, remoteRelay: relaySeams }: ExtensionOptions = {}): void {
	if (childMode !== undefined) {
		(globalThis as Record<symbol, unknown>)[CHILD_GATE_KEY] = true;
	} else if (process.env.PI_SUBAGENT_CHILD === "1") {
		// Checked per event, not at load: the child entry may load after this copy.
		const on = pi.on.bind(pi);
		pi = Object.assign(Object.create(pi), {
			on: (event: string, handler: (...args: unknown[]) => unknown) =>
				on(event as never, ((...args: unknown[]) => (ambientCopyStandsDown() ? undefined : handler(...args))) as never),
		}) as ExtensionAPI;
	}
	// Probe rtk once; until it resolves (or if unavailable) approved
	// commands simply run unrewritten.
	void createRtkRewriter(pi).then((probe) => {
		rewriter = probe;
	});

	let currentMode: ModeName = childMode ?? "default";
	/** Parent only: the registration that makes subagent children load this extension. */
	let bridge: BridgeRegistration | undefined;
	/** Parent only: the UI relay published for in-process subagent children. */
	let relayReg: { dispose(): void } | undefined;
	/** Parent only: answers the asks of background subagent children (ask-server.ts), and the context its callbacks use (rebound like the relay's). */
	let askServer: AskServer | undefined;
	let askCtx: ExtensionContext | undefined;
	let planFilePath: string | undefined;
	/** Last state written to the session, to append only on change. */
	let persistedState: string | undefined;
	/** Serializes permission dialogs (parallel tool calls). */
	let dialogQueue: Promise<unknown> = Promise.resolve();
	/** Project rules, re-read when the file changes (also mid-run). */
	let projectState: ProjectState | undefined;
	/** Rules fired this session, by name: the session entries are the truth, this is the fast copy (the rulebook itself is read once per turn and per prompt, see syncRulebook). */
	let firedRules = new Set<string>();
	/** Project rule files the user loaded or ignored this session (one key for the set), and whose problems were shown. */
	let rulebookReviewKey: string | undefined;
	let rulebookIgnoredKey: string | undefined;
	let rulebookWarnedKey: string | undefined;
	/** Rulebook files the user loaded this session, by path → content hash: their trust when the store cannot be written. */
	const rulebookApproved = new Map<string, string>();
	/** Fires in this run that asked for a continuation (bounded by RULES_PER_RUN_CAP). */
	let runFires = 0;
	/** Rules files (file + hash) the user loaded or ignored this session, and whose warnings were shown. */
	let approvedKey: string | undefined;
	let ignoredKey: string | undefined;
	let warnedKey: string | undefined;
	/** This session's scratch dir, created on first need and kept after exit; a new session gets a new one. */
	let scratchDir: string | undefined;
	/** This session's command, read and fetch grants; see session-grant-store.ts. */
	const grants = new SessionGrants();
	/** "Yes, allow all edits this session" (default mode): reset on session_start, like the grants. */
	let sessionEdits = false;
	/** Parent only: the session whose grants are published for background children, and what was last written. */
	let grantsSessionId: string | undefined;
	let publishedGrants: string | undefined;
	/** Parent only: this session's cwd, shared with children as their anchor (child-cwd.ts). */
	let sessionCwd: string | undefined;
	/** Child only: why its cwd is refused (then it is locked down), memoized by cwd and anchor. */
	let cwdCheck: { key: string; problem: string | undefined } | undefined;
	/** Child only: its asks go to the parent's mailbox (relay-less, background asks on, a live parent snapshot). Frozen at session_start with the lane line. */
	let parentAsks = false;
	/** Set by No: later asks in the same run are rejected without a dialog. */
	let rejectedThisRun = false;
	/** `allowed-tools` grants of the workflow command (prompt template) now running; cleared at agent_end and on the next user input. */
	let commandGrant: { name: string; rules: ParsedRule[] } | undefined;
	/** Why a bash call ran without a dialog, by toolCallId, for the tool-row badge. */
	const callNotes = new Map<string, string>();
	/** Tool annotations by name; refilled on a miss and on session/MCP changes. */
	let hintsCache = new Map<string, ToolHints | undefined>();
	/** `<agent dir>/pi-keeper.json`, re-read on session_start (defaults when absent). */
	let config: KeeperConfig = loadConfig(getAgentDir());
	setPreviewTextColor(config.commandColors);

	/**
	 * Who a call is judged and asked as. The session's own calls, and the calls of
	 * an in-process child (which runs this code in its own instance, its asks
	 * relayed to the parent's UI), use selfSubject(). A background child runs in
	 * another process: its asks arrive in the parent as requests (ask-server.ts)
	 * and are judged by remoteSubject(), the same as an in-process child with a
	 * relay would be, but with the parent's grants and UI. Decisions, dialog,
	 * grants and telemetry are one code path for all three; the subject says
	 * what differs.
	 */
	interface AskSubject {
		/** The mode the call is judged in. */
		readonly mode: ModeName;
		/** A subagent child's call: no switch to auto, no exact-command grant, "subagent" in the title. */
		readonly child: boolean;
		/** Where the call runs: the cwd checks, project rules, previews and project saves use it. */
		readonly cwd: string;
		/** The scratch dir the call may write, if the subject has one. */
		readonly scratchDir: string | undefined;
		readonly planFile: string | undefined;
		/** The parent's UI relay, for an in-process child: its grants are also written through to the parent. */
		readonly relay: UiRelay | undefined;
		/** The dialog surface; undefined = nobody to ask (the ask is denied). */
		readonly ui: AskUI | undefined;
		/** Closes the dialog when aborted. */
		readonly signal: AbortSignal | undefined;
		/** Set for a background child's request: answered in this session, grants go straight to it, and "No" never stops the parent's run. */
		readonly remote: { readonly label: string; readonly receivedAt: number } | undefined;
	}

	/** This session's own subject (live: the mode and scratch dir may change while a dialog is open). */
	function selfSubject(ctx: ExtensionContext): AskSubject {
		const relay = childMode !== undefined ? findUiRelay() : undefined;
		return {
			get mode() {
				return currentMode;
			},
			child: childMode !== undefined,
			cwd: ctx.cwd,
			get scratchDir() {
				return scratchDir;
			},
			get planFile() {
				return planFilePath;
			},
			relay,
			// a child asks through the relay or not at all; the parent through its own UI, when it has one
			ui: relay !== undefined ? relayUi(relay, ctx) : childMode === undefined && ctx.hasUI ? ctxUi(ctx) : undefined,
			get signal() {
				return ctx.signal;
			},
			remote: undefined,
		};
	}

	/**
	 * The paths a call may touch. `project` is passed in by the caller that already resolved
	 * the project rules (evalContext does, once per decision): resolving them again here would
	 * re-walk the directory tree to find the project root on every call.
	 */
	function pathContext(ctx: ExtensionContext, subject: AskSubject = selfSubject(ctx), project: ProjectPermissions = syncProject(subject).permissions): PathContext {
		// a child also honours the directories granted in the parent (a background request is judged with the parent's own grants)
		const shared = subject.remote === undefined ? sharedRules() : undefined;
		// ...and the project's trusted Read(<dir>/**) rules (realpath-checked again: the file is user-editable)
		const dirs = [...grants.outsideReadDirs, ...(shared?.outsideReadDirs ?? []), ...project.readDirs.flatMap((dir) => readGrantDir(dir, "/") ?? [])];
		// fetch grants: this session's, the parent's (a child), and the project's trusted Fetch(<host>) rules
		const hosts = [...grants.fetchHosts, ...(shared?.fetchHosts ?? []), ...project.fetchHosts];
		// git repos granted in this session, and the parent's (a child): git in them is judged like git in the cwd's repo
		const gitRepos = [...grants.gitRepos, ...(shared?.gitRepos ?? [])];
		return { cwd: subject.cwd, agentDir: getAgentDir(), planFile: subject.planFile, scratchDir: subject.scratchDir, outsideReadDirs: dirs, skillDirs: skillDirsOf(currentSystemPrompt(ctx)), fetchHosts: hosts, gitRepos };
	}

	/** The session scratch dir (0700 under the OS temp dir), created lazily; undefined if it can't be. */
	function ensureScratch(): string | undefined {
		if (scratchDir === undefined) {
			try {
				scratchDir = createScratchDir();
			} catch {
				// no scratch dir: scratch rules stay inactive
			}
		}
		return scratchDir;
	}

	function scratchLine(): string {
		const dir = ensureScratch();
		if (dir === undefined) return "";
		// a default child whose asks reach no one can write nowhere else: its lane line says to stage deliverables here
		const stagesHere = childMode === "default" && findUiRelay() === undefined && !parentAsks;
		return `Scratch dir: ${dir}\nYou may create and edit files there in any mode (notes, repros, cloned references).${stagesHere ? "" : " Don't put deliverables there."}`;
	}

	/** The child lane line, memoized: a child's mode, relay and tools are fixed for its session. */
	let laneCache: { key: string; line: string } | undefined;
	/** Child only: why this child's cwd is refused, or undefined (see child-cwd.ts). */
	function cwdProblem(ctx: ExtensionContext): string | undefined {
		if (childMode === undefined) return undefined;
		const anchor = sharedRules()?.cwd;
		// the env names a parent session: a missing anchor then means its grants are unreadable. Fail closed
		// only in auto, where nothing else stops work outside the project; in default and plan the child's
		// asks are denied anyway, and a nested child (whose parent publishes no snapshot) keeps reading.
		const parentExpected = currentMode === "auto" && (process.env[PARENT_SESSION_ENV] ?? "") !== "";
		const key = `${ctx.cwd}\0${anchor ?? ""}\0${parentExpected}`;
		if (cwdCheck?.key !== key) cwdCheck = { key, problem: childCwdProblem(ctx.cwd, anchor, undefined, parentExpected) };
		return cwdCheck.problem;
	}

	function laneLine(ctx: ExtensionContext): string {
		if (childMode === undefined) return "";
		const problem = cwdProblem(ctx);
		if (problem !== undefined) {
			return `Your lane: locked. ${problem[0].toUpperCase()}${problem.slice(1)}, so every tool call is denied except contact_supervisor and your report artifact: do not retry, and do not probe another tool or another path. Report this, and ask the parent to relaunch you inside its project.`;
		}
		const relay = findUiRelay() !== undefined;
		const tools = pi.getActiveTools();
		const key = `${childMode}:${relay}:${parentAsks}:${tools.join(",")}`;
		if (laneCache?.key !== key) laneCache = { key, line: childLaneLine({ mode: childMode, relay, parentAsks: !relay && parentAsks, activeTools: tools }) };
		return laneCache.line;
	}

	/** The one-sentence parent hint about the children this session can launch, memoized the same way. */
	let hintCache: { key: string; line: string } | undefined;
	function laneHint(): string {
		if (childMode !== undefined || !LAUNCH_TOOLS.some((name) => pi.getActiveTools().includes(name))) return "";
		const asks = backgroundAsksEnabled(config);
		const key = `${currentMode}:${config.backgroundAutoFallback}:${asks}`;
		if (hintCache?.key !== key) hintCache = { key, line: parentLaneHint(currentMode, config.backgroundAutoFallback, asks) };
		return hintCache.line;
	}

	const keyOf = (loaded: LoadedRules): string => `${loaded.file}:${loaded.hash ?? ""}`;
	/** allow rules apply only for a hash we recorded or the user approved; a file changed mid-run is untrusted. */
	const allowActive = (loaded: LoadedRules): boolean => loaded.trusted || approvedKey === keyOf(loaded);

	function syncProject(ctx: { cwd: string }): ProjectState {
		countWork("projectSync");
		const file = rulesPath(ctx.cwd);
		const signature = fileSignature(file);
		if (projectState?.file === file && projectState.signature === signature) return projectState;
		const loaded = loadProjectRules(ctx.cwd, getAgentDir());
		projectState = { file, signature, loaded, permissions: compilePermissions(loaded.rules, allowActive(loaded), loaded.broken) };
		return projectState;
	}

	/** Warn about malformed entries; ask whether to load allow rules we haven't seen. */
	async function reviewProject(ctx: ExtensionContext): Promise<void> {
		const { loaded } = syncProject(ctx);
		const key = keyOf(loaded);
		const problems = [
			...loaded.rules.warnings,
			...(loaded.broken === undefined ? [] : [`every shell command asks until the file is fixed: ${loaded.broken}`]),
		];
		if (ctx.hasUI && problems.length > 0 && warnedKey !== key) {
			warnedKey = key;
			ctx.ui.notify(sanitizeForTerminal(`pi-keeper: ignored in ${loaded.file}:\n${problems.join("\n")}`), "warning");
		}
		// command, read and fetch rules all take effect only once the file is trusted
		const allow = [...loaded.rules.allow, ...loaded.rules.readDirs, ...loaded.rules.fetchHosts, ...loaded.rules.allowVerbatim];
		if (allow.length === 0 || allowActive(loaded) || ignoredKey === key || !ctx.hasUI) return;
		const shown = allow.slice(0, 20).map((r) => `  ${r.text}`);
		if (allow.length > 20) shown.push(`  …and ${allow.length - 20} more`);
		attention(ctx, "pi: rules need review");
		const choice = await whileWaiting(ctx, () => withDialogLock(() => ctx.ui.select(
			sanitizeForTerminal(`Load ${allow.length} allow rule${allow.length === 1 ? "" : "s"} from ${RULES_FILE}?\n(The file was not written by pi-keeper or changed since; allowed commands, reads and fetches run without asking.)\n\n${shown.join("\n")}`),
			[LOAD_RULES, IGNORE_RULES],
			ctx.signal === undefined ? undefined : { signal: ctx.signal },
		), ctx.signal));
		if (choice === LOAD_RULES) {
			logRulesReview(pi, "load", allow.length);
			approvedKey = key;
			try {
				recordTrust(getAgentDir(), loaded.file, loaded.hash ?? "");
			} catch (error) {
				// approved for this session only
				if (ctx.hasUI) ctx.ui.notify(sanitizeForTerminal((error as Error).message), "warning");
			}
			ctx.ui.notify(`Loaded ${allow.length} allow rule${allow.length === 1 ? "" : "s"} from ${RULES_FILE}`, "info");
		} else {
			logRulesReview(pi, "ignore", allow.length);
			ignoredKey = key;
		}
		projectState = undefined;
	}

	/**
	 * The rulebook for this session: two directory listings and one read per rule
	 * file, so it is cheap enough to run per turn. Never opens a dialog, so it is
	 * safe inside a turn boundary. A project rule file that has not been reviewed
	 * yet is simply left out of `rules` (and reported in `untrusted`).
	 */
	function syncRulebook(ctx: { cwd: string }): LoadedRulebook {
		countWork("rulebookSync");
		const agentDir = getAgentDir();
		const trust = (file: string): string | undefined => {
			const approved = rulebookApproved.get(file);
			if (approved !== undefined) return approved;
			try {
				return trustedHash(agentDir, file);
			} catch {
				return undefined;
			}
		};
		return loadRulebook({ cwd: ctx.cwd, agentDir, trustedHash: trust });
	}

	/** Warn about rule files we had to skip; one review for every unreviewed project rule file. */
	async function reviewRules(ctx: ExtensionContext): Promise<void> {
		const book = syncRulebook(ctx);
		const key = book.untrusted.map((entry) => `${entry.file}:${entry.hash}`).join("|");
		const warned = `${key}#${book.problems.map((p) => `${p.file}:${p.problem}`).join("|")}`;
		if (ctx.hasUI && book.problems.length > 0 && rulebookWarnedKey !== warned) {
			rulebookWarnedKey = warned;
			const lines = book.problems.map((p) => `${basename(p.file)}: ${p.problem}`);
			ctx.ui.notify(sanitizeForTerminal(`pi-keeper: skipped in the rulebook:\n${lines.join("\n")}`), "warning");
		}
		if (book.untrusted.length === 0 || rulebookReviewKey === key || rulebookIgnoredKey === key || !ctx.hasUI) return;
		const shown = book.untrusted.slice(0, 8).map((entry) => `  ${basename(entry.file)}`);
		if (book.untrusted.length > shown.length) shown.push(`  …and ${book.untrusted.length - shown.length} more`);
		attention(ctx, "pi: rules need review");
		const choice = await whileWaiting(ctx, () => withDialogLock(() => ctx.ui.select(
			sanitizeForTerminal(`Load ${book.untrusted.length === 1 ? "a rulebook rule" : `${book.untrusted.length} rulebook rules`} from this project?\n(A project file can change how the model works. Nothing here was written by pi-keeper, or it changed since you last said yes.)\n\n${shown.join("\n")}`),
			[LOAD_RULES, IGNORE_RULES],
			ctx.signal === undefined ? undefined : { signal: ctx.signal },
		), ctx.signal));
		if (choice === LOAD_RULES) {
			let failure: string | undefined;
			for (const entry of book.untrusted) {
				rulebookApproved.set(entry.file, entry.hash);
				try {
					recordTrust(getAgentDir(), entry.file, entry.hash);
				} catch (error) {
					// approved for this session only
					failure ??= (error as Error).message;
				}
			}
			if (failure !== undefined) ctx.ui.notify(sanitizeForTerminal(failure), "warning");
			rulebookReviewKey = key;
			ctx.ui.notify(`Loaded ${book.untrusted.length === 1 ? "1 rulebook rule" : `${book.untrusted.length} rulebook rules`} from this project`, "info");
		} else {
			rulebookIgnoredKey = key;
		}
	}

	/**
	 * The parent session's grants for a child: live through the UI relay in
	 * the parent's process (foreground), else the snapshot the parent publishes
	 * for background children (session-grants.ts); undefined otherwise.
	 */
	function sharedRules(): SessionGitRules | undefined {
		if (childMode === undefined) return undefined;
		try {
			const relay = findUiRelay();
			return relay !== undefined ? relay.sessionRules() : readParentGrants(getAgentDir());
		} catch {
			return undefined;
		}
	}

	/** This session's own grants (a parent's; what it relays and publishes to its children). */
	function ownGrants(cwd: string | undefined): SessionGitRules {
		return { prefixes: grants.prefixes, exact: grants.exact, edits: sessionEdits, outsideReads: grants.outsideReadsAllowed, outsideReadDirs: grants.outsideReadDirs, fetchHosts: grants.fetchHosts, gitRepos: grants.gitRepos, ...(cwd !== undefined ? { cwd } : {}), ...(parentThinking !== undefined ? { thinking: parentThinking } : {}) };
	}

	/** This session's thinking level, from the harness (the session's own level wins over the event copy). */
	function currentThinkingLevel(ctx: ExtensionContext): ThinkingLevelName | undefined {
		try {
			const level = pi.getThinkingLevel();
			if (isThinkingLevel(level)) return level;
		} catch {
			// an older harness: fall through to the context copy
		}
		return isThinkingLevel(ctx.thinkingLevel) ? ctx.thinkingLevel : undefined;
	}

	/**
	 * Child only: follow the parent's thinking level when `subagent-thinking` is
	 * `follow`, never lowering the level the child's own agent file asked for
	 * (`childThinkingLevel`). Runs at session start and before every run, so a
	 * parent that raises its level after the child started still reaches it.
	 * Only when the parent published a level: an older parent, or one without
	 * `follow`, leaves the child at its own level.
	 */
	function applyChildThinking(ctx: ExtensionContext): void {
		if (childMode === undefined || config.subagentThinking === "role") return;
		const parent = sharedRules()?.thinking;
		if (!isThinkingLevel(parent)) return;
		const own = currentThinkingLevel(ctx);
		const next = childThinkingLevel(own, parent, config.subagentThinking);
		if (next === undefined || next === own) return;
		try {
			pi.setThinkingLevel(next);
		} catch {
			// the level is not ours to set here: the child keeps the one it started with
		}
	}

	/** Parent only: publish this session's grants for its background children when they changed. */
	function syncGrants(): void {
		if (childMode !== undefined || grantsSessionId === undefined) return;
		const rules = ownGrants(sessionCwd);
		const json = JSON.stringify(rules);
		if (json === publishedGrants) return;
		publishGrants(getAgentDir(), grantsSessionId, rules);
		publishedGrants = json;
	}

	function evalContext(ctx: ExtensionContext, subject: AskSubject = selfSubject(ctx)): EvalContext {
		// An in-process child shares the parent's session-scope rules (its asks
		// are answered in the parent's UI, so "for this session" spans the pi
		// session, parent and children alike). A background request is judged in
		// the parent, whose grants those are: they are `grants` and `sessionEdits`.
		const remote = subject.remote !== undefined;
		const shared = remote ? undefined : sharedRules();
		// resolved once: this is the hot path, one call per tool call
		const project = syncProject(subject).permissions;
		return {
			...pathContext(ctx, subject, project),
			remembered: shared === undefined ? grants.prefixes : [...grants.prefixes, ...shared.prefixes],
			rememberedExact: shared === undefined ? grants.exact : [...grants.exact, ...shared.exact],
			// an exact-command grant and a workflow command's grants are the parent user's own: a child never sees them;
			// the project's trusted BashExact entries apply everywhere (strictest wins in rules.ts)
			rememberedVerbatim: [...(remote ? [] : grants.verbatim), ...(project.allow.verbatim ?? [])],
			readOnlyTools: config.readOnlyTools,
			outsideReadsAllowed: grants.outsideReadsAllowed || (shared?.outsideReads ?? false),
			sessionEdits: sessionEdits || (shared?.edits ?? false),
			project,
			commandGrants: remote ? { prefixes: [], exact: [] } : grantPatterns(),
			annotationsOf: hintsOf,
			// a child inherits the bridge from its parent's snapshot
			subagentBridge: subject.child || bridge?.isCurrent() === true,
			child: subject.child,
		};
	}

	/**
	 * Parent only: make subagent children follow the current mode. Re-registers
	 * when the child mode changed; no registration (registry unusable, or the
	 * session already has someone else's) leaves the `subagent` tool denied.
	 */
	function syncBridge(ctx: ExtensionContext): void {
		if (childMode !== undefined) return;
		const wanted = childModeFor(currentMode, config.subagentsFollowAuto);
		if (bridge?.childMode === wanted && bridge.isCurrent()) return;
		bridge?.dispose();
		bridge = undefined;
		try {
			bridge = registerChildMode(ctx.sessionManager.getSessionId(), wanted);
		} catch {
			// no session id: stays unregistered
		}
	}

	/** The running workflow command's grants as prefix/exact token lists. */
	function grantPatterns(): { prefixes: string[][]; exact: string[][] } {
		const rules = commandGrant?.rules ?? [];
		return { prefixes: rules.filter((r) => !r.exact).map((r) => r.tokens), exact: rules.filter((r) => r.exact).map((r) => r.tokens) };
	}

	/** Annotations a tool declares (MCP hints), cached per name. */
	function hintsOf(toolName: string): ToolHints | undefined {
		if (!hintsCache.has(toolName)) {
			hintsCache = new Map(pi.getAllTools().map((tool) => [tool.name, tool.annotations]));
			if (!hintsCache.has(toolName)) hintsCache.set(toolName, undefined);
		}
		return hintsCache.get(toolName);
	}

	/** Ring the terminal (BEL + desktop notification) when a dialog needs the user. TUI only; fixed label text. */
	function attention(ctx: ExtensionContext, label: AttentionLabel): void {
		if (ctx.mode !== "tui") return;
		const sequence = attentionSequence(label);
		if (sequence !== "") process.stdout.write(sequence);
	}

	/** Show "Waiting for approval…" in the working row while `run` (a dialog) is open; restores the default after. */
	async function whileWaiting<T>(ctx: ExtensionContext, run: () => Promise<T>): Promise<T> {
		if (!ctx.hasUI) return run();
		ctx.ui.setWorkingMessage(WAITING_MESSAGE);
		try {
			return await run();
		} finally {
			syncWorkingMessage(ctx, true); // back to the mode-bearing text, or pi's default
		}
	}

	/** A dialog the user asked for (a command): taken in turn, after any approval already on screen, which it would otherwise replace. */
	function userDialog<T>(ctx: ExtensionContext, open: () => Promise<T>): Promise<T | undefined> {
		if (isDialogLocked()) ctx.ui.notify("An approval is waiting; this opens after it.", "info");
		return withDialogLock(open, ctx.signal);
	}

	/** The dialog surface a permission ask uses: this session's own UI, or the parent's via the relay. */
	interface AskUI {
		/** `recheck` runs once the dialog lock is reached: true when the call is now allowed, and the dialog is skipped (see permissionDialog). */
		dialog(title: DialogTitle, preview: Preview | undefined, options: string[], escLabel: string, recheck?: () => boolean): Promise<string | undefined>;
		input(title: string): Promise<string | undefined>;
		notify(message: string, type: "info" | "warning" | "error"): void;
	}

	/** The session's own UI. */
	function ctxUi(ctx: ExtensionContext): AskUI {
		return {
			dialog: (title, preview, options, escLabel, recheck) => permissionDialog(ctx, title, preview, options, escLabel, undefined, (data) => runModeShortcut(data, ctx), recheck),
			input: (title) => withDialogLock(() => ctx.ui.input(title, undefined, { signal: ctx.signal }), ctx.signal),
			notify: (message, type) => ctx.ui.notify(message, type),
		};
	}

	/** A child's dialogs, relayed to the parent's UI. Every call fails closed: a relay error is an unanswered dialog (reject), notifications are dropped. */
	function relayUi(relay: UiRelay, ctx: ExtensionContext): AskUI {
		return {
			dialog: (title, preview, options, escLabel, recheck) =>
				relay.select({ title: title.plain, lines: title.lines, options, preview, escLabel, signal: ctx.signal, recheck }).catch(() => undefined),
			input: (title) => relay.input({ title, signal: ctx.signal }).catch(() => undefined),
			notify: (message, type) => {
				try {
					relay.notify(message, type);
				} catch {
					// a dropped notification must not fail the ask
				}
			},
		};
	}

	/**
	 * Parent only: publish this session's UI for its in-process subagent
	 * children (a child has none, so its asks are relayed here). Re-registered
	 * per session — the captured context changes — and removed at shutdown.
	 * Children never host a relay.
	 */
	function syncRelay(ctx: ExtensionContext): void {
		if (childMode !== undefined) return;
		relayReg?.dispose();
		relayReg = undefined;
		if (!ctx.hasUI) return;
		relayReg = registerUiRelay({
			version: 1,
			sessionId: ctx.sessionManager.getSessionId(),
			async select(request) {
				attention(ctx, "pi: permission needed");
				return whileWaiting(ctx, () => {
					// the child's signal closes the dialog when its run is cancelled
					const signal = request.signal ?? ctx.signal;
					const title: DialogTitle =
						request.lines !== undefined ? { lines: request.lines, plain: request.title } : titleFromPlain(request.title);
					// the mode shortcut cycles this (the parent's) mode: the child's ask is unaffected, and the child's own mode is fixed
					return permissionDialog(ctx, title, request.preview, [...request.options], request.escLabel ?? "reject", signal, (data) => runModeShortcut(data, ctx), request.recheck);
				});
			},
			async input(request) {
				attention(ctx, "pi: permission needed");
				const signal = request.signal ?? ctx.signal;
				return whileWaiting(ctx, () => withDialogLock(() => ctx.ui.input(request.title, undefined, { signal }), signal));
			},
			notify: (message, type) => ctx.ui.notify(message, type ?? "info"),
			sessionRules: () => ownGrants(ctx.cwd),
			grantReadDirs: (dirs) => addReadDirs(dirs),
			grantFetchHosts: (hosts) => addFetchHosts(hosts),
			grantGitRepos: (roots) => addGitRepos(roots),
			rememberSession: (patterns) => rememberForSession(patterns),
			setSessionFlag: (flag) => {
				if (flag === "edits") sessionEdits = true;
				else grants.allowOutsideReads();
				syncGrants();
				refreshStatus(ctx);
			},
		});
	}

	/**
	 * Parent only: how a background child's request is judged. The request is
	 * untrusted, so only its call and cwd are used. The mode is the one this
	 * parent gives a background child (backgroundChildMode), whatever the
	 * request claims. The call goes through decide() with the rules and grants
	 * an in-process child with a relay would get (evalContext: this session's
	 * grants, the project rules of the request's cwd, no exact-command or
	 * workflow grants), and a cwd outside this session's project is locked out
	 * exactly as cwdProblem() locks such a child.
	 */
	/**
	 * The request's cwd as a realpath, cached: the cwd gate resolves symlinks, so the
	 * project rules read and written must be at the same place (`/x/link/..` is not `/x`).
	 */
	const realCwds = new Map<string, string>();
	function realCwdOf(cwd: string): string {
		let real = realCwds.get(cwd);
		if (real === undefined) {
			try {
				real = realpathSync(cwd);
			} catch {
				real = cwd;
			}
			if (realCwds.size >= 64) realCwds.clear();
			realCwds.set(cwd, real);
		}
		return real;
	}

	/**
	 * The mode this parent judges a background child's request in: the mode its own entry file would
	 * pick, or the mode the child says it runs in when that is stricter (it may have fallen back).
	 */
	function bgChildMode(request: AskRequest): ChildMode {
		return stricterMode(backgroundChildMode(currentMode, { ...config, backgroundAsks: backgroundAsksEnabled(config) }), request.childMode);
	}

	function remoteSubject(request: AskRequest, mode: ChildMode, extra: { ui?: AskUI; signal?: AbortSignal; receivedAt?: number } = {}): AskSubject {
		return {
			mode,
			child: true,
			cwd: realCwdOf(request.cwd),
			scratchDir: undefined, // the child's own scratch dir is its business: what it can write there it never asks about
			planFile: undefined,
			relay: undefined, // grants go straight to this session
			ui: extra.ui,
			signal: extra.signal,
			remote: { label: sanitizeForTerminal(request.childLabel), receivedAt: extra.receivedAt ?? Date.now() },
		};
	}

	function remoteDecision(request: AskRequest, ctx: ExtensionContext, subject: AskSubject): Decision {
		const call: ToolCall = { toolName: request.call.toolName, input: request.call.input };
		const decided = decide(call, ctx, subject);
		const problem = childCwdProblem(subject.cwd, ctx.cwd);
		const lockedOut = problem !== undefined && !(decided.action === "allow" && (decided.rule?.match === "childSession" || decided.rule?.match === "subagentArtifact"));
		return lockedOut ? { action: "deny", rule: { tools: [call.toolName], match: "childCwdLocked", action: "deny" } } : decided;
	}

	/** The ask server's judge: allow and deny are answered without a dialog. */
	function judgeRemote(request: AskRequest): Verdict {
		const ctx = askCtx;
		const mode = bgChildMode(request);
		if (ctx === undefined) return { action: "deny", mode, matcher: null };
		const decision = remoteDecision(request, ctx, remoteSubject(request, mode));
		return { action: decision.action, mode, matcher: decision.rule?.match ?? null, ...(request.childMode !== mode ? { claimed: request.childMode } : {}) };
	}

	/**
	 * The ask server's dialog for a request judged "ask": the same dialog, options and grants as an
	 * in-process child's relayed ask (ask()), titled with the child's label. Approving applies the
	 * grant to this session (rememberForSession, addReadDirs, ... each end in syncGrants) before the
	 * server replies; No or Esc denies this call only.
	 */
	async function askRemote(request: AskRequest, signal: AbortSignal, receivedAt: number): Promise<"allow" | "deny"> {
		const ctx = askCtx;
		if (ctx === undefined) return "deny";
		const prefix = `Background subagent ${sanitizeForTerminal(request.childLabel)}:`;
		const ui: AskUI = {
			dialog: (title, preview, options, escLabel, recheck) => permissionDialog(ctx, prefixTitle(`${prefix} `, title), preview, options, escLabel, signal, (data) => runModeShortcut(data, ctx), recheck),
			input: (title) => withDialogLock(() => ctx.ui.input(`${prefix} ${title}`, undefined, { signal }), signal),
			notify: (message, type) => ctx.ui.notify(message, type),
		};
		const subject = remoteSubject(request, bgChildMode(request), { ui, signal, receivedAt });
		const decision = remoteDecision(request, ctx, subject);
		if (decision.action !== "ask") return decision.action;
		const call: ToolCall = { toolName: request.call.toolName, input: request.call.input };
		// Inside the dialog lock, a grant a dialog opened first just made may cover this call: judge again, and skip the dialog then (as the parent's own asks do)
		const recheck = (): boolean => {
			const again = remoteDecision(request, ctx, subject);
			if (again.action !== "allow") return false;
			logDecision(pi, "redecide", request.id, call, subject.mode, again);
			return true;
		};
		const verdict = await ask(call, decision, ctx, request.id, subject, recheck);
		return verdict === undefined ? "allow" : "deny";
	}

	/** Telemetry for what the ask server settled without a dialog of its own. */
	function logRemote({ kind, request, verdict, waitMs }: ServerEvent): void {
		const mode = verdict?.mode ?? bgChildMode(request);
		if (kind === "clamped") {
			logRemoteMode(pi, request.id, request.childMode, mode);
			return;
		}
		const outcome: ChoiceOutcome =
			kind === "auto-allow" ? "remote-auto-allow" : kind === "auto-deny" ? "remote-auto-deny" : kind === "parent-gone" ? "parent-gone" : kind === "asks-off" ? "asks-off" : kind === "cancelled" || kind === "dropped" ? "remote-cancelled" : "remote-denied";
		const call: ToolCall = { toolName: request.call.toolName, input: request.call.input };
		logChoice(pi, { toolCallId: request.id, tool: call.toolName, mode, target: targetOf(call), matcher: verdict?.matcher ?? null, options: { primary: [], secondary: [] }, choice: null, outcome, waitMs, via: "background" });
	}

	/** Parent only: (re)start the server for this session's mailbox; any earlier one is stopped and its pending requests denied. */
	function startAsks(ctx: ExtensionContext): void {
		// turning asks off says why to the waiting children; any other restart is the session's end
		stopAsks(backgroundAsksEnabled(config) ? undefined : "asks-turned-off");
		if (childMode !== undefined) return;
		// nobody to answer (pi -p, json mode): write no heartbeat, so children see no listening parent and fall back at launch
		if (!ctx.hasUI) return;
		// no server, no heartbeat: children then deny at once instead of waiting for a parent that will not answer
		if (!backgroundAsksEnabled(config)) return;
		let dir: string;
		try {
			dir = askDirFor(getAgentDir(), ctx.sessionManager.getSessionId());
		} catch {
			return; // no session id: no mailbox
		}
		askCtx = ctx;
		const current = (): ExtensionContext => askCtx ?? ctx;
		askServer = startAskServer({
			ttlMs: () => askTtlMs(config.backgroundAskTimeoutMs), // read per poll: /keeper can change it while asks wait
			...askServerSeams,
			dir,
			judge: judgeRemote,
			ask: askRemote,
			hasUI: () => current().hasUI,
			isIdle: () => current().isIdle(),
			// getEditorText is optional here: a pi without it counts as an empty editor
			editorEmpty: () => (current().ui.getEditorText?.() ?? "").trim() === "",
			dialogBusy: isDialogLocked,
			popup: () => config.backgroundAskPopup,
			attention: () => attention(current(), "pi: permission needed"),
			badge: (count) => {
				if (current().hasUI) current().ui.setStatus(ASKS_STATUS_KEY, count > 0 ? badgeText(count) : undefined);
			},
			onEvent: logRemote,
			warn: (message) => {
				if (current().hasUI) current().ui.notify(sanitizeForTerminal(`pi-keeper: ${message}`), "warning");
			},
		});
	}

	/**
	 * Deny what is pending, close its dialogs, stop polling: "parent-session-ended" when the session ends, or
	 * "asks-turned-off" when background asks are turned off (startAsks passes it on that restart).
	 */
	function stopAsks(reason?: "asks-turned-off"): void {
		askServer?.stop(reason);
		askServer = undefined;
		askCtx = undefined;
	}

	/**
	 * Add granted read directories (deduplicated). Each one is checked again,
	 * since a child's relay call arrives from outside: "/", the home dir and
	 * its ancestors and missing paths are dropped, and the realpath is stored.
	 */
	function addReadDirs(dirs: readonly string[]): void {
		for (const dir of dirs) {
			if (typeof dir !== "string" || !isAbsolute(dir)) continue;
			const real = readGrantDir(dir, "/");
			if (real !== undefined) grants.addReadDir(real);
		}
		syncGrants();
	}

	/**
	 * Add granted git repo roots (deduplicated). Each one is resolved again to its repo root (gitRepoRootOf): "/", the
	 * home dir and its ancestors, and paths without a .git are dropped, and the realpath is stored.
	 */
	function addGitRepos(roots: readonly string[]): void {
		for (const root of roots) {
			if (typeof root !== "string" || !isAbsolute(root)) continue;
			const real = gitRepoRootOf(root);
			if (real !== undefined) grants.addGitRepo(real);
		}
		syncGrants();
	}

	/** Add granted fetch hosts (deduplicated). Checked again like addReadDirs: a child's relay call arrives from outside. */
	function addFetchHosts(hosts: readonly string[]): void {
		for (const host of hosts) {
			const parsed = typeof host === "string" ? parseFetchHost(fetchRuleFor(host)) : undefined;
			if (parsed !== undefined && !("error" in parsed)) grants.addFetchHost(parsed.host);
		}
		syncGrants();
	}

	function noteCall(toolCallId: string, note: string): void {
		callNotes.set(toolCallId, note);
		if (callNotes.size > MAX_CALL_NOTES) callNotes.delete(callNotes.keys().next().value as string);
	}

	function decide(call: ToolCall, ctx: ExtensionContext, subject: AskSubject = selfSubject(ctx)): Decision {
		const evalCtx = evalContext(ctx, subject);
		const mode = MODES[subject.mode].permissions;
		const decision = evaluate(mode, GLOBAL_RULES, call, evalCtx);
		if (!LAUNCH_TOOLS.includes(call.toolName)) return decision;
		// A launch also runs what the child leaves behind: its gate and acceptance commands,
		// and the write of its output file. Judge those as if this session ran them, and keep
		// the strictest answer, so no workflow can run a command or write a file that the mode
		// would have asked about.
		let strictest = decision;
		for (const nested of launchNestedCalls(call)) {
			// the file the child writes for its `output`: its own lane may write a report there in every
			// mode, and pi-subagents creates the run's directory only after this check, so the path is
			// judged from its text (isSubagentOutputPath)
			if (nested.toolName === "write" && isSubagentOutputPath(pathOf(nested.input), evalCtx)) continue;
			const nestedDecision = evaluate(mode, GLOBAL_RULES, nested, evalCtx);
			if (SEVERITY[nestedDecision.action] <= SEVERITY[strictest.action]) continue;
			strictest = { action: nestedDecision.action, rule: { tools: [call.toolName], match: "launchNested", action: nestedDecision.action }, detail: describe(nested) };
		}
		// what the nested calls cannot say (a command's env, a cwd outside the project, a shape we
		// cannot read) asks in every mode: the rules would judge it as something it is not
		const hazard = launchNestedHazards(call, evalCtx)[0];
		if (hazard !== undefined && SEVERITY.ask > SEVERITY[strictest.action]) {
			strictest = { action: "ask", rule: { tools: [call.toolName], match: "launchNested", action: "ask" }, detail: hazard };
		}
		return strictest;
	}

	/** The note of the switch that produced the current mode ("" when it needs none). */
	let modeNote = "";

	/** The mode part of the message: everything that changes when the mode changes. A child has none. */
	function modeMessageText(): string {
		if (childMode !== undefined) return ""; // fixed, and it belongs in front of the agent's own text
		return modeBlock({
			modeText: MODES[currentMode].prompt,
			mode: currentMode,
			planFile: currentMode === "plan" ? planFilePath : undefined,
			laneHint: laneHint(),
			scratch: scratchLine(),
			notes: modeNote,
			tail: MODE_ANNOUNCEMENTS[currentMode],
		});
	}

	/** The user's own rules and this session's grants, as the model is told them. */
	function rulesMessageText(ctx: ExtensionContext): string {
		// a locked child can reach no user and no file: the rules it cannot use are noise
		if (childMode !== undefined && laneLine(ctx).startsWith("Your lane: locked.")) return "";
		return rulesBlock(
			rulesLine({
				mode: childMode ?? currentMode,
				project: syncProject(ctx).permissions,
				session: childMode === undefined ? ownGrants(undefined) : sharedRules(),
			}),
		);
	}

	/**
	 * What the newest delivered message already told the model, if it is still in context.
	 * `getBranch()` is compaction-blind (it walks parentId to the root), so only entries after
	 * the newest compaction entry are certainly kept; a kept-but-older one is simply re-sent.
	 * Only this session's own kind counts: a parent's mode message, a child's rules message
	 * (so a parent block copied into a forked child cannot vouch for the child, nor a stray
	 * rules message for a parent's mode text).
	 */
	function lastDelivery(ctx: ExtensionContext): DeliveryDetails | undefined {
		const branch = ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; details?: unknown }>;
		const ownType = childMode === undefined ? MODE_MESSAGE : RULES_MESSAGE;
		let compactionAt = -1;
		for (let i = 0; i < branch.length; i++) if (branch[i].type === "compaction") compactionAt = i;
		for (let i = branch.length - 1; i > compactionAt; i--) {
			const entry = branch[i];
			if (entry.type !== "custom_message" || entry.customType !== ownType) continue;
			const details = entry.details as DeliveryDetails | undefined;
			if (childMode !== undefined && details?.mode !== "") continue;
			if (details === undefined || typeof details.mode !== "string" || typeof details.rules !== "string") return undefined;
			return details;
		}
		return undefined;
	}

	/** The message to append right now, or undefined while the model already has the current text. */
	function currentDelivery(ctx: ExtensionContext): Delivery | undefined {
		return nextDelivery({ mode: modeMessageText(), rules: rulesMessageText(ctx), last: lastDelivery(ctx) });
	}

	function persistState(): void {
		const state: KeeperState = { mode: currentMode, planFilePath };
		const serialized = JSON.stringify(state);
		if (serialized === persistedState) return;
		pi.appendEntry(STATE_ENTRY, state);
		persistedState = serialized;
	}

	function refreshStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, config.modeStatus ? formatModeStatus(ctx.ui.theme, currentMode, sessionEdits && currentMode === "default") : undefined);
	}

	let flashTimer: ReturnType<typeof setTimeout> | undefined;

	/** Remove the mode line and its timer. The context may be stale at shutdown; a failed clear is harmless. */
	function clearFlash(ctx: ExtensionContext): void {
		if (flashTimer !== undefined) clearTimeout(flashTimer);
		flashTimer = undefined;
		try {
			if (ctx.hasUI) ctx.ui.setWidget(FLASH_KEY, undefined);
		} catch {
			// the session is gone; nothing to clear
		}
	}

	/**
	 * The working row reads `<icon> <badge> · Working` in plan and auto mode (default mode keeps
	 * pi's own text), so the mode is in front of you while a run is active. It stays set between
	 * runs: pi shows it only while streaming. Off by default (`modeWorkingRow`).
	 */
	let workingMessageSet = false;
	function syncWorkingMessage(ctx: ExtensionContext, force = false): void {
		if (!ctx.hasUI) return;
		try {
			if (childMode !== undefined || currentMode === "default" || !config.modeWorkingRow) {
				// nothing to show: undo only what this function set (or what a dialog overwrote)
				if (workingMessageSet || force) ctx.ui.setWorkingMessage();
				workingMessageSet = false;
				return;
			}
			const { color, icon, badge } = MODES[currentMode];
			ctx.ui.setWorkingMessage(`${ctx.ui.theme.fg(color, `${icon} ${badge}`)} \u00b7 Working`);
			workingMessageSet = true;
		} catch {
			// a stale context at shutdown; the row is gone with it
		}
	}

	/** Show the mode, in its color, above the prompt for `modeFlashSecs` when idle; a new flash replaces the old one. */
	function flashMode(mode: ModeName, ctx: ExtensionContext): void {
		clearFlash(ctx);
		// a run is active: the working row carries the mode instead of a line above the prompt
		if (!ctx.hasUI || config.modeFlashSecs <= 0 || !ctx.isIdle()) return;
		const { color, icon, badge } = MODES[mode];
		ctx.ui.setWidget(FLASH_KEY, [ctx.ui.theme.fg(color, `${icon} ${badge}`)]);
		flashTimer = setTimeout(() => clearFlash(ctx), config.modeFlashSecs * 1000);
		flashTimer.unref?.();
	}

	function applyMode(mode: ModeName, ctx: ExtensionContext, options: { announce: boolean }): void {
		const previousMode = currentMode;
		currentMode = mode;
		// A child's mode is fixed: no tool swap, plan file, status, state entry or announcement
		if (childMode !== undefined) return;
		const definition = MODES[mode];

		// One plan file per session, created on first entry into plan mode
		// and kept afterwards (execution ticks off its checkboxes).
		if (mode === "plan" && planFilePath === undefined) {
			planFilePath = makePlanFilePath(ctx.cwd);
		}
		if (mode === "plan") mkdirSync(plansDir(), { recursive: true });

		// Keep tools we don't manage (other packages/MCP, built-in search tools
		// enabled via defaultTools), swap managed ones
		const preserved = pi.getActiveTools().filter((name) => !MANAGED_TOOLS.has(name));
		const builtins = pi.getFlag(BUILTIN_TOOLS_FLAG) === true ? BUILTIN_SEARCH_TOOLS : [];
		pi.setActiveTools([...new Set([...definition.tools, ...builtins, ...preserved])]);

		refreshStatus(ctx);
		persistState();
		syncBridge(ctx);
		syncWorkingMessage(ctx);
		if (previousMode !== mode) flashMode(mode, ctx);

		// The mode text is a conversation message now, not part of the system prompt (a changed
		// prefix flushes the prompt cache and, behind some gateways, fails every later request of a
		// session with signed thinking, docs/design.md). Mid-run we steer it so the model sees the
		// new mode before its next request; when idle we send nothing and the next prompt delivers
		// it, because a message sent while idle either is buffered unpersisted (nextTurn) or would
		// repeat the block (steer).
		if (options.announce && previousMode !== mode) {
			modeNote = switchNote(previousMode, mode);
			if (ctx.isIdle()) return;
			if (config.modeInstructions === "prompt") {
				// the text is in the system prompt, recomposed on the next prompt: steer a short
				// announcement for the rest of this run, not the whole block again
				const planLine = mode === "plan" && planFilePath !== undefined ? `\n${planFileLine(planFilePath)}` : "";
				const note = modeNote === "" ? "" : `\n${modeNote}`;
				pi.sendMessage(
					{ customType: "pi-keeper-mode-change", content: `Mode changed: ${MODE_CHANGE_NOTICES[mode]}${planLine}${note}`, display: false },
					{ deliverAs: "steer" },
				);
				return;
			}
			const delivery = currentDelivery(ctx);
			if (delivery !== undefined) pi.sendMessage(delivery, { deliverAs: "steer" });
		}
	}

	/** The note a switch adds: re-entering plan mode with an existing plan, or leaving it by hand. */
	function switchNote(previousMode: ModeName, mode: ModeName): string {
		if (mode === "plan") return planFilePath !== undefined && hasContent(planFilePath) ? PLAN_REENTRY_NOTE : "";
		return previousMode === "plan" && planFilePath !== undefined && hasContent(planFilePath) ? `The plan file is at ${planFilePath} if you need it.` : "";
	}

	/** The mode after the current one in the cycle. */
	function nextMode(): ModeName {
		return MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode) + 1) % MODE_CYCLE.length];
	}

	/** The keys the mode shortcuts use, matched inside custom UI that replaces pi's editor. */
	const isModeShortcut = (data: string): boolean => matchesKey(data, Key.alt("m")) || matchesKey(data, Key.ctrlShift("m"));

	/** Runs the mode cycle for a shortcut pressed inside custom UI; true when the key was consumed. */
	const runModeShortcut = (data: string, ctx: ExtensionContext): boolean => {
		if (!isModeShortcut(data)) return false;
		switchMode(nextMode(), ctx);
		return true;
	};

	function switchMode(mode: ModeName, ctx: ExtensionContext, options: { announce?: boolean } = {}): void {
		if (childMode !== undefined) {
			ctx.ui.notify(`Subagent children stay in ${childMode} mode (set by the parent)`, "warning");
			return;
		}
		applyMode(mode, ctx, { announce: options.announce ?? true });
		ctx.ui.notify(`Mode: ${MODES[mode].badge}`, "info");
	}

	/** Reset closure state, then restore the current branch's last state. */
	function restoreState(ctx: ExtensionContext): void {
		currentMode = "default";
		planFilePath = undefined;
		// A fresh session in default mode needs no state entry
		persistedState = JSON.stringify({ mode: "default" });

		const entries = ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>;
		const last = entries.filter((e) => e.type === "custom" && e.customType === STATE_ENTRY).pop();
		const data = last?.data as Partial<KeeperState> | undefined;
		const mode = parseMode(data?.mode);
		if (mode !== undefined) {
			currentMode = mode;
			// only a plan file inside the plans dir: anything else would be writable in every mode
			const restored = typeof data?.planFilePath === "string" ? data.planFilePath : undefined;
			planFilePath = restored !== undefined && isInsideDir(restored, plansDir()) ? restored : undefined;
			persistedState = JSON.stringify({ mode: data?.mode, planFilePath });
		}
		// A fork-context child copies the parent's state entries: ignore them (never auto, no plan file)
		if (childMode !== undefined) {
			currentMode = childMode;
			planFilePath = undefined;
		}
		applyMode(currentMode, ctx, { announce: false });
	}

	function deny(reason: string, terminate = false): ToolCallBlock {
		return { block: true, reason, terminate };
	}

	function denyReason(call: ToolCall, decision: Decision): string {
		const description = describe(call);
		if (decision.rule?.match === "privilegedBash") return PRIVILEGE_REASON;
		if (decision.rule?.match === "bridgeInactive") {
			return `pi-keeper couldn't attach to subagent children; refusing to launch unchecked subagents (pi-subagents' required-extension registry is unavailable, or already taken for this session). "${description}" was blocked. Do the work yourself, or tell the user.`;
		}
		// a workflow child whose own commands or output write the mode would not allow: say which
		if (decision.rule?.match === "launchNested") {
			const what = decision.detail === undefined ? "part of the child's own work" : `(${decision.detail})`;
			// a shell command is denied for being dangerous; a write, because only the plan file may change
			const shell = decision.detail?.startsWith("bash: ") === true;
			if (currentMode === "plan" && decision.rule.action === "deny") {
				return shell
					? `Plan mode is active: the workflow child's own command ${what} is dangerous and is never run while planning. Put this step in the plan file (${planFilePath ?? "not created yet"}); do not retry it.`
					: `Plan mode is active: only the plan file (${planFilePath ?? "not created yet"}) can be changed, so the workflow child's own write ${what} is blocked. Put it in the plan instead; do not retry it.`;
			}
			return `"${description}" is blocked in ${currentMode} mode: the workflow child's own step ${what} is not allowed here. Do not retry it; change the call or tell the user what you needed.`;
		}
		if (decision.rule?.match === "projectDeny") {
			const rule = findMatchingRule(projectState?.permissions.deny ?? [], commandOf(call.input));
			return `"${description}" is blocked by the project rule ${rule?.text ?? "(deny)"} in ${RULES_FILE}. Do not retry it; tell the user if it is needed.`;
		}
		if (call.toolName === EXIT_PLAN_TOOL) {
			return childMode !== undefined
				? `${EXIT_PLAN_TOOL} is not available to a subagent: the parent session owns the plan. Put your findings in your final report.`
				: NOT_IN_PLAN_MODE;
		}
		if (childMode !== undefined) {
			if (decision.rule?.match === "dangerousBash") {
				return `"${description}" is a dangerous command: it is never run in your lane (${childLaneName(childMode, findUiRelay() !== undefined, parentAsks)}). Do not retry it and do not probe variants. Say what you needed and why in your report, or ask the parent with contact_supervisor (reason "need_decision") if it is available.`;
			}
			return `"${description}" is not allowed in your lane (${childLaneName(childMode, findUiRelay() !== undefined, parentAsks)}). Do not retry it and do not probe another tool or path. Say what you needed and why in your report, or ask the parent with contact_supervisor (reason "need_decision") if it is available.`;
		}
		if (currentMode === "plan" && decision.rule?.match === "dangerousBash") {
			return `Plan mode is active: "${description}" is dangerous and is never run while planning. Put this step in the plan file (${planFilePath ?? "not created yet"}); do not retry it.`;
		}
		if (currentMode === "plan") {
			// a step the plan can carry out later: edits, writes, shell. Any other tool is just unavailable while planning
			if (call.toolName === "edit" || call.toolName === "write" || call.toolName === "bash" || call.toolName === "powershell") {
				return `Plan mode is active: only the plan file (${planFilePath ?? "not created yet"}) can be changed. "${description}" was blocked; add it to the plan instead and do not retry it.`;
			}
			return `Plan mode is active: the \`${call.toolName}\` tool is not available while planning. Do not retry it; carry on with reading, searching and read-only commands, or tell the user what you could not look up.`;
		}
		return `"${description}" is not allowed in ${currentMode} mode. Do not retry it; use another approach, or tell the user what you needed and why.`;
	}

	/**
	 * The deny text for a child whose ask cannot reach a user: the lane line, made specific to this call.
	 * `why` (a background ask that was sent to the parent but got no answer) is named in a clause.
	 * The lane name follows `parentAsks` like the lane line itself: a child whose asks do reach the
	 * parent's mailbox is a background child, and must not be told it has no relay (the ask was
	 * merely unanswered, so the next identical call may still be approved).
	 */
	function relaylessChildDeny(description: string, why?: string): string {
		const article = childMode === "auto" ? "an" : "a";
		const clause = why === undefined ? "" : ` (${why})`;
		if (childMode === "plan") {
			return `"${description}" is denied${clause}: you are ${article} ${childLaneName("plan", false, parentAsks)}, and non-read-only commands, first reads outside the working directory and secrets are denied for every path — do not retry it or probe another tool or path. Put it in your report, or ask the parent with contact_supervisor (reason "need_decision") if it is available.`;
		}
		if (childMode === "default") {
			const stage = why === undefined ? "; stage it in the scratch dir instead" : "";
			return `"${description}" is denied${clause}: you are ${article} ${childLaneName("default", false, parentAsks)}, and every mutation is denied for every path — do not retry it or probe another tool or path${stage}. Put it in your report, or ask the parent with contact_supervisor (reason "need_decision") if it is available.`;
		}
		return `"${description}" is denied${clause}: you are ${article} ${childLaneName("auto", false, parentAsks)}, and dangerous commands, secrets, protected and outside paths are denied fail-closed — do not retry it or probe variants. Put it in your report, or ask the parent with contact_supervisor (reason "need_decision") if it is available.`;
	}

	/** Why a background ask got no answer, as a clause for relaylessChildDeny. */
	function unansweredClause(result: RelayResult): string {
		if (result.decision === "cancelled") return "the ask to the parent's user was cancelled";
		if (result.reason === "timeout") return "the parent's user did not answer in time";
		if (result.reason === "error") return "the parent could not be reached";
		if (result.reason === "no-ui") return "the parent session has no interactive user";
		if (result.reason === "asks-turned-off") return "background asks were turned off in the parent session";
		if (result.reason === "request-size") return "the request is too large to send to the parent";
		return "the parent session has ended";
	}

	/**
	 * A background child's ask: file it in the parent session's mailbox and wait for the user's answer
	 * there (remote-relay.ts). Approval proceeds as any approved ask; the parent has applied any grant,
	 * which this child sees through sharedRules(). A decline denies this call only (no rejectedThisRun:
	 * the child carries on), the parent's rules deny with the usual text, and an ask nobody answered
	 * falls back to the relay-less deny.
	 */
	async function askTheParent(call: ToolCall, decision: Decision, ctx: ExtensionContext, toolCallId: string, subject: AskSubject): Promise<ToolCallBlock | undefined> {
		const description = describe(call);
		const started = Date.now();
		const result = await askParent(
			{ toolName: call.toolName, input: call.input as Record<string, unknown> },
			{
				dir: askDirFor(getAgentDir(), process.env[PARENT_SESSION_ENV] ?? ""),
				childMode: childMode as ChildMode,
				cwd: subject.cwd,
				label: ctx.sessionManager.getSessionName?.() ?? `subagent ${process.pid}`,
				signal: ctx.signal,
				timeoutMs: config.backgroundAskTimeoutMs,
				parentAlive: () => parentListening(getAgentDir()),
				...relaySeams,
			},
		);
		const answer = result.reason === undefined ? result.decision : `${result.decision}/${result.reason}`;
		logChoice(pi, { toolCallId, tool: call.toolName, mode: subject.mode, target: targetOf(call), matcher: decision.rule?.match ?? null, options: { primary: [], secondary: [] }, choice: answer, outcome: "parent-ask", waitMs: Date.now() - started, via: "background" });
		if (result.decision === "allow") return undefined;
		if (result.decision === "deny" && result.reason === "user") {
			return deny(`The user declined "${description}". Continue without it: do not retry it or probe another tool or path, and say in your final report what you skipped.`);
		}
		if (result.decision === "deny" && result.reason === "rules") return deny(denyReason(call, decision));
		return deny(relaylessChildDeny(description, unansweredClause(result)));
	}

	/** Permission dialog for an "ask" decision. Runs serialized. */
	async function ask(call: ToolCall, decision: Decision, ctx: ExtensionContext, toolCallId: string, subject: AskSubject = selfSubject(ctx), recheck?: () => boolean): Promise<ToolCallBlock | undefined> {
		const description = describe(call);
		const mode = subject.mode;
		const matcher = decision.rule?.match ?? null;
		const target = targetOf(call);
		// A child never uses its own UI (the parent's user can't see it): its
		// asks are relayed to the parent through the UI relay. A background child
		// in another process files its ask in the parent's mailbox instead (just
		// below); when neither way reaches a user, the ask is denied.
		const relay = subject.relay;
		// ...except a background child, which asks its parent's user through the parent's mailbox
		if (subject.ui === undefined && subject.child && subject.remote === undefined && childMode !== undefined && canAskParent(config, getAgentDir())) {
			return askTheParent(call, decision, ctx, toolCallId, subject);
		}
		if (subject.ui === undefined) {
			logChoice(pi, { toolCallId, tool: call.toolName, mode, target, matcher, options: { primary: [], secondary: [] }, choice: null, outcome: "no-ui", waitMs: 0 });
			if (subject.child) return deny(relaylessChildDeny(description, parentAsks && backgroundAsksEnabled(config) ? "the parent session has ended" : undefined));
			return deny(
				`"${description}" requires user approval, but no interactive user is available. Do not retry it. Continue with the parts of the task that need no approval, and say in your reply what you needed and why.`,
			);
		}
		const ui: AskUI = subject.ui;

		// Plain "not read-only" bash asks (default's fallback, plan's
		// unapprovedBash) explain why and offer to remember the command;
		// dangerous/secret asks never do, they must keep asking.
		const notReadOnly =
			call.toolName === "bash" &&
			((subject.mode === "default" && decision.rule === undefined) ||
				(subject.mode === "plan" && decision.rule?.match === "unapprovedBash"));
		const prefixes = notReadOnly ? deriveCommandPrefixes(commandOf(call.input), pathContext(ctx, subject)) : undefined;
		const commands = prefixes?.map((p) => `\`${p.join(" ")}\``).join(", ");
		// a rule for a command that writes files covers it only while its targets stay in the project
		const scope = prefixes === undefined ? "" : scopeSuffix(commandOf(call.input), pathContext(ctx, subject));
		const sessionLabel = prefixes === undefined ? undefined : `Yes, and don't ask again for ${commands} this session${subject.child ? ", for me and my subagents" : ""}${prefixes.some(viaRtkToo) ? " (also via rtk)" : ""}${scope}`;
		// project allow rules don't apply in plan mode, so only default offers them
		const projectLabel = config.projectCommandApprovals && prefixes !== undefined && subject.mode === "default" ? `Yes, and always allow ${commands} in this project${scope}` : undefined;
		// one segment needing approval: let the user pick the granularity (same conditions as the session option)
		const ladder = sessionLabel !== undefined ? patternLadder(commandOf(call.input), pathContext(ctx, subject)) : undefined;
		// no prefix can cover it (an interpreter, a script inside a compound): offer this exact text for the session (not in plan mode)
		// ...but never one that removes things: those stay a per-call decision
		// A child's answer is stored as an exact *pattern* in this session's list (which it and its
		// siblings read), so it is offered only when the command's tokens can be written as one;
		// the parent's own verbatim list stays the parent user's own.
		const exactTokens = subject.child ? exactRuleTokens(commandOf(call.input), pathContext(ctx, subject)) : undefined;
		const exactCommand =
			notReadOnly && prefixes === undefined && subject.mode === "default" && !hasRemoval(commandOf(call.input)) && (!subject.child || exactTokens !== undefined);
		// a child's answer lands in this session's list, which it and its siblings read, so the label says so
		const exactLabel = subject.child ? REMEMBER_EXACT_SHARED : REMEMBER_EXACT;
		// the `/keeper` setting adds a persistent variant: the exact rule
		// must also be representable in the project file (single segment, safe
		// tokens, nothing a rule may never cover). Offered to children too: like
		// the prefix project option, it saves to the child's own project.
		// Gated on exactCommand, like REMEMBER_EXACT. Without a token rule (quoted text, a loop), the exact text itself is saved.
		// Not for a program-running flag or a write outside the project: the session option only.
		const projectExactAllowed = config.projectExactCommands && exactCommand && !runsProgramOrWritesOutside(commandOf(call.input), ctx, subject);
		const projectExactCommandsTokens = projectExactAllowed ? projectExactCommandsTokensOf(commandOf(call.input), ctx, subject) : undefined;
		const projectExactVerbatim = projectExactAllowed && projectExactCommandsTokens === undefined ? projectVerbatimOf(commandOf(call.input)) : undefined;
		const projectExactOffered = projectExactCommandsTokens !== undefined || projectExactVerbatim !== undefined;
		// an outside read: offer to allow the directories (not for "/" or the home dir; those take the all-reads option)
		const grantDirs = decision.rule?.match === "outsideCwdRead" ? readGrantDirsOf(call, pathContext(ctx, subject)) : undefined;
		// a curl/wget GET to a host not yet allowed: offer the host (only when that is all the ask is about)
		const fetchMatch = decision.rule?.match === undefined || decision.rule.match === "unapprovedBash";
		const grantHosts = call.toolName === "bash" && fetchMatch ? fetchGrantHosts(commandOf(call.input), subject.cwd, subject.scratchDir, pathContext(ctx, subject).fetchHosts) : [];
		const hostGrant = grantHosts.length > 0 ? grantHosts : undefined;
		// a cd into another git repository (CD_GIT_REASON): offer its repo roots; only where a plain bash ask or the default fallback reaches
		const gitRoots = call.toolName === "bash" && (decision.rule === undefined || decision.rule.match === "unapprovedBash") ? gitGrantRoots(commandOf(call.input), subject.cwd, subject.scratchDir, pathContext(ctx, subject).gitRepos) : undefined;
		const { primary, secondary } = dialogOptions({
			mode: subject.mode,
			toolName: call.toolName,
			ruleMatch: decision.rule?.match,
			sessionLabel,
			projectLabel,
			exactCommand,
			projectExactCommands: projectExactOffered,
			readGrantLabel: grantDirs === undefined ? undefined : readGrantLabel(grantDirs),
			projectReadGrantLabel: grantDirs === undefined || !config.projectReadApprovals ? undefined : projectReadGrantLabel(grantDirs),
			fetchGrantLabel: hostGrant === undefined ? undefined : fetchGrantLabel(hostGrant),
			projectFetchGrantLabel: hostGrant === undefined || !config.projectCommandApprovals ? undefined : projectFetchGrantLabel(hostGrant),
			gitGrantLabel: gitRoots === undefined ? undefined : gitGrantLabel(gitRoots),
			hasLadder: ladder !== undefined,
			child: subject.child,
			// a background child's reply carries no text back, so there is nowhere for feedback to go
			feedback: subject.remote === undefined,
			sharedEdits: subject.remote !== undefined,
		});

		const why = notReadOnly ? formatBreakdown(approvalBreakdown(commandOf(call.input), subject.cwd, coverSources(ctx, subject), subject.scratchDir, pathContext(ctx, subject).fetchHosts, pathContext(ctx, subject).gitRepos)) : [];
		const hints = [...why, askHint(decision.rule?.match, commandOf(call.input), pathContext(ctx, subject), decision.detail)].filter((line) => line !== undefined);
		// The command/path is model-controlled: segments are sanitized for the terminal (title.ts)
		const { label, main, lang } = describeParts(call);
		const title = dialogTitle([
			[seg(`Permission required (${subject.child ? "subagent, " : ""}${subject.mode} mode)`, "bold")],
			blankLine(),
			...commandLines(`  ${label}`, main, lang),
			...(hints.length === 0 ? [] : [blankLine(), ...hints.map((hint) => [seg(hint, "dim")])]),
		]);
		/** The More… list: same lines; the plain text notes where Esc goes (the TUI hints line says "Esc back"). */
		const backTitle = (): DialogTitle => ({ lines: title.lines, plain: title.plain.replace(/\n*$/, "\n\n  Esc goes back\n") });
		// Diff of an edit/write (or a long command in full), computed now so a
		// queued call sees the file as earlier answers left it
		// (a cancelled or ended request must not wait for a slow preview)
		const preview = await Promise.race([
			previewFor(call, subject.cwd).catch(() => undefined),
			new Promise<undefined>((resolve) => {
				if (subject.signal?.aborted === true) resolve(undefined);
				else subject.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			}),
		]);
		// With a preview the dialog is re-opened for the "More…" list, so the diff or command stays visible
		// a recheck that answers the dialog is logged as "covered", not as the user's answer
		let covered = false;
		const watched = recheck === undefined ? undefined : (): boolean => (covered = recheck());
		const show = (options: string[], back: boolean): Promise<string | undefined> =>
			ui.dialog(back ? backTitle() : title, preview, options, back ? "back" : "reject", watched);
		// The relayed dialog rings and sets the parent's working row itself; a background request
		// rings from the ask server, when it decides to open
		if (!subject.child && subject.remote === undefined) attention(ctx, "pi: permission needed");
		const askedAt = Date.now();
		const runDialogs = async (): Promise<string | undefined> => {
			for (;;) {
				const picked = await show(primary, false);
				if (picked !== MORE) return picked;
				const sub = await show(secondary, true);
				// Esc in the More list goes back; an abort ends the dialog
				if (sub !== undefined || subject.signal?.aborted === true) return sub;
			}
		};
		const choice = relay === undefined ? await whileWaiting(ctx, runDialogs) : await runDialogs();
		const waitMs = Date.now() - askedAt;
		/** One telemetry entry for the answer, whichever branch resolved it. */
		const report = (outcome: ChoiceOutcome, extra?: Partial<ChoiceEvent>): void => {
			if (subject.remote !== undefined) {
				// a request that ended some other way (cancelled, session over) is logged by the ask server
				if (subject.signal?.aborted === true) return;
				const denied = outcome === "reject" || outcome === "reject-feedback";
				const remoteOutcome: ChoiceOutcome = outcome === "covered" ? "covered" : denied ? "remote-denied" : "remote-allowed";
				logChoice(pi, { toolCallId, tool: call.toolName, mode, target, matcher, options: { primary, secondary }, choice: choice ?? null, outcome: remoteOutcome, waitMs: Date.now() - subject.remote.receivedAt, via: "background", ...extra });
				return;
			}
			logChoice(pi, { toolCallId, tool: call.toolName, mode, target, matcher, options: { primary, secondary }, choice: choice ?? null, outcome, waitMs, ...(childMode !== undefined ? { via: "child-relay" as const } : {}), ...extra });
		};

		if (choice === ALLOW_ONCE) {
			report(covered ? "covered" : "allow-once");
			return undefined;
		}
		if ((choice === ALLOW_EDITS || choice === ALLOW_EDITS_SHARED) && primary.includes(choice)) {
			report("allow-edits");
			sessionEdits = true;
			syncGrants();
			if (relay !== undefined) {
				try {
					relay.setSessionFlag("edits");
				} catch {
					// the local flag stands
				}
			}
			refreshStatus(ctx);
			ui.notify("Edits in the working directory allowed for this session (until /new, /resume, fork or exit). Protected paths, outside paths and secrets still ask.", "info");
			return undefined;
		}
		if (choice === SWITCH_TO_AUTO) {
			report("switch-auto");
			switchMode("auto", ctx);
			return undefined;
		}
		if (choice === ALLOW_OUTSIDE_READS) {
			report("outside-reads");
			grants.allowOutsideReads();
			syncGrants();
			if (relay !== undefined) {
				try {
					relay.setSessionFlag("outsideReads");
				} catch {
					// the local flag stands
				}
			}
			ui.notify("Reads outside the working directory allowed for this session. Secrets still ask.", "info");
			return undefined;
		}
		if (grantDirs !== undefined && choice === readGrantLabel(grantDirs)) {
			report("outside-read-dirs");
			addReadDirs(grantDirs);
			if (relay?.grantReadDirs !== undefined) {
				try {
					relay.grantReadDirs(grantDirs);
				} catch {
					// the local grant stands
				}
			}
			ui.notify(`Reads from ${grantDirs.map((d) => sanitizeForTerminal(`${d}/`)).join(", ")} allowed for this session. Secrets still ask; /permissions lists and removes it.`, "info");
			return undefined;
		}
		if (grantDirs !== undefined && config.projectReadApprovals && choice === projectReadGrantLabel(grantDirs)) {
			report("project-read-approvals");
			saveReadDirsToProject(subject, ui, grantDirs);
			return undefined;
		}
		if (hostGrant !== undefined && choice === fetchGrantLabel(hostGrant)) {
			report("fetch-hosts");
			addFetchHosts(hostGrant);
			if (relay?.grantFetchHosts !== undefined) {
				try {
					relay.grantFetchHosts(hostGrant);
				} catch {
					// the local grant stands
				}
			}
			ui.notify(`Fetches (curl/wget GET) from ${hostGrant.map((h) => sanitizeForTerminal(h)).join(", ")} allowed for this session; /permissions lists and removes it.`, "info");
			return undefined;
		}
		if (hostGrant !== undefined && config.projectCommandApprovals && choice === projectFetchGrantLabel(hostGrant)) {
			report("project-fetch-hosts");
			saveFetchHostsToProject(subject, ui, hostGrant);
			return undefined;
		}
		if (gitRoots !== undefined && choice === gitGrantLabel(gitRoots)) {
			report("remember-session", { remembered: `git in ${gitRoots.map((r) => sanitizeForTerminal(`${r}/`)).join(", ")}`, scope: "session" });
			addGitRepos(gitRoots);
			if (relay?.grantGitRepos !== undefined) {
				try {
					relay.grantGitRepos(gitRoots);
				} catch {
					// the local grant stands
				}
			}
			ui.notify(`Git allowed in ${gitRoots.map((r) => sanitizeForTerminal(`${r}/`)).join(", ")} for this session. Dangerous git commands still ask.`, "info");
			// judged again: the rest of the command may still need an answer
			const again = decide(call, ctx, subject);
			return again.action === "allow" ? undefined : ask(call, again, ctx, toolCallId, subject, recheck);
		}
		if (choice === REJECT_WITH_FEEDBACK) {
			const feedback = (await ui.input("What should pi do instead? (empty: just say no)"))?.trim();
			// With feedback the agent continues with it; without, a plain reject
			if (feedback !== undefined && feedback !== "") {
				report("reject-feedback", { feedback });
				return deny(`The user rejected "${description}" and said: ${feedback}\nFollow this instead of retrying the same call.`);
			}
		}
		if (choice === OTHER_PATTERN && ladder !== undefined) {
			if (await patternFlow(subject, ui, commandOf(call.input), ladder, toolCallId)) {
				report("pattern-flow");
				return undefined;
			}
			// Esc in the picker falls through to the reject below
		}
		if (choice === exactLabel && exactCommand) {
			const command = commandOf(call.input);
			// redacted before it is cut: a cut inside a quoted secret would leave a half that no rule can see
			const shown = redactCommand(command);
			report("remember-session", { remembered: `exact: ${shown.length > 80 ? `${shown.slice(0, 80)}\u2026` : shown}`, scope: "session" });
			if (exactTokens === undefined) rememberVerbatim(command);
			else rememberForSession([{ tokens: exactTokens, exact: true }]);
			ui.notify("Allowed for this session: this exact command, character for character. Plan mode still asks; /permissions lists and removes it.", "warning");
			return undefined;
		}
		if (choice === PROJECT_EXACT && projectExactOffered) {
			const shown = redactCommand(commandOf(call.input));
			report("remember-project", { remembered: `exact: ${shown.length > 80 ? `${shown.slice(0, 80)}\u2026` : shown}`, scope: "project" });
			if (projectExactCommandsTokens !== undefined) saveToProject(subject, ui, [{ tokens: projectExactCommandsTokens, exact: true }]);
			else if (projectExactVerbatim !== undefined) saveVerbatimToProject(subject, ui, projectExactVerbatim);
			return undefined;
		}
		if (choice !== undefined && choice === sessionLabel && prefixes !== undefined) {
			report("remember-session", { remembered: prefixes.map((p) => `${p.join(" ")} *`).join(", "), scope: "session" });
			// Accepted with the Enter that chose the option — no second prompt.
			rememberForSession(prefixes.map((tokens) => ({ tokens, exact: false })));
			// The list is shared with plan mode: say so, since a remembered
			// command that writes (`git commit`) then runs there unasked too
			ui.notify(
				`Allowed for this session: ${prefixes.map((p) => p.join(" ")).join(", ")}\nThis also runs without asking in plan mode; /permissions lists it.`,
				"warning",
			);
			return undefined;
		}
		if (choice !== undefined && choice === projectLabel && prefixes !== undefined) {
			report("remember-project", { remembered: prefixes.map((p) => `${p.join(" ")} *`).join(", "), scope: "project" });
			saveToProject(subject, ui, prefixes.map((tokens) => ({ tokens, exact: false })));
			return undefined;
		}
		// No, Esc, or aborted
		report("reject");
		// a background child's No ends that call only: it has no run of the parent's to stop
		if (subject.remote === undefined) rejectedThisRun = true;
		return deny(rejectionReason(description, subject.child), true);
	}

	function rememberVerbatim(command: string): void {
		const key = verbatimKey(command);
		grants.addVerbatim(key);
	}

	function rememberForSession(patterns: readonly Pattern[]): void {
		for (const p of patterns) {
			grants.addPattern(p.tokens, p.exact);
		}
		syncGrants();
		// "… for this session" answered in a child covers the whole pi session:
		// write it through to the parent's session list, which the parent and other
		// in-process children read live.
		if (childMode !== undefined) {
			const relay = findUiRelay();
			if (relay !== undefined) {
				try {
					relay.rememberSession(patterns);
				} catch {
					// the local copy above is enough for this child
				}
			}
		}
	}

	/** Rule sources that count as approval in the Why breakdown and the tool-row badge (project allow rules and command grants apply in default mode only). */
	function coverSources(ctx: ExtensionContext, subject: AskSubject = selfSubject(ctx)): Array<CoverSource & { badge: string }> {
		const label = "allowed for this session";
		const shared = subject.remote === undefined ? sharedRules() : undefined;
		const sources: Array<CoverSource & { badge: string }> = [{
			label,
			badge: label,
			prefixes: shared === undefined ? grants.prefixes : [...grants.prefixes, ...shared.prefixes],
			exact: shared === undefined ? grants.exact : [...grants.exact, ...shared.exact],
		}];
		if (subject.mode === "default") {
			const { allow } = syncProject(subject).permissions;
			sources.push({ label: "allowed in this project", badge: "allowed by project rule", prefixes: allow.prefixes, exact: allow.exact });
			if (commandGrant !== undefined && subject.remote === undefined) {
				const granted = grantPatterns();
				const named = `allowed by /${commandGrant.name}`;
				sources.push({ label: named, badge: named, ...granted });
			}
		}
		return sources;
	}

	/** Why a bash call ran without a dialog, from the rule that allowed it: `allowed by project rule: git commit *`. Read-only calls get none. */
	function allowNote(call: ToolCall, decision: Decision, ctx: ExtensionContext): string | undefined {
		if (call.toolName === "bash" && decision.rule?.match === "rememberedVerbatim") {
			// the session list and the project's BashExact entries share this matcher: say which one
			return grants.verbatim.includes(verbatimKey(commandOf(call.input))) ? "allowed for this session: exact command" : "allowed by this project's exact-command rule";
		}
		if (call.toolName !== "bash" || (decision.rule?.match !== "rememberedBash" && decision.rule?.match !== "projectAllowBash")) return undefined;
		const sources = coverSources(ctx);
		const used = coveringPatterns(commandOf(call.input), sources, ctx.cwd, scratchDir, pathContext(ctx).fetchHosts, pathContext(ctx).gitRepos);
		const groups = sources.map((source) => ({ source, list: used.filter((u) => u.label === source.label) })).filter((g) => g.list.length > 0);
		if (groups.length === 0) return undefined;
		return sanitizeForTerminal(groups.map((g) => `${g.source.badge}: ${g.list.map((u) => patternString(u.tokens, u.exact)).join(", ")}`).join(" \u00b7 "));
	}

	/**
	 * The tokens of a project exact rule for `command`, when one is
	 * representable: single segment needing approval, and a rule body the
	 * project file accepts (parseRule re-checks the same conditions saveRules
	 * will). Undefined otherwise — the dialog then offers the session option
	 * only.
	 */
	function projectExactCommandsTokensOf(command: string, ctx: ExtensionContext, subject: AskSubject): string[] | undefined {
		const tokens = exactRuleTokens(command, pathContext(ctx, subject));
		if (tokens === undefined || tokens.length === 0) return undefined;
		const parsed = parseRule(exactRuleFor(tokens), "allow");
		return "error" in parsed ? undefined : tokens;
	}

	/**
	 * A program-running flag (`sed '1e id'`, `git -c`, `find -exec`), or a write
	 * whose targets don't pass the project check (outside, protected, secret or
	 * unknown): no project exact rule for it. A write inside the project keeps
	 * the option (deriveCommandPrefixes is undefined exactly for the failing writes).
	 */
	function runsProgramOrWritesOutside(command: string, ctx: ExtensionContext, subject: AskSubject): boolean {
		const pc = pathContext(ctx, subject);
		const effects = commandEffects(command, pc.cwd, pc.scratchDir, pc.fetchHosts, pc.gitRepos);
		if (effects?.includes("exec") === true) return true;
		return effects?.includes("write") === true && deriveCommandPrefixes(command, pc) === undefined;
	}

	/** The exact command text for a project `BashExact(...)` rule, when the file can hold it (no control characters); undefined otherwise. */
	function projectVerbatimOf(command: string): string | undefined {
		const key = verbatimKey(command);
		const parsed = parseVerbatim(verbatimRuleFor(key));
		return parsed === undefined || "error" in parsed ? undefined : key;
	}

	/**
	 * Write `BashExact(<command text>)` to the project file and tell the user.
	 * Like saveToProject: if the file holds unreviewed rules, or the write
	 * fails, the command applies for the session instead.
	 */
	function saveVerbatimToProject(where: { cwd: string }, ui: AskUI, command: string): void {
		const { loaded } = syncProject(where);
		try {
			const saved = saveRules(where.cwd, getAgentDir(), "allow", [verbatimRuleFor(command)], allowActive(loaded) ? loaded.hash : undefined);
			projectState = undefined;
			if (saved.trusted) {
				ui.notify(`Saved to ${RULES_FILE} as this exact text, character for character (default mode only; /permissions lists it)`, "info");
			} else {
				// the file held rules nobody reviewed: don't bless them with our write
				rememberVerbatim(command);
				ui.notify(`Saved to ${RULES_FILE}, but it holds unreviewed rules, so this exact command applies only for this session`, "warning");
			}
		} catch (error) {
			rememberVerbatim(command);
			ui.notify(sanitizeForTerminal(`Could not save to ${RULES_FILE}: ${error instanceof Error ? error.message : String(error)}\nAllowed for this session instead.`), "error");
		}
	}

	/**
	 * Write allow rules to the project file and tell the user. If the file
	 * holds unreviewed rules, or the write fails, the rules apply for the
	 * session instead.
	 */
	function saveToProject(where: { cwd: string }, ui: AskUI, patterns: readonly Pattern[]): void {
		const { loaded } = syncProject(where);
		const names = patterns.map((p) => p.tokens.join(" ") + (p.exact ? " (exact)" : "")).join(", ");
		try {
			const entries = patterns.map((p) => (p.exact ? exactRuleFor(p.tokens) : ruleFor(p.tokens)));
			const saved = saveRules(where.cwd, getAgentDir(), "allow", entries, allowActive(loaded) ? loaded.hash : undefined);
			projectState = undefined;
			if (saved.trusted) {
				ui.notify(`Saved to ${RULES_FILE}: ${names} (default mode only; /permissions lists them)`, "info");
			} else {
				// the file held rules nobody reviewed: don't bless them with our write
				rememberForSession(patterns);
				ui.notify(`Saved to ${RULES_FILE}, but it holds unreviewed rules, so these apply only for this session`, "warning");
			}
		} catch (error) {
			rememberForSession(patterns);
			ui.notify(sanitizeForTerminal(`Could not save to ${RULES_FILE}: ${error instanceof Error ? error.message : String(error)}\nAllowed for this session instead.`), "error");
		}
	}

	/** "Yes, and always allow reading from <dir>/ in this project": Read(<dir>/**) allow rules; the session grant when the file can't take them. */
	function saveReadDirsToProject(where: { cwd: string }, ui: AskUI, dirs: readonly string[]): void {
		const { loaded } = syncProject(where);
		const shown = dirs.map((d) => sanitizeForTerminal(`${d}/`)).join(", ");
		try {
			const saved = saveRules(where.cwd, getAgentDir(), "allow", dirs.map(readDirRuleFor), allowActive(loaded) ? loaded.hash : undefined);
			projectState = undefined;
			if (saved.trusted) {
				ui.notify(`Saved to ${RULES_FILE}: reads from ${shown}. Secrets still ask; /permissions lists and removes it.`, "info");
			} else {
				addReadDirs(dirs);
				ui.notify(`Saved to ${RULES_FILE}, but it holds unreviewed rules, so reads from ${shown} are allowed only for this session`, "warning");
			}
		} catch (error) {
			addReadDirs(dirs);
			ui.notify(sanitizeForTerminal(`Could not save to ${RULES_FILE}: ${error instanceof Error ? error.message : String(error)}\nReads from ${shown} allowed for this session instead.`), "error");
		}
	}

	/** "Yes, and always allow fetching from <host> in this project": Fetch(<host>) allow rules; the session grant when the file can't take them. */
	function saveFetchHostsToProject(where: { cwd: string }, ui: AskUI, hosts: readonly string[]): void {
		const { loaded } = syncProject(where);
		const shown = hosts.map((h) => sanitizeForTerminal(h)).join(", ");
		try {
			const saved = saveRules(where.cwd, getAgentDir(), "allow", hosts.map(fetchRuleFor), allowActive(loaded) ? loaded.hash : undefined);
			projectState = undefined;
			if (saved.trusted) {
				ui.notify(`Saved to ${RULES_FILE}: fetches from ${shown}; /permissions lists and removes it.`, "info");
			} else {
				addFetchHosts(hosts);
				ui.notify(`Saved to ${RULES_FILE}, but it holds unreviewed rules, so fetches from ${shown} are allowed only for this session`, "warning");
			}
		} catch (error) {
			addFetchHosts(hosts);
			ui.notify(sanitizeForTerminal(`Could not save to ${RULES_FILE}: ${error instanceof Error ? error.message : String(error)}\nFetches from ${shown} allowed for this session instead.`), "error");
		}
	}

	/**
	 * "Allow a different command pattern…": pick or type a pattern, then a
	 * scope. true = the call is allowed (also when a typed pattern was invalid:
	 * allowed once); false = Esc at a step, which rejects like the main dialog.
	 */
	async function patternFlow(subject: AskSubject, ui: AskUI, command: string, ladder: readonly PatternChoice[], toolCallId: string): Promise<boolean> {
		const shown = command.length > DESCRIBE_COMMAND_LIMIT ? `${command.slice(0, DESCRIBE_COMMAND_LIMIT)}\u2026` : command;
		const ladderTitle = dialogTitle([[seg("Which commands should be allowed?", "bold")], blankLine(), ...commandLines("  ", shown)]);
		const picked = await ui.dialog(ladderTitle, undefined, [...ladder.map((c) => c.label), TYPE_PATTERN], "reject");
		if (picked === undefined) return false;
		let pattern: Pattern;
		if (picked === TYPE_PATTERN) {
			const typed = await ui.input("Command pattern (e.g. git commit * or npm test)");
			if (typed === undefined) return false;
			const parsed = typed.trim() === "" ? { error: "empty pattern" } : parsePattern(typed, "allow");
			if ("error" in parsed) {
				ui.notify(sanitizeForTerminal(`Pattern not accepted (${parsed.error}); allowed once`), "warning");
				return true;
			}
			pattern = { tokens: parsed.tokens, exact: parsed.exact };
			const covers = isCoveredByPrefixes(command, pattern.exact ? [] : [[...pattern.tokens]], subject.cwd, pattern.exact ? [[...pattern.tokens]] : [], subject.scratchDir);
			if (!covers) ui.notify(sanitizeForTerminal(`\`${patternText(pattern)}\` doesn't cover this command; allowed once, rule still saved`), "warning");
		} else {
			const choice = ladder.find((c) => c.label === picked);
			if (choice === undefined) return false;
			pattern = { tokens: choice.tokens, exact: choice.exact };
		}
		const scopes = subject.mode === "default" ? [SCOPE_SESSION, SCOPE_PROJECT] : [SCOPE_SESSION];
		const scopeTitle = dialogTitle([[seg("Allow ", "bold"), seg(`\`${patternText(pattern)}\``, "command")]]);
		const scope = await ui.dialog(scopeTitle, undefined, scopes, "reject");
		if (scope === undefined) return false;
		if (scope === SCOPE_PROJECT) {
			logPattern(pi, toolCallId, patternText(pattern), "project");
			saveToProject(subject, ui, [pattern]);
		} else {
			logPattern(pi, toolCallId, patternText(pattern), "session");
			rememberForSession([pattern]);
			ui.notify(sanitizeForTerminal(`Allowed for this session: ${patternText(pattern)}\nThis also runs without asking in plan mode; /permissions lists it.`), "warning");
		}
		return true;
	}

	function rejectionReason(description: string, child = childMode !== undefined): string {
		// a child has no user to wait for: it carries on and reports instead
		if (child) {
			return `The user rejected "${description}". Do not retry it; say in your final report what you needed and why.`;
		}
		return `The user rejected "${description}". Stop and wait for the user's instructions.`;
	}

	/** True when the input is an unlocked bash call object with a command. */
	function rewritableBashInput(input: unknown): boolean {
		const command = (input as { command?: unknown } | undefined)?.command;
		return typeof command === "string" && Object.isExtensible(input);
	}

	const judgeToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallBlock | undefined> => {
		const call: ToolCall = { toolName: event.toolName, input: event.input };
		const decideAt = performance.now();
		const decided = decide(call, ctx);
		// a child launched outside its parent's project: only the escalation channel and its report
		const locked = cwdProblem(ctx);
		// the escalation channel is matched by name: auto mode allows it by fallback, with no childSession rule
		const escapeHatch = CHILD_PROTOCOL_TOOLS.includes(call.toolName) || decided.rule?.match === "subagentArtifact";
		const lockedOut = locked !== undefined && !(decided.action === "allow" && escapeHatch);
		const decision: Decision = lockedOut ? { action: "deny", rule: { tools: [call.toolName], match: "childCwdLocked", action: "deny" } } : decided;
		logDecision(pi, "decide", event.toolCallId, call, currentMode, decision, performance.now() - decideAt);
		if (lockedOut) {
			return deny(`"${describe(call)}" is denied: you are locked — ${locked}. Do not retry it or probe another tool or path. Report this, and ask the parent to relaunch you inside its project (contact_supervisor, reason "need_decision", if it is available).`);
		}
		if (decision.action === "allow") {
			const note = allowNote(call, decision, ctx);
			if (note !== undefined) noteCall(event.toolCallId, note);
			return;
		}
		if (decision.action === "deny") {
			if (ctx.hasUI) ctx.ui.notify(sanitizeForTerminal(`Blocked in ${currentMode}: ${describe(call)}`), "warning");
			return deny(denyReason(call, decision), decision.rule?.match === "privilegedBash");
		}

		// Serialize dialogs; re-decide after waiting (an earlier answer may
		// have switched mode or remembered a command).
		const run = dialogQueue.then(async () => {
			const redecideAt = performance.now();
			const current = decide(call, ctx);
			const redecideMs = performance.now() - redecideAt;
			if (current.action !== decision.action || current.rule?.match !== decision.rule?.match) {
				logDecision(pi, "redecide", event.toolCallId, call, currentMode, current, redecideMs);
			}
			if (current.action === "allow") {
				const note = allowNote(call, current, ctx);
				if (note !== undefined) noteCall(event.toolCallId, note);
				return undefined;
			}
			if (current.action === "deny") return deny(denyReason(call, current), current.rule?.match === "privilegedBash");
			// No stops the turn: parallel calls queued behind it get no dialog
			if (rejectedThisRun) {
				logChoice(pi, {
					toolCallId: event.toolCallId,
					tool: call.toolName,
					mode: currentMode,
					target: targetOf(call),
					matcher: current.rule?.match ?? null,
					options: { primary: [], secondary: [] },
					choice: null,
					outcome: "auto-reject",
					waitMs: 0,
				});
				return deny(rejectionReason(describe(call)), true);
			}
			// rtk rewrite runs concurrently with the dialog, so it adds no
			// latency; it is applied only after approval. The rules and the
			// dialog itself saw the original command — what the user approved.
			const rewrite =
				rewriter !== null && call.toolName === "bash" && rewritableBashInput(event.input)
					? rewriter.rewrite(commandOf(call.input), ctx.signal).catch(() => null)
					: null;
			// Inside the dialog lock, a parallel call (a child's, relayed here) may have just been granted
			// for this session or project: judge again, and skip the dialog when it is now allowed.
			const recheck = (): boolean => {
				const again = decide(call, ctx);
				if (again.action !== "allow") return false;
				logDecision(pi, "redecide", event.toolCallId, call, currentMode, again);
				return true;
			};
			const verdict = await ask(call, current, ctx, event.toolCallId, undefined, recheck);
			// What the user approved is what runs: later tool_call handlers
			// (other extensions) can't change it any more. rtk is a trusted
			// optimizer (rtk ls is within approving ls), so this package
			// itself applies its rewrite before locking — no other extension
			// gets that allowance, and the lock stays absolute afterwards.
			if (verdict === undefined && call.toolName === "bash") noteCall(event.toolCallId, "approved");
			if (verdict === undefined && LOCKABLE_TOOLS.has(call.toolName)) {
				// Description of what the user approved (captured before the
				// rewrite, since call.input and event.input are the same object)
				const approvedDescription = describe(call);
				if (rewrite !== null) {
					const rewritten = await rewrite;
					if (rewritten !== null && rewritten !== commandOf(call.input)) {
						(event.input as { command?: unknown }).command = rewritten;
					}
				}
				lockApprovedInput(event.input, approvedDescription);
			}
			return verdict;
		});
		dialogQueue = run.catch(() => undefined);
		return run;
	};

	pi.on("tool_call", async (event, ctx) => {
		try {
			return await judgeToolCall(event, ctx);
		} catch (error) {
			// an abort (Esc) is not a judgement failure: pi reports it as before
			if (ctx.signal?.aborted) throw error;
			const detail = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(sanitizeForTerminal(`pi-keeper could not check a call: ${detail}`), "warning");
			return deny("pi-keeper could not judge this call; it was blocked. Do not retry it.");
		}
	});

	/** The bash call row plus a dim line saying why it ran without asking; the note is read at render time. */
	class NotedCall implements Component {
		inner!: Component;
		toolCallId = "";
		dim: (text: string) => string = (text) => text;
		render(width: number): string[] {
			const lines = this.inner.render(width);
			const note = callNotes.get(this.toolCallId);
			return note === undefined ? lines : [...lines, truncateToWidth(this.dim(`  ${note}`), width)];
		}
		invalidate(): void {
			this.inner.invalidate();
		}
	}

	// Older Pi versions exposed registerToolRenderer for wrapping built-in rows.
	// Keep the enhancement when that optional API exists, but do not make the
	// extension fail to load against newer APIs where it was removed.
	interface LegacyToolRendererAPI {
		registerToolRenderer(resolver: (toolName: string, next: () => any) => any): void;
	}
	const legacyRendererAPI = pi as ExtensionAPI & Partial<LegacyToolRendererAPI>;
	if (legacyRendererAPI.registerToolRenderer !== undefined) {
		legacyRendererAPI.registerToolRenderer((toolName: string, next: () => any) => {
			const inner = next();
			const renderCall = inner?.renderCall;
			if (toolName !== "bash" || inner === undefined || renderCall === undefined) return inner;
			return {
				...inner,
				renderCall(args: any, theme: any, context: any) {
					const previous = context.lastComponent instanceof NotedCall ? context.lastComponent : undefined;
					const wrapper = previous ?? new NotedCall();
					wrapper.inner = renderCall(args, theme, { ...context, lastComponent: previous?.inner });
					wrapper.toolCallId = context.toolCallId;
					wrapper.dim = (text: string) => theme.fg("dim", text);
					return wrapper;
				},
			};
		});
	}

	/**
	 * The rule-fire card. One `custom` entry per fired rule is both the session
	 * record and the row, so nothing can disagree about what fired; custom entries
	 * never reach the model. TUI only — a headless session reads `/rules`.
	 */
	const entryRenderers = pi as ExtensionAPI & {
		registerEntryRenderer?: (customType: string, renderer: (entry: { data?: unknown }, options: { expanded: boolean }, theme: { fg(color: string, text: string): string }) => Component) => void;
	};
	if (entryRenderers.registerEntryRenderer !== undefined) {
		entryRenderers.registerEntryRenderer(RULE_FIRED_ENTRY, (entry, options, theme) => {
			const data = entry.data as Partial<RuleFireRecord> | undefined;
			if (data === undefined || typeof data.rule !== "string") return undefined;
			const why = typeof data.description === "string" && data.description !== "" ? theme.fg("dim", ` — ${data.description}`) : "";
			const lines = [`${theme.fg("warning", "⚠ rule fired: ")}${data.rule}${why}`];
			if (options.expanded) lines.push(theme.fg("dim", `${data.kind ?? "user"} rule · ${typeof data.at === "string" ? data.at : ""} · the correction went to the model as a hidden message (see /rules ${data.rule})`));
			return new Text(lines.join("\n"), 0, 0);
		});
	}

	pi.registerTool({
		name: EXIT_PLAN_TOOL,
		label: "Exit plan mode",
		description:
			'Ask the user to approve the plan in the plan file; on approval plan mode ends and you execute it. Write the plan file first: this tool takes no plan text and reads the file. The user sees the file rendered in full, so do not repeat it in your reply. This tool is how you ask "is this plan okay?"; never ask that in text. Use it only for a change to implement, not for a question or explanation (answer those directly).',
		parameters: Type.Object({
			commands: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Short command lines execution will run (e.g. ["npm test", "make build"]), never file contents or scripts. The user can pre-approve them for the session; read-only, dangerous and privileged ones are ignored. Omit if unsure.',
				}),
			),
		}),
		executionMode: "sequential",
		defaultActive: false,
		// the row is the plan: a header that tracks the outcome, then the plan as Markdown (plan-approval.ts).
		// It paints its own background, so pi's pending/success/error shell is skipped
		renderShell: "self",
		renderCall() {
			return new Text("", 0, 0);
		},
		renderResult(result, _options, theme, context) {
			const details = asPlanDetails(result.details);
			if (details === undefined) {
				// an abort or ctrl+c while the selector was open leaves no details: show the text
				const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
				const previous = context.lastComponent instanceof Text ? context.lastComponent : undefined;
				const component = previous ?? new Text("", 1, 1, (line) => theme.bg("toolPendingBg", line));
				component.setText(theme.fg("dim", sanitizeForTerminal(text)));
				return component;
			}
			if (context.lastComponent instanceof PlanView) {
				context.lastComponent.update(details, theme);
				return context.lastComponent;
			}
			return new PlanView(details, theme);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = (text: string, isError = false, details?: PlanDetails, extra: { terminate?: boolean; more?: string[] } = {}) => ({
				content: [text, ...(extra.more ?? [])].map((part) => ({ type: "text" as const, text: part })),
				details,
				isError,
				...(extra.terminate === true ? { terminate: true } : {}),
			});

			if (currentMode !== "plan" || planFilePath === undefined) return result(NOT_IN_PLAN_MODE, true);
			const planFile = planFilePath;
			let plan = "";
			try {
				plan = readFileSync(planFile, "utf8").trim();
			} catch {
				// not written yet
			}
			if (plan === "") {
				return result(`The plan file ${planFile} is empty. Write the plan there first, then call ${EXIT_PLAN_TOOL} again.`, true);
			}
			if (!ctx.hasUI) return result("Plan not approved: no interactive user is available. Stay in plan mode.", true);

			// commands the plan says it will run, as rememberable prefixes (dangerous, privileged and read-only ones dropped)
			const planned = planCommandPrefixes((params.commands ?? []).slice(0, MAX_PLAN_COMMANDS), pathContext(ctx));
			const plannedText = planned.map((p) => `\`${p.join(" ")}\``).join(", ");
			const plannedLabel = `Yes, approving each edit, and allow ${plannedText.length > PLAN_LABEL_COMMANDS_LIMIT ? `${plannedText.slice(0, PLAN_LABEL_COMMANDS_LIMIT)}…` : plannedText} for this session`;
			const planOptions = planned.length > 0 ? [PLAN_AUTO, PLAN_MANUAL, sanitizeForTerminal(plannedLabel)] : [PLAN_AUTO, PLAN_MANUAL];
			const telemetryOptions = [...planOptions, PLAN_KEEP];
			const commandSegments: TitleSegment[] = planned.flatMap((p, i) => [
				...(i === 0 ? [] : [seg(", ", "dim")]),
				seg(`\`${p.join(" ")}\``, "command"),
			]);

			let edited = false;
			/** The row's snapshot: sanitized, because the plan text is model-controlled. */
			const snapshot = (outcome: PlanDetails["outcome"], extra: Partial<PlanDetails> = {}): PlanDetails => ({
				plan: sanitizeForTerminal(plan),
				planFile,
				outcome,
				edited,
				...extra,
			});
			const abortResult = () => {
				logPlanApproval(pi, toolCallId, telemetryOptions, null, "aborted", planned.map((p) => p.join(" ")));
				return result(PLAN_ABORTED_TEXT, false, snapshot("aborted"), { terminate: true });
			};

			// the plan renders in the transcript while the selector waits (partial details are not persisted)
			onUpdate?.({ content: [{ type: "text", text: "Waiting for approval…" }], details: snapshot("pending") });
			attention(ctx, "pi: plan ready for approval");

			// ctrl+g in the selector edits the plan, then the selector returns with its draft feedback and row
			let draft = "";
			let row = 0;
			let notice: string | undefined;
			let choice: PlanChoice;
			for (;;) {
				choice = await whileWaiting(ctx, () =>
					selectPlanAction(ctx, { options: planOptions, commandSegments, signal, initialFeedback: draft, initialRow: row, notice, isModeShortcut }),
				);
				if (choice.kind === "mode-switch") {
					// The selector replaces pi's editor, so the shortcut never reaches the global handler: cycle here.
					// announce: false — the superseded result below tells the model, like the approve path.
					switchMode(nextMode(), ctx, { announce: false });
					// refused (a subagent child's mode is fixed): back to the review, draft and row intact
					if (currentMode === "plan") {
						draft = choice.feedback;
						row = choice.row;
						continue;
					}
					break;
				}
				if (choice.kind !== "edit") break;
				draft = choice.feedback;
				row = choice.row;
				notice = undefined;
				const revised = await withDialogLock(() => ctx.ui.editor("Edit plan", plan), signal);
				if (signal?.aborted) return abortResult();
				// the external editor strips a trailing newline: compare without it, or every round trip counts as an edit
				if (revised !== undefined && revised.trimEnd() !== plan.trimEnd()) {
					try {
						writeFileSync(planFile, `${revised.trim()}\n`);
						plan = revised.trim();
						edited = true;
						notice = "Plan updated";
						onUpdate?.({ content: [{ type: "text", text: "Waiting for approval…" }], details: snapshot("pending") });
					} catch (error) {
						ctx.ui.notify(`Could not save the edited plan: ${(error as Error).message}`, "error");
					}
				}
			}

			// the mode may have been switched while the selector was open: do not undo that
			if (currentMode !== "plan") {
				return result(
					`The mode changed to ${currentMode} while the plan was being reviewed, so the plan was neither approved nor rejected. Do not call ${EXIT_PLAN_TOOL} again. Follow the ${currentMode} mode instructions and continue the user's task; the plan file is ${planFile}.`,
					false,
					snapshot("superseded"),
				);
			}

			const commandList = planned.map((p) => p.join(" "));
			if (choice.kind === "approve") {
				const withCommands = planned.length > 0 && choice.row === 2;
				const target: ModeName = choice.row === 0 ? "auto" : "default";
				const feedback = choice.feedback;
				logPlanApproval(
					pi,
					toolCallId,
					telemetryOptions,
					planOptions[choice.row] ?? null,
					feedback !== undefined ? "execute-manual-feedback" : choice.row === 0 ? "execute-auto" : withCommands ? "execute-manual-commands" : "execute-manual",
					withCommands ? commandList : [],
					feedback,
				);
				if (withCommands) {
					rememberForSession(planned.map((tokens) => ({ tokens, exact: false })));
					ctx.ui.notify(
						sanitizeForTerminal(`Allowed for this session: ${commandList.join(", ")}\nThis also runs without asking in plan mode; /permissions lists them.`),
						"warning",
					);
				}
				// The tool result tells the model; no separate announcement
				applyMode(target, ctx, { announce: false });
				ctx.ui.notify(`Mode: ${MODES[target].badge} · executing plan`, "info");
				// the plan is always echoed: it was built from incremental edits that compaction can lose
				const echoed = plan.length > PLAN_ECHO_LIMIT ? `${plan.slice(0, PLAN_ECHO_LIMIT)}\n…(truncated; see the plan file)` : plan;
				return result(
					`Plan approved by the user. Plan mode is over and its restrictions no longer apply: start executing the plan now. Work through its checkbox steps in order, ticking each off in the plan file (${planFile}) as you finish it, then summarize. ${APPROVED_MODE_NOTE[target]}${withCommands ? ` Pre-approved for this session: ${commandList.join(", ")}.` : ""}\n\n## Approved plan${edited ? " (the user edited it)" : ""}:\n${echoed}`,
					false,
					snapshot("approved", { target, ...(feedback === undefined ? {} : { feedback }) }),
					{ more: feedback === undefined ? [] : [`The user's note on this plan: ${feedback}`] },
				);
			}
			if (choice.kind === "feedback") {
				logPlanApproval(pi, toolCallId, telemetryOptions, PLAN_KEEP, "keep-planning", commandList, choice.text);
				// A note is often a question ("where is the plan?", "why X?") rather than an
				// edit request; forbidding text made the model edit the file to answer it and
				// then get stuck. Say both moves, and keep the review open either way.
				return result(
					`The user sent the plan back with a note; plan mode is still active. Their note:\n${choice.text}\nIf it asks for a change, edit the plan file ${planFile} to make it. If it asks to see or explain something, answer that in text, briefly and in your own words (the plan is rendered above; the file is ${planFile}). Then call ${EXIT_PLAN_TOOL} again whatever you did: the review stays open until the user approves or declines, and ending your turn with a plan nobody approved leaves the work undone.`,
					false,
					snapshot("kept-planning", { feedback: choice.text }),
				);
			}
			if (choice.kind === "abort") return abortResult();
			// Esc: the turn ends (terminate), so the model cannot barrel on or loop on the tool
			logPlanApproval(pi, toolCallId, telemetryOptions, null, "rejected", commandList);
			return result(PLAN_REJECTED_TEXT, false, snapshot("rejected"), { terminate: true });
		},
	});

	pi.registerFlag(BUILTIN_TOOLS_FLAG, {
		description: "Activate pi's built-in grep/find/ls tools (default: search with rtk in bash)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("mode", {
		description: "Pick or switch pi-keeper mode (default | auto | plan)",
		getArgumentCompletions: (prefix) => {
			const items = MODE_CYCLE.filter((m) => m.startsWith(prefix.trim())).map((m) => ({ value: m, label: m, description: MODES[m].badge }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const target = args.trim();
			// no argument: a selector (or, without a UI, the state as text)
			if (target === "") return selectMode(ctx);
			const mode = parseMode(target);
			if (mode === undefined) {
				ctx.ui.notify(`Unknown mode: ${target}. Valid: ${MODE_CYCLE.join(", ")}`, "error");
				return;
			}
			switchMode(mode, ctx);
		},
	});

	/**
	 * `/mode` without arguments: a selector listing the modes with the current
	 * one marked; Esc keeps it. Without a UI (a headless child) the state is
	 * shown as text instead — the rules summary lives in /permissions, but a
	 * session without a selector still needs the whole picture.
	 */
	async function selectMode(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			const { loaded } = syncProject(ctx);
			const lines = [`Current mode: ${MODES[currentMode].badge}`];
			if (loaded.exists) {
				const { allow, ask, deny, readDirs, fetchHosts, allowVerbatim } = loaded.rules;
				const state = allow.length + readDirs.length + fetchHosts.length + allowVerbatim.length === 0 ? "" : allowActive(loaded) ? " (loaded)" : ignoredKey === keyOf(loaded) ? " (ignored this session)" : " (awaiting review)";
				lines.push(`Project rules (${loaded.file}): allow ${allow.length + readDirs.length + fetchHosts.length + allowVerbatim.length}${state}, ask ${ask.length}, deny ${deny.length}`);
				for (const [list, rules] of [["allow", [...allow, ...allowVerbatim]], ["ask", ask], ["deny", deny]] as const) {
					for (const rule of rules) lines.push(`  ${list}: ${rule.text}`);
				}
			}
			const session = [...grants.prefixes.map((tokens) => patternText({ tokens, exact: false })), ...grants.exact.map((tokens) => patternText({ tokens, exact: true }))];
			if (grants.verbatim.length > 0) session.push(`${grants.verbatim.length} exact command${grants.verbatim.length === 1 ? "" : "s"}`);
			if (session.length > 0) lines.push(`Session rules: ${session.join(", ")}`);
			lines.push("/permissions lists, removes and adds rules");
			lines.push(`Usage: /mode [${MODE_CYCLE.join("|")}]`);
			ctx.ui.notify(sanitizeForTerminal(lines.join("\n")), "info");
			return;
		}
		const index = await userDialog(ctx, () => selectModeDialog(
			ctx,
			MODE_CYCLE.map((m) => ({
				icon: MODES[m].icon,
				badge: MODES[m].badge,
				color: MODES[m].color,
				description: MODES[m].description,
				current: m === currentMode,
			})),
			`Current mode: ${MODES[currentMode].icon} ${MODES[currentMode].badge}\nPick a mode (Esc keeps it)`,
			ctx.signal,
			(data) => runModeShortcut(data, ctx),
		));
		const mode = index === undefined ? undefined : MODE_CYCLE[index];
		if (mode !== undefined) switchMode(mode, ctx);
	}

	/** `/plan` while planning: the plan file's path and content. */
	function showPlan(ctx: ExtensionContext): void {
		if (planFilePath === undefined || !hasContent(planFilePath)) {
			ctx.ui.notify(sanitizeForTerminal(`No plan yet. Plan file: ${planFilePath ?? "(none)"}`), "info");
			return;
		}
		ctx.ui.notify(sanitizeForTerminal(`Plan file: ${planFilePath}\n\n${readFileSync(planFilePath, "utf8").trim()}`), "info");
	}

	/** `/plan open`: edit the plan file in pi's editor (any mode); changed text is written back. */
	async function openPlan(ctx: ExtensionContext): Promise<void> {
		if (planFilePath === undefined || !existsSync(planFilePath)) {
			ctx.ui.notify("No plan file in this session", "info");
			return;
		}
		const plan = readFileSync(planFilePath, "utf8");
		const revised = await userDialog(ctx, () => ctx.ui.editor("Edit plan", plan));
		// the external editor strips a trailing newline: compare without it
		if (revised === undefined || revised.trimEnd() === plan.trimEnd()) return;
		try {
			writeFileSync(planFilePath, `${revised.trim()}\n`);
			ctx.ui.notify("Plan updated", "info");
		} catch (error) {
			ctx.ui.notify(`Could not save the edited plan: ${(error as Error).message}`, "error");
		}
	}

	if (childMode === undefined) {
		pi.registerCommand("approvals", {
			description: "Open the permission asks that background subagents are waiting on",
			handler: async (_args, ctx) => {
				askCtx = ctx;
				askServer?.tick(); // pick up what arrived since the last poll
				if ((askServer?.openNow() ?? 0) === 0) ctx.ui.notify("No background approvals waiting.", "info");
			},
		});
	}

	pi.registerCommand("plan", {
		description: "Switch to plan mode, or show the plan when already planning; /plan <prompt> also sends the prompt; /plan open edits the plan file",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (childMode !== undefined) {
				switchMode("plan", ctx); // tells the user the child's mode is fixed
				return;
			}
			if (text === "open") return openPlan(ctx);
			if (text === "" && currentMode === "plan") return showPlan(ctx);
			switchMode("plan", ctx);
			// busy agent: queue as a follow-up instead of failing
			if (text !== "") pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});

	const LISTS: readonly RuleList[] = ["allow", "ask", "deny"];

	// The rulebook (rulebook.ts): behaviour rules that fire on the model's finished
	// answer. Read-only, so it lists and explains; permission rules are /permissions.
	pi.registerCommand("rules", {
		description: "List the rulebook rules (behaviour rules that fire on a bad answer) and their fires; /rules <name> shows one",
		getArgumentCompletions: (prefix) => {
			const wanted = prefix.trim().toLowerCase();
			const book = childMode === undefined ? syncRulebook({ cwd: sessionCwd ?? process.cwd() }) : undefined;
			const items = (book?.rules ?? []).filter((rule) => rule.name.toLowerCase().startsWith(wanted)).map((rule) => ({ value: rule.name, label: rule.name, description: rule.description }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			ensureUserRuleDir(getAgentDir()); // first use: create the folder and an example rule
			const book = syncRulebook(ctx);
			const wanted = args.trim().toLowerCase();
			const fires = (name: string): string => (firedRules.has(name) ? "1 fire" : "not fired");
			if (wanted !== "") {
				const rule = book.rules.find((r) => r.name.toLowerCase() === wanted);
				if (rule === undefined) {
					const names = book.rules.map((r) => r.name);
					ctx.ui.notify(sanitizeForTerminal(names.length === 0 ? `No rulebook rule is named ${args.trim()}.` : `No rulebook rule is named ${args.trim()}. Known: ${names.join(", ")}`), "error");
					return;
				}
				ctx.ui.notify(sanitizeForTerminal([
					`${rule.name} (${rule.kind}) — ${fires(rule.name)}`,
					rule.description,
					`condition: ${rule.condition}`,
					`file: ${rule.file}`,
					"",
					rule.body,
				].join("\n")), "info");
				return;
			}
			if (book.rules.length === 0 && book.problems.length === 0 && book.untrusted.length === 0) {
				ctx.ui.notify(sanitizeForTerminal(`No rulebook rules. Put one .md file per rule in ${userRuleDir(getAgentDir())}/ (all projects) or <project>/.pi/rules/ (one project):\n\n---\ndescription: One line on what must not happen.\ncondition: (?i)\\bshould work\\b\n---\nDo not say "should work". Run it and quote the result.\n\n"condition" is a JavaScript regex matched against the end of the model's answer; the text below the dashes is the correction the model receives.`), "info");
				return;
			}
			// a TUI gets the coloured view (rules-view.ts); anything else the plain listing
			const view = { rules: book.rules, untrusted: book.untrusted, problems: book.problems, fired: firedRules };
			if (ctx.mode === "tui") {
				await rulesPanel(ctx, view);
				return;
			}
			ctx.ui.notify(sanitizeForTerminal(rulesText(view)), "info");
		},
	});

	/** One line per rule and flag, with what removing it does. */
	interface PermissionEntry {
		label: string;
		remove: () => void;
	}

	function permissionEntries(ctx: ExtensionContext): PermissionEntry[] {
		const entries: PermissionEntry[] = [];
		for (const exact of [false, true]) {
			for (const tokens of [...(exact ? grants.exact : grants.prefixes)]) {
				entries.push({
					label: `[session] ${patternText({ tokens, exact })}`,
					remove: () => grants.removePattern(tokens, exact),
				});
			}
		}
		for (const key of [...grants.verbatim]) {
			entries.push({
				label: `[session] exact command: ${sanitizeForTerminal(key.length > 100 ? `${key.slice(0, 100)}\u2026` : key)}`,
				remove: () => grants.removeVerbatim(key),
			});
		}
		if (commandGrant !== undefined) {
			const grant = commandGrant;
			for (const rule of [...grant.rules]) {
				entries.push({
					label: `[command /${grant.name}] ${patternString(rule.tokens, rule.exact)} (this run only)`,
					remove: () => {
						grant.rules = grant.rules.filter((r) => r !== rule);
					},
				});
			}
		}
		if (sessionEdits) {
			entries.push({
				label: "[session] edits in the working directory allowed (default mode)",
				remove: () => {
					sessionEdits = false;
					syncGrants();
					refreshStatus(ctx);
				},
			});
		}
		for (const dir of [...grants.outsideReadDirs]) {
			entries.push({
				label: `[session] reads from ${sanitizeForTerminal(dir)}/ allowed`,
				remove: () => {
					grants.removeReadDir(dir);
					syncGrants();
				},
			});
		}
		for (const host of [...grants.fetchHosts]) {
			entries.push({
				label: `[session] fetches from ${sanitizeForTerminal(host)} allowed`,
				remove: () => {
					grants.removeFetchHost(host);
					syncGrants();
				},
			});
		}
		for (const repo of [...grants.gitRepos]) {
			entries.push({
				label: `[session] git in ${sanitizeForTerminal(repo)}/ allowed`,
				remove: () => {
					grants.removeGitRepo(repo);
					syncGrants();
				},
			});
		}
		if (grants.outsideReadsAllowed) {
			entries.push({
				label: "[session] reads outside the working directory allowed",
				remove: () => {
					grants.revokeOutsideReads();
					syncGrants();
				},
			});
		}
		const { loaded } = syncProject(ctx);
		const state = allowActive(loaded) ? "" : ignoredKey === keyOf(loaded) ? " (ignored)" : " (awaiting review)";
		for (const rule of loaded.rules.fetchHosts) {
			entries.push({
				label: `[project allow] ${sanitizeForTerminal(rule.text)} (curl/wget GETs)${state}`,
				remove: () => {
					const result = removeRule(ctx.cwd, getAgentDir(), "allow", rule.text, allowActive(loaded) ? loaded.hash : undefined);
					projectState = undefined;
					if (!result.removed) ctx.ui.notify(`${rule.text} is no longer in ${RULES_FILE}`, "warning");
				},
			});
		}
		for (const rule of loaded.rules.allowVerbatim) {
			entries.push({
				label: `[project allow] ${sanitizeForTerminal(rule.text)} (exact text)${state}`,
				remove: () => {
					const result = removeRule(ctx.cwd, getAgentDir(), "allow", rule.text, allowActive(loaded) ? loaded.hash : undefined);
					projectState = undefined;
					if (!result.removed) ctx.ui.notify(`${rule.text} is no longer in ${RULES_FILE}`, "warning");
				},
			});
		}
		for (const rule of loaded.rules.readDirs) {
			entries.push({
				label: `[project allow] ${rule.text} (reads; secrets still ask)${state}`,
				remove: () => {
					const result = removeRule(ctx.cwd, getAgentDir(), "allow", rule.text, allowActive(loaded) ? loaded.hash : undefined);
					projectState = undefined;
					if (!result.removed) ctx.ui.notify(`${rule.text} is no longer in ${RULES_FILE}`, "warning");
				},
			});
		}
		for (const list of LISTS) {
			for (const rule of loaded.rules[list]) {
				entries.push({
					label: `[project ${list}] ${rule.text}${list === "allow" ? state : ""}`,
					remove: () => {
						const result = removeRule(ctx.cwd, getAgentDir(), list, rule.text, allowActive(loaded) ? loaded.hash : undefined);
						projectState = undefined;
						if (!result.removed) ctx.ui.notify(`${rule.text} is no longer in ${RULES_FILE}`, "warning");
						else if (!result.trusted) ctx.ui.notify(`Removed from ${RULES_FILE}. The file holds unreviewed rules, so its allow rules will be reviewed again.`, "warning");
					},
				});
			}
		}
		return entries;
	}

	/** `/permissions add <allow|ask|deny> <pattern>`: validate, then save to the project file. */
	function addPermission(rest: string, ctx: ExtensionContext): void {
		const [listWord, ...words] = rest.trim().split(/\s+/);
		const list = LISTS.find((l) => l === listWord);
		if (list === undefined || words.length === 0) {
			ctx.ui.notify("Usage: /permissions add <allow|ask|deny> <pattern>, e.g. /permissions add deny git push *", "error");
			return;
		}
		const parsed = parsePattern(words.join(" "), list);
		if ("error" in parsed) {
			ctx.ui.notify(sanitizeForTerminal(`Not added: ${parsed.error}`), "error");
			return;
		}
		const { loaded } = syncProject(ctx);
		try {
			const saved = saveRules(ctx.cwd, getAgentDir(), list, [parsed.text], allowActive(loaded) ? loaded.hash : undefined);
			projectState = undefined;
			const exactNote = parsed.exact ? " (matches only this exact command; end with ` *` for a prefix)" : "";
			const trustNote = saved.trusted || list !== "allow" ? "" : "\nThe file holds unreviewed rules, so allow rules stay under review.";
			ctx.ui.notify(
				sanitizeForTerminal(saved.added.length === 0 ? `Already in ${RULES_FILE}: ${parsed.text}` : `Added to ${RULES_FILE} ${list}: ${parsed.text}${exactNote}${trustNote}`),
				saved.trusted || list !== "allow" ? "info" : "warning",
			);
		} catch (error) {
			ctx.ui.notify(sanitizeForTerminal(`Could not save to ${RULES_FILE}: ${error instanceof Error ? error.message : String(error)}`), "error");
		}
	}

	pi.registerCommand("permissions", {
		description: "List, remove and add permission rules (/permissions add <allow|ask|deny> <pattern>)",
		getArgumentCompletions: (prefix) => {
			const words = prefix.replace(/^\s+/, "").split(/\s+/);
			if (words.length === 1) {
				return "add".startsWith(words[0]) ? [{ value: "add ", label: "add", description: "Add a project rule" }] : null;
			}
			if (words.length === 2 && words[0] === "add") {
				const items = LISTS.filter((l) => l.startsWith(words[1])).map((l) => ({ value: `add ${l} `, label: l }));
				return items.length > 0 ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text.startsWith("add ") || text === "add") {
				addPermission(text.slice(3), ctx);
				return;
			}
			if (text !== "") {
				ctx.ui.notify("Usage: /permissions [add <allow|ask|deny> <pattern>]", "error");
				return;
			}
			for (;;) {
				const entries = permissionEntries(ctx);
				if (entries.length === 0) {
					ctx.ui.notify("No session or project rules. Add one with /permissions add <allow|ask|deny> <pattern>.", "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(sanitizeForTerminal(entries.map((e) => e.label).join("\n")), "info");
					return;
				}
				const labels = entries.map((e) => sanitizeForTerminal(e.label));
				const picked = await userDialog(ctx, () => ctx.ui.select("Permission rules (select one to remove it, Esc to close)", labels, ctx.signal === undefined ? undefined : { signal: ctx.signal }));
				const entry = picked === undefined ? undefined : entries[labels.indexOf(picked)];
				if (entry === undefined) return;
				const action = await userDialog(ctx, () => ctx.ui.select(sanitizeForTerminal(entry.label), [REMOVE, CANCEL], ctx.signal === undefined ? undefined : { signal: ctx.signal }));
				if (action !== REMOVE) continue;
				try {
					entry.remove();
				} catch (error) {
					ctx.ui.notify(sanitizeForTerminal(`Could not remove: ${error instanceof Error ? error.message : String(error)}`), "error");
				}
			}
		},
	});

	/**
	 * A setting `/keeper` manages: one entry per setting, so more can
	 * be added by extending the table below. Values persist in
	 * `<agent dir>/pi-keeper.json`. `kind` says how it is set: a
	 * toggle (`on|off`), one of fixed choices, or a duration.
	 */
	type FlowSetting = {
		/** Argument name: `/keeper <key> <value>`. */
		readonly key: string;
		/** The panel's left column: what the setting is, without its value. */
		name(): string;
		/** Selector line and headless listing, with the current value. */
		label(): string;
		/** What the setting does; shown in the selector and the headless listing. */
		readonly summary: string;
	} & (
		| {
				readonly kind: "toggle";
				value(): boolean;
				/** Persist and apply the value; an error message when it failed. */
				set(value: boolean, ctx: ExtensionContext): string | undefined;
		  }
		| {
				readonly kind: "choice";
				readonly choices: readonly string[];
				value(): string;
				/** True while the value is the built-in default, so choosing that same value still saves it. */
				unsaved?(): boolean;
				set(value: string, ctx: ExtensionContext): string | undefined;
		  }
		| {
				readonly kind: "duration";
				/** Offered by completions and the selector, in the form the user may type (`5m`). */
				readonly presets: readonly string[];
				/** Accepted range, ms; typing anything outside it is an error, not a clamp. */
				readonly min: number;
				readonly max: number;
				value(): number;
				set(value: number, ctx: ExtensionContext): string | undefined;
		  }
	);

	/** What can be typed after the key, for completions and usage lines. */
	function settingValues(setting: FlowSetting): readonly string[] {
		return setting.kind === "toggle" ? ["on", "off"] : setting.kind === "choice" ? setting.choices : setting.presets;
	}

	/** The usage text after the key: `<on|off>`, `<idle|always|badge>`, `<duration, e.g. 90s, 5m, 2m30s>`. */
	function settingUsage(setting: FlowSetting): string {
		return setting.kind === "duration" ? `<duration: ${formatDuration(setting.min)} to ${formatDuration(setting.max)}, e.g. 90s, 5m, 2m30s>` : `<${settingValues(setting).join("|")}>`;
	}

	/** The mode flash's panel choices, and the one nearest to a value that was hand-edited into the file. */
	const MODE_FLASH_CHOICES = ["off", "1s", "2s", "3s", "5s"] as const;
	function modeFlashChoice(secs: number): string {
		if (secs <= 0) return "off";
		return MODE_FLASH_CHOICES.slice(1).reduce((best, choice) => (Math.abs(Number.parseFloat(choice) - secs) < Math.abs(Number.parseFloat(best) - secs) ? choice : best));
	}
	function modeFlashNote(): string {
		const secs = config.modeFlashSecs;
		return secs <= 0 ? "off" : `${secs} s`;
	}

	/** Whether pi-shell-highlight's highlighter is registered now (read at each use, so a later load counts). */
	const highlighterLoaded = (): boolean => commandHighlighter() !== undefined;

	/** The command color as the panel and the listings show it: the value in effect, and how it got there. */
	function commandColorsNote(): string {
		const loaded = highlighterLoaded();
		if (config.commandColors === undefined) return loaded ? "shell-highlight (default)" : "dim (default; pi-shell-highlight not installed)";
		if (config.commandColors === "shell-highlight" && !loaded) return "shell-highlight (not installed: using dim)";
		return config.commandColors;
	}

	/** pi-cc-extensions: pi lists its `/ccstyle` command (the fact the status check trusts most). */
	function ccExtensionsStatusNow(): CcExtensionsStatus {
		return ccExtensionsStatus(getAgentDir(), pi.getCommands().some((command) => command.source === "extension" && command.name === "ccstyle"));
	}

	/** Once per session: the id of the session the pi-cc-extensions dialog was offered in. */
	let ccPromptSession: string | undefined;

	/**
	 * Parent sessions with a UI, once per session: a dialog when pi-cc-extensions hides the plan
	 * approval and nothing has fixed it. It takes the dialog lock, so it never replaces an open
	 * permission dialog. Scheduled from session_start, so startup does not wait for the user.
	 */
	async function offerCcExtensionsFix(ctx: ExtensionContext): Promise<void> {
		if (!config.ccExtensionsPrompt) return;
		const id = ctx.sessionManager.getSessionId();
		if (ccPromptSession === id || ccExtensionsStatusNow() !== "needs-fix") return;
		ccPromptSession = id;
		const path = sanitizeForTerminal(ccSettingsPath(getAgentDir()));
		const APPLY = `Apply the fix to ${path}`;
		const EDITOR = "Put a prompt for the agent in the editor";
		const LATER = "Not now";
		const NEVER = "Don't ask again";
		const picked = await withDialogLock(
			() =>
				ctx.ui.select(
					`pi-cc-extensions hides pi-keeper's plan approval\npi-cc-extensions restyles tool rows, so the plan in plan mode's approval dialog is not shown. Adding exit_plan_mode to excludeRenderers in ${path} fixes it.`,
					[APPLY, EDITOR, LATER, NEVER],
					ctx.signal === undefined ? undefined : { signal: ctx.signal },
				),
			ctx.signal,
		);
		if (picked === APPLY) {
			const problem = excludeExitPlanMode(getAgentDir());
			if (problem !== undefined) ctx.ui.notify(sanitizeForTerminal(problem), "error");
			else ctx.ui.notify(`Added exit_plan_mode to excludeRenderers in ${path}. Run /reload (or restart pi) to apply it.`, "info");
		} else if (picked === EDITOR) {
			ctx.ui.setEditorText(`Add "exit_plan_mode" to the "excludeRenderers" list in ${path}, creating the list if it is missing and keeping every other setting unchanged. Then tell me to run /reload.`);
		} else if (picked === NEVER) {
			const problem = saveConfig(getAgentDir(), { ccExtensionsPrompt: false });
			if (problem !== undefined) ctx.ui.notify(sanitizeForTerminal(problem), "error");
			else config = { ...config, ccExtensionsPrompt: false };
		}
	}

	/** The settings table: the permission toggles, the subagent toggles, the background-ask popup and timeout, and the dialog's command colors. */
	function flowSettings(): FlowSetting[] {
		return [
			{
				kind: "toggle",
				key: "subagents-follow-auto",
				value: () => config.subagentsFollowAuto,
				name: () => "Subagents follow auto mode",
				label: () => `Subagents follow auto mode: ${config.subagentsFollowAuto ? "on" : "off"}`,
				summary: "On: when this session is in auto, subagents run in auto too, as long as they can ask you. Off: they run in default. In plan mode subagents are always read-only.",
				set(value, ctx) {
					const problem = saveConfig(getAgentDir(), { subagentsFollowAuto: value });
					if (problem !== undefined) return problem;
					config = { ...config, subagentsFollowAuto: value };
					syncBridge(ctx); // the next launch picks up the new child mode
					return undefined;
				},
			},
			{
				kind: "toggle",
				key: "project-exact-commands",
				value: () => config.projectExactCommands,
				name: () => "Allow exact commands in project",
				label: () => `Offer "always allow in this project" for exact commands: ${config.projectExactCommands ? "on" : "off"}`,
				summary: "On: for a command no prefix can safely cover (an interpreter call such as `python3 x.py`), the dialog also offers \"always allow\" for that exact command, in the current project only, saved to .pi/settings.local.json. Off: such a command can be allowed for this session at most.",
				set(value, ctx) {
					const problem = saveConfig(getAgentDir(), { projectExactCommands: value });
					if (problem !== undefined) return problem;
					config = { ...config, projectExactCommands: value };
					return undefined;
				},
			},
			{
				kind: "toggle",
				key: "project-command-approvals",
				value: () => config.projectCommandApprovals,
				name: () => "Allow commands in project",
				label: () => `Offer "always allow in this project" for commands: ${config.projectCommandApprovals ? "on" : "off"}`,
				summary: "On: the command dialog also offers \"always allow\" for the command's prefix (for example `npm test *`) and for fetch hosts, in the current project only. It is saved to this project's .pi/settings.local.json; other projects still ask. Off: command approvals last for one call or this session.",
				set(value) {
					const problem = saveConfig(getAgentDir(), { projectCommandApprovals: value });
					if (problem !== undefined) return problem;
					config = { ...config, projectCommandApprovals: value };
					return undefined;
				},
			},
			{
				kind: "toggle",
				key: "project-read-approvals",
				value: () => config.projectReadApprovals,
				name: () => "Allow read dirs in project",
				label: () => `Offer "always allow in this project" for outside read directories: ${config.projectReadApprovals ? "on" : "off"}`,
				summary: "Reads inside the current project never ask. On: when the agent reads a directory outside the project, the dialog also offers \"always allow reading from that directory while working in this project\", saved to this project's .pi/settings.local.json; other projects still ask, and secret files still ask. Off: an outside directory can be allowed once or for this session.",
				set(value) {
					const problem = saveConfig(getAgentDir(), { projectReadApprovals: value });
					if (problem !== undefined) return problem;
					config = { ...config, projectReadApprovals: value };
					return undefined;
				},
			},
			{
				kind: "toggle",
				key: "background-asks",
				value: () => config.backgroundAsks,
				name: () => "Background subagents can ask you",
				label: () => `Background subagents can ask you: ${config.backgroundAsks ? "on" : "off"}`,
				summary: "On: a background subagent's permission ask opens a dialog here. Off: its asks are denied, and \"Run auto when a background subagent can't ask\" sets its mode.",
				set(value, ctx) {
					const problem = saveConfig(getAgentDir(), { backgroundAsks: value });
					if (problem !== undefined) return problem;
					config = { ...config, backgroundAsks: value };
					// the ask server (and its heartbeat) runs only while asks are on; pending asks are denied when it stops
					startAsks(ctx);
					// child entry files read the config at child launch, so no syncBridge here
					return undefined;
				},
			},
			{
				kind: "choice",
				key: "subagent-thinking",
				choices: SUBAGENT_THINKING_MODES,
				value: () => config.subagentThinking,
				name: () => "Subagent thinking",
				label: () => `Subagent thinking: ${config.subagentThinking}`,
				summary: "follow: each subagent thinks at its own level or this session's, whichever is higher. role: it keeps the level from its agent file.",
				set(value, ctx) {
					const problem = saveConfig(getAgentDir(), { subagentThinking: value as SubagentThinkingMode });
					if (problem !== undefined) return problem;
					config = { ...config, subagentThinking: value as SubagentThinkingMode };
					// a parent publishes its level to children through the relay/snapshot
					parentThinking = currentThinkingLevel(ctx);
					syncGrants();
					return undefined;
				},
			},
			{
				kind: "toggle",
				key: "background-auto-fallback",
				value: () => config.backgroundAutoFallback,
				name: () => "Auto when background can't ask",
				label: () => `Run auto when a background subagent can't ask: ${config.backgroundAutoFallback ? "on" : "off"}`,
				summary: "Only for a background subagent that can't ask you. On: it runs in auto; dangerous commands, secrets and protected paths are still denied. Off: it runs in default, so its asks are denied.",
				set(value, ctx) {
					const problem = saveConfig(getAgentDir(), { backgroundAutoFallback: value });
					if (problem !== undefined) return problem;
					config = { ...config, backgroundAutoFallback: value };
					// child-default.ts / child-auto.ts read the config at child
					// launch, so no syncBridge here (unlike subagents-follow-auto)
					return undefined;
				},
			},
			{
				kind: "choice",
				key: "background-ask-popup",
				choices: POPUP_MODES,
				value: () => config.backgroundAskPopup,
				name: () => "When background asks pop up",
				label: () => `When background asks pop up: ${config.backgroundAskPopup}`,
				summary: "always (default): as soon as no other dialog is open. idle: when this session is idle; until then a badge shows and /approvals opens it. badge: only through /approvals.",
				set(value, ctx) {
					const problem = saveConfig(getAgentDir(), { backgroundAskPopup: value as BackgroundAskPopup });
					if (problem !== undefined) return problem;
					config = { ...config, backgroundAskPopup: value as BackgroundAskPopup };
					// the ask server reads the policy at every poll; nothing to restart
					return undefined;
				},
			},
			{
				kind: "duration",
				key: "background-ask-timeout",
				presets: ["1m", "2m", "5m", "10m", "15m", "30m"],
				min: MIN_BACKGROUND_ASK_TIMEOUT_MS,
				max: MAX_BACKGROUND_ASK_TIMEOUT_MS,
				value: () => config.backgroundAskTimeoutMs,
				name: () => "Background ask timeout",
				label: () => `Background ask timeout: ${formatDuration(config.backgroundAskTimeoutMs)}`,
				summary: "How long a background subagent waits for your answer before its ask is denied: 10s to 30m, for example 90s, 5m or 2m30s.",
				set(value) {
					const problem = saveConfig(getAgentDir(), { backgroundAskTimeoutMs: value });
					if (problem !== undefined) return problem;
					config = { ...config, backgroundAskTimeoutMs: value };
					// the ask server reads its limit at every poll; child entry files read the config at child launch
					return undefined;
				},
			},
			{
				kind: "choice",
				key: "command-colors",
				choices: PREVIEW_TEXT_COLORS,
				value: () => effectiveCommandColors(config.commandColors, highlighterLoaded()),
				unsaved: () => config.commandColors === undefined,
				name: () => "Command colors",
				label: () => `Command colors in the dialog: ${commandColorsNote()}`,
				summary: "How the dialog colors long commands. shell-highlight colors command names and heredoc languages; it is the default when pi-shell-highlight is installed (pi install npm:pi-shell-highlight). builtin-syntax: pi's own highlighter. dim, muted, text: plain colors.",
				set(value) {
					const problem = saveConfig(getAgentDir(), { commandColors: value as PreviewTextColor });
					if (problem !== undefined) return problem;
					config = { ...config, commandColors: value as PreviewTextColor };
					setPreviewTextColor(config.commandColors); // the next dialog uses it, no reload
					return undefined;
				},
			},
			{
				kind: "toggle",
				key: "mode-status",
				value: () => config.modeStatus,
				name: () => "Mode in the footer",
				label: () => `Mode in the footer: ${config.modeStatus ? "on" : "off"}`,
				summary: "Shows the current mode (default, auto, plan) in the footer status line. Off hides it; the mode still applies, and the mode line after a switch and Alt+M work as before.",
				set(value, ctx) {
					const problem = saveConfig(getAgentDir(), { modeStatus: value });
					if (problem !== undefined) return problem;
					config = { ...config, modeStatus: value };
					if (ctx.hasUI && childMode === undefined) refreshStatus(ctx); // the footer follows at once
					return undefined;
				},
			},
			{
				kind: "toggle",
				key: "mode-working-row",
				value: () => config.modeWorkingRow,
				name: () => "Mode in the working row",
				label: () => `Mode in the working row: ${config.modeWorkingRow ? "on" : "off"}`,
				summary: "While the agent works in plan or auto mode, the working row reads \"\u00bb auto \u00b7 Working\" so the mode is in front of you. Off by default: the footer already shows the mode. Default mode keeps pi's own text.",
				set(value, ctx) {
					const problem = saveConfig(getAgentDir(), { modeWorkingRow: value });
					if (problem !== undefined) return problem;
					config = { ...config, modeWorkingRow: value };
					syncWorkingMessage(ctx); // the working row follows at once
					return undefined;
				},
			},
			{
				kind: "choice",
				key: "mode-flash",
				choices: MODE_FLASH_CHOICES,
				value: () => modeFlashChoice(config.modeFlashSecs),
				name: () => "Mode line after a switch",
				label: () => `Mode line after a switch: ${modeFlashNote()}`,
				summary: "Shows the mode, in its color: above the prompt for this long after a switch while idle (1s, 2s, 3s or 5s). For another length between 0.1 and 10 seconds, set modeFlashSecs in the file.",
				set(value, ctx) {
					const secs = value === "off" ? 0 : Number.parseFloat(value);
					const problem = saveConfig(getAgentDir(), { modeFlashSecs: secs });
					if (problem !== undefined) return problem;
					config = { ...config, modeFlashSecs: secs }; // the next switch uses it, no reload
					syncWorkingMessage(ctx); // the working row follows at once
					return undefined;
				},
			},
		];
	}

	/**
	 * The `/keeper` panel's tabs. Every setting of `flowSettings` appears in
	 * exactly one section, in the order listed here; the headless listing and the
	 * completions stay flat (and keep the array's order).
	 */
	function flowSections(): { id: string; label: string; groups: { label: string; keys: readonly string[] }[] }[] {
		return [
			{
				id: "settings",
				label: "Settings",
				groups: [
					{ label: "Project approvals", keys: ["project-command-approvals", "project-read-approvals", "project-exact-commands"] },
					{ label: "Dialog & mode line", keys: ["command-colors", "mode-flash", "mode-status", "mode-working-row"] },
				],
			},
			{
				id: "subagents",
				label: "Subagents",
				groups: [{ label: "", keys: ["subagents-follow-auto", "background-asks", "background-auto-fallback", "subagent-thinking", "background-ask-popup", "background-ask-timeout"] }],
			},
		];
	}

	/** The panel's sections, with each row's current value and help text. */
	function flowPanelSections(): PanelSection[] {
		const settings = flowSettings();
		const rows = (keys: readonly string[]): PanelItem[] =>
			keys.flatMap((key): PanelItem[] => {
				const setting = settings.find((s) => s.key === key);
				if (setting === undefined) return [];
				const values = setting.kind === "toggle" ? ["on", "off"] : setting.kind === "choice" ? [...setting.choices] : undefined;
				return [
					{
						id: setting.key,
						label: setting.name(),
						// the colors row carries a note about the value in effect; the value column has room for the name only
						description: setting.key === "command-colors" ? `${setting.summary} Now: ${commandColorsNote()}.` : setting.summary,
						...(values === undefined ? { placeholder: `e.g. ${(setting as { presets: readonly string[] }).presets.slice(0, 3).join(", ")}` } : { values }),
					},
				];
			});
		return flowSections().map((section) => ({
			id: section.id,
			label: section.label,
			items: section.groups.flatMap((group) => rows(group.keys)),
			// a single unnamed group needs no heading
			...(section.groups.length > 1 || section.groups.some((g) => g.label !== "") ? { groups: section.groups.map((g) => ({ label: g.label, items: rows(g.keys) })) } : {}),
		}));
	}

	/** The value a setting shows: on/off, the choice, or the duration. */
	function flowSettingText(setting: FlowSetting): string {
		if (setting.kind === "toggle") return setting.value() ? "on" : "off";
		if (setting.kind === "duration") return formatDuration(setting.value());
		return setting.value();
	}

	/**
	 * Apply `value` (already in the form the setting takes) unless it is the
	 * current one. Returns the message to show and whether it is an error; the
	 * caller decides where (a notification, or the panel's footer).
	 */
	function applyFlowSetting(setting: FlowSetting, value: boolean | string | number, ctx: ExtensionContext): PanelResult {
		if (value === setting.value() && (setting.kind !== "choice" || setting.unsaved?.() !== true)) return { message: `${setting.label()} (unchanged)` };
		const problem = (setting.set as (value: boolean | string | number, ctx: ExtensionContext) => string | undefined)(value, ctx);
		if (problem !== undefined) return { message: `Could not save the setting: ${problem}`, error: true };
		return { message: `${setting.label()} — saved to ${CONFIG_FILE}` };
	}

	/** The headless and non-TUI paths: apply, then say it. */
	function applyFlowSettingOutLoud(setting: FlowSetting, value: boolean | string | number, ctx: ExtensionContext): PanelResult {
		const result = applyFlowSetting(setting, value, ctx);
		ctx.ui.notify(sanitizeForTerminal(result.message), result.error === true ? "error" : "info");
		return result;
	}

	/** `/keeper <key> <value>` (a toggle also without a value: flip it). A warning on anything unusable. */
	function setFlowSetting(text: string, ctx: ExtensionContext): void {
		const words = text.split(/\s+/);
		const setting = flowSettings().find((s) => s.key === words[0]);
		if (setting === undefined) {
			ctx.ui.notify(sanitizeForTerminal(`Unknown setting: ${words[0]}. Valid: ${flowSettings().map((s) => s.key).join(", ")}`), "error");
			return;
		}
		const wanted = words[1];
		const usage = (): void => ctx.ui.notify(sanitizeForTerminal(`Usage: /keeper ${setting.key} ${settingUsage(setting)}`), "error");
		if (words.length > 2 || (wanted === undefined && setting.kind !== "toggle")) return usage();
		switch (setting.kind) {
			case "toggle": {
				if (wanted !== undefined && wanted !== "on" && wanted !== "off") return usage();
				applyFlowSettingOutLoud(setting, wanted === undefined ? !setting.value() : wanted === "on", ctx);
				return;
			}
			case "choice": {
				if (wanted === undefined || !setting.choices.includes(wanted)) return usage();
				applyFlowSettingOutLoud(setting, wanted, ctx);
				return;
			}
			case "duration": {
				const ms = wanted === undefined ? undefined : parseDuration(wanted);
				if (ms === undefined) return usage();
				if (ms < setting.min || ms > setting.max) {
					ctx.ui.notify(sanitizeForTerminal(`${setting.key} must be between ${formatDuration(setting.min)} and ${formatDuration(setting.max)}, not ${formatDuration(ms)}`), "error");
					return;
				}
				applyFlowSettingOutLoud(setting, ms, ctx);
				return;
			}
		}
	}

	pi.registerCommand("keeper", {
		description: "Show or change pi-keeper settings (/keeper <setting> <value>)",
		getArgumentCompletions: (prefix) => {
			const words = prefix.replace(/^\s+/, "").split(/\s+/);
			const settings = flowSettings();
			if (words.length === 1) {
				const items = settings.filter((s) => s.key.startsWith(words[0])).map((s) => ({ value: `${s.key} `, label: s.key, description: s.label() }));
				return items.length > 0 ? items : null;
			}
			if (words.length === 2) {
				const setting = settings.find((s) => s.key === words[0]);
				if (setting === undefined) return null;
				const items = settingValues(setting).filter((v) => v.startsWith(words[1])).map((v) => ({ value: `${setting.key} ${v}`, label: v, description: setting.label() }));
				return items.length > 0 ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text !== "") return setFlowSetting(text, ctx);
			const settings = flowSettings();
			// without a UI: the settings as text
			if (!ctx.hasUI) {
				const lines = ["pi-keeper settings:", ...settings.map((s) => `  ${sanitizeForTerminal(s.label())} — ${s.summary}`), `Usage: /keeper <${settings.map((s) => `${s.key} ${settingUsage(s)}`).join(" | ")}>`];
				ctx.ui.notify(sanitizeForTerminal(lines.join("\n")), "info");
				return;
			}
			// A TUI gets the sectioned panel (tabs, aligned columns); RPC and print
			// hosts have no custom components, so they keep the two-step select lists.
			if (ctx.mode === "tui") {
				await userDialog(ctx, () =>
					settingsPanel(ctx, `pi-keeper settings (${CONFIG_FILE})`, flowPanelSections(), {
						currentValue: (id) => {
							const setting = flowSettings().find((s) => s.key === id);
							return setting === undefined ? "" : flowSettingText(setting);
						},
						apply: (id, value) => {
							const setting = flowSettings().find((s) => s.key === id);
							if (setting === undefined) return { message: `Unknown setting: ${id}`, error: true };
							if (setting.kind === "duration") {
								const ms = parseDuration(value);
								if (ms === undefined) return { message: `${setting.name()}: type a duration like ${setting.presets.slice(0, 3).join(", ")}`, error: true };
								if (ms < setting.min || ms > setting.max) return { message: `${setting.name()} must be between ${formatDuration(setting.min)} and ${formatDuration(setting.max)}`, error: true };
								return applyFlowSetting(setting, ms, ctx);
							}
							return applyFlowSetting(setting, setting.kind === "toggle" ? value === "on" : value, ctx);
						},
					}),
				);
				return;
			}
			for (;;) {
				const labels = settings.map((s) => sanitizeForTerminal(s.label()));
				const title = sanitizeForTerminal(`pi-keeper settings (${CONFIG_FILE})\nSelect a setting to change it, Esc to close`);
				const picked = await userDialog(ctx, () => ctx.ui.select(title, labels, ctx.signal === undefined ? undefined : { signal: ctx.signal }));
				const setting = picked === undefined ? undefined : settings[labels.indexOf(picked)];
				if (setting === undefined) return;
				if (setting.kind === "toggle") {
					if (applyFlowSettingOutLoud(setting, !setting.value(), ctx).error === true) return;
					continue;
				}
				// a choice or a duration: a second list of its values, the current one marked; Esc goes back
				const values = setting.kind === "choice" ? setting.choices : setting.presets;
				const current = setting.kind === "choice" ? setting.value() : formatDuration(setting.value());
				const valueLabels = values.map((v) => sanitizeForTerminal(`${setting.kind === "choice" ? v : formatDuration(parseDuration(v) ?? 0)}${(setting.kind === "choice" ? v : formatDuration(parseDuration(v) ?? 0)) === current ? " (current)" : ""}`));
				const chosen = await userDialog(ctx, () => ctx.ui.select(sanitizeForTerminal(`${setting.label()}\nSelect a value, Esc to go back`), valueLabels, ctx.signal === undefined ? undefined : { signal: ctx.signal }));
				const value = chosen === undefined ? undefined : values[valueLabels.indexOf(chosen)];
				if (value === undefined) continue;
				if (applyFlowSettingOutLoud(setting, setting.kind === "choice" ? value : (parseDuration(value) ?? 0), ctx).error === true) return;
			}
		},
	});

	const cycle = async (ctx: ExtensionContext): Promise<void> => {
		switchMode(nextMode(), ctx);
	};
	// Ctrl+Shift+M needs the kitty/CSI-u keyboard protocol (otherwise it is
	// Enter); Alt+M works everywhere.
	pi.registerShortcut(Key.ctrlShift("m"), { description: "Cycle pi-keeper mode (default -> auto -> plan)", handler: cycle });
	pi.registerShortcut(Key.alt("m"), { description: "Cycle pi-keeper mode (default -> auto -> plan)", handler: cycle });

	// The system prompt gets one thing from us and it never changes: the mode-independent
	// contract (prompts/contract.md). pi renders its prompt from named sections and appends a
	// delta when a section differs, so a varying section would still be a prefix change — and
	// a prefix change flushes the prompt cache and, behind some gateways, fails every
	// later request of a session with signed thinking (docs/design.md). Everything that
	// varies travels as a hidden message instead: the mode text (applyMode steers it
	// mid-run), the user's rules, the plan file, the lane hint.
	// pi fires this once per submitted prompt, not per turn and not after a compaction.
	pi.on("before_agent_start", async (event, ctx) => {
		// The rules file may have changed (the model can edit it): review again
		await reviewProject(ctx);
		// A new user prompt starts a new run: earlier rejections no longer apply
		rejectedThisRun = false;
		runFires = 0;
		// A project rulebook file needs the same one-time review as its permission rules
		await reviewRules(ctx);
		// The skills the prompt names (the parent's and a child's inherited catalog) are
		// readable for this run, and for any child launched from it
		runSystemPrompt = event.systemPrompt;
		if (childMode === undefined) {
			// the level a child should follow can change between runs (model switch, Alt+T)
			const level = currentThinkingLevel(ctx);
			if (level !== undefined && level !== parentThinking) {
				parentThinking = level;
				syncGrants();
			}
		}
		if (childMode !== undefined) {
			// a parent that raised its level after this child started still reaches it (subagent-thinking)
			applyChildThinking(ctx);
			// A child's mode is fixed and its lane line says what a gated call ends in, so its text
			// stays in the prompt and in front of the agent's own instructions (real runs read it
			// there). A forced prompt replaces the whole prompt, so no section is set: only the
			// rules — which move with the parent's grants — arrive as a message.
			const prompt = [CHILD_PROMPTS[childMode], laneLine(ctx), scratchLine(), childTail()].filter((part) => part !== "").join("\n\n");
			const delivery = currentDelivery(ctx);
			return { systemPrompt: `${prompt}\n\n${event.systemPrompt}`, ...(delivery === undefined ? {} : { message: delivery }) };
		}
		if (config.modeInstructions === "prompt") {
			// Escape hatch (7-14B models follow rules better in the system prompt): the old
			// placement, paid for with a prompt change on every switch. The text is composed
			// fresh every time, not from the delivery tracking: a mid-run steer (applyMode)
			// lands in the branch and would otherwise read as "already delivered".
			event.systemPromptOptions.sections.pi_keeper = [contractSection("prompt"), modeMessageText(), rulesMessageText(ctx)]
				.filter((part) => part !== "")
				.join("\n\n");
			return;
		}
		// The one constant thing we add to pi's prompt: the mode-independent contract. Everything
		// that varies — the mode text, the plan file, the user's rules — is a message below.
		event.systemPromptOptions.sections.pi_keeper = contractSection();
		const delivery = currentDelivery(ctx);
		return delivery === undefined ? undefined : { message: delivery };
	});

	// A compaction can summarize the mode message away (a custom message is a valid cut point;
	// the system prompt is not — pi snapshots it into the compaction entry). While the agent runs
	// we steer the text back so the retry sees it; an idle compaction is caught by the branch
	// check on the next prompt.
	pi.on("session_compact", async (_event, ctx) => {
		// prompt placement: the text is in the system prompt, which a compaction keeps
		if (childMode === undefined && config.modeInstructions === "prompt") return;
		const delivery = currentDelivery(ctx);
		if (delivery !== undefined && !ctx.isIdle()) pi.sendMessage(delivery, { deliverAs: "steer" });
	});

	// A steer or follow-up from the user (also while streaming) ends the
	// "rejected: wait for instructions" state. Input sent by extensions doesn't.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") {
			rejectedThisRun = false;
			// Input queued while a run is active belongs to that run: it neither ends nor starts a grant
			if (event.streamingBehavior === undefined) {
				commandGrant = undefined;
				startWorkflowGrant(event.text, ctx);
			}
		}
		return { action: "continue" as const };
	});

	/**
	 * `/name args` where `name` is a prompt template, or `/skill:name args`
	 * where the skill's `SKILL.md` has `allowed-tools` frontmatter: its Bash
	 * grants cover the run that follows (default mode). Fail closed: any
	 * problem reading the file means no grants.
	 */
	function startWorkflowGrant(text: string, ctx: ExtensionContext): void {
		const name = /^\/(\S+)/.exec(text.trim())?.[1];
		if (name === undefined) return;
		const commands = pi.getCommands();
		// an extension command of that name runs instead of the template or skill
		if (commands.some((c) => c.name === name && c.source === "extension")) return;
		const command = commands.find((c) => c.name === name && (c.source === "prompt" || c.source === "skill"));
		if (command === undefined) return;
		try {
			const { frontmatter } = parseFrontmatter(readFileSync(command.sourceInfo.path, "utf8"));
			const { rules, warnings } = parseAllowedTools(frontmatter["allowed-tools"]);
			if (warnings.length > 0 && ctx.hasUI) ctx.ui.notify(sanitizeForTerminal(`/${name}: allowed-tools ${warnings.join("; ")}`), "warning");
			if (rules.length === 0) return;
			commandGrant = { name, rules };
			if (ctx.hasUI) {
				const shown = rules.map((r) => patternString(r.tokens, r.exact)).join(", ");
				ctx.ui.notify(sanitizeForTerminal(`/${name} may run without asking during this run: ${shown}${currentMode === "default" ? "" : " (applies in default mode only)"}`), "info");
			}
		} catch {
			// unreadable template or skill: no grants
		}
	}

	// The grants last for one run
	pi.on("agent_end", async (_event, ctx) => {
		commandGrant = undefined;
		// the run is over: background approvals that waited for it may open now
		if (askServer !== undefined) {
			askCtx = ctx;
			askServer.runEnded();
		}
	});
	pi.on("mcp_servers_change", async () => {
		hintsCache = new Map();
	});

	// The rulebook (rulebook.ts). `turn_end` is the one hook that carries the model's
	// finished answer for a turn and lets us append entries atomically: the hidden
	// correction and the fired record land together, in order, and the model's next
	// request sees the correction. Nothing is interrupted — the turn is already done,
	// no tool call is touched — which is the warn-only promise.
	//
	// It terminates: the fired set only grows and a rule fires once per session, so
	// each rule can ask for at most one continuation. The continuation is also
	// skipped when the turn had tool results (the run goes on anyway, and the draft is
	// already in the next request) and past RULES_PER_RUN_CAP fires in one run.
	pi.on("turn_end", async (event, ctx) => {
		if (childMode !== undefined || event.outcome !== "completed") return;
		const text = assistantText(event.message);
		if (text === "") return;
		const book = syncRulebook(ctx);
		const fired = matchRules(book.rules, text, firedRules);
		if (fired.length === 0) return;
		const at = new Date().toISOString();
		const entries: SessionBoundaryDraft[] = [
			...event.entries,
			{ type: "custom_message", customType: RULE_MESSAGE, content: correctionText(fired), display: false, details: { rules: fired.map(ruleKey) } },
		];
		for (const rule of fired) {
			// marking before the return keeps a retry of this turn from firing it twice
			firedRules.add(ruleKey(rule));
			const data: RuleFireRecord = { rule: ruleKey(rule), kind: rule.kind, description: rule.description, at };
			entries.push({ type: "custom", customType: RULE_FIRED_ENTRY, data });
		}
		const cont = event.toolResults.length === 0 && runFires < RULES_PER_RUN_CAP;
		if (cont) runFires++;
		return { entries, continue: cont };
	});

	// A parent's level change reaches its children at their next run (subagent-thinking: follow):
	// publishing it also refreshes the relay an in-process child reads live.
	pi.on("thinking_level_select", async (event, ctx) => {
		if (childMode !== undefined) return;
		parentThinking = isThinkingLevel(event.level) ? event.level : currentThinkingLevel(ctx);
		syncGrants();
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionEdits = false; // /new and /resume start without it
		commandGrant = undefined;
		modeNote = ""; // a re-entry or plan-file note belongs to the session that switched
		// rules already fired on this branch stay fired: a resume or a fork must not repeat a correction
		firedRules = firedFromBranch(ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>);
		runFires = 0;
		rulebookReviewKey = undefined;
		rulebookIgnoredKey = undefined;
		rulebookWarnedKey = undefined;
		rulebookApproved.clear();
		ignoredKey = undefined;
		approvedKey = undefined;
		warnedKey = undefined;
		if (childMode === undefined) {
			ensureUserRuleDir(getAgentDir()); // an updated install gets the rules folder and the example too
			// session grants end with the session. The guard is defensive: a child's grants come
			// from the parent through the relay, and a child holds none of its own to clear
			grants.reset();
		}
		hintsCache = new Map();
		callNotes.clear();
		scratchDir = undefined; // ...and with a fresh scratch dir (the old one is left on disk)
		config = loadConfig(getAgentDir());
		setPreviewTextColor(config.commandColors);
		if (ctx.hasUI && config.warnings.length > 0) ctx.ui.notify(sanitizeForTerminal(`pi-keeper: ${CONFIG_FILE}:\n${config.warnings.join("\n")}`), "warning");
		// scheduled, not awaited: session_start returns first, and the dialog opens once startup has settled
		if (childMode === undefined && ctx.hasUI) setTimeout(() => void offerCcExtensionsFix(ctx).catch(() => undefined), 0);
		// once per session, not per event: what a later comparison needs and what never changes mid-session
		logSession(pi, { model: ctx.model === undefined ? null : `${ctx.model.provider}/${ctx.model.id}`, promptVersion: PROMPT_VERSION });
		restoreState(ctx);
		syncRelay(ctx);
		startAsks(ctx);
		// whether this child's asks go to its parent's mailbox: decided once, so the lane line below stays constant
		parentAsks = childMode !== undefined && findUiRelay() === undefined && canAskParent(config, getAgentDir());
		if (childMode !== undefined) {
			// Freeze a child's composed prompt before its first run: the lane line is derived from
			// the relay and the live tool list, so a late answer would change its prompt between
			// runs — a prefix change in the child's own session.
			laneLine(ctx);
			scratchLine();
		}
		if (childMode === undefined) {
			// grants are per session: a switch withdraws the old session's snapshot
			const id = ctx.sessionManager.getSessionId();
			if (grantsSessionId !== undefined && grantsSessionId !== id) withdrawGrants(getAgentDir(), grantsSessionId);
			grantsSessionId = id;
			sessionCwd = ctx.cwd;
			publishedGrants = undefined;
			parentThinking = currentThinkingLevel(ctx);
			sweepStaleGrants(getAgentDir());
			syncGrants();
		}
		applyChildThinking(ctx);
		await reviewProject(ctx);
		await reviewRules(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		modeNote = ""; // a note from the branch we just left must not reach the next mode block
		// the fired records of the branch we switched to, not the one we left
		firedRules = firedFromBranch(ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>);
		restoreState(ctx);
		syncRelay(ctx);
		if (askServer !== undefined) askCtx = ctx; // pi's context goes stale after a switch
		await reviewProject(ctx);
		await reviewRules(ctx);
	});
	// Children of a session that is gone must not keep loading this extension
	pi.on("session_shutdown", async (_event, ctx) => {
		clearFlash(ctx);
		if (workingMessageSet && ctx.hasUI) {
			try {
				ctx.ui.setWorkingMessage();
			} catch {
				// a stale context; the row is gone with it
			}
		}
		workingMessageSet = false;
		bridge?.dispose();
		bridge = undefined;
		relayReg?.dispose();
		relayReg = undefined;
		stopAsks();
		if (grantsSessionId !== undefined) withdrawGrants(getAgentDir(), grantsSessionId);
		grantsSessionId = undefined;
		publishedGrants = undefined;
	});
}
