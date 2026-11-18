/**
 * Tests for the child side of the ask mailbox (extensions/remote-relay.ts).
 * The parent is played with takeRequests / writeReply; waits use a short real
 * poll interval, except where fake timers pin the default one. Run: npm test
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { askDirFor, readCancels, takeRequests, writeReply, type AskRequest, type ReplyReason, type Taken } from "../../extensions/ask-mailbox.ts";
import { askParent, canAskParent, REPLY_POLL_MS, sanitizeLabel, type AskParentOptions, type RelayResult } from "../../extensions/remote-relay.ts";
import { HEARTBEAT_STALE_MS, writeHeartbeat } from "../../extensions/ask-heartbeat.ts";
import { PARENT_SESSION_ENV, publishGrants } from "../../extensions/session-grants.ts";

let base: string;
let dir: string;
const taken: Taken = new Map();

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-relay-")));
	dir = askDirFor(base, "parent-1");
	taken.clear();
});
afterEach(() => {
	mock.timers.reset();
	rmSync(base, { recursive: true, force: true });
});

const CALL = { toolName: "bash", input: { command: "npm test" } };

function options(over: Partial<AskParentOptions> = {}): AskParentOptions {
	return { dir, childMode: "default", cwd: "/work/project", label: "scout", timeoutMs: 5_000, pollMs: 5, parentAlive: () => true, ...over };
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The parent claims the request once it is filed. */
async function claim(): Promise<AskRequest> {
	for (let i = 0; i < 400; i++) {
		const { requests } = takeRequests(dir, taken, Date.now());
		if (requests.length > 0) return requests[0];
		await tick();
	}
	assert.fail("no request was filed");
}

/** Run askParent while the parent claims the request and answers it. */
async function answered(reply: { decision: "allow" | "deny" | "cancelled"; reason?: ReplyReason }, over: Partial<AskParentOptions> = {}): Promise<RelayResult> {
	const waiting = askParent(CALL, options(over));
	const request = await claim();
	writeReply(dir, taken, request.id, reply);
	return waiting;
}

const leftovers = (): string[] => (existsSync(dir) ? ["requests", "replies"].flatMap((sub) => readdirSync(join(dir, sub))) : []);

describe("the parent answers", () => {
	it("allow", async () => {
		assert.deepEqual(await answered({ decision: "allow" }), { decision: "allow" });
		assert.deepEqual(leftovers(), []);
	});

	for (const reason of ["rules", "user", "timeout", "parent-session-ended"] as const) {
		it(`deny with reason ${reason}`, async () => {
			assert.deepEqual(await answered({ decision: "deny", reason }), { decision: "deny", reason });
			assert.deepEqual(leftovers(), []);
		});
	}

	it("a deny without a reason counts as the parent's rules", async () => {
		assert.deepEqual(await answered({ decision: "deny" }), { decision: "deny", reason: "rules" });
	});

	it("a request the parent would drop unread is denied at once with a size reason, not left to time out", async () => {
		const started = Date.now();
		const result = await askParent({ toolName: "bash", input: { command: "漢".repeat(30_000) } }, options({ timeoutMs: 3_000 }));
		assert.equal(result.decision, "deny");
		assert.match(String(result.reason), /size/);
		assert.ok(Date.now() - started < 1_000, "no wait for a reply that cannot come");
		assert.deepEqual(leftovers(), []);
	});

	it("cancelled", async () => {
		assert.deepEqual(await answered({ decision: "cancelled" }), { decision: "cancelled" });
	});

	it("files the request with the call, mode, cwd, pid and a sanitized label", async () => {
		const waiting = askParent(CALL, options({ label: "  scout‮\nx  ", childMode: "auto" }));
		const request = await claim();
		assert.deepEqual(request.call, CALL);
		assert.equal(request.childMode, "auto");
		assert.equal(request.cwd, "/work/project");
		assert.equal(request.childPid, process.pid);
		assert.equal(request.childLabel, "scout x");
		writeReply(dir, taken, request.id, { decision: "allow" });
		await waiting;
	});

	it("each ask gets its own id and nonce", async () => {
		const first = askParent(CALL, options());
		const a = await claim();
		const second = askParent(CALL, options());
		const b = await claim();
		assert.notEqual(a.id, b.id);
		assert.notEqual(a.nonce, b.nonce);
		writeReply(dir, taken, a.id, { decision: "allow" });
		writeReply(dir, taken, b.id, { decision: "deny", reason: "user" });
		assert.deepEqual([await first, await second], [{ decision: "allow" }, { decision: "deny", reason: "user" }]);
	});
});

