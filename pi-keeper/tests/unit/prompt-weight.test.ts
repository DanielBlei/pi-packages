/**
 * Caps on the prompt weight this extension injects per mode: the constant
 * system-prompt section (every request) and the mode message (on a switch).
 * The numbers come from `scripts/prompt-weight.ts`, measured through the same
 * harness, so a cap can never drift from what pi actually sends.
 *
 * A cap is a budget, not a target: when one trips, trim the named file (or move
 * a mode-independent line into prompts/contract.md) instead of raising it.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../../extensions/prompt-blocks.ts";
import { correctionText, RULE_BODY_CAP, RULE_TEXT_CAP, type RulebookRule } from "../../extensions/rulebook.ts";
import { makeSandbox, restoreBell, startPi } from "../mocks/pi.ts";

/** Measured 2026-11: 2228 chars / 557 tokens. Headroom for a sentence, not for a section. */
const SECTION_CAP = 2400;
/** Measured 2026-11: default 554, auto 1046, plan 3091 chars. */
const MODE_CAPS = { default: 700, auto: 1200, plan: 3400 } as const;

/** What pi sends for `mode`: the assembled system prompt, and the mode message in the conversation. */
async function measure(mode: "default" | "auto" | "plan"): Promise<{ system: string; block: string }> {
	const savedTmp = process.env.TMPDIR;
	const sandbox = makeSandbox();
	try {
		const h = await startPi({ sandbox });
		await h.session();
		if (mode !== "default") await h.command("mode", mode);
		const { systemPrompt } = await h.prompt("go");
		return { system: systemPrompt, block: h.modeBlocks().at(-1) ?? "" };
	} finally {
		sandbox.cleanup();
		if (savedTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmp;
	}
}

test("the constant system-prompt section stays within its budget", async () => {
	const { system } = await measure("default");
	const tokens = estimateTokens(system);
	assert.ok(system.length <= SECTION_CAP, `the pi_keeper section grew to ${system.length} chars (cap ${SECTION_CAP}, ~${tokens} tokens): trim prompts/contract.md or the rtk/todo lines in prompt-blocks.ts`);
	assert.ok(tokens <= SECTION_CAP / 4 + 10, `${tokens} estimated tokens in the constant section (cap ${SECTION_CAP / 4 + 10})`);
});

test("each mode message stays within its budget", async () => {
	for (const mode of ["default", "auto", "plan"] as const) {
		const { block } = await measure(mode);
		const cap = MODE_CAPS[mode];
		assert.ok(block.length <= cap, `the ${mode} mode message grew to ${block.length} chars (cap ${cap}, ~${estimateTokens(block)} tokens): trim prompts/${mode}-mode.md`);
		assert.ok(estimateTokens(block) <= Math.ceil(cap / 4), `${estimateTokens(block)} estimated tokens in the ${mode} mode message (cap ${Math.ceil(cap / 4)})`);
	}
});

test("the rulebook correction stays within its budget when a rule fires", () => {
	const rule = (body: string): RulebookRule => ({ name: "no-claims", kind: "user", file: "/rules/no-claims.md", description: "Do not claim that tests pass when they did not run.", condition: "(?i)\\ball tests pass\\b", pattern: /all tests pass/i, body, hash: "" });
	const text = correctionText([rule("x".repeat(RULE_BODY_CAP))]);
	assert.ok(text.length <= RULE_BODY_CAP + 500, `the one-rule correction is ${text.length} chars (cap ${RULE_BODY_CAP + 500}): check RULE_BODY_CAP and prompts/rule-warning.md`);
	assert.ok(text.length < RULE_TEXT_CAP, "one rule never reaches the whole-message cap");
});

// the harness stubs the terminal bell; put it back for the rest of the suite
test("restore the bell stub", () => {
	restoreBell();
});
