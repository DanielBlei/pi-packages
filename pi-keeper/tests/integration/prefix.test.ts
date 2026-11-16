/**
 * The invariant this package exists for (docs/design.md, "Why the prefix is frozen"): the request
 * prefix — pi's system prompt plus the tool list — is byte-identical in every mode and
 * on every run, and everything that varies is appended to the conversation instead.
 *
 * A changed prefix is not a style problem: Claude's signed thinking blocks are bound to
 * it, so a switch mid-session can make every later request fail, and every model pays a
 * cache flush. So the assertions here are mostly negative on purpose: they fail if any
 * later change smuggles mode text, user rules or a lane hint back into the prompt.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, planFileOf, restoreBell, scratchOf, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { MODES } from "../../extensions/modes.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { contractSection, PLACEMENT_TEXT } from "../../extensions/prompt-blocks.ts";

function sandboxed(): Sandbox {
	const sb = makeSandbox();
	return sb;
}

describe("the request prefix is constant", () => {
	const sb = sandboxed();
	before(restoreBell);
	after(() => sb.cleanup());

	it("the system prompt and the tool list do not change across modes or runs", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();

		const prompts: string[] = [];
		const tools: string[] = [];
		const record = async (text = "go"): Promise<void> => {
			prompts.push((await h.prompt(text)).systemPrompt);
			tools.push([...h.activeTools()].sort().join(","));
		};

		await record(); // default
		await record(); // default again: a second run in the same mode
		await h.command("mode", "auto");
		await record();
		await h.command("mode", "plan");
		await record();
		await h.command("mode", "auto");
		await record();
		await h.command("mode", "default");
		await record();

		assert.deepEqual([...new Set(prompts)], [`BASE\n\n<pi_keeper>\n${contractSection()}\n</pi_keeper>`], "the prompt is pi's base plus the constant contract");
		assert.deepEqual([...new Set(tools)], [tools[0]], "the tool list is the same in every mode");
	});

	it("nothing that varies leaks into the prompt: no mode text, no rules line, no lane hint", async () => {
		const h = await startPi({ sandbox: sb, activeTools: ["read", "bash", "edit", "write", "subagent"] });
		await h.session();
		await h.command("mode", "plan");
		const { systemPrompt } = await h.prompt("go");
		for (const mode of ["default", "auto", "plan"] as const) {
			assert.ok(!systemPrompt.includes(MODES[mode].prompt), `prompts/${mode}-mode.md is in the prompt`);
		}
		assert.ok(!systemPrompt.includes("Your user's rules:"), "the rules line is in the prompt");
		assert.ok(!systemPrompt.includes("Subagents you launch"), "the lane hint is in the prompt");
		assert.ok(!systemPrompt.includes("Plan file:"), "the plan file line is in the prompt");
		// ...and they are all in the conversation instead
		const block = h.modeBlocks().at(-1) ?? "";
		assert.ok(block.includes(MODES.plan.prompt));
		assert.ok(block.includes("Subagents you launch"), "the lane hint is in the mode message");
		assert.ok(block.includes("Plan file:"));
	});

	it("the mode message is appended once and not repeated while nothing changes", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.prompt("one");
		assert.equal(h.modeBlocks().length, 1);
		await h.prompt("two");
		await h.prompt("three");
		assert.equal(h.modeBlocks().length, 1, "a second prompt in the same mode sends nothing");

		await h.command("mode", "auto");
		await h.prompt("four");
		assert.equal(h.modeBlocks().length, 2, "a switch appends the new mode");
		assert.match(h.modeBlocks()[1], /# Auto mode/);
	});

	it("a session grant re-sends the whole block, so the newest mode message always states the mode", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.prompt("go");
		const modes = h.modeBlocks().length;
		h.answer(/Permission required/, "Yes, and don't ask again for `make test` this session");
		await h.tool("bash", { command: "make test" });
		await h.prompt("go");
		assert.equal(h.modeBlocks().length, modes + 1, "the grant appends one full block");
		const block = h.modeBlocks().at(-1) ?? "";
		assert.match(block, /# Default mode/, "the newest message carries the mode, not only the rules");
		assert.match(block, /Your user's rules:/);
		assert.match(block, /make test/);
		assert.equal(h.rulesBlocks().length, 0, "a parent never sends a rules-only message");
		await h.prompt("again");
		assert.equal(h.modeBlocks().length, modes + 1, "and nothing more while nothing changes");
	});

	it("a rules-only message kept by a compaction does not vouch for the mode text", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.prompt("go");
		const delivered = [...h.entries].reverse().find((e) => e.type === "custom_message" && e.customType === "pi-keeper-mode");
		await h.compact();
		// a session from before the fix: the cut kept a rules message that claims the mode part
		h.entries.push({ type: "custom_message", id: "stale-rules", timestamp: new Date().toISOString(), customType: "pi-keeper-rules", content: "Your user's rules: x", display: false, details: (delivered as { details?: unknown }).details } as never);
		await h.prompt("after the compaction");
		assert.equal(h.modeBlocks().length, 2, "the mode text is re-sent");
	});

	it("a compaction re-delivers what it summarized away", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.prompt("go");
		assert.equal(h.modeBlocks().length, 1);
		await h.compact();
		await h.prompt("after the compaction");
		assert.equal(h.modeBlocks().length, 2, "the mode text survives a compaction that dropped it");
		assert.match(h.modeBlocks()[1], /# Default mode/);
		await h.prompt("and again");
		assert.equal(h.modeBlocks().length, 2, "and is not duplicated afterwards");
	});

	it("a busy compaction steers the mode text straight back", async () => {
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.prompt("go");
		h.idle = false;
		await h.compact({ reason: "threshold", willRetry: true });
		const steered = h.sentMessages.at(-1);
		assert.equal(steered?.options?.deliverAs, "steer");
		assert.equal(steered?.message.customType, "pi-keeper-mode");
		h.idle = true;
	});
});

describe("a subagent child's prompt is constant too", () => {
	const sb = sandboxed();
	before(restoreBell);
	after(() => sb.cleanup());

	it("its prompt keeps the same composition on every run, with its rules in a message", async () => {
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		await child.session();
		const first = (await child.prompt("go")).systemPrompt;
		const second = (await child.prompt("go")).systemPrompt;
		assert.equal(first, second, "a child's prompt is what it was on its first run");
		// the order real runs needed: its own permissions first, then the agent's instructions
		assert.match(first, /^# Subagent permissions/);
		assert.match(first, /rtk grep/, "the rtk nudge is not lost for children");
		assert.match(first, /`todo` tool/, "nor is the todo path");
		assert.ok(first.endsWith("\n\nBASE"));
		assert.equal(child.modeBlocks().length, 0, "a child has no mode message: its mode is fixed");
	});

	it("its rules line arrives once, not on every run", async () => {
		// a background child (no relay): its rules come from the project file, not a parent's UI
		const root = globalThis as unknown as Record<symbol, unknown>;
		const savedRelay = root[RELAY_KEY];
		delete root[RELAY_KEY];
		const own = sandboxed();
		mkdirSync(join(own.cwd, ".pi"), { recursive: true });
		writeFileSync(join(own.cwd, ".pi", "settings.local.json"), JSON.stringify({ "pi-keeper": { permissions: { deny: ["Bash(make deploy)"] } } }));
		try {
			const child = await startPi({ sandbox: own, entry: "child-default" });
			await child.session();
			await child.prompt("one");
			await child.prompt("two");
			assert.equal(child.rulesBlocks().length, 1, child.rulesBlocks().join("\n---\n"));
			assert.match(child.rulesBlocks()[0], /make deploy/);
		} finally {
			own.cleanup();
			if (savedRelay !== undefined) root[RELAY_KEY] = savedRelay;
		}
	});
});

describe("the modeInstructions escape hatch", () => {
	const sb = sandboxed();
	before(restoreBell);
	after(() => sb.cleanup());

	it('"prompt" puts the mode back into the system prompt, for small local models', async () => {
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), '{"modeInstructions": "prompt"}');
		const h = await startPi({ sandbox: sb });
		await h.session();
		const def = (await h.prompt("go")).systemPrompt;
		assert.ok(def.includes(MODES.default.prompt), "the mode text is in the prompt again");
		assert.equal(h.modeBlocks().length, 0, "and nothing is appended to the conversation");
		await h.command("mode", "plan");
		const plan = (await h.prompt("go")).systemPrompt;
		assert.ok(plan.includes(MODES.plan.prompt));
		assert.ok(!plan.includes(MODES.default.prompt));
		assert.ok(plan.includes(PLACEMENT_TEXT.prompt), "the contract says the mode is in the prompt");
		assert.ok(!plan.includes(PLACEMENT_TEXT.message), "...and not that it arrives as a message");
	});

	it('"prompt" keeps the mode text through a grant, a mid-run switch and a compaction', async () => {
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), '{"modeInstructions": "prompt"}');
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.prompt("go");
		h.answer(/Permission required/, "Yes, and don't ask again for `make test` this session");
		await h.tool("bash", { command: "make test" });
		let prompt = (await h.prompt("go")).systemPrompt;
		assert.ok(prompt.includes(MODES.default.prompt), "a grant does not drop the mode text");
		assert.match(prompt, /make test/);

		// a mid-run switch steers the block (persisted), then the next prompt must still compose it
		h.idle = false;
		await h.command("mode", "auto");
		h.idle = true;
		prompt = (await h.prompt("go")).systemPrompt;
		assert.ok(prompt.includes(MODES.auto.prompt), "a steered block does not count as delivered in prompt placement");

		const sent = h.sentMessages.length;
		h.idle = false;
		await h.compact({ reason: "threshold", willRetry: true });
		h.idle = true;
		assert.equal(h.sentMessages.length, sent, "a compaction keeps the system prompt: nothing to steer back");
		rmSync(join(sb.agentDir, "pi-keeper.json"));
	});
});

describe("a mid-run switch under the prompt placement", () => {
	const sb = sandboxed();
	before(restoreBell);
	after(() => {
		rmSync(join(sb.agentDir, "pi-keeper.json"), { force: true });
		sb.cleanup();
	});

	it("steers a short announcement, not the hidden mode block, and an idle switch sends nothing", async () => {
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), '{"modeInstructions": "prompt"}');
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.prompt("go");
		h.idle = false;
		await h.command("mode", "plan");
		h.idle = true;
		assert.equal(h.sentMessages.length, 1);
		const steered = h.sentMessages[0];
		assert.equal(steered.options?.deliverAs, "steer");
		assert.equal(steered.message.customType, "pi-keeper-mode-change");
		assert.match(String(steered.message.content), /^Mode changed: plan mode/);
		assert.match(String(steered.message.content), /Plan file: /);
		assert.equal(h.modeBlocks().length, 0, "no hidden mode block, mid-run or at the next prompt");
		await h.command("mode", "auto"); // idle: the next prompt carries it
		assert.equal(h.sentMessages.length, 1);
		const prompt = (await h.prompt("go")).systemPrompt;
		assert.ok(prompt.includes(MODES.auto.prompt));
		assert.equal(h.modeBlocks().length, 0);
	});

	it("message placement still steers the whole block", async () => {
		rmSync(join(sb.agentDir, "pi-keeper.json"), { force: true });
		const h = await startPi({ sandbox: sb });
		await h.session();
		await h.prompt("go");
		h.idle = false;
		await h.command("mode", "plan");
		h.idle = true;
		assert.equal(h.sentMessages.at(-1)?.message.customType, "pi-keeper-mode");
	});
});

describe("delivery bookkeeping across sessions and compactions", () => {
	const sb = sandboxed();
	before(restoreBell);
	after(() => sb.cleanup());

	it("a session from before the message placement (no mode entry yet) gets one block, once", async () => {
		const h = await startPi({
			sandbox: sb,
			entries: [{ type: "custom", id: "old", timestamp: new Date().toISOString(), customType: "pi-keeper", data: { mode: "default" } }],
		});
		await h.session("resume");
		await h.prompt("first");
		assert.equal(h.modeBlocks().length, 1);
		await h.prompt("second");
		assert.equal(h.modeBlocks().length, 1, "and none on the second prompt");
	});

	it("a child re-sends its rules message after a compaction swallowed it", async () => {
		const root = globalThis as unknown as Record<symbol, unknown>;
		const savedRelay = root[RELAY_KEY];
		delete root[RELAY_KEY];
		const own = sandboxed();
		mkdirSync(join(own.cwd, ".pi"), { recursive: true });
		writeFileSync(join(own.cwd, ".pi", "settings.local.json"), JSON.stringify({ "pi-keeper": { permissions: { deny: ["Bash(make deploy)"] } } }));
		try {
			const child = await startPi({ sandbox: own, entry: "child-default" });
			await child.session();
			await child.prompt("one");
			assert.equal(child.rulesBlocks().length, 1);
			await child.compact();
			await child.prompt("after the compaction");
			assert.equal(child.rulesBlocks().length, 2, "the rules survive a compaction that dropped them");
			await child.prompt("and again");
			assert.equal(child.rulesBlocks().length, 2);
		} finally {
			own.cleanup();
			if (savedRelay !== undefined) root[RELAY_KEY] = savedRelay;
		}
	});
});

describe("the plan-file and scratch lines the mode message names", () => {
	const sb = sandboxed();
	before(restoreBell);
	after(() => sb.cleanup());

	it("the plan file is named once the mode is plan mode", async () => {
		const h: Harness = await startPi({ sandbox: sb });
		await h.session();
		await h.command("mode", "plan");
		await h.prompt("go");
		const planFile = planFileOf(h);
		assert.ok(planFile.startsWith(join(sb.agentDir, "plans")), planFile);
		assert.ok(scratchOf(h).startsWith(sb.tmp));
	});
});
