/**
 * The parent side of the ask mailbox (ask-mailbox.ts): answers the permission
 * asks of background subagents. The child asks, the parent decides: a request
 * is untrusted (the child's model may be prompt-injected), so nothing in it is
 * believed beyond the tool call and its working directory. The server only
 * moves requests and replies and decides WHEN a dialog opens; what a call is
 * judged as, and the dialog itself, come from the caller (`judge`, `ask`,
 * index.ts), which uses the same rules, grants and dialog code as the
 * session's own calls.
 *
 * Each poll (about every 500 ms): claim new requests, honour cancels, drop
 * requests whose child is gone, expire old ones, sweep leftovers. Every
 * queued request is judged again on each pass, so a grant given for one
 * request settles an identical one without a second dialog. `allow` and
 * `deny` are answered at once; only `ask` opens a dialog, one at a time,
 * and only when no other dialog is open (dialog-lock.ts) and the popup
 * policy says so:
 *
 *   idle    the session is idle and the editor empty, else a badge and /approvals
 *   always  as soon as no other dialog is open
 *   badge   only through /approvals
 *
 * Without a UI an ask is denied (reason `no-ui`), like a headless session's
 * own asks. When the session ends every pending request is denied with
 * `parent-session-ended` and its dialog is aborted, so no child waits for a
 * parent that is gone.
 *
 * Free of pi types so it is testable (like ask-mailbox.ts).
 */

import { HEARTBEAT_EVERY_MS, removeHeartbeat, writeHeartbeat } from "./ask-heartbeat.ts";
import { countWork } from "./perf.ts";
import { cleanup, ensureAskDir, pendingIds, readCancels, sweep, takeRequests, writeReply, type AskRequest, type ChildMode, type MailboxOptions, type ReplyDecision, type ReplyReason, type Taken } from "./ask-mailbox.ts";
import type { BackgroundAskPopup } from "./config.ts";
import type { ModeName } from "./modes.ts";
import { isPidAlive } from "./secure-file.ts";
import { childModeFor, relaylessChildMode } from "./subagents-bridge.ts";

/** Poll interval. */
export const POLL_MS = 500;
/** A request the user has not answered by then is denied (reason `timeout`). */
export const ASK_TTL_MS = 15 * 60_000;

/** The parent's per-request TTL: the child's own wait plus a minute, never below ASK_TTL_MS, so the parent never times out before the child. */
export function askTtlMs(childTimeoutMs: number): number {
	return Math.max(ASK_TTL_MS, childTimeoutMs + 60_000);
}
/** Extra time the mailbox keeps a timed-out request, so its child can still read the reply. */
const SWEEP_GRACE_MS = 60_000;
/** Requests held at once; more are denied unseen (a flood is a bug or an attack, not a user). */
export const MAX_QUEUE = 100;

/**
 * The mode a background child runs in, as this parent assigns it: the mode
 * its registered entry file gives (subagents-bridge.ts), and for a child with
 * no UI relay what child-default.ts / child-auto.ts pick (relaylessChildMode):
 * with background asks on the registered mode itself (an auto parent with
 * `subagentsFollowAuto` gives auto), else default, or auto with `background-auto-fallback`.
 * Plan stays plan. `backgroundAsks` is the effective flag (the setting and
 * the env kill switch).
 */
export function backgroundChildMode(mode: ModeName, settings: { subagentsFollowAuto: boolean; backgroundAutoFallback: boolean; backgroundAsks: boolean }): ChildMode {
	const registered = childModeFor(mode, settings.subagentsFollowAuto);
	if (registered === "plan") return "plan";
	return relaylessChildMode(registered, settings);
}

const STRICTNESS: Record<ChildMode, number> = { auto: 0, default: 1, plan: 2 };

/**
 * The stricter of two modes (plan > default > auto). The parent judges a
 * request in the stricter of its own clamp and the mode the child says it
 * runs in: a child that fell back to default (e.g. it saw no fresh heartbeat
 * at load) is never judged as auto, and one that claims more than the clamp
 * allows is still clamped.
 */
