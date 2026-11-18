/**
 * A subagent child's cwd is chosen by the parent model (`cwd` in the subagent
 * call); `cwd: "/"` made the whole disk "inside the working directory" in a
 * real run. A child checks its cwd against the parent's project and refuses
 * "/" and the home directory; a refused child is locked down: everything is
 * denied except contact_supervisor and its report. See extensions/child-cwd.ts.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { PARENT_SESSION_ENV } from "../../extensions/session-grants.ts";
import { childCwdProblem } from "../../extensions/child-cwd.ts";

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
beforeEach(() => {
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(() => {
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
	if (savedParentEnv === undefined) delete process.env[PARENT_SESSION_ENV];
	else process.env[PARENT_SESSION_ENV] = savedParentEnv;
});

describe("childCwdProblem", () => {
	const base = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "child-cwd-"));
	const home = join(base, "home", "me");
	const repo = join(home, "code", "repo");
	const sub = join(repo, "pkg");
	const sibling = join(home, "code", "other");
	for (const dir of [join(repo, ".git", "worktrees", "wt1"), sub, sibling]) mkdirSync(dir, { recursive: true });
	// a pi-subagents worktree beside the checkout: <repo parent>/worktrees/<project>/pi-worktree-*
	const worktree = join(home, "code", "worktrees", "repo", "pi-worktree-r1-0");
	mkdirSync(join(worktree, "src"), { recursive: true });
	writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt1")}\n`);
	const foreign = join(home, "code", "worktrees", "x", "pi-worktree-r2-0");
	mkdirSync(foreign, { recursive: true });
	writeFileSync(join(foreign, ".git"), `gitdir: ${join(sibling, ".git", "worktrees", "wt9")}\n`);

	it("refuses /, the home dir and its ancestors, even without a parent", () => {
		assert.match(childCwdProblem("/", undefined, home) ?? "", /is \/ or the home directory/);
		assert.match(childCwdProblem(home, undefined, home) ?? "", /home directory/);
		assert.match(childCwdProblem(join(home, ".."), undefined, home) ?? "", /home directory/);
		assert.equal(childCwdProblem(sibling, undefined, home), undefined, "no parent: only the root/home check applies");
	});

	it("fails closed when the env names a parent but its grants (and cwd) cannot be read", () => {
		assert.match(childCwdProblem(sibling, undefined, home, true) ?? "", /the parent session's grants could not be read/);
		assert.match(childCwdProblem(repo, undefined, home, true) ?? "", /the parent session's grants could not be read/);
		assert.match(childCwdProblem("/", undefined, home, true) ?? "", /is \/ or the home directory/, "the root/home refusal keeps its own reason");
	});

	it("accepts the parent's cwd, below it, and the parent's project root", () => {
		assert.equal(childCwdProblem(repo, repo, home), undefined);
		assert.equal(childCwdProblem(sub, repo, home), undefined);
		assert.equal(childCwdProblem(repo, sub, home), undefined, "parent in a subdirectory, child at the repository root");
	});

	it("accepts a linked worktree of the parent's repository, refuses a sibling or another repo's worktree", () => {
		assert.equal(childCwdProblem(worktree, repo, home), undefined);
		assert.equal(childCwdProblem(join(worktree, "src"), sub, home), undefined);
		assert.match(childCwdProblem(sibling, repo, home) ?? "", /outside the parent session's project/);
		assert.match(childCwdProblem(foreign, repo, home) ?? "", /outside the parent session's project/);
	});

	it("a home directory that is itself a git repository (dotfiles) is no project: only the parent's cwd is accepted", () => {
		const dotfiles = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "child-cwd-home-"));
		const home = join(dotfiles, "home");
		const proj = join(home, "proj");
		for (const dir of [join(home, ".git"), join(home, "Documents"), join(proj, "sub")]) mkdirSync(dir, { recursive: true });
		assert.match(childCwdProblem(join(home, "Documents"), proj, home) ?? "", /outside the parent session's project/);
		assert.equal(childCwdProblem(join(proj, "sub"), proj, home), undefined);
	});
});

/** A child harness running in `cwd` (same agent dir and temp as the sandbox). */
async function childIn(sandbox: Sandbox, cwd: string, options: { relay: boolean; parentSession?: string}): Promise<Harness> {
	const relay = root[RELAY_KEY];
	if (!options.relay) delete root[RELAY_KEY];
	if (options.parentSession === undefined) delete process.env[PARENT_SESSION_ENV];
	else process.env[PARENT_SESSION_ENV] = options.parentSession;
	try {
		const child = await startPi({ sandbox: { ...sandbox, cwd }, entry: "child-default" });
		await child.session();
		return child;
	} finally {
		if (relay !== undefined) root[RELAY_KEY] = relay;
	}
}

