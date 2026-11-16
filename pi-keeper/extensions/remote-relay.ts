/**
 * The child side of the ask mailbox (ask-mailbox.ts): a background subagent
 * has no UI, so instead of denying a permission ask it files the tool call in
 * the parent session's mailbox and waits for the parent's answer. `askParent`
 * writes the request, polls for the reply, and returns allow, deny or
 * cancelled with a reason. It never throws: any I/O problem is a deny, because
 * a child that cannot reach its parent must fail closed, not hang.
 *
 * It stops waiting when
 *   - the parent replies (allow, deny with the parent's reason, cancelled);
 *   - the parent is gone (`parentAlive()` is false): deny `parent-gone` at once (and file the cancel);
 *   - `timeoutMs` passes: deny `timeout`;
 *   - the child's abort signal fires: cancelled.
 * The reply is read first on every poll, so an answer that raced with the
 * parent's exit still counts. The request, reply and cancel files are removed
 * in `finally`. For a timeout, an abort or a gone parent the cancel note is filed after that
 * cleanup (the parent only needs it to close the dialog of a call nobody waits
 * for any more; with no request left, the parent's sweep removes it).
 *
 * Free of pi imports so it is testable with fake timers (like ask-mailbox.ts).
 */

import { heartbeatFresh } from "./ask-heartbeat.ts";
import { askDirFor, cleanup, MAX_BYTES, newAskId, newNonce, readReply, writeCancel, writeRequest, type AskRequest, type ChildMode, type ReplyDecision, type ReplyReason } from "./ask-mailbox.ts";
import { backgroundAsksEnabled, type KeeperConfig } from "./config.ts";
import { PARENT_SESSION_ENV, readParentGrants, readParentPid } from "./session-grants.ts";

/** Poll interval for the parent's reply. */
export const REPLY_POLL_MS = 250;

/** Why an ask was denied: what the parent said, or what the child saw. */
export type RelayReason = ReplyReason | "parent-gone" | "error";

export interface RelayResult {
	decision: ReplyDecision;
	/** Set for a deny. */
	reason?: RelayReason;
}

export interface AskParentOptions {
	/** The mailbox directory (askDirFor). */
	dir: string;
	childMode: ChildMode;
	cwd: string;
	/** Who is asking, as the parent's dialog names it; sanitized here. */
	label: string;
	signal?: AbortSignal;
	/** Give up after this long. */
	timeoutMs: number;
	/** Reply poll interval; default REPLY_POLL_MS. */
	pollMs?: number;
	/** False once the parent session can no longer answer (checked on every poll). */
	parentAlive(): boolean;
}

// control characters, line/paragraph separators, zero-width and bidi marks (the mailbox schema's set)
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const MAX_LABEL = 80;

/** A label the mailbox accepts: no control or bidi characters, at most 80 characters, never empty. */
export function sanitizeLabel(label: string, fallback: string): string {
	const clean = label.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
	let out = "";
	for (const char of clean) {
		if (out.length + char.length > MAX_LABEL) break;
		out += char;
	}
	return out.trim() === "" ? fallback : out.trim();
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted === true) return resolve();
		const done = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** Ask the parent session's user about `call`. Never throws. */
export async function askParent(call: AskRequest["call"], options: AskParentOptions): Promise<RelayResult> {
	const { dir, signal } = options;
	const id = newAskId();
	let fileCancel = false;
	const aborted = (): boolean => signal?.aborted === true;
	try {
		if (aborted()) return { decision: "cancelled" };
		const nonce = newNonce();
		const request: AskRequest = { v: 1, id, nonce, childPid: process.pid, childLabel: sanitizeLabel(options.label, `subagent ${process.pid}`), childMode: options.childMode, cwd: options.cwd, call };
		// the parent drops a file this big unread: no point waiting for an answer that cannot come
		if (JSON.stringify(request).length > MAX_BYTES) return { decision: "deny", reason: "error" };
		writeRequest(dir, request);
		const deadline = Date.now() + options.timeoutMs;
		const pollMs = options.pollMs ?? REPLY_POLL_MS;
		for (;;) {
			const reply = readReply(dir, id, nonce);
			if (reply !== undefined) return reply.decision === "allow" ? { decision: "allow" } : { decision: reply.decision, ...(reply.decision === "deny" ? { reason: reply.reason ?? "rules" } : {}) };
			if (!options.parentAlive()) {
				fileCancel = true; // a slow parent that is still there closes the dialog of a call nobody waits for
				return { decision: "deny", reason: "parent-gone" };
			}
			if (Date.now() >= deadline) {
				fileCancel = true;
				return { decision: "deny", reason: "timeout" };
			}
			await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
			if (aborted()) {
				fileCancel = true;
				return { decision: "cancelled" };
			}
		}
	} catch {
		return { decision: "deny", reason: "error" };
	} finally {
		cleanup(dir, id);
		if (fileCancel) {
			try {
				writeCancel(dir, id);
			} catch {
				// the parent's ttl closes the dialog
			}
		}
	}
}

/**
 * Whether the parent session is listening right now: its snapshot names a
 * live process, and that process keeps a fresh heartbeat in the session's
 * mailbox (ask-heartbeat.ts). Checked before a request is filed and on every
 * poll, so a parent that never started its ask server, or stopped it, is
 * found out at once instead of after the timeout.
 */
export function parentListening(agentDir: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
	try {
		const pid = readParentPid(agentDir, env);
		const sessionId = env[PARENT_SESSION_ENV];
		return pid !== undefined && sessionId !== undefined && heartbeatFresh(askDirFor(agentDir, sessionId), pid, now);
	} catch {
		return false;
	}
}

/**
 * Whether this process may ask its parent: background asks are on (setting
 * and env kill switch), the parent session has a live snapshot (which needs
 * PI_SUBAGENT_PARENT_SESSION) and its ask server is listening. A nested
 * child names a child session, which publishes no snapshot, so it cannot.
 * Reads nothing but the config, the snapshot and the heartbeat; writes nothing.
 */
export function canAskParent(config: Pick<KeeperConfig, "backgroundAsks">, agentDir: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
	if (!backgroundAsksEnabled(config, env)) return false;
	try {
		return readParentGrants(agentDir, env) !== undefined && parentListening(agentDir, env, now);
	} catch {
		return false;
	}
}
