/**
 * Static python through `evaluate` (plan D6, phase 4b): the expander turns a whole-unit
 * `python3 -c '...'` or `python3 - <<'EOF'` into its effect program and the rules judge that.
 * Synthetic data only. Skipped when python3 is missing. Run: node --test tests/unit/python-wiring.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_RULES, MODES, type ModeName } from "../../extensions/modes.ts";
import { PROBLEMS, expandCommand } from "../../extensions/program.ts";
import { bashWhy, evaluate, type EvalContext } from "../../extensions/rules.ts";
import { createScratchDir } from "../../extensions/utils.ts";

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const skip = hasPython ? false : "python3 is not installed";

const AGENT_DIR = `${homedir()}/.pi/agent`;
const PLAN_FILE = `${AGENT_DIR}/plans/project-2026-10-04-120000-ab12.md`;
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-keeper-pywire-")));
const cwd = join(root, "proj");
const scratch = createScratchDir();
before(() => {
	mkdirSync(join(cwd, "data"), { recursive: true });
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "data", "a.json"), '{"x": [1, 2], "y": [3]}\n');
	writeFileSync(join(cwd, ".env"), "TOKEN=synthetic\n");
	mkdirSync(join(cwd, "plain"), { recursive: true });
	writeFileSync(join(cwd, "plain", "one.json"), "{}\n");
	writeFileSync(join(cwd, "plain", "two.json"), "{}\n");
	mkdirSync(join(cwd, "mixed"), { recursive: true });
	writeFileSync(join(cwd, "mixed", "one.json"), "{}\n");
	writeFileSync(join(cwd, "mixed", ".env"), "TOKEN=synthetic\n");
	mkdirSync(join(cwd, "linked"), { recursive: true });
	writeFileSync(join(cwd, "linked", "one.json"), "{}\n");
	symlinkSync("/etc", join(cwd, "linked", "etc.json"));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});

const ctxOf = (extra: Partial<EvalContext> = {}): EvalContext => ({ cwd, agentDir: AGENT_DIR, planFile: PLAN_FILE, remembered: [], scratchDir: scratch, ...extra });

function decide(mode: ModeName, command: string, extra: Partial<EvalContext> = {}) {
	const decision = evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: "bash", input: { command } }, ctxOf(extra));
	return { action: decision.action, rule: decision.rule?.match ?? "fallback" };
}

const AGENT_SCRIPT = ["import json", 'data = json.load(open("data/a.json"))', "for key, rows in data.items():", "    print(key, len(rows))", ""].join("\n");
const HEREDOC = `python3 - <<'PYEOF'\n${AGENT_SCRIPT}PYEOF`;
const ONE_LINER = `python3 -c 'import json; print(len(json.load(open("data/a.json"))))'`;

test("an agent-style read-only heredoc is allowed in default and plan", { skip }, () => {
	for (const mode of ["default", "plan"] as const) {
		const got = decide(mode, HEREDOC);
		assert.equal(got.action, "allow", mode);
		assert.equal(got.rule, "readOnlyBash", mode);
	}
	assert.equal(decide("auto", HEREDOC).action, "allow");
});

test("a read-only one-liner is allowed; a script with no effect is allowed", { skip }, () => {
	for (const mode of ["default", "plan"] as const) {
		assert.equal(decide(mode, ONE_LINER).action, "allow", mode);
		assert.equal(decide(mode, "python3 -c 'print(1)'").action, "allow", mode);
	}
});

test("the heredoc form also works inside a for loop and after another command", { skip }, () => {
	assert.equal(decide("default", `ls data && ${HEREDOC}`).action, "allow");
	assert.equal(decide("default", `for n in a b; do python3 -c 'print(open("data/a.json").read())'; done`).action, "allow");
	assert.equal(decide("default", `${HEREDOC}\nls data`).action, "allow");
});

test("a read outside the cwd asks with outsideCwdRead; a granted read allows", { skip }, () => {
	const script = `python3 -c 'print(open("/etc/hosts").read())'`;
	for (const mode of ["default", "plan"] as const) {
		const got = decide(mode, script);
		assert.equal(got.action, "ask", mode);
		assert.equal(got.rule, "outsideCwdRead", mode);
	}
	assert.equal(decide("default", script, { outsideReadsAllowed: true }).action, "allow");
});

test("a secret read asks with secretBash", { skip }, () => {
	for (const mode of ["default", "plan"] as const) {
		const got = decide(mode, `python3 -c 'print(open(".env").read())'`);
		assert.equal(got.action, "ask", mode);
		assert.equal(got.rule, "secretBash", mode);
	}
});

test("an unknown import asks and the dialog names the python problem", { skip }, () => {
	const command = `python3 -c 'import requests; print(1)'`;
	for (const mode of ["default", "plan"] as const) assert.equal(decide(mode, command).action, "ask", mode);
	const program = expandCommand(command, { cwd, scratch, env: process.env });
	assert.equal(program.changed, false);
	assert.match(program.problem ?? "", /import requests is not on the allow-list/);
	const why = bashWhy(command, ctxOf(), [{ label: "allowed for this session", prefixes: [], exact: [] }]);
	assert.match(why[0] as string, /^Why: python: import requests is not on the allow-list\./);
});

test("a write into the scratch dir is allowed; a write into src asks", { skip }, () => {
	const inScratch = `python3 -c 'open("${scratch}/out.txt", "w").write("x")'`;
	for (const mode of ["default", "plan"] as const) assert.equal(decide(mode, inScratch).action, "allow", mode);
	const inSrc = `python3 -c 'open("src/out.txt", "w").write("x")'`;
	for (const mode of ["default", "plan"] as const) assert.equal(decide(mode, inSrc).action, "ask", mode);
});

test("shapes outside the whole-unit form ask", { skip }, () => {
	const cases: [string, string | RegExp][] = [
		[`cd src && ${ONE_LINER}`, PROBLEMS.pyDir("cd")],
		[`cd src\n${ONE_LINER}`, PROBLEMS.pyDir("cd")],
		[`for f in a b; do ${ONE_LINER}; cd src; done`, PROBLEMS.pyDir("cd")],
		[`python3 -c "print(1)"`, PROBLEMS.pyDouble],
		[`ls | ${ONE_LINER}`, PROBLEMS.pyPipe],
		[`${ONE_LINER} a.txt`, PROBLEMS.pyArgv],
		[`${ONE_LINER} > out.txt`, PROBLEMS.pyArgv],
		[`${ONE_LINER} &`, PROBLEMS.pyBackground],
		[`python3 - <<EOF\nprint(1)\nEOF`, PROBLEMS.pyHeredoc],
		[`python3 - <<'EOF'\nprint(1)\n`, PROBLEMS.pyHeredocOpen],
		[`python3 - <<'EOF' | sort\nprint(1)\nEOF`, PROBLEMS.pyHeredoc],
	];
	for (const [command, problem] of cases) {
		for (const mode of ["default", "plan"] as const) assert.equal(decide(mode, command).action, "ask", `${mode}: ${command}`);
		assert.equal(expandCommand(command, { cwd, scratch, env: process.env }).problem, problem, command);
	}
	// today's answer, no problem: another interpreter name, a module, a script file, a wrapper, a prefix assignment
	for (const command of ["python -c 'print(1)'", "python3.11 -c 'print(1)'", "python3 -m json.tool a.json", "python3 x.py", "env python3 -c 'print(1)'", "PYTHONPATH=src python3 -c 'print(1)'"]) {
		const program = expandCommand(command, { cwd, scratch, env: process.env });
		assert.deepEqual(program, { text: command, changed: false }, command);
		assert.equal(decide("default", command).action, "ask", command);
	}
});

test("a non-python heredoc keeps its refusal, and python text inside a quote or comment is data", { skip }, () => {
	const quoted = `echo "python3 -c 'print(1)'"`;
	assert.deepEqual(expandCommand(quoted, { cwd, scratch, env: process.env }), { text: quoted, changed: false });
	const comment = "ls # python3 -c 'print(1)'";
	assert.deepEqual(expandCommand(comment, { cwd, scratch, env: process.env }), { text: comment, changed: false });
	const other = `x=a; cat <<EOF\nhi\nEOF`;
	assert.equal(expandCommand(other, { cwd, scratch, env: process.env }).problem, PROBLEMS.heredoc);
	const mixed = `cat <<'EOF'\nhi\nEOF\n${ONE_LINER}`;
	assert.equal(expandCommand(mixed, { cwd, scratch, env: process.env }).problem, PROBLEMS.heredoc);
});

test("the effect program format", { skip }, () => {
	const run = (command: string) => expandCommand(command, { cwd, scratch, env: process.env });
	assert.equal(run(ONE_LINER).text, "cat -- 'data/a.json'");
	assert.equal(run("python3 -c 'print(1)'").text, "true");
	assert.equal(run(`python3 -c 'import glob, os; print(glob.glob("data/*.json"), os.listdir("src"), open("data/a.json").read())'`).text, "cat -- 'data/a.json'; ls -- data/*.json 'src'");
	assert.equal(run(`python3 -c 'open("${scratch}/o", "w").write("x")'`).text, `touch -- '${scratch}/o'`);
	assert.equal(run(`${ONE_LINER} && echo done`).text, "cat -- 'data/a.json' && echo done");
});

test("auto keeps today's answer for every python shape", { skip }, () => {
	const commands = [HEREDOC, ONE_LINER, `python3 -c 'print(open("/etc/hosts").read())'`, `python3 -c 'print(open(".env").read())'`, `python3 -c 'import requests'`, `cd src && ${ONE_LINER}`, `python3 -c "print(1)"`, `python3 -c 'open("src/o", "w").write("x")'`, "python3 x.py"];
	for (const command of commands) {
		assert.deepEqual(decide("auto", command), { action: "allow", rule: "fallback" }, command);
	}
});

test("fix wave: environment leaks, unbounded loops and device reads keep the dialog", { skip }, () => {
	const leak = `import glob\nprint(("{0._" + "_globals__[os].environ}").format(glob.escape))\n`;
	const commands = [
		`python3 -c '${leak}'`,
		`python3 - <<'PYEOF'\n${leak}PYEOF`,
		`python3 -c 'while True: pass'`,
		`python3 -c 'x = "a" * 10**10'`,
		`python3 -c 'print(open("/dev/stdin").read())'`,
		`python3 -c 'print(open("/proc/self/fd/0").read())'`,
	];
	for (const command of commands) {
		for (const mode of ["default", "plan"] as const) assert.notEqual(decide(mode, command).action, "allow", `${mode}: ${command}`);
	}
	assert.equal(decide("default", `python3 -c 'print("{} {}".format(1, 2))'`).action, "allow");
});

// ---- loops over literal lists and listings, and the while switch -----------------------------

const py = (script: string) => `python3 - <<'PYEOF'\n${script}\nPYEOF`;
const modes = ["default", "plan"] as const;

test("loops that pick a file: proved ones are allowed", { skip }, () => {
	const passing = [
		['for n in ["a.json"]:', '    print(len(open("data/" + n).read()))'],
		["import glob", 'for f in sorted(glob.glob("plain/*.json")):', "    print(len(open(f).read()))"],
		["from pathlib import Path", 'for p in Path("plain").glob("*.json"):', "    print(p.read_text())"],
		["import os", 'for n in os.listdir("plain"):', '    print(n, os.path.getsize(os.path.join("plain", n)))'],
		["import glob", `for f in glob.glob("plain/*.json"):`, "    text = open(f).read().strip()", `    open("${scratch}/clean.txt", "w").write(text)`],
	];
	for (const lines of passing) {
		const command = py(lines.join("\n"));
		for (const mode of modes) assert.equal(decide(mode, command).action, "allow", `${mode}: ${lines.join(" / ")}`);
	}
});

test("loops that pick a file: what the pattern matches decides", { skip }, () => {
	const asks: [string[], string][] = [
		[["import glob", 'for f in glob.glob("mixed/.*"):', "    print(open(f).read())"], "secretBash"],
		[["import os", 'for n in os.listdir("mixed"):', '    print(open(os.path.join("mixed", n)).read())'], "secretBash"],
		[["from pathlib import Path", 'for p in Path("mixed").iterdir():', "    print(p.read_text())"], "secretBash"],
		[["import glob", 'for f in glob.glob("linked/*.json"):', "    print(open(f).read())"], "outsideCwdRead"],
	];
	for (const [lines, rule] of asks) {
		const command = py(lines.join("\n"));
		for (const mode of modes) assert.deepEqual(decide(mode, command), { action: "ask", rule }, `${mode}: ${lines.join(" / ")}`);
	}
	const refused: string[][] = [
		["from pathlib import Path", 'for p in Path("mixed").glob("?env"):', "    print(p.read_text())"],
		["from pathlib import Path", 'for p in Path("mixed").glob("[.]*"):', "    print(p.read_text())"],
		["from pathlib import Path", 'for p in Path("mixed").glob("[.]git-*"):', "    print(p.read_text())"],
		["import glob", 'for f in glob.glob("mixed/*/../../../../../../../*/*"):', "    print(open(f).read())"],
		["import glob", 'for f in glob.glob("../*"):', "    print(open(f).read())"],
		["from pathlib import Path", 'for p in Path("mixed").glob("*/../../.."):', "    print(p.read_text())"],
		["import os", 'for n in os.listdir("mixed"):', '    print(open(os.path.join("x/../mixed", n)).read())'],

		["import glob", 'for f in glob.glob("plain/*.json"):', '    open(f, "w").write("x")'],
		[`for n in [${Array.from({ length: 17 }, (_, i) => `"f${i}"`).join(", ")}]:`, '    print(open("plain/" + n).read())'],
		["from pathlib import Path", 'for p in Path("plain").rglob("*.json"):', "    print(p.read_text())"],
		["import glob", 'for f in glob.glob("plain/*", recursive=True):', "    print(open(f).read())"],
	];
	for (const lines of refused) {
		const command = py(lines.join("\n"));
		for (const mode of modes) assert.equal(decide(mode, command).action, "ask", `${mode}: ${lines.join(" / ")}`);
		assert.ok(expandCommand(command, { cwd, scratch, env: process.env }).problem, lines.join(" / "));
	}
});