describe("the wait ends without an answer", () => {
	it("an abort files a cancel, returns cancelled and removes the rest", async () => {
		const controller = new AbortController();
		const waiting = askParent(CALL, options({ signal: controller.signal }));
		const request = await claim();
		controller.abort();
		assert.deepEqual(await waiting, { decision: "cancelled" });
		assert.deepEqual(leftovers(), []);
		assert.deepEqual(readCancels(dir), [request.id]);
	});

	it("an abort that already happened writes nothing", async () => {
		const controller = new AbortController();
		controller.abort();
		assert.deepEqual(await askParent(CALL, options({ signal: controller.signal })), { decision: "cancelled" });
		assert.deepEqual(leftovers(), []);
		assert.deepEqual(readCancels(dir), []);
	});

	it("a timeout denies with reason timeout and tells the parent to drop the dialog", async () => {
		const waiting = askParent(CALL, options({ timeoutMs: 40 }));
		const request = await claim();
		assert.deepEqual(await waiting, { decision: "deny", reason: "timeout" });
		assert.deepEqual(leftovers(), []);
		assert.deepEqual(readCancels(dir), [request.id]);
	});

	it("polls every 250 ms by default and times out on the clock (fake timers)", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
		let polls = 0;
		const waiting = askParent(CALL, options({ pollMs: undefined, timeoutMs: 1_000, parentAlive: () => (polls++, true) }));
		let result: RelayResult | undefined;
		void waiting.then((r) => (result = r));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(polls, 1);
		for (let elapsed = 0; elapsed < 1_000; elapsed += REPLY_POLL_MS) {
			assert.equal(result, undefined);
			mock.timers.tick(REPLY_POLL_MS);
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.deepEqual(result, { decision: "deny", reason: "timeout" });
		assert.equal(polls, 5);
		assert.equal(REPLY_POLL_MS, 250);
	});

	it("a parent that is gone ends the wait at once", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
		// no tick is ever advanced: the answer must come from the first poll
		assert.deepEqual(await askParent(CALL, options({ pollMs: undefined, parentAlive: () => false })), { decision: "deny", reason: "parent-gone" });
		assert.deepEqual(leftovers(), []);
	});

	it("a parent that goes away mid-wait is noticed on the next poll", async () => {
		let alive = true;
		const waiting = askParent(CALL, options({ parentAlive: () => alive }));
		await claim();
		alive = false;
		assert.deepEqual(await waiting, { decision: "deny", reason: "parent-gone" });
		assert.deepEqual(leftovers(), []);
	});

	it("a parent that is gone mid-wait gets a cancel note, so a slow but live parent closes the dialog", async () => {
		let alive = true;
		const waiting = askParent(CALL, options({ parentAlive: () => alive }));
		const request = await claim();
		alive = false;
		await waiting;
		assert.deepEqual(readCancels(dir), [request.id]);
	});

	it("a reply that raced with the parent's exit still counts", async () => {
		let gone = false;
		const waiting = askParent(CALL, options({ pollMs: 20, parentAlive: () => !gone }));
		const request = await claim();
		writeReply(dir, taken, request.id, { decision: "deny", reason: "parent-session-ended" });
		gone = true;
		assert.deepEqual(await waiting, { decision: "deny", reason: "parent-session-ended" });
	});
});

