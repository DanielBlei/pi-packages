/**
 * Plan approval, after Claude Code (its ExitPlanMode):
 *
 * - `PlanView` is the exit_plan_mode tool row: the plan rendered as Markdown
 *   in the transcript (so the wheel, PageUp/PageDown and search scroll it,
 *   and it stays in scrollback), under a header that tracks the outcome.
 * - `selectPlanAction` is the compact selector docked under it: the Yes
 *   rows, and "No, keep planning" as an inline text field for feedback.
 *   Outside the TUI it falls back to ctx.ui.select + ctx.ui.input.
 *
 * Plan text is model-controlled: callers sanitize it (preview.ts) before
 * it reaches the view.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { withDialogLock } from "./dialog-lock.ts";
import { paintShellLines, styleTitleLine, wantsShellHighlight } from "./dialog.ts";
import { MODES } from "./modes.ts";
import { sanitizeForTerminal } from "./preview.ts";
import { blankLine, dialogTitle, seg, type TitleSegment } from "./title.ts";

/** How the plan review ended; `pending` while the selector is open. */
export type PlanReviewOutcome = "pending" | "approved" | "kept-planning" | "rejected" | "aborted" | "superseded";

/** The snapshot kept in the tool result, so a resumed session shows the plan that was approved. */
export interface PlanDetails {
	plan: string;
	planFile: string;
	outcome: PlanReviewOutcome;
	/** The mode the plan was approved into. */
	target?: "auto" | "default";
	/** Feedback typed into the field (kept planning, or approved with feedback). */
	feedback?: string;
	/** The user edited the plan (ctrl+g) before deciding. */
	edited: boolean;
}

const OUTCOMES: readonly string[] = ["pending", "approved", "kept-planning", "rejected", "aborted", "superseded"];

/** `details` of a tool result, if it is a plan snapshot (aborts and old sessions carry none). */
export function asPlanDetails(details: unknown): PlanDetails | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const d = details as Record<string, unknown>;
	if (typeof d.plan !== "string" || typeof d.planFile !== "string" || typeof d.outcome !== "string" || !OUTCOMES.includes(d.outcome)) return undefined;
	return details as PlanDetails;
}

/** Longest feedback quoted in the row header (the full text is in the model's result). */
const HEADER_FEEDBACK_LIMIT = 200;
/** Widest the plan text gets, in columns, however wide the terminal is. */
const MAX_PLAN_WIDTH = 100;

/** The row header text for a plan snapshot. */
export function planHeaderText(details: PlanDetails): string {
	const edited = details.edited ? " · edited" : "";
	switch (details.outcome) {
		case "pending":
			return `● Plan ready for review${edited}`;
		case "approved": {
			const mode = details.target === "auto" ? "auto mode" : "manual approval";
			return `● Plan approved · ${mode}${details.feedback === undefined ? "" : " · + feedback"}${edited}`;
		}
		case "kept-planning": {
			const feedback = sanitizeForTerminal(details.feedback ?? "").replace(/\s+/g, " ").trim();
			const shown = feedback.length > HEADER_FEEDBACK_LIMIT ? `${feedback.slice(0, HEADER_FEEDBACK_LIMIT)}…` : feedback;
			return `● Kept planning: "${shown}"${edited}`;
		}
		case "superseded":
			return `● Plan review closed: the mode changed${edited}`;
		case "rejected":
			return `● Plan declined${edited}`;
		case "aborted":
			return `● Plan review interrupted${edited}`;
	}
}

