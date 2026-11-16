/**
 * UI relay for pi-subagents children: a child session has no UI (ctx.ui is
 * pi's no-op context), so a tool call that needs approval cannot ask anyone.
 * The parent registers itself here (a process-global registry, like the
 * required-extension bridge in subagents-bridge.ts) when it has a UI, and a
 * child then forwards its dialogs — select, text input, notifications — to
 * the parent, which shows them to its user.
 *
 * Only foreground children run in this process, so only they can find the
 * relay; background (`async: true`) children run in a separate runner
 * process and keep the fail-closed deny. Foreground children get their own
 * module instance of this extension (pi-subagents clears pi's extension
 * cache per child), which is why the connection has to go through
 * globalThis rather than module state.
 *
 * Fail closed: a registry we can't read, a relay of the wrong shape, or a
 * relay call that throws is treated as "no relay" — the child denies the
 * call. Nothing here throws.
 */

import type { Preview } from "./preview.ts";
import type { TitleLine } from "./title.ts";

/** Where the parent publishes the relay. */
export const RELAY_KEY = Symbol.for("pi-keeper.ui-relay.v1");

/** A select dialog to show in the parent's UI. */
export interface UiRelaySelectRequest {
	title: string;
	/** Styled title lines; the parent's dialog renders them when present. */
	lines?: readonly TitleLine[];
	options: readonly string[];
	/** Preview rendered above the options (edit diff or full command). */
	preview?: Preview;
	/** What Esc does, shown in the hints line ("reject" in the main dialog, "back" in a sub-list). */
	escLabel?: string;
	/** The child's abort signal; aborting closes the dialog like Esc. */
	signal?: AbortSignal;
}

/** A text input to show in the parent's UI. */
export interface UiRelayInputRequest {
	title: string;
	signal?: AbortSignal;
}

/** The parent session's session-scope permission state, read by its subagent children through the relay. */
export interface UiRelaySessionRules {
	prefixes: readonly (readonly string[])[];
	exact: readonly (readonly string[])[];
	/** "Yes, allow all edits this session" is set. */
	edits: boolean;
	/** "Yes, allow reads outside the working directory" is set. */
	outsideReads: boolean;
	/** Realpaths of directories granted for outside reads. Optional: a parent that predates it publishes none. */
	outsideReadDirs?: readonly string[];
	/** Hosts granted for curl/wget GETs ("Yes, allow fetching from <host> this session"). Optional: an older parent publishes none. */
	fetchHosts?: readonly string[];
	/** The parent session's working directory: a child's cwd must lie in its project (child-cwd.ts). Optional: an older parent publishes none. */
	cwd?: string;
	/** The parent session's current thinking level (`/keeper subagent-thinking: follow` runs the child at the higher of this and its own). Optional: an older parent publishes none. */
	thinking?: string;
}

/** A command pattern to remember: a token prefix, or the whole command when `exact`. */
export interface UiRelayPattern {
	tokens: readonly string[];
	exact: boolean;
}

/** What the parent publishes under RELAY_KEY while it has a UI. */
export interface UiRelay {
	readonly version: 1;
	/** The parent session id (labeling only). */
	readonly sessionId: string;
	/** Show a select dialog (optionally with a preview). Undefined on Esc or abort. */
	select(request: UiRelaySelectRequest): Promise<string | undefined>;
	/** Show a text input. Undefined on Esc or abort. */
	input(request: UiRelayInputRequest): Promise<string | undefined>;
	/** Show a notification in the parent's UI. */
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** The parent's session rules, read live. */
	sessionRules(): UiRelaySessionRules;
	/** Remember patterns in the parent's session list ("Yes, and don't ask again … this session" answered in a child). */
	rememberSession(patterns: readonly UiRelayPattern[]): void;
	/** Set "allow all edits" / "allow outside reads" in the parent session. */
	setSessionFlag(flag: "edits" | "outsideReads"): void;
	/** Add directories to the parent's outside-read grants ("Yes, and allow reading from <dir>/ this session" answered in a child). Optional: an older parent lacks it and the child keeps the grant locally. */
	grantReadDirs?(dirs: readonly string[]): void;
	/** Add hosts to the parent's fetch grants (answered in a child). Optional: an older parent lacks it and the child keeps the grant locally. */
	grantFetchHosts?(hosts: readonly string[]): void;
}

export interface RelayOptions {
	/** Test seam: the object holding the registry key (globalThis in production). */
	root?: Record<symbol, unknown>;
}

function isRelay(value: unknown): value is UiRelay {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<UiRelay>;
	return (
		candidate.version === 1 &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.select === "function" &&
		typeof candidate.input === "function" &&
		typeof candidate.notify === "function" &&
		typeof candidate.sessionRules === "function" &&
		typeof candidate.rememberSession === "function" &&
		typeof candidate.setSessionFlag === "function" &&
		(candidate.grantReadDirs === undefined || typeof candidate.grantReadDirs === "function") &&
		(candidate.grantFetchHosts === undefined || typeof candidate.grantFetchHosts === "function")
	);
}

/** The relay the parent published, or undefined when there is none we can use. Never throws. */
export function findUiRelay(options: RelayOptions = {}): UiRelay | undefined {
	try {
		const value = (options.root ?? (globalThis as Record<symbol, unknown>))[RELAY_KEY];
		return isRelay(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Publish `relay` as this process's relay (replacing any previous one, as on
 * /new or /resume). Undefined when `relay` is malformed.
 */
export function registerUiRelay(relay: UiRelay, options: RelayOptions = {}): { dispose(): void } | undefined {
	try {
		if (!isRelay(relay)) return undefined;
		const store = options.root ?? (globalThis as Record<symbol, unknown>);
		store[RELAY_KEY] = relay;
		return {
			dispose() {
				if (store[RELAY_KEY] === relay) delete store[RELAY_KEY];
			},
		};
	} catch {
		return undefined;
	}
}
