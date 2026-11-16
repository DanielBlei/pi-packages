/**
 * Tests for the permission dialog with a preview (fake TUI).
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { permissionDialog, selectModeDialog, setPreviewTextColor, type ModeDialogItem } from "../../extensions/dialog.ts";
import { HIGHLIGHTER_KEY } from "../../extensions/shell-highlight-bridge.ts";
import type { Preview } from "../../extensions/preview.ts";
import { blankLine, commandLines, dialogTitle, seg, type DialogTitle } from "../../extensions/title.ts";

initTheme();

const OPTIONS = ["Yes", "No", "No, and tell pi what to do instead"];
const KEYS = { enter: "\r", escape: "\x1b", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", end: "\x1b[F", altM: "\x1bm" };

interface Component {
	render(width: number): string[];
	handleInput(data: string): void;
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const TITLE: DialogTitle = dialogTitle([
	[seg("Permission required (default mode)", "bold")],
	blankLine(),
	...commandLines("  write ", "f.ts"),
]);

/** Opens the dialog in a fake TUI; returns the component and the result. */
async function open(preview: Preview | undefined, options: { rows?: number; signal?: AbortSignal; encode?: boolean; onModeShortcut?: (data: string) => boolean; title?: DialogTitle } = {}) {
	let component: Component | undefined;
	let finishes = 0;
	const theme = options.encode
		? { fg: (color: string, text: string) => `⟦${color}⟧${text}`, bold: (text: string) => `⟦bold⟧${text}` }
		: { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		mode: "tui",
		signal: options.signal,
		ui: {
			custom: (factory: (...args: unknown[]) => Component) =>
				new Promise((resolve) => {
					component = factory(
						{ requestRender() {}, terminal: { rows: options.rows ?? 30 } },
						theme,
						{},
						(result: unknown) => {
							finishes++;
							resolve(result);
						},
					);
				}),
		},
	} as unknown as ExtensionContext;
	const result = permissionDialog(ctx, options.title ?? TITLE, preview, OPTIONS, undefined, undefined, options.onModeShortcut);
	await new Promise((r) => setImmediate(r));
	assert.ok(component !== undefined);
	return { component, result, finishes: () => finishes };
}

const bigDiff: Preview = {
	kind: "diff",
	diff: Array.from({ length: 100 }, (_, i) => `+${i + 1} line ${i}`).join("\n"),
	summary: "new file, 100 lines",
};

test("renders header, summary, diff viewport and options within the terminal", async () => {
	const { component, result } = await open(bigDiff);
	const lines = component.render(60).map(strip);
	assert.ok(lines.length <= 30, `rendered ${lines.length} rows`);
	assert.ok(lines.some((l) => l.includes("write f.ts")));
	assert.ok(lines.some((l) => l.includes("new file, 100 lines")));
	assert.ok(lines.some((l) => l.includes("line 0")));
	assert.ok(lines.some((l) => /lines 1–\d+ of 100/.test(l)));
	assert.ok(lines.some((l) => l.includes("> Yes")));
	component.handleInput(KEYS.escape);
	assert.equal(await result, undefined);
});

test("scrolls the preview and selects with arrows, j/k and Enter", async () => {
	const first = await open(bigDiff);
	first.component.handleInput(KEYS.pageDown);
	assert.ok(first.component.render(60).map(strip).some((l) => /lines (?!1–)\d+–\d+ of 100/.test(l)));
	first.component.handleInput(KEYS.end);
	assert.ok(first.component.render(60).map(strip).some((l) => /–100 of 100/.test(l)));
	first.component.handleInput(KEYS.down);
	first.component.handleInput(KEYS.enter);
	assert.equal(await first.result, "No");

	const second = await open(bigDiff);
	second.component.handleInput("j");
	second.component.handleInput("j");
	second.component.handleInput("k");
	second.component.handleInput(KEYS.enter);
	assert.equal(await second.result, OPTIONS[1]);
});

test("digits don't select: a stray keystroke can't approve", async () => {
	const { component, result, finishes } = await open(bigDiff);
	for (const digit of "123456789") component.handleInput(digit);
	assert.equal(finishes(), 0);
	component.handleInput(KEYS.escape);
	assert.equal(await result, undefined);
});

