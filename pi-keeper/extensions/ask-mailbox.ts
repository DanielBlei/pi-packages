/**
 * File mailbox for permission asks from a background subagent. A background
 * child runs in a detached runner process with no UI, so it cannot open a
 * dialog. Instead it files a request carrying the raw tool call; the parent
 * session polls, decides with its own rules and grants (re-deciding, never
 * trusting the child), asks the user if needed, and writes back a reply with
 * only allow / deny / cancelled. The child polls for the reply and can file a
 * cancel (its abort signal fired). The child never sends grants.
 *
 *   <agent dir>/pi-keeper/asks/<sha256(parent session id)>/
 *     requests/<id>.json         child writes; parent claims by renaming to
 *     requests/<id>.json.taken   (rename is atomic: exactly one taker wins)
 *     replies/<id>.json          parent writes
 *     cancels/<id>.json          child writes
 *
 * Polling only, no fs.watch. Directories are 0700, files 0600, written by
 * tmp + rename. Everything read is hardened (secure-file.ts): lstat, regular
 * file only (no symlinks), our uid, at most 64 KB, then strict validation of
 * plain JSON: unknown or extra fields are rejected.
 *
 * receivedAt: the parent never trusts a child's clock or file mtimes. The
 * caller holds a `Taken` map (id -> parent-side receivedAt in ms), filled by
 * takeRequests and read by sweep. In-memory suits this: the parent process
 * is the only one that takes, and if it restarts the map is gone together
 * with the session, so sweep restarts the TTL clock for an unknown id.
 *
 * Reply authenticity. Each request carries a random nonce; the parent echoes
 * it in the reply and the child accepts a reply only when the nonce matches
 * AND `requests/<id>.json.taken` exists (the parent claimed the request). The
 * child also deletes any stale reply before filing. That defeats blind
 * pre-creation and stale reuse. It is not a defence against an active
 * same-uid forger: that boundary is that `<agentDir>/**` is a protected path
 * for the child's tools (isProtectedPath in utils.ts), so a child's tool calls
 * cannot write here. The parent in turn trusts nothing in a request beyond
 * the tool call, which it re-judges with its own rules and grants.
 *
 * Work per poll is bounded: takeRequests and sweep each handle at most
 * MAX_PER_PASS files.
 *
 * Free of pi types so it is testable (like config.ts).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentUid, ensureSecureDir, isPidAlive, readJsonFile, writeFileAtomic } from "./secure-file.ts";
import { countWork } from "./perf.ts";

const VERSION = 1;
/** A file larger than this is not one we wrote. */
export const MAX_BYTES = 64 * 1024;
/** Files handled per takeRequests / sweep call. */
export const MAX_PER_PASS = 64;
/** A leaked tmp file older than this is swept. */
const TMP_TTL_MS = 60_000;
const MAX_DEPTH = 16;
const MAX_KEYS = 2000;
const BAD_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

export type ChildMode = "default" | "auto" | "plan";
export type ReplyDecision = "allow" | "deny" | "cancelled";
export type ReplyReason = "parent-session-ended" | "asks-turned-off" | "timeout" | "user" | "rules" | "no-ui";

const MODES: readonly string[] = ["default", "auto", "plan"];
const DECISIONS: readonly string[] = ["allow", "deny", "cancelled"];
const REASONS: readonly string[] = ["parent-session-ended", "asks-turned-off", "timeout", "user", "rules", "no-ui"];

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
// eslint-disable-next-line no-control-regex
// control characters plus line/paragraph separators, zero-width and bidi marks/overrides/isolates
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const NONCE = /^[0-9a-f]{32}$/;
const MAX_LABEL = 80;
const MAX_CWD = 4096;

export interface AskRequest {
	v: 1;
	id: string;
	/** 16 random bytes, hex; the parent echoes it in the reply. */
	nonce: string;
	childPid: number;
	childLabel: string;
	childMode: ChildMode;
	cwd: string;
	call: { toolName: string; input: Record<string, unknown> };
}

export interface AskReply {
	v: 1;
	id: string;
	nonce: string;
	decision: ReplyDecision;
	reason?: ReplyReason;
}

