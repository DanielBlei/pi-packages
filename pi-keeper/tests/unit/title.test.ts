/**
 * Tests for the styled dialog title model.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankLine, commandLines, dialogTitle, prefixTitle, seg, titleFromPlain, type TitleLine } from "../../extensions/title.ts";

test("seg sanitizes control characters but keeps the text", () => {
	assert.deepEqual(seg("npm test"), { text: "npm test", style: "text" });
	assert.deepEqual(seg("\x1b[31m rm", "command"), { text: "␛[31m rm", style: "command" });
	assert.equal(seg("a\r\nb", "dim").text, "a␍\nb");
});

test("dialogTitle flattens segment texts into plain, blank lines included", () => {
	const title = dialogTitle([
		[seg("Plan ready: ", "bold"), seg("/tmp/p.md")],
		blankLine(),
		[seg("label: ", "dim"), seg("`npm test`", "command")],
	]);
	assert.equal(title.plain, "Plan ready: /tmp/p.md\n\nlabel: `npm test`");
	assert.equal(title.lines.length, 3);
	assert.deepEqual(title.lines[0], [
		{ text: "Plan ready: ", style: "bold" },
		{ text: "/tmp/p.md", style: "text" },
	]);
});

test("commandLines puts the label on the first line and splits the command on newlines", () => {
	const lines: TitleLine[] = commandLines("  bash: ", "echo one\necho two");
	assert.equal(lines.length, 2);
	assert.deepEqual(lines[0], [
		{ text: "  bash: ", style: "muted" },
		{ text: "echo one", style: "command" },
	]);
	assert.deepEqual(lines[1], [{ text: "echo two", style: "command" }]);
	// flattened, this is the plain description again
	assert.equal(lines.map((l) => l.map((s) => s.text).join("")).join("\n"), "  bash: echo one\necho two");
});

test("commandLines marks the command with its language only when it is one", () => {
	const command = commandLines("  bash: ", "echo one\necho two", "bash");
	assert.deepEqual(command[0]?.[1], { text: "echo one", style: "command", lang: "bash" });
	assert.deepEqual(command[1]?.[0], { text: "echo two", style: "command", lang: "bash" });
	assert.deepEqual(command[0]?.[0], { text: "  bash: ", style: "muted" }, "the label is not a command");
	// a command pattern is not a command: no language, so the dialog keeps it flat
	assert.deepEqual(commandLines("  ", "git *")[0]?.[1], { text: "git *", style: "command" });
});

test("titleFromPlain round-trips each line as one text segment", () => {
	const title = titleFromPlain("One\n\nTwo");
	assert.equal(title.plain, "One\n\nTwo");
	assert.deepEqual(title.lines, [[{ text: "One", style: "text" }], [], [{ text: "Two", style: "text" }]]);
	assert.deepEqual(titleFromPlain("").lines, [[]]);
});

test("prefixTitle puts bold text in front of the first line, keeps the rest and rebuilds plain", () => {
	const title = dialogTitle([[seg("Permission required", "bold")], blankLine(), [seg("npm test", "command")]]);
	const prefixed = prefixTitle("Background subagent scout: ", title);
	assert.equal(prefixed.plain, "Background subagent scout: Permission required\n\nnpm test");
	assert.deepEqual(prefixed.lines[0][0], { text: "Background subagent scout: ", style: "bold" });
	assert.deepEqual(prefixed.lines.slice(1), title.lines.slice(1));
	assert.equal(prefixTitle("x: ", dialogTitle([])).plain, "x: ");
	// the prefix is sanitized like any segment
	assert.equal(prefixTitle("\x1b[2J: ", title).lines[0][0].text, "␛[2J: ");
});
