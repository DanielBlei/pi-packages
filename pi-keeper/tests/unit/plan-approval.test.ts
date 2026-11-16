/**
 * Tests for the plan view (the exit_plan_mode tool row) and the plan-approval selector (fake TUI).
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { asPlanDetails, PlanView, planHeaderText, selectPlanAction, type PlanChoice, type PlanDetails } from "../../extensions/plan-approval.ts";
import { setPreviewTextColor } from "../../extensions/dialog.ts";
import { HIGHLIGHTER_KEY } from "../../extensions/shell-highlight-bridge.ts";

initTheme();

const KEYS = { enter: "\r", escape: "\x1b", up: "\x1b[A", down: "\x1b[B", shiftTab: "\x1b[Z", ctrlG: "\x07", ctrlN: "\x0e", ctrlP: "\x10", altM: "\x1bm" };
const OPTIONS = ["Yes, in auto mode", "Yes, approving each edit"];

interface Component {
	render(width: number): string[];
	handleInput(data: string): void;
}

const strip = (s: string): string => s.replace(/\[\/?bg\]/g, "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07\x1b]*(\x07|\x1b\\)/g, "");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, bg: (_color: string, text: string) => `[bg]${text}[/bg]` };

/** Opens the selector in a fake TUI. */
async function open(options: { signal?: AbortSignal; initialFeedback?: string; initialRow?: number; notice?: string; isModeShortcut?: (data: string) => boolean } = {}) {
	let component: Component | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory: (...args: unknown[]) => Component) =>
				new Promise((resolve) => {
					const keybindings = { matches: (data: string, id: string) => id === "app.editor.external" && data === KEYS.ctrlG };
					component = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, keybindings, resolve);
				}),
		},
	} as unknown as ExtensionContext;
	const result: Promise<PlanChoice> = selectPlanAction(ctx, { options: OPTIONS, ...options });
	await new Promise((r) => setImmediate(r));
	assert.ok(component !== undefined);
	const type = (text: string): void => {
		for (const char of text) component?.handleInput(char);
	};
	return { component, result, type, rows: () => component?.render(80).map(strip) ?? [] };
}

/** Settles a promise state without awaiting it forever: "pending" if it has not resolved yet. */
async function state<T>(promise: Promise<T>): Promise<T | "pending"> {
	return Promise.race([promise, new Promise<"pending">((r) => setImmediate(() => r("pending")))]);
}

const PLAN = "# Goal\n\n1. a long step that needs to wrap around the terminal because it is longer than the width we render at, ok\n   - nested item with its own words to wrap onto another line as well\n- [ ] first\n- [x] second\n";
const details = (extra: Partial<PlanDetails> = {}): PlanDetails => ({ plan: PLAN, planFile: "/tmp/p.md", outcome: "pending", edited: false, ...extra });

test("PlanView wraps long list items with a hanging indent at width 60", () => {
	const lines = new PlanView(details(), theme).render(60).map(strip);
	for (const line of lines) assert.ok(line.length <= 60, `fits the width: ${JSON.stringify(line)}`);
	const step = lines.findIndex((l) => l.includes("1. a long step"));
	assert.ok(step >= 0);
	const continuation = lines[step + 1] ?? "";
	// the wrapped text lines up under the item text, not under the number
	assert.ok(/^ {4,}\S/.test(continuation), `hanging indent: ${JSON.stringify(continuation)}`);
	assert.ok(lines.some((l) => l.includes("[ ] first")) && lines.some((l) => l.includes("[x] second")), "task markers");
});

test("PlanView caps the text column on wide terminals and pads it on the left", () => {
	const long = "word ".repeat(80).trim();
	const lines = new PlanView(details({ plan: long }), theme).render(200).map((l) => strip(l).trimEnd());
	const body = lines.filter((l) => l.includes("word"));
	assert.ok(body.length > 1, "wrapped although the terminal is wide");
	for (const line of body) {
		assert.ok(line.length <= 102, `capped: ${line.length}`);
		assert.ok(line.startsWith(" w"), "left padding");
	}
});