async function assertLocked(child: Harness, relay: boolean): Promise<void> {
	const lift = async <T>(fn: () => Promise<T>): Promise<T> => {
		const saved = root[RELAY_KEY];
		if (!relay) delete root[RELAY_KEY];
		try {
			return await fn();
		} finally {
			if (saved !== undefined) root[RELAY_KEY] = saved;
		}
	};
	const composed = (await lift(() => child.prompt("go"))).systemPrompt;
	assert.match(composed, /Your lane: locked\./);
	for (const [tool, input] of [
		["bash", { command: "ls" }],
		["read", { path: "etc/hosts" }],
		["edit", { path: "x.ts", oldText: "a", newText: "b" }],
	] as const) {
		const outcome = await lift(() => child.tool(tool, input));
		assert.equal(outcome.blocked, true, `${tool} must be denied`);
		assert.match(outcome.reason ?? "", /you are locked/);
	}
	assert.equal((await lift(() => child.tool("contact_supervisor", { reason: "need_decision", message: "relaunch me" }))).blocked, false);
	// telemetry records the lockdown as the decision, not the rule that would have allowed it
	const decided = child.entries
		.filter((e) => e.customType === "pi-keeper-permission" && (e.data as { phase?: string }).phase === "decide")
		.map((e) => e.data as { tool: string; action: string; matcher: string | null });
	assert.deepEqual(decided.filter((d) => d.tool !== "contact_supervisor").map((d) => `${d.action}/${d.matcher}`), ["deny/childCwdLocked", "deny/childCwdLocked", "deny/childCwdLocked"]);
	assert.equal(child.dialogs.length, 0);
}

describe("a child launched outside its parent's project is locked down", () => {
	it("foreground child at / (parent's cwd from the relay)", async () => {
		const sandbox = sandboxed();
		const parent = await startPi({ sandbox });
		await parent.session();
		await assertLocked(await childIn(sandbox, "/", { relay: true }), true);
		assert.equal(parent.dialogs.length, 0, "no dialog reached the parent");
	});

	it("background child in a sibling directory (parent's cwd from the grant snapshot)", async () => {
		const sandbox = sandboxed();
		const parent = await startPi({ sandbox });
		await parent.session();
		const sibling = mkdtempSync(join(sandbox.root, "sibling-"));
		await assertLocked(await childIn(sandbox, sibling, { relay: false, parentSession: parent.sessionId }), false);
	});

	it("background child at the home dir with no parent information", async () => {
		await assertLocked(await childIn(sandboxed(), homedir(), { relay: false }), false);
	});

	it("an auto background child whose parent env names a session with no readable snapshot is locked (fail closed)", async () => {
		const sandbox = sandboxed();
		const sibling = mkdtempSync(join(sandbox.root, "orphan-"));
		// backgroundAutoFallback: a child whose asks cannot reach the parent runs in auto, where nothing else gates it
		writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), '{"backgroundAutoFallback": true}');
		await assertLocked(await childIn(sandbox, sibling, { relay: false, parentSession: "no-such-parent-session" }), false);
	});

	it("a default background child with an unreadable parent snapshot is not locked: its asks are denied anyway", async () => {
		const sandbox = sandboxed();
		const sibling = mkdtempSync(join(sandbox.root, "nested-"));
		const child = await childIn(sandbox, sibling, { relay: false, parentSession: "no-such-parent-session" });
		assert.doesNotMatch((await child.prompt("go")).systemPrompt, /Your lane: locked/);
	});

	it("background child with no parent env and no snapshot keeps the root/home-only check", async () => {
		const sandbox = sandboxed();
		const sibling = mkdtempSync(join(sandbox.root, "plain-"));
		const child = await childIn(sandbox, sibling, { relay: false });
		assert.doesNotMatch((await child.prompt("go")).systemPrompt, /Your lane: locked/);
	});

	it("a child inside the parent's project is not locked", async () => {
		const sandbox = sandboxed();
		const parent = await startPi({ sandbox });
		await parent.session();
		const sub = join(sandbox.cwd, "pkg");
		mkdirSync(sub, { recursive: true });
		const child = await childIn(sandbox, sub, { relay: true });
		assert.doesNotMatch((await child.prompt("go")).systemPrompt, /Your lane: locked/);
		assert.equal((await child.tool("bash", { command: "ls" })).blocked, false);
	});
});
