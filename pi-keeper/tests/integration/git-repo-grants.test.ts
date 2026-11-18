/**
 * Git repo grants: a `cd` into another git repository combined with git can't
 * be remembered as the `cd` prefix (it never lifts the ask), so the dialog
 * offers "Yes, and allow git in <repo>/ this session" instead. While granted,
 * git running in that repo is judged like git in the cwd's repo (read-only
 * runs, git -C too); dangerous git still asks; the grant is session-only.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Sandbox } from "../mocks/pi.ts";
import { findUiRelay, RELAY_KEY } from "../../extensions/ui-relay.ts";

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

/** A git repository at `dir`: an empty `.git` directory is enough to be one. */
function repo(dir: string): string {
	mkdirSync(join(dir, ".git"), { recursive: true });
	mkdirSync(join(dir, "src"), { recursive: true });
	return dir;
}

/**
 * Two repositories outside the session's project (cwd): harbor and third. They sit under the
 * temp dir, which reads outside the cwd never ask about, so the only ask is the git one.
 */
function otherRepos(sb: Sandbox): { harbor: string; third: string } {
	const base = realpathSync(sb.tmp);
	return { harbor: repo(join(base, "harbor")), third: repo(join(base, "third")) };
}

/** The shape the model ran: a cd into another repo, git there, then a non-git tail. */
const shape = (dir: string): string => `cd ${dir} && git log --oneline -5; echo x; find . -maxdepth 2 -type d 2>/dev/null | head`;
const grantLabel = (dir: string): string => `Yes, and allow git in ${dir}/ this session`;
const ASK = /Permission required/;

