/**
 * Tests for the rulebook: rule files, matching, the correction text and the
 * session records. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compileCondition,
	ensureUserRuleDir,
	EXAMPLE_RULE_FILE,
	correctionText,
	firedFromBranch,
	loadRulebook,
	matchRules,
	parseRuleFile,
	ruleKey,
	splitFrontmatter,
	userRuleDir,
	RULE_BODY_CAP,
	RULE_FIRED_ENTRY,
	RULE_SCAN_CAP,
	RULE_TEXT_CAP,
	type RulebookRule,
} from "../../extensions/rulebook.ts";
import { sha256 } from "../../extensions/project-rules.ts";

const ruleFile = (fields: string, body: string): string => `---\n${fields}\n---\n${body}\n`;

function sandbox(): { cwd: string; agentDir: string; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "pdf-rulebook-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { cwd, agentDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Write a rule file and return its path. */
function writeRule(dir: string, name: string, fields: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, ruleFile(fields, body));
	return file;
}

const userDir = (agentDir: string): string => userRuleDir(agentDir);
const projectDir = (cwd: string): string => join(cwd, ".pi", "rules");
const hashOf = (file: string): string => sha256(readFileSync(file, "utf8"));

/** One parsed rule, asserted to parse. */
function rule(name: string, condition: string, body = "Fix it."): RulebookRule {
	const parsed = parseRuleFile(`/rules/${name}.md`, "user", ruleFile(`description: ${name} rule\ncondition: ${condition}`, body));
	assert.ok(!("problem" in parsed), `rule ${name} should parse`);
	return parsed;
}

// --- frontmatter and one file -------------------------------------------------

test("frontmatter: flat key: value, quotes stripped, the first key wins, a value may contain a colon", () => {
	const { fields, body } = splitFrontmatter(ruleFile(`description: "Do not say: fine"\ncondition: a:b\ncondition: second\n# a comment\nnot a pair`, "The body."));
	assert.equal(fields.description, "Do not say: fine");
	assert.equal(fields.condition, "a:b");
	assert.equal(body, "The body.");
});

test("frontmatter: no frontmatter, or no closing fence, leaves the whole file as the body", () => {
	for (const text of ["Just text.", "---\ndescription: x\nA body with no closing fence."]) {
		const { fields, body } = splitFrontmatter(text);
		assert.deepEqual(fields, {});
		assert.equal(body, text.trim());
	}
});

test("a rule file becomes a rule: name from the file, description, condition, body, hash", () => {
	const parsed = parseRuleFile("/rules/no-claims.md", "user", ruleFile("description: Do not claim tests pass.\ncondition: (?i)\\ball tests pass\\b", "Run them, then quote the output."));
	assert.ok(!("problem" in parsed));
	assert.equal(parsed.name, "no-claims");
	assert.equal(parsed.kind, "user");
	assert.equal(parsed.description, "Do not claim tests pass.");
	assert.equal(parsed.body, "Run them, then quote the output.");
	assert.match(parsed.hash, /^[0-9a-f]{64}$/);
	assert.equal(parsed.pattern.test("All tests pass now."), true);
});

test("a file that cannot be a rule says why, and never throws", () => {
	const cases: Array<[string, RegExp]> = [
		[ruleFile("condition: x", "body"), /no `description:`/],
		[ruleFile("description: x", "body"), /no `condition:`/],
		[ruleFile("description: x\ncondition: (?i)[", "body"), /does not compile/],
		[ruleFile("description: x\ncondition: ok", "   "), /body is empty/],
	];
	for (const [text, expected] of cases) {
		const parsed = parseRuleFile("/rules/x.md", "project", text);
		assert.ok("problem" in parsed, text);
		assert.match(parsed.problem, expected);
	}
});

test("inline (?i) becomes the i flag; g is never set, so test() carries no state between calls", () => {
	const pattern = compileCondition("(?i)\\bshould work\\b");
	assert.ok(pattern !== undefined);
	assert.equal(pattern.flags, "i");
	assert.equal(pattern.test("It SHOULD WORK"), true);
	assert.equal(pattern.test("It SHOULD WORK"), true);
	assert.equal(compileCondition("(?i)(?s)a.b")?.flags, "is");
	assert.equal(compileCondition("(?gm)^x"), undefined, "g is not an accepted inline flag");
	assert.equal(compileCondition("(unclosed"), undefined);
});

