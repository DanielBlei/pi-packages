/**
 * The session grant "Yes, and allow python `while` loops this session (higher
 * risk: a loop may not end)": a python script whose only problem is a `while`
 * loop asks once; the dialog offers the grant only when a dry run with it would
 * allow. Any other problem keeps asking and never offers it. Auto mode never
 * offers it. Plan mode treats it like loop-globs: a session grant, offered
 * wherever the dry run allows (python scripts are judged in plan too).
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeSandbox, restoreBell, startPi, type Sandbox } from "../mocks/pi.ts";
import { PARENT_SESSION_ENV } from "../../extensions/session-grants.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { TELEMETRY_ENTRY } from "../../extensions/telemetry.ts";

after(() => restoreBell());

const skip = spawnSync("python3", ["--version"]).status === 0 ? false : "python3 is not installed";
const TMPDIR = process.env.TMPDIR;
const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(): Sandbox {
	if (TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = TMPDIR;
	const sandbox = makeSandbox();
	created.push(sandbox);
	return sandbox;
}

const root = globalThis as unknown as Record<symbol, unknown>;
let savedRelay: unknown;
const savedParentEnv = process.env[PARENT_SESSION_ENV];
const savedAsksEnv = process.env.PI_KEEPER_BACKGROUND_ASKS;
beforeEach(() => {
	process.env.PI_KEEPER_BACKGROUND_ASKS = "0";
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(() => {
	if (savedAsksEnv === undefined) delete process.env.PI_KEEPER_BACKGROUND_ASKS;
	else process.env.PI_KEEPER_BACKGROUND_ASKS = savedAsksEnv;
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
	if (savedParentEnv === undefined) delete process.env[PARENT_SESSION_ENV];
	else process.env[PARENT_SESSION_ENV] = savedParentEnv;
});

const ASK = /Permission required/;
const GRANT = "Yes, and allow python `while` loops this session (higher risk: a loop may not end or may fill memory)";
const py = (script: string): string => `python3 - <<'PYEOF'\n${script}\nPYEOF`;
const WHILE = py("n = 3\nwhile n:\n    n -= 1\nprint(n)");
const WHILE2 = py("total = 0\nwhile total < 5:\n    total += 2\nprint(total)");
const offered = (options: readonly string[]): boolean => options.some((o) => o.startsWith("Yes, and allow python `while` loops"));

describe("a while script asks once", { skip }, () => {
	it("offers the grant, allows the call, then another while script runs with no dialog", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(ASK, GRANT);
		assert.equal((await h.tool("bash", { command: WHILE })).blocked, false);
		assert.ok(h.dialogs[0].options.includes(GRANT), h.dialogs[0].options.join(" | "));
		const count = h.dialogs.length;
		assert.equal((await h.tool("bash", { command: WHILE })).blocked, false);
		assert.equal((await h.tool("bash", { command: WHILE2 })).blocked, false);
		assert.equal(h.dialogs.length, count);
		const choice = h.entries
			.filter((e) => e.type === "custom" && e.customType === TELEMETRY_ENTRY)
			.map((e) => e.data as Record<string, unknown>)
			.find((d) => d.phase === "choice");
		assert.equal(choice?.remembered, "python while loops");
		assert.equal(choice?.scope, "session");
		h.assertNoPendingAnswers();
	});

	it("a declined offer grants nothing", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: WHILE })).blocked, true);
		await h.prompt("go on");
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: WHILE })).blocked, true);
		assert.equal(h.dialogs.length, 2);
		h.assertNoPendingAnswers();
	});
});

describe("other problems keep asking and never offer it", { skip }, () => {
	const others: Array<[string, string]> = [
		["a `**` in the loop body", py("n = 3\nwhile n:\n    n = n ** 2")],
		["an unknown import", py("import requests\nn = 1\nwhile n:\n    n -= 1")],
	];
	for (const [name, command] of others) {
		it(`${name}, without the grant`, async () => {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			h.answer(ASK, "No");
			assert.equal((await h.tool("bash", { command })).blocked, true);
			assert.ok(!offered(h.dialogs[0].options), h.dialogs[0].options.join(" | "));
			h.assertNoPendingAnswers();
		});
		it(`${name}, with the grant`, async () => {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			h.answer(ASK, GRANT);
			assert.equal((await h.tool("bash", { command: WHILE })).blocked, false);
			const before = h.dialogs.length;
			await h.prompt("go on");
			h.answer(ASK, "No");
			assert.equal((await h.tool("bash", { command })).blocked, true);
			assert.equal(h.dialogs.length, before + 1, "asked again");
			assert.ok(!offered(h.dialogs[before].options));
			h.assertNoPendingAnswers();
		});
	}

	it("not in auto mode", async () => {
		const h = await startPi({ sandbox: sandboxed(), entry: "child-auto" });
		await h.session();
		h.answer(ASK, "No");
		await h.tool("bash", { command: WHILE });
		assert.ok(h.dialogs.every((d) => !offered(d.options)));
	});
});

describe("plan mode", { skip }, () => {
	it("offers it like loop-globs (a session grant), and the answer reaches the parent", async () => {
		const sb = sandboxed();
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		const child = await startPi({ sandbox: sb, entry: "child-plan" });
		await child.session();
		parent.answer(/Permission required \(subagent/, GRANT);
		assert.equal((await child.tool("bash", { command: WHILE })).blocked, false);
		assert.ok(parent.dialogs[0].options.some((o) => o.startsWith("Yes, and allow python `while` loops")), parent.dialogs[0].options.join(" | "));
		const count = parent.dialogs.length;
		assert.equal((await parent.tool("bash", { command: WHILE2 })).blocked, false);
		assert.equal(parent.dialogs.length, count);
		parent.assertNoPendingAnswers();
	});
});
