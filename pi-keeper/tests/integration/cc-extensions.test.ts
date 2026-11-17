/**
 * pi-cc-extensions compatibility in the parent session: the one-time dialog at
 * session start and its four choices. Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";

after(() => restoreBell());

const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

const started: Harness[] = [];
const DIALOG = /pi-cc-extensions hides pi-keeper's plan approval/;
const CC_COMMAND = [{ name: "ccstyle", source: "extension" as const }];

function sandboxed(settings?: unknown): Sandbox {
	const sandbox = makeSandbox();
	created.push(sandbox);
	if (settings !== undefined) writeFileSync(join(sandbox.agentDir, "pi-cc-extensions.json"), JSON.stringify(settings));
	return sandbox;
}

const ccText = (sandbox: Sandbox): string => readFileSync(join(sandbox.agentDir, "pi-cc-extensions.json"), "utf8");
const ccFile = (sandbox: Sandbox): Record<string, unknown> => JSON.parse(ccText(sandbox)) as Record<string, unknown>;
const dialogsOf = (h: Harness): number => h.dialogs.filter((d) => DIALOG.test(d.title)).length;

/** A pi that has not started a session yet; answers can be queued before session_start. */
async function harnessFor(sandbox: Sandbox, ccCommand = true): Promise<Harness> {
	const h = await startPi({ sandbox, ui: "tui", ...(ccCommand ? { commands: CC_COMMAND } : {}) });
	started.push(h);
	return h;
}

/** Starts the session and lets the scheduled dialog timer run (the offer is not awaited by session_start). */
async function sessionStart(h: Harness): Promise<void> {
	await h.session();
	await new Promise((resolve) => setTimeout(resolve, 20));
}

const root = globalThis as unknown as Record<symbol, unknown>;
let savedRelay: unknown;
beforeEach(() => {
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(async () => {
	for (const harness of started.splice(0)) await harness.shutdown();
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
});

describe("pi-cc-extensions dialog at session start", () => {
	it("opens once when the plan approval is hidden, and not again in the same session", async () => {
		const h = await harnessFor(sandboxed({ excludeRenderers: ["read"] }));
		h.answer(DIALOG, "esc");
		await sessionStart(h);
		// a second session_start in the same session: no answer is queued, so a second dialog would throw
		await sessionStart(h);
		assert.equal(dialogsOf(h), 1);
		h.assertNoPendingAnswers();
	});

	it("does not open when exit_plan_mode is already excluded", async () => {
		const h = await harnessFor(sandboxed({ excludeRenderers: ["exit_plan_mode"] }));
		await sessionStart(h);
		assert.equal(dialogsOf(h), 0);
	});

	it("does not open when pi-cc-extensions is not in use", async () => {
		const h = await harnessFor(sandboxed(), false);
		await sessionStart(h);
		assert.equal(dialogsOf(h), 0);
	});

	it("does not open in a subagent child", async () => {
		const sandbox = sandboxed({ excludeRenderers: ["read"] });
		const child = await startPi({ sandbox, entry: "child-default", ui: "tui", commands: CC_COMMAND });
		started.push(child);
		await sessionStart(child);
		assert.equal(dialogsOf(child), 0);
	});

	it("Apply the fix writes exit_plan_mode and keeps the other settings", async () => {
		const sandbox = sandboxed({ theme: "dark", excludeRenderers: ["read"] });
		const h = await harnessFor(sandbox);
		h.answer(DIALOG, /^Apply the fix to /);
		await sessionStart(h);
		assert.deepEqual(ccFile(sandbox), { theme: "dark", excludeRenderers: ["read", "exit_plan_mode"] });
		assert.ok(h.notifications.some((n) => n.type === "info" && /^Added exit_plan_mode to excludeRenderers in .*Run \/reload \(or restart pi\) to apply it\.$/.test(n.message)));
		assert.ok(!existsSync(join(sandbox.agentDir, "pi-cc-extensions.json.tmp")));
		h.assertNoPendingAnswers();
	});

	it("Put a prompt for the agent in the editor fills the editor and sends nothing", async () => {
		const sandbox = sandboxed({ excludeRenderers: ["read"] });
		const h = await harnessFor(sandbox);
		h.answer(DIALOG, /^Put a prompt for the agent/);
		await sessionStart(h);
		assert.match(h.editorText, /^Add "exit_plan_mode" to the "excludeRenderers" list in .*pi-cc-extensions\.json, creating the list if it is missing and keeping every other setting unchanged\. Then tell me to run \/reload\.$/);
		assert.deepEqual(ccFile(sandbox), { excludeRenderers: ["read"] }, "the file is not touched");
		assert.equal(h.userMessages.length, 0);
		assert.equal(h.sentMessages.length, 0);
		h.assertNoPendingAnswers();
	});

	it("Not now writes nothing, and the next session asks again", async () => {
		const sandbox = sandboxed({ excludeRenderers: ["read"] });
		const before = ccText(sandbox);
		const first = await harnessFor(sandbox);
		first.answer(DIALOG, /^Not now/);
		await sessionStart(first);
		assert.equal(ccText(sandbox), before);
		assert.equal(existsSync(join(sandbox.agentDir, "pi-keeper.json")), false, "nothing saved");
		first.assertNoPendingAnswers();

		const next = await harnessFor(sandbox);
		next.answer(DIALOG, /^Not now/);
		await sessionStart(next);
		assert.equal(dialogsOf(next), 1, "a new session asks again");
		next.assertNoPendingAnswers();
	});

	it("Don't ask again saves ccExtensionsPrompt false; the next session shows no dialog", async () => {
		const sandbox = sandboxed({ excludeRenderers: ["read"] });
		const first = await harnessFor(sandbox);
		first.answer(DIALOG, /^Don't ask again/);
		await sessionStart(first);
		assert.deepEqual(JSON.parse(readFileSync(join(sandbox.agentDir, "pi-keeper.json"), "utf8")), { ccExtensionsPrompt: false });
		assert.equal(ccText(sandbox), JSON.stringify({ excludeRenderers: ["read"] }), "the fix is not applied");

		const next = await harnessFor(sandbox);
		await sessionStart(next);
		assert.equal(dialogsOf(next), 0);
		next.assertNoPendingAnswers();
	});
});
