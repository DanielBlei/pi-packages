/**
 * The session grant "Yes, and allow loops over globs this session": a `for`
 * loop over an unquoted glob asks once; the dialog offers the grant only when a
 * dry run with it would allow. Every hard limit keeps asking, with or without
 * the grant, and never offers it. Children inherit the grant.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, scratchOf, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { PARENT_SESSION_ENV } from "../../extensions/session-grants.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { TELEMETRY_ENTRY } from "../../extensions/telemetry.ts";

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
	mkdirSync(join(sandbox.cwd, "data"), { recursive: true });
	writeFileSync(join(sandbox.cwd, "data", "a.json"), "{}");
	writeFileSync(join(sandbox.cwd, "data", "b.json"), "{}");
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
const GRANT = "Yes, and allow loops over globs this session";
const LOOP = 'for f in data/*.json; do cat "$f"; done';
const LOOP2 = 'for f in data/*.json; do head -n 1 "$f"; done';
const offered = (h: Harness, at = 0): boolean => (h.dialogs[at]?.options ?? []).some((o) => o.startsWith("Yes, and allow loops over globs"));

describe("a glob loop asks once", () => {
	it("offers the grant, allows the call, then a second glob loop runs with no dialog", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, GRANT);
		assert.equal((await h.tool("bash", { command: LOOP })).blocked, false);
		assert.ok(h.dialogs[0].options.includes(GRANT), h.dialogs[0].options.join(" | "));
		const count = h.dialogs.length;
		assert.equal((await h.tool("bash", { command: LOOP2 })).blocked, false);
		assert.equal(h.dialogs.length, count);
		const choice = h.entries
			.filter((e) => e.type === "custom" && e.customType === TELEMETRY_ENTRY)
			.map((e) => e.data as Record<string, unknown>)
			.find((d) => d.phase === "choice");
		assert.equal(choice?.remembered, "loops over globs");
		assert.equal(choice?.scope, "session");
		h.assertNoPendingAnswers();
	});

	it("a declined offer grants nothing", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: LOOP })).blocked, true);
		assert.ok(offered(h));
		h.assertNoPendingAnswers();
	});
});

describe("the hard limits ask again, with the grant, and never offer it", () => {
	async function granted(sb: Sandbox): Promise<Harness> {
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, GRANT);
		assert.equal((await h.tool("bash", { command: LOOP })).blocked, false);
		return h;
	}

	const limits: Array<[string, (sb: Sandbox, scratch: string) => { files?: Record<string, string>; command: string }]> = [
		["a bare * with a file named -x present", () => ({ files: { "-x": "" }, command: 'for f in *; do cat "$f"; done' })],
		["a write earlier in the command", () => ({ command: 'touch data/new.json; for f in data/*.json; do cat "$f"; done' })],
		["a glob inside the scratch dir", (_sb, scratch) => ({ command: `for f in ${scratch}/*; do cat "$f"; done` })],
		["a body that is not read-only", () => ({ command: 'for f in data/*.json; do rm "$f"; done' })],
		["a glob that matches nothing", () => ({ command: 'for f in data/*.nothing; do cat "$f"; done' })],
	];
	for (const [name, make] of limits) {
		it(name, async () => {
			const sb = sandboxed();
			const h = await granted(sb);
			const spec = make(sb, scratchOf(h));
			for (const [file, text] of Object.entries(spec.files ?? {})) writeFileSync(join(sb.cwd, file), text);
			const before = h.dialogs.length;
			h.answer(ASK, "No");
			assert.equal((await h.tool("bash", { command: spec.command })).blocked, true);
			assert.equal(h.dialogs.length, before + 1, "asked again");
			assert.ok(!offered(h, before), h.dialogs[before].options.join(" | "));
			h.assertNoPendingAnswers();
		});
	}

	it("without the grant, the same limits do not offer it either", async () => {
		const sb = sandboxed();
		writeFileSync(join(sb.cwd, "-x"), "");
		const h = await startPi({ sandbox: sb });
		await h.session();
		for (const command of ['for f in *; do cat "$f"; done', 'for f in data/*.json; do rm "$f"; done', 'for f in data/*.nothing; do cat "$f"; done']) {
			h.answer(ASK, "No");
			assert.equal((await h.tool("bash", { command })).blocked, true);
		}
		assert.ok(h.dialogs.every((d) => !d.options.some((o) => o.startsWith("Yes, and allow loops over globs"))));
	});
});

describe("where it is not offered", () => {
	it("not for a literal loop or a non-loop command", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		for (const command of ['for f in data/a.json data/b.json; do cat "$f"; done', "npm test", "python3 x.py"]) {
			h.answer(ASK, "No");
			await h.tool("bash", { command });
		}
		assert.ok(h.dialogs.length >= 1);
		assert.ok(h.dialogs.every((d) => !d.options.some((o) => o.startsWith("Yes, and allow loops over globs"))));
	});

	it("not in auto mode", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb, entry: "child-auto" });
		await h.session();
		h.answer(/Permission required/, "No");
		await h.tool("bash", { command: LOOP });
		assert.ok(h.dialogs.every((d) => !d.options.some((o) => o.startsWith("Yes, and allow loops over globs"))));
	});
});

describe("children inherit the grant", () => {
	it("a foreground child (through the relay) runs a glob loop without a dialog", async () => {
		const sb = sandboxed();
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		await child.session();
		parent.answer(ASK, GRANT);
		assert.equal((await parent.tool("bash", { command: LOOP })).blocked, false);
		assert.equal((await child.tool("bash", { command: LOOP2 })).blocked, false);
		assert.equal(child.dialogs.length, 0);
		parent.assertNoPendingAnswers();
	});

	it("a foreground child's grant reaches the parent", async () => {
		const sb = sandboxed();
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		await child.session();
		parent.answer(/Permission required \(subagent/, GRANT);
		assert.equal((await child.tool("bash", { command: LOOP })).blocked, false);
		const count = parent.dialogs.length;
		assert.equal((await parent.tool("bash", { command: LOOP2 })).blocked, false);
		assert.equal(parent.dialogs.length, count);
		parent.assertNoPendingAnswers();
	});

	it("a background child (through the published snapshot) runs a glob loop without a dialog", async () => {
		const sb = sandboxed();
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		parent.answer(ASK, GRANT);
		assert.equal((await parent.tool("bash", { command: LOOP })).blocked, false);
		const relay = root[RELAY_KEY];
		delete root[RELAY_KEY];
		process.env[PARENT_SESSION_ENV] = parent.sessionId;
		try {
			const child = await startPi({ sandbox: sb, entry: "child-default" });
			await child.session();
			assert.equal((await child.tool("bash", { command: LOOP2 })).blocked, false);
			assert.equal(child.dialogs.length, 0);
		} finally {
			if (relay !== undefined) root[RELAY_KEY] = relay;
		}
	});
});
