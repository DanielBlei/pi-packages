/**
 * What the dialogs may save to the project (.pi/settings.local.json), per the
 * `/keeper` settings: `projectCommandApprovals` (default on) offers "always
 * allow <prefix> in this project"; `projectReadApprovals` (default off) offers
 * "always allow reading from <dir>/ in this project", saved as a
 * `Read(<dir>/**)` allow rule that every later session and every subagent
 * honours (secrets inside still ask). Off, approvals stay once/session.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { parseRules } from "../../extensions/project-rules.ts";

after(() => restoreBell());

const TMPDIR = process.env.TMPDIR;
const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(settings?: Record<string, boolean>): Sandbox {
	if (TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = TMPDIR;
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
});
afterEach(() => {
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
});

const NPM_PROJECT = /^Yes, and always allow `npm test` in this project/;
const READ_PROJECT = /^Yes, and always allow reading from .* in this project$/;

function outsideDir(sandbox: Sandbox): string {
	const dir = mkdtempSync(join(sandbox.root, "outside-"));
	writeFileSync(join(dir, "notes.md"), "x");
	writeFileSync(join(dir, ".env"), "SECRET=1");
	return dir;
}

async function parentOf(sandbox: Sandbox): Promise<Harness> {
	const h = await startPi({ sandbox });
	await h.session();
	return h;
}

describe("projectCommandApprovals", () => {
	it("on by default: the command dialog offers the project rule", async () => {
		const h = await parentOf(sandboxed());
		h.answer(/Permission required/, "Yes");
		await h.tool("bash", { command: "npm test" });
		assert.ok(h.dialogs[0].options.some((o) => NPM_PROJECT.test(o)), h.dialogs[0].options.join(" | "));
	});

	it("off: no project option, the session option stays", async () => {
		const h = await parentOf(sandboxed({ projectCommandApprovals: false }));
		h.answer(/Permission required/, "Yes");
		await h.tool("bash", { command: "npm test" });
		assert.equal(h.dialogs[0].options.some((o) => NPM_PROJECT.test(o)), false);
		assert.ok(h.dialogs[0].options.some((o) => /this session/.test(o)));
	});
});

describe("projectReadApprovals", () => {
	it("off by default: outside reads offer once/session only", async () => {
		const sandbox = sandboxed();
		const dir = outsideDir(sandbox);
		const h = await parentOf(sandbox);
		h.answer(/Permission required/, "Yes");
		await h.tool("read", { path: join(dir, "notes.md") });
		assert.equal(h.dialogs[0].options.some((o) => READ_PROJECT.test(o)), false);
	});

	it("on: the saved directory holds across sessions and for background subagents; secrets still ask", async () => {
		const sandbox = sandboxed({ projectReadApprovals: true });
		const dir = outsideDir(sandbox);
		// the option is offered; its label names the directory
		const probe = await parentOf(sandbox);
		probe.answer(/Permission required/, "Yes");
		await probe.tool("read", { path: join(dir, "notes.md") });
		const label = probe.dialogs[0].options.find((o) => READ_PROJECT.test(o));
		assert.ok(label !== undefined, probe.dialogs[0].options.join(" | "));

		const saver = await parentOf(sandbox);
		saver.answer(/Permission required/, label);
		assert.equal((await saver.tool("read", { path: join(dir, "notes.md") })).blocked, false);
		const rules = JSON.parse(readFileSync(join(sandbox.cwd, ".pi", "settings.local.json"), "utf8"));
		assert.deepEqual(rules["pi-keeper"].permissions.allow, [`Read(${dir}/**)`]);

		// a new session (pi restarted): no dialog
		const next = await parentOf(sandbox);
		assert.equal((await next.tool("read", { path: join(dir, "notes.md") })).blocked, false);
		assert.equal(next.dialogs.length, 0);
		// ...and every model is told (the rules line)
		const told = new RegExp(`Reads allowed outside the working directory \\(secrets still ask\\): ${dir}/`);
		await next.prompt("go");
		// the mode message carries the mode and the rules, re-sent whole when either changes
		assert.match([...next.modeBlocks(), ...next.rulesBlocks()].join("\n"), told, "the model is told the rule");
		// a background subagent (no relay): allowed too
		delete root[RELAY_KEY];
		const child = await startPi({ sandbox, entry: "child-default" });
		await child.session();
		assert.equal((await child.tool("read", { path: join(dir, "notes.md") })).blocked, false);
		await child.prompt("go");
		assert.match(child.rulesBlocks().at(-1) ?? "", told, "a child's rules arrive as their own message");
		// a secret inside the saved directory still asks (denied without a relay)
		assert.equal((await child.tool("read", { path: join(dir, ".env") })).blocked, true);
	});
});

describe("Read(<dir>/**) entries", () => {
	it("refuses /, the home directory, its ancestors, relative paths, and Read in ask/deny", () => {
		const home = homedir();
		const parsed = parseRules({
			"pi-keeper": {
				permissions: {
					allow: ["Read(/**)", `Read(${home}/**)`, "Read(/home/**)", "Read(rel/dir/**)", "Read(/srv/data)", "Read(/srv/data/**)"],
					deny: ["Read(/srv/data/**)"],
				},
			},
		});
		assert.deepEqual(parsed.readDirs.map((r) => r.dir), ["/srv/data"]);
		assert.equal(parsed.allow.length, 0, "Read entries never become command rules");
		assert.equal(parsed.warnings.length, 6, parsed.warnings.join("\n"));
	});
});

