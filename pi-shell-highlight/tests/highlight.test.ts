/**
 * Tests for the command highlighter: the text invariant, command positions, and
 * heredoc languages. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { MAX_HIGHLIGHT_LINES, guessHeredocLanguage, heredocLanguage, highlightCommand, markAssignments, markCommandNames, type CommandStyle } from "../highlight.ts";

initTheme();

/** Marks what we colored (`⟦c⟧` command, `⟦v⟧` variable, `⟦p⟧` plain) and drops pi's own colors. */
const style: CommandStyle = { command: (text) => `⟦c⟧${text}⟦/⟧`, plain: (text) => `⟦p⟧${text}⟦/⟧`, variable: (text) => `⟦v⟧${text}⟦/⟧` };
const stripAll = (text: string): string =>
	text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/⟦\/⟧/g, "")
		.replace(/⟦[a-z]⟧/g, "");

/** Every slot of the contract, each with its own marker: runner, precommand, option. */
const full: CommandStyle = {
	...style,
	runner: (text) => `⟦r⟧${text}⟦/⟧`,
	precommand: (text) => `⟦m⟧${text}⟦/⟧`,
	option: (text) => `⟦o⟧${text}⟦/⟧`,
};
const rich = (text: string, lang = "bash"): string => highlightCommand(text, lang, full).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

const lines = (text: string, lang = "bash"): string[] => highlightCommand(text, lang, style);
const textOf = (text: string, lang = "bash"): string => lines(text, lang).map(stripAll).join("\n");
/** Our own markers with pi's colors removed, so an assertion reads like the command. */
const marked = (text: string, lang = "bash"): string => lines(text, lang).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

test("the visible text never changes, on every fixture", () => {
	const fixtures = [
		"git status",
		"npm test -- --watch=false",
		"sudo -u root git commit -m 'x'",
		"ls | grep x > out",
		"FOO=1 make",
		"# a comment",
		'echo "done"',
		"cd /tmp && rm -rf build",
		"python3 - <<PY\nimport os\nprint('hi')\nPY",
		"cat <<'SQL' > q.sql\nselect 1;\nSQL",
		"cat <<EOF\nno language here\nEOF",
		"cat <<'EOF'\ngit status\nmake check\nEOF",
		"cat <<EOF\nimport os\nprint(os.getcwd())\nEOF",
		"git commit -F - <<'EOF'\nfix: handle the empty case\nEOF",
		"ssh host <<-EOF\n\techo indented\n\tEOF",
		"cat <<EOF\nnever closed\nand never will",
		"",
		"\n\n",
		"awk '{print $1}' f | sort -u",
		"rtk grep -n ack extensions | head -3",
		"RTK git status",
	];
	for (const fixture of fixtures) {
		assert.equal(textOf(fixture), fixture, `text changed for ${JSON.stringify(fixture)}`);
		assert.equal(lines(fixture).length, fixture.split("\n").length, `line count changed for ${JSON.stringify(fixture)}`);
	}
});

test("a command name is colored, and its arguments are not", () => {
	assert.equal(marked("git status"), `${markStart("git")} status`);
	assert.equal(marked("npm test -- --watch=false"), `${markStart("npm")} test -- --watch=false`);
	assert.equal(marked("tar -xzf a.tgz"), `${markStart("tar")} -xzf a.tgz`);
});

/** The exact string our fake style produces for a command word, with pi's colors removed. */
function markStart(word: string): string {
	return `⟦c⟧${word}⟦/⟧`;
}

test("a prefix is colored and so is the command after it", () => {
	const shown = marked("sudo -u root git commit -m 'x'");
	assert.match(shown, /⟦c⟧sudo⟦\/⟧ -u root ⟦c⟧git⟦\/⟧ commit/);
	assert.match(marked("env A=1 make"), /⟦c⟧env⟦\/⟧ A=1 ⟦c⟧make⟦\/⟧/);
});

test("rtk carries the command it runs, so both words are colored", () => {
	assert.match(marked("rtk grep -n ack extensions"), /^⟦c⟧rtk⟦\/⟧ ⟦c⟧grep⟦\/⟧ -n ack/);
	assert.match(marked("rtk git status"), /⟦c⟧rtk⟦\/⟧ ⟦c⟧git⟦\/⟧ status/);
	// no command after it (a bare `rtk` or a lone option): nothing fails, nothing is invented
	assert.equal(marked("rtk"), markStart("rtk"));
	assert.match(marked("rtk --json grep x"), /⟦c⟧rtk⟦\/⟧ --json ⟦c⟧grep⟦\/⟧ x/);
});

