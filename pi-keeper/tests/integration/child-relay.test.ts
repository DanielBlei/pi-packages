/**
 * pi-subagents children relay their permission asks to the parent's UI: a
 * child has no UI of its own, so the parent publishes a UI relay
 * (extensions/ui-relay.ts) and the child's dialogs — the same permission
 * dialog the parent shows for its own calls — appear in the parent's
 * terminal. Answers apply session-wide; without a relay the ask is denied.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KEY, makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { findUiRelay, registerUiRelay, RELAY_KEY, type UiRelay } from "../../extensions/ui-relay.ts";

after(() => restoreBell());

const TMPDIR = process.env.TMPDIR;
const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(): Sandbox {
	// startPi points TMPDIR into the previous sandbox; put it back so this one can be created
	if (TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = TMPDIR;
	const sandbox = makeSandbox();
	created.push(sandbox);
	return sandbox;
}

// the relay registry is process-global: leave it as found
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

/** A parent with a TUI (registers the relay) plus a child without one. */
async function parentAndChild(childEntry: "child-default" | "child-plan" | "child-auto" = "child-default"): Promise<{ parent: Harness; child: Harness }> {
	const sandbox = sandboxed();
	const parent = await startPi({ sandbox });
	await parent.session();
	const child = await startPi({ sandbox, entry: childEntry });
	await child.session();
	return { parent, child };
}

const SUB = /Permission required \(subagent, default mode\)/;
const SUB_PLAN = /Permission required \(subagent, plan mode\)/;
const SUB_AUTO = /Permission required \(subagent, auto mode\)/;
const PERMISSION_ANY = /Permission required/;
const ALLOW_ONCE = "Yes";
const EDITS = "Yes, allow all edits this session";
const AUTO = "Yes, and switch to auto mode";

