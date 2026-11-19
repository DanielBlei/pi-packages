/**
 * Session grants reach background subagent children. A background child runs
 * in a separate runner process, so it cannot read the parent's grants through
 * the UI relay; the parent publishes them (extensions/session-grants.ts) and
 * the child, told its parent session by pi-subagents (PI_SUBAGENT_PARENT_SESSION),
 * reads them. Grants stay session-scope: never written to the project, gone
 * when the parent session ends, ignored when stale or foreign.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { grantsFile, PARENT_SESSION_ENV, readParentGrants } from "../../extensions/session-grants.ts";

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
const savedParentEnv = process.env[PARENT_SESSION_ENV];
const savedAsksEnv = process.env.PI_KEEPER_BACKGROUND_ASKS;
beforeEach(() => {
	// these tests are about grants the child reads, not asks it sends: the kill switch keeps a denied call a plain deny (no parent polls here)
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

const SESSION_NPM_TEST = "Yes, and don't ask again for `npm test` this session (also via rtk)";

/** A parent with a UI that grants, for this session: `npm test`, reads from one outside dir. */
async function grantingParent(sandbox: Sandbox): Promise<{ parent: Harness; outside: string }> {
	const outside = mkdtempSync(join(sandbox.root, "outside-"));
	writeFileSync(join(outside, "notes.md"), "x");
	const parent = await startPi({ sandbox });
	await parent.session();
	parent.answer(/Permission required/, SESSION_NPM_TEST);
	assert.equal((await parent.tool("bash", { command: "npm test" })).blocked, false);
	parent.answer(/Permission required/, `Yes, and allow reading from ${outside}/ this session`);
	assert.equal((await parent.tool("read", { path: join(outside, "notes.md") })).blocked, false);
	parent.assertNoPendingAnswers();
	return { parent, outside };
}

/** A background child: no relay in its process, the parent's session id in its env. */
async function backgroundChild(sandbox: Sandbox, parentSessionId: string | undefined): Promise<Harness> {
	const relay = root[RELAY_KEY];
	delete root[RELAY_KEY];
	if (parentSessionId === undefined) delete process.env[PARENT_SESSION_ENV];
	else process.env[PARENT_SESSION_ENV] = parentSessionId;
	try {
		const child = await startPi({ sandbox, entry: "child-default" });
		await child.session();
		return child;
	} finally {
		if (relay !== undefined) root[RELAY_KEY] = relay;
	}
}

/** Run a child call the way a runner process does: no relay reachable. */
async function inRunner<T>(fn: () => Promise<T>): Promise<T> {
	const relay = root[RELAY_KEY];
	delete root[RELAY_KEY];
	try {
		return await fn();
	} finally {
		if (relay !== undefined) root[RELAY_KEY] = relay;
	}
}

describe("a background child honours its parent session's grants", () => {
	it("session-approved commands and read dirs run in the background child, without a dialog", async () => {
		const sandbox = sandboxed();
		const { parent, outside } = await grantingParent(sandbox);
		const child = await backgroundChild(sandbox, parent.sessionId);
		assert.equal((await inRunner(() => child.tool("bash", { command: "npm test" }))).blocked, false);
		assert.equal((await inRunner(() => child.tool("read", { path: join(outside, "notes.md") }))).blocked, false);
		assert.equal(child.dialogs.length, 0);
	});

	it("nothing is written to the project", async () => {
		const sandbox = sandboxed();
		await grantingParent(sandbox);
		assert.equal(existsSync(join(sandbox.cwd, ".pi", "settings.local.json")), false);
	});

	it("a grant made while the child runs applies to its next call", async () => {
		const sandbox = sandboxed();
		const parent = await startPi({ sandbox });
		await parent.session();
		const child = await backgroundChild(sandbox, parent.sessionId);
		assert.equal((await inRunner(() => child.tool("bash", { command: "npm test" }))).blocked, true);
		parent.answer(/Permission required/, SESSION_NPM_TEST);
		await parent.tool("bash", { command: "npm test" });
		assert.equal((await inRunner(() => child.tool("bash", { command: "npm test" }))).blocked, false);
	});

	it("fail-closed: no parent session in the env, another session's id, or the parent session ended", async () => {
		const sandbox = sandboxed();
		const { parent } = await grantingParent(sandbox);
		const orphan = await backgroundChild(sandbox, undefined);
		assert.equal((await inRunner(() => orphan.tool("bash", { command: "npm test" }))).blocked, true);
		const foreign = await backgroundChild(sandbox, "some-other-session");
		assert.equal((await inRunner(() => foreign.tool("bash", { command: "npm test" }))).blocked, true);
		const child = await backgroundChild(sandbox, parent.sessionId);
		await parent.shutdown();
		assert.equal(existsSync(grantsFile(sandbox.agentDir, parent.sessionId)), false, "snapshot withdrawn at shutdown");
		assert.equal((await inRunner(() => child.tool("bash", { command: "npm test" }))).blocked, true);
	});

	it("a background child cannot forge its parent's grants", async () => {
		const sandbox = sandboxed();
		const { parent } = await grantingParent(sandbox);
		const child = await backgroundChild(sandbox, parent.sessionId);
		const file = grantsFile(sandbox.agentDir, parent.sessionId);
		const forged = JSON.stringify({ edits: true });
		assert.equal((await inRunner(() => child.tool("write", { path: file, content: forged }))).blocked, true);
		assert.equal((await inRunner(() => child.tool("bash", { command: `echo '${forged}' > ${file}` }))).blocked, true);
		assert.equal((await inRunner(() => child.tool("bash", { command: `rm ${file}` }))).blocked, true);
	});
});

