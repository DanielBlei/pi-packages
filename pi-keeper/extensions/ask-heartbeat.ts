/**
 * The parent's "I am listening" note for the ask mailbox: while its ask
 * server runs, the parent keeps `<askDir>/alive` fresh (`{v:1, pid, at}`).
 * A background child sends an ask only while the note is fresh and names the
 * pid that published the session snapshot. Without it a child could wait out
 * its whole timeout on a parent that never started its server (an older
 * version, background asks off) or has stopped it. The file is removed when
 * the server stops. Written and read with the mailbox's hardening
 * (secure-file.ts); free of pi imports.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { ensureAskDir, type MailboxOptions } from "./ask-mailbox.ts";
import { readJsonFile, writeFileAtomic } from "./secure-file.ts";

/**
 * The parent rewrites the note at most this often. Ten seconds keeps a margin of
 * five under HEARTBEAT_STALE_MS, so a poll a little late never makes the parent
 * look gone, while the write (create + write + rename) drops from 30 to 6 a minute.
 */
export const HEARTBEAT_EVERY_MS = 10_000;
/** A note older than this is stale: the parent is not listening. */
export const HEARTBEAT_STALE_MS = 15_000;
const MAX_HEARTBEAT_BYTES = 1024;
const MAX_AHEAD_MS = 3000;

const heartbeatFile = (dir: string): string => join(dir, "alive");

/** Parent: publish the note. Throws on an unusable mailbox. */
export function writeHeartbeat(dir: string, pid: number, at: number, options: MailboxOptions = {}): void {
	ensureAskDir(dir, options);
	writeFileAtomic(heartbeatFile(dir), JSON.stringify({ v: 1, pid, at }));
}

/** Parent: withdraw the note. Never throws. */
export function removeHeartbeat(dir: string): void {
	try {
		rmSync(heartbeatFile(dir), { force: true });
	} catch {
		// the note goes stale on its own
	}
}

/** Child: whether `pid` published a note less than HEARTBEAT_STALE_MS before `now`. Missing, malformed, foreign or stale is false. */
export function heartbeatFresh(dir: string, pid: number, now: number, options: MailboxOptions = {}): boolean {
	try {
		const value = readJsonFile(heartbeatFile(dir), MAX_HEARTBEAT_BYTES, options.uid) as { v?: unknown; pid?: unknown; at?: unknown } | null;
		if (value === null || typeof value !== "object" || value.v !== 1 || value.pid !== pid || typeof value.at !== "number" || !Number.isFinite(value.at)) return false;
		// a little clock skew is fine; a note from the future is not a fresh one
		return value.at - now < MAX_AHEAD_MS && now - value.at < HEARTBEAT_STALE_MS;
	} catch {
		return false;
	}
}
