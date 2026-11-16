/**
 * The composed model-facing text: one constant section, one mode message, one
 * rules message. Run: npm test
 *
 * These strings are the contract with the model (docs/architecture.md,
 * "Model-facing text"), so they are pinned here: the section stays constant and
 * short, the mode block carries the plan-file line and the closing instruction,
 * and nothing leaks the other channel's content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SEARCH_HINT, CONTRACT, MODE_ANNOUNCEMENTS, MODES, RTK_SEARCH_HINT } from "../../extensions/modes.ts";
import {
	childTail,
	contractSection,
	fallbackModeText,
	MODE_MESSAGE,
	modeBlock,
	nextDelivery,
	PLACEMENT_TEXT,
	planFileLine,
	RULES_MESSAGE,
	rulesBlock,
	TODO_PATH,
} from "../../extensions/prompt-blocks.ts";

test("the contract loads and stays short", () => {
	assert.ok(CONTRACT !== "", "prompts/contract.md did not load");
	const lines = CONTRACT.split("\n").length;
	assert.ok(lines <= 30, `prompts/contract.md grew to ${lines} lines: move mode-specific rules into prompts/<mode>-mode.md`);
});

test("the contract is the mode-independent half: it never names a mode's own list", () => {
	for (const mode of ["default", "auto", "plan"] as const) {
		const modeText = MODES[mode].prompt;
		// every heading of a mode prompt must not be repeated in the contract
		for (const line of modeText.split("\n").filter((l) => l.startsWith("# "))) {
			assert.ok(!CONTRACT.includes(line), `the contract repeats the mode heading ${JSON.stringify(line)}`);
		}
	}
});

test("the contract section is constant, ordered and carries the search nudge and the todo path", () => {
	const section = contractSection("message", true);
	assert.ok(section.startsWith(CONTRACT === "" ? "You work under" : CONTRACT.slice(0, 20)));
	assert.ok(section.includes(RTK_SEARCH_HINT), "the rtk nudge is missing");
	assert.ok(section.includes(TODO_PATH), "the todo path is missing");
	assert.ok(section.indexOf(RTK_SEARCH_HINT) < section.indexOf(TODO_PATH));
	assert.equal(section, contractSection("message", true), "the section must be deterministic: it is the cached prefix");
});

test("without rtk the section names the built-in tools instead of a binary that is not there", () => {
	const section = contractSection("message", false);
	assert.ok(section.includes(BUILTIN_SEARCH_HINT), "the built-in nudge is missing");
	assert.ok(!section.includes("rtk grep"), "no model is sent to rtk when rtk is absent");
	assert.ok(section.includes(TODO_PATH));
	assert.ok(section.indexOf(BUILTIN_SEARCH_HINT) < section.indexOf(TODO_PATH));
	assert.ok(!section.includes(RTK_SEARCH_HINT), "the rtk nudge must not be sent alongside the built-in one");
});

test("both channels carry the todo path; a subagent gets it without the contract", () => {
	assert.match(TODO_PATH, /`todo` tool/);
	assert.match(childTail(true), /`todo` tool/);
	assert.match(childTail(true), /rtk grep/);
	assert.match(childTail(false), /built-in `grep`/);
	assert.ok(!childTail(true).includes(CONTRACT === "" ? "permission layer" : CONTRACT));
});

test("the mode block orders prompt, plan-file line, lane hint and the closing instruction", () => {
	const block = modeBlock({
		modeText: "MODE TEXT",
		mode: "plan",
		planFile: "/tmp/plan.md",
		laneHint: "LANE HINT",
		tail: MODE_ANNOUNCEMENTS.plan,
	});
	const order = ["MODE TEXT", "Plan file: /tmp/plan.md", "LANE HINT", MODE_ANNOUNCEMENTS.plan].map((part) => block.indexOf(part));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	assert.equal(block, modeBlock({ modeText: "MODE TEXT", mode: "plan", planFile: "/tmp/plan.md", laneHint: "LANE HINT", tail: MODE_ANNOUNCEMENTS.plan }));
});

test("the mode block leaves out what a mode does not have", () => {
	const block = modeBlock({ modeText: "MODE TEXT", mode: "auto", tail: MODE_ANNOUNCEMENTS.auto });
	assert.ok(!block.includes("Plan file:"));
	assert.ok(!block.includes("\n\n\n"), "no empty part may leave a gap");
	assert.equal(block, `MODE TEXT\n\n${MODE_ANNOUNCEMENTS.auto}`);
});

test("a mode prompt that failed to load still yields a truthful one-line block", () => {
	const block = modeBlock({ modeText: "", mode: "default", tail: "Continue the task." });
	assert.equal(block, `${fallbackModeText("default")}\n\nContinue the task.`);
	assert.match(fallbackModeText("plan"), /plan mode/);
});

test("the plan-file line states the path, the only-file rule and how to create it", () => {
	const line = planFileLine("/p/plan.md");
	assert.match(line, /^Plan file: \/p\/plan\.md\n/);
	assert.match(line, /ONLY project file you may edit or write/);
	assert.match(line, /does not exist yet, create it with the `write` tool/);
});

test("the rules block is the rules line as-is, and empty when the user has no rules", () => {
	assert.equal(rulesBlock("Your user's rules: deny: `rm …`."), "Your user's rules: deny: `rm …`.");
	assert.equal(rulesBlock(""), "");
});

test("the contract names where the mode text lives, once per placement", () => {
	assert.ok(CONTRACT.includes("{{placement}}"), "prompts/contract.md lost its {{placement}} slot");
	assert.ok(contractSection().includes(PLACEMENT_TEXT.message));
	assert.ok(contractSection("prompt").includes(PLACEMENT_TEXT.prompt));
	assert.ok(!contractSection().includes("{{placement}}"));
	assert.ok(!contractSection("prompt").includes(PLACEMENT_TEXT.message));
});

test("nextDelivery: the parent always sends the whole block, a child only its rules", () => {
	const block = (mode: string, rules: string) => nextDelivery({ mode, rules, last: undefined });
	// first delivery
	assert.deepEqual(block("M", ""), { customType: MODE_MESSAGE, content: "M", display: false, details: { mode: "M", rules: "" } });
	assert.equal(block("M", "R")?.content, "M\n\nR");
	// nothing changed: nothing to send
	assert.equal(nextDelivery({ mode: "M", rules: "R", last: { mode: "M", rules: "R" } }), undefined);
	// a grant (rules only moved) re-sends the whole block, never a rules-only message
	const grant = nextDelivery({ mode: "M", rules: "R2", last: { mode: "M", rules: "R" } });
	assert.equal(grant?.customType, MODE_MESSAGE);
	assert.equal(grant?.content, "M\n\nR2");
	// rules dropped back to none: the block alone
	assert.equal(nextDelivery({ mode: "M", rules: "", last: { mode: "M", rules: "R" } })?.content, "M");
	// a mode change
	assert.equal(nextDelivery({ mode: "N", rules: "R", last: { mode: "M", rules: "R" } })?.content, "N\n\nR");
	// a child: rules only, once
	assert.deepEqual(block("", "R"), { customType: RULES_MESSAGE, content: "R", display: false, details: { mode: "", rules: "R" } });
	assert.equal(nextDelivery({ mode: "", rules: "R", last: { mode: "", rules: "R" } }), undefined);
	assert.equal(block("", ""), undefined);
});
