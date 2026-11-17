/**
 * Permission asks from background subagents are answered in the parent. A
 * background child runs in a separate runner process with no UI, so it files
 * its ask in the session's mailbox (extensions/ask-mailbox.ts); the parent's ask
 * server (extensions/ask-server.ts, wired in index.ts) re-decides it with its
 * own rules and grants and, if it still needs the user, shows the same dialog
 * an in-process child's relayed ask shows. These tests play the child by
 * writing requests straight into the mailbox and step the server's timer by hand.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { HEARTBEAT_STALE_MS, writeHeartbeat } from "../../extensions/ask-heartbeat.ts";
import { askDirFor, newAskId, newNonce, readReply, writeCancel, writeRequest, type AskReply, type AskRequest } from "../../extensions/ask-mailbox.ts";
import { PARENT_SESSION_ENV, readParentGrants } from "../../extensions/session-grants.ts";
import { BACKGROUND_ASKS_ENV } from "../../extensions/config.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { TELEMETRY_ENTRY } from "../../extensions/telemetry.ts";

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
const savedEnv = { parent: process.env[PARENT_SESSION_ENV], kill: process.env[BACKGROUND_ASKS_ENV] };
const started: Harness[] = [];
beforeEach(() => {
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(async () => {
	// ends every ask server, so no dialog stays open holding the one dialog slot for the next test
	for (const harness of started.splice(0)) await harness.shutdown();
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
	if (savedEnv.parent === undefined) delete process.env[PARENT_SESSION_ENV];
	else process.env[PARENT_SESSION_ENV] = savedEnv.parent;
	if (savedEnv.kill === undefined) delete process.env[BACKGROUND_ASKS_ENV];
	else process.env[BACKGROUND_ASKS_ENV] = savedEnv.kill;
});

async function parentOf(sandbox: Sandbox, config?: Record<string, unknown>, ui: "tui" | "none" = "tui"): Promise<Harness> {
	if (config !== undefined) writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), JSON.stringify(config));
	const parent = await startPi({ sandbox, ui });
	started.push(parent);
	await parent.session();
	return parent;
}

const mailbox = (sandbox: Sandbox, parent: Harness): string => askDirFor(sandbox.agentDir, parent.sessionId);

/** What a background child files: an ask for `call`, in the project unless said otherwise. */
function file(sandbox: Sandbox, parent: Harness, over: Partial<AskRequest> = {}): AskRequest {
	const request: AskRequest = {
		v: 1,
		id: newAskId(),
		nonce: newNonce(),
		childPid: process.pid,
		childLabel: "scout",
		childMode: "default",
		cwd: sandbox.cwd,
		call: { toolName: "bash", input: { command: "npm test" } },
		...over,
	};
	writeRequest(mailbox(sandbox, parent), request);
	return request;
}

const replyTo = (sandbox: Sandbox, parent: Harness, request: AskRequest): AskReply | undefined => readReply(mailbox(sandbox, parent), request.id, request.nonce);
const outcomeOf = (sandbox: Sandbox, parent: Harness, request: AskRequest): string | undefined => {
	const reply = replyTo(sandbox, parent, request);
	return reply === undefined ? undefined : reply.reason === undefined ? reply.decision : `${reply.decision}/${reply.reason}`;
};

/** Waits for what the server does asynchronously (previews, dialogs) until `done`. */
async function until(done: () => boolean, what = "the condition"): Promise<void> {
	for (let i = 0; i < 1200; i++) {
		if (done()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`timed out waiting for ${what}`);
}

/** Lets the server finish whatever it will do on its own (nothing is expected to open). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

/** The permission log entries (data) of a harness. */
const telemetry = (parent: Harness): Array<Record<string, unknown>> =>
	parent.entries.filter((e) => e.type === "custom" && e.customType === TELEMETRY_ENTRY).map((e) => e.data as Record<string, unknown>);
const outcomes = (parent: Harness): unknown[] => telemetry(parent).filter((d) => d.phase === "choice").map((d) => d.outcome);

const BG = /Background subagent scout: Permission required \(subagent, default mode\)/;
const ALLOW_ONCE = "Yes";
const SESSION_NPM = /^Yes, and don't ask again for `npm test` this session/;
const PROJECT_NPM = /^Yes, and always allow `npm test` in this project/;
const EDITS = "Yes, allow all edits this session, for the parent and its subagents";
const FEEDBACK = "No, and tell pi what to do instead";
const MORE = "More…";
const edit = (path: string): AskRequest["call"] => ({ toolName: "edit", input: { path, edits: [{ oldText: "one", newText: "two" }] } });

describe("an ask is shown to the user in the parent", () => {
	it("opens a dialog titled with the child's label and the call; Yes replies allow", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(BG, ALLOW_ONCE);
		parent.clearBells();
		const request = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
		assert.equal(parent.dialogs.length, 1);
		assert.match(parent.dialogs[0].title, BG);
		assert.match(parent.dialogs[0].title, /bash: npm test/);
		assert.ok(parent.bells() >= 1);
		parent.assertNoPendingAnswers();
		const logged = telemetry(parent).find((d) => d.phase === "choice");
		assert.equal(logged?.outcome, "remote-allowed");
		assert.equal(logged?.via, "background");
		assert.equal(typeof logged?.waitMs, "number");
	});

	it("a label with non-ASCII text is shown as it is", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(/Background subagent/, "esc");
		// the mailbox already rejects control characters in a label; the title sanitizes again regardless
		file(sandbox, parent, { childLabel: "scout ☃" });
		parent.pollAsks();
		await until(() => parent.dialogs.length === 1, "the dialog");
		assert.match(parent.dialogs[0].title, /Background subagent scout ☃: Permission required/);
	});

	it("Esc replies deny with reason user for that call only; the parent's own next ask is unaffected", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(BG, "esc");
		const request = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "deny/user");
		assert.ok(outcomes(parent).includes("remote-denied"));
		// "No" in a run of the parent's own would reject its later asks without a dialog (rejectedThisRun); this one must not
		parent.answer(/Permission required \(default mode\)/, ALLOW_ONCE);
		const own = await parent.tool("edit", { path: "src/own.ts", edits: [{ oldText: "a", newText: "b" }] });
		assert.equal(own.blocked, false);
		assert.ok(!outcomes(parent).includes("auto-reject"));
		parent.assertNoPendingAnswers();
	});

	it("offers what an in-process child's relayed ask offers (no feedback option: the reply cannot carry text)", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await startPi({ sandbox, entry: "child-default" });
		started.push(child);
		await child.session();
		for (const call of [{ toolName: "bash", input: { command: "npm test" } }, edit("src/a.ts")]) {
			parent.dialogs.length = 0;
			await child.prompt("go"); // a new run: the child's earlier No no longer rejects its asks unseen
			parent.answer(/Permission required \(subagent/, "esc");
			await child.tool(call.toolName, call.input);
			parent.answer(BG, "esc");
			const request = file(sandbox, parent, { call });
			parent.pollAsks();
			await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
			const [relayed, background] = parent.dialogs.map((d) => d.options);
			// the feedback option is dropped; with it gone the dialog may have nothing left behind "More…"
			const expected = relayed.filter((o) => o !== FEEDBACK && o !== MORE).map((o) => (o === "Yes, allow all edits this session" ? EDITS : o));
			assert.deepEqual(background.filter((o) => o !== "Allow a different command pattern…"), expected.filter((o) => o !== "Allow a different command pattern…"));
			assert.ok(!background.includes(FEEDBACK));
			assert.equal(parent.dialogs[1].title.replace(BG, "").trim().split("\n")[0], parent.dialogs[0].title.replace(/Permission required \(subagent, default mode\)/, "").trim().split("\n")[0]);
		}
	});
});

