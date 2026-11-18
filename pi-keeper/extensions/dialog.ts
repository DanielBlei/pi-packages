/**
 * Permission dialog with a preview (diff or full command) above the
 * options, so the user sees what a call will do before answering. The
 * title is styled per line (title.ts): headers and questions bold in the
 * normal text color, commands in the theme's warning color (yellow, like
 * the auto-mode badge), explanations dim — except a whole command when
 * `commandColors` asks for the shell highlighter (see below). Without a
 * preview the same dialog shows just the title and the options.
 *
 * The full command of a long bash call (preview.kind === "text") is painted in the
 * slot `commandColors` names (config.ts), because a theme's dim is often only just
 * readable for a block of body text. Unset, it is `"shell-highlight"` when
 * `pi-shell-highlight` is loaded and `"dim"` when not; the choice is made each time a
 * dialog opens, so a package that loads later counts. The two syntax values color it
 * instead: `"builtin-syntax"` with pi's own highlighter (the one the transcript uses
 * for fenced code), `"shell-highlight"` with `pi-shell-highlight` (command names and the
 * inner language of a heredoc; without that package it means dim). `"shell-highlight"`
 * reaches two more surfaces through
 * `paintShellLines`: the one-line `bash: <command>` title of a short command (which has
 * no preview block), and a shell fenced block in the plan view (plan-approval.ts).
 * A diff preview keeps its own added/removed colors on purpose: there the colors carry
 * meaning.
 *
 * A mode-switch shortcut (onModeShortcut) is consumed without closing the
 * dialog: the answer still governs the pending call, and the next call
 * follows the new mode.
 *
 * Returns the chosen option label (undefined on Esc or abort), like
 * ctx.ui.select, so callers keep their branch logic.
 */

import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { highlightCode, renderDiff } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { effectiveCommandColors, type PreviewTextColor } from "./config.ts";
import { withDialogLock } from "./dialog-lock.ts";
import { ALLOW_ONCE } from "./options.ts";
import type { Preview } from "./preview.ts";
import { commandHighlighter, type CommandStyle } from "./shell-highlight-bridge.ts";
import type { DialogTitle, TitleLine, TitleSegment } from "./title.ts";

/**
 * The configured full-command color: what config.ts holds, undefined when unset. Set once per
 * session from the config (index.ts, right after `loadConfig`), so every dialog of this process
 * agrees. It is resolved against the loaded highlighter at each use, not here.
 */
let commandColors: PreviewTextColor | undefined;

/** Use `color` (undefined: unset) for the full-command text of every later dialog (config `commandColors`). */
export function setPreviewTextColor(color: PreviewTextColor | undefined): void {
	commandColors = color;
}

/** The color in effect now: the configured one, or the default that depends on whether pi-shell-highlight is loaded. */
function resolvedCommandColors(): PreviewTextColor {
	return effectiveCommandColors(commandColors, commandHighlighter() !== undefined);
}

/** True when the command is painted by the shell highlighter (`shell-highlight` in effect). */
export function wantsShellHighlight(): boolean {
	return resolvedCommandColors() === "shell-highlight";
}

/**
 * How the command highlighter paints what it decides, in the theme that draws the text.
 * One definition for every surface that shows a shell command (the dialog title, the
 * full-command preview, the plan's fenced blocks), so they cannot drift apart: a command
 * name is `syntaxFunction`, a runner (python, go, npm) `syntaxType`, a precommand
 * (sudo, rtk) `syntaxVariable`, an option `syntaxNumber`.
 */
export function shellStyle(theme: Pick<Theme, "fg">): CommandStyle {
	return {
		command: (text) => theme.fg("syntaxFunction", text),
		// a runner names the language or the task, so it reads louder than a plain tool
		runner: (text) => theme.fg("syntaxType", text),
		// a precommand only says *how* the command runs: it recedes
		precommand: (text) => theme.fg("syntaxVariable", text),
		option: (text) => theme.fg("syntaxNumber", text),
		plain: (text) => theme.fg("mdCodeBlock", text),
		variable: (text) => theme.fg("syntaxVariable", text),
	};
}

/**
 * Shell text as colored lines: `pi-shell-highlight` when it is loaded (command names and
 * the inner language of a heredoc on top of the grammar), pi's own highlighter when it is
 * not or when it throws. Never throws itself, so a caller can paint a title with it.
 */
export function paintShellLines(theme: Pick<Theme, "fg">, text: string, lang: string): string[] {
	const highlighter = commandHighlighter();
	if (highlighter !== undefined) {
		try {
			return highlighter(text, lang, shellStyle(theme));
		} catch {
			// a broken highlighter must not cost the caller its text
		}
	}
	return highlightCode(text, lang);
}

