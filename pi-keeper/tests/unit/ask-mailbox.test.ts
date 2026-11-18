import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	askDirFor,
	cleanup,
	ensureAskDir,
	MAX_BYTES,
	MAX_PER_PASS,
	newAskId,
	newNonce,
	pendingIds,
	readCancels,
	RequestTooLargeError,
	readReply,
	sweep,
	takeRequests,
	writeCancel,
	writeReply,
	writeRequest,
	type AskRequest,
	type Taken,
} from "../../extensions/ask-mailbox.ts";
import { ensureSecureDir } from "../../extensions/secure-file.ts";

let base: string;
let dir: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-asks-")));
	dir = askDirFor(base, "session-1");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function request(over: Partial<AskRequest> = {}): AskRequest {
	return {
		v: 1,
		id: newAskId(),
		nonce: newNonce(),
		childPid: process.pid,
		childLabel: "worker",
		childMode: "default",
		cwd: "/work/project",
		call: { toolName: "bash", input: { command: "ls" } },
		...over,
	};
}

/** Put a raw (possibly invalid) request file where a child would. */
function plant(value: unknown, id: string = randomUUID()): string {
	ensureAskDir(dir);
	const file = join(dir, "requests", `${id}.json`);
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
	return file;
}

function rejected(value: unknown): string[] {
	plant(value);
	const { requests, warnings } = takeRequests(dir, new Map(), 0);
	assert.equal(requests.length, 0);
	return warnings;
}