// --- discovery ----------------------------------------------------------------

test("discovery: user rules load, an unreviewed project rule is reported instead of loaded, .md only", () => {
	const sb = sandbox();
	try {
		writeRule(userDir(sb.agentDir), "no-claims.md", "description: User rule.\ncondition: user", "User body.");
		writeRule(projectDir(sb.cwd), "project-style.md", "description: Project rule.\ncondition: project", "Project body.");
		writeFileSync(join(projectDir(sb.cwd), "notes.txt"), "not a rule");
		const book = loadRulebook({ cwd: sb.cwd, agentDir: sb.agentDir, trustedHash: () => undefined });
		assert.deepEqual(book.rules.map((r) => r.name), ["no-claims"]);
		assert.equal(book.untrusted.length, 1);
		assert.match(book.untrusted[0].hash, /^[0-9a-f]{64}$/);
		assert.deepEqual(book.problems, []);
	} finally {
		sb.cleanup();
	}
});

test("discovery: a project rule loads once its content hash was reviewed, and drops out again after an edit", () => {
	const sb = sandbox();
	try {
		const file = writeRule(projectDir(sb.cwd), "project-style.md", "description: Project rule.\ncondition: project", "Project body.");
		const reviewed = loadRulebook({ cwd: sb.cwd, agentDir: sb.agentDir, trustedHash: () => hashOf(file) });
		assert.deepEqual(reviewed.rules.map((r) => r.name), ["project-style"]);
		assert.deepEqual(reviewed.untrusted, []);
		const changed = loadRulebook({ cwd: sb.cwd, agentDir: sb.agentDir, trustedHash: () => "a hash from before the edit" });
		assert.deepEqual(changed.rules, []);
		assert.equal(changed.untrusted.length, 1);
	} finally {
		sb.cleanup();
	}
});

test("discovery: a user rule shadows a project rule of the same name", () => {
	const sb = sandbox();
	try {
		writeRule(userDir(sb.agentDir), "no-claims.md", "description: Mine.\ncondition: mine", "Mine.");
		const file = writeRule(projectDir(sb.cwd), "no-claims.md", "description: Theirs.\ncondition: theirs", "Theirs.");
		const book = loadRulebook({ cwd: sb.cwd, agentDir: sb.agentDir, trustedHash: (f) => (f === file ? hashOf(file) : undefined) });
		assert.deepEqual(book.rules.map((r) => r.name), ["no-claims"]);
		assert.equal(book.rules[0].description, "Mine.");
	} finally {
		sb.cleanup();
	}
});

test("discovery: a broken file is one problem line, and the rest still loads", () => {
	const sb = sandbox();
	try {
		const broken = writeRule(projectDir(sb.cwd), "broken.md", "description: x\ncondition: (?i)[", "body");
		writeRule(projectDir(sb.cwd), "fine.md", "description: Fine.\ncondition: fine", "Fine body.");
		const book = loadRulebook({ cwd: sb.cwd, agentDir: sb.agentDir, trustedHash: (f) => (f === broken ? hashOf(broken) : hashOf(join(projectDir(sb.cwd), "fine.md"))) });
		assert.deepEqual(book.rules.map((r) => r.name), ["fine"]);
		assert.equal(book.problems.length, 1);
		assert.match(book.problems[0].problem, /does not compile/);
	} finally {
		sb.cleanup();
	}
});

test("discovery: absent directories are simply empty", () => {
	const sb = sandbox();
	try {
		const book = loadRulebook({ cwd: sb.cwd, agentDir: sb.agentDir, trustedHash: () => undefined });
		assert.deepEqual([book.rules, book.problems, book.untrusted], [[], [], []]);
	} finally {
		sb.cleanup();
	}
});

test("userRuleDir is under the agent dir, like every other pi-keeper file", () => {
	assert.equal(userRuleDir("/home/x/.pi/agent"), "/home/x/.pi/agent/pi-keeper/rules");
});

// --- matching -----------------------------------------------------------------

