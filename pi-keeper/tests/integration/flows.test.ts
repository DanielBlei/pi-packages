/**
 * End-to-end user flows: the real extension (extensions/index.ts) against a
 * fake pi (tests/mocks/pi.ts). No pi process, no model. Each `describe` is one
 * user story; each `it` one step, run in order against shared state.
 * Run: npm run test:integration
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, makeSandbox, planFileOf, restoreBell, scratchOf, startPi, type Harness, type Sandbox, type SessionEntry } from "../mocks/pi.ts";
import { MODES } from "../../extensions/modes.ts";
import { contractSection } from "../../extensions/prompt-blocks.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PERMISSION = /Permission required/;

after(() => restoreBell());

/** A sandbox that is removed when the enclosing describe finishes, pass or fail. */
function sandboxed(): Sandbox {
	const sandbox = makeSandbox();
	after(() => sandbox.cleanup());
	return sandbox;
}

type Event = Record<string, unknown>;

/** The permission telemetry entries (`pi-keeper-permission`), optionally of one phase. */
function telemetry(h: Harness, phase?: string): Event[] {
	return h.entries
		.filter((e) => e.customType === "pi-keeper-permission")
		.map((e) => e.data as Event)
		.filter((d) => phase === undefined || d.phase === phase);
}

/** Last telemetry event of a phase for a target. */
function lastEvent(h: Harness, phase: string, target: string): Event {
	const found = telemetry(h, phase).filter((e) => e.target === target || e.target === undefined).pop();
	assert.ok(found, `no ${phase} telemetry for ${target}`);
	return found;
}

const rulesFile = (sb: Sandbox): string => join(sb.cwd, ".pi", "settings.local.json");
const readRules = (sb: Sandbox): { allow?: string[]; ask?: string[]; deny?: string[] } =>
	(JSON.parse(readFileSync(rulesFile(sb), "utf8")) as { "pi-keeper": { permissions: { allow?: string[] } } })["pi-keeper"].permissions;
const writeRules = (sb: Sandbox, permissions: Record<string, string[]>): void => {
	mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
	writeFileSync(rulesFile(sb), JSON.stringify({ "pi-keeper": { permissions } }, null, 2));
};
const trustStore = (sb: Sandbox): Record<string, string> =>
	JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper", "trusted-rules.json"), "utf8")) as Record<string, string>;
const lastStatus = (h: Harness): string => String(h.statuses[h.statuses.length - 1]);
const notes = (h: Harness): string[] => h.notifications.map((n) => n.message);

describe("flow 1: default loop and persistence", () => {
	const sb = sandboxed();
	let h: Harness;
	before(async () => {
		h = await startPi({ sandbox: sb });
		await h.session();
	});

	it("asks for git commit with session and project options, and More… behind", async () => {
		h.answer(PERMISSION, /Yes, and always allow `git commit` in this project/);
		const result = await h.tool("bash", { command: "git commit -m x" });
		assert.equal(result.blocked, false);
		assert.equal(h.dialogs.length, 1);
		assert.deepEqual(h.dialogs[0].options, [
			"Yes",
			"Yes, and don't ask again for `git commit` this session (also via rtk)",
			"Yes, and always allow `git commit` in this project",
			"No",
			"More…",
		]);
		assert.match(h.dialogs[0].title, /Permission required \(default mode\)/);
		h.assertNoPendingAnswers();
	});

	it("saved the rule, recorded the trust hash and excluded the file from git", () => {
		assert.deepEqual(readRules(sb).allow, ["Bash(git commit *)"]);
		assert.equal(Object.keys(trustStore(sb)).length, 1);
		assert.ok(trustStore(sb)[rulesFile(sb)], "hash recorded under the rules file path");
		assert.match(readFileSync(join(sb.cwd, ".git", "info", "exclude"), "utf8"), /^\.pi\/settings\.local\.json$/m);
	});

	it("telemetry: decide(ask) then choice(remember-project)", () => {
		const decide = lastEvent(h, "decide", "git commit -m x");
		assert.equal(decide.action, "ask");
		assert.equal(decide.tool, "bash");
		assert.equal(decide.mode, "default");
		const choice = lastEvent(h, "choice", "git commit -m x");
		assert.equal(choice.choice, "Yes, and always allow `git commit` in this project");
		assert.equal(choice.outcome, "remember-project");
		assert.equal(choice.remembered, "git commit *");
		assert.equal(choice.scope, "project");
		assert.ok(h.entries.findIndex((e) => (e.data as Event).phase === "decide") < h.entries.findIndex((e) => (e.data as Event).phase === "choice"));
	});

	it("after a restart the rule runs silently (also via rtk) while git push still asks", async () => {
		const restarted = await startPi({ sandbox: sb });
		await restarted.session();
		const silent = await restarted.tool("bash", { command: "rtk git commit -m y" });
		assert.equal(silent.blocked, false);
		assert.equal(restarted.dialogs.length, 0);
		const decide = lastEvent(restarted, "decide", "rtk git commit -m y");
		assert.equal(decide.action, "allow");
		assert.equal(decide.matcher, "projectAllowBash");

		restarted.answer(PERMISSION, "No");
		const push = await restarted.tool("bash", { command: "git push origin main" });
		assert.equal(push.blocked, true);
		assert.equal(restarted.dialogs.length, 1);
		assert.equal(lastEvent(restarted, "decide", "git push origin main").matcher, "dangerousBash");
		restarted.assertNoPendingAnswers();
	});

	it("while planning the saved rule doesn't apply: git commit asks, with no project option", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "plan");
		h.answer(PERMISSION, "No");
		const commit = await h.tool("bash", { command: "git commit -m z" });
		assert.equal(commit.blocked, true);
		assert.equal(h.dialogs.length, 1, "the project rule must not allow it in plan mode");
		const options = h.dialogs[0].options.join("\n");
		assert.match(options, /this session/);
		assert.doesNotMatch(options, /in this project/);
		h.assertNoPendingAnswers();
	});
});

describe("flow 2: trust review of a hand-edited rules file", () => {
	const sb = sandboxed();
	before(() => writeRules(sb, { allow: ["Bash(make build *)"], deny: ["Bash(npm publish *)"] }));

	it("ignoring the review leaves the allow rule inactive and the deny rule active", async () => {
		const h = await startPi({ sandbox: sb });
		h.answer(/Load 1 allow rule/, "Ignore for this session");
		await h.session();
		assert.deepEqual(telemetry(h, "rules-review").map((e) => [e.choice, e.rules]), [["ignore", 1]]);
		assert.match(h.dialogs[0].title, /make build \*/);

		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("bash", { command: "make build -j4" })).blocked, false);
		assert.equal(h.dialogs.length, 2, "the allow rule did not apply: it asked");

		const denied = await h.tool("bash", { command: "npm publish --dry-run" });
		assert.equal(denied.blocked, true);
		assert.match(denied.reason ?? "", /blocked by the project rule Bash\(npm publish \*\)/);
		assert.equal(h.dialogs.length, 2);
		assert.equal(telemetry(h, "decide").pop()?.matcher, "projectDeny");
		h.assertNoPendingAnswers();
	});

	it("loading it next session makes the allow rule run silently and records trust", async () => {
		const h = await startPi({ sandbox: sb });
		h.answer(/Load 1 allow rule/, "Load them");
		await h.session();
		assert.deepEqual(telemetry(h, "rules-review").map((e) => [e.choice, e.rules]), [["load", 1]]);
		assert.ok(trustStore(sb)[rulesFile(sb)]);
		assert.ok(notes(h).some((m) => /Loaded 1 allow rule/.test(m)));

		assert.equal((await h.tool("bash", { command: "make build -j4" })).blocked, false);
		assert.equal(h.dialogs.length, 1, "only the review");
		assert.equal(telemetry(h, "decide").pop()?.matcher, "projectAllowBash");

		// edited mid-run (as the model could): untrusted until the next prompt's review
		writeRules(sb, { allow: ["Bash(make build *)", "Bash(make test *)"], deny: ["Bash(npm publish *)"] });
		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("bash", { command: "make build -j4" })).blocked, false);
		assert.equal(h.dialogs.length, 2, "the edited file's rules are inactive: asked");

		h.answer(/Load 2 allow rules/, "Load them");
		await h.prompt("go on");
		assert.equal((await h.tool("bash", { command: "make test" })).blocked, false);
		assert.equal(h.dialogs.length, 3, "reviewed at the prompt, then silent");
		h.assertNoPendingAnswers();
	});
});

