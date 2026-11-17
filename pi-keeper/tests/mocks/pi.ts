/**
 * A fake pi for end-to-end tests of extensions/index.ts: no pi process, no
 * model. `startPi` loads the real extension against a fake ExtensionAPI and
 * returns a harness that fires pi's events (session_start, input,
 * before_agent_start, tool_call, ...), runs registered commands, shortcuts and
 * tools, and answers the extension's dialogs from a script.
 *
 * Not a test file (tests/**\/*.test.ts only are run).
 *
 * Dialogs are scripted: `h.answer(titleMatch, choice)` queues an answer. A
 * dialog with no queued answer, or whose title does not match, throws, so an
 * unexpected prompt fails the test. `h.assertNoPendingAnswers()` catches
 * answers that were never used.
 *
 * Casts to the pi types are kept in this file (marked `cast:`) so tests
 * stay free of them.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findUiRelay } from "../../extensions/ui-relay.ts";
import { loadConfig } from "../../extensions/config.ts";
import { canAskParent } from "../../extensions/remote-relay.ts";
import { relaylessChildMode } from "../../extensions/subagents-bridge.ts";

initTheme();

let instances = 0;
const EXTENSION_DIR = new URL("../../extensions/", import.meta.url);

// ---------------------------------------------------------------------------
// Sandbox: every test gets its own project, agent dir and TMPDIR
// ---------------------------------------------------------------------------

export interface Sandbox {
	root: string;
	/** Project dir, with an empty `.git` directory. */
	cwd: string;
	/** Stands in for ~/.pi/agent (PI_CODING_AGENT_DIR). */
	agentDir: string;
	/** TMPDIR, so scratch dirs land inside the sandbox and are removed with it. */
	tmp: string;
	cleanup(): void;
}

export function makeSandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "pdf-flows-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const tmp = join(root, "tmp");
	for (const dir of [join(cwd, ".git"), agentDir, tmp]) mkdirSync(dir, { recursive: true });
	return { root, cwd, agentDir, tmp, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Bell capture
// ---------------------------------------------------------------------------

const bellWrites: string[] = [];
let bellStub: { mock: { restore(): void } } | undefined;

/**
 * Swallow (and record) string writes containing BEL so tests never ring the
 * developer's terminal. Everything else is forwarded: node:test reports through
 * the same stream. Idempotent; undone by restoreBell().
 */
function captureBell(): void {
	if (bellStub !== undefined) return;
	const original = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
	// cast: the overloaded write() signature can't be expressed for the mock implementation
	bellStub = mock.method(process.stdout, "write", ((chunk: unknown, ...rest: unknown[]) => {
		if (typeof chunk === "string" && chunk.includes("\x07")) {
			bellWrites.push(chunk);
			return true;
		}
		return original(chunk, ...rest);
	}) as typeof process.stdout.write);
}

/** Put process.stdout.write back (call from a top-level `after`). */
export function restoreBell(): void {
	bellStub?.mock.restore();
	bellStub = undefined;
}

// ---------------------------------------------------------------------------
// Scripted dialogs
// ---------------------------------------------------------------------------

/**
 * What to do with a dialog: pick an option (exact label, or the first label matching a RegExp), type text
 * (`input`: a text or editor dialog), press Esc, or drive the plan-approval selector with raw `keys`
 * (sent from the row it opens on) or `feedback` (typed into its field, then Enter). `"hang"` leaves a preview dialog open
 * until the extension aborts it.
 */
export type Choice = string | RegExp | { input: string; during?: () => unknown } | { keys: string[] } | { feedback: string } | "esc" | "hang";

/** Raw terminal input for `{ keys }` answers; ctrlShiftM is the kitty/CSI-u form (Alt+M works everywhere). */
export const KEY = { enter: "\r", escape: "\x1b", down: "\x1b[B", up: "\x1b[A", tab: "\t", shiftTab: "\x1b[Z", ctrlG: "\x07", altM: "\x1bm", ctrlShiftM: "\x1b[109;6u" };

interface Answer {
	title: RegExp | string;
	choice: Choice;
}

export interface DialogRecord {
	kind: "select" | "input" | "editor" | "custom";
	/** The dialog title; for `custom` (the preview dialog) the whole rendered text. */
	title: string;
	/** Option labels as offered (empty for `input`). */
	options: string[];
}

const KEYS = KEY;
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function titleMatches(expected: RegExp | string, title: string): boolean {
	return typeof expected === "string" ? title.includes(expected) : expected.test(title);
}

interface DialogComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate?(): void;
}

/** What a tool's execute returns (the parts the tests read). */
interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
	terminate?: boolean;
}