describe("an answer to a child's ask can last for the session", () => {
	it("the session prefix grant answered for a child also covers the child's next identical ask", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(BG, SESSION_NPM);
		const first = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, first) !== undefined, "the first reply");
		assert.equal(outcomeOf(sandbox, parent, first), "allow");
		assert.equal(parent.dialogs.length, 1);
		// the same ask again: the parent's own grant covers it, so no dialog
		const second = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, second) !== undefined, "the second reply");
		assert.equal(outcomeOf(sandbox, parent, second), "allow");
		assert.equal(parent.dialogs.length, 1, "no second dialog");
		assert.ok(outcomes(parent).includes("remote-auto-allow"));
	});

	it("the shared exact-command grant answered for a child lasts too, and is published to background children", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		// no prefix exists for an interpreter, and its tokens can be written as one exact rule
		const call = { toolName: "bash", input: { command: "python3 x.py" } };
		parent.answer(BG, /^Yes, and don't ask again for this exact command this session, for me and my subagents$/);
		const first = file(sandbox, parent, { call });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, first) !== undefined, "the first reply");
		assert.equal(outcomeOf(sandbox, parent, first), "allow");
		const published = readParentGrants(sandbox.agentDir, { [PARENT_SESSION_ENV]: parent.sessionId });
		assert.deepEqual(published?.exact, [["python3", "x.py"]], "the exact command is in the list a background child reads");
		const second = file(sandbox, parent, { call });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, second) !== undefined, "the second reply");
		assert.equal(outcomeOf(sandbox, parent, second), "allow");
		assert.equal(parent.dialogs.length, 1, "no second dialog");
	});
});

describe("what the rules settle needs no dialog", () => {
	it("a call covered by a session grant is allowed", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(/Permission required/, SESSION_NPM);
		assert.equal((await parent.tool("bash", { command: "npm test" })).blocked, false);
		const request = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
		assert.equal(parent.dialogs.length, 1, "only the parent's own");
		assert.ok(outcomes(parent).includes("remote-auto-allow"));
	});

	it("a call covered by a project grant is allowed", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(/Permission required/, PROJECT_NPM);
		assert.equal((await parent.tool("bash", { command: "npm test" })).blocked, false);
		const request = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
		assert.equal(parent.dialogs.length, 1);
	});

	it("a denied call replies deny with reason rules", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const sudo = file(sandbox, parent, { call: { toolName: "bash", input: { command: "sudo rm -rf /var/x" } } });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, sudo) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, sudo), "deny/rules");
		assert.equal(parent.dialogs.length, 0);
		assert.ok(outcomes(parent).includes("remote-auto-deny"));
	});

	it("a read-only call is allowed", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const request = file(sandbox, parent, { call: { toolName: "bash", input: { command: "git status" } } });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
		assert.equal(parent.dialogs.length, 0);
	});
});