export interface AskCancel {
	v: 1;
	id: string;
}

/** What the parent remembers about a claimed request. */
export interface TakenEntry {
	/** The parent's own clock when it claimed the request; the TTL runs from here. */
	receivedAt: number;
	/** The request's nonce, echoed in the reply. */
	nonce: string;
	/** A reply was written (or the request was dropped); no longer pending. */
	answered: boolean;
}

/** Parent-side: id -> entry. Doubles as the exactly-once seen-set and the pending set. */
export type Taken = Map<string, TakenEntry>;

/** Child: a fresh ask id. */
export function newAskId(): string {
	return randomUUID();
}

/** Child: a fresh nonce for a request. */
export function newNonce(): string {
	return randomBytes(16).toString("hex");
}

/** Parent: ids claimed but not yet answered (for "deny all" on a session switch). */
export function pendingIds(taken: Taken): string[] {
	return [...taken].filter(([, entry]) => !entry.answered).map(([id]) => id);
}

export interface MailboxOptions {
	/** Expected owner uid; defaults to the current uid. Injectable for tests. */
	uid?: number;
	/**
	 * The caller already ran `ensureAskDir` for this pass. A poll tick checks the mailbox
	 * once and then calls `takeRequests`, `readCancels` and `sweep`; without this each of
	 * the three would re-walk the same directory chain (four levels per subdir, nine in all).
	 */
	dirReady?: boolean;
}

/** Skip the directory check when the caller says it already did it in this pass. */
function ready(dir: string, options: MailboxOptions): void {
	if (options.dirReady === true) return;
	ensureAskDir(dir, options);
}

export function askDirFor(agentDir: string, parentSessionId: string): string {
	return join(agentDir, "pi-keeper", "asks", createHash("sha256").update(parentSessionId).digest("hex"));
}

// --- validation ---------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

/** Plain JSON only, no prototype-poisoning keys, bounded depth and key count. */
function isPlainJson(value: unknown, depth: number, budget: { keys: number }): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (depth >= MAX_DEPTH) return false;
	if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1, budget));
	if (!isRecord(value)) return false;
	for (const key of Object.keys(value)) {
		if (BAD_KEYS.includes(key) || ++budget.keys > MAX_KEYS) return false;
		if (!isPlainJson(value[key], depth + 1, budget)) return false;
	}
	return true;
}

export function isValidId(id: unknown): id is string {
	return typeof id === "string" && ID.test(id);
}

/** The request, or undefined when it is not exactly a v1 request. */
export function parseRequest(value: unknown): AskRequest | undefined {
	if (!isRecord(value) || !onlyKeys(value, ["v", "id", "nonce", "childPid", "childLabel", "childMode", "cwd", "call"])) return undefined;
	if (value.v !== VERSION || !isValidId(value.id)) return undefined;
	if (typeof value.nonce !== "string" || !NONCE.test(value.nonce)) return undefined;
	const { childPid, childLabel, childMode, cwd, call } = value;
	if (typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid <= 0) return undefined;
	if (typeof childLabel !== "string" || childLabel.length > MAX_LABEL || CONTROL.test(childLabel)) return undefined;
	if (typeof childMode !== "string" || !MODES.includes(childMode)) return undefined;
	if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > MAX_CWD || CONTROL.test(cwd)) return undefined;
	if (!isRecord(call) || !onlyKeys(call, ["toolName", "input"])) return undefined;
	if (typeof call.toolName !== "string" || !TOOL_NAME.test(call.toolName) || !isRecord(call.input) || !isPlainJson(call.input, 0, { keys: 0 })) return undefined;
	return { v: 1, id: value.id, nonce: value.nonce, childPid, childLabel, childMode: childMode as ChildMode, cwd, call: { toolName: call.toolName, input: call.input } };
}

