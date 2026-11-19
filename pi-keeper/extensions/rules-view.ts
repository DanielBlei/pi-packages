/**
 * The `/rules` view: the rulebook, in colours from the active theme.
 *
 * `ctx.ui.notify` renders its text muted, and it cannot carry per-token colour
 * (the message goes through `sanitizeForTerminal`), so a listing that should
 * read like the rest of the UI is a small TUI component instead: name, source
 * and fire count in their own colours, then the rule's description. Enter opens
 * one rule (condition, file, body), Esc goes back, Esc there closes.
 *
 * `rulesRows` and `renderRulesList` are pure and take a narrow theme, so the
 * layout and the colours are unit-tested without a session
 * (tests/unit/rules-view.test.ts). The component adds only key handling.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { withDialogLock } from "./dialog-lock.ts";
import type { RulebookRule } from "./rulebook.ts";
import { sanitizeForTerminal } from "./preview.ts";

/** The part of pi's theme this view uses; a fake object is enough to test it. */
export interface RulesTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** One line of the list, before colours. */
export type RulesRow =
	| { readonly kind: "rule"; readonly rule: RulebookRule; readonly fired: boolean; readonly count: number }
	/** A project rule file waiting for its one-time review. */
	| { readonly kind: "untrusted"; readonly file: string }
	/** A rule file that could not be read at all. */
	| { readonly kind: "problem"; readonly file: string; readonly problem: string };

export interface RulesViewInput {
	readonly rules: readonly RulebookRule[];
	readonly untrusted: readonly { readonly file: string }[];
	readonly problems: readonly { readonly file: string; readonly problem: string }[];
	/** Rule names that fired this session. */
	readonly fired: ReadonlySet<string>;
	/** Lifetime fires by rule name: a user rule's across all projects, a project rule's in this project. */
	readonly lifetime?: ReadonlyMap<string, number>;
}

/** The rows to show: every rule, then the files that did not become one. */
export function rulesRows({ rules, untrusted, problems, fired, lifetime }: RulesViewInput): RulesRow[] {
	return [
		...rules.map((rule): RulesRow => ({ kind: "rule", rule, fired: fired.has(rule.name), count: lifetime?.get(rule.name) ?? 0 })),
		...untrusted.map((entry): RulesRow => ({ kind: "untrusted", file: entry.file })),
		...problems.map((entry): RulesRow => ({ kind: "problem", file: entry.file, problem: entry.problem })),
	];
}

const SEP = " · ";
/** "12 fires · fired this session", "12 fires", "not fired yet". A fire this session counts even if the store could not be written. */
export function fireText(count: number, fired: boolean): string {
	const total = Math.max(count, fired ? 1 : 0);
	if (total === 0) return "not fired yet";
	return `${total} ${total === 1 ? "fire" : "fires"}${fired ? " · fired this session" : ""}`;
}
const baseName = (file: string): string => file.split("/").pop() ?? file;

/**
 * Wrap one logical line to `width`. pi-tui throws when a rendered line is wider
 * than the terminal, and a rule's description, regex, file path or problem text
 * is user-written and can be any length; nothing here may emit a long line.
 * Continuation lines get `indent`. A single token longer than the width (a regex
 * has no spaces) is broken by the wrapper; the final clamp is a safety net.
 */
export function wrapLine(text: string, width: number, indent = ""): string[] {
	const room = Math.max(1, width - visibleWidth(indent));
	const parts = wrapTextWithAnsi(text, Math.max(1, width));
	const lines: string[] = [];
	for (const [index, part] of parts.entries()) {
		if (index === 0) lines.push(part);
		else lines.push(...wrapTextWithAnsi(part, room).map((piece) => `${indent}${piece}`));
	}
	return (lines.length === 0 ? [""] : lines).map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
}

/** The coloured list, one line per row. `selected` is skipped when it points at a non-rule row. */
export function renderRulesList(theme: RulesTheme, rows: readonly RulesRow[], selected: number, width: number): string[] {
	const sep = theme.fg("dim", SEP);
	const out: string[] = [];
	for (const [index, row] of rows.entries()) {
		const cursor = index === selected ? theme.fg("accent", "> ") : "  ";
		if (row.kind === "untrusted") {
			out.push(...wrapLine(`${cursor}${theme.fg("warning", baseName(sanitizeForTerminal(row.file)))}${sep}${theme.fg("warning", "needs review")}${sep}${theme.fg("text", "a project rule file; asked on the next prompt")}`, width, "    "));
			continue;
		}
		if (row.kind === "problem") {
			out.push(...wrapLine(`${cursor}${theme.fg("error", baseName(sanitizeForTerminal(row.file)))}${sep}${theme.fg("error", "skipped")}${sep}${theme.fg("text", sanitizeForTerminal(row.problem))}`, width, "    "));
			continue;
		}
		const name = theme.bold(theme.fg(index === selected ? "accent" : "mdLink", sanitizeForTerminal(row.rule.name)));
		const source = row.rule.kind === "user" ? theme.fg("success", "user") : theme.fg("warning", "project");
		const fires = theme.fg(row.fired || row.count > 0 ? "success" : "muted", fireText(row.count, row.fired));
		out.push(...wrapLine(`${cursor}${name}${sep}${source}${sep}${fires}${sep}${theme.fg("text", sanitizeForTerminal(row.rule.description))}`, width, "    "));
	}
	return out;
}