interface ToolSpec {
	execute: (...args: unknown[]) => Promise<ToolResult>;
	renderResult?: (result: ToolResult, options: unknown, theme: unknown, context: unknown) => DialogComponent;
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface StartOptions {
	sandbox: Sandbox;
	/** What pi loads: the extension itself, or a pi-subagents child entry file (a child has no UI unless `ui` says otherwise). */
	entry?: "index" | "child-plan" | "child-default" | "child-auto";
	/** "tui" (custom components, bell), "rpc" (dialogs through select/input), "none" (no dialogs at all). */
	ui?: "tui" | "rpc" | "none";
	/** Session entries to start from, as when resuming. */
	entries?: SessionEntry[];
	/** Result of `pi.exec(command, args)`; the default behaves like a machine without rtk (exit 127). */
	exec?: (command: string, args: string[]) => { code: number; stdout?: string; stderr?: string } | undefined;
	/** `pi.getAllTools()` annotations by tool name. */
	toolAnnotations?: Record<string, Record<string, unknown>>;
	/** `pi.getCommands()`: prompt templates, skills and extension commands. */
	commands?: Array<{ name: string; source: "prompt" | "skill" | "extension"; path?: string }>;
	/** The active tools the session starts with (the default is read/bash/edit/write plus one MCP tool). */
	activeTools?: string[];
	/**
	 * A pi-subagents runner process (PI_SUBAGENT_CHILD=1) where pi also loaded the
	 * package's index.ts as an ambient extension, before the child entry: both
	 * copies register on the same pi. Only meaningful with a child entry.
	 */
	runnerWithAmbientCopy?: boolean;
	/** A background child's wait for its parent (poll interval, timeout, parent liveness), so tests need not wait for the real ones. */
	/** The abort signal of the session's run (default: never aborts). */
	signal?: AbortSignal;
	/** `ctx.sessionManager.getSessionName()` (pi-subagents names a child run). */
	sessionName?: string;
	/** The system prompt `ctx.getSystemPrompt()` returns (pi renders the skills catalog into it). */
	systemPrompt?: string;
	/** The session's thinking level (`pi.getThinkingLevel()`), and the starting point for a child's level. */
	thinkingLevel?: string;
	remoteRelay?: { pollMs?: number; timeoutMs?: number; parentAlive?: () => boolean };
}

export interface SessionEntry {
	type: string;
	id: string;
	timestamp: string;
	customType?: string;
	data?: unknown;
	[key: string]: unknown;
}

/**
 * The plan file a mode message names, or "": the tests used to read it out of the system
 * prompt, which no longer carries it (the prompt is constant, the mode arrives as a message).
 */
export function planFileOf(h: Harness): string {
	for (const block of [...h.modeBlocks()].reverse()) {
		const found = /Plan file: (.+)/.exec(block);
		if (found !== null) return found[1].trim();
	}
	return "";
}

/** The session scratch dir a mode message names (a child names it in its prompt). */
export function scratchOf(h: Harness): string {
	const texts = [...h.modeBlocks()].reverse();
	for (const block of texts) {
		const found = /Scratch dir: (\S+)/.exec(block);
		if (found !== null) return found[1];
	}
	return "";
}

/** An assistant message with these text blocks, as `turn_end` carries it (one text per argument). */
export function assistantMessage(...texts: string[]): { role: "assistant"; content: Array<{ type: "text"; text: string }>; stopReason: "stop"; timestamp: number } {
	return { role: "assistant", content: texts.map((text) => ({ type: "text" as const, text })), stopReason: "stop", timestamp: Date.now() };
}

export interface ToolOutcome {
	blocked: boolean;
	reason?: string;
	terminate?: boolean;
	/** The event's input object, as handlers left it (rtk rewrite applied, approved fields locked). */
	input: Record<string, unknown>;
}

/** A finished tool run: the model-facing text and flags, the details snapshot, and the partial updates (`onUpdate`) it sent while running. */
export interface ToolRun {
	text: string;
	isError: boolean;
	terminate: boolean;
	content: Array<{ type: string; text: string }>;
	details: unknown;
	updates: Array<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

export interface Harness {
	readonly sandbox: Sandbox;
	/** Entries appended with pi.appendEntry, in order (the session log). */
	readonly entries: SessionEntry[];
	/** What `ctx.sessionManager.getBranch()` returns; defaults to all entries. */
	branch: SessionEntry[] | undefined;
	/** `ctx.isIdle()`. */
	idle: boolean;
	readonly notifications: Array<{ message: string; type: string | undefined }>;
	readonly statuses: Array<string | undefined>;
	/** The newest text set under a status key (`undefined` = cleared or never set). */
	statusOf(key: string): string | undefined;
	/** What `ctx.ui.getEditorText()` returns. */
	editorText: string;
	/** Runs one poll of the background-ask server (its timer is stepped by hand; see StartOptions). */
	pollAsks(): void;
	/** Every setWorkingMessage call; `undefined` = back to the default. */
	readonly workingMessages: Array<string | undefined>;
	readonly dialogs: DialogRecord[];
	/**
	 * Keeps each dialog open this long after it is answered (default 0: answered at once), so
	 * that dialogs opened at the same time overlap. pi shows one at a time; see maxOpenDialogs.
	 */
	dialogHoldMs: number;
	/** Dialogs open right now (opened, not yet closed). */
	readonly openDialogs: number;
	/** The most dialogs that were open at once. Above 1, one of them replaced another in pi's single editor slot. */
	readonly maxOpenDialogs: number;
	readonly sentMessages: Array<{
		message: { customType: string; content: unknown; display?: boolean; details?: unknown };
		options?: { deliverAs?: string; triggerTurn?: boolean };
	}>;
	readonly userMessages: Array<{ content: unknown; options?: { deliverAs?: string } }>;
	readonly execCalls: Array<{ command: string; args: string[] }>;
	activeTools(): string[];
	/** The session's thinking level (`pi.getThinkingLevel()`); settable to simulate a parent that changes it. */
	thinkingLevel: string;
	/** Every `pi.setThinkingLevel()` call, in order, as the levels asked for. */
	readonly thinkingLevelCalls: string[];
	/** Fires `thinking_level_select`, as Alt+T does (the extension republishes its level). */
	thinkingLevelSelected(level: string): Promise<void>;