export function parseReply(value: unknown): AskReply | undefined {
	if (!isRecord(value) || !onlyKeys(value, ["v", "id", "nonce", "decision", "reason"])) return undefined;
	if (value.v !== VERSION || !isValidId(value.id)) return undefined;
	if (typeof value.nonce !== "string" || !NONCE.test(value.nonce)) return undefined;
	if (typeof value.decision !== "string" || !DECISIONS.includes(value.decision)) return undefined;
	if (value.reason !== undefined && (typeof value.reason !== "string" || !REASONS.includes(value.reason))) return undefined;
	return {
		v: 1,
		id: value.id,
		nonce: value.nonce,
		decision: value.decision as ReplyDecision,
		...(value.reason !== undefined ? { reason: value.reason as ReplyReason } : {}),
	};
}

export function parseCancel(value: unknown): AskCancel | undefined {
	if (!isRecord(value) || !onlyKeys(value, ["v", "id"]) || value.v !== VERSION || !isValidId(value.id)) return undefined;
	return { v: 1, id: value.id };
}

// --- paths --------------------------------------------------------------

const requestFile = (dir: string, id: string) => join(dir, "requests", `${id}.json`);
const takenFile = (dir: string, id: string) => join(dir, "requests", `${id}.json.taken`);
const replyFile = (dir: string, id: string) => join(dir, "replies", `${id}.json`);
const cancelFile = (dir: string, id: string) => join(dir, "cancels", `${id}.json`);

/** Create the mailbox (0700) and refuse one that is a symlink or not ours. Throws. */
export function ensureAskDir(dir: string, options: MailboxOptions = {}): void {
	const uid = options.uid ?? currentUid();
	// check every component below the agent dir (<agent>/pi-keeper/asks/<hash>/<sub>)
	countWork("ensureAskDir");
	const agentDir = dirname(dirname(dirname(dir)));
	for (const sub of ["requests", "replies", "cancels"]) ensureSecureDir(join(dir, sub), uid, agentDir);
}

function need(id: string): void {
	if (!isValidId(id)) throw new Error("invalid ask id");
}

function readValidated<T>(file: string, parse: (value: unknown) => T | undefined, options: MailboxOptions): T {
	const parsed = parse(readJsonFile(file, MAX_BYTES, options.uid));
	if (parsed === undefined) throw new Error("does not match the v1 schema");
	return parsed;
}

function remove(file: string): void {
	countWork("fs");
	rmSync(file, { force: true, recursive: true });
}

function isFile(file: string): boolean {
	try {
		countWork("fs");
		return lstatSync(file).isFile();
	} catch {
		return false;
	}
}

// --- child side ---------------------------------------------------------

/** Thrown by writeRequest for a request the parent would drop unread: over MAX_BYTES, or over the key budget. */
export class RequestTooLargeError extends Error {
	readonly code = "request-too-large";

	constructor() {
		super("request too large to send to the parent");
		this.name = "RequestTooLargeError";
	}
}

/** Child: file a request. Validated first; throws on an invalid one or an unusable dir. */
export function writeRequest(dir: string, request: AskRequest, options: MailboxOptions = {}): void {
	const text = JSON.stringify(request);
	// the parent's reader counts bytes, not UTF-16 units: a request of CJK text is three bytes a character
	if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new RequestTooLargeError();
	if (parseRequest(request) === undefined) {
		const budget = { keys: 0 };
		isPlainJson((request as { call?: { input?: unknown } }).call?.input, 0, budget);
		if (budget.keys > MAX_KEYS) throw new RequestTooLargeError();
		throw new Error("invalid ask request");
	}
	ensureAskDir(dir, options);
	remove(replyFile(dir, request.id)); // never accept a reply that predates this request
	writeFileAtomic(requestFile(dir, request.id), text);
}

/**
 * Child: the parent's reply, or undefined (none yet, or unusable: fail closed,
 * the child keeps waiting or times out). Accepted only when the parent claimed
 * the request (`.taken` exists) and the reply echoes this request's nonce.
 */
export function readReply(dir: string, id: string, nonce: string, options: MailboxOptions = {}): AskReply | undefined {
	try {
		need(id);
		ensureAskDir(dir, options);
		if (!isFile(takenFile(dir, id))) return undefined;
		const reply = readValidated(replyFile(dir, id), parseReply, options);
		return reply.id === id && reply.nonce === nonce ? reply : undefined;
	} catch {
		return undefined;
	}
}

