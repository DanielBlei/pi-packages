/**
 * Recursive searches over secret-looking files that git tracks: a committed
 * fixture (a demo certificate, a template `.env`) is repository content, so
 * searching the project does not ask. An untracked file, a directory that is
 * not a repository, or a search root outside the working directory still does.
 * Run: npm test
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretSearchHits, type PathContext } from "../../extensions/utils.ts";

/** Runs git in `cwd`, failing the test when it errors. */
function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

test("a committed secret fixture in the project does not ask; an untracked one does", { skip: hasGit ? false : "git is not installed" }, () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-fixtures-")));
	try {
		const project = join(base, "project");
		mkdirSync(join(project, "deploy", "x509"), { recursive: true });
		// fixtures: tracked (a demo certificate, a template .env)
		writeFileSync(join(project, "deploy", "x509", "server.pem"), "fixture");
		writeFileSync(join(project, ".env"), "DEMO=1");
		git(project, ["init", "--quiet"]);
		git(project, ["add", "."]);
		git(project, ["commit", "--quiet", "-m", "fixtures"]);

		const ctx: PathContext = { cwd: project };
		assert.deepEqual(secretSearchHits("grep -r KEY .", ctx), [], "both fixtures are committed");
		assert.deepEqual(secretSearchHits("grep -rn KEY deploy", ctx), []);
		assert.deepEqual(secretSearchHits("rg --hidden KEY", ctx), []);

		// the user's own credentials beside them: untracked, so the search asks
		writeFileSync(join(project, ".env.local"), "REAL=1");
		assert.deepEqual(
			secretSearchHits("grep -r KEY .", ctx).map((hit) => hit.path),
			[".env.local"],
		);
		// a tracked file that is modified is still tracked
		writeFileSync(join(project, ".env"), "DEMO=2");
		assert.deepEqual(
			secretSearchHits("grep -r KEY .", ctx).map((hit) => hit.path),
			[".env.local"],
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a nested repository judges its own files (a submodule's fixtures count as committed)", { skip: hasGit ? false : "git is not installed" }, () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-fixtures-")));
	try {
		const project = join(base, "project");
		const nested = join(project, "apps");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "tls.key"), "fixture");
		git(nested, ["init", "--quiet"]);
		git(nested, ["add", "."]);
		git(nested, ["commit", "--quiet", "-m", "fixtures"]);
		// the outer project does not know the inner file (this is the submodule case)
		git(project, ["init", "--quiet"]);
		const ctx: PathContext = { cwd: project };
		assert.deepEqual(secretSearchHits("grep -r KEY apps", ctx), []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("no repository, or a search root outside the project, still asks", { skip: hasGit ? false : "git is not installed" }, () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-fixtures-")));
	try {
		const project = join(base, "project");
		const other = join(base, "other");
		mkdirSync(project);
		mkdirSync(other);
		writeFileSync(join(other, ".env"), "SECRET=1");
		git(other, ["init", "--quiet"]);
		git(other, ["add", "."]);
		git(other, ["commit", "--quiet", "-m", "fixtures"]);
		// the file is tracked, but it is not in this project: reading it is an outside read
		const ctx: PathContext = { cwd: project };
		assert.deepEqual(
			secretSearchHits(`grep -r KEY ${other}`, ctx).map((hit) => hit.path),
			[join(other, ".env")],
		);
		// a project without git: the walk finds the file and cannot prove it is a fixture
		writeFileSync(join(project, ".env"), "SECRET=1");
		git(project, ["init", "--quiet"]);
		assert.deepEqual(
			secretSearchHits("grep -r KEY .", ctx).map((hit) => hit.path),
			[".env"],
			"initialized but not added: untracked",
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a tracked-file answer expires after 30 seconds (untracked later, the search asks again)", { skip: hasGit ? false : "git is not installed" }, () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-fixtures-")));
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		const project = join(base, "project");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, ".env"), "DEMO=1");
		git(project, ["init", "--quiet"]);
		git(project, ["add", "."]);
		git(project, ["commit", "--quiet", "-m", "fixture"]);
		const ctx: PathContext = { cwd: project };
		assert.deepEqual(secretSearchHits("grep -r KEY .", ctx), [], "committed: no ask");
		// untracked now, but the answer is still cached within the 30 seconds
		git(project, ["rm", "--quiet", "--cached", ".env"]);
		assert.deepEqual(secretSearchHits("grep -r KEY .", ctx), [], "cached answer within the window");
		mock.timers.tick(31_000);
		assert.deepEqual(
			secretSearchHits("grep -r KEY .", ctx).map((hit) => hit.path),
			[".env"],
			"after 30 seconds the file is checked again",
		);
	} finally {
		mock.timers.reset();
		rmSync(base, { recursive: true, force: true });
	}
});