/**
 * The full-command text: syntax-colored when configured, else one plain theme slot.
 * pi's highlighter reads the process theme (as renderDiff does), not the `theme`
 * argument, which is the same instance in the TUI; the richer renderer gets the color
 * callbacks and stays a pure function of text and style. Either way a language nothing
 * knows comes back uncolored rather than failing.
 */
function paintCommand(theme: Pick<Theme, "fg">, preview: { text: string; lang?: string }): string {
	const lang = preview.lang ?? "bash";
	const color = resolvedCommandColors();
	if (color === "shell-highlight") return paintShellLines(theme, preview.text, lang).join("\n");
	// builtin-syntax keeps pi's highlighter alone
	if (color === "builtin-syntax") return highlightCode(preview.text, lang).join("\n");
	return theme.fg(color, preview.text);
}

/** Preview lines kept in the plain-text fallback (RPC select title). */
const PLAIN_PREVIEW_LINES = 200;

/** Rows left free below the dialog (pi's footer/status lines). */
const RESERVED_ROWS = 4;
/** Keep enough command/diff content visible to make paging useful. */
const MIN_VIEWPORT = 10;
const MAX_VIEWPORT = 15;

/** One title segment in its dialog color: commands yellow (the warning slot, like the auto-mode badge), labels muted, headers bold, explanations dim. */
function styleSegment(theme: Pick<Theme, "fg" | "bold">, segment: TitleSegment): string {
	if (segment.style === "command") return styleCommand(theme, segment);
	if (segment.style === "muted") return theme.fg("muted", segment.text);
	if (segment.style === "bold") return theme.bold(theme.fg("text", segment.text));
	if (segment.style === "dim") return theme.fg("dim", segment.text);
	return theme.fg("text", segment.text);
}

/**
 * A command in a title. With a language and the shell highlighter configured, the words
 * are colored as shell text, so the one-line `bash: <command>` form reads like the
 * full-command preview below it; otherwise — another setting, a command pattern, a
 * highlighter that throws — it keeps the flat yellow that draws the eye.
 */
function styleCommand(theme: Pick<Theme, "fg" | "bold">, segment: TitleSegment): string {
	if (segment.lang === undefined || segment.text.trim() === "" || wantsShellHighlight() === false) return theme.fg("warning", segment.text);
	const lines = paintShellLines(theme, segment.text, segment.lang);
	return lines.length === 1 && lines[0] !== undefined ? lines[0] : theme.fg("warning", segment.text);
}

/** A title line in its dialog colors (shared with the plan-approval selector). */
export function styleTitleLine(theme: Pick<Theme, "fg" | "bold">, line: TitleLine): string {
	return line.map((segment) => styleSegment(theme, segment)).join("");
}

export function permissionDialog(
	ctx: ExtensionContext,
	title: DialogTitle,
	preview: Preview | undefined,
	options: string[],
	escLabel = "reject",
	signalOverride?: AbortSignal,
	onModeShortcut?: (data: string) => boolean,
	/** Run inside the lock, before the dialog opens: true when the call is now allowed (a grant a queued dialog just made), and the dialog is skipped. */
	recheck?: () => boolean,
): Promise<string | undefined> {
	// the one choke point of every permission select, the parent's own and a child's relayed ask
	return withDialogLock(async () => {
		if (recheck !== undefined) {
			// Yield one macrotask first: the dialog that held the lock just before may still be on its way
			// to recording its answer (a grant is written after its promise settles, a few microtasks later),
			// and the recheck must see that grant.
			await new Promise((resolve) => setImmediate(resolve));
			if (recheck() === true) return ALLOW_ONCE;
		}
		return openPermissionDialog(ctx, title, preview, options, escLabel, signalOverride, onModeShortcut);
	}, signalOverride ?? ctx.signal);
}

