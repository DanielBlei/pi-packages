/**
 * User-level settings for pi-keeper, read from
 * `<agent dir>/pi-keeper.json` (the same place pi-cc-extensions keeps
 * its settings file):
 *
 *   { "readOnlyTools": ["web_search", "fetch_content"],
 *     "subagentsFollowAuto": true }
 *
 * `readOnlyTools` names tools from other packages that only read: they run
 * without a dialog in default mode and are allowed while planning. Global
 * only, never read from the project: a cloned repository must not be able to
 * grant itself tools. Names are exact (no wildcards). The shell and file
 * writers, `exit_plan_mode`, and the two tools that front other tools (`mcp`
 * runs any MCP sub-tool, `subagent` launches agents) can never be listed:
 * they are rejected here with a warning, and rules.ts ignores them whatever
 * this says.
 *
 * `subagentsFollowAuto` (default false) lets subagents of an auto-mode parent run in
 * auto mode too, as long as their permission asks can reach the user; `/keeper`
 * toggles it and saves it here.
 * `projectExactCommands` (default true) adds "Yes, and always allow this exact
 * command in this project" to the approval dialog for commands no prefix
 * can cover, saved to the project's .pi/settings.local.json (as a token rule when the
 * command can be written as one, else as the exact text `BashExact(...)`); `/keeper` toggles it and saves it here.
 * `backgroundAutoFallback` (default false) lets children whose asks cannot reach a
 * user (background asks off, or a parent without a UI, which writes no
 * heartbeat so its children fall back at launch) run in auto mode
 * instead of having every ask denied; `/keeper` toggles it and saves
 * it here.
 * `backgroundAsks` (default true) sends the permission asks of background
 * subagents to this session's user instead of denying them; with it on, a
 * background child follows its parent's mode (an auto parent with
 * `subagentsFollowAuto` gives auto) and `backgroundAutoFallback` only matters when it is
 * off. `backgroundAskTimeoutMs` (default 300000, 10 s to 30 min) is how long a
 * background child waits for the answer before its ask is denied. The env var
 * PI_KEEPER_BACKGROUND_ASKS=0 switches the feature off for a process.
 * `modeInstructions` (default "message") says where the mode rules go: "message"
 * appends them to the conversation when they change, which keeps the system
 * prompt constant (a changed prompt flushes the prompt cache and, behind some
 * gateways, fails every later request of a session with signed thinking);
 * "prompt" is the old behaviour of appending them to the system prompt, for
 * small local models that follow prompt rules better. Written by
 * hand only — `/keeper` has no entry for it yet.
 * `modeStatus` (default true) shows the mode in the footer status line; false hides it.
 * `modeWorkingRow` (default false) shows it in the working row too (`⏵⏵ auto · Working`,
 * plan and auto mode only). Both are set by the `/keeper` panel or by hand.
 * `modeFlashSecs` (default 0, which is off; otherwise 0.1 to 10) is how long the
 * mode (icon and badge, in the mode's color) shows above the prompt after a real
 * switch; it adds no permanent row. Set by the `/keeper` panel (off, 1, 2, 3 or 5 s) or by hand.
 * `backgroundAskPopup` (default "always") says when a permission ask from a
 * background subagent opens its dialog in this session: "always" as soon as no
 * other dialog is open, "idle" only when the session is idle and the editor is
 * empty (otherwise a status badge and `/approvals`), "badge" only through
 * `/approvals`. `/keeper` sets it, and `backgroundAskTimeoutMs`, and saves them here.
 * `ccExtensionsPrompt` (default true) says whether the session-start dialog about
 * pi-cc-extensions (see cc-extensions-compat.ts) may open. "Don't ask again" in that dialog
 * sets it to false; it is not in `/keeper`.
 * `commandColors` is how the permission dialog paints a long bash command, under its
 * "full command" label: the theme slots "dim", "muted" or "text", or one of the two
 * syntax values. Unset (the default) means "shell-highlight" when `pi-shell-highlight`
 * is loaded and "dim" when it is not, resolved each time a dialog opens (see
 * `effectiveCommandColors`). "builtin-syntax" is pi's own highlighter — strings,
 * variables, keywords and comments in the theme's syntax colors, the same one the
 * transcript uses for fenced code; it cannot color the name of an external command, and
 * it paints a heredoc body as one string. "shell-highlight" asks `pi-shell-highlight`
 * for a richer renderer (command names, and the inner language of a heredoc); set
 * explicitly without that package it means "dim". A theme's `dim` is often
 * only just readable on a dark background (obsidian-harbor's slate sits at 4.4:1), so a
 * long command reads better as "muted" or as one of the syntax values. A diff preview
 * keeps its added/removed colors. Set by the `/keeper` panel (section "Dialog")
 * and by hand; read once at session start, and live again when the panel changes it.
 * `subagentThinking` (default "follow") decides a child's thinking level.
 * "role" keeps what the agent file (or a launch) asked for; "follow" runs the
 * child at the higher of its own level and this session's current one, so a
 * parent that goes to high lifts its children without touching a role file.
 * `/keeper` sets it and saves it here.
 * Free of pi types so it is testable.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSubagentThinkingMode, type SubagentThinkingMode } from "./thinking.ts";

export const CONFIG_FILE = "pi-keeper.json";

/** Env kill switch for background asks: "0" in the environment of the parent or the child turns them off. */
export const BACKGROUND_ASKS_ENV = "PI_KEEPER_BACKGROUND_ASKS";

