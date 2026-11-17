/**
 * An unquoted glob is expanded by the shell before the command runs, so the
 * checks look at what it matches on disk: a secret file inside the project, a
 * link that leads out of it, and a glob that matches too much to check.
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../../extensions/rules.ts";
import { GLOBAL_RULES, MODES } from "../../extensions/modes.ts";
import { isSecretCommand, outsideCwdReadPaths } from "../../extensions/utils.ts";

/** A project and a sibling file outside it, in a directory that is not the OS temp dir (reads there never ask). */
function withProject(body: (cwd: string, base: string) => void): void {
	const base = mkdtempSync(join(process.cwd(), ".glob-reads-"));
	try {
		const cwd = join(base, "project");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(join(cwd, "conf"));
		writeFileSync(join(cwd, "src", "a.py"), "x");
		writeFileSync(join(cwd, "src", "b.py"), "x");
		writeFileSync(join(cwd, "conf", "id_rsa"), "k");
		writeFileSync(join(cwd, "conf", "app.toml"), "k");
		writeFileSync(join(cwd, "plain.txt"), "x");
		writeFileSync(join(base, "outside.txt"), "x");
		symlinkSync(join(base, "outside.txt"), join(cwd, "src", "link.py"));
		body(cwd, base);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

const action = (cwd: string, command: string): string =>
	evaluate(MODES.default.permissions, GLOBAL_RULES, { toolName: "bash", input: { command } }, { cwd, remembered: [] }).action;

test("a glob that matches a secret file asks, whatever its pattern says", () => {
	withProject((cwd) => {
		assert.equal(isSecretCommand("rtk grep x conf/*", { cwd }), true);
		assert.equal(isSecretCommand("cat conf/id_*", { cwd }), true);
		assert.equal(isSecretCommand("cat conf/{id_rsa,app.toml}", { cwd }), true);
		assert.equal(isSecretCommand("cat conf/app.*", { cwd }), false);
		assert.equal(isSecretCommand("rtk grep x src/*.py", { cwd }), false);
		assert.equal(isSecretCommand("cat conf/*", {}), false, "without a cwd there is nothing to expand");
		assert.equal(action(cwd, "rtk grep x conf/*"), "ask");
		assert.equal(action(cwd, "rtk grep x src/*.py"), "ask", "the link in src leads out of the project");
	});
});

test("a glob or a name that is a link out of the project is an outside read", () => {
	withProject((cwd) => {
		const ctx = { cwd };
		assert.deepEqual(outsideCwdReadPaths("rtk grep x src/link.py", ctx), ["src/link.py"], "named directly");
		assert.deepEqual(outsideCwdReadPaths("rtk grep x src/*.py", ctx), ["src/link.py"], "matched by a glob");
		assert.deepEqual(outsideCwdReadPaths("rtk grep x src/l*", ctx), ["src/link.py"]);
		assert.deepEqual(outsideCwdReadPaths("cat src/{a,link}.py", ctx), ["src/link.py"]);
		assert.deepEqual(outsideCwdReadPaths("rtk grep x src/a.py src/b.py", ctx), []);
		assert.deepEqual(outsideCwdReadPaths("rtk grep x src/[ab].py", ctx), []);
		assert.deepEqual(outsideCwdReadPaths("rtk grep x --include=src/*.py .", ctx), [], "an option value is a filter, not a read");
		assert.deepEqual(outsideCwdReadPaths("rtk grep x plain.*", ctx), []);
		assert.equal(action(cwd, "rtk grep x src/link.py"), "ask");
		assert.equal(action(cwd, "rtk grep x src/a.py"), "allow");
		assert.equal(action(cwd, "ls plain.*"), "allow");
	});
});

test("a glob follows the shell: dotfiles only for a dot pattern, names that do not exist are not matches", () => {
	withProject((cwd) => {
		writeFileSync(join(cwd, ".env"), "KEY=1");
		assert.equal(isSecretCommand("ls *", { cwd }), false, "* does not match .env");
		assert.equal(isSecretCommand("ls .*", { cwd }), true, ".* does");
		assert.equal(isSecretCommand("ls nothing/*", { cwd }), false);
	});
});

test("a glob that matches more than the limit fails closed", () => {
	withProject((cwd) => {
		mkdirSync(join(cwd, "many"));
		for (let i = 0; i < 2100; i++) writeFileSync(join(cwd, "many", `f${i}.txt`), "");
		assert.equal(isSecretCommand("cat many/*", { cwd }), true);
		assert.deepEqual(outsideCwdReadPaths("cat many/*", { cwd }), ["many/*"]);
	});
});
