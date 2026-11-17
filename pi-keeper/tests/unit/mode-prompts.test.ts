/**
 * Mode rules vs. what the models are told. Run: npm test
 *
 * A rule added to a mode applies to the parent in that mode and to every
 * subagent child in it (children evaluate MODES[childMode], index.ts decide()),
 * with no extra wiring. Nothing else would notice that no prompt mentions the
 * new tool: the gate allows it and the model never learns it may use it.
 *
 * So every tool a mode allows unconditionally must be listed below with the
 * wording that tells the model about it, checked in that mode's prompt
 * (prompts/<mode>-mode.md) and its child prompt (prompts/child-<mode>.md).
 * A new tool in a mode's allow rules fails here until it is described.
 * Conditional rules (`match`) are checked against the gate per lane by
 * tests/integration/child-lanes.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILD_PROMPTS, CONTRACT, GLOBAL_RULES, MODES, type ChildMode } from "../../extensions/modes.ts";

/**
 * What a parent model reads: the constant contract in the system prompt plus its mode
 * message (prompt-blocks.ts composes the message; the rules it states are the mode's own
 * text). A gate named in either half is named to the model.
 */
const parentText = (mode: ChildMode): string => `${CONTRACT}\n\n${MODES[mode].prompt}`;

/** How the prompts describe a tool; `exempt` names why a tool needs no wording. */
type Coverage = { parent: RegExp; child: RegExp } | { exempt: string };

const COVERAGE: Record<string, Coverage> = {
	read: { parent: /\bread/i, child: /\bread/i },
	grep: { parent: /search/i, child: /search/i },
	find: { parent: /search/i, child: /search/i },
	ls: { parent: /search|read/i, child: /search|read/i },
	questionnaire: { exempt: "asks the user a question; not an action on the machine" },
	ask_user_question: { exempt: "asks the user a question; not an action on the machine" },
	subagent: { exempt: "launching subagents is described by the parent lane hint (child-lane.ts parentLaneHint)" },
	subagent_launch: {
		exempt:
			"the per-child launch of a workflow/parallel/tasks/chain child: pi-subagents makes it itself and never declares the name to the model, so no prompt line could reach it (its commands and output are gated by tests/unit/rules.test.ts and tests/integration/subagents.test.ts)",
	},
	exit_plan_mode: { parent: /exit_plan_mode/, child: /exit_plan_mode/ },
};

for (const mode of ["default", "plan", "auto"] as ChildMode[]) {
	test(`${mode} mode: every unconditional allow rule's tool is described to the parent and the child`, () => {
		const allowed = MODES[mode].permissions.rules
			.filter((rule) => rule.action === "allow" && rule.match === undefined)
			.flatMap((rule) => rule.tools);
		for (const tool of allowed) {
			const coverage = COVERAGE[tool];
			assert.ok(
				coverage !== undefined,
				`${mode} mode allows "${tool}" unconditionally, but no prompt is known to describe it: say what it may do in prompts/${mode}-mode.md and prompts/child-${mode}.md, then add it to COVERAGE in this test`,
			);
			if ("exempt" in coverage) continue;
			assert.match(parentText(mode), coverage.parent, `prompts/${mode}-mode.md or prompts/contract.md does not describe "${tool}"`);
			assert.match(CHILD_PROMPTS[mode], coverage.child, `prompts/child-${mode}.md does not describe "${tool}"`);
		}
	});
}

/**
 * The other half: what is NOT allowed. Auto mode allows by fallback, so its
 * contract is its ask/deny rules. Every matcher a mode gates (ask or deny)
 * must be named in that mode's prompt and its child prompt. A new gate fails
 * here until the models are told about it. Whether a gate asks or denies in a
 * child depends on the relay: the lane line says that (child-lanes tests).
 */
const GATED: Record<string, { words: RegExp } | { exempt: string }> = {
	dangerousBash: { words: /dangerous/i },
	privilegedBash: { words: /elevated privileges/i },
	unapprovedBash: { words: /not read-only|non-read-only|other commands ask/i },
	secretBash: { words: /secret/i },
	secretFile: { words: /secret/i },
	secretSearch: { words: /secret/i },
	secretUpload: { words: /secret/i },
	protectedPath: { words: /protected/i },
	outsideCwd: { words: /outside the working directory/i },
	outsideCwdRead: { words: /outside the working directory/i },
	outsideCwdBashWrite: { words: /outside the working directory/i },
	outsideCwdDestructive: { words: /outside the working directory/i },
	bridgeInactive: { exempt: "parent-only plumbing: the subagent tool is unusable until children load this extension" },
	projectAsk: { exempt: "project rules are user data, not mode semantics (the rules line states them)" },
	projectDeny: { exempt: "project rules are user data, not mode semantics (the rules line states them)" },
};

for (const mode of ["default", "plan", "auto"] as ChildMode[]) {
	test(`${mode} mode: every gate (ask/deny rule) is named to the parent and the child`, () => {
		const rules = [...GLOBAL_RULES, ...MODES[mode].permissions.rules].filter((rule) => rule.action !== "allow" && rule.match !== undefined);
		const missing: string[] = [];
		for (const rule of rules) {
			const gate = GATED[rule.match as string];
			if (gate === undefined) {
				missing.push(`${rule.match} (${rule.action}): unknown gate, describe it in prompts/${mode}-mode.md and prompts/child-${mode}.md, then add it to GATED`);
				continue;
			}
			if ("exempt" in gate) continue;
			if (!gate.words.test(parentText(mode))) missing.push(`${rule.match} (${rule.action}) not named in prompts/${mode}-mode.md nor prompts/contract.md`);
			if (!gate.words.test(CHILD_PROMPTS[mode])) missing.push(`${rule.match} (${rule.action}) not named in prompts/child-${mode}.md`);
		}
		assert.deepEqual([...new Set(missing)], []);
	});
}