test("a mode shortcut the handler consumes does not answer the dialog", async () => {
	const { component, result, finishes } = await open(bigDiff, { onModeShortcut: (data) => data === KEYS.altM });
	component.handleInput(KEYS.altM);
	assert.equal(finishes(), 0, "the dialog stays open");
	component.handleInput(KEYS.enter);
	assert.equal(await result, "Yes");
});

test("a mode shortcut the handler does not consume leaves the normal keys working", async () => {
	const seen: string[] = [];
	const { component, result } = await open(bigDiff, {
		onModeShortcut: (data) => {
			seen.push(data);
			return false;
		},
	});
	component.handleInput(KEYS.altM);
	assert.deepEqual(seen, [KEYS.altM]);
	component.handleInput(KEYS.down);
	component.handleInput(KEYS.enter);
	assert.equal(await result, "No");
});

test("small previews show in full without a scroll indicator", async () => {
	const { component, result } = await open({ kind: "diff", diff: "-1 a\n+1 b", summary: "1 edit, +1 −1 lines" });
	const lines = component.render(60).map(strip);
	assert.ok(!lines.some((l) => l.includes("PgUp/PgDn")));
	component.handleInput(KEYS.enter);
	assert.equal(await result, "Yes");
});

test("wraps long single-line commands without losing their tail", async () => {
	const command = `python3 -c "${"print('line') ".repeat(30)}"`;
	const { component, result } = await open({ kind: "text", text: command }, { rows: 40 });
	const lines = component.render(60).map(strip);
	assert.ok(lines.some((line) => line.includes("python3 -c")));
	assert.ok(lines.some((line) => line.includes("print('line')")));
	assert.ok(!lines.some((line) => line.includes("…")), "wrapped content must not be replaced by an ellipsis");
	assert.ok(lines.length <= 40);
	component.handleInput(KEYS.enter);
	assert.equal(await result, "Yes");
});

test("shows fewer than 15 preview rows in full and pages longer previews", async () => {
	const short = await open({ kind: "text", text: Array.from({ length: 12 }, (_, i) => `short-${i}`).join("\n") }, { rows: 40 });
	const shortLines = short.component.render(60).map(strip);
	assert.ok(shortLines.some((line) => line.includes("short-11")));
	assert.ok(!shortLines.some((line) => line.includes("of 12")));
	short.component.handleInput(KEYS.enter);
	assert.equal(await short.result, "Yes");

	const long = await open({ kind: "text", text: Array.from({ length: 25 }, (_, i) => `long-${i}`).join("\n") }, { rows: 40 });
	const first = long.component.render(60).map(strip);
	assert.ok(first.some((line) => line.includes("long-0")));
	assert.ok(first.some((line) => /lines 1–15 of 25/.test(line)));
	long.component.handleInput(KEYS.pageDown);
	assert.ok(long.component.render(60).map(strip).some((line) => line.includes("long-14")));
	long.component.handleInput(KEYS.pageUp);
	assert.ok(long.component.render(60).map(strip).some((line) => line.includes("long-0")));
	long.component.handleInput(KEYS.end);
	assert.ok(long.component.render(60).map(strip).some((line) => /–25 of 25/.test(line)));
	long.component.handleInput(KEYS.enter);
	assert.equal(await long.result, "Yes");
});

test("without a preview: header and options only, no summary or scroll rows", async () => {
	const { component, result } = await open(undefined);
	const lines = component.render(60).map(strip);
	assert.ok(lines.some((l) => l.includes("Permission required (default mode)")));
	assert.ok(lines.some((l) => l.includes("write f.ts")));
	assert.ok(lines.some((l) => l.includes("> Yes")));
	assert.ok(!lines.some((l) => l.includes("full command")));
	assert.ok(!lines.some((l) => l.includes("PgUp/PgDn")));
	assert.ok(lines.some((l) => l.includes("esc reject")));
	// options start right after the header block: no empty viewport rows
	const headerIndex = lines.findIndex((l) => l.includes("write f.ts"));
	assert.match(lines[headerIndex + 2], /^> /);
	component.handleInput(KEYS.enter);
	assert.equal(await result, "Yes");
});