test("PlanView paints every line with the neutral background, padded to the width, whatever the outcome", () => {
	for (const outcome of ["pending", "approved", "rejected"] as const) {
		const lines = new PlanView(details({ outcome }), theme).render(60);
		assert.ok(lines.length > 3);
		for (const line of lines) {
			assert.ok(line.startsWith("[bg]") && line.endsWith("[/bg]"), `bg on ${JSON.stringify(line)}`);
			assert.equal(strip(line).length, 60, "padded to width");
		}
	}
});

test("PlanView header follows the outcome; the plan file is named; the body stays", () => {
	const view = new PlanView(details(), theme);
	const header = (): string => view.render(80).map((l) => strip(l).trimEnd()).find((l) => l.startsWith("●")) ?? "";
	assert.match(header(), /^● Plan ready for review$/);
	assert.ok(view.render(80).map(strip).some((l) => l.includes("Plan file: /tmp/p.md")));
	view.update(details({ outcome: "approved", target: "auto", edited: true }), theme);
	assert.match(header(), /^● Plan approved · auto mode · edited$/);
	assert.equal(planHeaderText(details({ outcome: "approved", target: "default", feedback: "x" })), "● Plan approved · manual approval · + feedback");
	assert.equal(planHeaderText(details({ outcome: "kept-planning", feedback: "split\nstep 2" })), '● Kept planning: "split step 2"');
	assert.equal(planHeaderText(details({ outcome: "aborted" })), "● Plan review interrupted");
	assert.equal(planHeaderText(details({ outcome: "rejected" })), "● Plan declined");
	assert.ok(view.render(80).map(strip).some((l) => l.includes("Goal")));
});

test("asPlanDetails: only a well-formed snapshot passes", () => {
	assert.ok(asPlanDetails(details()));
	assert.equal(asPlanDetails(undefined), undefined);
	assert.equal(asPlanDetails({ plan: 1 }), undefined);
	assert.equal(asPlanDetails({ plan: "x", planFile: "f", outcome: "weird" }), undefined);
});

test("PlanView colors a shell fenced block with the shell highlighter when the config asks for it", () => {
	const plan = "# Goal\n\n```bash\ngit commit -m wip\n```\n";
	const registry = globalThis as unknown as Record<symbol, unknown>;
	const asked: string[] = [];
	registry[HIGHLIGHTER_KEY] = {
		highlightCommand: (text: string, lang: string | undefined) => {
			asked.push(`${lang ?? ""}:${text}`);
			return [`⟦shell⟧${text}⟦/⟧`];
		},
	};
	const render = (): string => new PlanView(details({ plan }), theme).render(80).join("\n");
	try {
		setPreviewTextColor("shell-highlight");
		assert.ok(render().includes("⟦shell⟧git commit -m wip⟦/⟧"), "the fence is painted by the highlighter");
		assert.deepEqual(asked, ["bash:git commit -m wip"], "asked once, with the fence's language");

		// every other setting keeps pi's own highlighter: the fence is there, the highlighter is not asked
		for (const color of ["dim", "muted", "text", "builtin-syntax"] as const) {
			setPreviewTextColor(color);
			const raw = render();
			assert.ok(strip(raw).includes("git commit -m wip"), color);
			assert.ok(!raw.includes("⟦shell⟧"), color);
		}
		assert.equal(asked.length, 1, "only the configured run asked");

		// a fence in another language is not a shell run
		setPreviewTextColor("shell-highlight");
		assert.ok(!new PlanView(details({ plan: "```json\n{\"a\":1}\n```\n" }), theme).render(80).join("\n").includes("⟦shell⟧"));
		assert.equal(asked.length, 1, "json stays with pi's highlighter");
	} finally {
		delete registry[HIGHLIGHTER_KEY];
		setPreviewTextColor("dim");
	}
});

