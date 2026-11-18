/**
 * pi-subagents integration: the parent registers a child extension for its
 * mode and refuses `subagent` without it; children run in a forced mode and
 * never prompt. Goes through the real extension against the mock pi.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { REGISTRY_KEY } from "../../extensions/subagents-bridge.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";

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

const entryFile = (mode: string): string => realpathSync(fileURLToPath(new URL(`../../extensions/child-${mode}.ts`, import.meta.url)));
type Store = { version: number; bySession: Map<string, Array<{ id: string; path: string; requireForAllRunners: boolean }>> };
const root = globalThis as unknown as Record<symbol, unknown>;

// the registries are process-global: leave them as found
let saved: unknown;
let savedRelay: unknown;
beforeEach(() => {
	saved = root[REGISTRY_KEY];
	delete root[REGISTRY_KEY];
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(() => {
	if (saved === undefined) delete root[REGISTRY_KEY];
	else root[REGISTRY_KEY] = saved;
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
});

const registered = (h: Harness): string | undefined => (root[REGISTRY_KEY] as Store | undefined)?.bySession.get(h.sessionId)?.[0]?.path;

describe("parent: children load this extension in the parent's mode", () => {
	it("registers child-default at start; auto keeps it, plan swaps to child-plan, shutdown clears it", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		assert.equal(registered(h), entryFile("default"));
		assert.deepEqual((root[REGISTRY_KEY] as Store).bySession.get(h.sessionId), [{ id: "pi-keeper", path: entryFile("default"), requireForAllRunners: true }]);

		await h.command("mode", "auto");
		assert.equal(registered(h), entryFile("default"));
		await h.command("mode", "plan");
		assert.equal(registered(h), entryFile("plan"));
		await h.command("mode", "auto");
		assert.equal(registered(h), entryFile("default"));

		await h.shutdown();
		assert.equal(registered(h), undefined);
	});

	it("a resumed plan session registers child-plan", async () => {
		const h = await startPi({
			sandbox: sandboxed(),
			entries: [{ type: "custom", id: "e1", timestamp: "2026-01-01T00:00:00Z", customType: "pi-keeper", data: { mode: "plan", planFilePath: "/tmp/p.md" } }],
		});
		await h.session("resume");
		assert.equal(registered(h), entryFile("plan"));
	});

	it("leaving plan mode moves the registration back to child-default", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "plan");
		assert.equal(registered(h), entryFile("plan"));
		await h.command("mode", "default");
		assert.equal(registered(h), entryFile("default"));
	});
});

describe("parent: the /keeper setting lets an auto parent register child-auto", () => {
	it("the mode prompt carries the one-sentence parent hint about the children it can launch", async () => {
		const sb = sandboxed();
		// background asks off: the hint then follows backgroundAutoFallback (with them on, background children ask the user like foreground ones)
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), '{"backgroundAutoFallback": true, "backgroundAsks": false}');
		const h = await startPi({ sandbox: sb, activeTools: ["read", "bash", "edit", "write", "subagent"] });
		await h.session();
		await h.prompt("go");
		const withSubagent = h.modeBlocks().at(-1) ?? "";
		assert.match(withSubagent, /scout = explorer, worker = implementer, reviewer = checker; each runs in its lane/);
		assert.match(withSubagent, /background \(async\) children run in the auto lane and can write inside this directory/);
		await h.command("mode", "plan");
		await h.prompt("go");
		assert.match(h.modeBlocks().at(-1) ?? "", /stay read-only like you/);
		// background asks on (the default): background children ask this session's user
		const asking = await startPi({ sandbox: sandboxed(), activeTools: ["read", "bash", "edit", "write", "subagent"] });
		await asking.session();
		await asking.prompt("go");
		assert.match(asking.modeBlocks().at(-1) ?? "", /background \(async\) children ask the user through this session like foreground ones/);
		// without the subagent tool active there is nothing to hint about
		const bare = await startPi({ sandbox: sandboxed(), activeTools: ["read", "bash"] });
		await bare.session();
		await bare.prompt("go");
		assert.doesNotMatch(bare.modeBlocks().at(-1) ?? "", /scout = explorer/);
	});

	it("with subagentsFollowAuto on, auto registers child-auto; plan and default are unchanged", async () => {
		const sb = sandboxed();
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), '{"subagentsFollowAuto": true}');
		const h = await startPi({ sandbox: sb });
		await h.session();
		assert.equal(registered(h), entryFile("default"));
		await h.command("mode", "auto");
		assert.equal(registered(h), entryFile("auto"));
		await h.command("mode", "plan");
		assert.equal(registered(h), entryFile("plan"));
		await h.command("mode", "auto");
		assert.equal(registered(h), entryFile("auto"));
		await h.command("mode", "default");
		assert.equal(registered(h), entryFile("default"));
	});

	it("/keeper subagents-follow-auto on re-registers without a restart; off goes back; the file follows", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "auto");
		assert.equal(registered(h), entryFile("default"));
		await h.command("keeper", "subagents-follow-auto on");
		assert.equal(registered(h), entryFile("auto"));
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).subagentsFollowAuto, true);
		assert.ok(h.notifications.some((n) => /Subagents follow auto mode: on/.test(n.message)));
		await h.command("keeper", "subagents-follow-auto off");
		assert.equal(registered(h), entryFile("default"));
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).subagentsFollowAuto, false);
		// the setting applies in auto only: default and plan registrations don't move
		await h.command("mode", "plan");
		await h.command("keeper", "subagents-follow-auto on");
		assert.equal(registered(h), entryFile("plan"));
	});

	it("an unchanged value notifies and re-registering keeps the current entry", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("keeper", "subagents-follow-auto off");
		assert.ok(h.notifications.some((n) => /\(unchanged\)/.test(n.message)));
		// nothing to save: the file is not even created
		assert.equal(existsSync(join(sb.agentDir, "pi-keeper.json")), false);
	});

	it("/keeper background-auto-fallback toggles and saves; the bridge registration is untouched", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		assert.equal(registered(h), entryFile("default"));
		assert.deepEqual(h.complete("keeper", "background"), [
			{ value: "background-asks ", label: "background-asks", description: "Background subagents can ask you: on" },
			{ value: "background-auto-fallback ", label: "background-auto-fallback", description: "Run auto when a background subagent can't ask: off" },
			{ value: "background-ask-popup ", label: "background-ask-popup", description: "When background asks pop up: always" },
			{ value: "background-ask-timeout ", label: "background-ask-timeout", description: "Background ask timeout: 5 min" },
		]);
		// the child entry files read the config at launch, so no re-registration
		await h.command("keeper", "background-auto-fallback on");
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).backgroundAutoFallback, true);
		assert.ok(h.notifications.some((n) => /Run auto when a background subagent can't ask: on/.test(n.message)));
		assert.equal(registered(h), entryFile("default"));
		await h.command("keeper", "background-auto-fallback off");
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).backgroundAutoFallback, false);
	});

	it("a wrong usage or unknown setting warns, and completions cover key and value", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("keeper", "nonsense");
		assert.ok(h.notifications.some((n) => /Unknown setting: nonsense/.test(n.message)));
		await h.command("keeper", "subagents-follow-auto maybe");
		assert.ok(h.notifications.some((n) => /Usage: \/keeper subagents-follow-auto <on\|off>/.test(n.message)));
		assert.deepEqual(
			h.complete("keeper", "subagents-f"),
			[{ value: "subagents-follow-auto ", label: "subagents-follow-auto", description: "Subagents follow auto mode: off" }],
		);
		assert.deepEqual(h.complete("keeper", "subagents-follow-auto o"), [
			{ value: "subagents-follow-auto on", label: "on", description: "Subagents follow auto mode: off" },
			{ value: "subagents-follow-auto off", label: "off", description: "Subagents follow auto mode: off" },
		]);
		assert.equal(h.complete("keeper", "subagents-follow-auto on x"), null);
	});

	it("without a UI the settings are listed as text", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb, ui: "none" });
		await h.session();
		await h.command("keeper");
		assert.ok(h.notifications.some((n) => /Subagents follow auto mode: off/.test(n.message) && /Usage: \/keeper/.test(n.message)));
		// the argument form still works headless
		await h.command("keeper", "subagents-follow-auto on");
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).subagentsFollowAuto, true);
	});

	it("the panel toggles on Enter and Esc closes it", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "auto");
		// Subagents tab, row 0: Subagents follow auto mode
		h.answer(/pi-keeper settings/, { keys: [KEY.tab, KEY.enter, KEY.escape] });
		await h.command("keeper");
		assert.equal(registered(h), entryFile("auto"));
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).subagentsFollowAuto, true);
	});
});

describe("parent: subagent is allowed only while the bridge works", () => {
	for (const mode of ["default", "auto", "plan"]) {
		it(`allowed in ${mode} with the bridge registered`, async () => {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			assert.equal((await h.tool("subagent", { agent: "worker", task: "x" })).blocked, false);
		});

		it(`denied in ${mode} with an explanation when the registry is malformed`, async () => {
			root[REGISTRY_KEY] = { version: 2, bySession: new Map() };
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			const outcome = await h.tool("subagent", { agent: "worker", task: "x" });
			assert.equal(outcome.blocked, true);
			assert.match(outcome.reason ?? "", /couldn't attach to subagent children; refusing to launch unchecked subagents/);
			// everything else still works
			assert.equal((await h.tool("read", { path: "a.txt" })).blocked, false);
		});
	}

	it("denied when someone else holds the session's registration", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		root[REGISTRY_KEY] = { version: 1, bySession: new Map([[h.sessionId, Object.freeze([Object.freeze({ id: "theirs", path: "/x.ts" })])]]) };
		await h.session();
		assert.equal((await h.tool("subagent", { task: "x" })).blocked, true);
		assert.equal((root[REGISTRY_KEY] as Store).bySession.get(h.sessionId)?.[0].id, "theirs");
	});

	it("denied once the registration is replaced behind our back", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		assert.equal((await h.tool("subagent", { task: "x" })).blocked, false);
		(root[REGISTRY_KEY] as Store).bySession.delete(h.sessionId);
		assert.equal((await h.tool("subagent", { task: "x" })).blocked, true);
	});

	it("denied after shutdown", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.shutdown();
		assert.equal((await h.tool("subagent", { task: "x" })).blocked, true);
	});

	it("without pi-subagents's bridge, pi-keeper starts, the modes and ordinary tools work, and only subagent is refused", async () => {
		// pi-keeper cannot register with pi-subagents (the registry it finds is not one it can use): the case the guide's "could not register" means
		root[REGISTRY_KEY] = { version: 2, bySession: new Map() };
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		assert.deepEqual(h.notifications.filter((n) => n.type === "error"), [], "the session starts without an error");
		for (const mode of ["auto", "plan", "default"] as const) {
			await h.command("mode", mode);
			// each mode's edit verdict shows the switch took: plan denies, auto runs, default asks
			const edit = { path: "src/a.ts", oldText: "a", newText: "b" };
			if (mode === "plan") assert.match((await h.tool("edit", edit)).reason ?? "", /Plan mode is active/, "plan: edit denied");
			if (mode === "auto") assert.equal((await h.tool("edit", edit)).blocked, false, "auto: edit runs");
			if (mode === "default") {
				h.answer(/Permission required/, "No");
				assert.equal((await h.tool("edit", edit)).blocked, true, "default: edit asks");
				assert.equal(h.dialogs.length, 1, "default: one dialog");
			}
			assert.equal((await h.tool("read", { path: "a.txt" })).blocked, false, `${mode}: read`);
			assert.equal((await h.tool("bash", { command: "git status" })).blocked, false, `${mode}: read-only bash`);
			const denied = await h.tool("subagent", { agent: "worker", task: "x" });
			assert.equal(denied.blocked, true, `${mode}: subagent`);
			assert.match(denied.reason ?? "", /couldn't attach to subagent children; refusing to launch unchecked subagents/, mode);
		}
	});
});

describe("child under plan mode", () => {
	it("reads, and the protocol tools, are allowed", async () => {
		const h = await startPi({ sandbox: sandboxed(), entry: "child-plan" });
		await h.session();
		for (const tool of ["read", "contact_supervisor", "structured_output", "bg_wait", "subagent"]) {
			assert.equal((await h.tool(tool, { path: "a.txt" })).blocked, false, tool);
		}
		assert.equal((await h.tool("bash", { command: "git status" })).blocked, false);
	});

	it("edits, writes (also to a plan-like path) and mutating bash are denied, without throwing or a dialog", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb, entry: "child-plan" });
		await h.session();
		for (const [tool, input] of [
			["edit", { path: "src/a.ts", oldText: "a", newText: "b" }],
			["write", { path: "src/a.ts", content: "x" }],
			["write", { path: `${sb.agentDir}/plans/p.md`, content: "x" }],
			["bash", { command: "npm test" }],
			["bash", { command: "git push" }],
			["mcp", { tool: "x" }],
		] as const) {
			const outcome = await h.tool(tool, { ...input });
			assert.equal(outcome.blocked, true, `${tool} ${JSON.stringify(input)}`);
			assert.match(outcome.reason ?? "", /not allowed in your lane|is denied: you are a|dangerous command/);
		}
		assert.deepEqual(h.dialogs, []);
	});

	it("scratch files are writable", async () => {
		const h = await startPi({ sandbox: sandboxed(), entry: "child-plan" });
		await h.session();
		const prompt = await h.prompt("go");
		const scratch = /Scratch dir: (\S+)/.exec(prompt.systemPrompt)?.[1];
		assert.ok(scratch);
		assert.equal((await h.tool("write", { path: `${scratch}/notes.md`, content: "x" })).blocked, false);
	});

	it("a restored auto entry is ignored; no plan file, tools or state entry are touched", async () => {
		const h = await startPi({
			sandbox: sandboxed(),
			entry: "child-plan",
			entries: [{ type: "custom", id: "e1", timestamp: "2026-01-01T00:00:00Z", customType: "pi-keeper", data: { mode: "auto", planFilePath: "/tmp/parent-plan.md" } }],
		});
		const tools = h.activeTools();
		await h.session("fork");
		await h.tree();
		assert.equal((await h.tool("edit", { path: "src/a.ts" })).blocked, true);
		assert.equal((await h.tool("edit", { path: "/tmp/parent-plan.md" })).blocked, true);
		assert.equal((await h.tool("bash", { command: "npm test" })).blocked, true);
		assert.deepEqual(h.activeTools(), tools);
		assert.equal(h.entries.filter((e) => e.customType === "pi-keeper").length, 1);
		assert.deepEqual(h.statuses, []);
	});

	it("registers nothing and cannot switch mode", async () => {
		const h = await startPi({ sandbox: sandboxed(), entry: "child-plan" });
		await h.session();
		assert.equal(root[REGISTRY_KEY], undefined);
		await h.command("mode", "auto");
		await h.command("plan");
		await h.shortcut("alt+m");
		assert.equal((await h.tool("edit", { path: "src/a.ts" })).blocked, true);
		assert.equal((await h.tool("bash", { command: "npm test" })).blocked, true);
		assert.deepEqual(h.sentMessages, []);
	});

	it("uses the child prompt, not the plan-mode prompt", async () => {
		const h = await startPi({ sandbox: sandboxed(), entry: "child-plan" });
		await h.session();
		const { systemPrompt } = await h.prompt("go");
		assert.match(systemPrompt, /Subagent under plan mode/);
		assert.doesNotMatch(systemPrompt, /exit_plan_mode`: it|Plan file:/);
	});
});

describe("child under default mode (no UI)", () => {
	it("edit is denied with the approval message; read-only bash and protocol tools are allowed", async () => {
		const h = await startPi({ sandbox: sandboxed(), entry: "child-default" });
		await h.session();
		const edit = await h.tool("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(edit.blocked, true);
		assert.match(edit.reason ?? "", /is denied: you are a default child with no relay, and every mutation is denied for every path/);
		assert.match((await h.prompt("go")).systemPrompt, /Your lane: default child with no relay\./);
		assert.equal((await h.tool("bash", { command: "git status" })).blocked, false);
		assert.equal((await h.tool("bash", { command: "npm test" })).blocked, true);
		assert.equal((await h.tool("structured_output", {})).blocked, false);
		assert.equal((await h.tool("contact_supervisor", {})).blocked, false);
		assert.deepEqual(h.dialogs, []);
	});

	it("still never prompts if a UI is present", async () => {
		const h = await startPi({ sandbox: sandboxed(), entry: "child-default", ui: "tui" });
		await h.session();
		assert.equal((await h.tool("edit", { path: "src/a.ts" })).blocked, true);
		assert.deepEqual(h.dialogs, []);
	});

	it("a restored auto entry is ignored", async () => {
		const h = await startPi({
			sandbox: sandboxed(),
			entry: "child-default",
			entries: [{ type: "custom", id: "e1", timestamp: "2026-01-01T00:00:00Z", customType: "pi-keeper", data: { mode: "auto" } }],
		});
		await h.session("fork");
		assert.equal((await h.tool("bash", { command: "npm test" })).blocked, true);
		assert.match((await h.prompt("go")).systemPrompt, /# Subagent permissions/);
	});

	it("the protocol tools are not allowed outside a child (plan fallback denies)", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "plan");
		assert.equal((await h.tool("contact_supervisor", {})).blocked, true);
	});
});

/**
 * A workflow, `parallel`, `tasks` or `chain` child is launched by pi-subagents
 * itself, with a `subagent_launch` call the model never sees (upstream 0.85+).
 * The same bridge rule covers it, and the commands and the output write it
 * carries are judged with the mode's own rules.
 */
