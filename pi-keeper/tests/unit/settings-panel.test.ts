/**
 * Tests for the /keeper settings panel: tabs, aligned rows, cycling,
 * free-text rows, the footer notice and the snap-back. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { settingsPanel, type PanelItem, type PanelResult, type PanelSection } from "../../extensions/settings-panel.ts";

const KEYS = { enter: "\r", escape: "\x1b", down: "\x1b[B", up: "\x1b[A", tab: "\t", shiftTab: "\x1b[Z" };

interface Component {
	render(width: number): string[];
	handleInput(data: string): void;
}

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/⟦[a-z]+⟧/g, "");

/** A panel over a fake settings store, opened through a fake TUI host. */
async function open(options: { sections?: PanelSection[]; mode?: string; values?: Record<string, string>; apply?: (id: string, value: string) => PanelResult } = {}) {
	const values: Record<string, string> = options.values ?? { alpha: "on", beta: "idle", gamma: "2 min" };
	const applied: Array<[string, string]> = [];
	let component: Component | undefined;
	let finishes = 0;
	const theme = { fg: (color: string, text: string) => `⟦${color}⟧${text}`, bold: (text: string) => `⟦bold⟧${text}`, italic: (text: string) => text };
	const ctx = {
		mode: options.mode ?? "tui",
		ui: {
			custom: (factory: (...args: unknown[]) => Component) =>
				new Promise<void>((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows: 40 } }, theme, {}, () => {
						finishes++;
						resolve();
					});
				}),
		},
	} as unknown as ExtensionContext;

	const sections: PanelSection[] = options.sections ?? [
		{
			id: "one",
			label: "One",
			items: [
				{ id: "alpha", label: "Alpha toggle", description: "What alpha does.", values: ["on", "off"] },
				{ id: "beta", label: "Beta choice", values: ["idle", "always", "badge"] },
			],
		},
		{
			id: "two",
			label: "Two",
			items: [{ id: "gamma", label: "Gamma duration", placeholder: "e.g. 1m, 2m", description: "How long." } as PanelItem],
		},
	];

	const done = settingsPanel(ctx, "the settings (file.json)", sections, {
		currentValue: (id) => values[id] ?? "",
		apply: (id, value) => {
			applied.push([id, value]);
			if (options.apply !== undefined) return options.apply(id, value);
			values[id] = value;
			return { message: `${id} saved` };
		},
	});
	await new Promise((r) => setImmediate(r));
	assert.ok(component !== undefined);
	return { component, done, applied, values, finishes: () => finishes };
}

test("renders the title, the tabs with the first one active, and label/value columns", async () => {
	const { component, done } = await open();
	const lines = component.render(70).map(strip);
	assert.match(lines[0] ?? "", /the settings \(file\.json\)/);
	assert.match(lines[2] ?? "", /One \/ Two/);
	// the label column is padded so the values line up
	const alpha = lines.find((line) => line.includes("Alpha toggle")) ?? "";
	const beta = lines.find((line) => line.includes("Beta choice")) ?? "";
	assert.match(alpha, /^> Alpha toggle +on$/);
	assert.match(beta, /^  Beta choice +idle$/);
	assert.equal(alpha.indexOf("on"), beta.indexOf("idle"));
	// the selected row's help text and the footer hints are there
	assert.ok(lines.some((line) => line.includes("What alpha does.")));
	assert.ok(lines.some((line) => line.includes("Tab/Shift+Tab sections")));
	component.handleInput(KEYS.escape);
	await done;
});

test("Enter on a row cycles its value; the row shows the new value", async () => {
	const { component, applied, done } = await open();
	component.handleInput(KEYS.enter);
	assert.deepEqual(applied, [["alpha", "off"]]);
	assert.match(component.render(70).map(strip).find((line) => line.includes("Alpha toggle")) ?? "", /off/);
	component.handleInput(KEYS.escape);
	await done;
});

test("Tab and Shift+Tab switch sections and wrap around", async () => {
	const { component, done } = await open();
	component.handleInput(KEYS.tab);
	// the second tab's rows, and the tabs still name both sections
	const second = component.render(70).map(strip);
	assert.ok(second.some((line) => line.includes("Gamma duration")));
	assert.ok(!second.some((line) => line.includes("Alpha toggle")));
	assert.match(second[2] ?? "", /One \/ Two/);
	// Shift+Tab goes back, and once more wraps to the last section
	component.handleInput(KEYS.shiftTab);
	assert.ok(component.render(70).map(strip).some((line) => line.includes("Alpha toggle")));
	component.handleInput(KEYS.shiftTab);
	assert.ok(component.render(70).map(strip).some((line) => line.includes("Gamma duration")));
	component.handleInput(KEYS.escape);
	await done;
});