async function openPermissionDialog(
	ctx: ExtensionContext,
	title: DialogTitle,
	preview: Preview | undefined,
	options: string[],
	/** What Esc does, shown in the hints line ("reject" in the main dialog, "back" in a sub-list). */
	escLabel = "reject",
	/** Closes the dialog when aborted, overriding ctx.signal (the child relay passes the child's signal). */
	signalOverride?: AbortSignal,
	/**
	 * Handles a mode-switch shortcut pressed inside the dialog; returns true when it
	 * consumed the key. The dialog stays open: the answer still governs the pending
	 * call, and the next call follows the new mode.
	 */
	onModeShortcut?: (data: string) => boolean,
): Promise<string | undefined> {
	const signal = signalOverride ?? ctx.signal;
	if (ctx.mode !== "tui") {
		return ctx.ui.select(`${title.plain}\n${preview === undefined ? "" : `${plainPreview(preview)}\n`}`, options, { signal });
	}

	if (signal?.aborted) return undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, finish) => {
			// abort can race a keypress: settle once
			let settled = false;
			const done = (result: string | undefined): void => {
				if (settled) return;
				settled = true;
				finish(result);
			};
			onAbort = () => done(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });

			const hasPreview = preview !== undefined;
			const body =
				preview === undefined
					? ""
					: (preview.kind === "diff" ? renderDiff(preview.diff) : paintCommand(theme, preview)).replace(/\t/g, "    ");
			let bodyLines: string[] = body === "" ? [] : body.split("\n");
			const summary = preview !== undefined && preview.kind === "diff" ? preview.summary : "full command";

			let selected = 0;
			let scroll = 0;
			let viewport = MIN_VIEWPORT;
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			const refresh = (): void => {
				cachedLines = undefined;
				tui.requestRender();
			};
			const scrollBy = (delta: number): void => {
				scroll = Math.max(0, Math.min(scroll + delta, Math.max(0, bodyLines.length - viewport)));
				refresh();
			};

			function handleInput(data: string): void {
				if (onModeShortcut?.(data)) return;
				if (matchesKey(data, Key.escape)) return done(undefined);
				if (matchesKey(data, Key.enter)) return done(options[selected]);
				if (matchesKey(data, Key.shift("up"))) return scrollBy(-1);
				if (matchesKey(data, Key.shift("down"))) return scrollBy(1);
				if (matchesKey(data, Key.pageUp)) return scrollBy(-Math.max(1, viewport - 2));
				if (matchesKey(data, Key.pageDown)) return scrollBy(Math.max(1, viewport - 2));
				if (matchesKey(data, Key.home)) return scrollBy(-bodyLines.length);
				if (matchesKey(data, Key.end)) return scrollBy(bodyLines.length);
				if (matchesKey(data, Key.up) || data === "k") {
					selected = Math.max(0, selected - 1);
					return refresh();
				}
				if (matchesKey(data, Key.down) || data === "j") {
					selected = Math.min(options.length - 1, selected + 1);
					return refresh();
				}
			}

			function render(width: number): string[] {
				if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
				const w = Math.max(1, width);
				const border = theme.fg("accent", "─".repeat(w));

				// trailing blank lines are dropped, as the string title's trailing newlines were
				// Wrap each logical preview line instead of truncating it horizontally. This
				// is especially important for long, single-line interpreter commands.
				bodyLines = body === "" ? [] : body.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(` ${line}`, w)));
				const headerTexts = title.lines.map((line) => styleTitleLine(theme, line));
				while (headerTexts.length > 0 && headerTexts[headerTexts.length - 1] === "") headerTexts.pop();
				const header = headerTexts.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(` ${line}`, w)));
				const optionLines = options.flatMap((option, i) => {
					const prefix = i === selected ? theme.fg("accent", "> ") : "  ";
					const label = theme.fg(i === selected ? "accent" : "text", option);
					return wrapTextWithAnsi(`${prefix}${label}`, w);
				});
				const hints = ` ↑↓ select · enter confirm · esc ${escLabel}`;

				// border, header, blank, [summary, viewport, indicator, blank], options, blank, hints, border
				const fixed = hasPreview
					? 2 + header.length + 2 + 1 + 1 + optionLines.length + 2
					: 2 + header.length + 1 + optionLines.length + 2;
				const available = tui.terminal.rows - RESERVED_ROWS - fixed;
				const target = Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, bodyLines.length));
				viewport = hasPreview ? Math.max(1, Math.min(target, available)) : 0;
				scroll = Math.max(0, Math.min(scroll, bodyLines.length - viewport));
				const scrollable = bodyLines.length > viewport;

				const lines = [border, ...header];
				if (hasPreview) {
					lines.push("", ` ${theme.fg("muted", summary)}`);
					for (const line of bodyLines.slice(scroll, scroll + viewport)) lines.push(line);
					if (scrollable) {
						const last = Math.min(scroll + viewport, bodyLines.length);
						lines.push(theme.fg("dim", truncateToWidth(` lines ${scroll + 1}–${last} of ${bodyLines.length} · pgup/pgdn, shift+↑↓ scroll`, w)));
					}
				}
				lines.push("", ...optionLines, "", theme.fg("dim", truncateToWidth(hints, w)), border);

				cachedWidth = width;
				cachedLines = lines;
				return lines;
			}

			return {
				render,
				handleInput,
				invalidate: () => {
					cachedLines = undefined;
				},
			};
		});
	} finally {
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}