test("each command of a pipeline or a chain is colored", () => {
	const shown = marked("ls | grep x > out");
	assert.match(shown, /⟦c⟧ls⟦\/⟧ \| ⟦c⟧grep⟦\/⟧ x > out/);
	assert.match(marked("cd /tmp && rm -rf build"), /⟦c⟧rm⟦\/⟧ -rf build/, "rm after && (cd is a builtin, pi colors it)");
	assert.match(marked("true; touch f"), /⟦c⟧touch⟦\/⟧ f/);
});

test("assignments, redirections, comments and builtins are not recolored", () => {
	assert.equal(marked("FOO=1 make"), `FOO=1 ${markStart("make")}`);
	assert.match(marked("make > out 2>&1"), /⟦c⟧make⟦\/⟧ > out 2>&1/);
	assert.match(marked("# a comment"), /# a comment$/);
	assert.doesNotMatch(marked("# a comment"), /⟦c⟧/);
	// pi's grammar already colors the builtin, so we must leave it alone
	assert.doesNotMatch(marked('echo "done"'), /⟦c⟧echo/);
});

test("a word inside a colored span is never wrapped", () => {
	// as the grammar would hand it over: the string "git status" is already colored
	const example = "\x1b[38;5;2m\"git status\"\x1b[39m";
	const out = markCommandNames(example, style);
	assert.ok(out.includes("⟦c⟧") === false, out);
	assert.equal(stripAll(out), '"git status"');
});

test("a heredoc body gets the language its delimiter names", () => {
	assert.equal(heredocLanguage("PY", "python3 - <<PY"), "python");
	assert.equal(heredocLanguage("PY_EOF", "cat <<PY_EOF"), "python", "a part of the delimiter counts");
	assert.equal(heredocLanguage("SQL", "psql <<SQL"), "sql");
	assert.equal(heredocLanguage("EOF", "psql -c x <<EOF"), "sql", "falls back to the opening command");
	assert.equal(heredocLanguage("EOF", "cat <<EOF"), undefined);

	const shown = lines("python3 - <<PY\nimport os\nPY");
	assert.match(shown[0] ?? "", /⟦c⟧python3⟦\/⟧/, "the opener line is a shell line: its command is colored");
	assert.doesNotMatch(shown[1] ?? "", /⟦p⟧/, "a known language does not fall back to plain");
	assert.match(stripAll(shown[1] ?? ""), /^import os$/);
	assert.ok(/\x1b\[/.test(shown[1] ?? ""), "the body carries the highlighter's color");
});

test("a heredoc body with no name to go by is read as shell", () => {
	const shown = lines("cat <<'EOF'\ngit status\nmake check\nEOF");
	assert.match(shown[1] ?? "", /⟦c⟧git⟦\/⟧ status/, "a command in the body is colored");
	assert.match(shown[2] ?? "", /⟦c⟧make⟦\/⟧ check/);
	assert.equal(stripAll(shown[3] ?? ""), "EOF", "the terminator is emitted as written");
	// prose in such a body keeps its text: only its first word takes the command color
	const prose = lines("git commit -F - <<'EOF'\nfix: handle the empty case\nEOF");
	assert.equal(stripAll(prose[1] ?? ""), "fix: handle the empty case");
});

test("an unnamed body of another language is not read as shell", () => {
	const shown = lines("cat <<EOF\nimport os\nprint(os.getcwd())\nEOF");
	assert.doesNotMatch(shown[1] ?? "", /⟦c⟧/, "a python body gets no command names");
	assert.ok(/\x1b\[/.test(shown[1] ?? ""), "but the grammar colors it");
});

test("a body is read for what it looks like when nothing names its language", () => {
	const cases: Array<[string[], string | undefined]> = [
		[["import os", "print(os.getcwd())"], "python"],
		[["def f(x):", "    return x"], "python"],
		[["#!/usr/bin/env python3", "x = 1"], "python"],
		[["#!/bin/bash", "set -eu"], "bash"],
		[["#!/usr/bin/env node", "const x = 1"], "javascript"],
		[["if [ -f x ]; then", "  echo hi", "fi"], "bash"],
		[["for f in *.ts; do", "  echo \"$f\"", "done"], "bash"],
		[["package main", "func main() {"], "go"],
		[["fn main() {", "}"], "rust"],
		[["select id from users"], "sql"],
		[["const x = 1;", "console.log(x);"], "javascript"],
		[["{'a': 1}".replace(/'/g, '"')], "json"],
		[["<h1>hi</h1>"], "html"],
		[["FROM node:22", "RUN npm ci"], "dockerfile"],
		[["just some prose", "over two lines"], undefined],
		[[], undefined],
	];
	for (const [body, expected] of cases) assert.equal(guessHeredocLanguage(body), expected, JSON.stringify(body));
});

test("prose that starts with a SQL word is not read as SQL", () => {
	const prose: string[][] = [["Select the best option here"], ["Update the set of tests"], ["With a note as follows"]];
	for (const body of prose) assert.equal(guessHeredocLanguage(body), undefined, JSON.stringify(body));
});

test("real SQL is still read as SQL when nothing names its language", () => {
	const sql = [
		"select name from t",
		"SELECT * FROM t",
		"select 1",
		"select count(*) from t",
		"select distinct a from t",
		"with x as (select 1) select * from x",
		"update users set x = 1",
		"insert into t values (1)",
		"delete from t where id = 1",
		"create table t (id int)",
	];
	for (const line of sql) assert.equal(guessHeredocLanguage([line]), "sql", line);
});

test("<<- strips tabs from the terminator, and an unclosed heredoc takes the rest", () => {
	const shown = lines("ssh host <<-EOF\n\techo hi\n\tEOF");
	assert.equal(shown.length, 3);
	assert.equal(stripAll(shown[2] ?? ""), "\tEOF", "the terminator is emitted as written");

	const unclosed = lines("cat <<EOF\nnever closed\nand never will");
	assert.equal(unclosed.length, 3);
	assert.equal(stripAll(unclosed[2] ?? ""), "and never will");
});

test("a runner, a precommand and an option each get their own slot", () => {
	assert.equal(rich("python3 x.py"), "⟦r⟧python3⟦/⟧ x.py", "a language runner is not a plain command");
	assert.equal(rich("grep -n ack"), "⟦c⟧grep⟦/⟧ ⟦o⟧-n⟦/⟧ ack", "a tool is a command, its flag an option");
	assert.equal(rich("sudo python3 x.py"), "⟦m⟧sudo⟦/⟧ ⟦r⟧python3⟦/⟧ x.py", "the qualifier recedes");
	assert.equal(rich("rtk grep -n ack"), "⟦m⟧rtk⟦/⟧ ⟦c⟧grep⟦/⟧ ⟦o⟧-n⟦/⟧ ack");
	// a chain of modifiers, as an agent writes it: `sudo rtk grep`
	assert.equal(rich("sudo rtk grep -n ack"), "⟦m⟧sudo⟦/⟧ ⟦m⟧rtk⟦/⟧ ⟦c⟧grep⟦/⟧ ⟦o⟧-n⟦/⟧ ack");
	assert.equal(rich("env A=1 make check"), "⟦m⟧env⟦/⟧ A=1 ⟦r⟧make⟦/⟧ check");
	// `--` alone is the end-of-options marker, not an option; `--watch=` is one (its `false` value
	// keeps the grammar's literal color, which is why this is not an equality assertion)
	assert.match(rich("npm test -- --watch=false"), /^⟦r⟧npm⟦\/⟧ test -- ⟦o⟧--watch=/);
	assert.equal(rich("head -3 f"), "⟦c⟧head⟦/⟧ ⟦o⟧-3⟦/⟧ f", "a numeric option counts");
	// `-` and `--` alone are stdin/stdout or a separator, not options
	assert.equal(rich("cat -"), "⟦c⟧cat⟦/⟧ -");
	// every command of a chain starts over: a runner after `&&` is a runner (`cd` is a shell builtin,
	// so the grammar colors it and we leave it alone)
	assert.equal(rich("cd x && go test ./..."), "cd x && ⟦r⟧go⟦/⟧ test ./...");
});

test("an option or a runner inside a colored span is never repainted", () => {
	const shown = rich('git commit -m "-x"');
	assert.match(shown, /⟦c⟧git⟦\/⟧ commit ⟦o⟧-m⟦\/⟧/, "the option of the command is painted");
	assert.doesNotMatch(shown, /⟦o⟧-x/, "a flag inside a string keeps the string's color");
	assert.doesNotMatch(shown, /⟦c⟧-x/, "an argument is never a command");
});

test("without the optional slots, every word keeps the command color", () => {
	// the v1 consumer: no runner/precommand/option callbacks, so nothing changes for it
	assert.equal(marked("python3 x.py"), `${markStart("python3")} x.py`);
	assert.equal(marked("sudo grep -n ack"), `⟦c⟧sudo⟦/⟧ ⟦c⟧grep⟦/⟧ -n ack`);
});

test("a long heredoc body is capped", () => {
	const body = Array.from({ length: MAX_HIGHLIGHT_LINES + 100 }, (_, i) => `x${i} = 1`);
	const text = `python3 - <<PY\n${body.join("\n")}\nPY`;
	const shown = lines(text);
	assert.equal(shown.length, body.length + 2);
	// the last 100 body lines are plain, the first ones carry the language
	assert.equal(shown[shown.length - 2], `⟦p⟧x${body.length - 1} = 1⟦/⟧`);
	assert.doesNotMatch(shown[1] ?? "", /⟦p⟧/);
});

test("a single line of prose with no separator colors only the first word", () => {
	assert.equal(marked("make build"), `${markStart("make")} build`);
});

test("a python assignment target is colored, because the grammar leaves it plain", () => {
	// the numbers keep the grammar's own color, so compare with pi's codes removed
	const shown = lines("python3 - <<PY\nrows = [1, 2]\ntotal: int = len(rows)\nif total == 3:\n    print(rows)\nPY").map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.match(shown[1] ?? "", /⟦v⟧rows⟦\/⟧ = \[1, 2\]/);
	assert.match(shown[2] ?? "", /⟦v⟧total⟦\/⟧: int = /);
	assert.doesNotMatch(shown[3] ?? "", /⟦v⟧/, "a comparison is not an assignment");
	assert.doesNotMatch(shown[4] ?? "", /⟦v⟧/, "a call argument is not an assignment");
});

test("markAssignments does nothing without a variable style, and never touches a colored name", () => {
	const plainStyle: CommandStyle = { command: (text) => text, plain: (text) => text };
	assert.equal(markAssignments("rows = [1]", plainStyle), "rows = [1]");
	// a name the grammar already colored keeps its color
	const colored = "\x1b[38;5;5mrow\x1b[39m = 1";
	assert.equal(markAssignments(colored, style), colored);
	// nothing assignment-like: no color, no change
	for (const line of ["if x == 1:", "print(rows)", "# rows = 1", "x += 1"]) {
		assert.equal(stripAll(markAssignments(line, style)), line, line);
		assert.doesNotMatch(markAssignments(line, style), /⟦v⟧/, line);
	}
});

test("the variable pass follows the invariant too: same text, same line count", () => {
	const text = "python3 - <<PY\nrows = [1]\ntotal: int = len(rows)\nPY";
	assert.equal(textOf(text), text);
	assert.equal(lines(text).length, text.split("\n").length);
});

test("a here-string is not a heredoc: the line after it is shell, not a body", () => {
	// `<<<` takes a word on the same line; no delimiter follows, so nothing after it is a body
	const text = "grep foo <<< PY\nprint(1)\nPY";
	const shown = lines(text);
	assert.equal(shown.length, 3);
	assert.doesNotMatch(marked(text), /⟦p⟧/, "no line is a heredoc terminator, so none is emitted as plain");
	assert.equal(textOf(text), text);
});

test("a heredoc with a plain delimiter still closes on its terminator", () => {
	const shown = lines("cat <<EOF\nx\nEOF");
	assert.equal(shown.length, 3);
	assert.equal(stripAll(shown[1] ?? ""), "x");
	assert.equal(shown[2], "⟦p⟧EOF⟦/⟧", "the terminator is emitted as a plain line");
});

test("<<- with a plain command still strips tabs and closes on its terminator", () => {
	const shown = lines("cat <<-EOF\n\tx\n\tEOF");
	assert.equal(shown.length, 3);
	assert.equal(stripAll(shown[1] ?? ""), "\tx");
	assert.equal(shown[2], "⟦p⟧\tEOF⟦/⟧", "the indented terminator is emitted as written, in the plain style");
});
