/**
 * Skill files the model was told to read: pi renders an `<available_skills>`
 * block into the system prompt, and every `<location>` in it is a file the
 * model is invited to load. Reading those files is not an outside-cwd read
 * (asking for each one would make an inherited skills catalog useless),
 * while anything else outside the cwd keeps asking.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOutsideCwdRead, outsideCwdReadPaths, skillDirsFromPrompt, type PathContext } from "../../extensions/utils.ts";

const CWD = "/home/user/project";

/** pi's own shape (`formatSkillsForPrompt`): the block plus one entry per skill. */
function promptWithSkills(locations: readonly string[]): string {
	return [
		"BASE",
		"",
		"<skills>",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
		...locations.flatMap((location) => ["  <skill>", "    <name>alpha</name>", "    <description>d</description>", `    <location>${location}</location>`, "  </skill>"]),
		"</available_skills>",
		"</skills>",
	].join("\n");
}

/** skills/{alpha,beta}/SKILL.md, alpha/scripts/run.py, and an unrelated `other/`. */
function withTree<T>(run: (base: string) => T): T {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-skills-")));
	try {
		mkdirSync(join(base, "skills", "alpha", "scripts"), { recursive: true });
		mkdirSync(join(base, "skills", "beta"), { recursive: true });
		mkdirSync(join(base, "other"));
		writeFileSync(join(base, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
		writeFileSync(join(base, "skills", "alpha", "scripts", "run.py"), "# run\n");
		writeFileSync(join(base, "skills", "beta", "SKILL.md"), "---\nname: beta\n---\n");
		writeFileSync(join(base, "other", "notes.md"), "n");
		return run(base);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

test("the skill directories come from the prompt's locations", () =>
	withTree((base) => {
		const alpha = join(base, "skills", "alpha", "SKILL.md");
		const beta = join(base, "skills", "beta", "SKILL.md");
		assert.deepEqual(skillDirsFromPrompt(promptWithSkills([alpha, beta])), [join(base, "skills", "alpha"), join(base, "skills", "beta")]);
		// a duplicate location is one directory
		assert.deepEqual(skillDirsFromPrompt(promptWithSkills([alpha, alpha])), [join(base, "skills", "alpha")]);
	}));

test("no catalog means no skill directories", () => {
	assert.deepEqual(skillDirsFromPrompt(""), []);
	assert.deepEqual(skillDirsFromPrompt("BASE\n\n<rules>\nnothing\n</rules>"), []);
	// a catalog with no entries is the same as none
	assert.deepEqual(skillDirsFromPrompt("<available_skills>\n</available_skills>"), []);
	// a relative location is not a path pi renders; it grants nothing
	assert.deepEqual(skillDirsFromPrompt(promptWithSkills(["skills/alpha/SKILL.md"])), []);
});

test("an escaped location is unescaped before it is used", () =>
	withTree((base) => {
		const dir = join(base, "skills", "a&b");
		mkdirSync(dir);
		writeFileSync(join(dir, "SKILL.md"), "---\nname: ab\n---\n");
		const escaped = join(dir, "SKILL.md").replace(/&/g, "&amp;");
		assert.deepEqual(skillDirsFromPrompt(promptWithSkills([escaped])), [dir]);
	}));

test("a skill file and the files beside it are readable; the rest stays an outside read", () =>
	withTree((base) => {
		const ctx: PathContext = { cwd: CWD, skillDirs: skillDirsFromPrompt(promptWithSkills([join(base, "skills", "alpha", "SKILL.md")])) };
		assert.equal(isOutsideCwdRead(join(base, "skills", "alpha", "SKILL.md"), ctx), false);
		// a file the skill points at (its scripts) is inside the skill's directory
		assert.equal(isOutsideCwdRead(join(base, "skills", "alpha", "scripts", "run.py"), ctx), false);
		// another skill's directory was not in this prompt
		assert.equal(isOutsideCwdRead(join(base, "skills", "beta", "SKILL.md"), ctx), true);
		// `..` out of the skill directory
		assert.equal(isOutsideCwdRead(join(base, "skills", "alpha", "..", "beta", "SKILL.md"), ctx), true);
		assert.equal(isOutsideCwdRead(join(base, "other", "notes.md"), ctx), true);
		// bash reads follow the same rule
		assert.deepEqual(outsideCwdReadPaths(`cat ${join(base, "skills", "alpha", "SKILL.md")}`, ctx), []);
		assert.deepEqual(outsideCwdReadPaths(`cat ${join(base, "other", "notes.md")}`, ctx), [join(base, "other", "notes.md")]);
		// and without skillDirs nothing is exempt
		assert.equal(isOutsideCwdRead(join(base, "skills", "alpha", "SKILL.md"), { cwd: CWD }), true);
	}));

test("a symlinked skill directory is judged by realpath, so the link and its target both count", () =>
	withTree((base) => {
		const link = join(base, "linked-alpha");
		symlinkSync(join(base, "skills", "alpha"), link);
		const p = promptWithSkills([join(link, "SKILL.md")]);
		const dirs = skillDirsFromPrompt(p);
		const ctx: PathContext = { cwd: CWD, skillDirs: dirs };
		assert.deepEqual(dirs, [join(base, "skills", "alpha")]);
		assert.equal(isOutsideCwdRead(join(link, "SKILL.md"), ctx), false);
		assert.equal(isOutsideCwdRead(join(base, "skills", "alpha", "SKILL.md"), ctx), false);
		// a sibling the link's directory does not cover
		assert.equal(isOutsideCwdRead(join(base, "skills", "beta", "SKILL.md"), ctx), true);
	}));