describe("the published snapshot", () => {
	it("has exactly the documented keys, no verbatim grant, and mode 0600", async () => {
		const sandbox = sandboxed();
		const { parent } = await grantingParent(sandbox);
		// the parent also holds a verbatim ("this exact command") grant: it must not appear in the file
		parent.answer(/Permission required/, "Yes, and don't ask again for this exact command this session");
		assert.equal((await parent.tool("bash", { command: "python3 x.py" })).blocked, false);
		parent.assertNoPendingAnswers();
		const file = grantsFile(sandbox.agentDir, parent.sessionId);
		const keys = Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>).sort();
		const required = ["edits", "exact", "fetchHosts", "gitRepos", "loopGlobs", "outsideReadDirs", "outsideReads", "pid", "prefixes", "pythonWhile", "sessionId", "tools", "version"];
		const optional = ["cwd", "thinking"];
		assert.deepEqual(
			keys.filter((k) => !optional.includes(k)),
			required,
		);
		assert.ok(keys.every((k) => required.includes(k) || optional.includes(k)), `unexpected keys: ${keys.join(",")}`);
		assert.ok(!keys.some((k) => /verbatim/i.test(k)));
		assert.doesNotMatch(readFileSync(file, "utf8"), /python3/, "the verbatim command text is not published");
		assert.equal(statSync(file).mode & 0o777, 0o600);
	});
});

describe("the snapshot reader", () => {
	it("ignores a malformed file and a dead owner process", () => {
		const sandbox = sandboxed();
		const env = { [PARENT_SESSION_ENV]: "s1" };
		const file = grantsFile(sandbox.agentDir, "s1");
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, "{not json");
		assert.equal(readParentGrants(sandbox.agentDir, env), undefined);
		const snapshot = { version: 1, sessionId: "s1", pid: 2 ** 22 + 12345, prefixes: [["npm", "test"]], exact: [], edits: true, outsideReads: false, outsideReadDirs: [] };
		writeFileSync(file, JSON.stringify(snapshot));
		assert.equal(readParentGrants(sandbox.agentDir, env), undefined, "dead pid");
		writeFileSync(file, JSON.stringify({ ...snapshot, pid: process.pid, sessionId: "s2" }));
		assert.equal(readParentGrants(sandbox.agentDir, env), undefined, "foreign session id");
		writeFileSync(file, JSON.stringify({ ...snapshot, pid: process.pid, edits: "yes" }));
		assert.equal(readParentGrants(sandbox.agentDir, env), undefined, "wrong type");
		writeFileSync(file, JSON.stringify({ ...snapshot, pid: process.pid }));
		assert.deepEqual(readParentGrants(sandbox.agentDir, env)?.prefixes, [["npm", "test"]]);
	});

	it("rejects a symlinked snapshot and a FIFO snapshot without hanging", (t) => {
		const sandbox = sandboxed();
		const env = { [PARENT_SESSION_ENV]: "s1" };
		const file = grantsFile(sandbox.agentDir, "s1");
		mkdirSync(join(file, ".."), { recursive: true });
		const snapshot = { version: 1, sessionId: "s1", pid: process.pid, prefixes: [["npm", "test"]], exact: [], edits: true, outsideReads: false, outsideReadDirs: [] };
		const real = join(sandbox.agentDir, "real-snapshot.json");
		writeFileSync(real, JSON.stringify(snapshot));
		symlinkSync(real, file);
		assert.equal(readParentGrants(sandbox.agentDir, env), undefined, "symlink");
		rmSync(file);
		let fifo = true;
		try {
			execFileSync("mkfifo", [file]);
		} catch {
			fifo = false;
			t.diagnostic("mkfifo unavailable, FIFO case skipped");
		}
		if (fifo) {
			assert.equal(readParentGrants(sandbox.agentDir, env), undefined, "fifo");
			rmSync(file);
		}
		writeFileSync(file, JSON.stringify(snapshot));
		assert.deepEqual(readParentGrants(sandbox.agentDir, env)?.prefixes, [["npm", "test"]], "regular file");
	});
});