test("title styles: commands warning-yellow, labels muted, headers bold, explanations dim", async () => {
	const { component } = await open(undefined, { encode: true });
	const raw = component.render(80).join("\n");
	assert.ok(raw.includes("⟦bold⟧⟦text⟧Permission required (default mode)"), "bold header in the text color");
	assert.ok(raw.includes("⟦warning⟧f.ts"), "command in the warning color");
	assert.ok(raw.includes("⟦muted⟧  write "), "the label is muted, not the terminal default");
	// close it: an open dialog holds the dialog lock for the tests after it
	component.handleInput(KEYS.escape);
});

test("the full command is painted in the configured theme slot (previewTextColor)", async () => {
	const text: Preview = { kind: "text", text: "rtk grep foo" };
	// render, close, then assert: an open dialog holds the dialog lock for the tests after it
	const before = await open(text, { encode: true });
	const beforeRaw = before.component.render(80).join("\n");
	before.component.handleInput(KEYS.escape);
	assert.equal(await before.result, undefined);
	assert.ok(beforeRaw.includes("⟦dim⟧rtk grep foo"), "dim until configured");

	setPreviewTextColor("muted");
	let afterRaw = "";
	try {
		const after = await open(text, { encode: true });
		afterRaw = after.component.render(80).join("\n");
		after.component.handleInput(KEYS.escape);
		assert.equal(await after.result, undefined);
	} finally {
		setPreviewTextColor("dim");
	}
	assert.ok(afterRaw.includes("⟦muted⟧rtk grep foo"), "muted when configured");
	assert.ok(!afterRaw.includes("⟦dim⟧rtk grep foo"), "not dim any more");
});

/** Renders one text preview under `color` and returns the dialog's rows, closed again. */
async function paintedWith(color: "dim" | "muted" | "text" | "builtin-syntax" | "shell-highlight", preview: Preview): Promise<string> {
	setPreviewTextColor(color);
	try {
		const opened = await open(preview, { encode: true });
		const raw = opened.component.render(100).join("\n");
		opened.component.handleInput(KEYS.escape);
		assert.equal(await opened.result, undefined);
		return raw;
	} finally {
		setPreviewTextColor("dim");
	}
}

test("previewTextColor \"builtin-syntax\" colors the command with pi's highlighter", async () => {
	const command = `rtk grep -n "ask_user_question" extensions | head -5 # why`;
	const raw = await paintedWith("builtin-syntax", { kind: "text", text: command, lang: "bash" });
	assert.ok(/\x1b\[[0-9;]*m/.test(raw), "the body carries color codes");
	assert.ok(strip(raw).includes(command), "the command text survives the coloring");
	// the hints row is dim too, so look for the plain slot right before the command
	assert.ok(!raw.includes(`⟦dim⟧${command}`) && !raw.includes(`⟦muted⟧${command}`), "not painted as one plain slot");
});

test("previewTextColor \"shell-highlight\" uses the registered highlighter and falls back without it", async () => {
	const preview: Preview = { kind: "text", text: "git status", lang: "bash" };
	// nothing registered: pi's highlighter, i.e. the builtin-syntax look
	const fallback = await paintedWith("shell-highlight", preview);
	assert.equal(fallback, await paintedWith("builtin-syntax", preview), "no highlighter means the builtin one");

	// a registered highlighter is asked, with the dialog's own color callbacks
	const registry = globalThis as unknown as Record<symbol, unknown>;
	const seen: Array<{ text: string; lang: string | undefined; style: unknown }> = [];
	registry[HIGHLIGHTER_KEY] = {
		highlightCommand: (text: string, lang: string | undefined, style: unknown) => {
			seen.push({ text, lang, style });
			return ["⟦remote⟧" + text + "⟦/⟧"];
		},
	};
	try {
		const raw = await paintedWith("shell-highlight", preview);
		assert.ok(raw.includes("⟦remote⟧git status⟦/⟧"), "the registered highlighter's lines are shown");
	} finally {
		delete registry[HIGHLIGHTER_KEY];
	}
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.text, "git status");
	assert.equal(seen[0]?.lang, "bash");
	const style = seen[0]?.style as { command(text: string): string; plain(text: string): string; variable(text: string): string };
	assert.ok(style.command("x").includes("⟦syntaxFunction⟧"), "command names take the theme's syntaxFunction slot");
	assert.ok(style.plain("x").includes("⟦mdCodeBlock⟧"), "plain lines take mdCodeBlock");
	assert.ok(style.variable("x").includes("⟦syntaxVariable⟧"), "assignment targets take syntaxVariable");

	// a wrongly shaped registry entry is ignored, not fatal
	for (const broken of [null, {}, { highlightCommand: 7 }, "nope"]) {
		registry[HIGHLIGHTER_KEY] = broken;
		try {
			assert.equal(await paintedWith("shell-highlight", preview), fallback, String(broken));
		} finally {
			delete registry[HIGHLIGHTER_KEY];
		}
	}

	// a highlighter that throws costs the colors, not the body
	registry[HIGHLIGHTER_KEY] = {
		highlightCommand: () => {
			throw new Error("boom");
		},
	};
	try {
		assert.equal(await paintedWith("shell-highlight", preview), fallback, "a throw falls back");
	} finally {
		delete registry[HIGHLIGHTER_KEY];
	}
});

