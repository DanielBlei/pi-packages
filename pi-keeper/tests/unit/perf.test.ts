/**
 * Budgets for the two paths that run constantly: a permission decision per tool
 * call, and one idle poll of the background-ask mailbox. The numbers come from
 * `extensions/perf.ts` (a counting seam that is off in normal use), so the
 * assertions are call counts, not timings — a loaded machine cannot fail them.
 * `scripts/bench.ts` prints the same numbers as a table.
 *
 * The one timed assertion is the cold import: a loose ceiling that only catches
 * a catastrophe (a new dependency tree, an accidental synchronous read).
 * Run: npm test
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { counter, counterTotal, enablePerfCounting, resetCounters } from "../../extensions/perf.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENTRY = join(PACKAGE_ROOT, "extensions", "index.ts");

/**
 * Budget for one tool call that needs no dialog: filesystem calls, and how many
 * times the project rules are resolved. One resolution per call is the target;
 * the budget is that target, so a repeat call has to be a deliberate change.
 */
const DECIDE_FS_BUDGET = 2;
const DECIDE_RULES_SYNC_BUDGET = 1;

/** Budget for one idle poll of the empty mailbox, filesystem calls included. */
const IDLE_TICK_FS_BUDGET = 18;

/** A cold import of the whole extension graph, harness included, in milliseconds. */
const COLD_IMPORT_CEILING_MS = 5000;

const sandboxes: Sandbox[] = [];
after(() => {
	restoreBell();
	for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

let harness: Harness | undefined;
beforeEach(() => {
	enablePerfCounting(false);
});
afterEach(async () => {
	enablePerfCounting(false);
	await harness?.shutdown();
	harness = undefined;
});

async function started(): Promise<{ h: Harness; sandbox: Sandbox }> {
	const sandbox = makeSandbox();
	sandboxes.push(sandbox);
	const h = await startPi({ sandbox });
	harness = h;
	await h.session();
	await h.prompt("bench");
	return { h, sandbox };
}

describe("cost budgets", () => {
	it("one tool call resolves the project rules once and touches no more than the budget", async () => {
		const { h, sandbox } = await started();
		enablePerfCounting();
		resetCounters();
		const outcome = await h.tool("read", { path: join(sandbox.cwd, "a.txt") });
		assert.equal(outcome.blocked, false, "a read inside the project needs no dialog");
		const fsCalls = counter("fs");
		const rulesSyncs = counter("projectSync");
		assert.ok(fsCalls <= DECIDE_FS_BUDGET, `one tool call used ${fsCalls} fs calls (budget ${DECIDE_FS_BUDGET})`);
		assert.ok(rulesSyncs <= DECIDE_RULES_SYNC_BUDGET, `one tool call resolved the project rules ${rulesSyncs} times (budget ${DECIDE_RULES_SYNC_BUDGET})`);
		assert.ok(counterTotal() >= 1, "counting works: something was measured");
	});

	it("an idle mailbox poll stays inside its budget", async () => {
		const { h } = await started();
		enablePerfCounting();
		resetCounters();
		const ticks = 10;
		for (let i = 0; i < ticks; i++) h.pollAsks();
		const perTick = counter("fs") / ticks;
		assert.ok(perTick <= IDLE_TICK_FS_BUDGET, `an idle poll used ${perTick} fs calls (budget ${IDLE_TICK_FS_BUDGET})`);
	});

	it("a cold import of the extension graph stays under the ceiling", () => {
		const script = `const t = performance.now(); await import(${JSON.stringify(ENTRY)}); console.log((performance.now() - t).toFixed(1));`;
		const ms = Number(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim());
		assert.ok(Number.isFinite(ms) && ms < COLD_IMPORT_CEILING_MS, `cold import took ${ms} ms (ceiling ${COLD_IMPORT_CEILING_MS})`);
	});
});