/** How long a background child waits for the parent's answer: default and bounds (ms). */
export const DEFAULT_BACKGROUND_ASK_TIMEOUT_MS = 300_000;
export const MIN_BACKGROUND_ASK_TIMEOUT_MS = 10_000;
export const MAX_BACKGROUND_ASK_TIMEOUT_MS = 30 * 60_000;

/** How long the mode line stays above the prompt after a switch: default and bounds (seconds); 0 turns it off. */
export const DEFAULT_MODE_FLASH_SECS = 0;
export const MIN_MODE_FLASH_SECS = 0.1;
export const MAX_MODE_FLASH_SECS = 10;

/**
 * Read-only tools of the packages in use (web access, code overview, LSP, ast
 * search, MCP resources) when the file doesn't say. `bg_wait` (pi-subagents)
 * only waits for background runs the session launched; asking for it gated
 * waiting on your own subagent. `todo` (rpiv-todo) only records the plan in the
 * transcript: it changes no file and runs nothing, so it is allowed in every
 * mode. The MCP resource tools are listed while `mcp` is not: `mcp` runs any
 * MCP sub-tool, these three only read what a server already offers.
 * `lsp_rename` is deliberately absent — it only previews a rename today, but
 * the name promises a write, and this list fails closed on such names (a user
 * can still add it by hand).
 */
export const DEFAULT_READ_ONLY_TOOLS: readonly string[] = [
	"web_search", "fetch_content", "get_search_content", "source_check", "code_overview",
	"lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references", "lsp_symbols", "lsp_code_actions", "lsp_completions",
	"ast_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
	"bg_wait", "todo",
];

/** When a background subagent's ask opens a dialog (see the header). */
export type BackgroundAskPopup = "idle" | "always" | "badge";

/** Theme slot for the full-command text in the permission dialog, or a syntax renderer (see the header). */
export type PreviewTextColor = "dim" | "muted" | "text" | "builtin-syntax" | "shell-highlight";

export const PREVIEW_TEXT_COLORS: readonly PreviewTextColor[] = ["dim", "muted", "text", "builtin-syntax", "shell-highlight"];

/** The plain theme slot the command is painted in when no highlighter is loaded. */
export const DEFAULT_PREVIEW_TEXT_COLOR: PreviewTextColor = "dim";

