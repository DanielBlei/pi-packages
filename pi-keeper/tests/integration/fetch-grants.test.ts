/**
 * Fetch grants end to end: no host runs without a grant, GitHub included; a GET asks
 * once with "allow fetching from <host>" options, the grant covers later GETs
 * (not POSTs), children share it both ways, the project variant persists as
 * `Fetch(<host>)` and /permissions lists and removes the session grant.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";

after(() => restoreBell());

const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(): Sandbox {
	const sandbox = makeSandbox();
	created.push(sandbox);
	return sandbox;
}

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

const PYPI = "curl -s https://pypi.org/simple/requests/";
const SESSION = "Yes, and allow fetching from pypi.org this session";
const PROJECT = "Yes, and always allow fetching from pypi.org in this project";

describe("fetch grants", () => {
	it("a GitHub GET asks like any other host, offering the api.github.com options", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(/Permission required/, "No");
		assert.equal((await h.tool("bash", { command: "curl -s https://api.github.com/x" })).blocked, true);
		assert.equal(h.dialogs.length, 1);
		assert.ok(h.dialogs[0].options.includes("Yes, and allow fetching from api.github.com this session"), h.dialogs[0].options.join(" | "));
		assert.ok(h.dialogs[0].options.includes("Yes, and always allow fetching from api.github.com in this project"));
		h.assertNoPendingAnswers();
	});

	it("in plan mode an ungranted GitHub GET asks, like any non-read-only command", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "plan");
		h.answer(/Permission required/, "No");
		assert.equal((await h.tool("bash", { command: "curl -s https://raw.githubusercontent.com/a/b/main/x" })).blocked, true);
		assert.equal(h.dialogs.length, 1);
		h.assertNoPendingAnswers();
	});

	it("a Fetch(github.com) project rule lets that GET run without a dialog in default and plan mode", async () => {
		const sb = sandboxed();
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(join(sb.cwd, ".pi", "settings.local.json"), JSON.stringify({ "pi-keeper": { permissions: { allow: ["Fetch(github.com)", "Fetch(api.github.com)"] } } }));
		const h = await startPi({ sandbox: sb });
		h.answer(/Load 2 allow rules/, "Load them");
		await h.session();
		assert.equal((await h.tool("bash", { command: "curl -s https://api.github.com/x" })).blocked, false);
		await h.command("mode", "plan");
		assert.equal((await h.tool("bash", { command: "curl -sL https://github.com/a/b" })).blocked, false);
		assert.equal(h.dialogs.length, 1, "only the rules review");
		h.assertNoPendingAnswers();
	});

	it("a hand-written file of only Fetch(github.com) is reviewed, then lets the GET run", async () => {
		const sb = sandboxed();
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(join(sb.cwd, ".pi", "settings.local.json"), JSON.stringify({ "pi-keeper": { permissions: { allow: ["Fetch(github.com)"] } } }));
		const h = await startPi({ sandbox: sb });
		h.answer(/Load 1 allow rule/, "Load them");
		await h.session();
		assert.equal((await h.tool("bash", { command: "curl -s https://github.com/a" })).blocked, false);
		assert.equal(h.dialogs.length, 1, "only the rules review");
		h.assertNoPendingAnswers();
	});

	it("a WebFetch(domain:<host>) alias in .pi/settings.local.json acts like Fetch(<host>)", async () => {
		const sb = sandboxed();
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(join(sb.cwd, ".pi", "settings.local.json"), JSON.stringify({ "pi-keeper": { permissions: { allow: ["WebFetch(domain:api.github.com)"] } } }));
		const h = await startPi({ sandbox: sb });
		h.answer(/Load 1 allow rule/, "Load them");
		await h.session();
		assert.equal((await h.tool("bash", { command: "curl -s https://api.github.com/x" })).blocked, false);
		assert.equal(h.dialogs.length, 1, "only the rules review");
		h.assertNoPendingAnswers();
	});

	it("ignoring the review leaves the GET asking", async () => {
		const sb = sandboxed();
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(join(sb.cwd, ".pi", "settings.local.json"), JSON.stringify({ "pi-keeper": { permissions: { allow: ["Fetch(github.com)"] } } }));
		const h = await startPi({ sandbox: sb });
		h.answer(/Load 1 allow rule/, "Ignore for this session");
		await h.session();
		h.answer(/Permission required/, "No");
		assert.equal((await h.tool("bash", { command: "curl -s https://github.com/a" })).blocked, true);
		assert.equal(h.dialogs.length, 2, "the review, then the permission dialog");
		h.assertNoPendingAnswers();
	});

	it("editing the file after approval asks for a new review", async () => {
		const sb = sandboxed();
		const file = join(sb.cwd, ".pi", "settings.local.json");
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(file, JSON.stringify({ "pi-keeper": { permissions: { allow: ["Fetch(github.com)"] } } }));
		const h = await startPi({ sandbox: sb });
		h.answer(/Load 1 allow rule/, "Load them");
		await h.session();
		assert.equal((await h.tool("bash", { command: "curl -s https://github.com/a" })).blocked, false);
		writeFileSync(file, JSON.stringify({ "pi-keeper": { permissions: { allow: ["Fetch(github.com)", "Fetch(pypi.org)"] } } }));
		h.answer(/Permission required/, "No");
		assert.equal((await h.tool("bash", { command: "curl -s https://github.com/a" })).blocked, true, "inactive until reviewed");
		h.answer(/Load 2 allow rules/, "Load them");
		await h.prompt("go on");
		assert.equal((await h.tool("bash", { command: "curl -s https://pypi.org/a" })).blocked, false);
		h.assertNoPendingAnswers();
	});

	it("a hand-written file of only Read(<dir>/**) is reviewed, then allows the read", async () => {
		const sb = sandboxed();
		const outside = sandboxed();
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(join(sb.cwd, ".pi", "settings.local.json"), JSON.stringify({ "pi-keeper": { permissions: { allow: [`Read(${outside.cwd}/**)`] } } }));
		const h = await startPi({ sandbox: sb });
		h.answer(/Load 1 allow rule/, "Load them");
		await h.session();
		assert.equal((await h.tool("read", { path: join(outside.cwd, "x.txt") })).blocked, false);
		assert.equal(h.dialogs.length, 1, "only the rules review");
		h.assertNoPendingAnswers();
	});

	it("another host asks once with the host options; the session grant covers GETs, not POSTs", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(/Permission required/, SESSION);
		assert.equal((await h.tool("bash", { command: PYPI })).blocked, false);
		assert.ok(h.dialogs[0].options.includes(SESSION), h.dialogs[0].options.join(" | "));
		assert.ok(h.dialogs[0].options.includes(PROJECT), h.dialogs[0].options.join(" | "));
		assert.equal((await h.tool("bash", { command: "curl -s https://pypi.org/pypi/x/json | head" })).blocked, false);
		assert.equal(h.dialogs.length, 1, "the grant covers later GETs");
		h.answer(/Permission required/, "No");
		await h.tool("bash", { command: "curl -d x https://pypi.org/x" });
		assert.equal(h.dialogs.length, 2, "a POST still asks");
		assert.ok(!h.dialogs[1].options.includes(SESSION), "and offers no host grant");
		// the model is told
		await h.prompt("go");
		assert.match(h.modeBlocks().at(-1) ?? "", /without asking: pypi\.org/);
		h.assertNoPendingAnswers();
	});

	it("/permissions lists the session grant and removes it", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(/Permission required/, SESSION);
		await h.tool("bash", { command: PYPI });
		h.answer(/Permission rules/, "[session] fetches from pypi.org allowed");
		h.answer(/fetches from/, "Remove");
		await h.command("permissions");
		h.answer(/Permission required/, "Yes");
		await h.tool("bash", { command: PYPI });
		assert.equal(h.dialogs.filter((d) => /Permission required/.test(d.title)).length, 2, "removed: asks again");
		h.assertNoPendingAnswers();
	});

	it("a child's grant is shared with the parent, and the parent's covers the child", async () => {
		const sb = sandboxed();
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		await child.session();
		parent.answer(/subagent/, SESSION);
		assert.equal((await child.tool("bash", { command: PYPI })).blocked, false);
		const count = parent.dialogs.length;
		assert.equal((await parent.tool("bash", { command: PYPI })).blocked, false);
		assert.equal(parent.dialogs.length, count, "the parent fetches without asking");
		parent.answer(/Permission required/, "Yes, and allow fetching from docs.rs this session");
		await parent.tool("bash", { command: "curl -s https://docs.rs/x" });
		const before = parent.dialogs.length;
		assert.equal((await child.tool("bash", { command: "curl -s https://docs.rs/y" })).blocked, false);
		assert.equal(parent.dialogs.length, before, "the child fetches without asking");
		parent.assertNoPendingAnswers();
	});

	it("the project grant persists as Fetch(<host>) and covers a new session and a background child", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(/Permission required/, PROJECT);
		assert.equal((await h.tool("bash", { command: PYPI })).blocked, false);
		const rules = JSON.parse(readFileSync(join(sb.cwd, ".pi", "settings.local.json"), "utf8"));
		assert.deepEqual(rules["pi-keeper"].permissions.allow, ["Fetch(pypi.org)"]);

		const next = await startPi({ sandbox: sb });
		await next.session();
		assert.equal((await next.tool("bash", { command: PYPI })).blocked, false);
		assert.equal(next.dialogs.length, 0);
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		await child.session();
		assert.equal((await child.tool("bash", { command: PYPI })).blocked, false, "a background child inherits the project grant");
	});
});