describe("parent: workflow children (subagent_launch)", () => {
	const launch = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ workflowRunId: "w1", key: "task-1", agent: "scout", task: "find the parser", ...extra });

	for (const mode of ["default", "auto", "plan"]) {
		it(`a plain child is allowed in ${mode} with the bridge registered`, async () => {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			assert.equal((await h.tool("subagent_launch", launch())).blocked, false);
			assert.deepEqual(h.dialogs, []);
		});

		it(`denied in ${mode} when the bridge is missing, like subagent`, async () => {
			root[REGISTRY_KEY] = { version: 2, bySession: new Map() };
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			const outcome = await h.tool("subagent_launch", launch());
			assert.equal(outcome.blocked, true);
			assert.match(outcome.reason ?? "", /couldn't attach to subagent children; refusing to launch unchecked subagents/);
		});
	}

	it("a read-only command the child leaves behind runs without a dialog in default and plan", async () => {
		for (const mode of ["default", "plan"]) {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			assert.equal((await h.tool("subagent_launch", launch({ commands: [{ command: "git status" }] }))).blocked, false, mode);
			assert.deepEqual(h.dialogs, [], mode);
		}
	});

	it("plan mode asks about a command the child would run, naming it", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "plan");
		h.answer(/Permission required \(plan mode\)/, /^Yes$/);
		assert.equal((await h.tool("subagent_launch", launch({ commands: [{ command: "npm test" }] }))).blocked, false);
		assert.equal(h.dialogs.length, 1);
		assert.match(h.dialogs[0].title, /task-1 \(scout\)/);
		assert.match(h.dialogs[0].title, /The child leaves this behind: bash: npm test\./);
		assert.deepEqual(h.dialogs[0].options, ["Yes", "No", "No, and tell pi what to do instead"]);
	});

	it("plan mode denies a dangerous command the child would run, before any dialog, and names it", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "plan");
		const outcome = await h.tool("subagent_launch", launch({ commands: [{ command: "rm -rf /" }] }));
		assert.equal(outcome.blocked, true);
		assert.match(outcome.reason ?? "", /Plan mode is active: the workflow child's own command \(bash: rm -rf \/\) is dangerous/);
		assert.deepEqual(h.dialogs, []);
	});

	it("auto mode asks about a dangerous command and runs a plain one", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "auto");
		assert.equal((await h.tool("subagent_launch", launch({ commands: [{ command: "npm test" }] }))).blocked, false);
		assert.deepEqual(h.dialogs, []);
		h.answer(/Permission required \(auto mode\)/, "No");
		assert.equal((await h.tool("subagent_launch", launch({ commands: [{ command: "rm -rf /" }] }))).blocked, true);
		assert.equal(h.dialogs.length, 1);
	});

	it("default mode asks once for the child's own non-read-only command", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(/Permission required \(default mode\)/, "No");
		assert.equal((await h.tool("subagent_launch", launch({ commands: [{ command: "npm test" }] }))).blocked, true);
		assert.match(h.dialogs[0].title, /The child leaves this behind: bash: npm test\./);
	});

	it("a command that sets env, or runs outside the project, asks in every mode, even a read-only one", async () => {
		for (const mode of ["default", "auto", "plan"]) {
			for (const [extra, hint] of [
				[{ env: { GIT_PAGER: "sh -c id" } }, /sets GIT_PAGER in its environment/],
				[{ cwd: "/" }, /runs in \/, outside this project/],
			] as const) {
				const h = await startPi({ sandbox: sandboxed() });
				await h.session();
				await h.command("mode", mode);
				h.answer(/Permission required/, "No");
				const outcome = await h.tool("subagent_launch", launch({ commands: [{ command: "git status", ...extra }] }));
				assert.equal(outcome.blocked, true, `${mode} ${JSON.stringify(extra)}`);
				assert.equal(h.dialogs.length, 1, `${mode} ${JSON.stringify(extra)}`);
				assert.match(h.dialogs[0].title, /The child leaves this behind: bash: git status/);
				assert.match(h.dialogs[0].title, hint);
				assert.deepEqual(h.dialogs[0].options, ["Yes", "No", "No, and tell pi what to do instead"]);
			}
		}
	});

	it("a command whose cwd is inside the project, and a plain command, are not asked about when read-only", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		assert.equal((await h.tool("subagent_launch", launch({ commands: [{ command: "git status", cwd: sb.cwd }] }))).blocked, false);
		assert.deepEqual(h.dialogs, []);
	});

	it("a session approval of the command from a normal bash call covers the same gate command in a launch", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(/Permission required \(default mode\)/, /don't ask again/);
		assert.equal((await h.tool("bash", { command: "npm test" })).blocked, false);
		assert.equal(h.dialogs.length, 1);
		assert.equal((await h.tool("subagent_launch", launch({ commands: [{ command: "npm test" }] }))).blocked, false);
		assert.equal(h.dialogs.length, 1, "the launch asked nothing more");
	});

	it("a launch whose commands this check cannot read asks instead of passing", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(/Permission required/, "No");
		assert.equal((await h.tool("subagent_launch", launch({ commands: "git status" }))).blocked, true);
		assert.match(h.dialogs[0].title, /commands: a list this check cannot read/);
	});

	it("the dialog offers no don't-ask-again or always-allow option, and N launches ask N times", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		for (let i = 1; i <= 3; i++) h.answer(/Permission required \(default mode\)/, "Yes");
		for (let i = 1; i <= 3; i++) {
			assert.equal((await h.tool("subagent_launch", launch({ key: `task-${i}`, commands: [{ command: "npm test" }] }))).blocked, false, `launch ${i}`);
		}
		assert.equal(h.dialogs.length, 3, "one dialog per launch");
		for (const dialog of h.dialogs) assert.ok(!dialog.options.some((o) => /ask again|always allow|this session|in this project/.test(o)), JSON.stringify(dialog.options));
		h.assertNoPendingAnswers();
	});

	it("the output file is judged as a write: denied in plan mode outside the artifact dirs, asked in default", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "plan");
		const refused = await h.tool("subagent_launch", launch({ output: join(sb.cwd, "report.md") }));
		assert.equal(refused.blocked, true);
		assert.match(refused.reason ?? "", /only the plan file .* can be changed, so the workflow child's own write \(write .*report\.md\) is blocked/);

		await h.command("mode", "default");
		h.answer(/Permission required \(default mode\)/, "No");
		assert.equal((await h.tool("subagent_launch", launch({ output: join(sb.cwd, "report.md") }))).blocked, true);
		assert.match(h.dialogs.at(-1)?.title ?? "", /The child leaves this behind: write .*report\.md\./);
	});

	it("a child's artifact report stays writable, so a scout with output is not blocked", async () => {
		const sb = sandboxed();
		const artifact = join(sb.agentDir, "sessions", "s1", "subagent-artifacts", "outputs", "run1", "context.md");
		for (const mode of ["default", "plan"]) {
			const h = await startPi({ sandbox: sb });
			await h.session();
			await h.command("mode", mode);
			assert.equal((await h.tool("subagent_launch", launch({ output: artifact }))).blocked, false, mode);
		}
	});

	it("the tool can't be listed as read-only, so a config entry cannot bypass the bridge", async () => {
		const sb = sandboxed();
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), '{"readOnlyTools": ["subagent_launch"]}');
		root[REGISTRY_KEY] = { version: 2, bySession: new Map() };
		const h = await startPi({ sandbox: sb });
		await h.session();
		assert.equal((await h.tool("subagent_launch", launch())).blocked, true);
		assert.ok(h.notifications.some((n) => /readOnlyTools: ignored "subagent_launch"/.test(n.message)));
	});
});