/**
 * The color a command is painted with. An unset value (undefined) is "shell-highlight" when
 * the highlighter is loaded, else "dim". An explicit "shell-highlight" without it is "dim";
 * every other explicit value is kept.
 */
export function effectiveCommandColors(configured: PreviewTextColor | undefined, highlighterAvailable: boolean): PreviewTextColor {
	if (configured === undefined) return highlighterAvailable ? "shell-highlight" : DEFAULT_PREVIEW_TEXT_COLOR;
	if (configured === "shell-highlight" && !highlighterAvailable) return DEFAULT_PREVIEW_TEXT_COLOR;
	return configured;
}

export const POPUP_MODES: readonly string[] = ["idle", "always", "badge"];

export interface KeeperConfig {
	readOnlyTools: ReadonlySet<string>;
	/** Subagents of an auto-mode parent run in auto mode too, while their asks can reach the user (the `/keeper` setting). Default false. */
	subagentsFollowAuto: boolean;
	/** Exact-command dialogs offer a persistent project rule (the `/keeper` setting). Default true. */
	projectExactCommands: boolean;
	/** Relay-less (background) children run in auto mode instead of being denied (the `/keeper` setting). Default false. */
	backgroundAutoFallback: boolean;
	/** Command dialogs offer "always allow <prefix> in this project" (the `/keeper` setting). Default true. */
	projectCommandApprovals: boolean;
	/** The session-start dialog about pi-cc-extensions may open (set by its "Don't ask again"). Default true. */
	ccExtensionsPrompt: boolean;
	/** Where the mode rules go: a message in the conversation, or (old behaviour) the system prompt. */
	modeInstructions: "message" | "prompt";
	/** Seconds the mode line shows above the prompt after a switch; 0 = off. Default 0 (off): it is intrusive. */
	modeFlashSecs: number;
	/** The mode in the footer status line. Default true; false hides it. */
	modeStatus: boolean;
	/** The mode in the working row (`<mode> · Working`) in plan and auto mode. Default false: the footer already shows it. */
	modeWorkingRow: boolean;
	/** Outside-read dialogs offer "always allow reading from <dir>/ in this project" (the `/keeper` setting). Default false: read grants stay session-only. */
	projectReadApprovals: boolean;
	/** Background subagents' asks reach this session's user instead of being denied (the `/keeper` setting). Default true. */
	backgroundAsks: boolean;
	/** How long a background child waits for the answer, in ms (10 s to 30 min). Default 300000. */
	backgroundAskTimeoutMs: number;
	/** When a background subagent's ask opens its dialog here. Default "always". */
	backgroundAskPopup: BackgroundAskPopup;
	/** A child's thinking level: its own ("role") or the higher of its own and the parent's ("follow"). Default "follow". */
	subagentThinking: SubagentThinkingMode;
	/** Theme slot for the full-command text in the permission dialog, or a syntax renderer. Undefined when unset: see `effectiveCommandColors`. */
	commandColors: PreviewTextColor | undefined;
	/** One line per problem (unreadable file, wrong shape, rejected name); empty when the file is fine or absent. */
	warnings: string[];
}

/** Tools a user cannot list: they write, or they front tools whose own behaviour the name hides. */
export const UNLISTABLE_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell", "edit", "write", "exit_plan_mode", "mcp", "subagent", "subagent_launch"]);

/** Tool names are plain identifiers (letters, digits, `_`, `-`, `.`, `:`). */
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

