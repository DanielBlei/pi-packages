/**
 * Cost measurements for the paths that run constantly: how long the extension
 * takes to load, what one permission decision costs, what one idle poll of the
 * background-ask mailbox costs.
 *
 * Prints a table and never fails on a threshold — `tests/unit/perf.test.ts`
 * holds the budget. Run: `npm run bench`.
 *
 * The counters come from `extensions/perf.ts`, which is off until
 * `enablePerfCounting()`; every count is one extra call on the measured path.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, restoreBell, startPi } from "../tests/mocks/pi.ts";
import { countersSnapshot, counter, counterTotal, enablePerfCounting, resetCounters } from "../extensions/perf.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(PACKAGE_ROOT, "extensions", "index.ts");
/** Idle polls per measurement: the heartbeat writes only on some of them. */
const TICKS = 20;

/** Milliseconds to import the extension entry in a fresh process (the harness included). */
function coldImportMs(): number {
	const script = `const t = performance.now(); await import(${JSON.stringify(ENTRY)}); console.log((performance.now() - t).toFixed(1));`;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
	return Number(out.trim());
}

function row(label: string, values: Array<[string, number | string]>): void {
	const parts = values.map(([name, value]) => `${name}=${value}`);
	console.log(`  ${label.padEnd(28)} ${parts.join("  ")}`);
}

function table(label: string): void {
	const snapshot = countersSnapshot();
	console.log(`\n${label}`);
	if (snapshot.length === 0) {
		console.log("  (nothing counted)");
		return;
	}
	for (const [name, count] of snapshot) console.log(`  ${name.padEnd(18)} ${String(count).padStart(6)}`);
	console.log(`  ${"total".padEnd(18)} ${String(counterTotal()).padStart(6)}`);
}

async function main(): Promise<void> {
	console.log("pi-keeper bench");

	// 1. Load cost. Import the entry alone: tests/mocks/pi.ts would pull the harness in too.
	const cold = coldImportMs();
	row("cold import (entry)", [["ms", cold.toFixed(0)]]);

	// 2. One permission decision, and one idle mailbox poll, through the same mock the tests use.
	const sandbox = makeSandbox();
	const pi = await startPi({ sandbox });
	try {
		await pi.session();
		await pi.prompt("bench");

		enablePerfCounting();
		resetCounters();
		await pi.tool("read", { path: join(sandbox.cwd, "bench.txt") });
		const decisionTotal = counterTotal();
		const rulesSyncs = counter("projectSync");
		const decisionFs = counter("fs");
		table("one tool call that needs no dialog (read inside the project)");
		row("decision cost", [["fsCalls", decisionFs], ["rulesSyncs", rulesSyncs], ["counted", decisionTotal]]);

		resetCounters();
		for (let i = 0; i < TICKS; i++) pi.pollAsks();
		const tickTotal = counterTotal();
		table(`idle mailbox polls (${TICKS})`);
		row("per poll", [["fsCalls", (counter("fs") / TICKS).toFixed(1)], ["counted", (tickTotal / TICKS).toFixed(1)]]);
	} finally {
		enablePerfCounting(false);
		await pi.shutdown();
		sandbox.cleanup();
		restoreBell();
	}
}

await main();