describe("git in another repository, granted for the session", () => {
	it("the dialog offers the repo grant, and no session option for cd", async () => {
		const sb = sandboxed();
		const { harbor } = otherRepos(sb);
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: shape(harbor) })).blocked, true);
		const options = h.dialogs[0].options;
		assert.ok(options.includes(grantLabel(harbor)), options.join(" | "));
		assert.equal(
			options.some((o) => /don't ask again for `cd`|always allow `cd`/.test(o)),
			false,
			options.join(" | "),
		);
		h.assertNoPendingAnswers();
	});

	it("after the grant, the same command, another read-only git command and git -C run without a dialog", async () => {
		const sb = sandboxed();
		const { harbor } = otherRepos(sb);
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, grantLabel(harbor));
		assert.equal((await h.tool("bash", { command: shape(harbor) })).blocked, false);
		const count = h.dialogs.length;
		assert.equal((await h.tool("bash", { command: `cd ${harbor} && git status` })).blocked, false);
		assert.equal((await h.tool("bash", { command: `git -C ${harbor} log --oneline -3` })).blocked, false);
		assert.equal(h.dialogs.length, count);
		h.assertNoPendingAnswers();
	});

	it("a dangerous git command in the granted repo still asks", async () => {
		const sb = sandboxed();
		const { harbor } = otherRepos(sb);
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, grantLabel(harbor));
		assert.equal((await h.tool("bash", { command: shape(harbor) })).blocked, false);
		const count = h.dialogs.length;
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: `cd ${harbor} && git push origin main` })).blocked, true);
		assert.equal(h.dialogs.length, count + 1);
		h.assertNoPendingAnswers();
	});

	it("a third repository is not covered by the grant for another one", async () => {
		const sb = sandboxed();
		const { harbor, third } = otherRepos(sb);
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, grantLabel(harbor));
		assert.equal((await h.tool("bash", { command: shape(harbor) })).blocked, false);
		const count = h.dialogs.length;
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: `cd ${third} && git log -1` })).blocked, true);
		assert.equal(h.dialogs.length, count + 1);
		const options = h.dialogs[count].options;
		assert.ok(options.includes(grantLabel(third)), options.join(" | "));
		assert.equal(options.includes(grantLabel(harbor)), false);
		h.assertNoPendingAnswers();
	});

	it("/new drops the grant", async () => {
		const sb = sandboxed();
		const { harbor } = otherRepos(sb);
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, grantLabel(harbor));
		assert.equal((await h.tool("bash", { command: shape(harbor) })).blocked, false);
		await h.session("new");
		const count = h.dialogs.length;
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: shape(harbor) })).blocked, true);
		assert.equal(h.dialogs.length, count + 1);
		h.assertNoPendingAnswers();
	});

	it("the home directory is never offered as a git repo grant", async () => {
		const sb = sandboxed();
		const home = repo(join(realpathSync(sb.tmp), "home"));
		const savedHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const h = await startPi({ sandbox: sb });
			await h.session();
			h.answer(ASK, "No");
			assert.equal((await h.tool("bash", { command: shape(home) })).blocked, true);
			const options = h.dialogs[0].options;
			assert.equal(
				options.some((o) => o.startsWith("Yes, and allow git in")),
				false,
				options.join(" | "),
			);
			h.assertNoPendingAnswers();
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
		}
	});

	it("plan mode offers the grant and honours it", async () => {
		const sb = sandboxed();
		const { harbor } = otherRepos(sb);
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "plan");
		h.answer(ASK, grantLabel(harbor));
		assert.equal((await h.tool("bash", { command: shape(harbor) })).blocked, false);
		assert.ok(h.dialogs[0].options.includes(grantLabel(harbor)), h.dialogs[0].options.join(" | "));
		const count = h.dialogs.length;
		assert.equal((await h.tool("bash", { command: `cd ${harbor} && git status` })).blocked, false);
		assert.equal(h.dialogs.length, count);
		h.assertNoPendingAnswers();
	});

	it("auto mode asks only the outside-read question for a repo outside the temp dir, not the git one", async () => {
		// auto's fallback allows a git run in another repo, so the git grant is never offered there; the
		// outside-read rule (a repo outside the temp dir) is what asks, and its own grant is what lifts it
		const sb = sandboxed();
		const outside = repo(join(realpathSync(sb.root), "outside"));
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "auto");
		h.answer(/Reads outside/, `Yes, and allow reading from ${outside}/ this session`);
		assert.equal((await h.tool("bash", { command: shape(outside) })).blocked, false);
		assert.equal(h.dialogs.length, 1);
		assert.equal(
			h.dialogs[0].options.some((o) => o.startsWith("Yes, and allow git in")),
			false,
			h.dialogs[0].options.join(" | "),
		);
		const count = h.dialogs.length;
		assert.equal((await h.tool("bash", { command: `git -C ${outside} log --oneline -3` })).blocked, false);
		assert.equal(h.dialogs.length, count);
		h.assertNoPendingAnswers();
	});

	it("a subagent of the session sees the grant", async () => {
		const sb = sandboxed();
		const { harbor } = otherRepos(sb);
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		await child.session();
		parent.answer(/subagent/, grantLabel(harbor));
		assert.equal((await child.tool("bash", { command: shape(harbor) })).blocked, false);
		const count = parent.dialogs.length;
		assert.equal((await child.tool("bash", { command: `cd ${harbor} && git status` })).blocked, false);
		assert.equal(parent.dialogs.length, count);
		parent.assertNoPendingAnswers();
	});

	it("a git grant chosen in a child's dialog reaches the parent: the parent's next cd and git runs with no dialog", async () => {
		const sb = sandboxed();
		const { harbor } = otherRepos(sb);
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		await child.session();
		parent.answer(/subagent/, grantLabel(harbor));
		assert.equal((await child.tool("bash", { command: shape(harbor) })).blocked, false);
		const count = parent.dialogs.length;
		assert.equal((await parent.tool("bash", { command: shape(harbor) })).blocked, false);
		assert.equal(parent.dialogs.length, count);
		parent.assertNoPendingAnswers();
	});

	it("the relay's git grants are re-checked like read dirs: no /, home, relative or missing paths", async () => {
		const sb = sandboxed();
		const { harbor } = otherRepos(sb);
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		const relay = findUiRelay();
		assert.ok(relay?.grantGitRepos !== undefined);
		relay.grantGitRepos?.(["/", homedir(), "relative/dir", join(realpathSync(sb.tmp), "missing")]);
		assert.deepEqual(relay.sessionRules().gitRepos, []);
		relay.grantGitRepos?.([harbor]);
		assert.deepEqual(relay.sessionRules().gitRepos, [harbor]);
	});

	it("/permissions lists the git repo grant and removes it", async () => {
		const sb = sandboxed();
		const { harbor } = otherRepos(sb);
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, grantLabel(harbor));
		assert.equal((await h.tool("bash", { command: shape(harbor) })).blocked, false);
		const base = h.dialogs.length;
		const entry = `[session] git in ${harbor}/ allowed`;
		h.answer(/Permission rules/, entry);
		h.answer(/git in/, "Remove");
		await h.command("permissions");
		assert.deepEqual(h.dialogs[base].options, [entry]);
		h.assertNoPendingAnswers();
		// removed: the cd asks again
		const before = h.dialogs.length;
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: shape(harbor) })).blocked, true);
		assert.equal(h.dialogs.length, before + 1);
		h.assertNoPendingAnswers();
	});
});
