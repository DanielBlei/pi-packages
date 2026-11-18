/**
 * An unquoted glob is expanded by the shell before the command runs, so the
 * checks look at what it matches on disk: a secret file inside the project, a
 * link that leads out of it, and a glob that matches too much to check.
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("a glob under ~ that matches a secret asks, whatever its pattern says (a fake HOME holds the file)", () => {
	const base = mkdtempSync(join(process.cwd(), ".glob-home-"));
	const savedHome = process.env.HOME;
	try {
		const home = join(base, "home");
		const cwd = join(base, "project");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(cwd);
		writeFileSync(join(home, ".pi", "agent", "auth.json"), "{}");
		writeFileSync(join(cwd, "a.py"), "x");
		process.env.HOME = home;
		assert.equal(isSecretCommand("cat ~/.pi/agent/auth.js*", { cwd }), true);
		assert.equal(action(cwd, "cat ~/.pi/agent/auth.js*"), "ask");
		// guard: a glob under ~ that names no secret
		assert.equal(isSecretCommand("cat ~/.pi/agent/auth.md*", { cwd }), false);
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(base, { recursive: true, force: true });
	}
});

test("a glob whose directory is outside the project is an outside read; one inside the project is not", () => {
	withProject((cwd) => {
		assert.deepEqual(outsideCwdReadPaths("cat /etc/pass*", { cwd }), ["/etc/pass*"]);
		assert.equal(action(cwd, "cat /etc/pass*"), "ask");
		// guards: globs inside the project
		assert.equal(action(cwd, "cat src/*.ts"), "allow", "no .ts file: the literal word is passed through");
		assert.deepEqual(outsideCwdReadPaths("cat src/a*.py", { cwd }), []);
		assert.deepEqual(outsideCwdReadPaths("rtk grep foo src/*.py", { cwd }), ["src/link.py"], "same as before: the link leads out");
		assert.equal(isSecretCommand("rtk grep foo src/*.py", { cwd }), false);
	});
});

/**
 * Decisions for one command in a child process, with the time the evaluation took inside it. A regex that
 * backtracks for minutes would hang the test runner, so the child is killed after 10 s and the test fails.
 */
function timedDecisions(cwd: string, command: string): Array<{ action: string; ms: number }> | "timeout" {
	const rules = new URL("../../extensions/rules.ts", import.meta.url).href;
	const modes = new URL("../../extensions/modes.ts", import.meta.url).href;
	const script = `
import { evaluate } from ${JSON.stringify(rules)};
import { GLOBAL_RULES, MODES } from ${JSON.stringify(modes)};
const [cwd, command] = JSON.parse(process.argv[1]);
const out = [];
for (const mode of ["default", "auto", "plan"]) {
	const t = performance.now();
	const action = evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: "bash", input: { command } }, { cwd, remembered: [] }).action;
	out.push({ action, ms: performance.now() - t });
}
console.log(JSON.stringify(out));
`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify([cwd, command])], { encoding: "utf8", timeout: 10_000 });
	if (result.error !== undefined || result.status !== 0) return "timeout";
	return JSON.parse(result.stdout);
}

test("a glob with many stars asks quickly: its star regex is never built", () => {
	withProject((cwd) => {
		// long names, so an unbounded star regex would backtrack for a long time
		for (let i = 0; i < 3; i++) writeFileSync(join(cwd, "x".repeat(30) + i), "");
		for (const stars of [16, 20]) {
			const decisions = timedDecisions(cwd, `cat ${"*".repeat(stars)}Z`);
			assert.notEqual(decisions, "timeout", `${stars} stars: the decision did not finish in 10 s`);
			for (const [k, mode] of ["default", "auto", "plan"].entries()) {
				const d = (decisions as Array<{ action: string; ms: number }>)[k];
				assert.equal(d.action, "ask", `${stars} stars in ${mode}`);
				assert.ok(d.ms < 200, `${stars} stars in ${mode} took ${d.ms.toFixed(0)} ms`);
			}
		}
	});
});

test("a glob with up to 8 stars still expands and matches as before", () => {
	withProject((cwd) => {
		mkdirSync(join(cwd, "src", "deep"), { recursive: true });
		writeFileSync(join(cwd, "src", "deep", "c.py"), "x");
		writeFileSync(join(cwd, "src", "deep", "id_rsa"), "k");
		assert.equal(isSecretCommand("cat src/**/*.py", { cwd }), false);
		assert.equal(isSecretCommand("cat src/**/id_*", { cwd }), true, "a secret one level down is still matched");
		assert.equal(action(cwd, "cat src/**/id_*"), "ask");
		assert.equal(action(cwd, "cat src/*.py"), "ask", "the link under src leads out of the project");
		assert.equal(isSecretCommand("cat ******** ", { cwd }), false, "eight stars, nothing secret");
	});
});

test("a quoted word with many stars is a literal, not a glob: it decides as before; an unquoted one asks fast", () => {
	withProject((cwd) => {
		// quoted: the shell passes the pattern through, so the star cap does not apply (0.1.0: allow)
		assert.equal(action(cwd, "rg 'a*b*c*d*e*f*g*h*i*' ."), "allow");
		assert.equal(action(cwd, "rg 'a*b*c*d*e*f*g*h*' ."), "allow", "8 stars, quoted");
		// unquoted: the shell expands it, so it asks without building the regex
		const decisions = timedDecisions(cwd, `cat ${"*".repeat(9)}Z`);
		assert.notEqual(decisions, "timeout");
		for (const [k, mode] of ["default", "auto", "plan"].entries()) {
			const d = (decisions as Array<{ action: string; ms: number }>)[k];
			assert.equal(d.action, "ask", `9 unquoted stars in ${mode}`);
			assert.ok(d.ms < 200, `9 unquoted stars in ${mode} took ${d.ms.toFixed(0)} ms`);
		}
	});
});

test("cat conf/* asks in every mode when conf/ holds an id_rsa (the 0.1.0 changelog case)", () => {
	withProject((cwd) => {
		for (const mode of ["default", "auto", "plan"] as const) {
			const decided = evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: "bash", input: { command: "cat conf/*" } }, { cwd, remembered: [] }).action;
			assert.equal(decided, "ask", `cat conf/* in ${mode}`);
		}
		assert.equal(isSecretCommand("cat conf/*", { cwd }), true);
	});
});