test("matching: a rule fires on a match, once per session, and never on an already-fired rule", () => {
	const rules = [rule("no-claims", "(?i)\\ball tests pass\\b"), rule("no-assume", "(?i)\\bI assume\\b")];
	assert.deepEqual(matchRules(rules, "All tests pass.", new Set()).map(ruleKey), ["no-claims"]);
	assert.deepEqual(matchRules(rules, "i assume it works", new Set()).map(ruleKey), ["no-assume"]);
	assert.deepEqual(matchRules(rules, "All tests pass.", new Set(["no-claims"])), []);
	assert.deepEqual(matchRules(rules, "", new Set()), [], "an empty turn matches nothing");
});

test(`matching: only the last ${RULE_SCAN_CAP} characters are scanned`, () => {
	const rules = [rule("no-claims", "(?i)\\ball tests pass\\b")];
	const violationAtTheStart = `All tests pass.${"x".repeat(RULE_SCAN_CAP)}`;
	assert.deepEqual(matchRules(rules, violationAtTheStart, new Set()), [], "a huge answer is not handed to the regex");
	const violationAtTheEnd = `${"x".repeat(RULE_SCAN_CAP)} All tests pass.`;
	assert.deepEqual(matchRules(rules, violationAtTheEnd, new Set()).map(ruleKey), ["no-claims"]);
});

// --- the correction -----------------------------------------------------------