export function stricterMode(a: ChildMode, b: ChildMode): ChildMode {
	return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/** The status line for `count` asks waiting in the queue. */
export function badgeText(count: number): string {
	return `${count} background approval${count === 1 ? "" : "s"} waiting · /approvals`;
}

export interface PopupState {
	policy: BackgroundAskPopup;
	/** `/approvals` was run: open everything that waits. */
	forced: boolean;
	/** A run just ended: the session counts as idle. */
	assumeIdle: boolean;
	idle: boolean;
	editorEmpty: boolean;
}

/** Whether the next dialog may open now (the caller also checks that no other dialog is open). */
export function mayPopUp(state: PopupState): boolean {
	if (state.forced) return true;
	if (state.policy === "always") return true;
	if (state.policy === "badge") return false;
	return (state.idle || state.assumeIdle) && state.editorEmpty;
}

/** How the parent judged a request. */
export interface Verdict {
	action: "allow" | "deny" | "ask";
	/** The mode the call was judged in: the parent's own choice. */
	mode: ChildMode;
	/** The mode the request claimed, when it differs from `mode` (the claim is ignored, only noted). */
	claimed?: string;
	/** The rule that decided, for telemetry; null for a mode's fallback. */
	matcher: string | null;
}

type EventKind = "auto-allow" | "auto-deny" | "no-ui" | "cancelled" | "timeout" | "parent-gone" | "dropped" | "clamped";

/** What happened to a request without a dialog of its own (a dialog's answer is logged where it is shown). */
export interface ServerEvent {
	kind: EventKind;
	request: AskRequest;
	verdict?: Verdict;
	/** Parent-side ms since the request was claimed. */
	waitMs: number;
}

export interface AskServerOptions {
	/** The mailbox directory (askDirFor). */
	dir: string;
	/** Judge a request with the parent's own engine. Never trust the request beyond its call and cwd. */
	judge(request: AskRequest): Verdict;
	/** Show the dialog for a request judged `ask`; resolves "allow" or "deny". Aborting `signal` closes it. `receivedAt` is when the server claimed the request. */
	ask(request: AskRequest, signal: AbortSignal, receivedAt: number): Promise<"allow" | "deny">;
	hasUI(): boolean;
	isIdle(): boolean;
	editorEmpty(): boolean;
	/** Another dialog is open or waiting for the slot (isDialogLocked). */
	dialogBusy(): boolean;
	popup(): BackgroundAskPopup;
	/** Ring the terminal before a dialog opens. */
	attention(): void;
	/** Show (count > 0) or clear (0) the waiting badge. */
	badge(count: number): void;
	onEvent(event: ServerEvent): void;
	/** A mailbox problem worth telling the user about (reported once per distinct text). */
	warn?(message: string): void;
	/** Test seams. */
	setTimer?(tick: () => void, ms: number): { stop(): void };
	now?(): number;
	alive?(pid: number): boolean;
	/** Per-request TTL; a function is read at every poll, so a setting change applies to pending requests too. */
	ttlMs?: number | (() => number);
	/** The pid the heartbeat names (default: this process). */
	pid?: number;
}

export interface AskServer {
	/** One poll; the timer calls this. */
	tick(): void;
	/** A run ended: look at the queue now instead of at the next poll. */
	runEnded(): void;
	/** `/approvals`: open what waits, whatever the popup policy says. Returns how many were waiting. */
	openNow(): number;
	/** Requests held (queued or on screen). */
	pending(): number;
	/** The session is ending: deny everything pending, close its dialogs, stop polling. */
	stop(): void;
}

type Why = "cancel" | "timeout" | "dropped" | "ended";

interface Entry {
	request: AskRequest;
	receivedAt: number;
	/** Set once something other than the user's answer ended it. */
	why?: Why;
	controller?: AbortController;
	clampNoted?: boolean;
}

const defaultTimer = (tick: () => void, ms: number): { stop(): void } => {
	const timer = setInterval(tick, ms);
	timer.unref(); // polling must never keep the process alive
	return { stop: () => clearInterval(timer) };
};

export function startAskServer(options: AskServerOptions): AskServer {
	const { dir } = options;
	const now = options.now ?? Date.now;
	const alive = options.alive ?? isPidAlive;
	const ttlSetting = options.ttlMs ?? ASK_TTL_MS;
	let sweepTtl = 0;
	const currentTtl = (): number => (typeof ttlSetting === "function" ? ttlSetting() : ttlSetting);
	const taken: Taken = new Map();
	const queue: Entry[] = [];
	let open: Entry | undefined;
	let forced = false;
	let assumeIdle = false;
	let stopped = false;
	let shownBadge = 0;
	const warned = new Set<string>();
	let lastBeat = Number.NEGATIVE_INFINITY;

	/** Keep the "listening" note fresh (throttled); a mailbox that cannot be written just leaves it stale. */
	function beat(at: number): void {
		if (at - lastBeat < HEARTBEAT_EVERY_MS) return;
		lastBeat = at;
		try {
			writeHeartbeat(dir, options.pid ?? process.pid, at);
		} catch {
			// children then see a stale note and deny at once
		}
	}

	function reply(entry: Entry, decision: ReplyDecision, reason?: ReplyReason): void {
		try {
			writeReply(dir, taken, entry.request.id, { decision, ...(reason !== undefined ? { reason } : {}) });
		} catch {
			// the child is gone or the mailbox unusable: its own timeout covers it
		}
	}

	function emit(kind: EventKind, entry: Entry, verdict?: Verdict): void {
		try {
			options.onEvent({ kind, request: entry.request, ...(verdict !== undefined ? { verdict } : {}), waitMs: Math.max(0, now() - entry.receivedAt) });
		} catch {
			// telemetry must not break the mailbox
		}
	}

	function forget(entry: Entry): void {
		const at = queue.indexOf(entry);
		if (at >= 0) queue.splice(at, 1);
		if (open === entry) open = undefined;
	}

	/** Answer an entry that ended for a reason other than the user's answer. "ended" was answered by stop(). */
	function settle(entry: Entry, why: Why): void {
		if (why === "cancel") {
			reply(entry, "cancelled");
			emit("cancelled", entry);
		} else if (why === "timeout") {
			reply(entry, "deny", "timeout");
			emit("timeout", entry);
		} else if (why === "dropped") {
			// nobody is left to read a reply
			cleanup(dir, entry.request.id);
			taken.delete(entry.request.id);
			emit("dropped", entry);
		}
	}

	/** End an entry that is not (or not only) the user's to answer. */
	function end(entry: Entry, why: Why): void {
		if (entry.why !== undefined) return;
		entry.why = why;
		if (open === entry) {
			// its dialog closes; finish() settles it when the dialog returns
			entry.controller?.abort();
			return;
		}
		forget(entry);
		settle(entry, why);
	}

	function enqueue(request: AskRequest): void {
		const entry: Entry = { request, receivedAt: now() };
		if (queue.length >= MAX_QUEUE) {
			reply(entry, "deny", "rules");
			emit("auto-deny", entry);
			return;
		}
		queue.push(entry);
	}

	function judged(entry: Entry): Verdict {
		let verdict: Verdict;
		try {
			verdict = options.judge(entry.request);
		} catch {
			verdict = { action: "deny", mode: "default", matcher: null }; // fail closed
		}
		if (verdict.claimed !== undefined && entry.clampNoted !== true) {
			entry.clampNoted = true;
			emit("clamped", entry, verdict);
		}
		return verdict;
	}

	function finish(entry: Entry, decision: "allow" | "deny"): void {
		forget(entry);
		if (entry.why !== undefined) settle(entry, entry.why);
		else if (decision === "allow") reply(entry, "allow"); // the dialog logged the user's answer itself
		else reply(entry, "deny", "user");
		pump();
	}

	function openDialog(entry: Entry): void {
		open = entry;
		entry.controller = new AbortController();
		options.attention();
		let shown: Promise<"allow" | "deny">;
		try {
			shown = options.ask(entry.request, entry.controller.signal, entry.receivedAt);
		} catch (error) {
			shown = Promise.reject(error);
		}
		shown.then(
			(decision) => finish(entry, decision),
			() => finish(entry, "deny"), // a dialog that failed is no approval
		);
	}

	/** Answer what the rules settle, then open the next dialog if the policy allows. Never throws. */
	function pump(): void {
		try {
			settleAndOpen();
		} catch {
			// e.g. a stale context: the next poll tries again
		}
	}

	function settleAndOpen(): void {
		if (stopped) return;
		const ui = options.hasUI();
		for (const entry of [...queue]) {
			if (entry === open) continue;
			const verdict = judged(entry);
			if (verdict.action === "allow") {
				forget(entry);
				reply(entry, "allow");
				emit("auto-allow", entry, verdict);
			} else if (verdict.action === "deny") {
				forget(entry);
				reply(entry, "deny", "rules");
				emit("auto-deny", entry, verdict);
			} else if (!ui) {
				forget(entry);
				reply(entry, "deny", "no-ui");
				emit("no-ui", entry, verdict);
			}
		}
		if (open === undefined && queue.length > 0 && !options.dialogBusy()) {
			if (mayPopUp({ policy: options.popup(), forced, assumeIdle, idle: options.isIdle(), editorEmpty: options.editorEmpty() })) {
				assumeIdle = false;
				openDialog(queue[0]);
			}
		}
		assumeIdle = false;
		if (queue.length === 0) forced = false;
		const waiting = queue.length - (open === undefined ? 0 : 1);
		if (waiting !== shownBadge) {
			shownBadge = waiting;
			try {
				options.badge(waiting);
			} catch {
				// a status line that cannot be set is not worth failing over
			}
		}
	}

	function tick(): void {
		if (stopped) return;
		countWork("askTick");
		try {
			const at = now();
			const ttl = currentTtl();
			sweepTtl = Math.max(sweepTtl, ttl); // never shrinks: a lowered setting must not sweep away a timeout reply the child has yet to read
			beat(at);
			// One check of the mailbox per pass: the three reads below would each re-walk the same
			// directory chain. A refusal here is left to them, so their warnings stay what they were.
			let mailbox: MailboxOptions = {};
			try {
				ensureAskDir(dir);
				mailbox = { dirReady: true };
			} catch {
				// unusable: takeRequests reports it
			}
			const { requests, warnings } = takeRequests(dir, taken, at, mailbox);
			for (const request of requests) enqueue(request);
			for (const warning of warnings) {
				if (warned.has(warning)) continue;
				warned.add(warning);
				options.warn?.(warning);
			}
			for (const id of readCancels(dir, mailbox)) {
				const entry = queue.find((e) => e.request.id === id);
				if (entry !== undefined) end(entry, "cancel");
			}
			for (const entry of [...queue]) {
				if (entry.why !== undefined) continue;
				if (!alive(entry.request.childPid)) end(entry, "dropped");
				else if (at - entry.receivedAt >= ttl) end(entry, "timeout");
			}
			for (const id of sweep(dir, taken, at, sweepTtl + SWEEP_GRACE_MS, alive, mailbox)) {
				const entry = queue.find((e) => e.request.id === id);
				if (entry !== undefined) end(entry, "dropped");
			}
			pump();
		} catch {
			// one bad poll must not stop the next
		}
	}

	const timer = (options.setTimer ?? defaultTimer)(tick, POLL_MS);
	beat(now());

	return {
		tick,
		runEnded() {
			assumeIdle = true;
			pump();
		},
		openNow() {
			const waiting = queue.length;
			if (waiting === 0) return 0;
			forced = true;
			pump();
			return waiting;
		},
		pending: () => queue.length,
		stop() {
			if (stopped) return;
			// one last look, so a request that just arrived is denied too and not left waiting
			try {
				for (const request of takeRequests(dir, taken, now()).requests) enqueue(request);
			} catch {
				// whatever was claimed is denied below
			}
			stopped = true;
			timer.stop();
			removeHeartbeat(dir);
			const held = new Set(pendingIds(taken));
			for (const entry of [...queue]) {
				if (!held.has(entry.request.id)) continue;
				entry.why = "ended";
				reply(entry, "deny", "parent-session-ended");
				emit("parent-gone", entry);
			}
			for (const entry of queue) entry.controller?.abort();
			queue.length = 0;
			open = undefined;
			if (shownBadge !== 0) {
				shownBadge = 0;
				try {
					options.badge(0);
				} catch {
					// the session is going away
				}
			}
		},
	};
}