/** Uncolored preview for non-TUI dialogs, capped at PLAIN_PREVIEW_LINES. */
function plainPreview(preview: Preview): string {
	const text = preview.kind === "diff" ? `${preview.summary}\n${preview.diff}` : preview.text;
	const lines = text.split("\n");
	if (lines.length <= PLAIN_PREVIEW_LINES) return text;
	return `${lines.slice(0, PLAIN_PREVIEW_LINES).join("\n")}\n… ${lines.length - PLAIN_PREVIEW_LINES} more lines`;
}

/** One /mode selector row: icon and badge (padded into aligned columns, colored like the footer chip) plus a plain-text description. */
export interface ModeDialogItem {
	icon: string;
	badge: string;
	color: ThemeColor;
	description: string;
	current: boolean;
}

/** Icon + badge padded into fixed columns, so the rows stack: `● default`, `» auto`, `≡ plan`. */
function padModeLabel(item: ModeDialogItem, iconWidth: number, badgeWidth: number): string {
	const icon = item.icon + " ".repeat(iconWidth - visibleWidth(item.icon));
	const badge = item.badge + " ".repeat(badgeWidth - visibleWidth(item.badge));
	return `${icon} ${badge}`;
}

/**
 * The /mode selector: rows stacked in aligned columns — bold icon and badge
 * in the mode's footer-chip color, description in the text color. Returns the
 * chosen index (undefined on Esc or abort). Non-TUI modes fall back to
 * ctx.ui.select with plain strings.
 */
export async function selectModeDialog(
	ctx: ExtensionContext,
	items: ModeDialogItem[],
	title: string,
	signal?: AbortSignal,
	onModeShortcut?: (data: string) => boolean,
): Promise<number | undefined> {
	const iconWidth = Math.max(...items.map((item) => visibleWidth(item.icon)));
	const badgeWidth = Math.max(...items.map((item) => visibleWidth(item.badge)));
	const plain = items.map((item) => `${padModeLabel(item, iconWidth, badgeWidth)} — ${item.description}${item.current ? " (current)" : ""}`);
	if (ctx.mode !== "tui") {
		const picked = await ctx.ui.select(title, plain, signal === undefined ? undefined : { signal });
		return picked === undefined ? undefined : plain.indexOf(picked);
	}
	if (signal?.aborted) return undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await ctx.ui.custom<number | undefined>((tui, theme, _keybindings, finish) => {
			let settled = false;
			const done = (result: number | undefined): void => {
				if (settled) return;
				settled = true;
				finish(result);
			};
			onAbort = () => done(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });

			let selected = Math.max(0, items.findIndex((item) => item.current));
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;
			const refresh = (): void => {
				cachedLines = undefined;
				tui.requestRender();
			};

			function handleInput(data: string): void {
				if (onModeShortcut?.(data)) return;
				if (matchesKey(data, Key.escape)) return done(undefined);
				if (matchesKey(data, Key.enter)) return done(selected);
				if (matchesKey(data, Key.up) || data === "k") {
					selected = Math.max(0, selected - 1);
					return refresh();
				}
				if (matchesKey(data, Key.down) || data === "j") {
					selected = Math.min(items.length - 1, selected + 1);
					return refresh();
				}
			}

			function render(width: number): string[] {
				if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
				const w = Math.max(1, width);
				const border = theme.fg("accent", "─".repeat(w));
				const header = title.split("\n").flatMap((line) => wrapTextWithAnsi(` ${theme.bold(theme.fg("text", line))}`, w));
				const rows = items.flatMap((item, i) => {
					const prefix = i === selected ? theme.fg("accent", "> ") : "  ";
					const text =
						`${prefix}${theme.bold(theme.fg(item.color, padModeLabel(item, iconWidth, badgeWidth)))}${theme.fg("text", ` — ${item.description}`)}` +
						(item.current ? theme.fg("dim", " (current)") : "");
					return wrapTextWithAnsi(text, w);
				});
				const hints = " ↑↓ select · enter confirm · esc keep";
				cachedWidth = width;
				cachedLines = [border, ...header, "", ...rows, "", theme.fg("dim", truncateToWidth(hints, w)), border];
				return cachedLines;
			}

			return {
				render,
				handleInput,
				invalidate: () => {
					cachedLines = undefined;
				},
			};
		});
	} finally {
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}
