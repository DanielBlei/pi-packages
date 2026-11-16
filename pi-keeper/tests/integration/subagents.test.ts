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
		// background asks off: the hint then follows backgroundAuto (with them on, background children ask the user like foreground ones)
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), '{"backgroundAuto": true, "backgroundAsks": false}');
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

	it("with autoSubagents on, auto registers child-auto; plan and default are unchanged", async () => {
		const sb = sandboxed();
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), '{"autoSubagents": true}');
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

	it("/keeper auto-subagents on re-registers without a restart; off goes back; the file follows", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "auto");
		assert.equal(registered(h), entryFile("default"));
		await h.command("keeper", "auto-subagents on");
		assert.equal(registered(h), entryFile("auto"));
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).autoSubagents, true);
		assert.ok(h.notifications.some((n) => /Allow subagents in auto mode: on/.test(n.message)));
		await h.command("keeper", "auto-subagents off");
		assert.equal(registered(h), entryFile("default"));
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).autoSubagents, false);
		// the setting applies in auto only: default and plan registrations don't move
		await h.command("mode", "plan");
		await h.command("keeper", "auto-subagents on");
		assert.equal(registered(h), entryFile("plan"));
	});

	it("an unchanged value notifies and re-registering keeps the current entry", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("keeper", "auto-subagents off");
		assert.ok(h.notifications.some((n) => /\(unchanged\)/.test(n.message)));
		// nothing to save: the file is not even created
		assert.equal(existsSync(join(sb.agentDir, "pi-keeper.json")), false);
	});

	it("/keeper background-auto toggles and saves; the bridge registration is untouched", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		assert.equal(registered(h), entryFile("default"));
		assert.deepEqual(h.complete("keeper", "background"), [
			{ value: "background-asks ", label: "background-asks", description: "Background subagent asks reach you: on" },
			{ value: "background-auto ", label: "background-auto", description: "Background subagents run auto when asks cannot reach you: off" },
			{ value: "background-ask-popup ", label: "background-ask-popup", description: "Background ask popup: idle" },
			{ value: "background-ask-timeout ", label: "background-ask-timeout", description: "Background ask timeout: 5 min" },
		]);
		// the child entry files read the config at launch, so no re-registration
		await h.command("keeper", "background-auto on");
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).backgroundAuto, true);
		assert.ok(h.notifications.some((n) => /Background subagents run auto when asks cannot reach you: on/.test(n.message)));
		assert.equal(registered(h), entryFile("default"));
		await h.command("keeper", "background-auto off");
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).backgroundAuto, false);
	});

	it("a wrong usage or unknown setting warns, and completions cover key and value", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("keeper", "nonsense");
		assert.ok(h.notifications.some((n) => /Unknown setting: nonsense/.test(n.message)));
		await h.command("keeper", "auto-subagents maybe");
		assert.ok(h.notifications.some((n) => /Usage: \/keeper auto-subagents <on\|off>/.test(n.message)));
		assert.deepEqual(
			h.complete("keeper", "auto-su"),
			[{ value: "auto-subagents ", label: "auto-subagents", description: "Allow subagents in auto mode: off" }],
		);
		assert.deepEqual(h.complete("keeper", "auto-subagents o"), [
			{ value: "auto-subagents on", label: "on", description: "Allow subagents in auto mode: off" },
			{ value: "auto-subagents off", label: "off", description: "Allow subagents in auto mode: off" },
		]);
		assert.equal(h.complete("keeper", "auto-subagents on x"), null);
	});

	it("without a UI the settings are listed as text", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb, ui: "none" });
		await h.session();
		await h.command("keeper");
		assert.ok(h.notifications.some((n) => /Allow subagents in auto mode: off/.test(n.message) && /Usage: \/keeper/.test(n.message)));
		// the argument form still works headless
		await h.command("keeper", "auto-subagents on");
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).autoSubagents, true);
	});

	it("the panel toggles on Enter and Esc closes it", async () => {
		const sb = sandboxed();
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "auto");
		// Subagents tab, row 0: Allow subagents in auto mode
		h.answer(/pi-keeper settings/, { keys: [KEY.tab, KEY.enter, KEY.escape] });
		await h.command("keeper");
		assert.equal(registered(h), entryFile("auto"));
		assert.equal(JSON.parse(readFileSync(join(sb.agentDir, "pi-keeper.json"), "utf8")).autoSubagents, true);
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
