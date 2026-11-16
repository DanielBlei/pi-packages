/**
 * Tests for permission-dialog previews.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedDiff, DESCRIBE_COMMAND_LIMIT, DIFF_BUDGET, editsOf, MAX_PREVIEW_BYTES, previewFor, sanitizeForTerminal, type Preview } from "../../extensions/preview.ts";

const CWD = mkdtempSync(join(tmpdir(), "pi-keeper-preview-"));

function file(name: string, content: string): string {
	writeFileSync(join(CWD, name), content);
	return name;
}

function diffOf(preview: Preview | undefined): { diff: string; summary: string } {
	assert.ok(preview !== undefined && preview.kind === "diff", `expected a diff preview, got ${JSON.stringify(preview)}`);
	return preview;
}

test("write to a new file shows every line as added", async () => {
	const { diff, summary } = diffOf(await previewFor({ toolName: "write", input: { path: "new.txt", content: "a\nb\n" } }, CWD));
	assert.equal(summary, "new file, 2 lines");
	assert.deepEqual(diff.split("\n"), ["+1 a", "+2 b"]);
});

test("write over an existing file diffs against it", async () => {
	const path = file("existing.txt", "a\nb\nc\n");
	const { diff, summary } = diffOf(await previewFor({ toolName: "write", input: { path, content: "a\nB\nc\n" } }, CWD));
	assert.equal(summary, "overwrite, +1 −1 lines");
	assert.match(diff, /^-2 b$/m);
	assert.match(diff, /^\+2 B$/m);
});

test("write with identical content says so", async () => {
	const path = file("same.txt", "x\n");
	const { diff, summary } = diffOf(await previewFor({ toolName: "write", input: { path, content: "x\n" } }, CWD));
	assert.equal(diff, "");
	assert.match(summary, /no changes/);
});

test("edit applies exact edits against the file", async () => {
	const path = file("edit.txt", "one\ntwo\nthree\nfour\n");
	const input = { path, edits: [{ oldText: "two", newText: "TWO" }, { oldText: "four", newText: "FOUR" }] };
	const { diff, summary } = diffOf(await previewFor({ toolName: "edit", input }, CWD));
	assert.equal(summary, "2 edits, +2 −2 lines");
	assert.match(diff, /^-2 two$/m);
	assert.match(diff, /^\+2 TWO$/m);
	assert.match(diff, /^-4 four$/m);
	assert.match(diff, /^\+4 FOUR$/m);
});

test("edit handles BOM and CRLF files", async () => {
	const path = file("crlf.txt", "﻿alpha\r\nbeta\r\n");
	const { diff, summary } = diffOf(await previewFor({ toolName: "edit", input: { path, edits: [{ oldText: "alpha\nbeta", newText: "alpha\ngamma" }] } }, CWD));
	assert.equal(summary, "1 edit, +1 −1 lines");
	assert.match(diff, /^-2 beta$/m);
	assert.match(diff, /^\+2 gamma$/m);
});

test("edit input shapes match pi's edit tool", () => {
	const edit = { oldText: "a", newText: "b" };
	assert.deepEqual(editsOf({ path: "x", edits: [edit] }), [edit]);
	assert.deepEqual(editsOf({ path: "x", edits: JSON.stringify([edit]) }), [edit]);
	assert.deepEqual(editsOf({ path: "x", edits: JSON.stringify(edit) }), [edit]);
	assert.deepEqual(editsOf({ path: "x", edits: edit }), [edit]);
	assert.deepEqual(editsOf({ path: "x", oldText: "a", newText: "b" }), [edit]);
	assert.equal(editsOf({ path: "x", edits: "not json" }), undefined);
	assert.equal(editsOf({ path: "x", edits: [{ oldText: 1 }] }), undefined);
});

test("edit falls back to replacement text when it can't locate an edit exactly", async () => {
	const path = file("fallback.txt", "dup\ndup\n");
	const missing = diffOf(await previewFor({ toolName: "edit", input: { path, edits: [{ oldText: "nope", newText: "yes" }] } }, CWD));
	assert.match(missing.summary, /could not locate edit 1 exactly/);
	assert.deepEqual(missing.diff.split("\n"), ["-1 nope", "+1 yes"]);

	const ambiguous = diffOf(await previewFor({ toolName: "edit", input: { path, edits: [{ oldText: "dup", newText: "x" }] } }, CWD));
	assert.match(ambiguous.summary, /could not locate edit 1 exactly/);

	const noFile = diffOf(await previewFor({ toolName: "edit", input: { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] } }, CWD));
	assert.match(noFile.summary, /file not found/);
});

test("edit with overlapping edits falls back", async () => {
	const path = file("overlap.txt", "abcdef\n");
	const input = { path, edits: [{ oldText: "abcd", newText: "X" }, { oldText: "cdef", newText: "Y" }] };
	assert.match(diffOf(await previewFor({ toolName: "edit", input }, CWD)).summary, /overlap/);
});

test("long or multi-line bash commands get the full text; short ones nothing", async () => {
	const long = `echo ${"x".repeat(DESCRIBE_COMMAND_LIMIT)}`;
	assert.deepEqual(await previewFor({ toolName: "bash", input: { command: long } }, CWD), { kind: "text", text: long, lang: "bash" });
	const heredoc = "cat > f <<EOF\nhello\nEOF";
	assert.deepEqual(await previewFor({ toolName: "bash", input: { command: heredoc } }, CWD), { kind: "text", text: heredoc, lang: "bash" });
	// the language goes with it, so the dialog can color the command (previewTextColor "syntax")
	assert.deepEqual(await previewFor({ toolName: "powershell", input: { command: "Get-ChildItem `\n  -Recurse" } }, CWD), { kind: "text", text: "Get-ChildItem `\n  -Recurse", lang: "powershell" });
	assert.equal(await previewFor({ toolName: "bash", input: { command: "npm test" } }, CWD), undefined);
	assert.equal(await previewFor({ toolName: "read", input: { path: "x" } }, CWD), undefined);
});

test("write that only changes line endings or the BOM says so", async () => {
	const path = file("crlf-write.txt", "a\r\nb\r\n");
	const { diff, summary } = diffOf(await previewFor({ toolName: "write", input: { path, content: "a\nb\n" } }, CWD));
	assert.equal(diff, "");
	assert.equal(summary, "only line endings or the BOM change");
});

test("escape sequences and bidi overrides can't reach the terminal", async () => {
	const evil = "ok\n\x1b[1A\x1b[2KAllow once\rX\u202Eevil\x9b";
	const { diff } = diffOf(await previewFor({ toolName: "write", input: { path: "evil.txt", content: evil } }, CWD));
	assert.doesNotMatch(diff, /[\x1b\r\x9b\u202e]/);
	assert.match(diff, /\u241b\[1A/); // ␛ shown instead
	const command = `echo ${"x".repeat(DESCRIBE_COMMAND_LIMIT)}\x1b[2J`;
	const text = await previewFor({ toolName: "bash", input: { command } }, CWD);
	assert.ok(text?.kind === "text" && !text.text.includes("\x1b"));
	// newlines and tabs are kept
	assert.equal(sanitizeForTerminal("a\tb\nc"), "a\tb\nc");
});

test("large files and contents are not read or diffed", async () => {
	const big = "x".repeat(MAX_PREVIEW_BYTES + 1);
	const path = file("big.txt", big);
	assert.match(diffOf(await previewFor({ toolName: "write", input: { path: "other.txt", content: big } }, CWD)).summary, /too large/);
	assert.match(diffOf(await previewFor({ toolName: "write", input: { path, content: "y" } }, CWD)).summary, /too large/);
	assert.match(diffOf(await previewFor({ toolName: "edit", input: { path, edits: [{ oldText: "x", newText: "y" }] } }, CWD)).summary, /too large/);
});

test("diffs over budget show the changed region's new text instead", () => {
	const gen = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n");
	const n = Math.ceil(Math.sqrt(DIFF_BUDGET)); // (2n lines) x (2n changed) > budget
	const result = boundedDiff(`same\n${gen(n, "old")}\nend`, `same\n${gen(n, "new")}\nend`);
	assert.match(result.note ?? "", new RegExp(`diff too large: −${n} \\+${n} lines`));
	const lines = result.diff.split("\n");
	assert.equal(lines[0], "+2 new 0"); // starts after the common first line
	assert.match(lines.at(-1) ?? "", /more new lines/);
	assert.ok(lines.length <= 301);
	// small changes in big files still get the full diff
	const base = gen(20000, "l");
	assert.equal(boundedDiff(base, base.replace("l 100\n", "L 100\n")).note, undefined);
});