/** Child: ask the parent to drop this request (the child's abort signal fired). */
export function writeCancel(dir: string, id: string, options: MailboxOptions = {}): void {
	need(id);
	ensureAskDir(dir, options);
	writeFileAtomic(cancelFile(dir, id), JSON.stringify({ v: VERSION, id } satisfies AskCancel));
}

/** Child: remove its request (claimed or not), reply and cancel. Never throws. */
export function cleanup(dir: string, id: string, options: MailboxOptions = {}): void {
	if (!isValidId(id)) return;
	try {
		ensureAskDir(dir, options);
		for (const file of [requestFile(dir, id), takenFile(dir, id), replyFile(dir, id), cancelFile(dir, id)]) remove(file);
	} catch {
		// the parent's sweep removes what is left
	}
}

// --- parent side --------------------------------------------------------

/**
 * Parent: claim and return the new requests. Each file is renamed to
 * `<id>.json.taken`; rename is atomic, so across any number of takers exactly
 * one gets each file (the others see ENOENT and skip it). `taken` also
 * remembers every id, with the parent's own receivedAt (`now`), so an id is
 * never returned twice. A file that is not valid is deleted and reported in
 * `warnings`; nothing here throws.
 */
export function takeRequests(dir: string, taken: Taken, now: number, options: MailboxOptions = {}): { requests: AskRequest[]; warnings: string[] } {
	const requests: AskRequest[] = [];
	const warnings: string[] = [];
	let names: string[];
	try {
		ready(dir, options);
		countWork("fs");
		names = readdirSync(join(dir, "requests"));
	} catch (error) {
		return { requests, warnings: [`ask mailbox unusable: ${(error as Error).message}`] };
	}
	const candidates = names.filter((name) => name.endsWith(".json")).sort().slice(0, MAX_PER_PASS);
	for (const name of candidates) {
		const id = name.slice(0, -".json".length);
		const from = join(dir, "requests", name);
		if (!isValidId(id)) {
			remove(from);
			warnings.push(`ask request ${JSON.stringify(name.slice(0, 80))}: bad file name`);
			continue;
		}
		if (taken.has(id)) {
			remove(from); // an id is claimed once; a rewrite under the same id is dropped
			continue;
		}
		const to = takenFile(dir, id);
		try {
			countWork("fs");
			renameSync(from, to);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				remove(from); // e.g. a directory sits at the .taken name
				warnings.push(`ask request ${id}: cannot claim (${(error as NodeJS.ErrnoException).code ?? "error"})`);
			}
			continue; // ENOENT: another taker won, or the child cleaned up
		}
		try {
			const request = readValidated(to, parseRequest, options);
			if (request.id !== id) throw new Error("id does not match the file name");
			taken.set(id, { receivedAt: now, nonce: request.nonce, answered: false });
			requests.push(request);
		} catch (error) {
			remove(to);
			warnings.push(`ask request ${id}: ${(error as Error).message}`);
		}
	}
	return { requests, warnings };
}

/**
 * Parent: answer a request it claimed (it is in `taken`) and has not answered.
 * Throws for an unknown or already answered id, an invalid reply, or an
 * unusable dir. Marks the entry answered.
 */
export function writeReply(dir: string, taken: Taken, id: string, reply: Pick<AskReply, "decision" | "reason">, options: MailboxOptions = {}): void {
	need(id);
	const entry = taken.get(id);
	if (entry === undefined) throw new Error("unknown ask id");
	if (entry.answered) throw new Error("ask already answered");
	const full: AskReply = { v: VERSION, id, nonce: entry.nonce, decision: reply.decision, ...(reply.reason !== undefined ? { reason: reply.reason } : {}) };
	if (parseReply(full) === undefined) throw new Error("invalid ask reply");
	ensureAskDir(dir, options);
	writeFileAtomic(replyFile(dir, id), JSON.stringify(full));
	entry.answered = true;
}