describe("a lasting answer applies to the parent session", () => {
	it("\"don't ask again for <prefix>\" grants on the parent, republishes the snapshot, and an identical queued request needs no second dialog", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(BG, SESSION_NPM);
		const first = file(sandbox, parent);
		const second = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, first) !== undefined && replyTo(sandbox, parent, second) !== undefined, "both replies");
		assert.equal(outcomeOf(sandbox, parent, first), "allow");
		assert.equal(outcomeOf(sandbox, parent, second), "allow");
		assert.equal(parent.dialogs.length, 1);
		parent.assertNoPendingAnswers();
		const shared = readParentGrants(sandbox.agentDir, { [PARENT_SESSION_ENV]: parent.sessionId });
		assert.deepEqual(shared?.prefixes, [["npm", "test"]]);
		assert.deepEqual(outcomes(parent).sort(), ["remote-allowed", "remote-auto-allow"]);
		// and the parent's own next call is covered too
		assert.equal((await parent.tool("bash", { command: "npm test" })).blocked, false);
		assert.equal(parent.dialogs.length, 1);
	});

	it("\"allow all edits\" sets the parent's edits flag and publishes it", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(BG, EDITS);
		const first = file(sandbox, parent, { call: edit("src/a.ts") });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, first) !== undefined, "the reply");
		assert.equal(readParentGrants(sandbox.agentDir, { [PARENT_SESSION_ENV]: parent.sessionId })?.edits, true);
		// the parent's own edit is covered now, and so is the next background one
		assert.equal((await parent.tool("edit", edit("src/own.ts").input)).blocked, false);
		const second = file(sandbox, parent, { call: edit("src/b.ts") });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, second) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, second), "allow");
		assert.equal(parent.dialogs.length, 1);
	});

	it("an outside-read directory grant lands in the parent's grants", async () => {
		const sandbox = sandboxed();
		const outside = mkdtempSync(join(sandbox.root, "outside-"));
		writeFileSync(join(outside, "notes.md"), "x");
		const parent = await parentOf(sandbox);
		parent.answer(BG, `Yes, and allow reading from ${outside}/ this session`);
		const first = file(sandbox, parent, { call: { toolName: "read", input: { path: join(outside, "notes.md") } } });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, first) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, first), "allow");
		const shared = readParentGrants(sandbox.agentDir, { [PARENT_SESSION_ENV]: parent.sessionId });
		assert.equal(shared?.outsideReadDirs?.length, 1);
		const second = file(sandbox, parent, { call: { toolName: "read", input: { path: join(outside, "notes.md") } } });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, second) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, second), "allow");
		assert.equal(parent.dialogs.length, 1);
	});

	it("\"always allow in this project\" saves to the request's project, as for an in-process child, and covers the next request", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(BG, PROJECT_NPM);
		const first = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, first) !== undefined, "the reply");
		assert.match(readFileSync(join(sandbox.cwd, ".pi", "settings.local.json"), "utf8"), /Bash\(npm test \*\)/);
		const second = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, second) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, second), "allow");
		assert.equal(parent.dialogs.length, 1);
	});

	it("a request from a subdirectory of the project saves to the project root's file", async () => {
		const sandbox = sandboxed();
		const sub = join(sandbox.cwd, "packages", "app");
		mkdirSync(sub, { recursive: true });
		const parent = await parentOf(sandbox);
		parent.answer(BG, PROJECT_NPM);
		const request = file(sandbox, parent, { cwd: sub });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.ok(existsSync(join(sandbox.cwd, ".pi", "settings.local.json")));
		assert.ok(!existsSync(join(sub, ".pi")));
	});
});

describe("a request is judged on the parent's terms", () => {
	it("childMode auto while the parent is in default mode is judged as default", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		// an auto child would not have asked about an edit inside the project; the parent's default mode does
		parent.answer(BG, "esc");
		const request = file(sandbox, parent, { childMode: "auto", call: edit("src/a.ts") });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.match(parent.dialogs[0].title, /subagent, default mode/);
		assert.doesNotMatch(parent.dialogs[0].title, /auto mode/);
		const noted = telemetry(parent).find((d) => d.phase === "remote-mode");
		assert.deepEqual([noted?.claimed, noted?.mode], ["auto", "default"]);
	});

	it("an auto parent with subagentsFollowAuto still judges a request from a child that says default as default", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { subagentsFollowAuto: true });
		await parent.command("mode", "auto");
		// the child fell back to default (e.g. it loaded while the heartbeat was stale): its edit asks, it is not auto-allowed
		parent.answer(BG, "esc");
		const request = file(sandbox, parent, { childMode: "default", call: edit("src/a.ts") });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.match(parent.dialogs[0].title, /subagent, default mode/);
		assert.equal(outcomeOf(sandbox, parent, request), "deny/user");
	});

	it("a request that says plan is judged as plan even under an auto parent", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { subagentsFollowAuto: true });
		await parent.command("mode", "auto");
		const request = file(sandbox, parent, { childMode: "plan", call: edit("src/a.ts") });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "deny/rules");
		assert.equal(parent.dialogs.length, 0);
	});

	it("a plan-mode parent judges a default-mode request as plan: an edit is denied outright", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		await parent.command("mode", "plan");
		const request = file(sandbox, parent, { call: edit("src/a.ts") });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "deny/rules");
		assert.equal(parent.dialogs.length, 0);
	});

	it("a parent with background asks off runs no ask server: a filed request is left alone and no heartbeat is written", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAsks: false });
		const asked = file(sandbox, parent);
		parent.pollAsks();
		await settle();
		assert.equal(replyTo(sandbox, parent, asked), undefined);
		assert.equal(parent.dialogs.length, 0);
		assert.equal(existsSync(join(mailbox(sandbox, parent), "alive")), false);
	});

	it("a cwd outside the parent's project gets the locked deny, whatever the call", async () => {
		const sandbox = sandboxed();
		const elsewhere = join(sandbox.root, "elsewhere");
		mkdirSync(join(elsewhere, ".git"), { recursive: true });
		const parent = await parentOf(sandbox);
		const request = file(sandbox, parent, { cwd: elsewhere, call: { toolName: "bash", input: { command: "git status" } } });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "deny/rules");
		assert.equal(parent.dialogs.length, 0);
		const logged = telemetry(parent).find((d) => d.phase === "choice");
		assert.equal(logged?.matcher, "childCwdLocked");
	});

	it("the home directory and / are refused even though they contain the project", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const request = file(sandbox, parent, { cwd: "/", call: { toolName: "bash", input: { command: "git status" } } });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "deny/rules");
	});
});