test("the correction names the rule, its description and its body, and says what to do next", () => {
	const text = correctionText([rule("no-claims", "x", "Run the tests, then quote the output.")]);
	assert.match(text, /rulebook rule matched your last message/);
	assert.match(text, /warning, not a block/);
	assert.match(text, /correct it now\s+in your next message/);
	assert.match(text, /## Rule: no-claims/);
	assert.match(text, /no-claims rule/);
	assert.match(text, /Run the tests, then quote the output\./);
});

test("the header appears once, however many rules fired", () => {
	const text = correctionText([rule("one", "x", "First body."), rule("two", "y", "Second body."), rule("three", "z", "Third body.")]);
	assert.equal(text.match(/rulebook rule matched your last message/g)?.length, 1, "one preamble, not one per rule");
	assert.equal(text.match(/warning, not a block/g)?.length, 1);
	for (const name of ["one", "two", "three"]) assert.match(text, new RegExp(`## Rule: ${name}`));
});

test("a body is capped per rule, so the next rule keeps its instruction", () => {
	const text = correctionText([rule("long", "x", "y".repeat(RULE_BODY_CAP * 2)), rule("short", "x", "Keep this body.")]);
	assert.match(text, /…\(rule text truncated\)/);
	assert.match(text, /## Rule: short/);
	assert.match(text, /Keep this body\./);
	assert.ok(text.length < RULE_TEXT_CAP, `${text.length} chars, well under the whole-message cap`);
});

test("many rules stay under the whole-message cap and say where the rest is", () => {
	const many = Array.from({ length: 20 }, (_, i) => rule(`r${i}`, "x", "body ".repeat(100)));
	const text = correctionText(many);
	assert.ok(text.length <= RULE_TEXT_CAP + 80, `${text.length} chars`);
	assert.match(text, /20 rules fired; the rest is in \/rules <name>/);
});

// --- session records ----------------------------------------------------------

test("fired rules are read back from the session entries: the branch is the truth, bad payloads are ignored", () => {
	const branch = [
		{ type: "custom", customType: RULE_FIRED_ENTRY, data: { rule: "no-claims", kind: "user", at: "2024-01-01" } },
		{ type: "custom_message", customType: "pi-keeper-rule", content: "x" },
		{ type: "custom", customType: RULE_FIRED_ENTRY, data: { rule: "no-assume" } },
		{ type: "custom", customType: RULE_FIRED_ENTRY, data: { rule: 7 } },
		{ type: "custom", customType: "something-else", data: { rule: "not-ours" } },
	];
	assert.deepEqual([...firedFromBranch(branch)].sort(), ["no-assume", "no-claims"]);
	assert.deepEqual([...firedFromBranch([])], []);
});

test("a rule body with $&, $1 and $` reaches the correction text literally", () => {
	const text = correctionText([rule("dollars", "zzz", "Write `$&` and `$1` as-is, not $`.")]);
	assert.ok(text.includes("Write `$&` and `$1` as-is, not $`."), text);
});

test("ensureUserRuleDir creates the folder with one example that parses, and leaves existing rules alone", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-keeper-rules-"));
	try {
		const dir = ensureUserRuleDir(agentDir);
		assert.equal(dir, userRuleDir(agentDir));
		const book = loadRulebook({ cwd: agentDir, agentDir, trustedHash: () => undefined });
		assert.deepEqual(book.problems, []);
		assert.equal(book.rules.length, 1);
		assert.equal(book.rules[0]?.file.endsWith(EXAMPLE_RULE_FILE), true);
		assert.equal(matchRules(book.rules, "This should work now. All tests pass. EXAMPLE rule.", new Set()).length, 0, "the example is a dummy");
		rmSync(join(dir, EXAMPLE_RULE_FILE));
		writeFileSync(join(dir, "mine.md"), "---\ndescription: d\ncondition: x\n---\nbody");
		ensureUserRuleDir(agentDir);
		assert.equal(loadRulebook({ cwd: agentDir, agentDir, trustedHash: () => undefined }).rules.length, 1);
		// offered once: with no rule left, it does not come back
		rmSync(join(dir, "mine.md"));
		ensureUserRuleDir(agentDir);
		assert.equal(existsSync(join(dir, EXAMPLE_RULE_FILE)), false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("ensureUserRuleDir retrofits an existing folder that has no rule file, and leaves one that has rules", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-keeper-rules-"));
	try {
		const dir = userRuleDir(agentDir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "old.yaml"), "not a rule file");
		ensureUserRuleDir(agentDir);
		assert.equal(existsSync(join(dir, EXAMPLE_RULE_FILE)), true, "an old install with only a yaml file gets the example");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
	const withRules = mkdtempSync(join(tmpdir(), "pi-keeper-rules-"));
	try {
		const dir = userRuleDir(withRules);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "mine.md"), "---\ndescription: d\ncondition: x\n---\nbody");
		ensureUserRuleDir(withRules);
		assert.equal(existsSync(join(dir, EXAMPLE_RULE_FILE)), false, "an install with its own rules is not touched");
	} finally {
		rmSync(withRules, { recursive: true, force: true });
	}
});

test("a file with literal \\n and no frontmatter line says so", () => {
	const parsed = parseRuleFile("/r/a.md", "user", "description: d\\ncondition: x\\n---\\nbody");
	assert.ok("problem" in parsed);
	assert.match(parsed.problem, /no frontmatter: .*literal \\n/);
});

test("a condition that matches ordinary text is refused (an optional group matches everywhere)", () => {
	const parsed = parseRuleFile("/r/a.md", "user", "---\ndescription: d\ncondition: (?i)\\b(let commit now)*\\b\n---\nbody");
	assert.ok("problem" in parsed);
	assert.match(parsed.problem, /would fire on every answer/);
	assert.ok(!("problem" in parseRuleFile("/r/b.md", "user", "---\ndescription: d\ncondition: (?i)\\bshould work\\b\n---\nbody")));
});

test("an inline (?m) sets the m flag: ^ matches the start of a later line, and does without it", () => {
	const multi = rule("line-start", "(?m)^line");
	assert.equal(multi.pattern.flags, "m");
	assert.equal(matchRules([multi], "first\nline two", new Set()).length, 1, "^ at the start of line 2");
	const single = rule("line-start-plain", "^line");
	assert.equal(single.pattern.flags, "");
	assert.equal(matchRules([single], "first\nline two", new Set()).length, 0, "without (?m), ^ is the start of the text only");
});

test("the seeded example rule never fires on an ordinary answer", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-keeper-rules-"));
	try {
		ensureUserRuleDir(agentDir);
		const book = loadRulebook({ cwd: agentDir, agentDir, trustedHash: () => undefined });
		const example = book.rules.find((r) => r.file.endsWith(EXAMPLE_RULE_FILE));
		assert.ok(example !== undefined, "the example parses as a rule");
		const answers = [
			"",
			"Done. All tests pass.",
			"I read the module and changed the parser so that it handles nested groups. The new code keeps the old behaviour for flat input, and the cases for unbalanced brackets now report a line number. ".repeat(20),
			"Here is the change:\n\n```ts\nexport const example = (x: number): number => x * 2;\n```\n",
		];
		for (const answer of answers) {
			assert.equal(example.pattern.test(answer), false, `the example's condition does not match ${JSON.stringify(answer.slice(0, 40))}`);
			assert.equal(matchRules(book.rules, answer, new Set()).length, 0);
		}
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