/**
 * Parent: ids the children want cancelled. Consumes what it returns (deletes
 * the files); invalid files are deleted too. A cancel whose request is still
 * unclaimed is left for a later poll, so it is not lost before the parent has
 * seen the request.
 */
export function readCancels(dir: string, options: MailboxOptions = {}): string[] {
	const ids: string[] = [];
	let names: string[];
	try {
		ready(dir, options);
		countWork("fs");
		names = readdirSync(join(dir, "cancels"));
	} catch {
		return ids;
	}
	for (const name of names.filter((n) => n.endsWith(".json")).sort().slice(0, MAX_PER_PASS)) {
		const id = name.slice(0, -".json".length);
		const file = join(dir, "cancels", name);
		if (!isValidId(id)) {
			remove(file);
			continue;
		}
		if (isFile(requestFile(dir, id))) continue;
		try {
			if (readValidated(file, parseCancel, options).id === id) ids.push(id);
		} catch {
			// not a cancel we can trust
		}
		remove(file);
	}
	return ids;
}

/**
 * Parent: remove the leftovers of requests that are finished. A claimed
 * request goes (with its reply and cancel) when its child pid is dead or the
 * parent has held it longer than `ttlMs` by its own clock (`taken`; an id it
 * has no time for, such as after a restart, starts its clock now). A reply or
 * cancel with no request at all is an orphan and goes. Returns the ids
 * removed. Never throws.
 */
export function sweep(dir: string, taken: Taken, now: number, ttlMs: number, alive: (pid: number) => boolean = isPidAlive, options: MailboxOptions = {}): string[] {
	const removed: string[] = [];
	try {
		ready(dir, options);
	} catch {
		return removed;
	}
	let budget = MAX_PER_PASS;
	const list = (sub: string): string[] => {
		try {
			countWork("fs");
			return readdirSync(join(dir, sub));
		} catch {
			return [];
		}
	};
	const idOf = (name: string, suffix: string): string | undefined => {
		if (!name.endsWith(suffix)) return undefined;
		const id = name.slice(0, -suffix.length);
		return isValidId(id) ? id : undefined;
	};
	const requests = list("requests");
	const claimed = new Set<string>();
	for (const name of requests) {
		const id = idOf(name, ".json.taken");
		if (id !== undefined) claimed.add(id);
	}
	const unclaimed = new Set(requests.map((name) => idOf(name, ".json")).filter((id) => id !== undefined));
	for (const id of [...claimed].sort()) {
		if (budget-- <= 0) return removed;
		let dead = true;
		let nonce = "";
		try {
			const request = readValidated(takenFile(dir, id), parseRequest, options);
			dead = !alive(request.childPid);
			nonce = request.nonce;
		} catch {
			// unreadable: nothing to wait for
		}
		let entry = taken.get(id);
		if (entry === undefined) {
			entry = { receivedAt: now, nonce, answered: true };
			taken.set(id, entry);
		}
		if (dead || now - entry.receivedAt > ttlMs) {
			cleanup(dir, id, options);
			taken.delete(id);
			removed.push(id);
		}
	}
	for (const sub of ["replies", "cancels"]) {
		for (const name of list(sub)) {
			if (name.endsWith(".tmp")) {
				if (budget-- <= 0) return removed;
				try {
					countWork("fs");
					if (now - lstatSync(join(dir, sub, name)).mtimeMs > TMP_TTL_MS) remove(join(dir, sub, name));
				} catch {
					// gone already
				}
				continue;
			}
			const id = idOf(name, ".json");
			if (id === undefined || claimed.has(id) || unclaimed.has(id)) continue;
			if (budget-- <= 0) return removed;
			remove(join(dir, sub, name));
			taken.delete(id);
			if (!removed.includes(id)) removed.push(id);
		}
	}
	for (const name of requests) {
		if (!name.endsWith(".tmp")) continue;
		if (budget-- <= 0) return removed;
		try {
			countWork("fs");
			if (now - lstatSync(join(dir, "requests", name)).mtimeMs > TMP_TTL_MS) remove(join(dir, "requests", name));
		} catch {
			// gone already
		}
	}
	return removed;
}