describe("requests that end without an answer", () => {
	it("a cancel aborts the open dialog and replies cancelled", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(BG, "hang");
		const request = file(sandbox, parent);
		parent.pollAsks();
		await until(() => parent.openDialogs === 1, "the dialog");
		writeCancel(mailbox(sandbox, parent), request.id);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "cancelled");
		await until(() => parent.openDialogs === 0, "the dialog to close");
		assert.ok(outcomes(parent).includes("remote-cancelled"));
	});

	it("a request whose child pid is dead is dropped without a dialog or a reply", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const dead = spawnSync(process.execPath, ["-e", "0"]).pid as number;
		const request = file(sandbox, parent, { childPid: dead });
		parent.pollAsks();
		await settle();
		assert.equal(parent.dialogs.length, 0);
		assert.equal(replyTo(sandbox, parent, request), undefined);
		assert.equal(existsSync(join(mailbox(sandbox, parent), "requests", `${request.id}.json.taken`)), false);
	});

	it("/new with requests pending denies them with parent-session-ended and closes the dialog", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(BG, "hang");
		const open = file(sandbox, parent);
		const queued = file(sandbox, parent);
		parent.pollAsks();
		await until(() => parent.openDialogs === 1, "the dialog");
		await parent.session("new");
		assert.equal(outcomeOf(sandbox, parent, open), "deny/parent-session-ended");
		assert.equal(outcomeOf(sandbox, parent, queued), "deny/parent-session-ended");
		await until(() => parent.openDialogs === 0, "the dialog to close");
		assert.equal(outcomes(parent).filter((o) => o === "parent-gone").length, 2);
	});

	it("shutdown does the same, and stops polling", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "badge" });
		const request = file(sandbox, parent);
		parent.pollAsks();
		assert.match(parent.statusOf("pi-keeper-asks") ?? "", /1 background approval waiting/);
		await parent.shutdown();
		assert.equal(outcomeOf(sandbox, parent, request), "deny/parent-session-ended");
		assert.equal(parent.statusOf("pi-keeper-asks"), undefined);
		const late = file(sandbox, parent);
		parent.pollAsks(); // the timer is gone: nothing happens
		await settle();
		assert.equal(replyTo(sandbox, parent, late), undefined);
	});
});

describe("/keeper changes apply to asks already waiting", () => {
	it("popup badge to always: the next poll opens the waiting ask", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "badge" });
		const request = file(sandbox, parent);
		parent.pollAsks();
		assert.match(parent.statusOf("pi-keeper-asks") ?? "", /1 background approval waiting/);
		assert.equal(parent.dialogs.length, 0);
		await parent.command("keeper", "background-ask-popup always");
		parent.answer(BG, ALLOW_ONCE);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
	});

	it("changing the timeout denies nothing and keeps the ask waiting", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "badge" });
		const request = file(sandbox, parent);
		parent.pollAsks();
		await parent.command("keeper", "background-ask-timeout 30m");
		await parent.command("keeper", "background-ask-timeout 10s");
		parent.pollAsks();
		await settle();
		assert.equal(replyTo(sandbox, parent, request), undefined);
		assert.match(parent.statusOf("pi-keeper-asks") ?? "", /1 background approval waiting/);
		assert.equal(existsSync(join(mailbox(sandbox, parent), "alive")), true, "the server and its heartbeat were not restarted away");
	});
});

describe("when the dialog opens", () => {
	it("idle: an idle session with an empty editor opens it at once and rings", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "idle" });
		parent.answer(BG, ALLOW_ONCE);
		parent.clearBells();
		const request = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.ok(parent.bells() >= 1);
		assert.equal(parent.statusOf("pi-keeper-asks"), undefined);
	});

	it("idle: a busy session shows a badge; /approvals opens it, and the badge clears", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "idle" });
		parent.idle = false;
		const request = file(sandbox, parent);
		parent.pollAsks();
		await settle();
		assert.equal(parent.dialogs.length, 0);
		assert.equal(parent.statusOf("pi-keeper-asks"), "1 background approval waiting · /approvals");
		parent.answer(BG, ALLOW_ONCE);
		await parent.command("approvals");
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
		assert.equal(parent.statusOf("pi-keeper-asks"), undefined);
	});

	it("idle: it opens when the run ends", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "idle" });
		parent.idle = false;
		const request = file(sandbox, parent);
		parent.pollAsks();
		assert.equal(parent.dialogs.length, 0);
		parent.answer(BG, ALLOW_ONCE);
		await parent.agentEnd();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
	});

	it("idle: text in the editor holds it back, even when the run ends", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "idle" });
		parent.editorText = "half a thought";
		const request = file(sandbox, parent);
		parent.pollAsks();
		await parent.agentEnd();
		await settle();
		assert.equal(parent.dialogs.length, 0);
		assert.match(parent.statusOf("pi-keeper-asks") ?? "", /1 background approval waiting/);
		parent.editorText = "";
		parent.answer(BG, "esc");
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "deny/user");
	});

	it("always: opens while the session is busy and the editor has text", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "always" });
		parent.idle = false;
		parent.editorText = "typing";
		parent.answer(BG, ALLOW_ONCE);
		const request = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
	});

	it("badge: never opens by itself, only through /approvals", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "badge" });
		const request = file(sandbox, parent);
		parent.pollAsks();
		await parent.agentEnd();
		await settle();
		assert.equal(parent.dialogs.length, 0);
		assert.equal(parent.statusOf("pi-keeper-asks"), "1 background approval waiting · /approvals");
		parent.answer(BG, ALLOW_ONCE);
		await parent.command("approvals");
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
	});

	it("/approvals with nothing pending says so", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		await parent.command("approvals");
		assert.deepEqual(parent.notifications.at(-1), { message: "No background approvals waiting.", type: "info" });
		assert.equal(parent.dialogs.length, 0);
	});

	it("a bad popup value falls back to always with a warning", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "sometimes" });
		assert.ok(parent.notifications.some((n) => /backgroundAskPopup must be/.test(n.message)));
		parent.answer(BG, ALLOW_ONCE);
		const request = file(sandbox, parent);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
	});
});

