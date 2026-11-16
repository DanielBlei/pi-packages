/**
 * Previews for permission dialogs: what an edit/write would change (a diff
 * against the file on disk) and the full text of long bash commands.
 *
 * Edits are applied here with exact, unique matching only. pi's edit tool
 * also fuzzy-matches (trailing whitespace, smart quotes), so when an
 * oldText can't be located exactly the preview falls back to showing each
 * edit's own oldText -> newText diff instead of nothing.
 *
 * Everything shown is model-controlled, so previews are sanitized for the
 * terminal (sanitizeForTerminal) and diffs are bounded: the diff runs
 * synchronously on pi's UI thread, and its cost grows with
 * lines x changed lines.
 */

import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { commandOf, pathOf, type ToolCall } from "./rules.ts";
import { expandHome } from "./utils.ts";

/** Commands longer than this are cut in the dialog title (see describe). */
export const DESCRIBE_COMMAND_LIMIT = 300;

/** Files or contents larger than this are not read or diffed. */
export const MAX_PREVIEW_BYTES = 1_000_000;

/**
 * Upper bound on (total lines) x (changed lines) for a full diff; about
 * 0.2 s on a typical machine. Past it, the new text of the changed region
 * is shown instead.
 */
export const DIFF_BUDGET = 4_000_000;

/** New lines shown when the full diff is over budget. */
const SKIPPED_DIFF_LINES = 300;

export type Preview =
	| { kind: "diff"; diff: string; summary: string }
	/** `lang` is the highlighter language of the text (`bash` for bash, `powershell`), when it is a command. */
	| { kind: "text"; text: string; lang?: string };

interface Edit {
	oldText: string;
	newText: string;
}

/** Preview for a tool call, or undefined when there is nothing to show. */
export async function previewFor(call: ToolCall, cwd: string): Promise<Preview | undefined> {
	const preview = await rawPreviewFor(call, cwd);
	if (preview === undefined) return undefined;
	return preview.kind === "diff"
		? { kind: "diff", diff: sanitizeForTerminal(preview.diff), summary: sanitizeForTerminal(preview.summary) }
		: { kind: "text", text: sanitizeForTerminal(preview.text), ...(preview.lang === undefined ? {} : { lang: preview.lang }) };
}

async function rawPreviewFor(call: ToolCall, cwd: string): Promise<Preview | undefined> {
	if (call.toolName === "write") return writePreview(call.input, cwd);
	if (call.toolName === "edit") return editPreview(call.input, cwd);
	if (call.toolName === "bash" || call.toolName === "powershell") {
		const command = commandOf(call.input);
		return command.includes("\n") || command.length > DESCRIBE_COMMAND_LIMIT
			? { kind: "text", text: command, lang: call.toolName === "powershell" ? "powershell" : "bash" }
			: undefined;
	}
	return undefined;
}

/**
 * Make model-controlled text safe to print inside the dialog: C0/C1
 * control characters (ESC, CR, backspace, ...) become visible symbols, so
 * escape sequences can't move the cursor, erase lines or draw fake
 * options; bidi overrides (Trojan Source) become U+FFFD. Newlines and
 * tabs are kept.
 */
export function sanitizeForTerminal(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g, (ch) => {
		const code = ch.charCodeAt(0);
		if (code < 0x20) return String.fromCharCode(0x2400 + code); // ␛, ␍, ...
		if (code === 0x7f) return "␡"; // ␡
		return "�";
	});
}

async function writePreview(input: unknown, cwd: string): Promise<Preview | undefined> {
	const path = pathOf(input);
	const content = (input as { content?: unknown } | undefined)?.content;
	if (path === "" || typeof content !== "string") return undefined;
	if (content.length > MAX_PREVIEW_BYTES) return tooLarge("new content", content.length);
	const file = await readTextFile(resolve(cwd, expandHome(path)));
	if (file.kind === "tooLarge") return tooLarge("existing file", file.bytes);
	const updated = normalizeToLF(content);
	if (file.kind === "missing") {
		const lines = updated === "" ? 0 : updated.replace(/\n$/, "").split("\n").length;
		const { diff, note } = boundedDiff("", updated);
		return { kind: "diff", diff, summary: `new file, ${lines} line${lines === 1 ? "" : "s"}${note === undefined ? "" : ` (${note})`}` };
	}
	if (file.text === updated) {
		const summary = file.raw === content ? "no changes (content is identical)" : "only line endings or the BOM change";
		return { kind: "diff", diff: "", summary };
	}
	const { diff, note } = boundedDiff(file.text, updated);
	return { kind: "diff", diff, summary: `overwrite, ${note ?? countChanges(diff)}` };
}