describe("ask mailbox", () => {
	it("derives the dir from the sha256 of the session id", () => {
		assert.match(dir, /pi-keeper\/asks\/[0-9a-f]{64}$/);
		assert.notEqual(dir, askDirFor(base, "session-2"));
	});

	it("round-trips request, take, reply, read", () => {
		const req = request();
		writeRequest(dir, req);
		const taken: Taken = new Map();
		const { requests, warnings } = takeRequests(dir, taken, 1000);
		assert.deepEqual(warnings, []);
		assert.deepEqual(requests, [req]);
		assert.equal(taken.get(req.id)?.receivedAt, 1000);
		assert.deepEqual(pendingIds(taken), [req.id]);
		assert.equal(readReply(dir, req.id, req.nonce), undefined);
		writeReply(dir, taken, req.id, { decision: "allow", reason: "user" });
		assert.deepEqual(pendingIds(taken), []);
		assert.deepEqual(readReply(dir, req.id, req.nonce), { v: 1, id: req.id, nonce: req.nonce, decision: "allow", reason: "user" });
		cleanup(dir, req.id);
		assert.equal(readReply(dir, req.id, req.nonce), undefined);
		assert.deepEqual(readdirSync(join(dir, "requests")), []);
	});

	it("hands each request out exactly once, also across two takers", () => {
		const req = request();
		writeRequest(dir, req);
		const a = takeRequests(dir, new Map(), 0);
		const b = takeRequests(dir, new Map(), 0);
		assert.equal(a.requests.length + b.requests.length, 1);
		assert.deepEqual(b.warnings, []);
		assert.ok(existsSync(join(dir, "requests", `${req.id}.json.taken`)));
		// the same id filed again is not returned twice by one taker
		const taken: Taken = new Map([[req.id, { receivedAt: 5, nonce: req.nonce, answered: false }]]);
		writeRequest(dir, req);
		assert.equal(takeRequests(dir, taken, 9).requests.length, 0);
		assert.equal(taken.get(req.id)?.receivedAt, 5);
		assert.deepEqual(readdirSync(join(dir, "requests")), [`${req.id}.json.taken`]);
	});

	it("refuses to file a request over MAX_BYTES in UTF-8 bytes: 30,000 CJK characters are 90,000 bytes", () => {
		// JSON.stringify(...).length counts 30,000 units here, under the limit; the parent's reader counts bytes
		ensureAskDir(dir);
		const big = request({ call: { toolName: "bash", input: { command: "漢".repeat(30_000) } } });
		assert.throws(() => writeRequest(dir, big), (error: unknown) => error instanceof RequestTooLargeError && error.code === "request-too-large" && /too large/.test(error.message));
		assert.deepEqual(readdirSync(join(dir, "requests")), []);
	});

	it("rejects an oversize file", () => {
		const warnings = rejected(" ".repeat(MAX_BYTES + 1));
		assert.match(warnings[0] as string, /larger than/);
		assert.deepEqual(readdirSync(join(dir, "requests")), []);
	});

	it("rejects a symlinked request file", () => {
		ensureAskDir(dir);
		const target = join(base, "real.json");
		writeFileSync(target, JSON.stringify(request()));
		const id = randomUUID();
		symlinkSync(target, join(dir, "requests", `${id}.json`));
		const { requests, warnings } = takeRequests(dir, new Map(), 0);
		assert.equal(requests.length, 0);
		assert.match(warnings[0] as string, /ELOOP|not a regular file/);
		assert.ok(existsSync(target));
	});

	it("ignores a symlinked reply", () => {
		ensureAskDir(dir);
		const id = randomUUID();
		const nonce = newNonce();
		const target = join(base, "reply.json");
		writeFileSync(target, JSON.stringify({ v: 1, id, nonce, decision: "allow" }));
		writeFileSync(join(dir, "requests", `${id}.json.taken`), "{}");
		symlinkSync(target, join(dir, "replies", `${id}.json`));
		assert.equal(readReply(dir, id, nonce), undefined);
	});

	it("refuses a symlinked mailbox dir and a symlinked subdir", () => {
		const elsewhere = join(base, "elsewhere");
		mkdirSync(elsewhere);
		mkdirSync(join(dir, ".."), { recursive: true });
		symlinkSync(elsewhere, dir);
		assert.throws(() => writeRequest(dir, request()), /not a plain directory/);
		assert.deepEqual(takeRequests(dir, new Map(), 0).requests, []);
		assert.match(takeRequests(dir, new Map(), 0).warnings[0] as string, /unusable/);
		rmSync(dir);
		mkdirSync(dir, { mode: 0o700 });
		symlinkSync(elsewhere, join(dir, "requests"));
		assert.throws(() => ensureAskDir(dir), /not a plain directory/);
	});

	it("rejects malformed JSON and schema violations", () => {
		assert.match(rejected("{not json")[0] as string, /JSON/);
		const bad: [string, unknown][] = [
			["array", []],
			["bad id", { ...request(), id: "../etc/passwd" }],
			["wrong version", { ...request(), v: 2 }],
			["control chars in label", { ...request(), childLabel: "a\u001b[31mb" }],
			["long label", { ...request(), childLabel: "x".repeat(81) }],
			["relative cwd", { ...request(), cwd: "work/project" }],
			["control chars in cwd", { ...request(), cwd: "/work\n/x" }],
			["bad toolName", { ...request(), call: { toolName: "bash; rm", input: {} } }],
			["array input", { ...request(), call: { toolName: "bash", input: [] } }],
			["string input", { ...request(), call: { toolName: "bash", input: "ls" } }],
			["bad mode", { ...request(), childMode: "yolo" }],
			["bad pid", { ...request(), childPid: -1 }],
			["extra field", { ...request(), grants: ["rm"] }],
			["extra call field", { ...request(), call: { toolName: "bash", input: {}, extra: 1 } }],
			["missing field", (() => { const { cwd: _cwd, ...rest } = request(); return rest; })()],
		];
		for (const [name, value] of bad) {
			assert.equal(rejected(value).length, 1, name);
		}
		assert.deepEqual(readdirSync(join(dir, "requests")), []);
	});

	it("rejects a request whose id differs from its file name", () => {
		plant(request(), randomUUID());
		assert.match(takeRequests(dir, new Map(), 0).warnings[0] as string, /id does not match/);
	});

	it("accepts the no-ui reason (the parent has no interactive user)", () => {
		const req = request();
		writeRequest(dir, req);
		const taken: Taken = new Map();
		takeRequests(dir, taken, 1);
		writeReply(dir, taken, req.id, { decision: "deny", reason: "no-ui" });
		assert.deepEqual(readReply(dir, req.id, req.nonce), { v: 1, id: req.id, nonce: req.nonce, decision: "deny", reason: "no-ui" });
	});

	it("refuses to write an invalid request or reply, and a reply with an unknown reason", () => {
		assert.throws(() => writeRequest(dir, request({ cwd: "rel" })), /invalid/);
		const req = request();
		const taken: Taken = new Map([[req.id, { receivedAt: 0, nonce: req.nonce, answered: false }]]);
		assert.throws(() => writeReply(dir, taken, req.id, { decision: "allow", reason: "because" as never }), /invalid/);
		assert.throws(() => writeReply(dir, taken, req.id, { decision: "maybe" as never }), /invalid/);
		assert.throws(() => writeCancel(dir, "nope"), /invalid/);
	});

	it("reads a reply strictly", () => {
		ensureAskDir(dir);
		const id = randomUUID();
		const nonce = newNonce();
		writeFileSync(join(dir, "requests", `${id}.json.taken`), "{}");
		for (const value of [{ v: 1, id, nonce, decision: "allow", extra: 1 }, { v: 1, id, nonce, decision: "yes" }, { v: 1, id: randomUUID(), nonce, decision: "deny" }, { v: 1, id, decision: "deny" }]) {
			writeFileSync(join(dir, "replies", `${id}.json`), JSON.stringify(value));
			assert.equal(readReply(dir, id, nonce), undefined);
		}
		assert.equal(readReply(dir, "../x", nonce), undefined);
	});

	it("round-trips a cancel and ignores invalid ones", () => {
		const id = randomUUID();
		writeCancel(dir, id);
		writeFileSync(join(dir, "cancels", `${randomUUID()}.json`), "{}");
		writeFileSync(join(dir, "cancels", "junk.json"), JSON.stringify({ v: 1, id }));
		assert.deepEqual(readCancels(dir), [id]);
		assert.deepEqual(readdirSync(join(dir, "cancels")), []); // consumed
		assert.deepEqual(readCancels(dir), []);
	});

	it("uses modes 0700 for dirs and 0600 for files", () => {
		const req = request();
		writeRequest(dir, req);
		writeCancel(dir, req.id);
		const taken: Taken = new Map();
		takeRequests(dir, taken, 0);
		writeReply(dir, taken, req.id, { decision: "deny" });
		writeFileSync(join(dir, "requests", `${req.id}.json`), "x"); // keep a request file to check mode below
		for (const d of [dir, join(dir, "requests"), join(dir, "replies"), join(dir, "cancels")]) {
			assert.equal(statSync(d).mode & 0o777, 0o700, d);
		}
		for (const f of [join(dir, "requests", `${req.id}.json.taken`), join(dir, "cancels", `${req.id}.json`), join(dir, "replies", `${req.id}.json`)]) {
			assert.equal(statSync(f).mode & 0o777, 0o600, f);
		}
		assert.equal(readdirSync(join(dir, "requests")).some((n) => n.endsWith(".tmp")), false);
	});

	it("rejects a dir or file owned by another uid", () => {
		const other = (process.getuid?.() ?? 0) + 1;
		assert.throws(() => ensureAskDir(dir, { uid: other }), /not owned/);
		const req = request();
		writeRequest(dir, req);
		const { requests, warnings } = takeRequests(dir, new Map(), 0, { uid: other });
		assert.equal(requests.length, 0);
		assert.match(warnings[0] as string, /unusable|not owned/);
		const taken: Taken = new Map();
		takeRequests(dir, taken, 0);
		writeReply(dir, taken, req.id, { decision: "allow" });
		assert.equal(readReply(dir, req.id, req.nonce, { uid: other }), undefined);
		assert.ok(readReply(dir, req.id, req.nonce));
	});

	describe("sweep", () => {
		function claimed(req: AskRequest, taken: Taken, at: number): void {
			writeRequest(dir, req);
			takeRequests(dir, taken, at);
			writeReply(dir, taken, req.id, { decision: "deny" });
			writeCancel(dir, req.id);
		}

		it("removes a claimed request whose child pid is dead", () => {
			const taken: Taken = new Map();
			const dead = request({ childPid: 4242 });
			const live = request({ childPid: 4343 });
			claimed(dead, taken, 0);
			claimed(live, taken, 0);
			const removed = sweep(dir, taken, 10, 60_000, (pid) => pid !== 4242);
			assert.deepEqual(removed, [dead.id]);
			assert.equal(existsSync(join(dir, "requests", `${dead.id}.json.taken`)), false);
			assert.equal(existsSync(join(dir, "replies", `${dead.id}.json`)), false);
			assert.equal(existsSync(join(dir, "cancels", `${dead.id}.json`)), false);
			assert.ok(readReply(dir, live.id, live.nonce));
			assert.equal(taken.has(dead.id), false);
		});

		it("removes by the parent's receivedAt once the TTL passed, whatever the child says", () => {
			const taken: Taken = new Map();
			const req = request();
			claimed(req, taken, 1000);
			assert.deepEqual(sweep(dir, taken, 1000 + 60_000, 60_000, () => true), []);
			assert.deepEqual(sweep(dir, taken, 1000 + 60_001, 60_000, () => true), [req.id]);
			assert.equal(existsSync(join(dir, "requests", `${req.id}.json.taken`)), false);
		});

		it("starts the clock for a claimed id it has no time for", () => {
			const req = request();
			claimed(req, new Map(), 0);
			const taken: Taken = new Map();
			assert.deepEqual(sweep(dir, taken, 500, 100, () => true), []);
			assert.equal(taken.get(req.id)?.receivedAt, 500);
			assert.deepEqual(sweep(dir, taken, 601, 100, () => true), [req.id]);
		});

		it("removes orphan replies and cancels but keeps those of an unclaimed request", () => {
			const orphan = randomUUID();
			ensureAskDir(dir);
			writeFileSync(join(dir, "replies", `${orphan}.json`), "{}");
			writeCancel(dir, orphan);
			const waiting = request();
			writeRequest(dir, waiting);
			writeCancel(dir, waiting.id);
			assert.deepEqual(sweep(dir, new Map(), 0, 1000, () => true), [orphan]);
			assert.ok(existsSync(join(dir, "cancels", `${waiting.id}.json`)));
			assert.deepEqual(readCancels(dir), []); // not consumed before the request is claimed
			assert.ok(existsSync(join(dir, "cancels", `${waiting.id}.json`)));
		});
	});
});

