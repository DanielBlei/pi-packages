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
		[`python3 - <<'EOF' > out.txt\nprint(1)\nEOF`, PROBLEMS.pyHeredocWords],
	];
	for (const [command, problem] of cases) {
		for (const mode of ["default", "plan"] as const) assert.equal(decide(mode, command).action, "ask", `${mode}: ${command}`);
		assert.equal(expandCommand(command, { cwd, scratch, env: process.env }).problem, problem, command);
	}
	// no problem, still asks: a module, a script file, a wrapper, a prefix assignment
	for (const command of ["python3 -m json.tool a.json", "python3 x.py", "env python3 -c 'print(1)'", "PYTHONPATH=src python3 -c 'print(1)'"]) {
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
	const commands = [HEREDOC, ONE_LINER, CAT_PIPE, `${HEREDOC} 2>&1`, `${ONE_LINER} 2>&1`, "python -c 'print(1)'", "ls | python3 -c 'print(1)'", `python3 -c '${UTF7}'`, `python3 -c 'print(open("/etc/hosts").read())'`, `python3 -c 'print(open(".env").read())'`, `python3 -c 'import requests'`, `cd src && ${ONE_LINER}`, `python3 -c "print(1)"`, `python3 -c 'open("src/o", "w").write("x")'`, "python3 x.py"];
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

// ---- the other ways models run inline python (cat-pipe, flags, interpreters, tails) ---------------

const LISTING = ["import os", 'print("=== Files and Directories ===")', "for item in sorted(os.listdir('.')):", "    path = os.path.join('.', item)", "    if os.path.isdir(path):", '        print(f"DIRECTORY:  {item}/")', "    else:", '        print(f"FILE:       {item}")', ""].join("\n");
const CAT_PIPE = `cat << 'EOF' | python3\n${LISTING}EOF`;
const bodyOf = (head: string, script = LISTING) => `${head}\n${script}EOF`;
const UTF7 = "# coding: utf-7\nimport os\nos.system('id')";
const run = (command: string) => expandCommand(command, { cwd, scratch, env: process.env });

// a clean dir: no secret file, so a listing of "." is a plain read
const clean = join(root, "clean");
before(() => {
	mkdirSync(join(clean, "sub"), { recursive: true });
	writeFileSync(join(clean, "a.txt"), "x\n");
	writeFileSync(join(clean, "b.json"), "{}\n");
});

test("ACCEPTANCE: the directory listing through cat | python3 is allowed, and asks with a .env", { skip }, () => {
	for (const mode of modes) {
		assert.deepEqual(decide(mode, CAT_PIPE, { cwd: clean }), { action: "allow", rule: "readOnlyBash" }, mode);
		assert.deepEqual(decide(mode, CAT_PIPE), { action: "ask", rule: "secretBash" }, `${mode} with .env`);
	}
});

test("the cat-pipe and heredoc forms: operator spellings, flags, interpreter names", { skip }, () => {
	const heads = [
		"cat << 'EOF' | python3", "cat <<'EOF' | python3", 'cat <<"EOF" | python3', "cat <<'EOF' | python3 -", "cat <<'EOF' | python3 -u", "cat <<'EOF' | python3 -I",
		"cat <<'EOF' | python3 -uB -", "python3 - << 'EOF'", 'python3 - <<"EOF"', "python3 - <<'EOF'", "python3 -u - <<'EOF'", "python3 -I - <<'EOF'", "python3 -I -S - <<'EOF'",
		"python3 <<'EOF'", "cat <<'EOF' | python3.12", "python3.12 - <<'EOF'",
	];
	const extra: string[] = [];
	for (const name of ["python", "/usr/bin/python3", "/usr/bin/python"]) {
		if (spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0) extra.push(`cat <<'EOF' | ${name}`, `${name} - <<'EOF'`, `${name} -c 'print(1)'`);
	}
	for (const head of [...heads, ...extra]) {
		const command = head.includes("-c '") ? head : bodyOf(head);
		if (/python3\.12/.test(command) && spawnSync("python3.12", ["--version"], { stdio: "ignore" }).status !== 0) continue;
		for (const mode of modes) {
			assert.deepEqual(decide(mode, command, { cwd: clean }), { action: "allow", rule: "readOnlyBash" }, `${mode}: ${head}`);
			if (!head.includes("-c '")) assert.equal(decide(mode, command).action, "ask", `${mode} with .env: ${head}`);
		}
	}
});

test("tails after the heredoc operator are judged with the effect program", { skip }, () => {
	for (const head of ["python3 - <<'EOF'", "cat <<'EOF' | python3"]) {
		for (const tail of [" 2>&1", " 2>/dev/null", " | head -20", " && echo done", " 2>&1 | head -20", " | sort | uniq -c", " || echo failed", " ; echo done"]) {
			const command = bodyOf(head + tail);
			for (const mode of modes) assert.equal(decide(mode, command, { cwd: clean }).action, "allow", `${mode}: ${head}${tail}`);
		}
	}
	assert.equal(run(bodyOf("python3 - <<'EOF' 2>&1", "print(1)\n")).text, "true 2>&1");
	assert.equal(run(`python3 -c 'print(1)' 2>/dev/null && echo done`).text, "true 2>/dev/null && echo done");
});

test("python output piped into another program keeps asking", { skip }, () => {
	const asks = [
		`python3 -c 'print("ls")' | sh`, `python3 -c 'print(1)' | python3`, bodyOf("python3 - <<'EOF' | sh", "print('ls')\n"), bodyOf("python3 - <<'EOF' | python3", "print('ls')\n"),
		bodyOf("cat <<'EOF' | python3 | sh", "print('ls')\n"), bodyOf("python3 - <<'EOF' | bash -s", "print('ls')\n"), bodyOf("python3 - <<'EOF' | xargs rm", "print('a')\n"),
	];
	for (const command of asks) for (const mode of modes) assert.notEqual(decide(mode, command, { cwd: clean }).action, "allow", `${mode}: ${command}`);
});

test("a coding cookie or BOM is refused for -c, heredoc and cat-pipe", { skip }, () => {
	const commands = [`python3 -c '${UTF7}'`, bodyOf("python3 - <<'EOF'", UTF7 + "\n"), bodyOf("cat <<'EOF' | python3", UTF7 + "\n"), bodyOf("python3 - <<'EOF'", "#!/usr/bin/python3\n# -*- coding: latin-1 -*-\nprint(1)\n"), bodyOf("python3 - <<'EOF'", "\ufeffprint(1)\n")];
	for (const command of commands) {
		for (const mode of modes) assert.equal(decide(mode, command, { cwd: clean }).action, "ask", `${mode}: ${command}`);
		assert.ok(run(command).problem, command);
	}
});

test("cat-pipe scripts that are not a plain read of the cwd ask", { skip }, () => {
	const head = "cat <<'EOF' | python3";
	const scripts: [string, string][] = [
		['print(open(".env").read())\n', "secretBash"],
		['print(open("/etc/passwd").read())\n', "outsideCwdRead"],
		["import requests\nprint(1)\n", ""],
		['import os\nos.system("id")\n', ""],
		['open("src/out.txt", "w").write("x")\n', ""],
		['open("/tmp/pk-out.txt", "w").write("x")\n', ""],
	];
	for (const [script, rule] of scripts) {
		for (const mode of modes) {
			const got = decide(mode, bodyOf(head, script), { cwd: clean });
			assert.equal(got.action, "ask", `${mode}: ${script}`);
			if (rule !== "") assert.equal(got.rule, rule, script);
		}
	}
});

test("shapes that must keep asking: interpreters, flags, producers, extra heredocs", { skip }, () => {
	const body = "print(1)\nEOF";
	const asks = [
		`python2 - <<'EOF'\n${body}`, `python2 -c 'print(1)'`, `pypy3 -c 'print(1)'`, `./python3 - <<'EOF'\n${body}`, `src/python3 -c 'print(1)'`, `${cwd}/python3 -c 'print(1)'`,
		`env python3 - <<'EOF'\n${body}`, `env python3 -c 'print(1)'`, `/usr/bin/../bin/python3 -c 'print(1)'`, `uv run python -c 'print(1)'`,
		`python3 -x - <<'EOF'\n${body}`, `python3 -i -c 'print(1)'`, `python3 -m json.tool a.json`, `python3 -m json.tool <<'EOF'\n{}\nEOF`, `python3 -uc 'print(1)'`, `python3 -W error -c 'print(1)'`,
		`python3 -X dev -c 'print(1)'`, `python3 -O -c 'print(1)'`, `python3 -- - <<'EOF'\n${body}`, `python3 - arg <<'EOF'\n${body}`,
		`ls | python3 -c 'print(1)'`, `echo x | python3`, `echo 'print(1)' | python3`, `printf 'print(1)' | python3 -`, `cat a.txt | python3`, `cat <<'EOF' | python3 -c 'print(1)'\n${body}`,
		`cat -n <<'EOF' | python3\n${body}`, `cat - <<'EOF' | python3\n${body}`, `cat <<'EOF' <a.txt | python3\n${body}`, `ls | cat <<'EOF' | python3\n${body}`, `\\cat <<'EOF' | python3\n${body}`,
		`cat <<-'EOF' | python3\n${body}`, `cat <<<'print(1)' | python3`, `python3 <<<'print(1)'`, `python3 < a.txt`, `python3 - <<'EOF' <evil.py\n${body}`, `cat <<'EOF' | python3 |& cat\n${body}`,
		`python3 - <<'EOF' &\n${body}`, `python3 - <<'EOF' | grep 'x'\n${body}`, `python3 - <<'EOF' | head \\\n${body}`, `cd src && cat <<'EOF' | python3\n${body}`,
		`python3 - <<'EOF'\nprint(1)\nEOF\npython3 - <<'EOF2'\nprint(2)\nEOF2 <<'EOF3'\nx\nEOF3`, `cat <<'A' <<'B' | python3\nprint(1)\nA\nprint(2)\nB`,
	];
	for (const command of asks) {
		for (const mode of modes) assert.equal(decide(mode, command, { cwd: clean }).action, "ask", `${mode}: ${command}`);
	}
});

test("a script reading two files is judged on every read, also with a tail", { skip }, () => {
	const two = ["from pathlib import Path", 'print(Path("a.txt").read_text())', 'print(Path("b.json").read_text())', ""].join("\n");
	const withEnv = ["from pathlib import Path", 'print(Path("a.txt").read_text())', 'print(Path(".env").read_text())', ""].join("\n");
	const expanded = run(bodyOf("python3 - <<'EOF' | head", two));
	assert.equal(expanded.text, "cat -- 'a.txt' 'b.json' | head");
	for (const head of ["python3 - <<'EOF' | head", "cat <<'EOF' | python3 | head", "cat <<'EOF' | python3 2>&1", "python3 - <<'EOF' && echo done"]) {
		for (const mode of modes) {
			assert.equal(decide(mode, bodyOf(head, two), { cwd: clean }).action, "allow", `${mode}: ${head}`);
			assert.deepEqual(decide(mode, bodyOf(head, withEnv)), { action: "ask", rule: "secretBash" }, `${mode}: ${head} with .env`);
		}
	}
});