async function editPreview(input: unknown, cwd: string): Promise<Preview | undefined> {
	const path = pathOf(input);
	const edits = editsOf(input);
	if (path === "" || edits === undefined || edits.length === 0) return undefined;
	const file = await readTextFile(resolve(cwd, expandHome(path)));
	if (file.kind === "tooLarge") return fallbackPreview(edits, `file too large to diff (${formatBytes(file.bytes)}) — showing replacement text`);
	if (file.kind === "missing") return fallbackPreview(edits, "file not found or unreadable — showing replacement text");
	const original = file.text;

	const located: Array<Edit & { index: number }> = [];
	for (const [i, edit] of edits.entries()) {
		const index = original.indexOf(edit.oldText);
		const unique = index !== -1 && edit.oldText !== "" && original.indexOf(edit.oldText, index + 1) === -1;
		if (!unique) return fallbackPreview(edits, `could not locate edit ${i + 1} exactly — showing replacement text`);
		located.push({ ...edit, index });
	}
	located.sort((a, b) => a.index - b.index);
	for (let i = 1; i < located.length; i++) {
		if (located[i].index < located[i - 1].index + located[i - 1].oldText.length) {
			return fallbackPreview(edits, "edits overlap — showing replacement text");
		}
	}
	let updated = original;
	for (const edit of [...located].reverse()) {
		updated = updated.slice(0, edit.index) + edit.newText + updated.slice(edit.index + edit.oldText.length);
	}
	const { diff, note } = boundedDiff(original, updated);
	return { kind: "diff", diff, summary: `${edits.length} edit${edits.length === 1 ? "" : "s"}, ${note ?? countChanges(diff)}` };
}

/** Each edit's own oldText -> newText diff, separated by a blank line. */
function fallbackPreview(edits: Edit[], note: string): Preview {
	const diff = edits.map((edit) => boundedDiff(edit.oldText, edit.newText).diff).join("\n\n");
	return { kind: "diff", diff, summary: note };
}

function tooLarge(what: string, bytes: number): Preview {
	return { kind: "diff", diff: "", summary: `${what} too large to preview (${formatBytes(bytes)})` };
}

/**
 * generateDiffString within DIFF_BUDGET. Over budget, the changed region
 * (after trimming common leading/trailing lines) is shown as added lines,
 * capped, with a note for the summary.
 */
export function boundedDiff(oldText: string, newText: string): { diff: string; note?: string } {
	const a = oldText === "" ? [] : oldText.split("\n");
	const b = newText === "" ? [] : newText.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let end = 0;
	while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	const removed = a.length - start - end;
	const added = b.length - start - end;
	if ((a.length + b.length) * (removed + added) <= DIFF_BUDGET) return { diff: generateDiffString(oldText, newText).diff };

	const shown = b.slice(start, start + Math.min(added, SKIPPED_DIFF_LINES)).map((line, i) => `+${start + i + 1} ${line}`);
	if (added > shown.length) shown.push(` … ${added - shown.length} more new lines`);
	return { diff: shown.join("\n"), note: `diff too large: −${removed} +${added} lines, showing the new text` };
}

/**
 * Edits of an edit call, in every shape pi's edit tool accepts: an
 * `edits` array, `edits` as a JSON string, a single edit object, or
 * legacy top-level `oldText`/`newText`.
 */
export function editsOf(input: unknown): Edit[] | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const args = input as { edits?: unknown; oldText?: unknown; newText?: unknown };
	let raw: unknown = args.edits;
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	const list: unknown[] = Array.isArray(raw) ? [...raw] : isEdit(raw) ? [raw] : [];
	if (typeof args.oldText === "string" && typeof args.newText === "string") list.push({ oldText: args.oldText, newText: args.newText });
	if (!list.every(isEdit)) return undefined;
	return list.map((e) => ({ oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText) }));
}

function isEdit(value: unknown): value is Edit {
	const edit = value as Partial<Edit> | null | undefined;
	return typeof edit?.oldText === "string" && typeof edit.newText === "string";
}

type TextFile = { kind: "missing" } | { kind: "tooLarge"; bytes: number } | { kind: "text"; raw: string; text: string };

/**
 * A file's raw text and its BOM-less, LF form; size-capped. Only a regular
 * file is read: a FIFO, a device or /proc/self/fd/0 would block or never end,
 * so it counts as missing. Opened non-blocking and checked with fstat on the
 * open descriptor (no stat/open race); symlinks are followed, as the tools do.
 */
async function readTextFile(path: string): Promise<TextFile> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const st = await handle.stat();
		if (!st.isFile()) return { kind: "missing" };
		if (st.size > MAX_PREVIEW_BYTES) return { kind: "tooLarge", bytes: st.size };
		const raw = await handle.readFile("utf8");
		return { kind: "text", raw, text: normalizeToLF(raw.replace(/^\ufeff/, "")) };
	} catch {
		return { kind: "missing" };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function countChanges(diff: string): string {
	const lines = diff.split("\n");
	const added = lines.filter((l) => l.startsWith("+")).length;
	const removed = lines.filter((l) => l.startsWith("-")).length;
	return `+${added} −${removed} lines`;
}

function formatBytes(bytes: number): string {
	return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
}
