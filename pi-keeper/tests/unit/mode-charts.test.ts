/**
 * Ties the Mermaid flowcharts in docs/design.md ("Behaviour at a glance") to
 * the rule tables in modes.ts: per mode and per layer (deny / ask / allow) the
 * rules named in the chart must be exactly the rules in `MODES`, and the
 * fallback must match. Names and layers only, not arrows; whether Mermaid
 * renders them is `npm run check:charts`. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOBAL_RULES, MODES, READ_TOOLS, type ModeName } from "../../extensions/modes.ts";
import type { Action, Rule } from "../../extensions/rules.ts";
import { chartsInFile, DESIGN, subgraphs, tags } from "../../scripts/charts/lib.ts";

const ACTIONS: readonly Action[] = ["deny", "ask", "allow"];
const CHARTS = ["core", "ask", "default", "auto", "plan"] as const;

/** The tags a set of rules should have: the matcher, or the tool (the read-only built-ins as one `reads`). */
function expectedTags(rules: readonly Rule[], action: Action): string[] {
	const out = new Set<string>();
	for (const rule of rules.filter((r) => r.action === action)) {
		if (rule.match !== undefined) {
			out.add(`matcher: ${rule.match}`);
			continue;
		}
		for (const tool of rule.tools) out.add(READ_TOOLS.includes(tool) ? "tool: reads" : `tool: ${tool}`);
	}
	return [...out].sort();
}

function assertSame(where: string, expected: string[], found: string[]): void {
	const missing = expected.filter((t) => !found.includes(t));
	const stale = found.filter((t) => !expected.includes(t));
	assert.deepEqual({ missing, stale }, { missing: [], stale: [] }, `${where}: the chart and modes.ts differ (missing = in modes.ts, not in the chart; stale = in the chart, not in modes.ts)`);
}

/** The design.md charts by name; every block must carry its `%% chart: <name>` tag, once. */
const all = new Map<string, string>();
for (const chart of chartsInFile(DESIGN)) {
	assert.ok(chart.tagged, `a mermaid block in design.md must start with "%% chart: <name>", got: ${chart.source.split("\n")[0]}`);
	assert.ok(!all.has(chart.name), `two charts named ${chart.name}`);
	all.set(chart.name, chart.source);
}

test("design.md has every chart exactly once", () => {
	assert.deepEqual([...all.keys()].sort(), [...CHARTS].sort());
});

test("every chart is a flowchart with balanced subgraphs and no node or id called end", () => {
	for (const [name, chart] of all) {
		assert.match(chart, /^%% chart: \w+\nflowchart TD\n/, `${name}: starts with the chart tag and "flowchart TD"`);
		subgraphs(chart);
		for (const line of chart.split("\n")) {
			if (/^\s*(end|%%.*)$/.test(line)) continue;
			// quoted labels may say anything; outside them the lowercase word `end` breaks Mermaid
			assert.doesNotMatch(line.replace(/"[^"]*"/g, '""'), /\bend\b/, `${name}: lowercase "end" outside a label: ${line.trim()}`);
		}
	}
});

for (const mode of Object.keys(MODES) as ModeName[]) {
	test(`${mode} chart: each layer lists exactly the ${mode} rules of that action, and the fallback`, () => {
		const chart = all.get(mode);
		assert.ok(chart, `no chart for ${mode}`);
		const layers = subgraphs(chart);
		const { rules, fallback } = MODES[mode].permissions;
		const prefix = { default: "d", auto: "a", plan: "p" }[mode];
		for (const action of ACTIONS) {
			assertSame(`${mode} ${action} layer`, expectedTags(rules, action), tags(layers.get(`${prefix}_${action}`) ?? ""));
		}
		assert.deepEqual(chart.match(/fallback: (ask|allow|deny)/g), [`fallback: ${fallback}`], `${mode}: one fallback line, equal to the mode's fallback`);
	});
}

test("core chart: the global rules by action are exactly GLOBAL_RULES", () => {
	const chart = all.get("core");
	assert.ok(chart, "no core chart");
	const layers = subgraphs(chart);
	for (const action of ACTIONS) {
		assertSame(`global ${action} rules`, expectedTags(GLOBAL_RULES, action), tags(layers.get(`c_global_${action}`) ?? ""));
	}
});

test("every matcher used by a mode rule or a global rule appears in some chart", () => {
	const everything = [...all.values()].join("\n");
	const used = new Set<string>();
	for (const rule of [...GLOBAL_RULES, ...Object.values(MODES).flatMap((m) => m.permissions.rules)]) if (rule.match !== undefined) used.add(rule.match);
	for (const matcher of used) assert.ok(everything.includes(`matcher: ${matcher}`), `matcher ${matcher} is in modes.ts but in no chart`);
});