describe("dialogs never overlap", () => {
	it("a parent ask on screen holds a background ask back until it is answered", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAskPopup: "always" });
		parent.dialogHoldMs = 20;
		parent.answer(/Permission required \(default mode\)/, ALLOW_ONCE);
		parent.answer(BG, "esc");
		const request = file(sandbox, parent);
		const own = parent.tool("edit", { path: "src/own.ts", edits: [{ oldText: "a", newText: "b" }] });
		await until(() => parent.openDialogs === 1, "the parent's dialog");
		parent.pollAsks();
		assert.equal(parent.dialogs.length, 1, "the background ask waits for the slot");
		assert.equal((await own).blocked, false);
		await until(() => parent.openDialogs === 0, "the parent's dialog to close");
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "deny/user");
		assert.equal(parent.dialogs.length, 2);
		assert.equal(parent.maxOpenDialogs, 1);
		parent.assertNoPendingAnswers();
	});

	it("a parent ask arriving while a background ask is on screen waits for it", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.dialogHoldMs = 20;
		parent.answer(BG, "esc");
		parent.answer(/Permission required \(default mode\)/, ALLOW_ONCE);
		const request = file(sandbox, parent);
		parent.pollAsks();
		await until(() => parent.openDialogs === 1, "the background dialog");
		const own = await parent.tool("edit", { path: "src/own.ts", edits: [{ oldText: "a", newText: "b" }] });
		assert.equal(own.blocked, false);
		assert.equal(outcomeOf(sandbox, parent, request), "deny/user");
		assert.equal(parent.dialogs.length, 2);
		assert.equal(parent.maxOpenDialogs, 1);
		parent.assertNoPendingAnswers();
	});

	it("two background asks open one at a time", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.dialogHoldMs = 20;
		parent.answer(BG, "esc");
		parent.answer(BG, "esc");
		const a = file(sandbox, parent, { call: edit("src/a.ts") });
		const b = file(sandbox, parent, { call: edit("src/b.ts") });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, a) !== undefined && replyTo(sandbox, parent, b) !== undefined, "both replies");
		assert.equal(parent.maxOpenDialogs, 1);
		assert.equal(parent.dialogs.length, 2);
	});
});

describe("a parent without a UI", () => {
	it("starts no server and writes no heartbeat; its background child of an auto parent falls back to default", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { subagentsFollowAuto: true }, "none");
		await parent.command("mode", "auto");
		assert.equal(existsSync(join(mailbox(sandbox, parent), "alive")), false);
		const child = await backgroundChild(sandbox, parent, { entry: "child-auto" });
		const started = Date.now();
		assert.equal((await child.tool("edit", edit("src/a.ts").input)).blocked, true, "default, not auto");
		assert.ok(Date.now() - started < 1000);
		assert.equal(filed(sandbox, parent).length, 0);
	});

	it("with background-auto-fallback the same child runs auto", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { subagentsFollowAuto: true, backgroundAutoFallback: true }, "none");
		await parent.command("mode", "auto");
		assert.equal(existsSync(join(mailbox(sandbox, parent), "alive")), false);
		const child = await backgroundChild(sandbox, parent, { entry: "child-auto" });
		assert.equal((await child.tool("edit", edit("src/a.ts").input)).blocked, false);
	});
});

describe("a child does not start a server", () => {
	it("a subagent child session has no /approvals and touches no mailbox", async () => {
		const sandbox = sandboxed();
		const child = await startPi({ sandbox, entry: "child-default" });
		started.push(child);
		await child.session();
		assert.equal(existsSync(join(sandbox.agentDir, "pi-keeper", "asks")), false);
		await assert.rejects(child.command("approvals"));
	});
});

describe("hardening", () => {
	it("an edit aimed at a FIFO does not hang the preview or the dialogs behind it; a cancel closes it", async () => {
		const sandbox = sandboxed();
		const fifo = join(sandbox.cwd, "pipe");
		assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
		const parent = await parentOf(sandbox);
		parent.answer(BG, "hang");
		const first = file(sandbox, parent, { call: edit("pipe") });
		parent.pollAsks();
		await until(() => parent.openDialogs === 1, "the dialog (the preview must not block on the pipe)");
		writeCancel(mailbox(sandbox, parent), first.id);
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, first) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, first), "cancelled");
		// the next background dialog still opens
		parent.answer(BG, "esc");
		const second = file(sandbox, parent, { call: edit("src/b.ts") });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, second) !== undefined, "the second reply");
		assert.equal(outcomeOf(sandbox, parent, second), "deny/user");
	});

	it("a cwd spelled with a symlink and .. is judged and saved at the one place the gate resolves it to", async () => {
		const sandbox = sandboxed();
		const sub = join(sandbox.cwd, "packages");
		mkdirSync(sub, { recursive: true });
		const decoy = join(sandbox.root, "decoy");
		mkdirSync(join(decoy, "deeper"), { recursive: true });
		symlinkSync(join(decoy, "deeper"), join(sub, "link"));
		const parent = await parentOf(sandbox);
		parent.answer(BG, PROJECT_NPM);
		// realpath folds the .. lexically, the same way the cwd gate does: gate, rules and saves agree on <project>/packages
		const request = file(sandbox, parent, { cwd: `${sub}/link/..` });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
		assert.equal(existsSync(join(decoy, ".pi")), false);
		assert.equal(existsSync(join(decoy, "deeper", ".pi")), false);
		assert.match(readFileSync(join(sandbox.cwd, ".pi", "settings.local.json"), "utf8"), /Bash\(npm test \*\)/);
	});

	it("a cwd that is a symlink into the project saves rules at the real project", async () => {
		const sandbox = sandboxed();
		const link = join(sandbox.root, "alias");
		symlinkSync(sandbox.cwd, link);
		const parent = await parentOf(sandbox);
		parent.answer(BG, PROJECT_NPM);
		const request = file(sandbox, parent, { cwd: link });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
		assert.match(readFileSync(join(sandbox.cwd, ".pi", "settings.local.json"), "utf8"), /Bash\(npm test \*\)/);
	});

	it("a session exact-command grant is the parent user's own: it does not allow a background request", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		parent.answer(/Permission required/, "Yes, and don't ask again for this exact command this session");
		assert.equal((await parent.tool("bash", { command: "python3 x.py" })).blocked, false);
		assert.equal((await parent.tool("bash", { command: "python3 x.py" })).blocked, false, "the parent itself is covered");
		parent.answer(BG, "esc");
		const request = file(sandbox, parent, { call: { toolName: "bash", input: { command: "python3 x.py" } } });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "deny/user");
		assert.equal(parent.dialogs.length, 2);
	});

	it("a workflow command's allowed-tools do not allow a background request", async () => {
		const sandbox = sandboxed();
		const template = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "commit-template.md");
		const parent = await startPi({ sandbox, commands: [{ name: "commit", source: "prompt", path: template }] });
		started.push(parent);
		await parent.session();
		await parent.prompt("/commit tidy");
		assert.equal((await parent.tool("bash", { command: "git add ." })).blocked, false, "the run itself is covered");
		parent.answer(BG, "esc");
		const request = file(sandbox, parent, { call: { toolName: "bash", input: { command: "git add ." } } });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "deny/user");
	});

	it("the relayed child's edits option keeps its wording", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await startPi({ sandbox, entry: "child-default" });
		started.push(child);
		await child.session();
		parent.answer(/Permission required \(subagent/, "esc");
		await child.tool("edit", edit("src/a.ts").input);
		assert.ok(parent.dialogs[0].options.includes("Yes, allow all edits this session"));
	});
});