describe("flow 3: reject semantics", () => {
	const sb = sandboxed();
	let h: Harness;
	before(async () => {
		h = await startPi({ sandbox: sb });
		await h.session();
	});

	it("rejecting one of three parallel calls blocks the others without a dialog", async () => {
		h.answer(PERMISSION, "No");
		const [a, b, c] = await Promise.all([
			h.tool("bash", { command: "make a" }),
			h.tool("bash", { command: "make b" }),
			h.tool("bash", { command: "make c" }),
		]);
		for (const r of [a, b, c]) {
			assert.equal(r.blocked, true);
			assert.equal(r.terminate, true);
			assert.match(r.reason ?? "", /rejected/);
		}
		assert.equal(h.dialogs.length, 1);
		assert.deepEqual(telemetry(h, "choice").map((e) => [e.target, e.outcome]), [
			["make a", "reject"],
			["make b", "auto-reject"],
			["make c", "auto-reject"],
		]);
		h.assertNoPendingAnswers();
	});

	it("input from an extension does not reset it, a user steer does", async () => {
		await h.prompt("from an extension", { source: "extension", streaming: "steer" });
		const stillRejected = await h.tool("bash", { command: "make d" });
		assert.equal(stillRejected.blocked, true);
		assert.equal(h.dialogs.length, 1);

		await h.prompt("do it differently", { streaming: "steer" });
		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("bash", { command: "make e" })).blocked, false);
		assert.equal(h.dialogs.length, 2);
	});

	it("a new prompt resets it too", async () => {
		h.answer(PERMISSION, "No");
		await h.tool("bash", { command: "make f" });
		await h.prompt("next task");
		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("bash", { command: "make g" })).blocked, false);
	});

	it("More… > No, and tell pi: the text is the reason and the run is not terminated", async () => {
		h.answer(PERMISSION, "More…");
		h.answer(/esc back/, "No, and tell pi what to do instead");
		h.answer(/What should pi do instead/, { input: "use pnpm" });
		const result = await h.tool("bash", { command: "npm install left-pad" });
		assert.equal(result.blocked, true);
		assert.match(result.reason ?? "", /use pnpm/);
		assert.ok(!result.terminate, "the agent continues with the feedback");
		assert.equal(telemetry(h, "choice").pop()?.outcome, "reject-feedback");
		assert.equal(telemetry(h, "choice").pop()?.feedback, "use pnpm");

		// no reject state: the next call is asked normally
		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("bash", { command: "pnpm install left-pad" })).blocked, false);
		h.assertNoPendingAnswers();
	});

	it("Esc inside More… goes back to the main dialog", async () => {
		const before = h.dialogs.length;
		h.answer(PERMISSION, "More…");
		h.answer(/esc back/, "esc");
		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("bash", { command: "make h" })).blocked, false);
		assert.equal(h.dialogs.length - before, 3);
		h.assertNoPendingAnswers();
	});
});

describe("flow 4: plan, approve, execute", () => {
	const sb = sandboxed();
	let h: Harness;
	let planFile = "";
	let scratch = "";

	before(async () => {
		h = await startPi({ sandbox: sb });
		await h.session();
	});

	it("/plan <prompt> enters plan mode and sends the prompt", async () => {
		await h.command("plan", "fix X");
		assert.match(lastStatus(h), /plan/);
		assert.ok(h.activeTools().includes("exit_plan_mode"));
		assert.deepEqual(h.userMessages.map((m) => m.content), ["fix X"]);
		assert.equal(h.userMessages[0].options, undefined, "idle: no deliverAs");
		// an idle switch sends nothing: the next prompt delivers the mode message, and the
		// system prompt stays exactly what pi built
		assert.equal(h.sentMessages.length, 0, "idle: nothing is sent, the next prompt carries the mode");

		const { systemPrompt } = await h.prompt("fix X");
		planFile = planFileOf(h);
		scratch = scratchOf(h);
		assert.ok(planFile.startsWith(join(sb.agentDir, "plans")), planFile);
		assert.ok(scratch.startsWith(sb.tmp), scratch);
		const block = h.modeBlocks().at(-1) ?? "";
		assert.ok(block.includes(MODES.plan.prompt));
		assert.equal(systemPrompt, "BASE\n\n<pi_keeper>\n" + contractSection() + "\n</pi_keeper>", "the prompt carries the contract only");
	});

	it("writes to the scratch dir are allowed, project edits are denied with the plan-mode reason", async () => {
		assert.equal((await h.tool("write", { path: join(scratch, "notes.md"), content: "n" })).blocked, false);
		const denied = await h.tool("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] });
		assert.equal(denied.blocked, true);
		assert.match(denied.reason ?? "", /Plan mode is active/);
		assert.equal(h.dialogs.length, 0);
	});

	it("npm test asks with session-only options", async () => {
		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("bash", { command: "npm test" })).blocked, false);
		const options = h.dialogs[0].options;
		assert.match(h.dialogs[0].title, /plan mode/);
		assert.ok(options.some((o) => /this session/.test(o)));
		assert.ok(!options.some((o) => /in this project/.test(o)));
	});

	it("exit_plan_mode with an empty plan file is an error", async () => {
		const result = await h.runTool("exit_plan_mode", {});
		assert.equal(result.isError, true);
		assert.match(result.text, /is empty/);
	});

	it("approving with the commands pre-approved executes in default mode", async () => {
		mkdirSync(dirname(planFile), { recursive: true });
		writeFileSync(planFile, "# Plan\n- [ ] run the tests\n- [ ] commit\n");
		h.answer(/Plan ready/, /allow `npm test`, `git commit` for this session/);
		const result = await h.runTool("exit_plan_mode", { commands: ["npm test", "rtk git commit -m x", "git push"] });
		assert.equal(result.isError, false);
		assert.equal(result.terminate, false);
		assert.match(result.text, /Plan approved by the user/);
		assert.match(result.text, /Pre-approved for this session: npm test, git commit/);
		assert.match(result.text, /## Approved plan:\n# Plan\n- \[ \] run the tests/);
		assert.match(lastStatus(h), /default/);
		const plan = telemetry(h, "plan").pop();
		assert.equal(plan?.outcome, "execute-manual-commands");
		assert.deepEqual(plan?.commands, ["npm test", "git commit"]);
		assert.equal((h.dialogs.at(-1)?.options ?? []).length, 4, "three Yes rows and the feedback field");
		h.assertNoPendingAnswers();
	});

	it("npm test and git commit run silently now, git push still asks", async () => {
		const before = h.dialogs.length;
		assert.equal((await h.tool("bash", { command: "npm test" })).blocked, false);
		assert.equal((await h.tool("bash", { command: "git commit -m done" })).blocked, false);
		assert.equal(h.dialogs.length, before);
		h.answer(PERMISSION, "No");
		assert.equal((await h.tool("bash", { command: "git push" })).blocked, true);
		assert.equal(h.dialogs.length, before + 1);
	});

	it("Keep planning with feedback stays in plan mode and gives the model another turn", async () => {
		await h.command("plan");
		h.answer(/Plan ready/, { feedback: "also add tests" });
		const result = await h.runTool("exit_plan_mode", {});
		assert.equal(result.isError, false);
		assert.equal(result.terminate, false);
		assert.match(result.text, /sent the plan back/);
		assert.match(result.text, /also add tests/);
		assert.match(result.text, /call exit_plan_mode again/);
		// both moves are named: a change is an edit, a question is answered in text
		assert.match(result.text, /If it asks for a change, edit the plan file/);
		assert.match(result.text, /answer that in text/);
		assert.doesNotMatch(result.text, /Do not answer in text/);
		assert.match(lastStatus(h), /plan/);
		const plan = telemetry(h, "plan").pop();
		assert.equal(plan?.outcome, "keep-planning");
		assert.equal(plan?.feedback, "also add tests");
	});

	it("Esc on the selector rejects: not an error, the turn ends, plan mode stays", async () => {
		h.answer(/Plan ready/, "esc");
		const result = await h.runTool("exit_plan_mode", {});
		assert.equal(result.isError, false);
		assert.equal(result.terminate, true);
		assert.match(result.text, /NOT approved/);
		assert.match(lastStatus(h), /plan/);
		assert.equal(telemetry(h, "plan").pop()?.outcome, "rejected");
	});

	it("approving for auto mode switches to auto", async () => {
		h.answer(/Plan ready/, "Yes, in auto mode");
		const result = await h.runTool("exit_plan_mode", {});
		assert.match(result.text, /Plan approved by the user/);
		assert.match(lastStatus(h), /auto/);
		assert.equal(telemetry(h, "plan").pop()?.outcome, "execute-auto");
		h.assertNoPendingAnswers();
	});
});

