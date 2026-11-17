/**
 * Tests for persisted per-project rules: parsing, matching, the trust gate
 * and writing. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_RULES, MODES, type ModeName } from "../../extensions/modes.ts";
import { evaluate, type Action, type EvalContext } from "../../extensions/rules.ts";
import {
	compilePermissions,
	findMatchingRule,
	findProjectRoot,
	loadProjectRules,
	parseAllowedTools,
	parsePattern,
	parseRule,
	parseRules,
	recordTrust,
	removeRule,
	saveAllowRules,
	saveRules,
	sha256,
	type ParsedRules,
	type ProjectPermissions,
} from "../../extensions/project-rules.ts";

const CWD = "/home/user/project";

function rules(permissions: { allow?: unknown; ask?: unknown; deny?: unknown }): ParsedRules {
	return parseRules({ "pi-keeper": { permissions } });
}

function decide(mode: ModeName, command: string, project: ProjectPermissions, remembered: string[][] = []): Action {
	const ctx: EvalContext = { cwd: CWD, remembered, project };
	return evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: "bash", input: { command } }, ctx).action;
}

test("parsing: prefix vs exact, rtk forms, malformed entries", () => {
	const prefix = parseRule("Bash(git commit *)", "allow");
	assert.deepEqual(prefix, { text: "Bash(git commit *)", tokens: ["git", "commit"], exact: false });
	assert.deepEqual(parseRule("Bash(npm test)", "allow"), { text: "Bash(npm test)", tokens: ["npm", "test"], exact: true });
	// rtk forms canonicalize
	assert.deepEqual((parseRule("Bash(rtk git add *)", "allow") as { tokens: string[] }).tokens, ["git", "add"]);
	assert.deepEqual((parseRule("Bash(rtk read *)", "ask") as { tokens: string[] }).tokens, ["rtk", "read"]);

	for (const bad of ["git commit *", "Bash(git commit", "Bash()", "Bash(*)", "Bash(git commit * && rm x)", 'Bash(git "commit" *)', "Bash(git *commit)", "Read(x)"]) {
		assert.ok("error" in parseRule(bad, "ask"), bad);
	}
	// allow rules obey the "Always allow" limits
	for (const bad of ["Bash(bash *)", "Bash(python3 *)", "Bash(sudo *)", "Bash(rm *)", "Bash(git rm *)", "Bash(npm run *)", "Bash(rtk run *)", "Bash(find *)", "Bash(awk *)", "Bash(gawk *)", "Bash(vim *)", "Bash(less *)", "Bash(busybox awk *)"]) {
		assert.ok("error" in parseRule(bad, "allow"), `allow: ${bad}`);
	}
	assert.ok(!("error" in parseRule("Bash(rm *)", "deny")));
	assert.ok(!("error" in parseRule("Bash(sudo *)", "ask")));

	const parsed = rules({ allow: ["Bash(git commit *)", 5, "Bash(bash *)"], ask: "nope", deny: ["Bash(terraform destroy *)", "garbage"] });
	assert.deepEqual(parsed.allow.map((r) => r.text), ["Bash(git commit *)"]);
	assert.deepEqual(parsed.deny.map((r) => r.text), ["Bash(terraform destroy *)"]);
	assert.equal(parsed.warnings.length, 4);
	assert.match(parsed.warnings.join("\n"), /allow: ignored `5` \(not a string\)/);
	assert.match(parsed.warnings.join("\n"), /allow: ignored `Bash\(bash \*\)`/);
	assert.match(parsed.warnings.join("\n"), /`ask` is not a list/);
	assert.match(parsed.warnings.join("\n"), /deny: ignored `garbage`/);
	assert.deepEqual(parseRules({ other: 1 }).warnings, []);
	assert.deepEqual(parseRules(null).allow, []);
	assert.equal(parseRules({ "pi-keeper": { permissions: [] } }).warnings.length, 1);
});

test("matching: any simple command, rtk forms, flags between tokens, exact rules", () => {
	const ask = rules({ ask: ["Bash(git push *)", "Bash(npm test)"] }).ask;
	const match = (command: string) => findMatchingRule(ask, command)?.text;
	assert.equal(match("git push origin main"), "Bash(git push *)");
	assert.equal(match("rtk git push"), "Bash(git push *)");
	assert.equal(match("rtk proxy git push"), "Bash(git push *)");
	assert.equal(match("git add . && git push"), "Bash(git push *)");
	assert.equal(match("bash -c 'git push'"), "Bash(git push *)");
	assert.equal(match("git -C sub push"), "Bash(git push *)");
	assert.equal(match("git -c core.x=y push --force"), "Bash(git push *)");
	assert.equal(match("git commit -m push"), undefined);
	assert.equal(match("git status"), undefined);
	assert.equal(match("echo git push"), undefined);
	assert.equal(match("git pushx"), undefined);
	// heredoc-substituted and unparseable commands still match
	assert.equal(match('echo "$(git push)"'), "Bash(git push *)");
	// exact: the whole command
	assert.equal(match("npm test"), "Bash(npm test)");
	assert.equal(match("rtk npm test"), "Bash(npm test)");
	assert.equal(match("npm test -- --watch"), undefined);
	assert.equal(findMatchingRule([], "git push"), undefined);
});

test("evaluation: deny > ask > allow in every mode", () => {
	const project = (r: Parameters<typeof rules>[0], active = true) => compilePermissions(rules(r), active);

	// deny applies everywhere, beating a session prefix too
	const deny = project({ deny: ["Bash(git commit *)"] });
	for (const mode of ["default", "auto", "plan"] as const) assert.equal(decide(mode, "git commit -m x", deny, [["git", "commit"]]), "deny", mode);
	assert.equal(decide("default", "git status", deny), "allow");
	assert.equal(decide("default", "git add . && git commit -m x", deny), "deny");

	// a persisted allow works in default, is ignored in plan, and changes nothing in auto
	const allow = project({ allow: ["Bash(git commit *)"] });
	assert.equal(decide("default", "git commit -m x", allow), "allow");
	assert.equal(decide("default", "rtk git commit -m x", allow), "allow");
	assert.equal(decide("default", "git commit -m x && git status", allow), "allow");
	assert.equal(decide("default", "git add .", allow), "ask");
	assert.equal(decide("plan", "git commit -m x", allow), "ask");
	assert.equal(decide("auto", "git commit -m x", allow), "allow");
	// untrusted allow rules are not compiled in
	assert.equal(decide("default", "git commit -m x", project({ allow: ["Bash(git commit *)"] }, false)), "ask");
	// combined with a session prefix across segments
	assert.equal(decide("default", "git add . && git commit -m x", allow, [["git", "add"]]), "allow");

	// exact allow
	const exact = project({ allow: ["Bash(npm test)"] });
	assert.equal(decide("default", "npm test", exact), "allow");
	assert.equal(decide("default", "npm test --coverage", exact), "ask");

	// ask applies in every mode, even auto
	const ask = project({ ask: ["Bash(make deploy *)", "Bash(npm publish *)"] });
	assert.equal(decide("auto", "make deploy prod", ask), "ask");
	assert.equal(decide("auto", "npm publish", ask), "ask");
	assert.equal(decide("auto", "make build", ask), "allow");
	assert.equal(decide("default", "make deploy prod", ask, [["make", "deploy"]]), "ask");
	assert.equal(decide("plan", "make deploy prod", ask), "ask");
	// ask beats a user allow of the same command
	const both = project({ allow: ["Bash(make deploy *)"], ask: ["Bash(make deploy *)"] });
	assert.equal(decide("default", "make deploy x", both), "ask");
	// deny beats ask and allow
	assert.equal(decide("default", "make deploy x", project({ allow: ["Bash(make deploy *)"], ask: ["Bash(make deploy *)"], deny: ["Bash(make deploy *)"] })), "deny");

	// a user allow never covers dangerous, privileged, removal or write-flag commands
	const risky = project({ allow: ["Bash(git push *)", "Bash(git log *)", "Bash(git *)"] });
	assert.equal(decide("default", "git push origin main", risky), "ask");
	assert.equal(decide("default", "git log --output=/tmp/x", risky), "ask");
	assert.equal(decide("default", "git rm x", risky), "ask");
	assert.equal(decide("default", "sudo git status", risky), "deny");
	assert.equal(decide("default", "git status", project({ deny: ["Bash(sudo *)"] })), "allow");
});

function temp(): { agent: string; project: string; done: () => void } {
	const base = mkdtempSync(join(tmpdir(), "pdf-rules-"));
	const agent = join(base, "agent");
	const project = join(base, "project");
	mkdirSync(agent);
	mkdirSync(join(project, ".git", "info"), { recursive: true });
	return { agent, project, done: () => rmSync(base, { recursive: true, force: true }) };
}

const FILE = ".pi/settings.local.json";

test("project root is the nearest ancestor with .git", () => {
	const t = temp();
	try {
		mkdirSync(join(t.project, "a", "b"), { recursive: true });
		assert.equal(findProjectRoot(join(t.project, "a", "b")), t.project);
		const plain = mkdtempSync(join(tmpdir(), "pdf-plain-"));
		try {
			assert.equal(findProjectRoot(plain), plain);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	} finally {
		t.done();
	}
});

test("trust gate: recorded hashes load allow rules, edits and unknown files do not", () => {
	const t = temp();
	try {
		const file = join(t.project, FILE);
		mkdirSync(join(t.project, ".pi"));
		const content = JSON.stringify({ "pi-keeper": { permissions: { allow: ["Bash(git commit *)"], ask: ["Bash(git push *)"], deny: ["Bash(terraform destroy *)"] } } }, null, 2);
		writeFileSync(file, content);

		// no hash recorded: untrusted, but deny/ask are parsed and load
		let loaded = loadProjectRules(t.project, t.agent);
		assert.equal(loaded.exists, true);
		assert.equal(loaded.trusted, false);
		let perms = compilePermissions(loaded.rules, loaded.trusted);
		assert.deepEqual(perms.allow, { prefixes: [], exact: [] });
		assert.equal(perms.ask.length, 1);
		assert.equal(perms.deny.length, 1);
		assert.equal(decide("default", "git commit -m x", perms), "ask"); // untrusted allow: falls back to ask
		assert.equal(decide("auto", "terraform destroy", perms), "deny");
		assert.equal(decide("auto", "git push", perms), "ask");

		// recorded: trusted, allow loads
		recordTrust(t.agent, file, sha256(content));
		loaded = loadProjectRules(t.project, t.agent);
		assert.equal(loaded.trusted, true);
		perms = compilePermissions(loaded.rules, loaded.trusted);
		assert.deepEqual(perms.allow.prefixes, [["git", "commit"]]);
		assert.equal(decide("default", "git commit -m x", perms), "allow");

		// modified (e.g. the model edited it): allow no longer loads, deny/ask still do
		const edited = content.replace('"Bash(git commit *)"', '"Bash(git commit *)", "Bash(make deploy *)"');
		writeFileSync(file, edited);
		loaded = loadProjectRules(t.project, t.agent);
		assert.equal(loaded.trusted, false);
		assert.equal(loaded.rules.allow.length, 2);
		perms = compilePermissions(loaded.rules, loaded.trusted);
		assert.equal(decide("default", "make deploy x", perms), "ask");
		assert.equal(perms.deny.length, 1);

		// invalid JSON loads nothing and says so
		writeFileSync(file, "{ nope");
		loaded = loadProjectRules(t.project, t.agent);
		assert.match(loaded.rules.warnings.join(), /not valid JSON/);

		// no file at all is fine
		rmSync(file);
		loaded = loadProjectRules(t.project, t.agent);
		assert.deepEqual([loaded.exists, loaded.trusted, loaded.rules.allow.length], [false, true, 0]);
	} finally {
		t.done();
	}
});

test("saving: merges, dedupes, keeps foreign keys, atomic, excludes once", () => {
	const t = temp();
	try {
		const file = join(t.project, FILE);
		mkdirSync(join(t.project, ".pi"));
		writeFileSync(
			file,
			JSON.stringify({ theme: "dark", other: { a: [1, 2] }, "pi-keeper": { keep: true, permissions: { deny: ["Bash(x *)"], allow: ["Bash(npm test)"] } } }),
		);
		// an existing, unreviewed file is not blessed by our write
		let result = saveAllowRules(t.project, t.agent, [["git", "commit"]]);
		assert.deepEqual(result.added, ["Bash(git commit *)"]);
		assert.equal(result.trusted, false);
		assert.equal(loadProjectRules(t.project, t.agent).trusted, false);
		// ...unless the user approved that content in a review
		const current = readFileSync(file, "utf8");
		result = saveAllowRules(t.project, t.agent, [["git", "add"]], sha256(current));
		assert.equal(result.trusted, true);
		let loaded = loadProjectRules(t.project, t.agent);
		assert.equal(loaded.trusted, true);

		const doc = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(doc.theme, "dark");
		assert.deepEqual(doc.other, { a: [1, 2] });
		assert.equal(doc["pi-keeper"].keep, true);
		assert.deepEqual(doc["pi-keeper"].permissions.deny, ["Bash(x *)"]);
		assert.deepEqual(doc["pi-keeper"].permissions.allow, ["Bash(npm test)", "Bash(git commit *)", "Bash(git add *)"]);
		assert.ok(readFileSync(file, "utf8").endsWith("}\n"));
		assert.ok(readFileSync(file, "utf8").includes('\n  "theme"')); // 2-space indent

		// dedupe: nothing changes, nothing rewritten
		result = saveAllowRules(t.project, t.agent, [["git", "add"], ["git", "commit"]]);
		assert.deepEqual(result.added, []);
		assert.equal(JSON.parse(readFileSync(file, "utf8"))["pi-keeper"].permissions.allow.length, 3);

		// no temp files left behind
		assert.deepEqual(readdirSync(join(t.project, ".pi")), ["settings.local.json"]);
		assert.deepEqual(readdirSync(join(t.agent, "pi-keeper")), ["trusted-rules.json"]);

		// exclude line added once (and a fresh file is trusted)
		const exclude = join(t.project, ".git", "info", "exclude");
		assert.equal(readFileSync(exclude, "utf8").split("\n").filter((l) => l === ".pi/settings.local.json").length, 1);
		saveAllowRules(t.project, t.agent, [["make", "build"]], undefined);
		assert.equal(readFileSync(exclude, "utf8").split("\n").filter((l) => l === ".pi/settings.local.json").length, 1);
		loaded = loadProjectRules(t.project, t.agent);
		assert.equal(loaded.rules.allow.length, 4);
	} finally {
		t.done();
	}
});

test("saving: new file is trusted, existing exclude content is kept, bad files are never overwritten", () => {
	const t = temp();
	try {
		const exclude = join(t.project, ".git", "info", "exclude");
		writeFileSync(exclude, "*.log"); // no trailing newline
		const result = saveAllowRules(join(t.project, "sub"), t.agent, [["npm", "test"]]);
		assert.equal(result.file, join(t.project, FILE));
		assert.equal(result.trusted, true);
		assert.equal(readFileSync(exclude, "utf8"), "*.log\n.pi/settings.local.json\n");
		assert.equal(existsSync(join(t.project, ".gitignore")), false);
		assert.equal(loadProjectRules(t.project, t.agent).trusted, true);

		// invalid JSON or a non-object is left alone
		writeFileSync(result.file, "{ broken");
		assert.throws(() => saveAllowRules(t.project, t.agent, [["npm", "test"]]), /not valid JSON/);
		assert.equal(readFileSync(result.file, "utf8"), "{ broken");
		writeFileSync(result.file, "[]");
		assert.throws(() => saveAllowRules(t.project, t.agent, [["npm", "test"]]), /not a JSON object/);
		assert.deepEqual(readdirSync(join(t.project, ".pi")), ["settings.local.json"]);
	} finally {
		t.done();
	}
});

test("saving: worktree .git files and non-repos", () => {
	const base = mkdtempSync(join(tmpdir(), "pdf-wt-"));
	try {
		// worktree: .git is a file pointing into <common>/worktrees/x, which has commondir
		const common = join(base, "main", ".git");
		const gitdir = join(common, "worktrees", "wt");
		mkdirSync(gitdir, { recursive: true });
		writeFileSync(join(gitdir, "commondir"), "../..\n");
		const wt = join(base, "wt");
		mkdirSync(wt);
		writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
		const agent = join(base, "agent");
		saveAllowRules(wt, agent, [["npm", "test"]]);
		assert.equal(readFileSync(join(common, "info", "exclude"), "utf8"), ".pi/settings.local.json\n");

		// not a repo: the file is written, no exclude is touched
		const plain = join(base, "plain");
		mkdirSync(plain);
		const result = saveAllowRules(plain, agent, [["npm", "test"]]);
		assert.equal(existsSync(result.file), true);
		assert.equal(existsSync(join(plain, ".git")), false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("typed patterns: with or without Bash(...), same checks as file entries", () => {
	assert.ok("error" in parsePattern("awk *", "allow"));
	// sed is rememberable: its exec forms are never covered, its writes only inside the project
	assert.ok(!("error" in parsePattern("sed *", "allow")));
	assert.deepEqual(parsePattern("git commit *", "allow"), { text: "Bash(git commit *)", tokens: ["git", "commit"], exact: false });
	assert.deepEqual(parsePattern("  npm test ", "allow"), { text: "Bash(npm test)", tokens: ["npm", "test"], exact: true });
	assert.deepEqual(parsePattern("Bash(rtk git add *)", "allow"), { text: "Bash(rtk git add *)", tokens: ["git", "add"], exact: false });
	for (const bad of ["bash -c *", "git rm *", "npm run *", "git commit; rm x", "", "git 'commit' *"]) {
		assert.ok("error" in parsePattern(bad, "allow"), `accepted for allow: ${JSON.stringify(bad)}`);
	}
	// exact entries are narrower than prefixes: they may name interpreters and
	// script runners (only that one command runs unasked), never removals or
	// privilege commands
	assert.ok(!("error" in parsePattern("python3 scripts/x.py", "allow")));
	assert.ok(!("error" in parsePattern("npm run build", "allow")));
	assert.ok(!("error" in parsePattern("node --test tests/a.test.ts", "allow")));
	assert.ok(!("error" in parsePattern("rtk python3 x.py", "allow")));
	// `bash -c ls` names one command token-for-token: only that runs unasked
	assert.ok(!("error" in parsePattern("bash -c ls", "allow")));
	for (const bad of ["rm -rf src", "git rm file", "sudo apt update", "rtk run x"]) {
		assert.ok("error" in parsePattern(bad, "allow"), `accepted as exact allow: ${JSON.stringify(bad)}`);
	}
	// allow-only limits: ask and deny may name interpreters and removals
	assert.ok(!("error" in parsePattern("git rm *", "deny")));
	assert.ok(!("error" in parsePattern("bash *", "ask")));
	assert.ok("error" in parsePattern("git push $X", "deny"));
});

test("saveRules: ask and deny lists, validation, dedupe, trust", () => {
	const t = temp();
	try {
		const file = join(t.project, FILE);
		let result = saveRules(t.project, t.agent, "deny", ["Bash(git push *)", "Bash(git push *)"]);
		assert.deepEqual(result.added, ["Bash(git push *)"]);
		assert.equal(result.trusted, true);
		saveRules(t.project, t.agent, "ask", ["Bash(rm *)"]); // not allowed for allow, fine for ask
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8"))["pi-keeper"].permissions, { deny: ["Bash(git push *)"], ask: ["Bash(rm *)"] });
		assert.equal(loadProjectRules(t.project, t.agent).trusted, true);
		assert.equal(saveRules(t.project, t.agent, "deny", ["Bash(git push *)"]).added.length, 0);

		// allow entries obey the allow limits, nothing is written
		const before = readFileSync(file, "utf8");
		assert.throws(() => saveRules(t.project, t.agent, "allow", ["Bash(bash *)"]), /can't be allowed/);
		assert.throws(() => saveRules(t.project, t.agent, "deny", ["not a rule"]), /Bash\(/);
		assert.equal(readFileSync(file, "utf8"), before);

		// exact entries are kept as written
		saveRules(t.project, t.agent, "allow", ["Bash(npm test --coverage)"]);
		assert.deepEqual(loadProjectRules(t.project, t.agent).rules.allow.map((r) => [r.tokens.join(" "), r.exact]), [["npm test --coverage", true]]);

		// an edited (unreviewed) file is not blessed
		writeFileSync(file, before.replace("git push *", "git push *\", \"Bash(make deploy *)"));
		result = saveRules(t.project, t.agent, "deny", ["Bash(terraform destroy *)"]);
		assert.equal(result.trusted, false);
		assert.equal(loadProjectRules(t.project, t.agent).trusted, false);
	} finally {
		t.done();
	}
});

test("removeRule: removes one entry, keeps foreign keys, same trust semantics as saving", () => {
	const t = temp();
	try {
		const file = join(t.project, FILE);
		mkdirSync(join(t.project, ".pi"));
		const doc = { theme: "dark", "pi-keeper": { keep: true, permissions: { allow: ["Bash(git add *)", "Bash(npm test)"], deny: ["Bash(git push *)"] } } };
		writeFileSync(file, JSON.stringify(doc));

		// unreviewed content: removal works but doesn't bless the rest
		let result = removeRule(t.project, t.agent, "allow", "Bash(git add *)");
		assert.deepEqual([result.removed, result.trusted], [true, false]);
		assert.equal(loadProjectRules(t.project, t.agent).trusted, false);
		let saved = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(saved.theme, "dark");
		assert.equal(saved["pi-keeper"].keep, true);
		assert.deepEqual(saved["pi-keeper"].permissions, { allow: ["Bash(npm test)"], deny: ["Bash(git push *)"] });

		// missing entry or wrong list: nothing written
		const before = readFileSync(file, "utf8");
		assert.equal(removeRule(t.project, t.agent, "ask", "Bash(npm test)").removed, false);
		assert.equal(removeRule(t.project, t.agent, "allow", "Bash(nope)").removed, false);
		assert.equal(readFileSync(file, "utf8"), before);

		// approved by the user this session: the new content is recorded as trusted
		result = removeRule(t.project, t.agent, "deny", " Bash(git push *) ", sha256(before));
		assert.deepEqual([result.removed, result.trusted], [true, true]);
		assert.equal(loadProjectRules(t.project, t.agent).trusted, true);
		saved = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(saved["pi-keeper"].permissions, { allow: ["Bash(npm test)"] }); // emptied list dropped

		// already trusted content stays trusted
		result = removeRule(t.project, t.agent, "allow", "Bash(npm test)");
		assert.deepEqual([result.removed, result.trusted], [true, true]);
		assert.equal(loadProjectRules(t.project, t.agent).trusted, true);
		assert.deepEqual(readdirSync(join(t.project, ".pi")), ["settings.local.json"]);

		// no file: nothing created; bad files never overwritten
		rmSync(file);
		assert.equal(removeRule(t.project, t.agent, "allow", "Bash(x)").removed, false);
		assert.equal(existsSync(file), false);
		writeFileSync(file, "{ broken");
		assert.throws(() => removeRule(t.project, t.agent, "allow", "Bash(x)"), /not valid JSON/);
		assert.equal(readFileSync(file, "utf8"), "{ broken");
	} finally {
		t.done();
	}
});

// --- allowed-tools frontmatter ---

test("parseAllowedTools: string, list and legacy forms; non-Bash entries ignored", () => {
	const texts = (value: unknown) => parseAllowedTools(value).rules.map((r) => r.text);
	assert.deepEqual(texts("Bash(git add *) Bash(git commit *) Bash(git status)"), ["Bash(git add *)", "Bash(git commit *)", "Bash(git status)"]);
	assert.deepEqual(texts(["Bash(git diff *)", "Read", "Bash(npm test)"]), ["Bash(git diff *)", "Bash(npm test)"]);
	assert.deepEqual(texts("Bash(git commit:*), Read, Edit"), ["Bash(git commit *)"]);
	assert.deepEqual(texts("Bash(git add *) Bash(git add *)"), ["Bash(git add *)"]);
	assert.deepEqual(texts(undefined), []);
	assert.deepEqual(texts(42), []);
	const status = parseAllowedTools("Bash(git status)").rules[0];
	assert.equal(status.exact, true);
});

test("parseAllowedTools: grants that can't be remembered are rejected with a warning", () => {
	const { rules, warnings } = parseAllowedTools("Bash(rm *) Bash(python *) Bash(git add *) Bash(git add && rm x)");
	assert.deepEqual(rules.map((r) => r.text), ["Bash(git add *)"]);
	assert.equal(warnings.length, 3);
});

test("control characters in a rule are rejected, so they can't fake lines in the review dialog", () => {
	const crafted = "Read(/tmp/a\n  Fetch(github.com)\n  Read(/tmp/b/**)";
	const rules = parseRules({ "pi-keeper": { permissions: { allow: [crafted + "/**)", "Read(/tmp/a\u001b[2K/**)", "Bash(make\u001b[2K x)", "Read(/tmp/ok/**)"] } } });
	assert.deepEqual(rules.readDirs.map((r) => r.dir), ["/tmp/ok"]);
	assert.equal(rules.allow.length, 0);
	assert.equal(rules.fetchHosts.length, 0);
	assert.equal(rules.warnings.filter((w) => w.includes("control characters")).length, 3, rules.warnings.join("\n"));
});

test("loadProjectRules marks invalid JSON as broken, and whitespace-only as valid and empty", () => {
	const t = temp();
	try {
		mkdirSync(join(t.project, ".pi"));
		writeFileSync(join(t.project, FILE), "{broken");
		assert.match(loadProjectRules(t.project, t.agent).broken ?? "", /not valid JSON/);
		writeFileSync(join(t.project, FILE), "   \n");
		assert.equal(loadProjectRules(t.project, t.agent).broken, undefined);
	} finally {
		t.done();
	}
});

test("loadProjectRules marks an unreadable file as broken, a missing file as not broken", () => {
	const t = temp();
	try {
		assert.equal(loadProjectRules(t.project, t.agent).broken, undefined);
		// a directory where the file should be: the read fails with EISDIR, not ENOENT
		mkdirSync(join(t.project, FILE), { recursive: true });
		assert.match(loadProjectRules(t.project, t.agent).broken ?? "", /cannot be read/);
	} finally {
		t.done();
	}
});