	answer(title: RegExp | string, choice: Choice): void;
	assertNoPendingAnswers(): void;

	session(reason?: "startup" | "reload" | "new" | "resume" | "fork"): Promise<void>;
	tree(): Promise<void>;
	/** Fires `input`, then (unless streaming) `before_agent_start`; returns the system prompt after handlers. */
	prompt(text: string, options?: { streaming?: "steer" | "followUp"; source?: "interactive" | "rpc" | "extension" }): Promise<{ systemPrompt: string }>;
	/** The texts of the `customType` messages the extension delivered (sent or returned from before_agent_start), in order. */
	delivered(customType: string): string[];
	/** The mode messages (`pi-keeper-mode`), in order. */
	modeBlocks(): string[];
	/** The user-rules messages (`pi-keeper-rules`), in order. */
	rulesBlocks(): string[];
	/** Appends a compaction entry (dropping what came before, like pi's worst case) and fires `session_compact`. */
	compact(options?: { reason?: "manual" | "threshold" | "overflow"; willRetry?: boolean }): Promise<void>;
	/** Fires `tool_call`. */
	tool(toolName: string, input: Record<string, unknown>, options?: { id?: string }): Promise<ToolOutcome>;
	agentEnd(): Promise<void>;
	/**
	 * Fires `turn_end` with this assistant message (see `assistantMessage`), applies the
	 * custom / custom_message drafts the handlers return the way pi does, and reports
	 * whether a continuation was asked for.
	 */
	turnEnd(message: unknown, options?: { outcome?: "completed" | "aborted" | "error"; toolResults?: unknown[] }): Promise<{ continue: boolean }>;
	/** Renders a custom entry with the renderer registered for its `customType`; [] when there is none or it draws nothing. */
	renderEntry(customType: string, data: unknown, options?: { expanded?: boolean }): string[];
	/** Fires `session_shutdown`. */
	shutdown(): Promise<void>;
	/** `ctx.sessionManager.getSessionId()`; unique per harness. */
	readonly sessionId: string;
	command(name: string, args?: string): Promise<void>;
	complete(name: string, prefix: string): Array<{ value: string; label: string }> | null;
	shortcut(key: string): Promise<void>;
	/** The description a tool was registered with. */
	toolDescription(name: string): string;
	/** Runs a tool registered with pi.registerTool. */
	runTool(name: string, params: Record<string, unknown>, options?: { id?: string }): Promise<ToolRun>;
	/** Renders a tool result with the tool's own `renderResult`; pass `lastComponent` to reuse the previous row, as pi does. */
	renderToolResult(
		toolName: string,
		result: { content: Array<{ type: "text"; text: string }>; details?: unknown },
		options?: { width?: number; isPartial?: boolean; lastComponent?: DialogComponent },
	): { lines: string[]; component: DialogComponent };
	/** Renders the registered tool-row renderer for `toolName` around an inner renderer that draws `inner`. */
	renderCall(toolName: string, toolCallId: string, inner?: string[]): string[];
	/** Number of attention bells (BEL writes to stdout) since the harness started or `clearBells()`. */
	bells(): number;
	clearBells(): void;
	/** Writes the session as pi-session JSONL (header, custom entries, tool calls and results as messages) and returns the path. */
	exportSession(file: string): string;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Load a fresh extension instance against a fake pi. */
export async function startPi(options: StartOptions): Promise<Harness> {
	const { sandbox } = options;
	const entry = options.entry ?? "index";
	const uiMode = options.ui ?? (entry === "index" ? "tui" : "none");
	const sessionId = `test-session-${instances + 1}`;
	process.env.PI_CODING_AGENT_DIR = sandbox.agentDir;
	process.env.TMPDIR = sandbox.tmp;
	delete process.env.RTK_DISABLED;
	captureBell();
	const bellBase = { value: bellWrites.length };

	const entries: SessionEntry[] = [...(options.entries ?? [])];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }>();
	const shortcuts = new Map<string, (ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, ToolSpec>();
	const rendererResolvers: Array<(toolName: string, next: () => unknown) => unknown> = [];
	/** Entry renderers by customType (pi.registerEntryRenderer): a card the transcript would draw. */
	const entryRenderers = new Map<string, (entry: { data?: unknown }, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[] } | undefined>();
	let activeTools: string[] = options.activeTools ?? ["read", "bash", "edit", "write", "mcp__srv__list"];
	let idCounter = 0;

	/** A delivered message, as pi persists it (details included): the extension reads these back to avoid repeating itself. */
	function customMessageEntry(message: Harness["sentMessages"][number]["message"]): SessionEntry {
		return {
			type: "custom_message",
			id: `e${++idCounter}`,
			timestamp: new Date().toISOString(),
			customType: message.customType,
			content: message.content,
			display: message.display ?? true,
			details: (message as { details?: unknown }).details,
		};
	}

	/** pi renders a prompt as its base content followed by every section, each wrapped in its own tag. */
	function composeBase(sections: Record<string, string>): string {
		return ["BASE", ...Object.entries(sections).map(([name, content]) => `<${name}>\n${content}\n</${name}>`)].join("\n\n");
	}

	const dialogs: DialogRecord[] = [];
	const queue: Answer[] = [];
	const toolRecords: Array<{ id: string; name: string; input: Record<string, unknown>; blocked: boolean; at: string }> = [];

	const harness = {
		sandbox,
		entries,
		branch: undefined as SessionEntry[] | undefined,
		idle: true,
		notifications: [] as Harness["notifications"],
		statuses: [] as Array<string | undefined>,
		statusByKey: new Map<string, string | undefined>(),
		editorText: "",
		workingMessages: [] as Array<string | undefined>,
		dialogs,
		dialogHoldMs: 0,
		openDialogs: 0,
		maxOpenDialogs: 0,
		sentMessages: [] as Harness["sentMessages"],
		userMessages: [] as Harness["userMessages"],
		execCalls: [] as Harness["execCalls"],
		systemPrompt: options.systemPrompt ?? "BASE",
		thinkingLevel: options.thinkingLevel ?? "medium",
		thinkingLevelCalls: [] as string[],
	};

	// -- scripted UI -----------------------------------------------------------

	function nextAnswer(kind: DialogRecord["kind"], title: string): Answer {
		const answer = queue.shift();
		if (answer === undefined) throw new Error(`unscripted ${kind} dialog: ${JSON.stringify(title)}`);
		if (!titleMatches(answer.title, title)) {
			throw new Error(`${kind} dialog title ${JSON.stringify(title)} does not match the scripted ${String(answer.title)}`);
		}
		return answer;
	}

	function pick(choice: Choice, options: string[], title: string): string | undefined {
		if (choice === "esc") return undefined;
		if (typeof choice === "object" && !(choice instanceof RegExp)) throw new Error(`scripted a text answer for a selection dialog: ${JSON.stringify(title)}`);
		const found = typeof choice === "string" ? options.find((o) => o === choice) : options.find((o) => choice.test(o));
		if (found === undefined) throw new Error(`no option ${String(choice)} in ${JSON.stringify(options)} (dialog ${JSON.stringify(title)})`);
		return found;
	}

	/** Counts a dialog as open until the returned function runs (after dialogHoldMs). */
	function opened(): () => Promise<void> {
		harness.openDialogs++;
		harness.maxOpenDialogs = Math.max(harness.maxOpenDialogs, harness.openDialogs);
		return async () => {
			if (harness.dialogHoldMs > 0) await new Promise((resolve) => setTimeout(resolve, harness.dialogHoldMs));
			harness.openDialogs--;
		};
	}

	const ui = {
		theme: { fg: (_color: string, text: string): string => text, bold: (text: string): string => text, bg: (_color: string, text: string): string => text },
		async select(title: string, options: string[]): Promise<string | undefined> {
			dialogs.push({ kind: "select", title, options: [...options] });
			if (uiMode === "none") throw new Error(`dialog in a session without UI: ${JSON.stringify(title)}`);
			const close = opened();
			try {
				return pick(nextAnswer("select", title).choice, options, title);
			} finally {
				await close();
			}
		},
		async input(title: string): Promise<string | undefined> {
			dialogs.push({ kind: "input", title, options: [] });
			if (uiMode === "none") throw new Error(`dialog in a session without UI: ${JSON.stringify(title)}`);
			const close = opened();
			try {
				const { choice } = nextAnswer("input", title);
				if (choice === "esc") return undefined;
				if (typeof choice === "object" && !(choice instanceof RegExp) && "input" in choice) return choice.input;
				throw new Error(`scripted a selection for a text input dialog: ${JSON.stringify(title)}`);
			} finally {
				await close();
			}
		},
		async editor(title: string, _prefill?: string): Promise<string | undefined> {
			dialogs.push({ kind: "editor", title, options: [] });
			if (uiMode === "none") throw new Error(`dialog in a session without UI: ${JSON.stringify(title)}`);
			const close = opened();
			try {
				const { choice } = nextAnswer("editor", title);
				if (choice === "esc") return undefined;
				if (typeof choice === "object" && !(choice instanceof RegExp) && "during" in choice) await choice.during?.();
				if (typeof choice === "object" && !(choice instanceof RegExp) && "input" in choice) return choice.input;
				throw new Error(`scripted a selection for an editor dialog: ${JSON.stringify(title)}`);
			} finally {
				await close();
			}
		},
		/**
		 * The preview dialog and the plan selector: instantiate the component through its
		 * factory, read the option list off the rendered rows (stepping the selection), then press keys.
		 */
		custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => DialogComponent): Promise<T> {
			if (uiMode !== "tui") throw new Error("ui.custom is only available in tui mode");
			return new Promise<T>((resolveOpen) => {
				const close = opened();
				const resolve = (result: T): void => {
					void close().then(() => resolveOpen(result));
				};
				const keybindings = { matches: (data: string, id: string) => id === "app.editor.external" && data === KEYS.ctrlG };
				const component = factory({ requestRender() {}, terminal: { rows: 60 } }, ui.theme, keybindings, resolve);
				const rows = (): string[] => component.render(240).map(strip);
				// a selected row is "> label"; the plan selector numbers its rows and puts the feedback field after the label
				const selected = (): string => {
					const row = rows().find((l) => l.startsWith("> "))?.slice(2) ?? "";
					// the mode selector puts the description behind an em-dash; its label itself may contain padding spaces
					const dashed = row.replace(/^\d\. /, "").replace(/ — .*$/, "");
					const label = dashed.replace(/ {2}.*$/, "");
					return label.length >= 3 ? label : dashed.trimEnd();
				};
				const title = rows().join("\n");
				// Collect the rows. pi's select dialogs clamp at their ends; pi-tui's SettingsList
				// wraps around, so a walk can come back to where it started. Both are bounded here:
				// up until the selection stops moving (clamped) or a label repeats (wrapped), then
				// down for the rest. `labels` is in render order in both cases.
				const STEP_LIMIT = 128;
				const start = selected();
				const upOrder: string[] = [start];
				let wrapped = false;
				for (let i = 0; i < STEP_LIMIT; i++) {
					component.handleInput(KEYS.up);
					const now = selected();
					if (now === upOrder[upOrder.length - 1]) break; // clamped: the top does not move
					if (upOrder.includes(now)) {
						wrapped = true;
						break;
					}
					upOrder.push(now);
				}
				const labels: string[] = [];
				if (wrapped) {
					// the walk covered the whole cycle in reverse render order: turn it around, then
					// start at whichever label the render shows first
					const reversed = [...upOrder].reverse();
					const first = reversed.reduce((best, label) => (title.indexOf(label) < title.indexOf(best) ? label : best), reversed[0] ?? "");
					const at = Math.max(0, reversed.indexOf(first));
					labels.push(...reversed.slice(at), ...reversed.slice(0, at));
				} else {
					// the walk ended on the top row: list down from there
					labels.push(selected());
					for (let i = 0; i < STEP_LIMIT; i++) {
						component.handleInput(KEYS.down);
						const now = selected();
						if (now === labels[labels.length - 1] || labels.includes(now)) break;
						labels.push(now);
					}
				}
				// Reach a row: go to the first row (up comes round on a wrapping list and stops at the top of a
				// clamped one), then walk down to the target, which is in the list. Bounded either way.
				const walkTo = (label: string | undefined): void => {
					if (label === undefined || labels[0] === undefined) return;
					for (let i = 0; i < STEP_LIMIT && selected() !== labels[0]; i++) component.handleInput(KEYS.up);
					for (let i = 0; i < STEP_LIMIT && selected() !== label; i++) component.handleInput(KEYS.down);
				};
				dialogs.push({ kind: "custom", title, options: labels });
				const { choice } = nextAnswerFor(title, labels);
				// stays on screen until the extension closes it (its signal aborts): for tests of closing an open dialog
				if (choice === "hang") return;
				if (choice === "esc") return component.handleInput(KEYS.escape);
				if (typeof choice === "object" && !(choice instanceof RegExp)) {
					if ("keys" in choice) {
						// keys start where the dialog opened
						walkTo(start);
						for (const key of choice.keys) component.handleInput(key);
						return;
					}
					if ("feedback" in choice) {
						walkTo(labels[labels.length - 1]);
						for (const char of choice.feedback) component.handleInput(char);
						return component.handleInput(KEYS.enter);
					}
				}
				walkTo(pick(choice, labels, title));
				component.handleInput(KEYS.enter);
			});
		},
		notify(message: string, type?: string): void {
			harness.notifications.push({ message, type });
		},
		setStatus(key: string, text: string | undefined): void {
			harness.statuses.push(text);
			harness.statusByKey.set(key, text);
		},
		getEditorText: (): string => harness.editorText,
		setEditorText(text: string): void {
			harness.editorText = text;
		},
		setWorkingMessage(message?: string): void {
			harness.workingMessages.push(message);
		},
	};

