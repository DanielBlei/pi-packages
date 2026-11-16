/**
 * Permission-flow fixes (see docs/design.md),
 * driven through the real extension (tests/mocks/pi.ts): the exact-command
 * remember, scratch deletes, `bash -n`, the read-only tool list, plan-mode
 * wording for unavailable tools, and a child's own output artifact.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, planFileOf, restoreBell, scratchOf, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";

after(() => restoreBell());

const PERMISSION = /Permission required/;
const EXACT = "Yes, and don't ask again for this exact command this session";

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

type Event = Record<string, unknown>;
const telemetry = (h: Harness, phase: string): Event[] =>
	h.entries
		.filter((e) => e.customType === "pi-keeper-permission")
		.map((e) => e.data as Event)
		.filter((d) => d.phase === phase);

describe("remembering an exact command that no prefix can cover", () => {
	const sb = sandboxed();
	let h: Harness;
	const command = "python3 scripts/inspect-session.py --once";

	it("the dialog offers it, and the same command then runs without a dialog", async () => {
		h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(PERMISSION, EXACT);
		const first = await h.tool("bash", { command });
		assert.equal(first.blocked, false);
		assert.ok(h.dialogs[0].options.includes(EXACT), "offered after Yes");
		assert.deepEqual(h.dialogs[0].options.slice(0, 2), ["Yes", EXACT]);

		const again = await h.tool("bash", { command });
		assert.equal(again.blocked, false);
		assert.equal(h.dialogs.length, 1, "no second dialog");
		h.assertNoPendingAnswers();
	});

	it("telemetry records the choice as a session remember", () => {
		const choice = telemetry(h, "choice").at(-1) as Event;
		assert.equal(choice.outcome, "remember-session");
		assert.equal(choice.remembered, `exact: ${command}`);
	});

	it("a different command, or the same one with other arguments, still asks", async () => {
		h.answer(PERMISSION, "No");
		const other = await h.tool("bash", { command: `${command} --twice` });
		assert.equal(other.blocked, true);
		assert.equal(h.dialogs.length, 2);
	});

	it("/permissions lists it", async () => {
		h.answer(/Permission rules/, "esc");
		await h.command("permissions");
		const list = h.dialogs.at(-1);
		assert.ok(list?.options.some((o) => o.includes("[session] exact command:") && o.includes("inspect-session.py")), String(list?.options));
	});

	it("plan mode does not honour it", async () => {
		await h.prompt("next"); // a new run: the No above no longer auto-rejects
		await h.command("plan");
		h.answer(PERMISSION, "No");
		const planned = await h.tool("bash", { command });
		assert.equal(planned.blocked, true);
		const dialog = h.dialogs.at(-1);
		assert.match(dialog?.title ?? "", /plan mode/);
		assert.ok(!dialog?.options.includes(EXACT), "plan mode offers no exact option");
	});
});

describe("the exact-command option is not offered for removals", () => {
	const sb = sandboxed();

	it("rm -rf build, alone or after an interpreter, offers Yes / No only (no exact remember)", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		for (const command of ["rm -rf build", "python3 scripts/x.py && rm -rf build"]) {
			await h.prompt("go"); // a new run: an earlier No no longer auto-rejects
			h.answer(PERMISSION, "No");
			const outcome = await h.tool("bash", { command });
			assert.equal(outcome.blocked, true, command);
			const dialog = h.dialogs.at(-1);
			assert.ok(!dialog?.options.includes(EXACT), `${command}: ${dialog?.options}`);
		}
	});
});

describe("commands that used to ask for nothing", () => {
	const sb = sandboxed();
	let h: Harness;

	it("bash -n, git diff --check and lsp_diagnostics run without a dialog in default mode", async () => {
		h = await startPi({ sandbox: sb });
		await h.session();
		for (const [tool, input] of [
			["bash", { command: "bash -n run_itbench.sh && git diff --check -- run_itbench.sh && git diff -- run_itbench.sh" }],
			["lsp_diagnostics", { path: "run_itbench.sh" }],
		] as const) {
			const outcome = await h.tool(tool, { ...input });
			assert.equal(outcome.blocked, false, tool);
		}
		assert.equal(h.dialogs.length, 0);
	});

	it("rm -rf inside the scratch dir, and cd into it, run without a dialog; the dir itself still asks", async () => {
		await h.prompt("go");
		const scratch = scratchOf(h);
		assert.ok(scratch, "the scratch dir is named in the mode message");
		const silent = [
			`rm -rf ${scratch}/old-run`,
			`mkdir -p ${scratch}/run && cd ${scratch}/run && rm -rf ../old-run`,
			`rm -rf ${scratch}/a && mkdir -p ${scratch}/a`,
		];
		for (const command of silent) {
			const outcome = await h.tool("bash", { command });
			assert.equal(outcome.blocked, false, command);
		}
		assert.equal(h.dialogs.length, 0);

		h.answer(PERMISSION, "No");
		const outcome = await h.tool("bash", { command: `rm -rf ${scratch}` });
		assert.equal(outcome.blocked, true, "the scratch dir itself is dangerous");
		assert.match(h.dialogs[0].title, /dangerous/i);
	});
});

describe("read-only tools from other packages", () => {
	it("web_search and friends run while planning with the default list", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("plan");
		for (const tool of [
			"web_search", "fetch_content", "get_search_content", "code_overview", "lsp_diagnostics",
			// the LSP, ast and MCP readers the default list gained
			"lsp_hover", "lsp_definition", "lsp_references", "lsp_symbols", "lsp_code_actions", "lsp_completions",
			"ast_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
		]) {
			const outcome = await h.tool(tool, {});
			assert.equal(outcome.blocked, false, tool);
		}
		assert.equal(h.dialogs.length, 0);
	});

	it("an unlisted tool is denied with a message that says it is unavailable, not 'add it to the plan'", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("plan");
		const outcome = await h.tool("some_other_tool", {});
		assert.equal(outcome.blocked, true);
		assert.match(outcome.reason ?? "", /`some_other_tool` tool is not available while planning/);
		assert.doesNotMatch(outcome.reason ?? "", /add it to the plan/);
		// writes keep the plan-it-instead wording
		const write = await h.tool("write", { path: "src/x.ts", content: "x" });
		assert.match(write.reason ?? "", /add it to the plan instead/);
	});

	it("~/.pi/agent/pi-keeper.json replaces the default list", async () => {
		const sb = sandboxed();
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), JSON.stringify({ readOnlyTools: ["only_this"] }));
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("plan");
		assert.equal((await h.tool("only_this", {})).blocked, false);
		assert.equal((await h.tool("web_search", {})).blocked, true);
	});

	it("a broken settings file warns once at session start and the defaults apply", async () => {
		const sb = sandboxed();
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), "{broken");
		const h = await startPi({ sandbox: sb });
		await h.session();
		assert.ok(h.notifications.some((n) => n.type === "warning" && n.message.includes("pi-keeper.json")));
		await h.command("plan");
		assert.equal((await h.tool("web_search", {})).blocked, false);
	});
});

describe("a subagent child's own output artifact", () => {
	const sb = sandboxed();
	const artifact = join(sb.agentDir, "sessions", "--proj--", "subagent-artifacts", "outputs", "run-1", "context.md");

	for (const entry of ["child-plan", "child-default"] as const) {
		it(`${entry}: writing it needs no approval; other agent-dir files are still refused`, async () => {
			mkdirSync(join(artifact, ".."), { recursive: true });
			const child = await startPi({ sandbox: sb, entry });
			await child.session();
			const written = await child.tool("write", { path: artifact, content: "# Code Context\n" });
			assert.equal(written.blocked, false);
			const other = await child.tool("write", { path: join(sb.agentDir, "models.json"), content: "{}" });
			assert.equal(other.blocked, true);
			assert.equal(child.dialogs.length, 0, "a child never opens its own dialog");
		});
	}

	it("child-plan: a secret-named file in the artifact dir is not written silently", async () => {
		const child = await startPi({ sandbox: sb, entry: "child-plan" });
		await child.session();
		const secret = await child.tool("write", { path: join(artifact, "..", "id_rsa"), content: "x" });
		assert.equal(secret.blocked, true);
	});
});

describe("a mode note belongs to the session that switched", () => {
	const note = (block: string | undefined): boolean => /The plan file is at /.test(block ?? "");

	it("a note from a switch in this session is delivered; /new and /resume start without it", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "plan");
		await h.prompt("plan it");
		writeFileSync(planFileOf(h), "# Plan\n- [ ] one\n");
		await h.command("mode", "default");
		await h.prompt("go");
		assert.ok(note(h.modeBlocks().at(-1)), "leaving plan mode by hand points at the plan file");

		// /new: an empty branch, a fresh session_start
		h.entries.length = 0;
		await h.session("new");
		await h.prompt("fresh");
		assert.equal(h.modeBlocks().length, 1);
		assert.ok(!note(h.modeBlocks().at(-1)), "the stale note is gone");

		// /resume into a branch that never saw the switch
		h.entries.length = 0;
		await h.session("resume");
		await h.prompt("resumed");
		assert.ok(!note(h.modeBlocks().at(-1)));
	});

	it("navigating the tree drops a note from the branch you left", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "plan");
		await h.prompt("plan it");
		writeFileSync(planFileOf(h), "# Plan\n- [ ] one\n");
		await h.command("mode", "default"); // idle: the note waits for the next prompt
		h.branch = [];
		await h.tree();
		await h.prompt("elsewhere");
		assert.ok(!note(h.modeBlocks().at(-1)), "the note stays with the branch that switched");
	});
});

describe("session grants end with the session", () => {
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

	const ASK_READ = /Reads outside the working directory/;
	const ASK = /Permission required/;
	const FETCH = "curl -s https://pypi.org/simple/requests/";

	it("a prefix, an outside-read directory and a fetch host are asked for again after /new", async () => {
		const sb = sandboxed();
		const data = `${realpathSync(sb.root)}/data`;
		mkdirSync(data, { recursive: true });
		writeFileSync(join(data, "a.txt"), "a\n");
		const h = await startPi({ sandbox: sb });
		await h.session();
		h.answer(ASK, "Yes, and don't ask again for `make test` this session");
		h.answer(ASK_READ, `Yes, and allow reading from ${data}/ this session`);
		h.answer(ASK, "Yes, and allow fetching from pypi.org this session");
		for (const run of [
			() => h.tool("bash", { command: "make test" }),
			() => h.tool("read", { path: join(data, "a.txt") }),
			() => h.tool("bash", { command: FETCH }),
		]) assert.equal((await run()).blocked, false);
		assert.equal(h.dialogs.length, 3);
		// all three now run unasked
		for (const run of [
			() => h.tool("bash", { command: "make test" }),
			() => h.tool("read", { path: join(data, "a.txt") }),
			() => h.tool("bash", { command: FETCH }),
		]) assert.equal((await run()).blocked, false);
		assert.equal(h.dialogs.length, 3);

		h.entries.length = 0;
		await h.session("new");
		await h.prompt("fresh");
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: "make test" })).blocked, true);
		await h.prompt("again"); // a rejection ends the run
		h.answer(ASK_READ, "No");
		assert.equal((await h.tool("read", { path: join(data, "a.txt") })).blocked, true);
		await h.prompt("again");
		h.answer(ASK, "No");
		assert.equal((await h.tool("bash", { command: FETCH })).blocked, true);
		assert.equal(h.dialogs.length, 6, "each call asks again");
		h.assertNoPendingAnswers();
	});

	it("the rules the model is told drop the old grants", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(ASK, "Yes, and don't ask again for `make test` this session");
		await h.tool("bash", { command: "make test" });
		await h.prompt("go");
		assert.match(h.modeBlocks().at(-1) ?? "", /make test/);
		h.entries.length = 0;
		await h.session("new");
		await h.prompt("fresh");
		assert.doesNotMatch(h.modeBlocks().at(-1) ?? "", /make test/);
	});

	it("a subagent child's session_start leaves the parent's grants alone, and a new parent session resets what children see", async () => {
		const sb = sandboxed();
		const parent = await startPi({ sandbox: sb });
		await parent.session();
		parent.answer(ASK, "Yes, and don't ask again for `make test` this session");
		await parent.tool("bash", { command: "make test" });
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		await child.session();
		await child.session("resume");
		assert.equal((await child.tool("bash", { command: "make test" })).blocked, false, "the child sees the parent's grant");
		assert.equal((await parent.tool("bash", { command: "make test" })).blocked, false, "and the parent keeps it");
		assert.equal(parent.dialogs.length, 1);

		parent.entries.length = 0;
		await parent.session("new");
		parent.answer(/Permission required \(subagent, default mode\)/, "No");
		assert.equal((await child.tool("bash", { command: "make test" })).blocked, true, "after the parent's /new the child asks again");
		parent.assertNoPendingAnswers();
	});
});
