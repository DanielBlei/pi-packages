/**
 * The `/keeper` settings panel: the settings from `config.ts` laid out in
 * sections (tabs), one row per setting with the value in an aligned right-hand
 * column.
 *
 * pi-tui's SettingsList does the rows, the columns, the arrow keys and the
 * search — this file adds the tab bar, the footer, and the free-text row for a
 * duration. Enter or Space on a row flips a toggle or cycles a choice; a row
 * without `values` opens a one-line input (Enter accepts, Esc goes back).
 *
 * Every row's value is re-read through `currentValue` after each change, so a
 * value the caller rejects snaps back to what is saved instead of being shown
 * as if it had been applied.
 *
 * Free of pi types beyond the TUI component contract, so it is testable without
 * a session.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, SettingsList, truncateToWidth, type Component, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";

export interface PanelItem {
	readonly id: string;
	/** Left column: what the setting is. Keep the value out of it. */
	readonly label: string;
	/** Help text under the list while this row is selected. */
	readonly description?: string;
	/** Values Enter/Space cycle through; a row without them opens a text input. */
	readonly values?: readonly string[];
	/** Placeholder of that input. */
	readonly placeholder?: string;
}

export interface PanelSection {
	readonly id: string;
	readonly label: string;
	readonly items: readonly PanelItem[];
}

/** What to show in the footer after a change. */
export interface PanelResult {
	readonly message: string;
	readonly error?: boolean;
}

export interface PanelOptions {
	/** The value shown in the right column; read again after every change. */
	currentValue(id: string): string;
	/** Apply a picked or typed value. */
	apply(id: string, value: string): PanelResult;
}

const HINTS = "  Enter/Space change · Tab/Shift+Tab sections · Esc close";

/** Rows kept on screen; longer sections scroll (SettingsList shows "n/total"). */
const MAX_VISIBLE_ROWS = 10;

function panelTheme(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.bold(theme.fg("text", text)) : theme.fg("text", text)),
		value: (text, selected) => (selected ? theme.bold(theme.fg("accent", text)) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "> "),
		hint: (text) => theme.fg("dim", text),
	};
}

function renderTabs(theme: Theme, sections: readonly PanelSection[], active: number, width: number): string {
	const pieces = sections.map((section, i) => (i === active ? theme.bold(theme.fg("text", section.label)) : theme.fg("dim", section.label)));
	return truncateToWidth(`  ${pieces.join(theme.fg("dim", " / "))}`, width);
}

/** Tab / Shift+Tab, in the encodings terminals send (CSI Z is Shift+Tab). */
function isNextSection(data: string): boolean {
	return data === "\t" || matchesKey(data, "tab");
}

function isPreviousSection(data: string): boolean {
	return data === "\x1b[Z" || matchesKey(data, "shift+tab");
}

/** One line of text in a submenu row: Enter accepts, Esc backs out without a value. */
function textRow(theme: Theme, placeholder: string, done: (value?: string) => void): Component {
	// deliberately not prefilled with the current value: the row's column already shows it, and a
	// prefilled draft would have to be deleted before a new value can be typed
	const input = new Input({ prompt: "", placeholder, placeholderStyle: (text) => theme.fg("dim", text) });
	input.focused = true;
	return {
		render: (width: number) => input.render(width),
		invalidate: () => input.invalidate(),
		handleInput: (data: string) => {
			if (matchesKey(data, Key.escape)) return done(undefined);
			if (matchesKey(data, Key.enter)) {
				const value = input.getValue().trim();
				return done(value === "" ? undefined : value);
			}
			input.handleInput(data);
		},
	};
}

/**
 * Open the panel and resolve when it closes. A host without a TUI (RPC, print)
 * gets nothing: the caller keeps its own plain-dialog path for those.
 */
export async function settingsPanel(
	ctx: ExtensionContext,
	title: string,
	sections: readonly PanelSection[],
	options: PanelOptions,
): Promise<void> {
	const shown = sections.filter((section) => section.items.length > 0);
	if (ctx.mode !== "tui" || shown.length === 0) return;

	await ctx.ui.custom<void>((tui, theme, _keybindings, finish) => {
		let active = 0;
		/** A text row is open: Tab must reach the input, not switch sections. */
		let inSubmenu = false;
		let notice: PanelResult | undefined;
		let settled = false;

		const close = (): void => {
			if (settled) return;
			settled = true;
			finish();
		};

		const itemsOf = (section: PanelSection): SettingItem[] =>
			section.items.map((item) => ({
				id: item.id,
				label: item.label,
				...(item.description === undefined ? {} : { description: item.description }),
				currentValue: options.currentValue(item.id),
				...(item.values === undefined
					? {
							submenu: (current: string, done: (value?: string) => void) => {
								inSubmenu = true;
								return textRow(theme, item.placeholder ?? "new value", (value) => {
									inSubmenu = false;
									done(value);
									tui.requestRender();
								});
							},
						}
					: { values: [...item.values] }),
			}));

		const onChange = (id: string, value: string): void => {
			notice = options.apply(id, value);
			// a rejected value snaps back: every row shows what is actually saved
			for (const [index, section] of shown.entries()) {
				for (const item of section.items) lists[index]?.updateValue(item.id, options.currentValue(item.id));
			}
			tui.requestRender();
		};

		const lists = shown.map(
			(section) =>
				new SettingsList(itemsOf(section), Math.min(MAX_VISIBLE_ROWS, Math.max(section.items.length, 1)), panelTheme(theme), onChange, close, { enableSearch: false }),
		);

		return {
			render(width: number): string[] {
				const w = Math.max(1, Math.floor(width));
				const rule = theme.fg("dim", "─".repeat(w));
				const body = lists[active]?.render(w) ?? [];
				// drop SettingsList's own hint line: the footer below is the single source,
				// and its selected row's description stays (it is the help text).
				const hint = body.findIndex((line) => line.includes("Esc to cancel"));
				const rows = hint >= 0 ? body.slice(0, hint) : [...body];
				while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
				const footer = notice === undefined ? theme.fg("dim", truncateToWidth(HINTS, w)) : truncateToWidth(`  ${notice.error === true ? theme.fg("error", notice.message) : theme.fg("success", notice.message)}`, w);
				return [truncateToWidth(`  ${theme.bold(theme.fg("text", title))}`, w), rule, renderTabs(theme, shown, active, w), rule, ...rows, rule, footer, rule];
			},
			invalidate(): void {
				for (const list of lists) list.invalidate();
			},
			handleInput(data: string): void {
				if (!inSubmenu && isNextSection(data)) {
					active = (active + 1) % shown.length;
					tui.requestRender();
					return;
				}
				if (!inSubmenu && isPreviousSection(data)) {
					active = (active - 1 + shown.length) % shown.length;
					tui.requestRender();
					return;
				}
				lists[active]?.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