/**
 * A single child (`subagent` with agent + task) runs its `gate` and `acceptance.verify`
 * commands and writes its `output` itself, so the gate judges them like a workflow child's.
 */
describe("parent: single subagent launches (gate, acceptance, output)", () => {
	const single = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ agent: "worker", task: "x", ...extra });

	it("options.gate runs a shell command: asked in default and auto, not allowed in plan", async () => {
		for (const mode of ["default", "auto", "plan"]) {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			h.answer(/Permission required/, "No");
			const outcome = await h.tool("subagent", single({ options: { gate: "rm -rf ~/x" } }));
			assert.equal(outcome.blocked, true, mode);
			assert.match(outcome.reason ?? h.dialogs[0]?.title ?? "", /rm -rf/, mode);
		}
	});

	it("a single child's gate: the dialog offers no remember option either, and N launches ask N times", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		for (let i = 0; i < 2; i++) h.answer(/Permission required \(default mode\)/, "Yes");
		for (let i = 0; i < 2; i++) assert.equal((await h.tool("subagent", single({ options: { gate: "npm test" } }))).blocked, false, `launch ${i + 1}`);
		assert.equal(h.dialogs.length, 2, "one dialog per launch");
		for (const dialog of h.dialogs) assert.ok(!dialog.options.some((o) => /ask again|always allow|this session|in this project/.test(o)), JSON.stringify(dialog.options));
		h.assertNoPendingAnswers();
	});

	it("a flat top-level gate is judged the same way", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(/Permission required \(default mode\)/, "No");
		assert.equal((await h.tool("subagent", single({ gate: "rm -rf ~/x" }))).blocked, true);
		assert.match(h.dialogs[0]?.title ?? "", /The child leaves this behind: bash: rm -rf ~\/x\./);
	});

	it("an absolute output path outside the project is not allowed silently in auto", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "auto");
		h.answer(/Permission required/, "No");
		assert.equal((await h.tool("subagent", single({ output: "/home/someone/.bashrc" }))).blocked, true);
		assert.equal(h.dialogs.length, 1);
	});

	it("acceptance as a JSON string with an env entry asks in every mode", async () => {
		for (const mode of ["default", "auto", "plan"]) {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			h.answer(/Permission required/, "No");
			// a read-only command, so the env hazard (not the command itself) is what asks
			const acceptance = '{"verify":[{"command":"git status","env":{"API_TOKEN":"x"}}]}';
			assert.equal((await h.tool("subagent", single({ acceptance }))).blocked, true, mode);
			assert.match(h.dialogs[0]?.title ?? "", /sets API_TOKEN in its environment/, mode);
		}
	});

	it("acceptance that is a JSON list, not an object, asks (pi-subagents throws on it)", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(/Permission required/, "No");
		assert.equal((await h.tool("subagent", single({ acceptance: "[1]" }))).blocked, true);
		assert.match(h.dialogs[0]?.title ?? "", /acceptance: a value this check cannot read/);
	});

	it("schedule.create judges its gate: not allowed in any mode", async () => {
		for (const mode of ["default", "auto", "plan"]) {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			h.answer(/Permission required/, "No");
			const outcome = await h.tool("subagent", { action: "schedule.create", every: "1h", options: { gate: "rm -rf ~/x" } });
			assert.equal(outcome.blocked, true, mode);
		}
	});

	it("schedule.create of a workflow asks in every mode: its children run later with no tool call to judge them", async () => {
		for (const mode of ["default", "auto", "plan"]) {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			h.answer(/Permission required/, "No");
			assert.equal((await h.tool("subagent", { action: "schedule.create", every: "1h", workflow: true })).blocked, true, mode);
			assert.match(h.dialogs[0]?.title ?? "", /workflow script that runs later/, mode);
		}
	});

	it("guards: schedule.create with a plain scout task, and schedule.list, are unchanged (no dialog in plan)", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "plan");
		assert.equal((await h.tool("subagent", { action: "schedule.create", agent: "scout", task: "look", every: "1h" })).blocked, false);
		assert.equal((await h.tool("subagent", { action: "schedule.list" })).blocked, false);
		assert.deepEqual(h.dialogs, []);
	});

	it("acceptance that is not valid JSON asks", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		h.answer(/Permission required/, "No");
		assert.equal((await h.tool("subagent", single({ acceptance: "{not json" }))).blocked, true);
		assert.match(h.dialogs[0]?.title ?? "", /acceptance: JSON this check cannot read/);
	});

	it("an output path that leaves the run's directory asks in every mode", async () => {
		for (const mode of ["default", "auto", "plan"]) {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			await h.command("mode", mode);
			h.answer(/Permission required/, "No");
			assert.equal((await h.tool("subagent", single({ output: "../../x.md" }))).blocked, true, mode);
			assert.match(h.dialogs[0]?.title ?? "", /write: output path \.\.\/\.\.\/x\.md leaves the run's directory/, mode);
		}
	});

	it("guards: a plain scout, a scout with a relative output, and acceptance 'checked' are allowed in plan with no dialog", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "plan");
		assert.equal((await h.tool("subagent", { agent: "scout", task: "look" })).blocked, false);
		assert.equal((await h.tool("subagent", { agent: "scout", task: "look", output: "context.md" })).blocked, false);
		assert.equal((await h.tool("subagent", single({ acceptance: "checked" }))).blocked, false);
		assert.deepEqual(h.dialogs, []);
	});

	it("guards: a workflow or multi-child call, or a management action, is not judged on these fields here", async () => {
		const h = await startPi({ sandbox: sandboxed() });
		await h.session();
		await h.command("mode", "auto");
		const calls: Array<Record<string, unknown>> = [
			{ tasks: [{ agent: "scout", task: "look" }], options: { gate: "rm -rf ~/x" } },
			{ workflow: "./flow.js", options: { gate: "rm -rf ~/x" } },
			{ action: "status", id: "run1", options: { gate: "rm -rf ~/x" } },
		];
		for (const input of calls) assert.equal((await h.tool("subagent", input)).blocked, false, JSON.stringify(input));
		assert.deepEqual(h.dialogs, []);
	});
});