describe("flow 4b: the plan in the transcript, feedback, editing and the mode guards", () => {
	const sb = sandboxed();
	const READY = /Plan ready/;
	const AUTO = "Yes, in auto mode";
	const MANUAL = "Yes, approving each edit";

	/** A harness in plan mode with a plan file holding `plan`. */
	async function planning(plan = "# Plan\n- [ ] run the tests\n"): Promise<{ h: Harness; planFile: string }> {
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("plan");
		await h.prompt("go");
		const planFile = planFileOf(h);
		assert.ok(planFile);
		mkdirSync(dirname(planFile), { recursive: true });
		writeFileSync(planFile, plan);
		return { h, planFile };
	}

	it("approving echoes the plan and its file, and the row keeps the approved snapshot", async () => {
		const { h, planFile } = await planning();
		h.answer(READY, AUTO);
		const run = await h.runTool("exit_plan_mode", {});
		assert.equal(run.isError, false);
		assert.equal(run.terminate, false);
		assert.match(run.text, /^Plan approved by the user\. Plan mode is over and its restrictions no longer apply: start executing the plan now\..*Edits and commands run without asking/s);
		assert.ok(run.text.includes(`ticking each off in the plan file (${planFile})`));
		assert.match(run.text, /\n## Approved plan:\n# Plan\n- \[ \] run the tests$/);
		assert.equal(run.updates.length, 1, "the plan is shown while the selector waits");
		assert.equal((run.updates[0].details as { outcome: string }).outcome, "pending");
		assert.deepEqual(run.details, { plan: "# Plan\n- [ ] run the tests", planFile, outcome: "approved", edited: false, target: "auto" });
		const row = h.renderToolResult("exit_plan_mode", { content: [{ type: "text", text: run.text }], details: run.details }).lines;
		assert.match(row[1].trimEnd(), /^● Plan approved · auto mode$/);
		assert.ok(row.some((l) => l.includes("run the tests")));
	});

	it("ctrl+c on the selector cancels the review: not an error, the turn ends, plan mode stays", async () => {
		const { h } = await planning();
		h.answer(READY, { keys: ["\x03"] });
		const run = await h.runTool("exit_plan_mode", {});
		assert.equal(run.isError, false);
		assert.equal(run.terminate, true);
		assert.match(run.text, /^The plan review was cut off/);
		assert.match(lastStatus(h), /plan/);
		assert.equal(telemetry(h, "plan").pop()?.outcome, "aborted");
		assert.equal((run.details as { outcome: string }).outcome, "aborted");
		assert.match(h.renderToolResult("exit_plan_mode", { content: run.content as never, details: run.details }).lines[1].trimEnd(), /^● Plan review interrupted$/);
	});

	it("a huge plan is echoed capped, with a pointer to the file", async () => {
		const { h } = await planning(`# Plan\n${"- [ ] step\n".repeat(20000)}`);
		h.answer(READY, MANUAL);
		const run = await h.runTool("exit_plan_mode", {});
		assert.ok(run.text.length < 101_000 + 1000, `${run.text.length}`);
		assert.match(run.text, /\(truncated; see the plan file\)$/);
	});

	it("shift+tab approves with manual approval and sends the feedback as a second part", async () => {
		const { h } = await planning();
		h.answer(READY, { keys: [KEY.down, KEY.down, ..."also tests", KEY.shiftTab] });
		const run = await h.runTool("exit_plan_mode", {});
		assert.match(run.text, /^Plan approved by the user/);
		assert.match(lastStatus(h), /default/);
		assert.deepEqual(run.content.map((c) => c.text).slice(1), ["The user's note on this plan: also tests"]);
		assert.equal(telemetry(h, "plan").pop()?.outcome, "execute-manual-feedback");
		assert.equal(telemetry(h, "plan").pop()?.feedback, "also tests");
		assert.match(h.renderToolResult("exit_plan_mode", { content: run.content as never, details: run.details }).lines[1].trimEnd(), /manual approval · \+ feedback/);
	});

	it("ctrl+g edits the plan: the file is rewritten, the row re-renders and the result says edited", async () => {
		const { h, planFile } = await planning();
		h.answer(READY, { keys: [KEY.ctrlG] });
		h.answer(/Edit plan/, { input: "# Plan\n- [ ] run the tests\n- [ ] and lint" });
		h.answer(READY, MANUAL);
		const run = await h.runTool("exit_plan_mode", {});
		h.assertNoPendingAnswers();
		assert.match(run.text, /## Approved plan \(the user edited it\):\n# Plan\n- \[ \] run the tests\n- \[ \] and lint$/);
		assert.equal(readFileSync(planFile, "utf8"), "# Plan\n- [ ] run the tests\n- [ ] and lint\n");
		assert.equal(run.updates.length, 2, "the transcript row is updated with the edited plan");
		assert.match(String((run.updates[1].details as { plan: string }).plan), /and lint/);
		assert.match(h.dialogs.filter((d) => d.kind === "custom")[1].title, /Plan updated/);
		assert.equal((run.details as { edited: boolean }).edited, true);
	});

	it("an editor round trip that changes nothing but the trailing newline is not an edit", async () => {
		const { h } = await planning();
		h.answer(READY, { keys: [KEY.ctrlG] });
		h.answer(/Edit plan/, { input: "# Plan\n- [ ] run the tests" });
		h.answer(READY, MANUAL);
		const run = await h.runTool("exit_plan_mode", {});
		assert.doesNotMatch(run.text, /the user edited it/);
		assert.equal(run.updates.length, 1);
		assert.doesNotMatch(h.dialogs.filter((d) => d.kind === "custom")[1].title, /Plan updated/);
	});

	it("the draft feedback and the selected row survive ctrl+g", async () => {
		const { h } = await planning();
		h.answer(READY, { keys: [KEY.down, KEY.down, ..."keep this", KEY.ctrlG] });
		h.answer(/Edit plan/, "esc");
		h.answer(READY, { keys: [KEY.enter] });
		const run = await h.runTool("exit_plan_mode", {});
		h.assertNoPendingAnswers();
		assert.match(run.text, /Their note:\nkeep this\n/);
		assert.match(lastStatus(h), /plan/);
	});

	it("switching mode while the dialog is open: no approval, no mode switch", async () => {
		const { h } = await planning();
		h.answer(READY, { keys: [KEY.ctrlG] });
		h.answer(/Edit plan/, { input: "# Plan\n- [ ] run the tests", during: () => h.command("mode", "auto") });
		h.answer(READY, MANUAL);
		const before = h.sentMessages.length;
		const run = await h.runTool("exit_plan_mode", {});
		assert.equal(run.isError, false);
		assert.match(run.text, /The mode changed to auto while the plan was being reviewed/);
		assert.match(lastStatus(h), /auto/);
		assert.equal(h.sentMessages.slice(before).filter((m) => /default mode/.test(String(m.message.content))).length, 0);
		assert.equal(telemetry(h, "plan").length, 0);
	});

	it("the mode shortcut in the selector cycles the mode and approves nothing", async () => {
		const { h } = await planning();
		h.answer(READY, { keys: [KEY.altM] });
		const before = h.sentMessages.length;
		const run = await h.runTool("exit_plan_mode", {});
		assert.equal(run.isError, false);
		assert.match(run.text, /The mode changed to default while the plan was being reviewed/);
		assert.match(lastStatus(h), /default/);
		assert.equal(h.sentMessages.slice(before).length, 0, "the superseded result tells the model; no separate mode-change message");
		assert.equal(telemetry(h, "plan").length, 0);
		h.assertNoPendingAnswers();
	});

	it("a mode shortcut that cycles back into plan mode re-opens the review with the draft intact", async () => {
		const { h } = await planning();
		// the mode moved to auto while the plan editor was open, so the shortcut in the re-opened selector cycles auto -> plan
		h.answer(READY, { keys: [KEY.ctrlG] });
		h.answer(/Edit plan/, { input: "# Plan\n- [ ] run the tests", during: () => h.command("mode", "auto") });
		// down to the feedback field, type a draft, then the shortcut: the re-opened selector must still hold it
		h.answer(READY, { keys: [KEY.down, KEY.down, "d", "r", "a", "f", KEY.altM] });
		h.answer(READY, MANUAL);
		const run = await h.runTool("exit_plan_mode", {});
		h.assertNoPendingAnswers();
		assert.match(run.text, /Plan approved by the user/);
		assert.equal((run.details as { outcome: string }).outcome, "approved");
		assert.match(lastStatus(h), /default/);
		const reopened = h.dialogs.filter((d) => d.kind === "custom").at(-1)?.title ?? "";
		assert.match(reopened, /keep planning\s+draf/, "the typed draft survived the mode switch");
	});

	it("outside plan mode the tool and the tool_call guard say so", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		const run = await h.runTool("exit_plan_mode", {});
		assert.equal(run.isError, true);
		assert.match(run.text, /^Plan mode is not active, so there is nothing to exit\. This tool only ends plan mode once a plan is written\. If a plan was already approved, carry on with the work\.$/);
		const guard = await h.tool("exit_plan_mode", {});
		assert.equal(guard.blocked, true);
		assert.equal(guard.reason, run.text);
	});

	it("a second /plan with a plan on disk adds the re-entry note; the first does not", async () => {
		const { h } = await planning();
		assert.doesNotMatch(h.modeBlocks().at(-1) ?? "", /already has a plan file/);
		await h.command("mode", "default");
		await h.command("plan");
		await h.prompt("go");
		const block = h.modeBlocks().at(-1) ?? "";
		assert.match(block, /This session already has a plan file with content\. Read it first/);
		assert.match(block, /Edit the plan file before every exit_plan_mode call/);
	});

	it("leaving plan mode by hand names the plan file; an empty plan file or other switches do not", async () => {
		const { h, planFile } = await planning();
		await h.command("mode", "default");
		await h.prompt("go");
		assert.ok((h.modeBlocks().at(-1) ?? "").includes(`The plan file is at ${planFile} if you need it.`));
		await h.command("mode", "auto");
		await h.prompt("go");
		assert.doesNotMatch(h.modeBlocks().at(-1) ?? "", /The plan file is at/);
		writeFileSync(planFile, "  \n");
		await h.command("mode", "plan");
		await h.command("mode", "default");
		await h.prompt("go");
		assert.doesNotMatch(h.modeBlocks().at(-1) ?? "", /The plan file is at/);
	});

	it("the exit_plan_mode description says research-only requests skip it", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		const text = h.toolDescription("exit_plan_mode");
		assert.match(text, /not for a question or explanation/);
		assert.match(text, /never ask that in text/);
		assert.match(text, /takes no plan text and reads the file/);
	});

	it("the plan-mode prompt names the exploration, question and plan-file guidance", async () => {
		const { h } = await planning();
		await h.prompt("again");
		const block = h.modeBlocks().at(-1) ?? "";
		for (const part of ["call `subagent` with the read-only", "`scout`", "`questionnaire`", "## Plain-language explanation", "ASD-STE100", "one instruction", "**Write the plan file**", "A question, explanation or review"]) {
			assert.ok(block.includes(part), part);
		}
	});

	it("/plan in plan mode shows the plan file and content, or says there is no plan yet", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("plan");
		await h.prompt("go");
		const planFile = planFileOf(h);
		await h.command("plan");
		assert.match(h.notifications.at(-1)?.message ?? "", /^No plan yet\. Plan file: /);
		mkdirSync(dirname(planFile), { recursive: true });
		writeFileSync(planFile, "# Plan\n- [ ] run the tests\n");
		await h.command("plan");
		const shown = h.notifications.at(-1)?.message ?? "";
		assert.ok(shown.startsWith(`Plan file: ${planFile}\n\n# Plan`));
		assert.ok(shown.endsWith("- [ ] run the tests"));
		assert.equal(h.modeBlocks().length, 1, "no second switch: the block is unchanged");
	});

	it("/plan outside plan mode still switches to plan mode", async () => {
		const { h } = await planning();
		await h.command("mode", "default");
		await h.command("plan");
		assert.match(h.notifications.at(-1)?.message ?? "", /^Mode: plan/);
	});

	it("/plan open edits the plan file in any mode and writes changes back", async () => {
		const { h, planFile } = await planning();
		await h.command("mode", "default");
		h.answer(/Edit plan/, { input: "# Plan\n- [ ] run the tests\n- [ ] lint" });
		await h.command("plan", "open");
		assert.equal(readFileSync(planFile, "utf8"), "# Plan\n- [ ] run the tests\n- [ ] lint\n");
		assert.equal(h.notifications.at(-1)?.message, "Plan updated");
		// unchanged text (modulo the trailing newline) is not rewritten
		h.answer(/Edit plan/, { input: "# Plan\n- [ ] run the tests\n- [ ] lint\n\n" });
		await h.command("plan", "open");
		assert.equal(h.notifications.at(-1)?.message, "Plan updated");
		assert.equal(h.notifications.filter((n) => n.message === "Plan updated").length, 1);
		// cancelled: untouched
		h.answer(/Edit plan/, "esc");
		await h.command("plan", "open");
		assert.equal(readFileSync(planFile, "utf8"), "# Plan\n- [ ] run the tests\n- [ ] lint\n");
		assert.equal((await h.prompt("x")).systemPrompt.includes("Plan file:"), false, "still in default mode");
	});

	it("/plan open without a plan file says so and does not switch mode", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("plan", "open");
		assert.equal(h.notifications.at(-1)?.message, "No plan file in this session");
		assert.equal(h.dialogs.length, 0);
		assert.equal((await h.prompt("x")).systemPrompt.includes("Plan file:"), false);
	});

	it("the row falls back to the text when the result has no details (abort), and reuses its component", async () => {
		const { h } = await planning();
		const text = "Waiting for approval…";
		const first = h.renderToolResult("exit_plan_mode", { content: [{ type: "text", text }] });
		assert.deepEqual(first.lines.map((l) => l.trim()).filter(Boolean), [text]);
		const details = { plan: "# Plan", planFile: "/p.md", outcome: "pending", edited: false };
		const pending = h.renderToolResult("exit_plan_mode", { content: [{ type: "text", text }], details }, { isPartial: true });
		const again = h.renderToolResult("exit_plan_mode", { content: [{ type: "text", text }], details: { ...details, outcome: "rejected" } }, { lastComponent: pending.component });
		assert.equal(again.component, pending.component, "the Markdown is not rebuilt on every display update");
		assert.match(again.lines[1], /Plan declined/);
	});
});

