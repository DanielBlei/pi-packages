/**
 * Tests for the parent's listening note (extensions/ask-heartbeat.ts).
 * Time is passed in, never waited for. Run: npm test
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HEARTBEAT_STALE_MS, heartbeatFresh, removeHeartbeat, writeHeartbeat } from "../../extensions/ask-heartbeat.ts";
import { askDirFor } from "../../extensions/ask-mailbox.ts";

let base: string;
let dir: string;
beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-heartbeat-")));
	dir = askDirFor(base, "parent-1");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("the heartbeat", () => {
	it("is fresh for the pid that wrote it, until it is HEARTBEAT_STALE_MS old", () => {
		writeHeartbeat(dir, 4242, 1000);
		assert.equal(heartbeatFresh(dir, 4242, 1000), true);
		assert.equal(heartbeatFresh(dir, 4242, 1000 + HEARTBEAT_STALE_MS - 1), true);
		assert.equal(heartbeatFresh(dir, 4242, 1000 + HEARTBEAT_STALE_MS), false);
	});

	it("is not fresh when its time is ahead of ours (3 s of skew is tolerated)", () => {
		writeHeartbeat(dir, 4242, 10_000);
		assert.equal(heartbeatFresh(dir, 4242, 8_000), true, "2 s ahead");
		assert.equal(heartbeatFresh(dir, 4242, 5_000), false, "5 s ahead");
		writeHeartbeat(dir, 4242, 10_000_000_000);
		assert.equal(heartbeatFresh(dir, 4242, 10_000), false, "far in the future");
	});

	it("is not fresh for another pid, a missing file, a malformed one or a symlink", () => {
		assert.equal(heartbeatFresh(dir, 4242, 1000), false, "missing");
		writeHeartbeat(dir, 4242, 1000);
		assert.equal(heartbeatFresh(dir, 4243, 1000), false, "another pid");
		for (const text of ["{not json", "null", '{"v":2,"pid":4242,"at":1000}', '{"v":1,"pid":"4242","at":1000}', '{"v":1,"pid":4242}']) {
			writeFileSync(join(dir, "alive"), text);
			assert.equal(heartbeatFresh(dir, 4242, 1000), false, text);
		}
		rmSync(join(dir, "alive"));
		writeFileSync(join(base, "elsewhere"), '{"v":1,"pid":4242,"at":1000}');
		symlinkSync(join(base, "elsewhere"), join(dir, "alive"));
		assert.equal(heartbeatFresh(dir, 4242, 1000), false, "symlink");
	});

	it("removeHeartbeat withdraws it and tolerates its absence", () => {
		writeHeartbeat(dir, 4242, 1000);
		removeHeartbeat(dir);
		assert.equal(existsSync(join(dir, "alive")), false);
		removeHeartbeat(dir);
		assert.equal(heartbeatFresh(dir, 4242, 1000), false);
	});
});