describe("dialogs never overlap in the parent's UI", () => {
	it("a parent ask and a relayed child ask at once open one after the other; each gets its own answer", async () => {
		const { parent, child } = await parentAndChild();
		// each dialog stays open a while after its answer, so an unserialized second one would overlap it
		parent.dialogHoldMs = 20;
		parent.answer(/Permission required \(default mode\)/, ALLOW_ONCE);
		parent.answer(SUB, "esc");
		const own = parent.tool("edit", { path: "src/own.ts", oldText: "a", newText: "b" });
		const relayed = child.tool("edit", { path: "src/child.ts", oldText: "a", newText: "b" });
		const [ownOutcome, relayedOutcome] = await Promise.all([own, relayed]);
		assert.equal(ownOutcome.blocked, false);
		assert.equal(relayedOutcome.blocked, true);
		assert.equal(parent.dialogs.length, 2);
		assert.equal(parent.maxOpenDialogs, 1);
		assert.equal(parent.openDialogs, 0);
		parent.assertNoPendingAnswers();
	});

	it("/mode typed while a relayed ask is on screen waits for it, and says so", async () => {
		const { parent, child } = await parentAndChild();
		parent.dialogHoldMs = 20;
		parent.answer(SUB, ALLOW_ONCE);
		parent.answer(/Current mode/, "esc");
		const relayed = child.tool("edit", { path: "src/child.ts", oldText: "a", newText: "b" });
		// the child's dialog is on screen (holding the lock) before the command runs
		while (parent.openDialogs === 0) await new Promise((resolve) => setImmediate(resolve));
		const typed = parent.command("mode");
		const [outcome] = await Promise.all([relayed, typed]);
		assert.equal(outcome.blocked, false);
		assert.equal(parent.dialogs.length, 2);
		assert.match(parent.dialogs[1].title, /Current mode/);
		assert.equal(parent.maxOpenDialogs, 1);
		assert.ok(parent.notifications.some((n) => /approval is waiting/.test(n.message)));
		parent.assertNoPendingAnswers();
	});

	it("two children's asks at once open one after the other", async () => {
		const sandbox = sandboxed();
		const parent = await startPi({ sandbox });
		await parent.session();
		const first = await startPi({ sandbox, entry: "child-default" });
		await first.session();
		const second = await startPi({ sandbox, entry: "child-default" });
		await second.session();
		parent.dialogHoldMs = 20;
		parent.answer(/src\/one\.ts/, ALLOW_ONCE);
		parent.answer(/src\/two\.ts/, "esc");
		const [one, two] = await Promise.all([
			first.tool("edit", { path: "src/one.ts", oldText: "a", newText: "b" }),
			second.tool("edit", { path: "src/two.ts", oldText: "a", newText: "b" }),
		]);
		assert.equal(one.blocked, false);
		assert.equal(two.blocked, true);
		assert.equal(parent.maxOpenDialogs, 1);
		parent.assertNoPendingAnswers();
	});

	it("a queued read of a directory granted for the session by the first answer is not asked again", async () => {
		const sandbox = sandboxed();
		const outside = realpathSync(mkdtempSync(join(sandbox.root, "outside-")));
		writeFileSync(join(outside, "notes.md"), "x");
		const file = join(outside, "notes.md");
		const parent = await startPi({ sandbox });
		await parent.session();
		const first = await startPi({ sandbox, entry: "child-default" });
		await first.session();
		const second = await startPi({ sandbox, entry: "child-default" });
		await second.session();
		// only the first dialog is scripted: a second one would throw (no queued answer) and block the read
		parent.dialogHoldMs = 20;
		parent.answer(PERMISSION_ANY, `Yes, and allow reading from ${outside}/ this session`);
		const [one, two] = await Promise.all([first.tool("read", { path: file }), second.tool("read", { path: file })]);
		assert.equal(one.blocked, false);
		assert.equal(two.blocked, false);
		assert.equal(parent.dialogs.length, 1);
		assert.equal(parent.maxOpenDialogs, 1);
		parent.assertNoPendingAnswers();
	});

	it("a queued read after a one-time \"Yes\" still gets its own dialog", async () => {
		const sandbox = sandboxed();
		const outside = realpathSync(mkdtempSync(join(sandbox.root, "outside-")));
		writeFileSync(join(outside, "notes.md"), "x");
		const file = join(outside, "notes.md");
		const parent = await startPi({ sandbox });
		await parent.session();
		const first = await startPi({ sandbox, entry: "child-default" });
		await first.session();
		const second = await startPi({ sandbox, entry: "child-default" });
		await second.session();
		parent.dialogHoldMs = 20;
		parent.answer(PERMISSION_ANY, ALLOW_ONCE);
		parent.answer(PERMISSION_ANY, ALLOW_ONCE);
		const [one, two] = await Promise.all([first.tool("read", { path: file }), second.tool("read", { path: file })]);
		assert.equal(one.blocked, false);
		assert.equal(two.blocked, false);
		assert.equal(parent.dialogs.length, 2);
		assert.equal(parent.maxOpenDialogs, 1);
		parent.assertNoPendingAnswers();
	});
});