test("pathlib glob with * still passes and is judged with its dot variant", { skip }, () => {
	const ok = py(["from pathlib import Path", 'for p in Path("plain").glob("*.json"):', "    print(p.read_text())"].join("\n"));
	for (const mode of modes) assert.equal(decide(mode, ok).action, "allow", mode);
	const bad = py(["from pathlib import Path", 'for p in Path("mixed").glob("*"):', "    print(p.read_text())"].join("\n"));
	for (const mode of modes) assert.deepEqual(decide(mode, bad), { action: "ask", rule: "secretBash" }, mode);
});

test("the effect program leaves patterns unquoted", { skip }, () => {
	const run = (script: string) => expandCommand(py(script), { cwd, scratch, env: process.env }).text;
	assert.equal(run('import glob\nfor f in glob.glob("plain/*.json"): print(open(f).read())'), "cat -- plain/*.json; ls -- plain/*.json");
	assert.equal(run('import os\nfor n in os.listdir("plain"): print(os.path.getsize("plain/" + n))'), "cat -- plain/*; ls -- 'plain'");
});

test("while: asks without the session option, runs with it, other rules still apply", { skip }, () => {
	const script = "n = 3\nwhile n:\n    n -= 1\nprint(n)";
	const command = py(script);
	for (const mode of modes) assert.equal(decide(mode, command).action, "ask", mode);
	assert.match(expandCommand(command, { cwd, scratch, env: process.env }).problem ?? "", /a `while` loop may not end or may fill memory, so it needs the session option/);
	const granted = expandCommand(command, { cwd, scratch, env: process.env, pythonWhile: true });
	assert.deepEqual(granted, { text: "true", changed: true });
	const pow = expandCommand(py("n = 3\nwhile n:\n    n = n ** 2"), { cwd, scratch, env: process.env, pythonWhile: true });
	assert.equal(pow.changed, false);
	assert.match(pow.problem ?? "", /can run without end or fill memory/);
});
