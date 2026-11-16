/**
 * Per-directory outside-read grants: "Yes, and allow reading from <dir>/ this
 * session" covers the directory (and below), not secrets, not other
 * directories; children share it; /permissions lists and removes it.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";

after(() => restoreBell());

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
beforeEach(() => {
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(() => {
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
});

/** Files outside the project: data/{a.txt,sub/b.txt,.env}, other/c.txt. */
function outsideFiles(sb: Sandbox): { data: string; other: string } {
	const data = realpathSync(sb.root) + "/data";
	const other = realpathSync(sb.root) + "/other";
	mkdirSync(join(data, "sub"), { recursive: true });
	mkdirSync(other, { recursive: true });
	writeFileSync(join(data, "a.txt"), "a\n");
	writeFileSync(join(data, "sub", "b.txt"), "b\n");
	writeFileSync(join(data, ".env"), "SECRET=1\n");
	writeFileSync(join(other, "c.txt"), "c\n");
	return { data, other };
}

const ASK = /Reads outside the working directory/;

describe("directory-scoped outside reads", () => {
	it("the grant covers the directory and its subdirectories, not other directories or secrets", async () => {
		const sb = sandboxed();
		const { data, other } = outsideFiles(sb);
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, `Yes, and allow reading from ${data}/ this session`);
		assert.equal((await h.tool("read", { path: join(data, "a.txt") })).blocked, false);
		const first = h.dialogs[0];
		assert.deepEqual(first.options, ["Yes", `Yes, and allow reading from ${data}/ this session`, "No", "More…"]);
		const count = h.dialogs.length;
		// sibling, subdirectory, and a bash read: no dialog
		assert.equal((await h.tool("read", { path: join(data, "sub", "b.txt") })).blocked, false);
		assert.equal((await h.tool("bash", { command: `cat ${join(data, "a.txt")}` })).blocked, false);
		assert.equal(h.dialogs.length, count);
		// another directory, the parent, and a secret inside the granted directory still ask (Yes: a No would end the run)
		for (const [name, run] of [
			["other directory", () => h.tool("read", { path: join(other, "c.txt") })],
			["parent directory", () => h.tool("bash", { command: `ls ${realpathSync(sb.root)}` })],
			["secret", () => h.tool("read", { path: join(data, ".env") })],
		] as const) {
			const before = h.dialogs.length;
			h.answer(/Reads outside|secrets/, "Yes");
			assert.equal((await run()).blocked, false, name);
			assert.equal(h.dialogs.length, before + 1, `${name} asks`);
		}
		assert.match(h.dialogs.at(-1)?.options.join("|") ?? "", /^Yes\|No/);
		h.assertNoPendingAnswers();
	});

	it("/permissions lists the granted directory and removes it", async () => {
		const sb = sandboxed();
		const { data } = outsideFiles(sb);
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, `Yes, and allow reading from ${data}/ this session`);
		await h.tool("read", { path: join(data, "a.txt") });
		const base = h.dialogs.length;
		h.answer(/Permission rules/, `[session] reads from ${data}/ allowed`);
		h.answer(/reads from/, "Remove");
		await h.command("permissions");
		assert.deepEqual(h.dialogs[base].options, [`[session] reads from ${data}/ allowed`]);
		h.assertNoPendingAnswers();
		// removed: asks again
		const before = h.dialogs.length;
		h.answer(ASK, "Yes");
		await h.tool("read", { path: join(data, "a.txt") });
		assert.equal(h.dialogs.length, before + 1);
		h.assertNoPendingAnswers();
	});

	it("a child's grant is shared with the parent, and a child honours the parent's grant", async () => {
		const sb = sandboxed();
		const { data, other } = outsideFiles(sb);
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		await child.session();
		// answered in the parent's UI for the child's call
		parent.answer(/subagent/, `Yes, and allow reading from ${data}/ this session`);
		assert.equal((await child.tool("read", { path: join(data, "a.txt") })).blocked, false);
		const count = parent.dialogs.length;
		assert.equal((await child.tool("read", { path: join(data, "sub", "b.txt") })).blocked, false);
		// the parent reads the same directory without asking
		assert.equal((await parent.tool("read", { path: join(data, "a.txt") })).blocked, false);
		assert.equal(parent.dialogs.length, count);
		// a directory granted in the parent covers the child
		parent.answer(ASK, `Yes, and allow reading from ${other}/ this session`);
		await parent.tool("read", { path: join(other, "c.txt") });
		const before = parent.dialogs.length;
		assert.equal((await child.tool("read", { path: join(other, "c.txt") })).blocked, false);
		assert.equal(parent.dialogs.length, before);
		parent.assertNoPendingAnswers();
	});

	it("a skill the prompt names is readable without a dialog; a neighbour outside the cwd still asks", async () => {
		const sb = sandboxed();
		const { data, other } = outsideFiles(sb);
		// a skills root outside the project, as ~/.agents/skills is for every repo
		const skill = join(data, "alpha");
		mkdirSync(join(skill, "scripts"), { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\n---\nbody\n");
		writeFileSync(join(skill, "scripts", "run.py"), "# run\n");
		const h = await startPi({
			sandbox: sb,
			systemPrompt: [
				"BASE",
				"<skills>",
				"Use the read tool to load a skill's file when the task matches its description.",
				"<available_skills>",
				"  <skill>",
				"    <name>alpha</name>",
				"    <description>d</description>",
				`    <location>${join(skill, "SKILL.md")}</location>`,
				"  </skill>",
				"</available_skills>",
				"</skills>",
			].join("\n"),
		});
		await h.session();
		// the skill and the files its instructions point at: no dialog
		assert.equal((await h.tool("read", { path: join(skill, "SKILL.md") })).blocked, false);
		assert.equal((await h.tool("read", { path: join(skill, "scripts", "run.py") })).blocked, false);
		assert.equal((await h.tool("bash", { command: `cat ${join(skill, "SKILL.md")}` })).blocked, false);
		assert.equal(h.dialogs.length, 0);
		// anything else outside the project still asks
		h.answer(ASK, "Yes");
		assert.equal((await h.tool("read", { path: join(other, "c.txt") })).blocked, false);
		assert.equal(h.dialogs.length, 1);
		// and a secret inside the skill directory still asks
		writeFileSync(join(skill, ".env"), "SECRET=1\n");
		h.answer(/secrets/, "Yes");
		assert.equal((await h.tool("read", { path: join(skill, ".env") })).blocked, false);
		assert.equal(h.dialogs.length, 2);
		h.assertNoPendingAnswers();
	});

	it("the home directory and / get no directory grant", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, "Yes");
		await h.tool("read", { path: "/" });
		assert.deepEqual(h.dialogs[0].options, ["Yes", "No", "More…"]);
		h.answer(ASK, "Yes");
		await h.tool("bash", { command: "ls ~" });
		assert.deepEqual(h.dialogs[1].options, ["Yes", "No", "More…"]);
	});
});
