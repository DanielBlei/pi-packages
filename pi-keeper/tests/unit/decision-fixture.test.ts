/**
 * Replays tests/fixtures/decisions.ts against the current rules: every entry in every mode,
 * guard entries never loosen, twin links are consistent.
 * Run: node --test tests/unit/decision-fixture.test.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { GLOBAL_RULES, MODES, type ModeName } from "../../extensions/modes.ts";
import { SEVERITY, bashWhy, evaluate } from "../../extensions/rules.ts";
import { approvalBreakdown, createScratchDir, formatBreakdown, isReadOnlyCommand } from "../../extensions/utils.ts";
import { ENTRIES, expected, judge, type DecisionApi, type FixtureEnv } from "../fixtures/decisions.ts";

// A later phase gives "a name that is already in the environment" its own rule (such a name is never
// substituted). Export a name here so that rule's near-miss is real in this process; no entry uses it yet.
process.env.pk_fixture_exported = "1";

const MODE_NAMES: ModeName[] = ["default", "auto", "plan"];
const api: DecisionApi = { evaluate, MODES, GLOBAL_RULES, approvalBreakdown, formatBreakdown, isReadOnlyCommand, bashWhy };
const env: FixtureEnv = { scratch: createScratchDir(), cwd: "/home/user/project" };
after(() => rmSync(env.scratch, { recursive: true, force: true }));

test("every entry gives its expected decision in every mode", () => {
	for (const entry of ENTRIES) {
		for (const mode of MODE_NAMES) {
			const want = expected(entry, mode);
			const got = judge(entry, mode, api, env);
			const label = `${entry.id} [${mode}] ${entry.command(env)}`;
			assert.equal(got.action, want.action, `${label}: action`);
			assert.equal(got.rule, want.rule, `${label}: rule`);
			if (want.why === undefined) assert.equal(got.why, undefined, `${label}: no reason expected`);
			else assert.match(got.why ?? "", want.why, `${label}: reason`);
		}
	}
});

test("guard entries never loosen", () => {
	for (const entry of ENTRIES.filter((e) => e.guard)) {
		for (const mode of MODE_NAMES) {
			const floor = SEVERITY[entry.today[mode].action];
			const got = judge(entry, mode, api, env);
			assert.ok(SEVERITY[got.action] >= floor, `${entry.id} [${mode}] is ${got.action}, was ${entry.today[mode].action}`);
			for (const row of entry.after ?? []) {
				const next = row[mode];
				if (next !== undefined) assert.ok(SEVERITY[next.action] >= floor, `${entry.id} [${mode}] after ${row.phase} loosens to ${next.action}`);
			}
		}
	}
});

test("ids are unique and twin links resolve both ways", () => {
	const ids = ENTRIES.map((e) => e.id);
	assert.equal(new Set(ids).size, ids.length, "duplicate id");
	const byId = new Map(ENTRIES.map((e) => [e.id, e]));
	for (const entry of ENTRIES) {
		if (entry.twin === undefined) continue;
		const twin = byId.get(entry.twin);
		assert.ok(twin !== undefined, `${entry.id}: twin ${entry.twin} does not exist`);
		assert.equal(twin.twin, entry.id, `${entry.id}: twin ${entry.twin} does not link back`);
	}
});

test("every near-miss has a positive twin and is a guard", () => {
	for (const entry of ENTRIES.filter((e) => e.id.startsWith("near/"))) {
		assert.equal(entry.guard, true, `${entry.id} must be a guard`);
		assert.equal(entry.twin, entry.id.replace("near/", "pos/"));
	}
});

test("flip table", (t) => {
	const flips = ENTRIES.filter((e) => (e.after?.length ?? 0) > 0);
	t.diagnostic(`${ENTRIES.length} entries, ${flips.length} flipped`);
	for (const entry of flips) {
		for (const mode of MODE_NAMES) {
			const was = entry.today[mode];
			const now = expected(entry, mode);
			if (was.action !== now.action || was.rule !== now.rule) t.diagnostic(`${entry.id} [${mode}] ${was.action}/${was.rule} -> ${now.action}/${now.rule} (${entry.after?.at(-1)?.phase})`);
		}
	}
});
