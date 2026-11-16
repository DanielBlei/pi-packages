import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withDialogLock } from "../../extensions/dialog-lock.ts";

/** A dialog stand-in that stays open until `close()`; records what ran when. */
function dialog(log: string[], name: string): { run: () => Promise<string>; close: () => void } {
	let close!: () => void;
	const closed = new Promise<void>((resolve) => {
		close = resolve;
	});
	return {
		run: async () => {
			log.push(`open ${name}`);
			await closed;
			log.push(`close ${name}`);
			return name;
		},
		close,
	};
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("withDialogLock", () => {
	it("runs a free lock's function in the same tick", () => {
		let ran = false;
		void withDialogLock(async () => {
			ran = true;
		});
		assert.equal(ran, true);
	});

	it("runs waiters one at a time, in the order they asked", async () => {
		const log: string[] = [];
		const a = dialog(log, "a");
		const b = dialog(log, "b");
		const c = dialog(log, "c");
		const results = [withDialogLock(a.run), withDialogLock(b.run), withDialogLock(c.run)];
		await tick();
		assert.deepEqual(log, ["open a"]);
		a.close();
		await tick();
		assert.deepEqual(log, ["open a", "close a", "open b"]);
		b.close();
		c.close();
		assert.deepEqual(await Promise.all(results), ["a", "b", "c"]);
		assert.deepEqual(log, ["open a", "close a", "open b", "close b", "open c", "close c"]);
	});

	it("a rejection reaches its own caller only, and later waiters still run", async () => {
		const failing = withDialogLock(async () => {
			throw new Error("boom");
		});
		const after = withDialogLock(async () => "ok");
		await assert.rejects(failing, /boom/);
		assert.equal(await after, "ok");
		assert.equal(await withDialogLock(async () => "again"), "again");
	});

	it("a synchronous throw does not poison the chain either", async () => {
		await assert.rejects(
			withDialogLock((() => {
				throw new Error("sync");
			}) as () => Promise<string>),
			/sync/,
		);
		assert.equal(await withDialogLock(async () => "ok"), "ok");
	});

	it("a waiter aborted before its turn gives up without running, and the line moves on", async () => {
		const log: string[] = [];
		const first = dialog(log, "first");
		const controller = new AbortController();
		const holder = withDialogLock(first.run);
		const skipped = withDialogLock(async () => {
			log.push("open skipped");
			return "skipped";
		}, controller.signal);
		const last = withDialogLock(async () => {
			log.push("open last");
			return "last";
		});
		controller.abort();
		assert.equal(await skipped, undefined);
		// the abort alone does not let the last one jump the holder
		await tick();
		assert.deepEqual(log, ["open first"]);
		first.close();
		assert.equal(await holder, "first");
		assert.equal(await last, "last");
		assert.deepEqual(log, ["open first", "close first", "open last"]);
	});

	it("an already-aborted signal never runs and never takes a place in line", async () => {
		const controller = new AbortController();
		controller.abort();
		let ran = false;
		const result = await withDialogLock(async () => {
			ran = true;
			return "x";
		}, controller.signal);
		assert.equal(result, undefined);
		assert.equal(ran, false);
		assert.equal(await withDialogLock(async () => "next"), "next");
	});

	it("an abort after the turn came does not interrupt the running function", async () => {
		const controller = new AbortController();
		const result = withDialogLock(async () => {
			await tick();
			return "done";
		}, controller.signal);
		controller.abort();
		assert.equal(await result, "done");
	});
});
