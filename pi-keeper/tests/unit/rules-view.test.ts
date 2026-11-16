/**
 * Tests for the `/rules` view: the rows, the colours and the plain-text form.
 * A fake theme makes the colours assertable without a terminal.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRuleDetail, renderRulesList, rulesRows, rulesText, type RulesTheme, type RulesViewInput } from "../../extensions/rules-view.ts";
import { parseRuleFile, type RulebookRule } from "../../extensions/rulebook.ts";

/** Every colour becomes a tag, so the expected string reads like the screen. */
const theme: RulesTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `<b>${text}</b>`,
};

const strip = (line: string): string => line.replace(/<\/?[a-z]+>/g, "");

function rule(name: string, kind: "user" | "project" = "user", body = "Fix it."): RulebookRule {
	const parsed = parseRuleFile(`/rules/${name}.md`, kind, `---\ndescription: The ${name} rule.\ncondition: (?i)\\b${name}\\b\n---\n${body}\n`);
	assert.ok(!("problem" in parsed), `${name} should parse`);
	return parsed;
}

const view = (input: Partial<RulesViewInput> = {}): RulesViewInput => ({ rules: [], untrusted: [], problems: [], fired: new Set(), ...input });

test("rows: every rule first, then the files that need review or were skipped", () => {
	const rows = rulesRows(view({
		rules: [rule("no-claims"), rule("no-scope", "project")],
		untrusted: [{ file: "/p/.pi/rules/pending.md" }],
		problems: [{ file: "/r/broken.md", problem: "the condition does not compile" }],
		fired: new Set(["no-claims"]),
	}));
	assert.deepEqual(rows.map((row) => (row.kind === "rule" ? `${row.rule.name}:${row.fired}` : `${row.kind}:${row.file.split("/").pop()}`)), [
		"no-claims:true",
		"no-scope:false",
		"untrusted:pending.md",
		"problem:broken.md",
	]);
});

test("a rule row carries its name, its source and its fires in their own colours", () => {
	const [line] = renderRulesList(theme, rulesRows(view({ rules: [rule("no-claims")], fired: new Set(["no-claims"]) })), 0, 200);
	assert.match(line, /^<accent>> <\/accent>/, "the selected row has a cursor");
	assert.match(line, /<b><accent>no-claims<\/accent><\/b>/, "selected: the name is bold and accented");
	assert.match(line, /<success>user<\/success>/, "the source of a user rule");
	assert.match(line, /<success>1 fire<\/success>/, "a fire is green");
	assert.match(line, /<text>The no-claims rule\.<\/text>/, "the description reads as normal text, not dim");
	assert.doesNotMatch(line, /<dim>.*description/, "nothing here is dimmed");
});

test("an unselected, unfired rule: mdLink name, muted count, project in warning colour", () => {
	const rows = rulesRows(view({ rules: [rule("a"), rule("b", "project")] }));
	const [first, second] = renderRulesList(theme, rows, -1, 200);
	assert.match(first, /^ {2}/, "an unselected row has no cursor");
	assert.match(second, /<b><mdLink>b<\/mdLink><\/b>/);
	assert.match(second, /<warning>project<\/warning>/);
	assert.match(second, /<muted>not fired<\/muted>/);
});

test("status rows say their own story: needs review, skipped and why", () => {
	const rows = rulesRows(view({ untrusted: [{ file: "/p/.pi/rules/pending.md" }], problems: [{ file: "/r/broken.md", problem: "no `condition:` in the frontmatter" }] }));
	const [review, skipped] = renderRulesList(theme, rows, 0, 200);
	assert.match(review, /<warning>pending\.md<\/warning>/);
	assert.match(review, /<warning>needs review<\/warning>/);
	assert.match(skipped, /<error>broken\.md<\/error>/);
	assert.match(skipped, /<error>skipped<\/error>/);
	assert.match(skipped, /no `condition:` in the frontmatter/);
});

test("a long row is cut to the terminal width, colours and all", () => {
	const long = rule("a", "user", "x");
	const wide = { ...long, description: "d".repeat(300) };
	const [line] = renderRulesList(theme, rulesRows(view({ rules: [wide] })), 0, 60);
	assert.ok(strip(line).length <= 60, `${strip(line).length} columns`);
});

test("the detail view shows the condition, the file and the body", () => {
	const lines = renderRuleDetail(theme, rule("no-claims", "user", "Run them, then quote the output."), true, 100).join("\n");
	assert.match(lines, /<b><accent>no-claims<\/accent><\/b>/);
	assert.match(lines, /<success>1 fire<\/success>/);
	assert.match(lines, /<mdCode>\(\?i\)\\bno-claims\\b<\/mdCode>/, "the pattern as written");
	assert.match(lines, /<dim>\/rules\/no-claims\.md<\/dim>/, "the file");
	assert.match(lines, /Run them, then quote the output\./);
});

test("a body wraps to the width instead of overflowing", () => {
	const body = "word ".repeat(60).trim();
	const lines = renderRuleDetail(theme, rule("wide", "user", body), false, 40);
	assert.ok(lines.every((line) => strip(line).length <= 40), "every line fits");
	assert.ok(lines.length > 5, "the body is more than one line");
});

test("the plain-text form for a session without a TUI has the same facts, no colours", () => {
	const text = rulesText(view({ rules: [rule("no-claims")], untrusted: [{ file: "/p/.pi/rules/pending.md" }], problems: [{ file: "/r/broken.md", problem: "empty body" }], fired: new Set(["no-claims"]) }));
	assert.doesNotMatch(text, /<(accent|text|dim|success|warning|muted|mdLink|mdCode|error|b)>/, "no markup");
	assert.match(text, /no-claims · user · 1 fire · The no-claims rule\./);
	assert.match(text, /pending\.md · project · needs review/);
	assert.match(text, /broken\.md · skipped: empty body/);
	assert.match(text, /permission rules are \/permissions/);
});
