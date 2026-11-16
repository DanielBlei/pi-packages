/**
 * Dialog titles as styled lines: segments with a role (normal text, bold
 * header, command, dim explanation) instead of one plain string, which pi's
 * ui.select renders as a single accent-colored block. The styled lines are
 * what the TUI dialog renders (dialog.ts); `plain` is the same text
 * flattened, for selects, RPC clients and the UI relay.
 *
 * Segment text is sanitized here, so model-controlled commands, paths and
 * patterns cannot move the cursor or draw fake rows in the dialog.
 */

import { sanitizeForTerminal } from "./preview.ts";

/** How a segment renders in the TUI dialog (see dialog.ts for the colors). */
export type TitleStyle = "text" | "muted" | "bold" | "command" | "dim";

/** One styled run of a title line. */
export interface TitleSegment {
	readonly text: string;
	readonly style: TitleStyle;
	/**
	 * For a `command` segment: the language of the text, when the segment is a whole
	 * command (`bash`, `powershell`). The dialog then colors it with the command
	 * highlighter instead of the flat command color; without it the text is prose or a
	 * command pattern, which stays flat.
	 */
	readonly lang?: string;
}

/** A title line: styled segments; an empty line renders as a blank row. */
export type TitleLine = readonly TitleSegment[];

/** A dialog title: styled lines for the TUI, flattened text for every other surface. */
export interface DialogTitle {
	readonly lines: readonly TitleLine[];
	/** The segment texts joined per line, the lines joined with newlines. */
	readonly plain: string;
}

/** One styled run. Control characters in `text` become visible symbols. */
export function seg(text: string, style: TitleStyle = "text", lang?: string): TitleSegment {
	return { text: sanitizeForTerminal(text), style, ...(lang === undefined ? {} : { lang }) };
}

/** A blank title line. */
export function blankLine(): TitleLine {
	return [];
}

/** Title from styled lines; `plain` is derived, so the two cannot drift apart. */
export function dialogTitle(lines: readonly TitleLine[]): DialogTitle {
	return { lines, plain: lines.map((line) => line.map((segment) => segment.text).join("")).join("\n") };
}

/** Title from plain text (a relay request without styled lines): each line one text segment. */
export function titleFromPlain(plain: string): DialogTitle {
	return dialogTitle(plain.split("\n").map((line) => (line === "" ? blankLine() : [seg(line)])));
}

/**
 * `label` + command text as title lines: the label (muted — `text` is the terminal's
 * own foreground in most themes, which leaves the label uncolored next to the yellow
 * command) on the first line, the command (styled as a command) split on newlines, so
 * a multi-line command continues on lines of its own.
 *
 * `lang` names the language of `command` when the whole text is one command the user is
 * about to run, so the dialog can color it (see TitleSegment.lang); a command *pattern*
 * such as `git *` is not one and leaves it out.
 */
export function commandLines(label: string, command: string, lang?: string): TitleLine[] {
	return command
		.split("\n")
		.map((part, i) => (i === 0 ? [seg(label, "muted"), seg(part, "command", lang)] : [seg(part, "command", lang)]));
}

/** `title` with `text` in front of its first line (bold), e.g. who is asking. `text` is sanitized like any segment. */
export function prefixTitle(text: string, title: DialogTitle): DialogTitle {
	const [first = blankLine(), ...rest] = title.lines;
	return dialogTitle([[seg(text, "bold"), ...first], ...rest]);
}