describe("flow 5: session edits", () => {
	const sb = sandboxed();
	let h: Harness;
	const edit = (path: string) => ({ path, edits: [{ oldText: "one", newText: "two" }] });

	before(async () => {
		mkdirSync(join(sb.cwd, "src"), { recursive: true });
		writeFileSync(join(sb.cwd, "src", "a.ts"), "const x = one;\n");
		writeFileSync(join(sb.cwd, "src", "b.ts"), "const y = one;\n");
		h = await startPi({ sandbox: sb });
		await h.session();
	});

	it("an edit shows the preview dialog; Yes, allow all edits this session sets the footer chip", async () => {
		h.answer(PERMISSION, "Yes, allow all edits this session");
		const result = await h.tool("edit", edit("src/a.ts"));
		assert.equal(result.blocked, false);
		assert.equal(h.dialogs[0].kind, "custom", "the diff preview dialog");
		assert.match(h.dialogs[0].title, /1 edit/);
		assert.ok(h.dialogs[0].options.includes("Yes, allow all edits this session"));
		assert.match(lastStatus(h), /default · edits/);
		assert.equal(telemetry(h, "choice").pop()?.outcome, "allow-edits");
	});

	it("the next edit is silent", async () => {
		assert.equal((await h.tool("edit", edit("src/b.ts"))).blocked, false);
		assert.equal(h.dialogs.length, 1);
	});

	it(".git/config and .env still ask, offering only Yes and No", async () => {
		for (const [tool, path] of [
			["edit", ".git/config"],
			["write", ".env"],
		] as const) {
			h.answer(PERMISSION, "Yes");
			const input = tool === "edit" ? edit(path) : { path, content: "SECRET=1\n" };
			assert.equal((await h.tool(tool, input)).blocked, false);
			assert.deepEqual(h.dialogs.at(-1)?.options, ["Yes", "No", "No, and tell pi what to do instead"]);
		}
		assert.equal(h.dialogs.length, 3);
		h.assertNoPendingAnswers();
	});

	it("session_start(new) resets the flag", async () => {
		await h.session("new");
		assert.doesNotMatch(lastStatus(h), /edits/);
		h.answer(PERMISSION, "No");
		assert.equal((await h.tool("edit", edit("src/a.ts"))).blocked, true);
		assert.ok(h.dialogs.at(-1)?.options.includes("Yes, allow all edits this session"), "asked again");
	});
});