test("Enter on a Yes row approves it; digits, j/k and ctrl+n/ctrl+p move off the field", async () => {
	const first = await open();
	assert.ok(first.rows().some((l) => l.includes("> 1. Yes, in auto mode")));
	first.component.handleInput(KEYS.enter);
	assert.deepEqual(await first.result, { kind: "approve", row: 0 });

	const second = await open();
	second.type("j");
	second.component.handleInput(KEYS.enter);
	assert.deepEqual(await second.result, { kind: "approve", row: 1 });

	const third = await open();
	third.component.handleInput(KEYS.ctrlN);
	third.component.handleInput(KEYS.ctrlN);
	third.component.handleInput(KEYS.ctrlP);
	third.type("2");
	third.component.handleInput(KEYS.enter);
	assert.deepEqual(await third.result, { kind: "approve", row: 1 });
});

test("an empty Enter on the field does nothing; typed feedback is sent; Esc rejects", async () => {
	const { component, result, type } = await open({ initialRow: 2 });
	component.handleInput(KEYS.enter);
	assert.equal(await state(result), "pending", "an empty field ignores Enter");
	type("  ");
	component.handleInput(KEYS.enter);
	assert.equal(await state(result), "pending", "whitespace is empty too");
	type("split step 2");
	component.handleInput(KEYS.enter);
	assert.deepEqual(await result, { kind: "feedback", text: "split step 2" });

	const rejected = await open();
	rejected.component.handleInput(KEYS.escape);
	assert.deepEqual(await rejected.result, { kind: "reject" });
});

test("on the field, j/k and digits type into it instead of moving", async () => {
	const { component, result, rows, type } = await open({ initialRow: 2 });
	type("jk12");
	assert.ok(rows().some((l) => l.includes("> 3. No, keep planning") && l.includes("jk12")), "typed into the field");
	component.handleInput(KEYS.enter);
	assert.deepEqual(await result, { kind: "feedback", text: "jk12" });
});

test("the focused field row shows the placeholder and always the shift+tab hint; off the field there is none", async () => {
	const off = await open({ initialRow: 0 });
	assert.ok(!off.rows().some((l) => l.includes("shift+tab approves")));
	assert.ok(!off.rows().some((l) => l.includes("shift+tab: approve (approving each edit)")));
	off.component.handleInput(KEYS.escape);

	const { component, rows, type } = await open({ initialRow: 2 });
	assert.ok(rows().some((l) => l.includes("Tell pi what to change")));
	assert.ok(rows().some((l) => l.includes("shift+tab approves (approving each edit) with it")), "hint before typing");
	type("x");
	assert.ok(rows().some((l) => l.includes("shift+tab: approve (approving each edit) with this note")), "hint with a note");
	component.handleInput(KEYS.escape);
});

test("shift+tab approves manually, with the typed feedback riding along", async () => {
	const withFeedback = await open({ initialRow: 2 });
	withFeedback.type("also add tests");
	withFeedback.component.handleInput(KEYS.shiftTab);
	assert.deepEqual(await withFeedback.result, { kind: "approve", row: 1, feedback: "also add tests" });

	const plain = await open();
	plain.component.handleInput(KEYS.shiftTab);
	assert.deepEqual(await plain.result, { kind: "approve", row: 1 });
});

test("ctrl+g returns the draft feedback and the row; the next selector starts with both", async () => {
	const first = await open({ initialRow: 2 });
	first.type("draft text");
	first.component.handleInput(KEYS.ctrlG);
	const edit = await first.result;
	assert.deepEqual(edit, { kind: "edit", feedback: "draft text", row: 2 });

	const again = await open({ initialFeedback: "draft text", initialRow: 2, notice: "Plan updated" });
	assert.ok(again.rows().some((l) => l.includes("> 3. No, keep planning") && l.includes("draft text")));
	assert.ok(again.rows().some((l) => l.includes("Plan updated")));
	// the cursor sits after the restored draft, so typing appends
	again.type("!");
	again.component.handleInput(KEYS.enter);
	assert.deepEqual(await again.result, { kind: "feedback", text: "draft text!" });
});