// ---------------------------------------------------------------------------
// The child side, end to end: a real background child harness (no relay,
// PI_SUBAGENT_PARENT_SESSION set) asks through the mailbox; the parent's ask
// timer is stepped by hand while the child waits.
// ---------------------------------------------------------------------------

const requestsDir = (sandbox: Sandbox, parent: Harness): string => join(mailbox(sandbox, parent), "requests");
const filed = (sandbox: Sandbox, parent: Harness): string[] => (existsSync(requestsDir(sandbox, parent)) ? readdirSync(requestsDir(sandbox, parent)) : []);

/** A background child of `parent`: another process, so no relay (the parent's is removed), told its parent session, quick polls. */
async function backgroundChild(sandbox: Sandbox, parent: Harness, over: { entry?: "child-default" | "child-auto" | "child-plan"; timeoutMs?: number; parentAlive?: () => boolean } = {}): Promise<Harness> {
	delete root[RELAY_KEY];
	process.env[PARENT_SESSION_ENV] = parent.sessionId;
	const { entry, ...seams } = over;
	const child = await startPi({ sandbox, entry: entry ?? "child-default", remoteRelay: { pollMs: 5, timeoutMs: 5_000, ...seams } });
	started.push(child);
	await child.session();
	return child;
}

/** Steps the parent's poll until `done`. */
const serve = (parent: Harness, done: () => boolean, what: string): Promise<void> =>
	until(() => {
		parent.pollAsks();
		return done();
	}, what);

const CHILD_BG = /Background subagent subagent \d+: Permission required \(subagent, default mode\)/;
const DECLINED = /^The user declined "bash: npm test"\. Continue without it/;

