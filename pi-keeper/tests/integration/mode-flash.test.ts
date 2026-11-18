/**
 * The mode line above the prompt after a switch (`modeFlashSecs`, default 2): the mode's
 * icon and badge in its color, then gone, with no permanent row. Real switches only:
 * not on session restore, not for a child, not when the mode did not change.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { MODES } from "../../extensions/modes.ts";

after(() => restoreBell());

const KEY = "pi-keeper-mode-flash";
const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(settings?: Record<string, unknown>): Sandbox {
	const sandbox = makeSandbox();
	created.push(sandbox);
	if (settings !== undefined) writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), JSON.stringify(settings));
	return sandbox;
}

const root = globalThis as unknown as Record<symbol, unknown>;
let savedRelay: unknown;
beforeEach(() => {
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
	mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => {
	mock.timers.reset();
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
});

async function session(settings?: Record<string, unknown>, options: Omit<Parameters<typeof startPi>[0], "sandbox"> = {}): Promise<Harness> {
	// the shipped default is off; these tests are about the flash, so they turn it on unless a test says otherwise
	const h = await startPi({ sandbox: sandboxed({ modeFlashSecs: 2, modeWorkingRow: true, ...settings }), ...options });
	await h.session();
	return h;
}

const lineOf = (mode: "plan" | "auto" | "default") => `${MODES[mode].icon} ${MODES[mode].badge}`;
const lastFlashColor = (h: Harness) => h.themed.filter((t) => t.text.endsWith(" plan") || t.text.endsWith(" auto") || t.text.endsWith(" default")).at(-1)?.color;

describe("mode flash", () => {
	it("shows the mode in its color on a real switch, then clears it after 2 s", async () => {
		const h = await session();
		assert.equal(h.widgetOf(KEY), undefined, "nothing on a fresh session");
		for (const [mode, color] of [["plan", "success"], ["auto", "warning"], ["default", "mdLink"]] as const) {
			await h.command("mode", mode);
			assert.deepEqual(h.widgetOf(KEY), [lineOf(mode)]);
			assert.equal(lastFlashColor(h), color);
			assert.equal(color, MODES[mode].color, "the color is the mode's own, not a copy");
			mock.timers.tick(1_999);
			assert.deepEqual(h.widgetOf(KEY), [lineOf(mode)], "still shown just before the timeout");
			mock.timers.tick(1);
			assert.equal(h.widgetOf(KEY), undefined, "cleared at 2 s");
		}
	});

	it("does not flash when the mode is unchanged", async () => {
		const h = await session();
		await h.command("mode", "default");
		assert.equal(h.widgetOf(KEY), undefined);
		await h.command("mode", "plan");
		mock.timers.tick(2_000);
		await h.command("mode", "plan");
		assert.equal(h.widgetOf(KEY), undefined, "plan to plan is not a switch");
	});

	it("a new flash replaces the old one and restarts the timer", async () => {
		const h = await session();
		await h.command("mode", "plan");
		mock.timers.tick(1_500);
		await h.command("mode", "auto");
		assert.deepEqual(h.widgetOf(KEY), [lineOf("auto")]);
		mock.timers.tick(1_500);
		assert.deepEqual(h.widgetOf(KEY), [lineOf("auto")], "the first timer no longer clears it");
		mock.timers.tick(500);
		assert.equal(h.widgetOf(KEY), undefined);
	});

	it("is cleared on shutdown, with no timer left running", async () => {
		const h = await session();
		await h.command("mode", "plan");
		assert.deepEqual(h.widgetOf(KEY), [lineOf("plan")]);
		await h.shutdown();
		assert.equal(h.widgetOf(KEY), undefined);
	});

	it("does not flash on session restore", async () => {
		const h = await session(undefined, { entries: [{ type: "custom", id: "e1", timestamp: "2026-01-01T00:00:00Z", customType: "pi-keeper", data: { mode: "auto" } }] });
		assert.equal(h.statusOf("pi-keeper-mode")?.includes("auto"), true, "the restored mode is in the footer");
		assert.equal(h.widgetOf(KEY), undefined);
	});

	it("does not flash for a child", async () => {
		const h = await session(undefined, { entry: "child-auto", ui: "tui" });
		assert.equal(h.widgetOf(KEY), undefined);
	});

	it("modeFlashSecs sets the duration; 0 turns it off", async () => {
		const quick = await session({ modeFlashSecs: 0.5 });
		await quick.command("mode", "plan");
		mock.timers.tick(499);
		assert.deepEqual(quick.widgetOf(KEY), [lineOf("plan")]);
		mock.timers.tick(1);
		assert.equal(quick.widgetOf(KEY), undefined);

		const off = await session({ modeFlashSecs: 0 });
		await off.command("mode", "plan");
		assert.equal(off.widgetOf(KEY), undefined);
	});

	it("draws nothing without a UI", async () => {
		const h = await session(undefined, { ui: "none" });
		await h.command("mode", "plan");
		assert.equal(h.widgetOf(KEY), undefined);
	});

	it("while a run is active the working row carries the mode and nothing is drawn above", async () => {
		const h = await session();
		await h.command("mode", "auto");
		mock.timers.tick(2_000);
		assert.equal(h.workingMessages.at(-1), `${lineOf("auto")} \u00b7 Working`);
		h.idle = false;
		await h.command("mode", "plan");
		assert.equal(h.workingMessages.at(-1), `${lineOf("plan")} \u00b7 Working`, "a switch mid-run updates the row");
		assert.equal(h.widgetOf(KEY), undefined, "no line above the prompt during a run");
		await h.command("mode", "default");
		assert.equal(h.workingMessages.at(-1), undefined, "default mode goes back to pi's own text");
	});

	it("modeWorkingRow false (the default) leaves pi's own working text alone, whatever the flash says", async () => {
		const h = await session({ modeWorkingRow: false });
		await h.command("mode", "auto");
		assert.equal(h.workingMessages.some((m) => m !== undefined), false);
	});

	it("a dialog's waiting text gives the row back to the mode when it closes", async () => {
		const h = await session();
		await h.command("mode", "auto");
		await h.tool("bash", { command: "sudo ls" }).catch(() => undefined);
		await h.tool("write", { path: "/etc/x", content: "y" }).catch(() => undefined);
		const last = h.workingMessages.at(-1);
		assert.ok(last === undefined || last.includes("auto"), "never left on the waiting text");
		assert.notEqual(last, "Waiting for approval\u2026");
	});
});
