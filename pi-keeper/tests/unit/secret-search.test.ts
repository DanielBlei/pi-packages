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

test("a file list piped into a reader is a search over the listed tree: an untracked secret asks", { skip: hasGit ? false : "git is not installed" }, () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-pipes-")));
	try {
		const project = join(base, "project");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(join(project, "src", "a.ts"), "export {};");
		writeFileSync(join(project, "README.md"), "hi");
		git(project, ["init", "--quiet"]);
		git(project, ["add", "."]);
		git(project, ["commit", "--quiet", "-m", "init"]);
		// the user's own key, untracked, beside the tracked files
		writeFileSync(join(project, "id_rsa"), "PRIVATE");
		const ctx: PathContext = { cwd: project };
		const paths = (command: string): string[] => secretSearchHits(command, ctx).map((hit) => hit.path);

		// red: the reader gets every name the list prints, the key among them
		assert.deepEqual(paths("ls | xargs cat"), ["id_rsa"]);
		assert.deepEqual(paths("find . -type f | xargs cat"), ["id_rsa"]);
		assert.deepEqual(paths("git ls-files -o | xargs cat"), ["id_rsa"]);
		assert.deepEqual(paths("find . -name 'id_*' | xargs head"), ["id_rsa"], "a name glob that matches the secret");

		// guards: the same directory, a list that names no secret, or a command that is not a reader
		assert.deepEqual(paths("find . -name '*.ts' | xargs grep foo"), []);
		assert.deepEqual(paths("git ls-files | xargs cat"), [], "tracked files are content by design");
		assert.deepEqual(paths("ls | xargs wc -l"), []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("find -name G before a reader asks only when a secret the glob names is in the tree", { skip: hasGit ? false : "git is not installed" }, () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-findname-")));
	try {
		const project = join(base, "project");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(join(project, "src", "a.ts"), "export {};");
		git(project, ["init", "--quiet"]);
		git(project, ["add", "."]);
		git(project, ["commit", "--quiet", "-m", "init"]);
		writeFileSync(join(project, "id_rsa"), "PRIVATE");
		writeFileSync(join(project, "srcX.pem"), "PRIVATE");
		const ctx: PathContext = { cwd: project };
		const paths = (command: string): string[] => secretSearchHits(command, ctx).map((hit) => hit.path);

		// every name: the key and the pem both
		const all = paths("find . -name '*' | xargs cat");
		assert.ok(all.includes("id_rsa") && all.includes("srcX.pem"), `got ${all}`);
		// a glob that names only the pem
		assert.deepEqual(paths("find . -name 'src*' | xargs cat"), ["srcX.pem"]);
		// a glob that names no secret in the tree stays allowed
		assert.deepEqual(paths("find . -name '*.ts' | xargs grep foo"), []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

/** A git project with an untracked key beside tracked files. */
function keyProject(base: string): string {
	const project = join(base, "project");
	mkdirSync(join(project, "src"), { recursive: true });
	writeFileSync(join(project, "src", "a.ts"), "export {};");
	writeFileSync(join(project, "README.md"), "hi");
	git(project, ["init", "--quiet"]);
	git(project, ["add", "."]);
	git(project, ["commit", "--quiet", "-m", "init"]);
	writeFileSync(join(project, "id_rsa"), "PRIVATE");
	return project;
}

test("a file list reaches its reader through redirections, quotes, filters, groups and wrappers; a non-reading consumer does not", { skip: hasGit ? false : "git is not installed" }, () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-producers-")));
	try {
		const ctx: PathContext = { cwd: keyProject(base) };
		const asks = [
			"ls -a 2>&1 | xargs cat",
			"find . -type f 2>&1 | xargs cat",
			"ls -a &>/dev/null | xargs cat",
			"ls -a | sort | xargs cat",
			"ls -a | grep -v x | xargs cat",
			"find . -type f | grep -v git | xargs cat",
			"ls -a | tail -n +3 | xargs cat",
			"ls -a | head -5 | xargs cat",
			"ls -a | sed 's/x/y/' | xargs cat",
			"(ls -a; echo x) | xargs cat",
			"{ ls -a; } | xargs cat",
			"ls -a | nice xargs cat",
			"command ls -a | xargs cat",
			"ls -a | xargs sort",
			"ls -a | xargs jq .",
			"ls -a | xargs cmp x",
			"ls -a | xargs cut -c1-5",
			"git ls-files -io | xargs cat",
			"find . -type f -exec cat {} +",
			"find . -type f -exec cat {} \;",
			"find . ! -name '*.py' | xargs cat",
			"find . -name '*.py' -o -name '*nv' | xargs cat",
			"find . -name '*.py' -prune -o -print | xargs cat",
		];
		for (const command of asks) assert.notDeepEqual(secretSearchHits(command, ctx), [], `asks: ${command}`);
		// guards: a grep whose quoted pattern holds `ls|find` has no file list; non-reading consumers; no xargs
		for (const command of ["grep -E \"ls|find\" x | xargs cat", "ls | xargs wc -l", "ls | xargs echo", "ls -a | sort", "find . -name '*.ts' | xargs grep foo", "git ls-files | xargs cat"]) {
			assert.deepEqual(secretSearchHits(command, ctx), [], `guard: ${command}`);
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a file list of a directory outside the project is an unchecked hit at once, not a walk", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-outside-")));
	try {
		const project = join(base, "project");
		const outside = join(base, "outside");
		mkdirSync(project);
		mkdirSync(join(outside, "sub"), { recursive: true });
		for (let i = 0; i < 300; i++) writeFileSync(join(outside, "sub", `f${i}.txt`), "x");
		writeFileSync(join(outside, "sub", ".env"), "KEY=1");
		const ctx: PathContext = { cwd: project };
		const started = performance.now();
		const hits = secretSearchHits(`find ${outside} -maxdepth 1 | xargs cat`, ctx);
		const ms = performance.now() - started;
		assert.ok(hits.some((hit) => hit.why === "unchecked"), `hits: ${JSON.stringify(hits)}`);
		assert.ok(ms < 100, `took ${ms.toFixed(1)} ms`);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a file list reaches its reader through a long filter chain, a launcher with a value, parallel, and a long option", { skip: hasGit ? false : "git is not installed" }, () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-round4-")));
	try {
		const project = keyProject(base);
		writeFileSync(join(project, ".env"), "K=1");
		const ctx: PathContext = { cwd: project };
		const asks = [
			`ls -a | ${"cat | ".repeat(17)}xargs cat`,
			"ls -a | xargs --max-lines cat",
			"ls -a | timeout 5 xargs cat",
			"ls -a | setsid xargs cat",
			"ls -a | ionice xargs cat",
			"ls | parallel cat",
		];
		for (const command of asks) assert.notDeepEqual(secretSearchHits(command, ctx), [], command);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