describe("a background child asks its parent's user", () => {
	it("opens a dialog naming the child; approving runs the child's call, and nothing is applied in the child", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await backgroundChild(sandbox, parent);
		parent.answer(CHILD_BG, ALLOW_ONCE);
		const call = child.tool("bash", { command: "npm test" });
		await serve(parent, () => parent.dialogs.length === 1, "the dialog");
		assert.match(parent.dialogs[0].title, /bash: npm test/);
		const outcome = await call;
		assert.equal(outcome.blocked, false, outcome.reason ?? "");
		parent.assertNoPendingAnswers();
		assert.equal(filed(sandbox, parent).length, 0, "the child cleaned up");
		assert.ok(telemetry(child).some((d) => d.outcome === "parent-ask" && d.choice === "allow"));
	});

	it("Esc denies that call with the decline message; the child's next ask is still sent", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await backgroundChild(sandbox, parent);
		parent.answer(CHILD_BG, "esc");
		const first = child.tool("bash", { command: "npm test" });
		await serve(parent, () => parent.dialogs.length === 1, "the dialog");
		const denied = await first;
		assert.equal(denied.blocked, true);
		assert.match(denied.reason ?? "", DECLINED);
		assert.match(denied.reason ?? "", /do not retry it or probe/);
		// no rejectedThisRun: the next call asks again (it is not auto-rejected)
		parent.answer(CHILD_BG, ALLOW_ONCE);
		const second = child.tool("bash", { command: "npm test" });
		await serve(parent, () => parent.dialogs.length === 2, "the second dialog");
		assert.equal((await second).blocked, false);
		assert.ok(!outcomes(child).includes("auto-reject"));
	});

	it("\"don't ask again\" in the parent covers the child's next identical call with no dialog, through the snapshot", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await backgroundChild(sandbox, parent);
		parent.answer(CHILD_BG, SESSION_NPM);
		const first = child.tool("bash", { command: "npm test" });
		await serve(parent, () => parent.dialogs.length === 1, "the dialog");
		assert.equal((await first).blocked, false);
		const before = filed(sandbox, parent).length;
		const second = await child.tool("bash", { command: "npm test" });
		assert.equal(second.blocked, false);
		assert.equal(parent.dialogs.length, 1);
		assert.equal(before, 0);
		assert.equal(telemetry(child).filter((d) => d.outcome === "parent-ask").length, 1, "the second call never left the child");
	});

	it("the parent's rules deny with the usual lane text", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await backgroundChild(sandbox, parent); // default: an edit asks
		await parent.command("mode", "plan"); // the parent now judges the request as plan: an edit is denied outright
		const call = child.tool("edit", edit("src/a.ts").input);
		await serve(parent, () => telemetry(child).some((d) => d.outcome === "parent-ask"), "the answer");
		const outcome = await call;
		assert.equal(outcome.blocked, true);
		assert.match(outcome.reason ?? "", /is not allowed in your lane \(default background child\)/);
		assert.equal(parent.dialogs.length, 0);
	});

	it("a /new in the parent while the child waits ends the wait within a poll", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await backgroundChild(sandbox, parent);
		parent.answer(CHILD_BG, "hang");
		const call = child.tool("bash", { command: "npm test" });
		await serve(parent, () => parent.openDialogs === 1, "the dialog");
		await parent.session("new");
		const outcome = await call;
		assert.equal(outcome.blocked, true);
		assert.match(outcome.reason ?? "", /is denied \(the parent session has ended\)/);
		assert.match(outcome.reason ?? "", /do not retry it/);
	});

	it("a parent that vanishes (liveness check false) is a deny at the next poll", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		let alive = true;
		const child = await backgroundChild(sandbox, parent, { parentAlive: () => alive });
		const call = child.tool("bash", { command: "npm test" });
		await until(() => filed(sandbox, parent).length === 1, "the request");
		alive = false;
		const outcome = await call;
		assert.match(outcome.reason ?? "", /\(the parent session has ended\)/);
		assert.equal(filed(sandbox, parent).length, 0);
	});

	it("an unanswered ask times out into today's deny and is withdrawn from the parent", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		// the parent steps once as soon as the request is filed; the margin is wide so a loaded machine cannot expire it first
		const child = await backgroundChild(sandbox, parent, { timeoutMs: 800 });
		parent.answer(CHILD_BG, "hang");
		const call = child.tool("bash", { command: "npm test" });
		await until(() => filed(sandbox, parent).length === 1, "the request");
		await serve(parent, () => parent.openDialogs === 1, "the dialog");
		const outcome = await call;
		assert.match(outcome.reason ?? "", /is denied \(the parent's user did not answer in time\)/);
		// the ask did have a relay (it reached the parent's mailbox): only the answer was missing
		assert.match(outcome.reason ?? "", /you are a default background child/);
		assert.doesNotMatch(outcome.reason ?? "", /no relay/);
		assert.match(outcome.reason ?? "", /contact_supervisor/);
		// the child filed a cancel as it left: the parent closes the dialog
		await serve(parent, () => parent.openDialogs === 0, "the dialog to close");
	});

	it("the child's session name is what the parent's dialog calls it", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		delete root[RELAY_KEY];
		process.env[PARENT_SESSION_ENV] = parent.sessionId;
		const child = await startPi({ sandbox, entry: "child-default", sessionName: "scout: map the tests", remoteRelay: { pollMs: 5, timeoutMs: 5_000 } });
		started.push(child);
		await child.session();
		parent.answer(/Background subagent scout: map the tests: Permission required/, ALLOW_ONCE);
		const call = child.tool("bash", { command: "npm test" });
		await serve(parent, () => parent.dialogs.length === 1, "the dialog");
		assert.equal((await call).blocked, false);
		parent.assertNoPendingAnswers();
	});

	it("the heartbeat goes stale while the child waits: the next poll denies", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await backgroundChild(sandbox, parent);
		parent.answer(CHILD_BG, "hang");
		const call = child.tool("bash", { command: "npm test" });
		await serve(parent, () => parent.openDialogs === 1, "the dialog");
		// the parent stops stepping its server (as a wedged one would) and its note ages out
		writeHeartbeat(mailbox(sandbox, parent), process.pid, Date.now() - HEARTBEAT_STALE_MS - 1000);
		const outcome = await call;
		assert.match(outcome.reason ?? "", /is denied \(the parent session has ended\)/);
		assert.equal(filed(sandbox, parent).length, 0);
		// the child left a cancel note: the parent, still alive, closes the dialog, and no reply is left behind
		await serve(parent, () => parent.openDialogs === 0, "the dialog to close");
		const replies = join(mailbox(sandbox, parent), "replies");
		assert.deepEqual(existsSync(replies) ? readdirSync(replies).filter((n) => n.endsWith(".json")) : [], []);
	});

	it("an aborted run cancels the ask", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const controller = new AbortController();
		delete root[RELAY_KEY];
		process.env[PARENT_SESSION_ENV] = parent.sessionId;
		const child = await startPi({ sandbox, entry: "child-default", remoteRelay: { pollMs: 5, timeoutMs: 5_000 }, signal: controller.signal });
		started.push(child);
		await child.session();
		parent.answer(CHILD_BG, "hang");
		const call = child.tool("bash", { command: "npm test" });
		await serve(parent, () => parent.openDialogs === 1, "the dialog");
		controller.abort();
		const outcome = await call;
		assert.match(outcome.reason ?? "", /\(the ask to the parent's user was cancelled\)/);
		await serve(parent, () => parent.openDialogs === 0, "the dialog to close");
	});
});