/** One rule in full: where it lives, what makes it fire, and what it says. */
export function renderRuleDetail(theme: RulesTheme, rule: RulebookRule, fired: boolean, width: number, count = 0): string[] {
	const lines: string[] = [
		...wrapLine(`${theme.bold(theme.fg("accent", sanitizeForTerminal(rule.name)))}${theme.fg("dim", SEP)}${rule.kind === "user" ? theme.fg("success", "user") : theme.fg("warning", "project")}${theme.fg("dim", SEP)}${theme.fg(fired || count > 0 ? "success" : "muted", fireText(count, fired))}`, width),
		...wrapLine(theme.fg("text", sanitizeForTerminal(rule.description)), width),
		"",
		...wrapLine(theme.fg("dim", "condition"), width),
		...wrapLine(theme.fg("mdCode", sanitizeForTerminal(rule.condition)), width, "  "),
		...wrapLine(theme.fg("dim", "file"), width),
		...wrapLine(theme.fg("dim", sanitizeForTerminal(rule.file)), width, "  "),
		"",
	];
	for (const line of sanitizeForTerminal(rule.body).split("\n")) lines.push(...(line === "" ? [""] : wrapLine(theme.fg("text", line), width)));
	return lines;
}

/** The whole screen for one render: header, list, footer. */
function listScreen(theme: RulesTheme, rows: readonly RulesRow[], selected: number, width: number): string[] {
	const header = `${theme.bold(theme.fg("text", "Rulebook rules"))}${theme.fg("dim", " · behaviour rules that fire on the model's answer; permission rules are /permissions")}`;
	const body = rows.length === 0
		? [theme.fg("text", "No rulebook rules yet."), theme.fg("dim", "Put one .md file per rule in ~/.pi/agent/pi-keeper/rules/ (all projects) or <project>/.pi/rules/ (one project).")]
		: renderRulesList(theme, rows, selected, width);
	const footer = rows.length === 0
		? theme.fg("dim", "  Esc close")
		: theme.fg("dim", "  ↑↓ select · Enter shows the rule · Esc close");
	return [...wrapLine(header, width), "", ...body.flatMap((line) => wrapLine(line, width, "  ")), "", ...wrapLine(footer, width)];
}

/** The plain-text form for a session without a TUI: same facts, no colours. */
export function rulesText(input: RulesViewInput): string {
	const lines = ["Rulebook rules (behaviour rules; permission rules are /permissions):"];
	for (const row of rulesRows(input)) {
		if (row.kind === "untrusted") lines.push(`  ${baseName(row.file)} · project · needs review (asked on the next prompt)`);
		else if (row.kind === "problem") lines.push(`  ${baseName(row.file)} · skipped: ${row.problem}`);
		else lines.push(`  ${row.rule.name} · ${row.rule.kind} · ${fireText(row.count, row.fired)} · ${row.rule.description}`);
	}
	lines.push("A fired rule sends one hidden correction and shows a card. Sources: ~/.pi/agent/pi-keeper/rules/ and .pi/rules/. /rules <name> shows one.");
	return lines.join("\n");
}

/**
 * Open the view and resolve when it closes. A host without a TUI (RPC, print)
 * gets nothing here: the caller keeps its plain-text path for those.
 */
export async function rulesPanel(ctx: ExtensionContext, input: RulesViewInput): Promise<void> {
	if (ctx.mode !== "tui") return;
	const rows = rulesRows(input);
	await withDialogLock(() => ctx.ui.custom<void>((_tui, piTheme, _keybindings, finish) => {
		const theme = piTheme as unknown as RulesTheme;
		const selectable = (index: number): number => {
			// only rules open; a status row is informational
			if (rows[index]?.kind === "rule") return index;
			const nextRule = rows.findIndex((row) => row.kind === "rule");
			return nextRule === -1 ? 0 : nextRule;
		};
		let selected = selectable(0);
		let detail: RulebookRule | undefined;

		return {
			render(width: number): string[] {
				if (detail !== undefined) {
					const fired = input.fired.has(detail.name);
					return [...renderRuleDetail(theme, detail, fired, width, input.lifetime?.get(detail.name) ?? 0), "", ...wrapLine(theme.fg("dim", "  Esc back · Esc again closes"), width)];
				}
				return listScreen(theme, rows, selected, width);
			},
			invalidate(): void {},
			handleInput(data: string): void {
				if (detail !== undefined) {
					if (matchesKey(data, Key.escape)) detail = undefined;
					return;
				}
				if (matchesKey(data, Key.escape) || data === "q") return finish();
				if (matchesKey(data, Key.up) || data === "k") {
					const previous = rows.slice(0, selected).map((row) => row.kind).lastIndexOf("rule");
					selected = previous === -1 ? selected : previous;
					return;
				}
				if (matchesKey(data, Key.down) || data === "j") {
					const next = rows.findIndex((row, index) => index > selected && row.kind === "rule");
					selected = next === -1 ? selected : next;
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const row = rows[selected];
					if (row?.kind === "rule") detail = row.rule;
				}
			},
		} satisfies Component;
	}));
}