test("a rejected value snaps back and the reason shows in the footer", async () => {
	const { component, done } = await open({
		apply: () => ({ message: "must be between 10 s and 30 min", error: true }),
	});
	component.handleInput(KEYS.enter);
	const lines = component.render(70).map(strip);
	assert.ok(lines.some((line) => line.includes("must be between 10 s and 30 min")), "the error is in the footer");
	assert.match(lines.find((line) => line.includes("Alpha toggle")) ?? "", /on$/, "the row keeps the saved value");
	// the footer hint is replaced by the message until the next change
	assert.ok(!lines.some((line) => line.includes("Enter/Space change")));
	component.handleInput(KEYS.escape);
	await done;
});

test("a row without values opens a one-line input: Enter applies the typed text", async () => {
	const { component, applied, done } = await open();
	component.handleInput(KEYS.tab);
	component.handleInput(KEYS.enter);
	// the input replaces the list; typing reaches it, Tab no longer switches sections
	for (const char of "5m") component.handleInput(char);
	component.handleInput(KEYS.enter);
	assert.deepEqual(applied, [["gamma", "5m"]]);
	assert.ok(component.render(70).map(strip).some((line) => line.includes("Gamma duration")), "back to the list");
	component.handleInput(KEYS.escape);
	await done;
});

test("Esc inside the input applies nothing and leaves the row alone", async () => {
	const { component, applied, done } = await open();
	component.handleInput(KEYS.tab);
	component.handleInput(KEYS.enter);
	component.handleInput("5");
	component.handleInput(KEYS.escape);
	assert.deepEqual(applied, []);
	// an empty Enter applies nothing either
	component.handleInput(KEYS.enter);
	component.handleInput(KEYS.enter);
	assert.deepEqual(applied, []);
	component.handleInput(KEYS.escape);
	await done;
});

test("Esc closes the panel once", async () => {
	const { component, done, finishes } = await open();
	component.handleInput(KEYS.escape);
	await done;
	assert.equal(finishes(), 1);
});

test("a host without a TUI gets nothing: the command keeps its own plain dialogs", async () => {
	let opened = 0;
	const ctx = {
		mode: "rpc",
		ui: { custom: () => (opened++, Promise.resolve()) },
	} as unknown as ExtensionContext;
	await settingsPanel(ctx, "t", [{ id: "a", label: "A", items: [{ id: "x", label: "X", values: ["on"] }] }], {
		currentValue: () => "on",
		apply: () => ({ message: "ok" }),
	});
	assert.equal(opened, 0);
});

const item = (id: string): PanelItem => ({ id, label: `Row ${id}`, values: ["on", "off"] });
const grouped: PanelSection[] = [
	{
		id: "g",
		label: "G",
		items: [item("a"), item("b"), item("c")],
		groups: [
			{ label: "First group", items: [item("a"), item("b")] },
			{ label: "Second group", items: [item("c")] },
		],
	},
];

test("a grouped section shows headings with a blank line between the groups", async () => {
	const { component, done } = await open({ sections: grouped, values: { a: "on", b: "on", c: "on" } });
	const rows = component.render(150).map(strip);
	const first = rows.findIndex((line) => line.includes("First group"));
	const second = rows.findIndex((line) => line.includes("Second group"));
	assert.ok(first >= 0 && second > first);
	assert.equal(rows[second - 1]?.trim(), "", "a blank line before the second heading");
	assert.match(rows[first + 1] ?? "", /^> Row a +on/, `the cursor starts on the first row, not on a heading: ${JSON.stringify(rows[first + 1])}`);
	assert.ok(rows.every((line) => line.length <= 150));
	component.handleInput(KEYS.escape);
	await done;
});

test("the cursor steps over headings and the blank row, and wraps", async () => {
	const { component, applied, done } = await open({ sections: grouped, values: { a: "on", b: "on", c: "on" } });
	const selected = (): string => (component.render(150).map(strip).find((line) => line.startsWith("> ")) ?? "").trim();
	component.handleInput(KEYS.down);
	assert.match(selected(), /^> Row b/);
	component.handleInput(KEYS.down);
	assert.match(selected(), /^> Row c/, "skips the blank row and the second heading");
	component.handleInput(KEYS.down);
	assert.match(selected(), /^> Row a/, "wraps to the first row");
	component.handleInput(KEYS.up);
	assert.match(selected(), /^> Row c/, "wraps back, over the headings");
	component.handleInput(KEYS.enter);
	assert.deepEqual(applied, [["c", "off"]]);
	component.handleInput(KEYS.escape);
	await done;
});