	function nextAnswerFor(title: string, labels: string[]): Answer {
		try {
			return nextAnswer("custom", title);
		} catch (error) {
			throw new Error(`${(error as Error).message}\noptions: ${JSON.stringify(labels)}`);
		}
	}

	const signal = options.signal ?? new AbortController().signal;
	const makeContext = (): ExtensionContext =>
		// cast: only the parts of ExtensionContext the extension uses are provided
		({
			ui,
			mode: uiMode === "none" ? "print" : uiMode,
			hasUI: uiMode !== "none",
			cwd: sandbox.cwd,
			sessionManager: { getBranch: () => harness.branch ?? entries, getSessionId: () => sessionId, getSessionName: () => options.sessionName },
			signal,
			isIdle: () => harness.idle,
			isProjectTrusted: () => true,
			getSystemPrompt: () => harness.systemPrompt,
		}) as unknown as ExtensionContext;

	// -- fake ExtensionAPI -------------------------------------------------------

	// the background-ask server polls on a timer: stepped by hand here (pollAsks), so tests never wait for or leak a real one
	let askTick: (() => void) | undefined;
	const askServer = {
		setTimer: (tick: () => void) => {
			askTick = tick;
			return { stop: () => void (askTick = undefined) };
		},
	};
	const exec = options.exec ?? (() => undefined);
	const fakePi = {
		on(event: string, handler: Handler): () => void {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => undefined;
		},
		registerTool(tool: ToolSpec & { name: string }): void {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }): void {
			commands.set(name, spec);
		},
		registerShortcut(key: string, spec: { handler: (ctx: ExtensionContext) => unknown }): void {
			shortcuts.set(key, spec.handler);
		},
		registerFlag(): void {},
		getFlag: (): undefined => undefined,
		registerToolRenderer(resolver: (toolName: string, next: () => unknown) => unknown): void {
			rendererResolvers.push(resolver);
		},
		registerEntryRenderer(customType: string, renderer: (entry: { data?: unknown }, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[] } | undefined): void {
			entryRenderers.set(customType, renderer);
		},
		sendMessage(message: Harness["sentMessages"][number]["message"], opts?: Harness["sentMessages"][number]["options"]): void {
			harness.sentMessages.push({ message, options: opts });
			// pi persists every delivered message as a custom_message entry; the extension reads them back
			entries.push(customMessageEntry(message));
		},
		sendUserMessage(content: unknown, opts?: { deliverAs?: string }): void {
			harness.userMessages.push({ content, options: opts });
		},
		appendEntry(customType: string, data?: unknown): void {
			entries.push({ type: "custom", id: `e${++idCounter}`, timestamp: new Date().toISOString(), customType, data });
		},
		async exec(command: string, args: string[]) {
			harness.execCalls.push({ command, args });
			const result = exec(command, args);
			return { code: result?.code ?? 127, stdout: result?.stdout ?? "", stderr: result?.stderr ?? "", killed: false };
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]): void {
			activeTools = [...names];
		},
		getThinkingLevel: () => harness.thinkingLevel,
		setThinkingLevel(level: string): void {
			harness.thinkingLevelCalls.push(level);
			harness.thinkingLevel = level;
		},
		getAllTools: () => Object.entries(options.toolAnnotations ?? {}).map(([name, annotations]) => ({ name, annotations })),
		getCommands: () =>
			(options.commands ?? []).map((c) => ({ name: c.name, source: c.source, sourceInfo: { path: c.path ?? "", source: c.source, scope: "user", origin: "top-level" } })),
	};