/** Parse the file's text; defaults plus a warning on anything unusable. */
export function parseConfig(text: string): KeeperConfig {
	const warnings: string[] = [];
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return fallback([`not valid JSON (${error instanceof Error ? error.message : String(error)}); using the defaults`]);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return fallback(["does not hold a JSON object; using the defaults"]);
	}
	const listed = (value as { readOnlyTools?: unknown }).readOnlyTools;
	if (listed !== undefined && !Array.isArray(listed)) warnings.push("readOnlyTools must be a list of tool names; using the defaults");
	const names = new Set<string>();
	if (Array.isArray(listed)) {
		for (const entry of listed) {
			if (typeof entry === "string" && UNLISTABLE_TOOLS.has(entry)) warnings.push(`readOnlyTools: ignored "${entry}" (it can run or change things, so it can't be listed)`);
			else if (typeof entry === "string" && TOOL_NAME.test(entry)) names.add(entry);
			else warnings.push(`readOnlyTools: ignored ${JSON.stringify(entry)} (not a plain tool name)`);
		}
	}
	let subagentsFollowAuto = false;
	const rawAuto = (value as { subagentsFollowAuto?: unknown }).subagentsFollowAuto;
	if (typeof rawAuto === "boolean") subagentsFollowAuto = rawAuto;
	else if (rawAuto !== undefined) warnings.push("subagentsFollowAuto must be true or false; using false");
	let projectExactCommands = true;
	const rawExact = (value as { projectExactCommands?: unknown }).projectExactCommands;
	if (typeof rawExact === "boolean") projectExactCommands = rawExact;
	else if (rawExact !== undefined) warnings.push("projectExactCommands must be true or false; using true");
	let backgroundAutoFallback = false;
	const rawHeadless = (value as { backgroundAutoFallback?: unknown }).backgroundAutoFallback;
	if (typeof rawHeadless === "boolean") backgroundAutoFallback = rawHeadless;
	else if (rawHeadless !== undefined) warnings.push("backgroundAutoFallback must be true or false; using false");
	const flag = (key: "projectCommandApprovals" | "projectReadApprovals" | "backgroundAsks" | "ccExtensionsPrompt" | "modeStatus" | "modeWorkingRow", fallbackValue: boolean): boolean => {
		const raw = (value as Record<string, unknown>)[key];
		if (typeof raw === "boolean") return raw;
		if (raw !== undefined) warnings.push(`${key} must be true or false; using ${fallbackValue}`);
		return fallbackValue;
	};
	const projectCommandApprovals = flag("projectCommandApprovals", true);
	const projectReadApprovals = flag("projectReadApprovals", false);
	const ccExtensionsPrompt = flag("ccExtensionsPrompt", true);
	const modeStatus = flag("modeStatus", true);
	const modeWorkingRow = flag("modeWorkingRow", false);
	let modeInstructions: "message" | "prompt" = "message";
	const rawInstructions = (value as { modeInstructions?: unknown }).modeInstructions;
	if (rawInstructions === "prompt") modeInstructions = "prompt";
	else if (rawInstructions !== undefined && rawInstructions !== "message") warnings.push('modeInstructions must be "message" or "prompt"; using "message"');
	let modeFlashSecs = DEFAULT_MODE_FLASH_SECS;
	const rawFlash = (value as { modeFlashSecs?: unknown }).modeFlashSecs;
	if (typeof rawFlash === "number" && Number.isFinite(rawFlash)) {
		modeFlashSecs = rawFlash === 0 ? 0 : Math.min(MAX_MODE_FLASH_SECS, Math.max(MIN_MODE_FLASH_SECS, rawFlash));
		if (modeFlashSecs !== rawFlash) warnings.push(`modeFlashSecs must be 0 (off) or between ${MIN_MODE_FLASH_SECS} and ${MAX_MODE_FLASH_SECS}; using ${modeFlashSecs}`);
	} else if (rawFlash !== undefined) warnings.push(`modeFlashSecs must be a number of seconds; using ${DEFAULT_MODE_FLASH_SECS}`);
	let backgroundAskPopup: BackgroundAskPopup = "always";
	const rawPopup = (value as { backgroundAskPopup?: unknown }).backgroundAskPopup;
	if (typeof rawPopup === "string" && POPUP_MODES.includes(rawPopup)) backgroundAskPopup = rawPopup as BackgroundAskPopup;
	else if (rawPopup !== undefined) warnings.push('backgroundAskPopup must be "idle", "always" or "badge"; using "always"');
	const backgroundAsks = flag("backgroundAsks", true);
	let subagentThinking: SubagentThinkingMode = "follow";
	const rawThinking = (value as { subagentThinking?: unknown }).subagentThinking;
	if (isSubagentThinkingMode(rawThinking)) subagentThinking = rawThinking;
	else if (rawThinking !== undefined) warnings.push('subagentThinking must be "follow" or "role"; using "follow"');
	let commandColors: PreviewTextColor | undefined;
	const rawPreviewColor = (value as { commandColors?: unknown }).commandColors;
	if (typeof rawPreviewColor === "string" && (PREVIEW_TEXT_COLORS as readonly string[]).includes(rawPreviewColor)) commandColors = rawPreviewColor as PreviewTextColor;
	else if (rawPreviewColor !== undefined) warnings.push(`commandColors must be "dim", "muted", "text", "builtin-syntax" or "shell-highlight"; using the default`);
	let backgroundAskTimeoutMs = DEFAULT_BACKGROUND_ASK_TIMEOUT_MS;
	const rawTimeout = (value as { backgroundAskTimeoutMs?: unknown }).backgroundAskTimeoutMs;
	if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout)) {
		backgroundAskTimeoutMs = Math.min(MAX_BACKGROUND_ASK_TIMEOUT_MS, Math.max(MIN_BACKGROUND_ASK_TIMEOUT_MS, Math.round(rawTimeout)));
		if (backgroundAskTimeoutMs !== rawTimeout) warnings.push(`backgroundAskTimeoutMs must be between ${MIN_BACKGROUND_ASK_TIMEOUT_MS} and ${MAX_BACKGROUND_ASK_TIMEOUT_MS}; using ${backgroundAskTimeoutMs}`);
	} else if (rawTimeout !== undefined) warnings.push(`backgroundAskTimeoutMs must be a number of milliseconds; using ${DEFAULT_BACKGROUND_ASK_TIMEOUT_MS}`);
	// readOnlyTools absent or unusable: the defaults; a valid list (empty included) replaces them
	return { readOnlyTools: Array.isArray(listed) ? names : new Set(DEFAULT_READ_ONLY_TOOLS), subagentsFollowAuto, projectExactCommands, backgroundAutoFallback, projectCommandApprovals, projectReadApprovals, ccExtensionsPrompt, modeInstructions, modeFlashSecs, modeStatus, modeWorkingRow, backgroundAsks, backgroundAskTimeoutMs, backgroundAskPopup, subagentThinking, commandColors, warnings };
}