describe("a child's ask is relayed to the parent's UI", () => {
	it("an edit ask opens the parent's dialog; Yes allows the child's call", async () => {
		const { parent, child } = await parentAndChild();
		parent.answer(SUB, ALLOW_ONCE);
		const outcome = await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(outcome.blocked, false);
		// the dialog opened in the parent, not the child
		assert.equal(child.dialogs.length, 0);
		assert.equal(parent.dialogs.length, 1);
		assert.match(parent.dialogs[0].title, /Permission required \(subagent, default mode\)/);
		assert.match(parent.dialogs[0].title, /edit src\/a\.ts/);
		assert.ok(parent.dialogs[0].options.includes(EDITS));
		// the parent's terminal was alerted and its working row showed the wait
		assert.ok(parent.bells() >= 1);
		assert.ok(parent.workingMessages.includes("Waiting for approval…"));
		assert.equal(parent.workingMessages.at(-1), undefined);
		parent.assertNoPendingAnswers();
	});

	it("a bash ask relays without a preview and offers the session option", async () => {
		const { parent, child } = await parentAndChild();
		parent.answer(SUB, /^Yes, and don't ask again for `npm test` this session/);
		const outcome = await child.tool("bash", { command: "npm test" });
		assert.equal(outcome.blocked, false);
		assert.equal(parent.dialogs.length, 1);
		assert.equal(parent.dialogs[0].kind, "custom");
		assert.ok(parent.dialogs[0].options.some((o) => /^Yes, and don't ask again for `npm test` this session/.test(o)));
		assert.ok(parent.dialogs[0].options.some((o) => /^Yes, and always allow `npm test` in this project/.test(o)));
		parent.assertNoPendingAnswers();
	});

	it("a child dialog never offers switching to auto mode", async () => {
		const { parent, child } = await parentAndChild();
		// open More… (the secondary list), then Esc back, then Esc to reject
		parent.answer(SUB, "More…");
		parent.answer(SUB, "esc");
		parent.answer(SUB, "esc");
		const outcome = await child.tool("bash", { command: "npm test" });
		assert.equal(outcome.blocked, true);
		for (const dialog of parent.dialogs) {
			assert.equal(dialog.options.includes(AUTO), false, JSON.stringify(dialog.options));
		}
		parent.assertNoPendingAnswers();
	});

	it("the mode shortcut in a relayed dialog cycles the parent's mode; the child's ask is unaffected", async () => {
		const { parent, child } = await parentAndChild();
		parent.answer(SUB, { keys: [KEY.altM, KEY.enter] });
		const outcome = await child.tool("bash", { command: "npm test" });
		assert.equal(outcome.blocked, false, `the child's ask was still answered: ${outcome.reason ?? ""}`);
		assert.ok(parent.statuses.some((s) => s !== undefined && /auto/.test(s)), "the parent's mode cycled");
		assert.equal(parent.dialogs.length, 1, "one dialog, answered after the shortcut");
		parent.assertNoPendingAnswers();
	});

	it("Reject with feedback blocks the child with the user's words", async () => {
		const { parent, child } = await parentAndChild();
		parent.answer(SUB, "No, and tell pi what to do instead");
		parent.answer(/What should pi do instead/, { input: "use pnpm instead" });
		const outcome = await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(outcome.blocked, true);
		assert.match(outcome.reason ?? "", /use pnpm instead/);
		parent.assertNoPendingAnswers();
	});

	it("Esc rejects; later asks in the same run are rejected without a dialog", async () => {
		const { parent, child } = await parentAndChild();
		parent.answer(SUB, "esc");
		const first = await child.tool("bash", { command: "npm test" });
		assert.equal(first.blocked, true);
		assert.match(first.reason ?? "", /The user rejected/);
		// no new dialog for the queued call
		const second = await child.tool("bash", { command: "npm run build" });
		assert.equal(second.blocked, true);
		assert.match(second.reason ?? "", /The user rejected/);
		assert.equal(parent.dialogs.length, 1);
		parent.assertNoPendingAnswers();
	});

	it("Allow all edits this session in a child covers the parent too", async () => {
		const { parent, child } = await parentAndChild();
		parent.answer(SUB, EDITS);
		assert.equal((await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" })).blocked, false);
		// the parent's status shows the edits flag, and its own edit runs unasked
		assert.ok(parent.statuses.some((s) => s !== undefined && /edits/.test(s)));
		assert.equal((await parent.tool("edit", { path: "src/b.ts", oldText: "x", newText: "y" })).blocked, false);
		assert.equal(parent.dialogs.length, 1);
		parent.assertNoPendingAnswers();
	});

	it("with the project-exact-commands setting on, a child's exact-command ask offers the project option and saves to the child's project", async () => {
		const sandbox = sandboxed();
		writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), '{"projectExactCommands": true}');
		const parent = await startPi({ sandbox });
		await parent.session();
		const child = await startPi({ sandbox, entry: "child-default" });
		await child.session();
		// the relayed dialog offers the project option; the session-exact one stays parent-only
		parent.answer(SUB, "Yes, and always allow this exact command in this project");
		const outcome = await child.tool("bash", { command: "python3 x.py" });
		assert.equal(outcome.blocked, false);
		assert.equal(parent.dialogs.length, 1);
		assert.ok(!parent.dialogs[0].options.includes("Yes, and don't ask again for this exact command this session"));
		assert.ok(parent.dialogs[0].options.includes("Yes, and always allow this exact command in this project"));
		const saved = readFileSync(join(sandbox.cwd, ".pi", "settings.local.json"), "utf8");
		assert.match(saved, /Bash\(python3 x\.py\)/);
		// a restarted child in the same project loads the rule silently
		const next = await startPi({ sandbox, entry: "child-default" });
		await next.session();
		assert.equal((await next.tool("bash", { command: "python3 x.py" })).blocked, false);
		assert.deepEqual(next.dialogs, []);
		parent.assertNoPendingAnswers();
	});
});

describe("answers apply to the whole pi session", () => {
	it('"Allow for this session" from a child covers the child and the parent', async () => {
		const { parent, child } = await parentAndChild();
		parent.answer(SUB, /^Yes, and don't ask again for `npm test` this session/);
		assert.equal((await child.tool("bash", { command: "npm test" })).blocked, false);
		// the child doesn't ask again
		assert.equal((await child.tool("bash", { command: "npm test" })).blocked, false);
		// and neither does the parent: the session list is shared
		assert.equal((await parent.tool("bash", { command: "npm test" })).blocked, false);
		assert.equal(parent.dialogs.length, 1);
		// the notification landed in the parent's UI, not the child's
		assert.ok(parent.notifications.some((n) => /Allowed for this session/.test(n.message)));
		assert.equal(child.notifications.length, 0);
		parent.assertNoPendingAnswers();
	});

	it("the parent's exact-command (verbatim) grant is never seen by a foreground child: the same command still asks there", async () => {
		const { parent, child } = await parentAndChild();
		parent.answer(/Permission required \(default mode\)/, "Yes, and don't ask again for this exact command this session");
		assert.equal((await parent.tool("bash", { command: "python3 x.py" })).blocked, false);
		assert.equal((await parent.tool("bash", { command: "python3 x.py" })).blocked, false, "the parent itself is covered");
		assert.equal(parent.dialogs.length, 1);
		parent.answer(SUB, "esc");
		const outcome = await child.tool("bash", { command: "python3 x.py" });
		assert.equal(outcome.blocked, true);
		assert.equal(parent.dialogs.length, 2, "the child's ask reached the parent's user");
		parent.assertNoPendingAnswers();
	});

	it("a session prefix remembered by the parent covers a later child", async () => {
		const { parent, child } = await parentAndChild();
		// the parent remembers the command for its own ask
		parent.answer(/Permission required \(default mode\)/, /^Yes, and don't ask again for `npm test` this session/);
		assert.equal((await parent.tool("bash", { command: "npm test" })).blocked, false);
		// a fresh child of the same parent sees the shared session list
		const second = await startPi({ sandbox: parent.sandbox, entry: "child-default" });
		await second.session();
		assert.equal((await second.tool("bash", { command: "npm test" })).blocked, false);
		assert.equal(second.dialogs.length, 0);
		parent.assertNoPendingAnswers();
	});
});

describe("a plan-mode child relays its context-gathering asks", () => {
	it("non-read-only bash asks in the parent with the plan options; dangerous bash is still denied outright", async () => {
		const { parent, child } = await parentAndChild("child-plan");
		parent.answer(SUB_PLAN, ALLOW_ONCE);
		assert.equal((await child.tool("bash", { command: "npm test" })).blocked, false);
		assert.equal(parent.dialogs.length, 1);
		assert.ok(parent.dialogs[0].options.some((o) => /^Yes, and don't ask again for `npm test` this session/.test(o)));
		assert.equal(parent.dialogs[0].options.some((o) => /^Yes, and always allow `npm test` in this project/.test(o)), false);
		// dangerous commands never get a dialog in plan mode
		const dangerous = await child.tool("bash", { command: "git push" });
		assert.equal(dangerous.blocked, true);
		assert.match(dangerous.reason ?? "", /dangerous command|plan mode/);
		assert.equal(parent.dialogs.length, 1);
		parent.assertNoPendingAnswers();
	});
});

describe("an auto-mode child (the /keeper setting) runs auto while its asks relay", () => {
	it("edits inside the project, deletes and read-only bash run without a dialog anywhere", async () => {
		const { parent, child } = await parentAndChild("child-auto");
		assert.equal((await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" })).blocked, false);
		assert.equal((await child.tool("bash", { command: "rm src/old.ts" })).blocked, false);
		assert.equal((await child.tool("bash", { command: "git status" })).blocked, false);
		assert.deepEqual(parent.dialogs, []);
		assert.deepEqual(child.dialogs, []);
		parent.assertNoPendingAnswers();
	});

	it("a dangerous command still asks, relayed to the parent, and Yes runs it", async () => {
		const { parent, child } = await parentAndChild("child-auto");
		parent.answer(SUB_AUTO, ALLOW_ONCE);
		const outcome = await child.tool("bash", { command: "git push" });
		assert.equal(outcome.blocked, false);
		assert.equal(parent.dialogs.length, 1);
		assert.match(parent.dialogs[0].title, /Permission required \(subagent, auto mode\)/);
		assert.equal(child.dialogs.length, 0);
		parent.assertNoPendingAnswers();
	});

	it("uses the child-auto prompt and cannot switch modes", async () => {
		const { parent, child } = await parentAndChild("child-auto");
		const { systemPrompt } = await child.prompt("go");
		assert.match(systemPrompt, /Subagent under auto mode/);
		await child.command("mode", "plan");
		assert.ok(child.notifications.some((n) => /Subagent children stay in auto mode/.test(n.message)));
		// still auto: an edit runs unasked
		assert.equal((await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" })).blocked, false);
	});

	it("without a relay the child-auto entry falls back to default mode", async () => {
		const sandbox = sandboxed();
		// pin the setting off: with it on, a relay-less child-auto would run auto
		writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), '{"backgroundAutoFallback": false}');
		// no parent with a UI: no relay is published, so child-auto loads as default
		const child = await startPi({ sandbox, entry: "child-auto" });
		await child.session();
		const edit = await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(edit.blocked, true);
		assert.match(edit.reason ?? "", /is denied: you are a default child with no relay, and every mutation is denied for every path/);
		assert.match(edit.reason ?? "", /do not retry it or probe another tool or path/);
		const composed = (await child.prompt("go")).systemPrompt;
		assert.match(composed, /# Subagent permissions/);
		assert.match(composed, /Your lane: default child with no relay\./);
	});
});

describe("a relay-less child runs auto with the background-auto-fallback setting", () => {
	it("child-default with the setting on: edits and safe bash run unasked, dangerous commands still deny", async () => {
		const sandbox = sandboxed();
		writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), '{"backgroundAutoFallback": true}');
		// no parent with a UI: no relay is published
		const child = await startPi({ sandbox, entry: "child-default" });
		await child.session();
		assert.equal((await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" })).blocked, false);
		assert.equal((await child.tool("bash", { command: "git status" })).blocked, false);
		const dangerous = await child.tool("bash", { command: "git push" });
		assert.equal(dangerous.blocked, true);
		assert.match(dangerous.reason ?? "", /is denied: you are an auto child with no relay/);
		assert.match(dangerous.reason ?? "", /fail-closed/);
		const composed = (await child.prompt("go")).systemPrompt;
		assert.match(composed, /# Subagent under auto mode/);
		assert.match(composed, /Your lane: auto child with no relay\./);
		assert.deepEqual(child.dialogs, []);
	});

	it("child-auto with the setting on stays auto without a relay", async () => {
		const sandbox = sandboxed();
		writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), '{"backgroundAutoFallback": true}');
		const child = await startPi({ sandbox, entry: "child-auto" });
		await child.session();
		assert.equal((await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" })).blocked, false);
		assert.match((await child.prompt("go")).systemPrompt, /# Subagent under auto mode/);
	});

	it("with the setting off child-default stays default and denies (pinned)", async () => {
		const sandbox = sandboxed();
		writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), '{"backgroundAutoFallback": false}');
		const child = await startPi({ sandbox, entry: "child-default" });
		await child.session();
		const edit = await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(edit.blocked, true);
		assert.match(edit.reason ?? "", /is denied: you are a default child with no relay, and every mutation is denied for every path/);
		const composed = (await child.prompt("go")).systemPrompt;
		assert.match(composed, /# Subagent permissions/);
		assert.match(composed, /Your lane: default child with no relay\./);
	});

	it("a foreground child with a relay is unaffected: default-mode asks still relay", async () => {
		const sandbox = sandboxed();
		writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), '{"backgroundAutoFallback": true}');
		const parent = await startPi({ sandbox });
		await parent.session();
		const child = await startPi({ sandbox, entry: "child-default" });
		await child.session();
		parent.answer(SUB, ALLOW_ONCE);
		const outcome = await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(outcome.blocked, false);
		assert.equal(parent.dialogs.length, 1);
		assert.match(parent.dialogs[0].title, /Permission required \(subagent, default mode\)/);
		parent.assertNoPendingAnswers();
	});
});

describe("fail closed", () => {
	it("without a relay the ask is denied with the no-user message and no dialog", async () => {
		const { parent, child } = await parentAndChild();
		delete root[RELAY_KEY];
		const outcome = await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(outcome.blocked, true);
		assert.match(outcome.reason ?? "", /is denied: you are a default child with no relay, and every mutation is denied for every path/);
		assert.deepEqual(parent.dialogs, []);
		assert.deepEqual(child.dialogs, []);
	});

	it("a relay that fails rejects the child's call instead of running it", async () => {
		const { parent, child } = await parentAndChild();
		const broken = registerUiRelay({
			...findUiRelay(),
			select: () => Promise.reject(new Error("dead parent")),
		} as UiRelay);
		assert.ok(broken);
		const outcome = await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(outcome.blocked, true);
		assert.match(outcome.reason ?? "", /The user rejected/);
		broken.dispose();
	});

	it("the relay's read grants are re-checked: no /, home, ancestors or missing paths; realpath stored", async () => {
		await parentAndChild();
		const relay = findUiRelay();
		assert.ok(relay?.grantReadDirs !== undefined);
		const base = mkdtempSync(join(tmpdir(), "grant-"));
		try {
			const real = join(base, "real");
			mkdirSync(real);
			const link = join(base, "link");
			symlinkSync(real, link);
			relay.grantReadDirs(["/", homedir(), dirname(homedir()), join(base, "missing"), "relative/dir", link]);
			assert.deepEqual(relay.sessionRules().outsideReadDirs, [realpathSync(real)]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("a parent without a UI publishes no relay", async () => {
		const sandbox = sandboxed();
		const parent = await startPi({ sandbox, ui: "none" });
		await parent.session();
		assert.equal(root[RELAY_KEY], undefined);
		assert.equal(findUiRelay(), undefined);
		const child = await startPi({ sandbox, entry: "child-default" });
		await child.session();
		assert.equal((await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" })).blocked, true);
	});

	it("a child never hosts a relay, even with a UI", async () => {
		const sandbox = sandboxed();
		const child = await startPi({ sandbox, entry: "child-default", ui: "tui" });
		await child.session();
		assert.equal(root[RELAY_KEY], undefined);
	});

	it("shutdown removes the parent's relay", async () => {
		const { parent, child } = await parentAndChild();
		await parent.shutdown();
		assert.equal(root[RELAY_KEY], undefined);
		const outcome = await child.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(outcome.blocked, true);
		assert.match(outcome.reason ?? "", /is denied: you are a default child with no relay, and every mutation is denied for every path/);
	});
});