/** Pads each line to `width` and paints it with the neutral card background, one blank row above and below. */
export function paintPlanBackground(theme: Pick<Theme, "bg">, lines: string[], width: number): string[] {
	const paint = (line: string): string => theme.bg("toolPendingBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
	return ["", ...lines, ""].map(paint);
}

const SHELL_FENCE_LANGS: ReadonlySet<string> = new Set(["bash", "sh", "shell", "zsh", "console"]);

/**
 * The plan's Markdown theme. A shell fenced block is painted with the same colors the
 * permission dialog will give the command, so a plan that says `git commit -m …` reads
 * like the call that asks for it; every other block keeps pi's own highlighter, which is
 * also all a plan gets when the config does not ask for the richer one.
 */
function planMarkdownTheme(theme: Pick<Theme, "fg">): MarkdownTheme {
	const base = getMarkdownTheme();
	return {
		...base,
		highlightCode: (code, lang) => {
			if (lang === undefined || SHELL_FENCE_LANGS.has(lang) === false || wantsShellHighlight() === false) {
				return base.highlightCode?.(code, lang) ?? [code];
			}
			return paintShellLines(theme, code, lang);
		},
	};
}

/**
 * Header, plan file line and the plan as Markdown, on the theme's neutral
 * toolPendingBg whatever the outcome (the tool opts out of pi's shell with
 * renderShell "self", which would turn green on success). Re-parses only
 * when the plan text changes.
 */
export class PlanView implements Component {
	private details: PlanDetails;
	private theme: Pick<Theme, "fg" | "bold" | "bg">;
	private markdown: Markdown;
	private markdownText: string;

	constructor(details: PlanDetails, theme: Pick<Theme, "fg" | "bold" | "bg">) {
		this.details = details;
		this.theme = theme;
		this.markdownText = details.plan;
		this.markdown = new Markdown(details.plan, 1, 0, planMarkdownTheme(theme));
	}

	update(details: PlanDetails, theme: Pick<Theme, "fg" | "bold" | "bg">): void {
		this.details = details;
		this.theme = theme;
		if (details.plan !== this.markdownText) {
			this.markdownText = details.plan;
			this.markdown.setText(details.plan);
		}
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const header = this.theme.bold(this.theme.fg(MODES.plan.color, planHeaderText(this.details)));
		const lines = [header, this.theme.fg("dim", `  Plan file: ${this.details.planFile}`), ""];
		// the text column is capped, so lines stay readable on a wide terminal; 1 column of left padding
		const markdownWidth = Math.max(3, Math.min(w, MAX_PLAN_WIDTH + 2));
		const body = this.markdown.render(markdownWidth).map((line) => line.trimEnd());
		return paintPlanBackground(this.theme, [...lines.map((line) => truncateToWidth(line, w)), ...body], w);
	}
}

// ---------------------------------------------------------------------------
// The selector
// ---------------------------------------------------------------------------

/** What the user decided in the selector. */
export type PlanChoice =
	/** A Yes row (index into `options`), with the typed feedback when approved by shift+tab. */
	| { kind: "approve"; row: number; feedback?: string }
	/** "No, keep planning" with feedback typed into the field. */
	| { kind: "feedback"; text: string }
	| { kind: "edit"; feedback: string; row: number }
	/** Esc */
	| { kind: "reject" }
	/** The signal fired while the selector was open, or ctrl+c. */
	| { kind: "abort" }
	/** A mode-switch shortcut was pressed; the caller performs the switch. The draft is carried, so a refused switch (a child) restores it. */
	| { kind: "mode-switch"; feedback: string; row: number };

export const PLAN_KEEP = "No, keep planning";
export const FEEDBACK_PLACEHOLDER = "Tell pi what to change";
const SELECTOR_QUESTION = "The plan is ready. Start working on it?";
/** The Yes row shift+tab approves into: manual approval (second row), as in Claude Code. */
const MANUAL_ROW = 1;

export interface PlanSelectorOptions {
	/** The Yes rows, in order; the feedback field row follows them. */
	options: string[];
	/** Commands the third Yes row pre-approves, as styled title segments (shown above the rows). */
	commandSegments?: TitleSegment[];
	signal?: AbortSignal;
	/** Feedback typed earlier, restored after the plan editor closes. */
	initialFeedback?: string;
	/** Selected row, restored after the plan editor closes. */
	initialRow?: number;
	/** Transient line under the question ("Plan updated"). */
	notice?: string;
	/** Matches the mode-switch shortcut keys (wired by index.ts, so the key definitions live in one place); pressed inside the selector it finishes with a `mode-switch` choice. */
	isModeShortcut?: (data: string) => boolean;
}

/**
 * Asks what to do with the plan: Yes rows, or feedback in the inline field.
 * Keys follow Claude Code: ↑↓ and ctrl+n/ctrl+p move everywhere; j/k and the
 * digits only off the field row (on it they type); Enter on a Yes row
 * approves, on the field sends the feedback (an empty field does nothing);
 * shift+tab approves with the feedback; ctrl+g edits the plan; Esc rejects.
 * The mode-switch shortcut (isModeShortcut) is checked first, so it works
 * even on the field row, and finishes with a `mode-switch` choice that
 * carries the typed draft and row.
 */
export async function selectPlanAction(ctx: ExtensionContext, selector: PlanSelectorOptions): Promise<PlanChoice> {
	// one dialog at a time (dialog-lock.ts); aborted while waiting for the slot = aborted
	return (await withDialogLock(() => openPlanSelector(ctx, selector), selector.signal)) ?? { kind: "abort" };
}

async function openPlanSelector(ctx: ExtensionContext, selector: PlanSelectorOptions): Promise<PlanChoice> {
	const { options, signal } = selector;
	if (signal?.aborted) return { kind: "abort" };
	if (ctx.mode !== "tui") return selectPlanActionPlain(ctx, selector);

	let onAbort: (() => void) | undefined;
	try {
		return await ctx.ui.custom<PlanChoice>((tui, theme, keybindings, finish) => {
			// abort can race a keypress: settle once
			let settled = false;
			const done = (result: PlanChoice): void => {
				if (settled) return;
				settled = true;
				finish(result);
			};
			onAbort = () => done({ kind: "abort" });
			signal?.addEventListener("abort", onAbort, { once: true });

			const fieldRow = options.length;
			let selected = Math.max(0, Math.min(selector.initialRow ?? 0, fieldRow));
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			const input = new Input({ prompt: "", placeholder: FEEDBACK_PLACEHOLDER, placeholderStyle: (text) => theme.fg("dim", text) });
			// restored as a paste, so the cursor lands after the draft (setValue leaves it at 0)
			if (selector.initialFeedback) input.handleInput(`\x1b[200~${selector.initialFeedback}\x1b[201~`);
			input.focused = selected === fieldRow;

			const title = dialogTitle([
				[seg("Plan ready", "bold")],
				[seg(SELECTOR_QUESTION, "dim")],
				...(selector.commandSegments === undefined || selector.commandSegments.length === 0
					? []
					: [blankLine(), [seg("Commands to allow for the session if you choose that option: ", "dim"), ...selector.commandSegments]]),
			]);

			const refresh = (): void => {
				cachedLines = undefined;
				tui.requestRender();
			};
			const select = (row: number): void => {
				selected = Math.max(0, Math.min(row, fieldRow));
				input.focused = selected === fieldRow;
				refresh();
			};
			const feedback = (): string => input.getValue().trim();

			function handleInput(data: string): void {
				if (selector.isModeShortcut?.(data)) return done({ kind: "mode-switch", feedback: input.getValue(), row: selected });
				if (matchesKey(data, Key.escape)) return done({ kind: "reject" });
				// pi's ctrl+c handler belongs to the editor this selector replaces
				if (matchesKey(data, "ctrl+c")) return done({ kind: "abort" });
				if (matchesKey(data, Key.up) || matchesKey(data, "ctrl+p")) return select(selected - 1);
				if (matchesKey(data, Key.down) || matchesKey(data, "ctrl+n")) return select(selected + 1);
				if (matchesKey(data, Key.enter)) {
					if (selected < fieldRow) return done({ kind: "approve", row: selected });
					// an empty field does nothing: only Esc rejects outright
					if (feedback() !== "") done({ kind: "feedback", text: feedback() });
					return;
				}
				if (matchesKey(data, "shift+tab")) {
					const text = feedback();
					return done({ kind: "approve", row: MANUAL_ROW, ...(text === "" ? {} : { feedback: text }) });
				}
				if (keybindings.matches(data, "app.editor.external")) return done({ kind: "edit", feedback: input.getValue(), row: selected });
				if (selected === fieldRow) {
					input.handleInput(data);
					return refresh();
				}
				if (data === "k") return select(selected - 1);
				if (data === "j") return select(selected + 1);
				const digit = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
				if (digit >= 0 && digit <= fieldRow) select(digit);
			}

			function render(width: number): string[] {
				if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
				const w = Math.max(1, width);
				const border = theme.fg("accent", "─".repeat(w));
				const header = title.lines.flatMap((line) => {
					const styled = styleTitleLine(theme, line);
					return styled === "" ? [""] : wrapTextWithAnsi(` ${styled}`, w);
				});
				const rows = options.flatMap((option, i) => {
					const prefix = i === selected ? theme.fg("accent", "> ") : "  ";
					const label = theme.fg(i === selected ? "accent" : "text", `${i + 1}. ${option}`);
					return wrapTextWithAnsi(`${prefix}${label}`, w);
				});
				// the field row: the label, then the input (placeholder while empty) on the same line
				const fieldFocused = selected === fieldRow;
				const fieldPrefix = fieldFocused ? theme.fg("accent", "> ") : "  ";
				const fieldLabel = `${fieldRow + 1}. ${PLAN_KEEP}`;
				const lead = `${fieldPrefix}${theme.fg(fieldFocused ? "accent" : "text", fieldLabel)}  `;
				const room = Math.max(1, w - visibleWidth(lead));
				// Input draws its cursor even unfocused, so only a focused field renders through it
				const field = fieldFocused
					? (input.render(room)[0] ?? "")
					: theme.fg("dim", truncateToWidth(input.getValue() === "" ? FEEDBACK_PLACEHOLDER : input.getValue(), room, ""));
				const lines = [border, ...header, ""];
				if (selector.notice !== undefined) lines.push(truncateToWidth(` ${theme.fg("success", selector.notice)}`, w), "");
				lines.push(...rows, truncateToWidth(lead + field, w, ""));
				if (fieldFocused) {
					const hint = feedback() === "" ? "type a note, then shift+tab approves (approving each edit) with it; enter sends it as feedback" : "shift+tab: approve (approving each edit) with this note · enter: send as feedback";
					lines.push(truncateToWidth(`     ${theme.fg("dim", hint)}`, w));
				}
				const hints = " ↑↓ select · enter confirm · shift+tab approve with note · ctrl+g edit plan · esc reject";
				lines.push("", theme.fg("dim", truncateToWidth(hints, w)), border);

				cachedWidth = width;
				cachedLines = lines;
				return lines;
			}

			return {
				render,
				handleInput,
				invalidate: () => {
					cachedLines = undefined;
					input.invalidate();
				},
			};
		});
	} finally {
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}

/** Non-TUI surfaces: a select, then a text input for the feedback. */
async function selectPlanActionPlain(ctx: ExtensionContext, selector: PlanSelectorOptions): Promise<PlanChoice> {
	const { options, signal } = selector;
	const commands = selector.commandSegments?.map((s) => s.text).join("") ?? "";
	const title = `Plan ready\n${SELECTOR_QUESTION}${commands === "" ? "" : `\nCommands to allow for the session if you choose that option: ${commands}`}`;
	const choice = await ctx.ui.select(title, [...options, PLAN_KEEP], { signal });
	if (signal?.aborted) return { kind: "abort" };
	if (choice === undefined) return { kind: "reject" };
	const row = options.indexOf(choice);
	if (row >= 0) return { kind: "approve", row };
	const text = await ctx.ui.input("What should change in the plan?", undefined, { signal });
	if (signal?.aborted) return { kind: "abort" };
	// no feedback typed: nothing to revise from, so the plan is rejected
	return text !== undefined && text.trim() !== "" ? { kind: "feedback", text: text.trim() } : { kind: "reject" };
}