function fallback(warnings: string[]): KeeperConfig {
	return { readOnlyTools: new Set(DEFAULT_READ_ONLY_TOOLS), subagentsFollowAuto: false, projectExactCommands: true, backgroundAutoFallback: false, projectCommandApprovals: true, projectReadApprovals: false, ccExtensionsPrompt: true, modeInstructions: "message", modeFlashSecs: DEFAULT_MODE_FLASH_SECS, modeStatus: true, modeWorkingRow: false, backgroundAsks: true, backgroundAskTimeoutMs: DEFAULT_BACKGROUND_ASK_TIMEOUT_MS, backgroundAskPopup: "always",subagentThinking: "follow", commandColors: undefined, warnings };
}

/** Background asks are on in this process: the setting, and the env kill switch not set to "0". */
export function backgroundAsksEnabled(config: Pick<KeeperConfig, "backgroundAsks">, env: NodeJS.ProcessEnv = process.env): boolean {
	return config.backgroundAsks && env[BACKGROUND_ASKS_ENV] !== "0";
}

/** The config in `agentDir`: defaults when the file is absent, defaults plus warnings when it is unusable. Never throws. */
export function loadConfig(agentDir: string): KeeperConfig {
	let text: string;
	try {
		text = readFileSync(join(agentDir, CONFIG_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback([]);
		return fallback([`could not read ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}; using the defaults`]);
	}
	return parseConfig(text);
}

/**
 * Persist settings to `<agent dir>/pi-keeper.json`, merging into what is
 * there: keys this package doesn't know are kept as they are. Atomic (a
 * temp file in the same directory, then rename), so a crash mid-write leaves
 * the old file. Returns a warning instead of throwing on any problem.
 */
export function saveConfig(agentDir: string, update: { subagentsFollowAuto?: boolean; projectExactCommands?: boolean; backgroundAutoFallback?: boolean; backgroundAsks?: boolean; projectCommandApprovals?: boolean; projectReadApprovals?: boolean; ccExtensionsPrompt?: boolean; backgroundAskPopup?: BackgroundAskPopup; backgroundAskTimeoutMs?: number; subagentThinking?: SubagentThinkingMode; commandColors?: PreviewTextColor; modeFlashSecs?: number; modeStatus?: boolean; modeWorkingRow?: boolean }): string | undefined {
	const file = join(agentDir, CONFIG_FILE);
	let value: Record<string, unknown>;
	try {
		const text = readFileSync(file, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// refuse rather than overwrite: the user's settings are kept until the file is fixed
			return `${CONFIG_FILE} is not valid JSON, so nothing was saved; fix or remove the file and try again`;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return `${CONFIG_FILE} is not a JSON object, so nothing was saved; fix or remove the file and try again`;
		}
		value = { ...(parsed as Record<string, unknown>) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return `could not read ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`;
		}
		// first save: nothing to merge into
		value = {};
	}
	if (update.subagentsFollowAuto !== undefined) value.subagentsFollowAuto = update.subagentsFollowAuto;
	if (update.projectExactCommands !== undefined) value.projectExactCommands = update.projectExactCommands;
	if (update.backgroundAutoFallback !== undefined) value.backgroundAutoFallback = update.backgroundAutoFallback;
	if (update.backgroundAsks !== undefined) value.backgroundAsks = update.backgroundAsks;
	if (update.projectCommandApprovals !== undefined) value.projectCommandApprovals = update.projectCommandApprovals;
	if (update.projectReadApprovals !== undefined) value.projectReadApprovals = update.projectReadApprovals;
	if (update.ccExtensionsPrompt !== undefined) value.ccExtensionsPrompt = update.ccExtensionsPrompt;
	if (update.backgroundAskPopup !== undefined) value.backgroundAskPopup = update.backgroundAskPopup;
	if (update.backgroundAskTimeoutMs !== undefined) value.backgroundAskTimeoutMs = update.backgroundAskTimeoutMs;
	if (update.subagentThinking !== undefined) value.subagentThinking = update.subagentThinking;
	if (update.commandColors !== undefined) value.commandColors = update.commandColors;
	if (update.modeFlashSecs !== undefined) value.modeFlashSecs = update.modeFlashSecs;
	if (update.modeStatus !== undefined) value.modeStatus = update.modeStatus;
	if (update.modeWorkingRow !== undefined) value.modeWorkingRow = update.modeWorkingRow;
	const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`);
		renameSync(temp, file);
		return undefined;
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// nothing to clean up
		}
		return `could not write ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * A duration as typed in `/keeper`: minutes and/or seconds, each with
 * its unit and in that order (`90s`, `5m`, `2m30s`). A bare number is
 * refused (is `5` seconds or minutes?). Milliseconds, or undefined when the
 * text does not follow that form. Range is the caller's business.
 */
export function parseDuration(text: string): number | undefined {
	const match = /^(?:(\d{1,6})m)?(?:(\d{1,6})s)?$/i.exec(text.trim());
	if (match === null || (match[1] === undefined && match[2] === undefined)) return undefined;
	return (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 1000;
}

/** A duration for display: `90 s`, `5 min`, `2 min 30 s` (whole seconds). */
export function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return [minutes > 0 ? `${minutes} min` : "", seconds > 0 || minutes === 0 ? `${seconds} s` : ""].filter((part) => part !== "").join(" ");
}
