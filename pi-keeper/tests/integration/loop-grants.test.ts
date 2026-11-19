/**
 * The dialog of a loop that still asks offers the prefixes of its expanded
 * body (`harbor *` for a `harbor repo list` loop), not only the exact text.
 * Removals, dangerous bodies and refused expansions keep today's options.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";

after(() => restoreBell());

const TMPDIR = process.env.TMPDIR;
const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

const root = globalThis as unknown as Record<symbol, unknown>;
let savedRelay: unknown;
beforeEach(() => {
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(() => {
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
});

async function start(): Promise<{ h: Harness; sb: Sandbox }> {
	if (TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = TMPDIR;
	const sb = makeSandbox();
	created.push(sb);
	const h = await startPi({ sandbox: sb });
	await h.session();
	return { h, sb };
}

const ASK = /Permission required/;
const LOOP = 'for p in a b; do harbor repo list --project "$p"; done';
const SESSION = "Yes, and don't ask again for `harbor` this session";
const PROJECT = /^Yes, and always allow `harbor` in this project/;
const grants = (h: Harness): string[] => (h.dialogs[0]?.options ?? []).filter((o) => /don't ask again|always allow/.test(o));

describe("loops offer the prefixes of their expanded body", () => {
	it("offers the session and project options in default mode", async () => {
		const { h } = await start();
		h.answer(ASK, "Yes");
		await h.tool("bash", { command: LOOP });
		assert.ok(h.dialogs[0].options.some((o) => o.startsWith(SESSION)), h.dialogs[0].options.join(" | "));
		assert.ok(h.dialogs[0].options.some((o) => PROJECT.test(o)), h.dialogs[0].options.join(" | "));
	});

	it("the session option covers the same loop and a plain command with no dialog", async () => {
		const { h } = await start();
		h.answer(ASK, /^Yes, and don't ask again for `harbor` this session/);
		assert.equal((await h.tool("bash", { command: LOOP })).blocked, false);
		const count = h.dialogs.length;
		assert.equal((await h.tool("bash", { command: LOOP })).blocked, false);
		assert.equal((await h.tool("bash", { command: "harbor repo list --project c" })).blocked, false);
		assert.equal(h.dialogs.length, count);
		h.assertNoPendingAnswers();
	});

	it("the project option writes Bash(harbor *) to the project rules", async () => {
		const { h, sb } = await start();
		h.answer(ASK, PROJECT);
		assert.equal((await h.tool("bash", { command: LOOP })).blocked, false);
		const rules = JSON.parse(readFileSync(join(sb.cwd, ".pi", "settings.local.json"), "utf8"));
		assert.deepEqual(rules["pi-keeper"].permissions.allow, ["Bash(harbor *)"]);
	});

	it("a removal body offers no prefix", async () => {
		const { h } = await start();
		h.answer(ASK, "Yes");
		await h.tool("bash", { command: 'for f in a b; do rm -f "$f"; done' });
		assert.deepEqual(grants(h), [], h.dialogs[0].options.join(" | "));
	});

	it("a dangerous body offers no grant option", async () => {
		const { h } = await start();
		h.answer(ASK, "Yes");
		await h.tool("bash", { command: 'for p in web-1 web-2; do oc delete pod "$p"; done' });
		assert.deepEqual(grants(h), [], h.dialogs[0].options.join(" | "));
	});

	it("a refused loop (17 words) keeps today's options", async () => {
		const { h } = await start();
		h.answer(ASK, "Yes");
		const words = Array.from({ length: 17 }, (_, i) => `w${i}`).join(" ");
		await h.tool("bash", { command: `for p in ${words}; do harbor repo list --project "$p"; done` });
		assert.equal(h.dialogs[0].options.some((o) => o.startsWith(SESSION)), false, h.dialogs[0].options.join(" | "));
		assert.equal(h.dialogs[0].options.some((o) => PROJECT.test(o)), false);
	});

	it("plan mode offers no project option", async () => {
		const { h } = await start();
		await h.command("mode", "plan");
		h.answer(ASK, "Yes");
		await h.tool("bash", { command: LOOP });
		assert.equal(h.dialogs[0].options.some((o) => PROJECT.test(o)), false, h.dialogs[0].options.join(" | "));
	});
});