describe("it never throws: a problem is a deny", () => {
	it("a mailbox that cannot be created", async () => {
		const blocker = join(base, "blocker");
		writeFileSync(blocker, "x");
		assert.deepEqual(await askParent(CALL, options({ dir: join(blocker, "asks") })), { decision: "deny", reason: "error" });
	});

	it("a request the mailbox rejects (a relative cwd)", async () => {
		assert.deepEqual(await askParent(CALL, options({ cwd: "relative" })), { decision: "deny", reason: "error" });
		assert.deepEqual(leftovers(), []);
	});

	it("a call too big for the parent to read is denied without waiting", async () => {
		const big = { toolName: "write", input: { content: "x".repeat(70_000) } };
		assert.deepEqual(await askParent(big, options()), { decision: "deny", reason: "request-size" });
		assert.deepEqual(leftovers(), []);
	});

	it("a liveness check that throws", async () => {
		const throwing = (): boolean => {
			throw new Error("boom");
		};
		assert.deepEqual(await askParent(CALL, options({ parentAlive: throwing })), { decision: "deny", reason: "error" });
		assert.deepEqual(leftovers(), []);
	});
});

describe("sanitizeLabel", () => {
	it("strips control and bidi characters, collapses blanks, and caps the length", () => {
		assert.equal(sanitizeLabel("a\u0007b‏c⁦d", "x"), "a b c d");
		assert.equal(sanitizeLabel("  \n\t ", "subagent 7"), "subagent 7");
		assert.equal(sanitizeLabel("é".repeat(200), "x").length, 80);
		const emoji = sanitizeLabel("😀".repeat(100), "x");
		assert.ok(emoji.length <= 80 && !/[\ud800-\udbff]$/.test(emoji));
	});
});

describe("canAskParent", () => {
	const env = (): NodeJS.ProcessEnv => ({ [PARENT_SESSION_ENV]: "parent-1" });
	const rules = { prefixes: [], exact: [], edits: false, outsideReads: false };

	it("needs the setting, no kill switch, a live snapshot of the named parent and a fresh heartbeat from it", () => {
		assert.equal(canAskParent({ backgroundAsks: true }, base, env()), false, "no snapshot yet");
		publishGrants(base, "parent-1", rules);
		assert.equal(canAskParent({ backgroundAsks: true }, base, env()), false, "a snapshot but no ask server");
		writeHeartbeat(dir, process.pid, Date.now());
		assert.equal(canAskParent({ backgroundAsks: true }, base, env()), true);
		assert.equal(canAskParent({ backgroundAsks: false }, base, env()), false);
		assert.equal(canAskParent({ backgroundAsks: true }, base, { ...env(), PI_KEEPER_BACKGROUND_ASKS: "0" }), false);
		assert.equal(canAskParent({ backgroundAsks: true }, base, { ...env(), PI_KEEPER_BACKGROUND_ASKS: "1" }), true);
		assert.equal(canAskParent({ backgroundAsks: true }, base, {}), false, "no parent session in the env");
	});

	it("a stale heartbeat, or one from another pid, is not listening", () => {
		publishGrants(base, "parent-1", rules);
		writeHeartbeat(dir, process.pid, 1_000);
		assert.equal(canAskParent({ backgroundAsks: true }, base, env(), 1_000), true);
		assert.equal(canAskParent({ backgroundAsks: true }, base, env(), 1_000 + HEARTBEAT_STALE_MS), false, "stale");
		writeHeartbeat(dir, process.pid + 1, 1_000);
		assert.equal(canAskParent({ backgroundAsks: true }, base, env(), 1_000), false, "not the snapshot's pid");
	});

	it("a nested child names a child session, which publishes no snapshot", () => {
		publishGrants(base, "parent-1", rules);
		assert.equal(canAskParent({ backgroundAsks: true }, base, { [PARENT_SESSION_ENV]: "child-of-parent-1" }), false);
	});
});