test("ctrl+c cancels the review (abort), and an unfocused draft shows without a cursor", async () => {
	const { component, result, rows } = await open({ initialFeedback: "draft", initialRow: 0 });
	const field = rows().find((l) => l.includes("No, keep planning")) ?? "";
	assert.ok(field.includes("draft"));
	assert.ok(!component.render(80).find((l) => l.includes("draft"))?.includes("\x1b[7m"), "no reverse-video cursor block");
	component.handleInput("\x03");
	assert.deepEqual(await result, { kind: "abort" });
});

test("the mode shortcut finishes with a mode-switch choice, ahead of the field row, carrying the draft", async () => {
	const fromRow = await open({ isModeShortcut: (data) => data === KEYS.altM });
	fromRow.component.handleInput(KEYS.altM);
	assert.deepEqual(await fromRow.result, { kind: "mode-switch", feedback: "", row: 0 });

	const fromField = await open({ initialRow: 2, isModeShortcut: (data) => data === KEYS.altM });
	fromField.type("draf");
	fromField.component.handleInput(KEYS.altM);
	assert.deepEqual(await fromField.result, { kind: "mode-switch", feedback: "draf", row: 2 });
});

test("without the matcher the mode shortcut key falls through harmlessly", async () => {
	const { component, result, rows, type } = await open({ initialRow: 2 });
	type("draf");
	component.handleInput(KEYS.altM);
	assert.equal(await state(result), "pending", "the selector stays open");
	const field = rows().find((l) => l.includes("No, keep planning")) ?? "";
	assert.ok(field.includes("draf") && !field.includes("drafm"), "nothing typed into the field");
	component.handleInput(KEYS.enter);
	assert.deepEqual(await result, { kind: "feedback", text: "draf" });
});

test("every selector line fits a narrow terminal", async () => {
	const { component } = await open({ initialRow: 2, notice: "Plan updated after a long edit session" });
	for (const char of "some feedback") component.handleInput(char);
	for (const width of [20, 30, 43]) {
		for (const line of component.render(width).map(strip)) assert.ok(line.length <= width, `fits ${width}: ${JSON.stringify(line)}`);
	}
	component.handleInput(KEYS.escape);
});

test("an abort resolves the selector, and an already-aborted signal never mounts it", async () => {
	const controller = new AbortController();
	const { result } = await open({ signal: controller.signal });
	controller.abort();
	assert.deepEqual(await result, { kind: "abort" });

	let mounted = false;
	const ctx = { mode: "tui", ui: { custom: () => ((mounted = true), Promise.resolve({ kind: "reject" })) } } as unknown as ExtensionContext;
	assert.deepEqual(await selectPlanAction(ctx, { options: OPTIONS, signal: AbortSignal.abort() }), { kind: "abort" });
	assert.equal(mounted, false);
});

test("outside the TUI: a select, then an input for the feedback", async () => {
	const calls: string[] = [];
	const make = (picked: string | undefined, typed: string | undefined) =>
		({
			mode: "rpc",
			ui: {
				select: async (_title: string, options: string[]) => (calls.push(`select ${options.length}`), picked),
				input: async () => (calls.push("input"), typed),
			},
		}) as unknown as ExtensionContext;
	assert.deepEqual(await selectPlanAction(make(OPTIONS[0], undefined), { options: OPTIONS }), { kind: "approve", row: 0 });
	assert.deepEqual(await selectPlanAction(make("No, keep planning", "more tests"), { options: OPTIONS }), { kind: "feedback", text: "more tests" });
	assert.deepEqual(await selectPlanAction(make("No, keep planning", ""), { options: OPTIONS }), { kind: "reject" });
	assert.deepEqual(await selectPlanAction(make(undefined, undefined), { options: OPTIONS }), { kind: "reject" });
	assert.deepEqual(calls, ["select 3", "select 3", "input", "select 3", "input", "select 3"]);
});