	// cast: the fake implements the subset of ExtensionAPI the extension calls
	const pi = fakePi as unknown as ExtensionAPI;
	// every start is a fresh module instance (`?fresh=N`): session rules and flags are module-level,
	// so this is both test isolation and what restarting pi looks like. Child
	// entries load index.ts the same way, with the childMode option the real
	// child-default.ts / child-plan.ts wrappers pass (pi-subagents gives every
	// child its own module instance, so a shared cached one would not match it).
	// child-default.ts / child-auto.ts pick their mode by whether a UI relay
	// is reachable and (relay-less) whether the child can ask its parent or the
	// background-auto-fallback setting says auto, so the mock makes the same decisions
	// (relaylessChildMode, canAskParent) instead of fixed modes.
	const childModes = { "child-plan": "plan" } as const;
	const mod = (await import(`${new URL("index.ts", EXTENSION_DIR).href}?fresh=${++instances}`)) as {
		default: (pi: ExtensionAPI, options?: { childMode?: "default" | "plan" | "auto"; askServer?: { setTimer(tick: () => void, ms: number): { stop(): void } }; remoteRelay?: StartOptions["remoteRelay"] }) => void;
	};
	const relayless = (registered: "default" | "auto"): "default" | "auto" => {
		const config = loadConfig(sandbox.agentDir);
		return relaylessChildMode(registered, { backgroundAsks: canAskParent(config, sandbox.agentDir), backgroundAutoFallback: config.backgroundAutoFallback });
	};
	if (options.runnerWithAmbientCopy) {
		process.env.PI_SUBAGENT_CHILD = "1";
		const ambient = (await import(`${new URL("index.ts", EXTENSION_DIR).href}?fresh=${++instances}`)) as typeof mod;
		ambient.default(pi, { askServer });
	}
	const remoteRelay = options.remoteRelay;
	if (entry === "child-auto") mod.default(pi, { childMode: findUiRelay() === undefined ? relayless("auto") : "auto", remoteRelay });
	else if (entry === "child-default") mod.default(pi, { childMode: findUiRelay() === undefined ? relayless("default") : "default", remoteRelay });
	else if (entry in childModes) mod.default(pi, { childMode: childModes[entry as keyof typeof childModes], remoteRelay });
	else mod.default(pi, { askServer });
	// let the rtk probe (pi.exec at load) settle
	await new Promise((r) => setImmediate(r));