describe("flow 6: /permissions and /mode", () => {
	const sb = sandboxed();
	let h: Harness;
	before(async () => {
		h = await startPi({ sandbox: sb });
		await h.session();
	});

	it("/permissions add deny writes the rule, then git push is blocked naming it", async () => {
		await h.command("permissions", "add deny git push *");
		assert.deepEqual(readRules(sb).deny, ["Bash(git push *)"]);
		assert.ok(notes(h).some((m) => /Added to .*deny: Bash\(git push \*\)/.test(m)));
		const result = await h.tool("bash", { command: "git push origin main" });
		assert.equal(result.blocked, true);
		assert.match(result.reason ?? "", /project rule Bash\(git push \*\)/);
		assert.equal(h.dialogs.length, 0);
	});

	it("rejects malformed additions", async () => {
		await h.command("permissions", "add maybe git status");
		await h.command("permissions", "add allow sudo *");
		assert.equal(h.notifications.at(-2)?.type, "error");
		assert.equal(h.notifications.at(-1)?.type, "error");
		assert.deepEqual(readRules(sb).allow, undefined);
	});

	it("/mode shows the rules summary when there is no UI, and a selector when there is", async () => {
		const headless = await startPi({ sandbox: sb, ui: "none" });
		await headless.session();
		await headless.command("mode");
		const text = headless.notifications.at(-1)?.message ?? "";
		assert.match(text, /Current mode: default/);
		assert.match(text, /deny 1/);
		assert.match(text, /deny: Bash\(git push \*\)/);
		assert.match(text, /Usage: \/mode \[default\|auto\|plan\]/);

		// with a UI: a selector, not the text dump
		const notesBefore = h.notifications.length;
		h.answer(/Current mode: ● default/, "esc");
		await h.command("mode");
		assert.equal(h.dialogs.at(-1)?.kind, "custom");
		assert.equal(h.notifications.length, notesBefore, "Esc from the selector notifies nothing");
		h.assertNoPendingAnswers();
	});

	it("completions for /permissions add and /mode", () => {
		assert.deepEqual(h.complete("permissions", "a")?.map((c) => c.value), ["add "]);
		assert.deepEqual(h.complete("permissions", "add ")?.map((c) => c.value), ["add allow ", "add ask ", "add deny "]);
		assert.deepEqual(h.complete("permissions", "add de")?.map((c) => c.value), ["add deny "]);
		assert.equal(h.complete("permissions", "x"), null);
		assert.deepEqual(h.complete("mode", "p")?.map((c) => c.value), ["plan"]);
		assert.deepEqual(h.complete("mode", "")?.map((c) => c.value), ["default", "auto", "plan"]);
		assert.equal(h.complete("mode", "z"), null);
	});

	it("/permissions lists the rule; Remove deletes it from the file", async () => {
		h.answer(/Permission rules/, "[project deny] Bash(git push *)");
		h.answer(/\[project deny\] Bash\(git push \*\)/, "Remove");
		await h.command("permissions");
		h.assertNoPendingAnswers();
		const listed = h.dialogs.filter((d) => /Permission rules/.test(d.title)).at(-1);
		assert.equal(listed?.kind, "select");
		assert.deepEqual(listed?.options, ["[project deny] Bash(git push *)"]);
		assert.deepEqual(readRules(sb).deny, undefined);
		// emptied: nothing to list any more
		assert.match(h.notifications.at(-1)?.message ?? "", /No session or project rules/);
	});
});

describe("flow 7: workflow command grants", () => {
	const sb = sandboxed();
	let h: Harness;
	before(async () => {
		h = await startPi({ sandbox: sb, commands: [{ name: "commit", source: "prompt", path: join(PACKAGE_ROOT, "tests", "fixtures", "commit-template.md") }] });
		await h.session();
	});

	it("/commit grants git add and git commit for the run; git push still asks", async () => {
		await h.prompt("/commit tidy");
		assert.ok(notes(h).some((m) => /\/commit may run without asking during this run: .*git add \*, git commit \*/.test(m)), notes(h).join("\n"));
		assert.equal((await h.tool("bash", { command: "git add ." })).blocked, false);
		assert.equal((await h.tool("bash", { command: "git commit -m x" })).blocked, false);
		assert.equal(h.dialogs.length, 0);
		assert.equal(h.renderCall("bash", "never-ran").length, 1);

		h.answer(PERMISSION, "No");
		assert.equal((await h.tool("bash", { command: "git push" })).blocked, true);
		assert.equal(h.dialogs.length, 1);
	});

	it("the bash row says which grant allowed the call", async () => {
		await h.prompt("/commit again");
		await h.tool("bash", { command: "git commit -m y" }, { id: "granted" });
		assert.equal(h.renderCall("bash", "granted").at(-1), "  allowed by /commit: git commit *");
	});

	it("after agent_end the grant is gone", async () => {
		await h.agentEnd();
		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("bash", { command: "git commit -m z" })).blocked, false);
		assert.equal(h.dialogs.length, 2);
	});

	it("a queued steer neither starts nor ends a grant", async () => {
		await h.prompt("/commit once more");
		await h.prompt("/commit not a new run", { streaming: "steer" });
		assert.equal((await h.tool("bash", { command: "git add ." })).blocked, false);
		await h.prompt("plain steer", { streaming: "steer" });
		assert.equal((await h.tool("bash", { command: "git add ." })).blocked, false, "still granted");
		await h.agentEnd();
	});

	it("in plan mode the grants are ignored", async () => {
		await h.command("mode", "plan");
		await h.prompt("/commit in plan");
		assert.ok(notes(h).some((m) => /applies in default mode only/.test(m)));
		const before = h.dialogs.length;
		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("bash", { command: "git add ." })).blocked, false);
		assert.equal(h.dialogs.length, before + 1, "asked despite the grant");
		h.assertNoPendingAnswers();
	});

	it("an extension command of the same name wins over the template", async () => {
		const other = await startPi({
			sandbox: sb,
			commands: [
				{ name: "commit", source: "extension" },
				{ name: "commit", source: "prompt", path: join(PACKAGE_ROOT, "tests", "fixtures", "commit-template.md") },
			],
		});
		await other.session();
		await other.prompt("/commit");
		other.answer(PERMISSION, "Yes");
		await other.tool("bash", { command: "git add ." });
		assert.equal(other.dialogs.length, 1);
	});
});