test("the command in the title is painted by the shell highlighter when the config asks for it", async () => {
	const title = dialogTitle([[seg("Permission required (plan mode)", "bold")], blankLine(), ...commandLines("  bash: ", "git status", "bash")]);
	const registry = globalThis as unknown as Record<symbol, unknown>;
	registry[HIGHLIGHTER_KEY] = { highlightCommand: (text: string) => [`⟦title⟧${text}⟦/⟧`] };
	try {
		setPreviewTextColor("shell-highlight");
		const opened = await open(undefined, { encode: true, title });
		const raw = opened.component.render(100).join("\n");
		opened.component.handleInput(KEYS.escape);
		assert.equal(await opened.result, undefined);
		assert.ok(raw.includes("⟦muted⟧  bash: "), "the label stays muted");
		assert.ok(raw.includes("⟦title⟧git status⟦/⟧"), "the command is colored, not flat yellow");
		assert.ok(!raw.includes("⟦warning⟧git status"), "no longer the flat command color");
	} finally {
		delete registry[HIGHLIGHTER_KEY];
		setPreviewTextColor("dim");
	}
});

test("a title without a language, and every non-syntax setting, keep the flat command color", async () => {
	const pattern = dialogTitle([[seg("Allow ", "bold"), seg("`git *`", "command")]]);
	const registry = globalThis as unknown as Record<symbol, unknown>;
	let asked = 0;
	registry[HIGHLIGHTER_KEY] = {
		highlightCommand: (text: string) => {
			asked++;
			return [`⟦title⟧${text}⟦/⟧`];
		},
	};
	try {
		// a command pattern carries no language, so the highlighter is not asked at any setting
		setPreviewTextColor("shell-highlight");
		const patternOpened = await open(undefined, { encode: true, title: pattern });
		const patternRaw = patternOpened.component.render(100).join("\n");
		patternOpened.component.handleInput(KEYS.escape);
		await patternOpened.result;
		assert.ok(patternRaw.includes("⟦warning⟧`git *`"), "a pattern keeps the attention color");
		assert.equal(asked, 0, "no highlighting of a pattern");

		// a command, at a setting that does not ask for syntax colors
		const command = dialogTitle([[seg("Permission required", "bold")], blankLine(), ...commandLines("  bash: ", "git status", "bash")]);
		for (const color of ["dim", "muted", "text", "builtin-syntax"] as const) {
			setPreviewTextColor(color);
			const opened = await open(undefined, { encode: true, title: command });
			const raw = opened.component.render(100).join("\n");
			opened.component.handleInput(KEYS.escape);
			await opened.result;
			assert.ok(raw.includes("⟦warning⟧git status"), color);
		}
		assert.equal(asked, 0, "the highlighter is never asked");
	} finally {
		delete registry[HIGHLIGHTER_KEY];
		setPreviewTextColor("dim");
	}
});

test("abort dismisses the dialog once, even racing a keypress", async () => {
	const controller = new AbortController();
	const { component, result, finishes } = await open(bigDiff, { signal: controller.signal });
	component.handleInput(KEYS.enter);
	controller.abort();
	assert.equal(await result, "Yes");
	assert.equal(finishes(), 1);

	const aborted = new AbortController();
	const second = await open(bigDiff, { signal: aborted.signal });
	aborted.abort();
	assert.equal(await second.result, undefined);
});