	// -- drivers ----------------------------------------------------------------

	async function fire(event: string, payload: Record<string, unknown>): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, makeContext()));
		return results;
	}

	const api: Harness = {
		...harness,
		get branch() {
			return harness.branch;
		},
		set branch(value) {
			harness.branch = value;
		},
		get idle() {
			return harness.idle;
		},
		set idle(value) {
			harness.idle = value;
		},
		get thinkingLevel() {
			return harness.thinkingLevel;
		},
		set thinkingLevel(value) {
			harness.thinkingLevel = value;
		},
		get editorText() {
			return harness.editorText;
		},
		set editorText(value) {
			harness.editorText = value;
		},
		statusOf: (key) => harness.statusByKey.get(key),
		pollAsks: () => askTick?.(),
		get dialogHoldMs() {
			return harness.dialogHoldMs;
		},
		set dialogHoldMs(value) {
			harness.dialogHoldMs = value;
		},
		get openDialogs() {
			return harness.openDialogs;
		},
		get maxOpenDialogs() {
			return harness.maxOpenDialogs;
		},
		activeTools: () => [...activeTools],

		answer: (title, choice) => void queue.push({ title, choice }),
		assertNoPendingAnswers() {
			assert.deepEqual(
				queue.map((a) => `${String(a.title)} -> ${JSON.stringify(a.choice)}`),
				[],
				"scripted dialog answers that were never asked",
			);
		},

		async session(reason = "startup") {
			await fire("session_start", { reason });
		},
		async tree() {
			await fire("session_tree", { newLeafId: null, oldLeafId: null });
		},
		async prompt(text, opts = {}) {
			await fire("input", { text, source: opts.source ?? "interactive", streamingBehavior: opts.streaming });
			// pi's prompt is "base + the sections, appended in order"; composing it here is what lets a test
			// catch text smuggled into a section instead of returned as a message
			const sections: Record<string, string> = {};
			let systemPrompt = "BASE";
			if (opts.streaming === undefined) {
				const results = await fire("before_agent_start", { prompt: text, systemPrompt, systemPromptOptions: { sections } });
				for (const result of results) {
					const next = (result as { systemPrompt?: string } | undefined)?.systemPrompt;
					if (next !== undefined) systemPrompt = next;
					const message = (result as { message?: Harness["sentMessages"][number]["message"] } | undefined)?.message;
					if (message !== undefined) entries.push(customMessageEntry(message));
				}
				if (systemPrompt === "BASE") systemPrompt = composeBase(sections);
			}
			harness.systemPrompt = systemPrompt;
			return { systemPrompt };
		},
		async tool(toolName, input, opts = {}) {
			const id = opts.id ?? `call-${++idCounter}`;
			let outcome: ToolOutcome = { blocked: false, input };
			const event = { type: "tool_call", toolCallId: id, toolName, input };
			for (const handler of handlers.get("tool_call") ?? []) {
				const result = (await handler(event, makeContext())) as { block?: boolean; reason?: string; terminate?: boolean } | undefined;
				if (result?.block === true) {
					outcome = { blocked: true, reason: result.reason, terminate: result.terminate, input };
					break;
				}
			}
			toolRecords.push({ id, name: toolName, input: { ...input }, blocked: outcome.blocked, at: new Date().toISOString() });
			return outcome;
		},
		async agentEnd() {
			await fire("agent_end", { messages: [] });
		},
		async turnEnd(message, opts = {}) {
			const proposal: Array<Record<string, unknown>> = [];
			let cont = false;
			for (const handler of handlers.get("turn_end") ?? []) {
				const event = { type: "turn_end", turnIndex: 1, message, toolResults: opts.toolResults ?? [], messageEntryId: `e${idCounter}`, toolResultEntryIds: [], entries: [...proposal], continue: false, outcome: opts.outcome ?? "completed", context: {} };
				const result = (await handler(event, makeContext())) as { entries?: unknown[]; continue?: boolean } | undefined;
				if (result?.entries !== undefined) {
					proposal.length = 0;
					proposal.push(...(result.entries as Array<Record<string, unknown>>));
				}
				if (typeof result?.continue === "boolean") cont = result.continue;
			}
			// pi commits the drafts after every handler has seen them, in list order
			for (const draft of proposal) {
				if (draft.type === "custom_message") {
					entries.push({ type: "custom_message", id: `e${++idCounter}`, timestamp: new Date().toISOString(), customType: draft.customType, content: draft.content, display: draft.display ?? true, details: draft.details } as SessionEntry);
				} else if (draft.type === "custom") {
					entries.push({ type: "custom", id: `e${++idCounter}`, timestamp: new Date().toISOString(), customType: draft.customType, data: draft.data } as SessionEntry);
				}
			}
			return { continue: cont };
		},
		renderEntry(customType, data, opts = {}) {
			const renderer = entryRenderers.get(customType);
			if (renderer === undefined) return [];
			const component = renderer({ data }, { expanded: opts.expanded === true }, ui.theme);
			return component === undefined ? [] : component.render(160).map(strip);
		},
		async thinkingLevelSelected(level: string) {
			const previousLevel = harness.thinkingLevel;
			harness.thinkingLevel = level;
			await fire("thinking_level_select", { level, previousLevel });
		},
		delivered(customType) {
			return entries.filter((e) => e.type === "custom_message" && e.customType === customType).map((e) => String(e.content));
		},
		modeBlocks() {
			return api.delivered("pi-keeper-mode");
		},
		rulesBlocks() {
			return api.delivered("pi-keeper-rules");
		},
		async compact(compactOptions = {}) {
			const entry: SessionEntry = {
				type: "compaction",
				id: `e${++idCounter}`,
				timestamp: new Date().toISOString(),
				summary: "summary",
				// null keeps nothing before it: the worst case for a delivered message
				firstKeptEntryId: null,
			};
			entries.push(entry);
			await fire("session_compact", {
				compactionEntry: entry,
				fromExtension: false,
				reason: compactOptions.reason ?? "manual",
				willRetry: compactOptions.willRetry ?? false,
			});
		},
		async shutdown() {
			await fire("session_shutdown", { reason: "quit" });
		},
		sessionId,
		async command(name, args = "") {
			const spec = commands.get(name);
			assert.ok(spec, `command /${name} is not registered`);
			await spec.handler(args, makeContext());
		},
		complete(name, prefix) {
			const spec = commands.get(name);
			assert.ok(spec?.getArgumentCompletions, `command /${name} has no completions`);
			return spec.getArgumentCompletions(prefix) as ReturnType<Harness["complete"]>;
		},
		async shortcut(key) {
			const handler = shortcuts.get(key);
			assert.ok(handler, `shortcut ${key} is not registered (have ${[...shortcuts.keys()].join(", ")})`);
			await handler(makeContext());
		},
		toolDescription(name) {
			const tool = tools.get(name);
			assert.ok(tool, `tool ${name} is not registered`);
			return String((tool as { description?: unknown }).description);
		},
		async runTool(name, params, opts = {}) {
			const tool = tools.get(name);
			assert.ok(tool, `tool ${name} is not registered`);
			const updates: ToolRun["updates"] = [];
			const onUpdate = (partial: ToolRun["updates"][number]): void => void updates.push(partial);
			const result = await tool.execute(opts.id ?? `call-${++idCounter}`, params, signal, onUpdate, makeContext());
			return {
				text: result.content.map((c) => c.text).join("\n"),
				isError: result.isError === true,
				terminate: result.terminate === true,
				content: result.content,
				details: result.details,
				updates,
			};
		},
		renderToolResult(toolName, result, opts = {}) {
			const tool = tools.get(toolName);
			assert.ok(tool?.renderResult, `tool ${toolName} has no renderResult`);
			const context = { toolCallId: "render", lastComponent: opts.lastComponent, isPartial: opts.isPartial === true, expanded: false, isError: false, state: {}, args: {} };
			const component = tool.renderResult(result, { expanded: false, isPartial: opts.isPartial === true }, ui.theme, context);
			return { lines: component.render(opts.width ?? 100).map(strip), component };
		},
		renderCall(toolName, toolCallId, inner = [`${toolName} row`]) {
			const innerComponent = { render: () => inner, invalidate() {} };
			const terminal = () => ({ renderCall: () => innerComponent });
			// resolvers run in load order; ours is the only one, so `next` yields the built-in renderer
			let renderers: unknown = terminal();
			for (const resolver of rendererResolvers) {
				const previous = renderers;
				renderers = resolver(toolName, () => previous);
			}
			const renderCall = (renderers as { renderCall?: (args: unknown, theme: unknown, context: unknown) => DialogComponent } | undefined)?.renderCall;
			assert.ok(renderCall, "no renderCall for the tool");
			return renderCall({}, ui.theme, { toolCallId, lastComponent: undefined }).render(100).map(strip);
		},
		bells: () => bellWrites.length - bellBase.value,
		clearBells() {
			bellBase.value = bellWrites.length;
		},
		exportSession(file) {
			const lines: unknown[] = [{ type: "session", version: 3, id: "test-session", timestamp: new Date().toISOString(), cwd: sandbox.cwd }];
			lines.push(...entries);
			for (const record of toolRecords) {
				lines.push({
					type: "message",
					id: `m-${record.id}`,
					timestamp: record.at,
					message: { role: "assistant", content: [{ type: "toolCall", id: record.id, name: record.name, arguments: record.input }], timestamp: Date.parse(record.at) },
				});
				lines.push({
					type: "message",
					id: `r-${record.id}`,
					timestamp: record.at,
					message: { role: "toolResult", toolCallId: record.id, toolName: record.name, isError: record.blocked, content: [], timestamp: Date.parse(record.at) },
				});
			}
			writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
			return file;
		},
	};
	// getters above can't be spread from `harness`: copy the live arrays explicitly
	Object.assign(api, {
		notifications: harness.notifications,
		statuses: harness.statuses,
		workingMessages: harness.workingMessages,
		sentMessages: harness.sentMessages,
		userMessages: harness.userMessages,
		execCalls: harness.execCalls,
	});
	return api;
}