describe("flow 7b: skill command grants", () => {
	const sb = sandboxed();
	let h: Harness;
	before(async () => {
		h = await startPi({
			sandbox: sb,
			commands: [{ name: "skill:commit", source: "skill", path: join(PACKAGE_ROOT, "tests", "fixtures", "skills", "commit", "SKILL.md") }],
		});
		await h.session();
	});

	it("/skill:commit grants git add and git commit (rtk-wrapped too); git push still asks", async () => {
		await h.prompt("/skill:commit tidy");
		assert.ok(notes(h).some((m) => /\/skill:commit may run without asking during this run: .*git add \*, git commit \*/.test(m)), notes(h).join("\n"));
		assert.equal((await h.tool("bash", { command: "git add ." })).blocked, false);
		assert.equal((await h.tool("bash", { command: "rtk git add ." })).blocked, false);
		assert.equal((await h.tool("bash", { command: "git commit -m x" })).blocked, false);
		assert.equal(h.dialogs.length, 0);
		h.answer(PERMISSION, "No");
		assert.equal((await h.tool("bash", { command: "git push" })).blocked, true);
		assert.equal(h.dialogs.length, 1);
	});

	it("the git commit grant never covers the dangerous forms the skill forbids: they still ask", async () => {
		for (const command of [
			"git commit --amend -m x",
			"rtk git commit --amend",
			"git commit --no-verify -m x",
			"git -c core.hooksPath=/dev/null commit -m x",
		]) {
			// a fresh run each time: a rejection auto-rejects the rest of its run
			await h.prompt("/skill:commit tidy");
			const before = h.dialogs.length;
			h.answer(PERMISSION, "No");
			assert.equal((await h.tool("bash", { command })).blocked, true, command);
			assert.equal(h.dialogs.length, before + 1, `${command} asked`);
		}
		h.assertNoPendingAnswers();
	});
});

describe("flow 8: read-only tools", () => {
	const sb = sandboxed();
	let h: Harness;
	before(async () => {
		h = await startPi({
			sandbox: sb,
			toolAnnotations: {
				mcp__srv__list: { readOnlyHint: true },
				mcp__srv__mutate: {},
				mcp__srv__drop: { readOnlyHint: true, destructiveHint: true },
			},
		});
		await h.session();
	});

	it("readOnlyHint runs in default and plan mode", async () => {
		assert.equal((await h.tool("mcp__srv__list", {})).blocked, false);
		await h.command("mode", "plan");
		assert.equal((await h.tool("mcp__srv__list", {})).blocked, false);
		assert.equal(h.dialogs.length, 0);
		assert.equal(telemetry(h, "decide").pop()?.matcher, "readOnlyTool");
	});

	it("bg_wait (waiting on this session's own background subagents) runs without a dialog in every mode", async () => {
		for (const mode of ["default", "plan", "auto"]) {
			await h.command("mode", mode);
			assert.equal((await h.tool("bg_wait", {})).blocked, false, mode);
		}
		assert.equal(h.dialogs.length, 0);
		await h.command("mode", "plan");
	});

	it("without annotations: denied in plan mode, asks in default mode", async () => {
		const denied = await h.tool("mcp__srv__mutate", {});
		assert.equal(denied.blocked, true);
		assert.match(denied.reason ?? "", /Plan mode is active/);
		await h.command("mode", "default");
		h.answer(PERMISSION, "Yes");
		assert.equal((await h.tool("mcp__srv__mutate", {})).blocked, false);
		assert.equal(h.dialogs.length, 1);
	});

	it("destructiveHint overrides readOnlyHint: asks", async () => {
		h.answer(PERMISSION, "No");
		assert.equal((await h.tool("mcp__srv__drop", {})).blocked, true);
		assert.equal(h.dialogs.length, 2);
	});

	it("a tool unknown to pi is not read-only", async () => {
		h.answer(PERMISSION, "No");
		assert.equal((await h.tool("mcp__srv__unknown", {})).blocked, true);
	});
});