describe("when the child does not ask", () => {
	const TODAY = /is denied: you are a default child with no relay, and every mutation is denied for every path/;

	it("the env kill switch: today's deny, and no mailbox file is written", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		process.env[BACKGROUND_ASKS_ENV] = "0";
		const child = await backgroundChild(sandbox, parent);
		const outcome = await child.tool("bash", { command: "npm test" });
		assert.match(outcome.reason ?? "", TODAY);
		assert.equal(parent.dialogs.length, 0);
		assert.equal(existsSync(requestsDir(sandbox, parent)) ? readdirSync(requestsDir(sandbox, parent)).length : 0, 0);
		assert.equal(existsSync(join(mailbox(sandbox, parent), "cancels")) ? readdirSync(join(mailbox(sandbox, parent), "cancels")).length : 0, 0);
	});

	it("a snapshot but no ask server: the child denies at once and files nothing", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await backgroundChild(sandbox, parent);
		// the parent turns asks off: its server stops, the heartbeat goes, the snapshot stays
		await parent.command("keeper", "background-asks off");
		assert.equal(existsSync(join(mailbox(sandbox, parent), "alive")), false, "the heartbeat is removed with the server");
		assert.ok(readParentGrants(sandbox.agentDir, process.env) !== undefined, "the snapshot is still there");
		const started = Date.now();
		const outcome = await child.tool("bash", { command: "npm test" });
		assert.ok(Date.now() - started < 1000, "no wait");
		assert.match(outcome.reason ?? "", /is denied/);
		assert.equal(parent.dialogs.length, 0);
		assert.equal(filed(sandbox, parent).length, 0);
	});

	it("a parent that runs with the kill switch has no server: its child denies fast and falls back to default", async () => {
		const sandbox = sandboxed();
		process.env[BACKGROUND_ASKS_ENV] = "0";
		const parent = await parentOf(sandbox, { subagentsFollowAuto: true });
		await parent.command("mode", "auto");
		delete process.env[BACKGROUND_ASKS_ENV]; // the child's env does not carry the switch: only the missing heartbeat tells it
		assert.equal(existsSync(join(mailbox(sandbox, parent), "alive")), false);
		const child = await backgroundChild(sandbox, parent, { entry: "child-auto" });
		const started = Date.now();
		assert.equal((await child.tool("edit", edit("src/a.ts").input)).blocked, true, "default, not auto");
		assert.ok(Date.now() - started < 1000);
		assert.equal(filed(sandbox, parent).length, 0);
	});

	it("backgroundAsks false: today's deny, and the child stays default", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAsks: false });
		const child = await backgroundChild(sandbox, parent);
		const outcome = await child.tool("bash", { command: "npm test" });
		assert.match(outcome.reason ?? "", TODAY);
		assert.equal(parent.dialogs.length, 0);
		assert.equal(filed(sandbox, parent).length, 0);
	});

	it("a nested grandchild names a child session, which publishes no snapshot: the deny stands", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await backgroundChild(sandbox, parent);
		// the grandchild's parent session is the child's own
		process.env[PARENT_SESSION_ENV] = "test-session-of-the-child";
		const grandchild = await startPi({ sandbox, entry: "child-default", remoteRelay: { pollMs: 5, timeoutMs: 5_000 } });
		started.push(grandchild);
		await grandchild.session();
		assert.equal(readParentGrants(sandbox.agentDir, process.env), undefined);
		const outcome = await grandchild.tool("bash", { command: "npm test" });
		assert.match(outcome.reason ?? "", TODAY);
		assert.equal(parent.dialogs.length, 0);
		assert.equal(filed(sandbox, parent).length, 0);
		await child.shutdown();
	});
});

describe("the mode follows the parent", () => {
	it("an auto parent with subagentsFollowAuto and background asks on: the background child runs auto, and the parent clamps to auto", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { subagentsFollowAuto: true });
		await parent.command("mode", "auto");
		const child = await backgroundChild(sandbox, parent, { entry: "child-auto" });
		// an edit inside the project runs unasked in auto, in the child and in the parent's judgement of a request
		assert.equal((await child.tool("edit", edit("src/a.ts").input)).blocked, false);
		assert.equal(parent.dialogs.length, 0);
		const request = file(sandbox, parent, { childMode: "auto", call: edit("src/a.ts") });
		parent.pollAsks();
		await until(() => replyTo(sandbox, parent, request) !== undefined, "the reply");
		assert.equal(outcomeOf(sandbox, parent, request), "allow");
		assert.equal(telemetry(parent).find((d) => d.phase === "remote-mode"), undefined, "nothing was clamped");
	});

	it("a background child creates its own artifact dir with no ask at all, so nothing waits on the parent", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { subagentsFollowAuto: true });
		await parent.command("mode", "auto");
		const child = await backgroundChild(sandbox, parent, { entry: "child-auto" });
		// the shape pi-subagents' report dir needs, and the one that used to file a
		// mailbox ask nobody answers in time (denied after the ask timeout)
		const dir = join(sandbox.agentDir, "sessions", "--proj--", "subagent-artifacts", "outputs", "run-1");
		const started = Date.now();
		const outcome = await child.tool("bash", { command: `mkdir -p ${dir} && echo ok` });
		assert.equal(outcome.blocked, false, outcome.reason ?? "");
		assert.ok(Date.now() - started < 1000, "no wait for an answer");
		assert.equal(filed(sandbox, parent).length, 0, "no ask was filed");
		assert.equal(parent.dialogs.length, 0, "and no dialog was opened");
		// the same shell write anywhere else in the agent dir still asks
		const other = await child.tool("bash", { command: `mkdir -p ${join(sandbox.agentDir, "plans", "x")}` });
		assert.match(other.reason ?? "", /is denied/);
	});

	it("with background asks off the same child is default, unless background-auto-fallback is on", async () => {
		const off = sandboxed();
		const offParent = await parentOf(off, { subagentsFollowAuto: true, backgroundAsks: false });
		await offParent.command("mode", "auto");
		const defaultChild = await backgroundChild(off, offParent, { entry: "child-auto" });
		assert.equal((await defaultChild.tool("edit", edit("src/a.ts").input)).blocked, true);

		const on = sandboxed();
		const onParent = await parentOf(on, { subagentsFollowAuto: true, backgroundAsks: false, backgroundAutoFallback: true });
		await onParent.command("mode", "auto");
		const autoChild = await backgroundChild(on, onParent, { entry: "child-auto" });
		assert.equal((await autoChild.tool("edit", edit("src/a.ts").input)).blocked, false);
	});

	it("a default parent's background child stays default even with background-auto-fallback on, while asks are on", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox, { backgroundAutoFallback: true });
		const child = await backgroundChild(sandbox, parent);
		parent.answer(CHILD_BG, "esc");
		const call = child.tool("edit", edit("src/a.ts").input);
		await serve(parent, () => parent.dialogs.length === 1, "the dialog");
		assert.equal((await call).blocked, true);
	});

	it("the child's lane line says its asks are relayed, and stays the same for the whole session", async () => {
		const sandbox = sandboxed();
		const parent = await parentOf(sandbox);
		const child = await backgroundChild(sandbox, parent);
		const first = (await child.prompt("go")).systemPrompt;
		assert.match(first, /Your lane: default background child\./);
		assert.match(first, /relayed to the parent's user/);
		assert.doesNotMatch(first, /no relay|denied/);
		assert.match(first, /The user may approve or decline each ask/);
		assert.match(first, /Don't put deliverables there/);
		parent.answer(CHILD_BG, "esc");
		const call = child.tool("bash", { command: "npm test" });
		await serve(parent, () => parent.dialogs.length === 1, "the dialog");
		await call;
		assert.equal((await child.prompt("again")).systemPrompt, first);
	});
});
