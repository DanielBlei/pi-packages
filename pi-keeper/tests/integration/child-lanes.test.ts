/**
 * The child lanes, end to end: for every lane a pi-subagents child can run in
 * (mode × relay), what the child is told (its composed system prompt) must
 * match what the gate does to a gated call. One table drives both, so a
 * change to the prompt, the lane line or the rules that lets them disagree
 * fails here. The prompt/lane split itself is pinned by
 * tests/unit/child-prompts.test.ts.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { CHILD_PROMPTS } from "../../extensions/modes.ts";

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

interface Lane {
	name: string;
	entry: "child-plan" | "child-default" | "child-auto";
	relay: boolean;
	backgroundAuto: boolean;
	header: RegExp;
	laneLine: RegExp;
	/** A call this lane gates: asked through the parent's user with a relay, denied without. */
	gated: { tool: string; input: Record<string, unknown> };
}

const EDIT = { tool: "edit", input: { path: "src/a.ts", oldText: "a", newText: "b" } };
const PUSH = { tool: "bash", input: { command: "git push" } };
const INSTALL = { tool: "bash", input: { command: "npm install left-pad" } };

/** Every lane a child can run in (subagents-bridge.ts childModeFor + the child-*.ts entries). */
const LANES: Lane[] = [
	{ name: "L1 plan, relay", entry: "child-plan", relay: true, backgroundAuto: false, header: /# Subagent under plan mode/, laneLine: /Your lane: read-only plan child\./, gated: INSTALL },
	{ name: "L2 plan, no relay", entry: "child-plan", relay: false, backgroundAuto: false, header: /# Subagent under plan mode/, laneLine: /Your lane: read-only plan child\./, gated: INSTALL },
	{ name: "L3 default, relay", entry: "child-default", relay: true, backgroundAuto: false, header: /# Subagent permissions/, laneLine: /Your lane: default child with a relay\./, gated: EDIT },
	{ name: "L4 default, no relay", entry: "child-default", relay: false, backgroundAuto: false, header: /# Subagent permissions/, laneLine: /Your lane: default child with no relay\./, gated: EDIT },
	{ name: "L5 auto, relay", entry: "child-auto", relay: true, backgroundAuto: false, header: /# Subagent under auto mode/, laneLine: /Your lane: auto child with a relay\./, gated: PUSH },
	{ name: "L6 auto, no relay", entry: "child-default", relay: false, backgroundAuto: true, header: /# Subagent under auto mode/, laneLine: /Your lane: auto child with no relay\./, gated: PUSH },
];

async function start(lane: Lane): Promise<{ parent?: Harness; child: Harness }> {
	const sandbox = sandboxed();
	if (lane.backgroundAuto) writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), '{"backgroundAuto": true}');
	let parent: Harness | undefined;
	if (lane.relay) {
		// a parent with a TUI publishes the relay the child finds
		parent = await startPi({ sandbox });
		await parent.session();
	}
	const child = await startPi({ sandbox, entry: lane.entry });
	await child.session();
	return { parent, child };
}

describe("each child lane is told what its gate does", () => {
	for (const lane of LANES) {
		it(`${lane.name}: prompt, lane line and scratch line, in that order, before the agent's prompt`, async () => {
			const { child } = await start(lane);
			const composed = (await child.prompt("go")).systemPrompt;
			const header = composed.search(lane.header);
			const line = composed.search(lane.laneLine);
			const scratch = composed.search(/Scratch dir: /);
			assert.equal(header, 0, "the child's permissions come first, before the agent's own prompt");
			assert.ok(line > header, "lane line after the mode prompt");
			assert.ok(scratch > line, "scratch line after the lane line");
			assert.ok(composed.endsWith("\n\nBASE"), "the agent's own prompt (pi-subagents) comes last");
			// only the default lane with no relay stages its deliverables in the scratch dir
			if (lane.name.startsWith("L4 ")) assert.doesNotMatch(composed, /Don't put deliverables there/);
			else assert.match(composed, /Don't put deliverables there/);
			assert.doesNotMatch(composed, /\S {2,}\S/, "no double spaces");
			if (lane.relay) {
				assert.match(composed, /relayed to the parent's user/);
				assert.match(composed, /If an ask is rejected, do not retry it/);
				assert.doesNotMatch(composed, /no relay|no interactive user|fail-closed/);
			} else {
				assert.match(composed, /do not retry/);
				assert.doesNotMatch(composed, /relayed/);
			}
		});

		it(`${lane.name}: a gated ${lane.gated.tool} call is ${lane.relay ? "asked through the parent" : "denied"}`, async () => {
			const { parent, child } = await start(lane);
			if (parent !== undefined) parent.answer(/Permission required \(subagent/, "Yes");
			const outcome = await child.tool(lane.gated.tool, lane.gated.input);
			assert.equal(child.dialogs.length, 0, "a child never opens its own dialog");
			if (parent !== undefined) {
				assert.equal(parent.dialogs.length, 1, "the ask reached the parent's user");
				assert.equal(outcome.blocked, false);
				parent.assertNoPendingAnswers();
			} else {
				assert.equal(outcome.blocked, true);
				assert.match(outcome.reason ?? "", /do not retry it/);
				assert.match(outcome.reason ?? "", lane.laneLine.source.includes("plan") ? /read-only plan child/ : /with no relay/);
			}
		});
	}

	it("dangerous commands never run in a plan child, even with a relay (the plan prompt's invariant)", async () => {
		const { parent, child } = await start(LANES[0]);
		const outcome = await child.tool("bash", { command: "git push" });
		assert.equal(outcome.blocked, true);
		assert.equal(parent?.dialogs.length, 0);
		assert.match(outcome.reason ?? "", /do not retry it/i);
	});

	it("a rejected relayed ask tells the child to report, not to wait for a user", async () => {
		const { parent, child } = await start(LANES[2]);
		parent?.answer(/Permission required \(subagent/, "No");
		const outcome = await child.tool(EDIT.tool, EDIT.input);
		assert.equal(outcome.blocked, true);
		assert.match(outcome.reason ?? "", /Do not retry it; say in your final report/);
		assert.doesNotMatch(outcome.reason ?? "", /wait for the user/);
	});

	it("a child whose prompt file failed to load still gets its lane and scratch lines", async () => {
		const saved = CHILD_PROMPTS.default;
		CHILD_PROMPTS.default = "";
		try {
			const { child } = await start(LANES[3]);
			const composed = (await child.prompt("go")).systemPrompt;
			assert.match(composed, /^Your lane: default child with no relay\./);
			assert.match(composed, /Scratch dir: /);
		} finally {
			CHILD_PROMPTS.default = saved;
		}
	});

	it("a plan child has no active exit_plan_mode, and calling it changes nothing", async () => {
		const { child } = await start(LANES[1]);
		assert.equal(child.activeTools().includes("exit_plan_mode"), false);
		const run = await child.runTool("exit_plan_mode", {});
		assert.equal(run.isError, true);
	});
});

/**
 * A pi-subagents runner (a background child's process) also loads the
 * package's index.ts as an ambient extension when pi-keeper is
 * installed globally. Seen in a real run: every call was decided twice, and
 * the ambient copy — a UI-less default-mode "parent" — denied the child's
 * contact_supervisor. The ambient copy must stand down while a child entry
 * is loaded, and keep gating when none is (fail-closed).
 */
describe("a runner process with the ambient top-level copy loaded too", () => {
	const savedChildEnv = process.env.PI_SUBAGENT_CHILD;
	afterEach(() => {
		if (savedChildEnv === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = savedChildEnv;
	});

	const decides = (h: Harness) =>
		h.entries.filter((e) => e.customType === "pi-keeper-permission" && (e.data as { phase?: string }).phase === "decide");

	it("each call is decided once, by the child entry; contact_supervisor runs", async () => {
		const child = await startPi({ sandbox: sandboxed(), entry: "child-default", runnerWithAmbientCopy: true });
		await child.session();
		assert.equal((await child.tool("bash", { command: "pwd" })).blocked, false);
		assert.equal(decides(child).length, 1, "one decision per call");
		assert.equal((await child.tool("contact_supervisor", { reason: "need_decision", message: "x" })).blocked, false);
		const edit = await child.tool(EDIT.tool, EDIT.input);
		assert.equal(edit.blocked, true);
		assert.match(edit.reason ?? "", /default child with no relay/, "the child's lane denial, not the ambient parent's");
		const composed = (await child.prompt("go")).systemPrompt;
		assert.match(composed, /# Subagent permissions/);
		assert.doesNotMatch(composed, /# Default Mode/, "no parent mode prompt from the ambient copy");
	});

	it("a background-auto child's edits run: the ambient copy does not deny them", async () => {
		const sandbox = sandboxed();
		writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), '{"backgroundAuto": true}');
		const child = await startPi({ sandbox, entry: "child-default", runnerWithAmbientCopy: true });
		await child.session();
		assert.equal((await child.tool(EDIT.tool, EDIT.input)).blocked, false);
		assert.equal(child.dialogs.length, 0);
	});

	it("without a child entry the copy keeps gating (fail-closed)", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		const marker = Symbol.for("pi-keeper.child-gate.v1");
		const saved = root[marker];
		delete root[marker];
		try {
			const h = await startPi({ sandbox: sandboxed() });
			await h.session();
			h.answer(/Permission required/, "No");
			assert.equal((await h.tool(EDIT.tool, EDIT.input)).blocked, true);
			assert.equal(h.dialogs.length, 1);
		} finally {
			root[marker] = saved;
		}
	});
});