describe("flow 9: approval lock and the rtk rewrite", () => {
	const sb = sandboxed();
	let h: Harness;
	before(async () => {
		h = await startPi({
			sandbox: sb,
			exec: (command, args) => {
				if (command !== "rtk") return undefined;
				if (args[0] === "--version") return { code: 0, stdout: "rtk 0.37.0\n" };
				if (args[0] === "rewrite") return { code: 0, stdout: `rtk ${args[1]}\n` };
				return undefined;
			},
		});
		await h.session();
	});

	it("the dialog shows the original command; the approved call runs the rtk form", async () => {
		h.answer(PERMISSION, /Yes, and don't ask again for `make build` this session/);
		const result = await h.tool("bash", { command: "make build" });
		assert.equal(result.blocked, false);
		assert.match(h.dialogs[0].title, /bash: make build\n/);
		assert.doesNotMatch(h.dialogs[0].title, /rtk make build/);
		assert.equal(result.input.command, "rtk make build");
		assert.deepEqual(h.execCalls.map((c) => c.args.slice(0, 2)), [["--version"], ["rewrite", "make build"]]);
	});

	it("another extension cannot change the approved input afterwards", async () => {
		h.answer(PERMISSION, "Yes");
		const result = await h.tool("bash", { command: "make test" });
		assert.equal(result.input.command, "rtk make test");
		assert.throws(() => {
			result.input.command = "rm -rf /";
		}, /the user approved "bash: make test"/);
		assert.throws(() => {
			Object.defineProperty(result.input, "command", { value: "x" });
		}, TypeError);
		assert.throws(() => {
			result.input.extra = true;
		}, TypeError);
		assert.equal(result.input.command, "rtk make test");
	});

	it("rule-allowed calls are neither locked nor rewritten", async () => {
		const result = await h.tool("bash", { command: "make build" }); // remembered for the session above
		assert.equal(h.dialogs.length, 2);
		assert.equal(result.input.command, "make build");
		result.input.command = "make build --other";
		assert.equal(result.input.command, "make build --other");
		const readOnly = await h.tool("bash", { command: "git status" });
		readOnly.input.command = "git status -s";
		assert.equal(readOnly.input.command, "git status -s");
	});

	it("without rtk the approved command runs as typed (but is still locked)", async () => {
		const plain = await startPi({ sandbox: sb });
		await plain.session();
		plain.answer(PERMISSION, "Yes");
		const result = await plain.tool("bash", { command: "make test" });
		assert.equal(result.input.command, "make test");
		assert.throws(() => {
			result.input.command = "x";
		}, /user approved/);
	});
});

describe("flow 10: the bash row note", () => {
	const sb = sandboxed();
	let h: Harness;
	const inner = ["$ the command", "  output"];
	before(async () => {
		h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("permissions", "add allow git commit *");
	});

	it("a call covered by a project rule ends with the rule", async () => {
		await h.tool("bash", { command: "git commit -m x" }, { id: "p1" });
		const lines = h.renderCall("bash", "p1", inner);
		assert.deepEqual(lines.slice(0, 2), inner, "the inner renderer's lines are untouched");
		assert.equal(lines.length, 3);
		assert.equal(lines[2], "  allowed by project rule: git commit *");
	});

	it("a session rule shows as allowed for this session", async () => {
		h.answer(PERMISSION, /Yes, and don't ask again for `make all` this session/);
		await h.tool("bash", { command: "make all" }, { id: "s1" });
		await h.tool("bash", { command: "make all" }, { id: "s2" });
		assert.equal(h.renderCall("bash", "s2", inner).at(-1), "  allowed for this session: make all *");
	});

	it("a dialog-approved call shows approved", async () => {
		h.answer(PERMISSION, "Yes");
		await h.tool("bash", { command: "cp a b" }, { id: "d1" });
		assert.equal(h.renderCall("bash", "d1", inner).at(-1), "  approved");
	});

	it("a read-only call shows no note", async () => {
		await h.tool("bash", { command: "git status" }, { id: "r1" });
		assert.deepEqual(h.renderCall("bash", "r1", inner), inner);
	});

	it("other tools are not wrapped, and session_start clears the notes", async () => {
		assert.deepEqual(h.renderCall("bash", "unknown-id", inner), inner);
		await h.session("new");
		assert.deepEqual(h.renderCall("bash", "p1", inner), inner);
	});
});

describe("flow 11: no UI", () => {
	const sb = sandboxed();
	it("an ask is blocked with the no-interactive-user reason and no dialog", async () => {
		const h = await startPi({ sandbox: sb, ui: "none" });
		await h.session();
		const result = await h.tool("bash", { command: "git commit -m x" });
		assert.equal(result.blocked, true);
		assert.match(result.reason ?? "", /requires user approval, but no interactive user is available/);
		assert.equal(h.dialogs.length, 0);
		assert.equal(telemetry(h, "choice").pop()?.outcome, "no-ui");

		// read-only calls and the plan tool path still work, without UI
		assert.equal((await h.tool("bash", { command: "git status" })).blocked, false);
		await h.command("plan");
		assert.equal((await h.tool("bash", { command: "npm test" })).blocked, true);
		const exit = await h.runTool("exit_plan_mode", {});
		assert.equal(exit.isError, true);
	});

	it("a rules file with unreviewed allow rules is not loaded or asked about", async () => {
		writeRules(sb, { allow: ["Bash(make build *)"] });
		const h = await startPi({ sandbox: sb, ui: "none" });
		await h.session();
		const result = await h.tool("bash", { command: "make build" });
		assert.equal(result.blocked, true);
		assert.equal(h.dialogs.length, 0);
	});
});

describe("flow 12: bell and working message", () => {
	const sb = sandboxed();
	it("the first dialog rings the bell; the working row shows and then clears the waiting message", async () => {
		delete process.env.PI_KEEPER_BELL;
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(PERMISSION, "Yes");
		await h.tool("bash", { command: "make a" });
		assert.equal(h.bells(), 1);
		assert.deepEqual(h.workingMessages, ["Waiting for approval…", undefined]);
	});

	it("PI_KEEPER_BELL=0 silences it", async (t) => {
		t.after(() => {
			delete process.env.PI_KEEPER_BELL;
		});
		process.env.PI_KEEPER_BELL = "0";
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(PERMISSION, "Yes");
		await h.tool("bash", { command: "make b" });
		assert.equal(h.bells(), 0);
		assert.deepEqual(h.workingMessages, ["Waiting for approval…", undefined]);
	});

	it("rpc sessions get no bell; plan approval and rules review ring with their own labels", async () => {
		const rpc = await startPi({ sandbox: sb, ui: "rpc" });
		await rpc.session();
		rpc.answer(PERMISSION, "Yes");
		await rpc.tool("bash", { command: "make c" });
		assert.equal(rpc.bells(), 0);

		writeRules(sb, { allow: ["Bash(make d *)"] });
		const h = await startPi({ sandbox: sb });
		h.answer(/Load 1 allow rule/, "Ignore for this session");
		await h.session();
		assert.equal(h.bells(), 1);
		await h.command("plan");
		await h.prompt("plan it");
		const planFile = planFileOf(h);
		mkdirSync(dirname(planFile), { recursive: true });
		writeFileSync(planFile, "- [ ] step\n");
		h.answer(/Plan ready/, "esc");
		await h.runTool("exit_plan_mode", {});
		assert.equal(h.bells(), 2);
		rmSync(rulesFile(sb));
	});

	it("the working message is restored even when the dialog is aborted by Esc", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(PERMISSION, "esc");
		await h.tool("bash", { command: "make e" });
		assert.equal(h.workingMessages.at(-1), undefined);
		assert.equal(h.workingMessages.length, 2);
	});
});

describe("flow 13: mode persistence", () => {
	const sb = sandboxed();
	let h: Harness;
	const states = (): Array<{ mode: string; planFilePath?: string }> =>
		h.entries.filter((e) => e.customType === "pi-keeper").map((e) => e.data as { mode: string; planFilePath?: string });
	before(async () => {
		h = await startPi({ sandbox: sb });
		await h.session();
	});

	it("a new default session writes no state entry", () => {
		assert.deepEqual(states(), []);
		assert.match(lastStatus(h), /● default/);
	});

	it("Alt+M cycles default, auto, plan and back; each change is persisted and shown", async () => {
		await h.shortcut("alt+m");
		assert.match(lastStatus(h), /⏵⏵ auto/);
		await h.shortcut("alt+m");
		assert.match(lastStatus(h), /⏸ plan/);
		await h.shortcut("alt+m");
		assert.match(lastStatus(h), /● default/);
		assert.deepEqual(states().map((s) => s.mode), ["auto", "plan", "default"]);
		assert.ok(states()[1].planFilePath?.startsWith(join(sb.agentDir, "plans")));
		assert.deepEqual(notes(h).filter((m) => m.startsWith("Mode:")), ["Mode: auto", "Mode: plan", "Mode: default"]);
		assert.equal(h.sentMessages.length, 0, "an idle switch sends nothing: the next prompt carries the mode");
		await h.shortcut("ctrl+shift+m");
		assert.match(lastStatus(h), /auto/);
		await h.shortcut("alt+m");
		await h.shortcut("alt+m");
		await h.command("mode", "bogus");
		assert.equal(h.notifications.at(-1)?.type, "error");
	});

	it("/mode without arguments opens a selector: a pick switches, Esc keeps the mode", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(/Current mode: ● default/, /⏵⏵ auto/);
		await h.command("mode", "");
		assert.match(lastStatus(h), /⏵⏵ auto/);
		assert.ok(notes(h).includes("Mode: auto"));
		assert.equal(h.sentMessages.length, 0, "an idle switch sends nothing: the next prompt carries the mode");
		const dialog = h.dialogs.at(-1);
		assert.equal(dialog?.kind, "custom");
		assert.equal(dialog?.options.length, 3, "default, auto and plan");
		const rows = (dialog?.title ?? "").split("\n").filter((l) => / — /.test(l));
		assert.equal(rows.length, 3);
		assert.deepEqual(rows.filter((l) => l.includes("(current)")), rows.slice(0, 1), "only the current mode is marked");
		const descCols = rows.map((l) => l.indexOf(" — "));
		assert.ok(descCols.every((c) => c === descCols[0]), `descriptions align: ${JSON.stringify(rows)}`);
		h.answer(/Current mode: ⏵⏵ auto/, "esc");
		await h.command("mode", "");
		assert.match(lastStatus(h), /⏵⏵ auto/);
		assert.equal(h.sentMessages.length, 0, "Esc changed nothing");
		h.assertNoPendingAnswers();
	});

	it("without a UI /mode shows the mode and the rules summary as text", async () => {
		const h = await startPi({ sandbox: sb, ui: "none" });
		await h.session();
		await h.command("mode", "");
		const note = notes(h).at(-1) ?? "";
		assert.match(note, /Current mode: default/);
		assert.match(note, /Usage: \/mode/);
	});

	it("the mode shortcut works inside a permission dialog: the mode cycles and the dialog still answers", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(PERMISSION, { keys: [KEY.ctrlShiftM, KEY.enter] });
		assert.equal((await h.tool("bash", { command: "npm test" })).blocked, false);
		assert.match(lastStatus(h), /auto/);
		assert.equal(h.dialogs.length, 1, "the shortcut neither closed nor reopened the dialog");
		assert.ok(notes(h).includes("Mode: auto"));
		h.assertNoPendingAnswers();
	});

	it("switching while the agent runs steers the mode message instead of waiting for the next prompt", async () => {
		h.idle = false;
		await h.command("mode", "plan");
		assert.equal(h.sentMessages.at(-1)?.options?.deliverAs, "steer");
		assert.equal(h.sentMessages.at(-1)?.message.customType, "pi-keeper-mode");
		assert.match(String(h.sentMessages.at(-1)?.message.content), /# Plan mode/);
		h.idle = true;
		await h.command("mode", "default");
		// idle again: nothing is sent until the next prompt, which then carries the block
		await h.prompt("go");
		assert.match(h.modeBlocks().at(-1) ?? "", /# Default mode/);
	});

	it("session_tree restores the mode (and plan file) of the branch", async () => {
		const plan = h.entries.filter((e) => e.customType === "pi-keeper" && (e.data as { mode: string }).mode === "plan");
		h.branch = [plan[0]];
		await h.tree();
		assert.match(lastStatus(h), /⏸ plan/);
		assert.ok(h.activeTools().includes("exit_plan_mode"));
		await h.prompt("again");
		assert.ok((h.modeBlocks().at(-1) ?? "").includes(`Plan file: ${(plan[0].data as { planFilePath: string }).planFilePath}`));

		h.branch = [];
		await h.tree();
		assert.match(lastStatus(h), /● default/);
		// the tool list is the same in every mode: that is what keeps the request prefix stable
		assert.ok(h.activeTools().includes("exit_plan_mode"));
	});

	it("resuming a session restores its last state, and migrates accept-edits to auto", async () => {
		const entry = (mode: string): SessionEntry => ({ type: "custom", id: "x", timestamp: new Date().toISOString(), customType: "pi-keeper", data: { mode } });
		const resumed = await startPi({ sandbox: sb, entries: [entry("plan"), entry("accept-edits")] });
		await resumed.session("resume");
		assert.match(lastStatus(resumed), /auto/);
	});

	it("the prompt carries the constant contract; the mode, scratch line and plan file arrive as a message", async () => {
		const fresh = await startPi({ sandbox: sb });
		await fresh.session();
		// pi renders the base prompt and then the sections; ours is the only one we add
		const expected = `BASE\n\n<pi_keeper>\n${contractSection()}\n</pi_keeper>`;
		const def = (await fresh.prompt("hi")).systemPrompt;
		assert.equal(def, expected, "the system prompt is pi's plus the constant contract, nothing else");
		assert.match(def, /rtk grep/);
		assert.ok(!def.includes(MODES.default.prompt), "the mode text is not in the prompt");
		const defBlock = fresh.modeBlocks().at(-1) ?? "";
		assert.ok(defBlock.includes(MODES.default.prompt));
		assert.match(defBlock, /Scratch dir: .*pi-keeper-/);
		assert.doesNotMatch(defBlock, /Plan file:/);

		await fresh.command("mode", "auto");
		assert.equal((await fresh.prompt("hi")).systemPrompt, expected, "a mode switch does not touch the prompt");
		const autoBlock = fresh.modeBlocks().at(-1) ?? "";
		assert.ok(autoBlock.includes(MODES.auto.prompt));
		assert.ok(!autoBlock.includes(MODES.default.prompt));

		await fresh.command("mode", "plan");
		assert.equal((await fresh.prompt("hi")).systemPrompt, expected, "nor does entering plan mode");
		const planBlock = fresh.modeBlocks().at(-1) ?? "";
		assert.ok(planBlock.includes(MODES.plan.prompt));
		assert.match(planBlock, /Plan file: .*\nThis is the ONLY project file you may edit or write\./);
		const scratch = scratchOf(fresh);
		assert.ok(existsSync(scratch), "scratch dir created");
		assert.ok(scratch.startsWith(sb.tmp));
	});
});

describe("flow 14: telemetry round trip through scripts/extract_flow.py", () => {
	const sb = sandboxed();
	const python = spawnSync("python3", ["--version"]);
	const hasPython = python.status === 0;

	it("the recorded session reads back as decide, choice, decide events in order", { skip: hasPython ? false : "python3 is not available" }, async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(PERMISSION, "Yes");
		await h.tool("bash", { command: "git commit -m x" }, { id: "t1" });
		await h.tool("bash", { command: "git status" }, { id: "t2" });
		h.answer(PERMISSION, "No");
		await h.tool("bash", { command: "make zap" }, { id: "t3" });

		const file = h.exportSession(join(sb.root, "session.jsonl"));
		const run = spawnSync("python3", [join(PACKAGE_ROOT, "scripts", "extract_flow.py"), "--json", file], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as Event & { _exec?: { error: boolean | null }; session: { id: string; cwd: string } });

		assert.deepEqual(events.map((e) => [e.phase, e.toolCallId]), [
			// one session entry first: model + prompt version, recorded once per session
			["session", undefined],
			["decide", "t1"],
			["choice", "t1"],
			["decide", "t2"],
			["decide", "t3"],
			["choice", "t3"],
		]);
		const [sessionEntry] = events;
		assert.match(String((sessionEntry as unknown as { promptVersion: string }).promptVersion), /^[0-9a-f]{12}$/);
		// the flow itself starts after it (the assertions below index from there)
		events.splice(0, 1);
		assert.equal(events[0].action, "ask");
		assert.equal(events[1].outcome, "allow-once");
		assert.equal(events[1].choice, "Yes");
		assert.equal(events[2].action, "allow");
		assert.equal(events[2].matcher, "readOnlyBash");
		assert.equal(events[4].outcome, "reject");
		// correlated with the tool calls recorded around them
		assert.equal(events[0]._exec?.error, false);
		assert.equal(events[4]._exec?.error, true);
		assert.equal(events[0].session.id, "test-session");
		assert.equal(events[0].session.cwd, sb.cwd);

		// the human summary reads the same file
		const summary = spawnSync("python3", [join(PACKAGE_ROOT, "scripts", "extract_flow.py"), file], { encoding: "utf8" });
		assert.equal(summary.status, 0, summary.stderr);
		assert.match(summary.stdout, /git commit -m x/);
	});
});