test("non-TUI sessions get the plain title and preview in a select, capped", async () => {
	let title = "";
	const ctx = {
		mode: "rpc",
		ui: {
			select: async (t: string, options: string[]) => {
				title = t;
				return options[1];
			},
		},
	} as unknown as ExtensionContext;
	const huge: Preview = { kind: "text", text: Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n") };
	assert.equal(await permissionDialog(ctx, TITLE, huge, OPTIONS), "No");
	assert.match(title, /Permission required \(default mode\)\n\n  write f\.ts\nl0\n/);
	assert.match(title, /l199\n… 300 more lines/);

	let bare = "";
	const plain = { ...ctx, ui: { select: async (t: string, options: string[]) => ((bare = t), options[0]) } } as unknown as ExtensionContext;
	assert.equal(await permissionDialog(plain, TITLE, undefined, OPTIONS), "Yes");
	assert.equal(bare, `${TITLE.plain}\n`);
});

const MODE_ITEMS: ModeDialogItem[] = [
	{ icon: "●", badge: "default", color: "mdLink", description: "everyday work", current: true },
	{ icon: "⏵⏵", badge: "auto", color: "warning", description: "trusted task", current: false },
];

async function openModes(mode: string, select?: (title: string, options: string[]) => Promise<string | undefined>, onModeShortcut?: (data: string) => boolean) {
	let component: Component | undefined;
	const theme = { fg: (color: string, text: string) => `⟦${color}⟧${text}`, bold: (text: string) => `⟦bold⟧${text}` };
	const ctx = {
		mode,
		ui: {
			select,
			custom: (factory: (...args: unknown[]) => Component) =>
				new Promise((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, resolve);
				}),
		},
	} as unknown as ExtensionContext;
	const result = selectModeDialog(ctx, MODE_ITEMS, "Pick", undefined, onModeShortcut);
	await new Promise((r) => setImmediate(r));
	return { component, result };
}

test("mode selector colors the label by mode and the description as text", async () => {
	const { component, result } = await openModes("tui");
	assert.ok(component !== undefined);
	const lines = component.render(80);
	assert.ok(lines.some((l) => l.includes("⟦bold⟧⟦mdLink⟧●  default") && l.includes("⟦text⟧ — everyday work") && l.includes("⟦dim⟧ (current)")));
	assert.ok(lines.some((l) => l.includes("⟦bold⟧⟦warning⟧⏵⏵ auto") && !l.includes("(current)")));
	assert.ok(lines.some((l) => l.replace(/⟦\w+⟧/g, "").startsWith("> ●")), "opens on the current mode");
	// the rows stack: icon, badge and description each start at the same column
	const plain = lines.map((l) => l.replace(/⟦\w+⟧/g, "")).filter((l) => l.includes(" — "));
	assert.equal(plain.length, 2);
	const descCols = plain.map((l) => l.indexOf(" — "));
	assert.ok(descCols.every((c) => c === descCols[0]), `descriptions align: ${JSON.stringify(plain)}`);
	assert.deepEqual(plain.map((l) => l.search(/default|auto/)), [5, 5], "badges align");
	component.handleInput(KEYS.down);
	component.handleInput(KEYS.enter);
	assert.equal(await result, 1);
});

test("mode selector: Esc is undefined and the shortcut is consumed", async () => {
	let shortcuts = 0;
	const { component, result } = await openModes("tui", undefined, (d) => d === KEYS.altM && ++shortcuts > 0);
	assert.ok(component !== undefined);
	component.handleInput(KEYS.altM);
	assert.equal(shortcuts, 1);
	component.handleInput(KEYS.escape);
	assert.equal(await result, undefined);
});

test("mode selector falls back to ctx.ui.select with plain strings outside the TUI", async () => {
	let seen: string[] = [];
	const { result } = await openModes("rpc", async (_t, options) => {
		seen = options;
		return options[1];
	});
	assert.equal(await result, 1);
	assert.deepEqual(seen, ["●  default — everyday work (current)", "⏵⏵ auto    — trusted task"]);
});