describe("ask mailbox hardening", () => {
	const mode = (m: number) => m & 0o777;

	it("does not follow a planted tmp symlink when writing", () => {
		ensureAskDir(dir);
		const victim = join(base, "victim");
		writeFileSync(victim, "keep");
		// the tmp name is random, so a planted name cannot match; O_EXCL|O_NOFOLLOW backs that up
		for (const sub of ["requests", "replies", "cancels"]) symlinkSync(victim, join(dir, sub, "x.json.tmp"));
		writeRequest(dir, request());
		assert.equal(readFileSyncText(victim), "keep");
	});

	it("does not hang on a FIFO in place of a request", () => {
		ensureAskDir(dir);
		const id = randomUUID();
		execFileSync("mkfifo", [join(dir, "requests", `${id}.json`)]);
		const { requests, warnings } = takeRequests(dir, new Map(), 0);
		assert.equal(requests.length, 0);
		assert.equal(warnings.length, 1);
		assert.deepEqual(readdirSync(join(dir, "requests")), []);
	});

	it("rejects a forged pre-created reply and drops a stale one on writeRequest", () => {
		const req = request();
		ensureAskDir(dir);
		writeFileSync(join(dir, "replies", `${req.id}.json`), JSON.stringify({ v: 1, id: req.id, nonce: req.nonce, decision: "allow" }));
		writeRequest(dir, req);
		assert.equal(existsSync(join(dir, "replies", `${req.id}.json`)), false);
		// forged after filing but before the parent claimed it: no .taken yet
		writeFileSync(join(dir, "replies", `${req.id}.json`), JSON.stringify({ v: 1, id: req.id, nonce: req.nonce, decision: "allow" }));
		assert.equal(readReply(dir, req.id, req.nonce), undefined);
	});

	it("refuses writeReply for an untaken id, and a second answer", () => {
		const req = request();
		writeRequest(dir, req);
		assert.throws(() => writeReply(dir, new Map(), req.id, { decision: "allow" }), /unknown/);
		const taken: Taken = new Map();
		takeRequests(dir, taken, 0);
		writeReply(dir, taken, req.id, { decision: "deny" });
		assert.throws(() => writeReply(dir, taken, req.id, { decision: "allow" }), /already/);
	});

	it("rejects a reply with the wrong nonce", () => {
		const req = request();
		writeRequest(dir, req);
		const taken: Taken = new Map();
		takeRequests(dir, taken, 0);
		writeReply(dir, taken, req.id, { decision: "allow" });
		assert.equal(readReply(dir, req.id, newNonce()), undefined);
		assert.ok(readReply(dir, req.id, req.nonce));
	});

	it("rejects __proto__ keys, deep nesting and key floods in input", () => {
		const proto = `{"v":1,"id":"${newAskId()}","nonce":"${newNonce()}","childPid":1,"childLabel":"a","childMode":"auto","cwd":"/x","call":{"toolName":"t","input":{"a":{"__proto__":{"x":1}}}}}`;
		assert.equal(rejected(proto).length, 1);
		let deep: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) deep = { n: deep };
		assert.equal(rejected({ ...request(), call: { toolName: "t", input: deep } }).length, 1);
		const wide = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`k${i}`, 1]));
		assert.equal(rejected({ ...request(), call: { toolName: "t", input: wide } }).length, 1);
		const ok = request({ call: { toolName: "t", input: { a: [1, { b: null }] } } });
		plant(ok, ok.id);
		assert.equal(takeRequests(dir, new Map(), 0).requests.length, 1);
	});

	it("rejects line separators and bidi controls in label and cwd, and an id with a trailing newline", () => {
		for (const bad of ["a\u2028b", "a\u202eb", "a\u200bb", "a\u2066b"]) {
			assert.equal(rejected({ ...request(), childLabel: bad }).length, 1, JSON.stringify(bad));
			assert.equal(rejected({ ...request(), cwd: `/x${bad}` }).length, 1, JSON.stringify(bad));
		}
		const req = request();
		assert.equal(rejected({ ...req, id: `${req.id}\n` }).length, 1);
	});

	it("drops a duplicate id rewritten after take and keeps the original", () => {
		const req = request();
		writeRequest(dir, req);
		const taken: Taken = new Map();
		assert.equal(takeRequests(dir, taken, 1).requests.length, 1);
		writeRequest(dir, { ...req, nonce: newNonce() });
		assert.equal(takeRequests(dir, taken, 2).requests.length, 0);
		assert.equal(taken.get(req.id)?.nonce, req.nonce);
		assert.deepEqual(readdirSync(join(dir, "requests")), [`${req.id}.json.taken`]);
		writeReply(dir, taken, req.id, { decision: "allow" });
		assert.ok(readReply(dir, req.id, req.nonce));
	});

	it("caps takeRequests and sweep at 64 files per pass", () => {
		for (let i = 0; i < 100; i++) writeRequest(dir, request());
		const taken: Taken = new Map();
		assert.equal(takeRequests(dir, taken, 0).requests.length, MAX_PER_PASS);
		assert.equal(takeRequests(dir, taken, 0).requests.length, 36);
		assert.equal(sweep(dir, taken, 0, 60_000, () => false).length, MAX_PER_PASS);
		assert.equal(sweep(dir, taken, 0, 60_000, () => false).length, 36);
	});

	it("handles a directory at the .taken name without looping", () => {
		const req = request();
		ensureAskDir(dir);
		mkdirSync(join(dir, "requests", `${req.id}.json.taken`));
		writeRequest(dir, req);
		const { requests, warnings } = takeRequests(dir, new Map(), 0);
		assert.equal(requests.length, 0);
		assert.equal(warnings.length, 1);
		assert.equal(existsSync(join(dir, "requests", `${req.id}.json`)), false);
		assert.deepEqual(sweep(dir, new Map(), 0, 1000, () => true), [req.id]);
		assert.deepEqual(readdirSync(join(dir, "requests")), []);
	});

	it("sweeps leaked tmp files only when old", () => {
		ensureAskDir(dir);
		const old = join(dir, "replies", "a.json.deadbeef.tmp");
		const fresh = join(dir, "requests", "b.json.cafe.tmp");
		writeFileSync(old, "x");
		writeFileSync(fresh, "x");
		const t = new Date(Date.now() - 120_000);
		utimesSync(old, t, t);
		sweep(dir, new Map(), Date.now(), 1000, () => true);
		assert.equal(existsSync(old), false);
		assert.equal(existsSync(fresh), true);
	});

	it("tightens a loose directory to 0700 and refuses a symlinked ancestor", () => {
		ensureAskDir(dir);
		const asks = join(dir, "..");
		chmodSync(asks, 0o755);
		ensureAskDir(dir);
		assert.equal(mode(statSync(asks).mode), 0o700);
		const other = join(base, "other");
		mkdirSync(other);
		const agent = join(base, "agent2");
		mkdirSync(join(agent, "x"), { recursive: true });
		symlinkSync(other, join(agent, "pi-keeper"));
		assert.throws(() => ensureAskDir(askDirFor(agent, "s")), /not a plain directory/);
	});

	it("does not touch files outside the mailbox through a symlinked cancels/ or replies/", () => {
		ensureAskDir(dir);
		const outside = join(base, "outside");
		mkdirSync(outside);
		const id = randomUUID();
		writeFileSync(join(outside, "junk.json"), "x");
		writeFileSync(join(outside, `${id}.json`), "x");
		rmSync(join(dir, "cancels"), { recursive: true });
		symlinkSync(outside, join(dir, "cancels"));
		assert.deepEqual(readCancels(dir), []);
		rmSync(join(dir, "replies"), { recursive: true });
		symlinkSync(outside, join(dir, "replies"));
		assert.deepEqual(sweep(dir, new Map(), 0, 1000, () => true), []);
		assert.equal(readReply(dir, id, newNonce()), undefined);
		assert.throws(() => writeCancel(dir, id), /not a plain directory/);
		cleanup(dir, id);
		assert.deepEqual(readdirSync(outside).sort(), ["junk.json", `${id}.json`].sort());
	});

	it("creates nothing behind a symlinked intermediate dir", () => {
		const target = join(base, "target");
		mkdirSync(target);
		const agent = join(base, "agent3");
		mkdirSync(agent);
		symlinkSync(target, join(agent, "pi-keeper"));
		assert.throws(() => ensureSecureDir(join(agent, "pi-keeper", "asks", "h"), process.getuid?.(), agent), /not a plain directory/);
		assert.deepEqual(readdirSync(target), []);
	});

	it("tightens loose dirs to 0700 with ensureSecureDir", () => {
		const root = join(base, "root");
		mkdirSync(join(root, "a"), { recursive: true });
		chmodSync(join(root, "a"), 0o775);
		ensureSecureDir(join(root, "a"), process.getuid?.(), root);
		assert.equal(statSync(join(root, "a")).mode & 0o777, 0o700);
		ensureSecureDir(join(root, "a", "b"), process.getuid?.(), root);
		assert.equal(statSync(join(root, "a", "b")).mode & 0o777, 0o700);
	});

	it("uses unique ids and nonces", () => {
		assert.match(newNonce(), /^[0-9a-f]{32}$/);
		assert.notEqual(newNonce(), newNonce());
		assert.notEqual(newAskId(), newAskId());
	});
});

function readFileSyncText(file: string): string {
	return readFileSync(file, "utf8");
}