describe("flow: the plan file never asks, in any mode", () => {
	const sb = sandboxed();
	let h: Harness;
	let planFile = "";
	before(async () => {
		h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("plan");
		await h.prompt("go");
		planFile = planFileOf(h);
		assert.ok(planFile.startsWith(join(sb.agentDir, "plans")), planFile);
	});

	it("the plan-file line says how to create the file, and does not change when it appears", async () => {
		assert.ok(!existsSync(planFile));
		const first = h.modeBlocks().at(-1) ?? "";
		assert.match(first, /ONLY project file you may edit or write\. If it does not exist yet, create it with the `write` tool/);
		mkdirSync(dirname(planFile), { recursive: true });
		writeFileSync(planFile, "# Plan\n");
		await h.prompt("go");
		// the same text, so nothing is re-sent: the block is the cached tail, not a progress note
		assert.equal(h.modeBlocks().length, 1, "writing the plan file does not change the message");
	});

	for (const mode of ["default", "auto", "plan"] as const) {
		it(`${mode}: write and edit of the plan file run without a dialog`, async () => {
			await h.command("mode", mode);
			assert.equal((await h.tool("write", { path: planFile, content: "# Plan\n- [ ] a\n" })).blocked, false);
			assert.equal((await h.tool("edit", { path: planFile, edits: [{ oldText: "- [ ] a", newText: "- [x] a" }] })).blocked, false);
			assert.equal(h.dialogs.length, 0);
		});
	}

	it("default: another file next to the plan file still asks", async () => {
		await h.command("mode", "default");
		h.answer(PERMISSION, "No");
		const before = h.dialogs.length;
		const other = join(dirname(planFile), "other.md");
		assert.equal((await h.tool("write", { path: other, content: "x" })).blocked, true);
		assert.equal(h.dialogs.length, before + 1);
	});

	it("auto: another file next to the plan file still asks", async () => {
		await h.command("mode", "auto");
		await h.prompt("again"); // a rejection ends the run: new input clears it
		h.answer(PERMISSION, "No");
		const before = h.dialogs.length;
		const other = join(dirname(planFile), "other.md");
		assert.equal((await h.tool("write", { path: other, content: "x" })).blocked, true);
		assert.equal(h.dialogs.length, before + 1);
	});
});

describe("flow: a broken project rules file", () => {
	const sb = sandboxed();
	it("a broken rules file asks even for a command remembered for the session", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(PERMISSION, /don't ask again for `git commit` this session/);
		assert.equal((await h.tool("bash", { command: "git commit -m x" })).blocked, false);
		assert.equal(h.dialogs.length, 1);

		// the file is edited into invalid JSON: every shell command asks again
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(rulesFile(sb), "{ nope");
		h.answer(PERMISSION, "No");
		const result = await h.tool("bash", { command: "git commit -m x" });
		assert.equal(result.blocked, true);
		assert.equal(h.dialogs.length, 2);
	});
});

describe("flow: a failure while judging a call", () => {
	const sb = sandboxed();
	it("a throw inside decide blocks the call with a fixed message and never runs it", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		const input: Record<string, unknown> = {};
		// non-enumerable: the mock copies the input into its own records, which must not throw
		Object.defineProperty(input, "command", {
			enumerable: false,
			get() {
				throw new Error("internal-boom");
			},
		});
		const result = await h.tool("bash", input);
		assert.equal(result.blocked, true);
		assert.match(result.reason ?? "", /pi-keeper could not judge this call/);
		assert.doesNotMatch(result.reason ?? "", /internal-boom/);
		assert.equal(h.dialogs.length, 0);
	});
});
