/**
 * Tests for the static python analyzer. Synthetic scripts only. Run: npm test
 * The file is skipped when python3 is missing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePythonScript, PYTHON_PROBLEMS, type AnalyzeOptions } from "../../extensions/python.ts";

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const skip = hasPython ? false : "python3 is not installed";

const root = mkdtempSync(join(tmpdir(), "pi-keeper-pytest-"));
const runDir = join(root, "run");
const scratch = join(root, "scratch");
mkdirSync(runDir);
mkdirSync(scratch);
mkdirSync(join(runDir, "data"));
after(() => rmSync(root, { recursive: true, force: true }));

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const opts = (extra: Partial<AnalyzeOptions> = {}): AnalyzeOptions => ({ runDir, scratch, env, ...extra });
const src = (...lines: string[]) => lines.join("\n") + "\n";

function pass(script: string, extra: Partial<AnalyzeOptions> = {}) {
	const verdict = analyzePythonScript(script, opts(extra));
	assert.ok(verdict.ok, verdict.ok ? "" : verdict.problem);
	return verdict;
}
function refuse(script: string, problem: string, extra: Partial<AnalyzeOptions> = {}) {
	const verdict = analyzePythonScript(script, opts(extra));
	assert.ok(!verdict.ok, "expected a problem");
	if (!verdict.ok) assert.equal(verdict.problem, problem);
}

// ---- scripts an agent would write ------------------------------------------------------

test("for loop over json.load(open(...)) printing counts", { skip }, () => {
	const v = pass(
		src(
			"import json",
			'data = json.load(open("data/a.json"))',
			"for key, rows in data.items():",
			'    print(key, len(rows))',
		),
	);
	assert.deepEqual(v.effects, { reads: ["data/a.json"], lists: [], writes: [] });
	assert.deepEqual(v.imports, ["json"]);
});

test("with open + for line + re.search + print", { skip }, () => {
	const v = pass(
		src(
			"import re",
			'with open("logs/app.log") as fh:',
			"    for line in fh:",
			'        if re.search("ERROR", line):',
			"            print(line.strip())",
		),
	);
	assert.deepEqual(v.effects, { reads: ["logs/app.log"], lists: [], writes: [] });
});

test("Counter over csv.DictReader rows with f-string prints", { skip }, () => {
	const v = pass(
		src(
			"import csv",
			"from collections import Counter",
			'with open("data/rows.csv", newline="") as fh:',
			'    counts = Counter(row["kind"] for row in csv.DictReader(fh))',
			"for kind, n in counts.most_common():",
			'    print(f"{kind}: {n}")',
		),
	);
	assert.deepEqual(v.effects, { reads: ["data/rows.csv"], lists: [], writes: [] });
	assert.deepEqual(v.imports, ["collections", "csv"]);
});

test("sorted with a lambda key", { skip }, () => {
	const v = pass(src('rows = [{"n": 3}, {"n": 1}]', 'for r in sorted(rows, key=lambda r: r["n"]):', '    print(r["n"])'));
	assert.deepEqual(v.effects, { reads: [], lists: [], writes: [] });
});

test("glob.glob lists a literal pattern", { skip }, () => {
	const v = pass(src("import glob", 'names = glob.glob("data/*.json")', "print(len(names))"));
	assert.deepEqual(v.effects, { reads: [], lists: ["data/*.json"], writes: [] });
});

test("pathlib read_text", { skip }, () => {
	const v = pass(src("from pathlib import Path", 'lines = Path("README.md").read_text().splitlines()', "print(len(lines))"));
	assert.deepEqual(v.effects, { reads: ["README.md"], lists: [], writes: [] });
});

test("pathlib glob and iterdir list", { skip }, () => {
	const v = pass(
		src(
			"from pathlib import Path",
			'base = Path("data")',
			'print(len(list(base.glob("*.json"))))',
			"print(len(list(base.iterdir())))",
		),
	);
	assert.deepEqual(v.effects, { reads: [], lists: ["data/*.json", "data"], writes: [] });
});

test("a summary written into the scratch dir", { skip }, () => {
	const out = `${scratch}/out.txt`;
	const v = pass(src("total = 3", `with open("${out}", "w") as out:`, '    out.write(f"total={total}\\n")', '    print("done", file=out)'));
	assert.deepEqual(v.effects, { reads: [], lists: [], writes: [out] });
});

test("literals fold through variables, concatenation, f-strings and os.path.join", { skip }, () => {
	const v = pass(
		src(
			"import os",
			'SRC = "data"',
			'NAME = "a"',
			'one = open(SRC + "/" + NAME + ".json")',
			'two = open(f"{SRC}/b.json")',
			'three = open(os.path.join(SRC, "c.json"))',
			"print(os.path.basename(SRC))",
		),
	);
	assert.deepEqual(v.effects.reads, ["data/a.json", "data/b.json", "data/c.json"]);
});

test("csv.writer and json.dump into the scratch dir", { skip }, () => {
	const v = pass(
		src(
			"import csv, json",
			`with open("${scratch}/o.csv", "w", newline="") as fh:`,
			"    w = csv.writer(fh)",
			'    w.writerow(["a", 1])',
			`with open("${scratch}/o.json", "w") as fj:`,
			"    json.dump({}, fj)",
		),
	);
	assert.deepEqual(v.effects.writes, [`${scratch}/o.csv`, `${scratch}/o.json`]);
});

test("verdicts are cached and stay equal", { skip }, () => {
	const script = src("import json", 'print(json.dumps({"a": 1}))');
	assert.deepEqual(pass(script), pass(script));
});

// ---- near-misses -----------------------------------------------------------------------

test("unknown imports", { skip }, () => {
	refuse(src("import requests"), PYTHON_PROBLEMS.unknownImport("requests"));
	refuse(src("import pandas as pd"), PYTHON_PROBLEMS.unknownImport("pandas"));
	refuse(src("import subprocess"), PYTHON_PROBLEMS.unknownImport("subprocess"));
refuse(src("import importlib"), PYTHON_PROBLEMS.unknownImport("importlib"));
	refuse(src("from subprocess import run"), PYTHON_PROBLEMS.unknownImport("subprocess"));
	refuse(src("from os import *"), PYTHON_PROBLEMS.starImport("os"));
	refuse(src("from os import system"), PYTHON_PROBLEMS.unknownAttribute("os.system"));
});

test("os and sys attributes off the allow-list", { skip }, () => {
	refuse(src("import os", 'os.system("ls")'), PYTHON_PROBLEMS.unknownAttribute("os.system"));
	refuse(src("import os", "print(os.environ)"), PYTHON_PROBLEMS.unknownAttribute("os.environ"));
	refuse(src("import os", 'print(os.getenv("HOME"))'), PYTHON_PROBLEMS.unknownAttribute("os.getenv"));
	refuse(src("import sys", "print(sys.argv)"), PYTHON_PROBLEMS.unknownAttribute("sys.argv"));
	refuse(src("import sys", "print(sys.stdin.read())"), PYTHON_PROBLEMS.unknownAttribute("sys.stdin"));
	refuse(src("import time", "time.sleep(1)"), PYTHON_PROBLEMS.unknownAttribute("time.sleep"));
});

test("a path from a loop is not a literal", { skip }, () => {
	refuse(src("names = input_names()", "for name in names:", "    print(open(name).read())"), PYTHON_PROBLEMS.notAllowed("input_names"));
	refuse(src("for name, n in [('a', 1)]:", "    print(open(name).read())"), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src("import os", 'for name in os.listdir("data"):', "    print(open(name).read())"), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src("def f(p):", "    return open(p).read()", 'print(f("a.txt"))'), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src('p = "a"', 'p = "b"', "print(open(p).read())"), PYTHON_PROBLEMS.pathNotLiteral("open"));
});

test("open: writes outside scratch, odd modes, file descriptors", { skip }, () => {
	refuse(src('open("x.txt", "w").write("a")'), PYTHON_PROBLEMS.writeOutsideScratch("x.txt"));
	refuse(src(`open("${scratch}/../x.txt", "w").write("a")`), PYTHON_PROBLEMS.writeOutsideScratch(`${scratch}/../x.txt`));
	refuse(src('open("a.txt", "r+")'), PYTHON_PROBLEMS.openMode("r+"));
	refuse(src('open("a.txt", "w+")'), PYTHON_PROBLEMS.openMode("w+"));
	refuse(src("open(0)"), PYTHON_PROBLEMS.openFd());
	refuse(src("x = open", 'print(x("a"))'), PYTHON_PROBLEMS.effectRef("open"));
	refuse(src('open("a.txt", "w")'), PYTHON_PROBLEMS.writeOutsideScratch("a.txt"), { scratch: undefined });
});

test("write needs a scratch handle", { skip }, () => {
	refuse(src('fh = open("a.txt")', 'fh.write("x")'), PYTHON_PROBLEMS.writeHandle("write"));
});

test("eval, __import__, getattr, input", { skip }, () => {
	refuse(src('eval("1")'), PYTHON_PROBLEMS.forbiddenName("eval"));
	refuse(src('__import__("os")'), PYTHON_PROBLEMS.dunder("__import__"));
	refuse(src('getattr(str, "upper")'), PYTHON_PROBLEMS.forbiddenName("getattr"));
	refuse(src("input()"), PYTHON_PROBLEMS.forbiddenName("input"));
	refuse(src("x = [].__class__"), PYTHON_PROBLEMS.dunder("__class__"));
});

test("methods off the allow-list", { skip }, () => {
	refuse(src("rows = []", 'rows.to_csv("o.csv")'), PYTHON_PROBLEMS.unknownMethod("to_csv"));
	refuse(src("rows = []", "rows.remove(1)"), PYTHON_PROBLEMS.unknownMethod("remove"));
	refuse(src("from pathlib import Path", 'Path("a").unlink()'), PYTHON_PROBLEMS.unknownMethod("unlink"));
	refuse(src("from pathlib import Path", 'Path("a").rename("b")'), PYTHON_PROBLEMS.unknownMethod("rename"));
	refuse(src("from pathlib import Path", 'Path("a").replace("b")'), PYTHON_PROBLEMS.unknownMethod("replace"));
	refuse(src("from pathlib import Path", 'Path("a").write_text("b")'), PYTHON_PROBLEMS.unknownMethod("write_text"));
});

test("recursion", { skip }, () => {
	refuse(src("import os", 'for r, d, f in os.walk("."):', "    print(r)"), PYTHON_PROBLEMS.recursion("os.walk"));
	refuse(src("from pathlib import Path", 'print(list(Path(".").rglob("*")))'), PYTHON_PROBLEMS.recursion("rglob"));
	refuse(src("import glob", 'glob.glob("data/**/*.json")'), PYTHON_PROBLEMS.recursion("data/**/*.json"));
	refuse(src("import glob", 'glob.glob("data/*.json", recursive=True)'), PYTHON_PROBLEMS.recursion("glob.glob recursive"));
});

test("stdin and argv paths", { skip }, () => {
	refuse(src("import sys", "print(sys.stdin.read())"), PYTHON_PROBLEMS.unknownAttribute("sys.stdin"));
	refuse(src("name = input()", "print(open(name).read())"), PYTHON_PROBLEMS.forbiddenName("input"));
});

test("rebinding and module values", { skip }, () => {
	refuse(src("open = print"), PYTHON_PROBLEMS.rebinding("open"));
	refuse(src("import os", "o = os", 'o.system("ls")'), PYTHON_PROBLEMS.moduleValue("os"));
	refuse(src("import os", "os.path = None"), PYTHON_PROBLEMS.attrStore("path"));
	refuse(src("import json", "json = 1"), PYTHON_PROBLEMS.rebinding("json"));
});

test("syntax outside the allow-list", { skip }, () => {
	refuse(src("class A:", "    pass"), PYTHON_PROBLEMS.unsupportedSyntax("ClassDef"));
	refuse(src("global x"), PYTHON_PROBLEMS.unsupportedSyntax("Global"));
	refuse(src("print(**{})"), PYTHON_PROBLEMS.kwSplat());
});

test("a syntax error", { skip }, () => {
	const v = analyzePythonScript("def (:\n", opts());
	assert.ok(!v.ok);
	if (!v.ok) assert.match(v.problem, /^python: syntax error: /);
});

// ---- environment -----------------------------------------------------------------------

test("PYTHONPATH in env", { skip }, () => {
	refuse(src("print(1)"), PYTHON_PROBLEMS.pythonEnv("PYTHONPATH"), { env: { ...env, PYTHONPATH: "/tmp/x" } });
	refuse(src("print(1)"), PYTHON_PROBLEMS.pythonEnv("PYTHONSTARTUP"), { env: { ...env, PYTHONSTARTUP: undefined } });
});

test("runDir equal to or inside scratch", { skip }, () => {
	refuse(src("print(1)"), PYTHON_PROBLEMS.scratchRun(), { runDir: scratch });
	refuse(src("print(1)"), PYTHON_PROBLEMS.scratchRun(), { runDir: join(scratch, "sub") });
});

test("a module shadowed in runDir", { skip }, () => {
	const dir = mkdtempSync(join(root, "shadow-"));
	const script = src("import json", "print(json.dumps(1))");
	pass(script, { runDir: dir });
	writeFileSync(join(dir, "json.py"), "");
	refuse(script, PYTHON_PROBLEMS.shadow("json.py"), { runDir: dir });
	rmSync(join(dir, "json.py"));
	mkdirSync(join(dir, "re"));
	refuse(script, PYTHON_PROBLEMS.shadow("re"), { runDir: dir });
	rmSync(join(dir, "re"), { recursive: true });
	writeFileSync(join(dir, "json.cpython-312-x86_64-linux-gnu.so"), "");
	refuse(script, PYTHON_PROBLEMS.shadow("json.cpython-312-x86_64-linux-gnu.so"), { runDir: dir });
});

test("stdlib-named folders that the run does not import are fine", { skip }, () => {
	const dir = mkdtempSync(join(root, "folders-"));
	mkdirSync(join(dir, "test"));
	mkdirSync(join(dir, "code"));
	pass(src("import json, csv, re", "print(re.escape(json.dumps(1)))"), { runDir: dir });
});

test("a transitive import is shadowed too", { skip }, () => {
	const dir = mkdtempSync(join(root, "transitive-"));
	const script = src("import json", "print(json.dumps(1))");
	writeFileSync(join(dir, "re.py"), "");
	refuse(script, PYTHON_PROBLEMS.shadow("re.py"), { runDir: dir });
	rmSync(join(dir, "re.py"));
	writeFileSync(join(dir, "codecs.py"), "");
	refuse(script, PYTHON_PROBLEMS.shadow("codecs.py"), { runDir: dir });
});

test("sitecustomize in the run dir refuses any script", { skip }, () => {
	const dir = mkdtempSync(join(root, "site-"));
	writeFileSync(join(dir, "sitecustomize.py"), "");
	refuse(src("print(1)"), PYTHON_PROBLEMS.shadow("sitecustomize.py"), { runDir: dir });
});

test("types.py refuses a script whose imports load types", { skip }, () => {
	const dir = mkdtempSync(join(root, "types-"));
	writeFileSync(join(dir, "types.py"), "");
	refuse(src("import functools", "print(functools.reduce(max, [1]))"), PYTHON_PROBLEMS.shadow("types.py"), { runDir: dir });
});

test("an unrelated stdlib-named file does not refuse", { skip }, () => {
	const dir = mkdtempSync(join(root, "unrelated-"));
	writeFileSync(join(dir, "turtle.py"), "");
	pass(src("print(1)"), { runDir: dir });
});

test("a missing interpreter", () => {
	refuse(src("print(1)"), PYTHON_PROBLEMS.noInterpreter("/nonexistent/python3"), { python: "/nonexistent/python3" });
	refuse(src("print(1)"), PYTHON_PROBLEMS.noInterpreter("python3"), { env: { PATH: "/nonexistent" } });
});

// ---- fix wave: format strings, unbounded work, device paths ---------------------------------

const FMT = PYTHON_PROBLEMS.formatString;

test("str.format cannot reach attributes: near-misses", { skip }, () => {
	const leak = '("{0._" + "_globals__[os].environ}")';
	refuse(src("import glob", `print(${leak}.format(glob.escape))`), FMT("format on a non-literal"));
	refuse(src("import glob", `s = ${leak}`, "print(s.format(glob.escape))"), FMT("format on a non-literal"));
	refuse(src("import glob", `print(("{0._" + "_globals__[os].environ}").format(glob.escape))`), FMT("format on a non-literal"));
	refuse(src('print("{0.real}".format(1))'), FMT("format"));
	refuse(src('print("{0[0]}".format([1]))'), FMT("format"));
	refuse(src('print("{!a}".format(1))'), FMT("format"));
	refuse(src('print("{:{0.real}}".format(1))'), FMT("format"));
	refuse(src('print("{".format(1))'), FMT("format"));
	refuse(src('print("{x}".format_map({"x": 1}))'), FMT("format_map"));
	refuse(src('f = "{0.real}".format', "print(f(1))"), FMT(".format used as a value"));
	refuse(src('print(list(map("{0.real}".format, [1])))'), FMT(".format used as a value"));
	refuse(src('print(str.format("{0.real}", 1))'), FMT("format on a non-literal"));
	refuse(src('print(f"{1:{2}}")'), FMT("an f-string with a computed format spec"));
	refuse(src("w = 5", 'print(f"{w:>{w}}")'), FMT("an f-string with a computed format spec"));
	refuse(src('print(format(1, "x" + "y"))'), FMT("format() with a spec that is not a literal"));
	refuse(src("print(list(map(format, [1])))"), FMT("format used as a value"));
	refuse(src('print("%(a.b)s" % {"a.b": 1})'), FMT("% formatting"));
	refuse(src('s = "%s" + "%d"', "print(s % (1, 2))"), FMT("% formatting on a non-literal"));
	refuse(src('print(("%s" + "x") % 1)'), FMT("% formatting on a non-literal"));
	refuse(src("from string import Template"), PYTHON_PROBLEMS.unknownAttribute("string.Template"));
	refuse(src("import string", 'print(string.Formatter().format("{0.real}", 1))'), FMT("format on a non-literal"));
	refuse(src("import string", "f = string.Formatter"), PYTHON_PROBLEMS.unknownAttribute("string.Formatter"));
});

test("plain formatting stays allowed", { skip }, () => {
	pass(src("a = 1", "b = 2", 'print("{} {}".format(a, b))'));
	pass(src('n = "x"', 'print("{name:>10}".format(name=n))'));
	pass(src("x = 1", 'print(f"{x:>10}")'));
	pass(src("a = 1", "b = 2", 'print("%s %d" % (a, b))'));
	pass(src("print(7 % 3)", 'print("{!r} {!s}".format(1, 2))', 'print(format(3.14159, ".2f"))', 'print("%(k)s" % {"k": 1})'));
});

test("work that may not end or may fill memory: near-misses", { skip }, () => {
	refuse(src("while True:", "    pass"), PYTHON_PROBLEMS.whileNeedsGrant());
	refuse(src("n = 3", "while n:", "    n -= 1"), PYTHON_PROBLEMS.whileNeedsGrant());
	refuse(src("import itertools", "for i in itertools.count():", "    print(i)"), PYTHON_PROBLEMS.unbounded("itertools.count"));
	refuse(src("import itertools as it", "print(it.cycle([1]))"), PYTHON_PROBLEMS.unbounded("itertools.cycle"));
	refuse(src("import itertools", "print(itertools.repeat(1, 2))"), PYTHON_PROBLEMS.unbounded("itertools.repeat"));
	refuse(src("from itertools import count"), PYTHON_PROBLEMS.unbounded("itertools.count"));
	refuse(src("x = 'a' * 10**10"), PYTHON_PROBLEMS.unbounded("a nested * expression"));
	refuse(src("print(2 ** 3)"), PYTHON_PROBLEMS.unbounded("**"));
	refuse(src("print(pow(2, 3))"), PYTHON_PROBLEMS.unbounded("pow"));
	refuse(src("x = 'a' * 10000000000"), PYTHON_PROBLEMS.unbounded("a repeat by 10000000000"));
	refuse(src("n = 5000000", "x = [0] * n"), PYTHON_PROBLEMS.unbounded("a repeat by 5000000"));
	refuse(src("a = 1", "print(a * 2 * 3)"), PYTHON_PROBLEMS.unbounded("a nested * expression"));
	refuse(src("x = 'a'", "x *= 10000000000"), PYTHON_PROBLEMS.unbounded("a repeat by 10000000000"));
});

test("huge int constants are refused anywhere", { skip }, () => {
	refuse(src("print(len(list(range(1000000000000))))"), PYTHON_PROBLEMS.unbounded("the number 1000000000000"));
	refuse(src('print("x".zfill(10000000000))'), PYTHON_PROBLEMS.unbounded("the number 10000000000"));
	refuse(src('print("x".ljust(10000000000))'), PYTHON_PROBLEMS.unbounded("the number 10000000000"));
	refuse(src('print("x".rjust(20000000))'), PYTHON_PROBLEMS.unbounded("the number 20000000"));
	refuse(src('n = 99999999999', 'print("x".center(n))'), PYTHON_PROBLEMS.unbounded("the number 99999999999"));
	pass(src("print(len(list(range(1000))))", 'print("x".zfill(8))', 'print("x".ljust(10000000))'));
});

test("bounded loops and small repeats stay allowed", { skip }, () => {
	pass(src("for i in range(10):", "    print(i)", "print('-' * 40)", "print(3 * 4)"));
});

test("device and proc paths are refused", { skip }, () => {
	for (const p of ["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0", "/dev/../dev/stdin", "//dev/stdin", "/proc/self/environ", "/dev"]) {
		refuse(src(`print(open("${p}").read())`), PYTHON_PROBLEMS.deviceRoot(p));
	}
	refuse(src("import os", 'print(os.listdir("/proc"))'), PYTHON_PROBLEMS.deviceRoot("/proc"));
	refuse(src("import glob", 'print(glob.glob("/dev/*"))'), PYTHON_PROBLEMS.deviceRoot("/dev/*"));
	refuse(src("import glob", 'print(glob.glob("/d*/stdin"))'), PYTHON_PROBLEMS.deviceRoot("/d*/stdin"));
	refuse(src("from pathlib import Path", 'print(Path("/proc/self/fd/0").read_text())'), PYTHON_PROBLEMS.deviceRoot("/proc/self/fd/0"));
	refuse(src(`print(open("${scratch}/../../../../../dev/stdin").read())`), PYTHON_PROBLEMS.deviceRoot(`${scratch}/../../../../../dev/stdin`), { runDir: "/dev" });
	refuse(src('print(open("fd/0").read())'), PYTHON_PROBLEMS.deviceRoot("fd/0"), { runDir: "/proc/self" });
	refuse(src('print(open("stdin").read())'), PYTHON_PROBLEMS.deviceRoot("stdin"), { runDir: "/dev" });
});

test("/dev/null and ordinary paths stay allowed", { skip }, () => {
	pass(src('print(open("/dev/null").read())'));
	pass(src('print(open("data/a.json").read())'));
});

// ---- loops over literal lists and listings, and the while switch --------------------------

test("a literal-list loop folds the path once per value", { skip }, () => {
	const v = pass(src('for name in ["a.txt", "b.txt", "a.txt"]:', '    print(open("data/" + name).read())'));
	assert.deepEqual(v.effects, { reads: ["data/a.txt", "data/b.txt"], lists: [], writes: [] });
	pass(src('names = ("x.csv", "y.csv")', "for n in sorted(names):", '    with open(f"data/{n}") as fh:', "        print(len(fh.read()))"));
	const w = pass(src('for n in ["a", "b"]:', '    open(f"{n}.out", "r")', '    open("' + scratch + '/o.txt", "w").write(n)'));
	assert.deepEqual(w.effects.writes, [scratch + "/o.txt"]);
	// a write path derived from the value must still be inside the scratch dir
	refuse(src('for n in ["a", "b"]:', '    open(n + ".out", "w").write("x")'), PYTHON_PROBLEMS.writeOutsideScratch("a.out"));
	const ok = pass(src('for n in ["a", "b"]:', `    open("${scratch}/" + n, "w").write("x")`));
	assert.deepEqual(ok.effects.writes, [`${scratch}/a`, `${scratch}/b`]);
	// a derived name inside the loop
	const d = pass(src('for n in ["a", "b"]:', '    p = "data/" + n', "    print(open(p).read())"));
	assert.deepEqual(d.effects.reads, ["data/a", "data/b"]);
});

test("a literal-list loop: limits and rebinding fall back to a non-literal path", { skip }, () => {
	const items = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify(`f${i}`)).join(", ");
	assert.equal(pass(src(`for n in [${items(16)}]:`, '    print(open("d/" + n).read())')).effects.reads.length, 16);
	refuse(src(`for n in [${items(17)}]:`, '    print(open("d/" + n).read())'), PYTHON_PROBLEMS.pathNotLiteral("open"));
	// 8 x 8 = 64 passes, 9 x 8 = 72 does not
	const nested = (a: number, b: number) => src(`for x in [${items(a)}]:`, `    for y in [${items(b)}]:`, '        print(open(x + "/" + y).read())');
	assert.equal(pass(nested(8, 8)).effects.reads.length, 64);
	refuse(nested(9, 8), PYTHON_PROBLEMS.pathNotLiteral("open"));
	// the name is rebound, or the list is mutated
	refuse(src('for n in ["a"]:', "    pass", 'n = "b"', 'print(open(n).read())'), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src('names = ["a", "b"]', 'names.append("../x")', "for n in names:", "    print(open(n).read())"), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src('names = ["a"]', 'names = ["b"]', "for n in names:", "    print(open(n).read())"), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src("for n in [1, 2]:", "    print(open(n).read())"), PYTHON_PROBLEMS.pathNotLiteral("open"));
});

test("listing loops fold to patterns", { skip }, () => {
	const g = pass(src("import glob", 'for f in sorted(glob.glob("data/*.json")):', "    print(open(f).read())"));
	assert.deepEqual(g.effects, { reads: [], lists: ["data/*.json"], writes: [], patterns: ["data/*.json"] });
	const l = pass(src("import os", 'for n in os.listdir("data"):', '    print(os.path.getsize(os.path.join("data", n)))'));
	assert.deepEqual(l.effects, { reads: [], lists: ["data"], writes: [], patterns: ["data/*", "data/.*"] });
	const l2 = pass(src("import os", 'for n in os.listdir("data"):', '    p = "data/" + n', "    if os.path.isfile(p):", "        print(open(p).read())"));
	assert.deepEqual(l2.effects.patterns, ["data/*", "data/.*"]);
	const pg = pass(src("from pathlib import Path", 'for p in Path("data").glob("*.json"):', "    print(p.read_text())"));
	assert.deepEqual(pg.effects.patterns, ["data/*.json", "data/.*.json"]);
	assert.deepEqual(pg.effects.lists, ["data/*.json"]);
	const it = pass(src("from pathlib import Path", 'for p in Path("data").iterdir():', "    print(open(p).read())"));
	assert.deepEqual(it.effects.patterns, ["data/*", "data/.*"]);
	const pd = pass(src("from pathlib import Path", "import os", 'for n in os.listdir("data"):', '    print((Path("data") / n).read_text())'));
	assert.deepEqual(pd.effects.patterns, ["data/*", "data/.*"]);
	const gp = pass(src("import glob", "from pathlib import Path", 'for f in glob.iglob("data/*.json"):', "    print(Path(f).read_text())"));
	assert.deepEqual(gp.effects.patterns, ["data/*.json"]);
	// a loop that only counts needs no pattern
	assert.equal(pass(src("import glob", 'for f in glob.glob("data/*"):', "    print(f)")).effects.patterns, undefined);
	// a write into scratch with a literal path inside such a loop
	const w = pass(src("import glob", 'for f in glob.glob("data/*.json"):', "    text = open(f).read().strip()", `    open("${scratch}/clean.txt", "w").write(text)`));
	assert.deepEqual(w.effects.writes, [`${scratch}/clean.txt`]);
});

test("listing loops: refusals", { skip }, () => {
	refuse(src("import glob", 'for f in glob.glob("data/*"):', `    open(f, "w").write("x")`), PYTHON_PROBLEMS.matchWrite());
	refuse(src("import glob", 'for f in glob.glob("data/*"):', `    open("${scratch}/" + f, "w").write("x")`), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src("from pathlib import Path", 'for p in Path("data").rglob("*"):', "    print(p.read_text())"), PYTHON_PROBLEMS.recursion("rglob"));
	refuse(src("import glob", 'for f in glob.glob("data/*", recursive=True):', "    print(open(f).read())"), PYTHON_PROBLEMS.recursion("glob.glob recursive"));
	refuse(src("import glob", 'for f in glob.glob("data/**/*.json"):', "    print(open(f).read())"), PYTHON_PROBLEMS.recursion("data/**/*.json"));
	refuse(src("import glob", 'for f in glob.glob("data/*.{json}"):', "    print(open(f).read())"), PYTHON_PROBLEMS.badPattern("data/*.{json}"));
	refuse(src("import glob", 'for f in glob.glob("data/[!a]*"):', "    print(open(f).read())"), PYTHON_PROBLEMS.badPattern("data/[!a]*"));
	// pathlib's ? and [..] match a leading dot: refused; * keeps its dot variant
	for (const g of ["?env", "[.]*", "[.]git-*", "a[0-9]/*", "x/?env"]) {
		refuse(src("from pathlib import Path", `for p in Path("data").glob("${g}"):`, "    print(p.read_text())"), PYTHON_PROBLEMS.badPattern(g));
	}
	assert.deepEqual(pass(src("from pathlib import Path", 'for p in Path("data").glob("*.json"):', "    print(p.read_text())")).effects.patterns, ["data/*.json", "data/.*.json"]);
	// a .. component escapes the directory: refused in every pattern and listing form
	const up = (lines: string[], bad: string) => refuse(src(...lines), PYTHON_PROBLEMS.badPattern(bad));
	up(["import glob", 'for f in glob.glob("d/*/../../../*/*"):', "    print(open(f).read())"], "d/*/../../../*/*");
	up(["import glob", 'for f in glob.glob("../*"):', "    print(open(f).read())"], "../*");
	up(["import glob", 'print(glob.glob("../*"))'], "../*");
	up(["from pathlib import Path", 'for p in Path("data").glob("*/../../.."):', "    print(p.read_text())"], "*/../../..");
	up(["import os", 'print(os.listdir(".."))'], "..");
	up(["from pathlib import Path", 'for p in Path("../x").iterdir():', "    print(p.read_text())"], "../x");
	// the base of a joined path is the exact listing directory
	refuse(src("import os", 'for n in os.listdir("data"):', '    print(open(os.path.join("x/../data", n)).read())'), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src("import os", 'for n in os.listdir("data"):', '    print(open("x/../data/" + n).read())'), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src("from pathlib import Path", "import os", 'for n in os.listdir("data"):', '    print((Path("x/../data") / n).read_text())'), PYTHON_PROBLEMS.pathNotLiteral("read_text"));
	up(["import os", 'for n in os.listdir("x/../data"):', '    print(open(os.path.join("x/../data", n)).read())'], "x/../data");
	// a listdir name outside its directory is no path
	refuse(src("import os", 'for n in os.listdir("data"):', "    print(open(n).read())"), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src("import os", 'for n in os.listdir("data"):', '    print(open(os.path.join("other", n)).read())'), PYTHON_PROBLEMS.pathNotLiteral("open"));
	refuse(src("import os", 'for n in os.listdir("data"):', "    print(os.listdir(n))"), PYTHON_PROBLEMS.pathNotLiteral("os.listdir"));
});

test("while: needs the grant, and the grant lifts only that", { skip }, () => {
	const loop = src("n = 3", "while n:", "    n -= 1", "print(n)");
	refuse(loop, PYTHON_PROBLEMS.whileNeedsGrant());
	assert.match(PYTHON_PROBLEMS.whileNeedsGrant(), /a `while` loop may not end or may fill memory, so it needs the session option/);
	pass(loop, { allowWhile: true });
	pass(src("while True:", "    break"), { allowWhile: true });
	// another problem wins over the while
	refuse(src("import requests", "while True:", "    break"), PYTHON_PROBLEMS.unknownImport("requests"));
	refuse(src("while True:", "    break", "import requests"), PYTHON_PROBLEMS.unknownImport("requests"));
	refuse(src("while True:", "    x = 2 ** 3"), PYTHON_PROBLEMS.unbounded("**"));
	// every other rule still applies with the grant
	refuse(loop.replace("n -= 1", "n = n ** 2"), PYTHON_PROBLEMS.unbounded("**"), { allowWhile: true });
	refuse(src("while True:", '    print(open("x.txt", "w"))'), PYTHON_PROBLEMS.writeOutsideScratch("x.txt"), { allowWhile: true });
	refuse(src("while True:", "    print(open(name).read())"), PYTHON_PROBLEMS.pathNotLiteral("open"), { allowWhile: true });
	refuse(src("x = 'a' * 10000000000", "while True:", "    break"), PYTHON_PROBLEMS.unbounded("a repeat by 10000000000"), { allowWhile: true });
	// the cache does not mix the two answers
	refuse(loop, PYTHON_PROBLEMS.whileNeedsGrant());
});

// ---- PEP 263 coding cookies and BOMs ---------------------------------------------------

const COOKIE = PYTHON_PROBLEMS.codingCookie();

test("a coding cookie or BOM is refused, whatever the line ends", { skip }, () => {
	const exploit = '# coding: utf-7\nACM=0\nx=1 +ACM- 1;import os;os.system("touch pwned.txt")\n';
	refuse(exploit, COOKIE);
	refuse("print(1)\n# coding: utf-7\nprint(2)\n", COOKIE);
	refuse("# coding: utf-8\nprint(1)\n", COOKIE);
	refuse("# coding=latin-1\nprint(1)\n", COOKIE);
	refuse("# -*- coding: utf-7 -*-\nprint(1)\n", COOKIE);
	refuse("# vim: set fileencoding=utf-7 :\nprint(1)\n", COOKIE);
	refuse("\f# coding: utf-7\nprint(1)\n", COOKIE);
	refuse("# coding: utf-7\rprint(1)\r", COOKIE);
	refuse("print(1)\r# coding: utf-7\rprint(2)\r", COOKIE);
	refuse("print(1)\r\n# coding: utf-7\r\nprint(2)\r\n", COOKIE);
	refuse("﻿print(1)\n", COOKIE);
	refuse("￾print(1)\n", COOKIE);
});

test("the word coding after line 2 is fine", { skip }, () => {
	pass(src("print(1)", "print(2)", "# coding: utf-7 is only a word here", "print(3)"));
	pass(src("print(1)", "x = 'coding: utf-7'", "print(x)"));
});

// ---- interpreter checks ----------------------------------------------------------------

const realPython = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
const bin = join(root, "bin");
mkdirSync(bin);
function fake(dir: string, name: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}
const wrapper = (dir: string, name: string) => fake(dir, name, `exec ${realPython} "$@"`);
const unsafe = (p: string) => PYTHON_PROBLEMS.unsafeInterpreter(p);

test("an interpreter inside runDir or scratch is refused", { skip }, () => {
	const inRun = wrapper(runDir, "py-in-run");
	const inScratch = wrapper(scratch, "py-in-scratch");
	for (const p of [inRun, inScratch]) refuse("print(1)\n", unsafe(p), { python: p });
});

test("an absolute interpreter path with .., odd characters or no leading slash is refused", { skip }, () => {
	wrapper(bin, "py-dots");
	const p = join(bin, "..", "bin", "py-dots");
	const dots = `${bin}/../bin/py-dots`;
	assert.ok(p.includes("py-dots"));
	refuse("print(1)\n", PYTHON_PROBLEMS.badInterpreter(dots), { python: dots });
	const odd = wrapper(join(root, "odd dir"), "py");
	refuse("print(1)\n", PYTHON_PROBLEMS.badInterpreter(odd), { python: odd });
	refuse("print(1)\n", PYTHON_PROBLEMS.badInterpreter("bin/py-dots"), { python: "bin/py-dots" });
});

test("a missing absolute interpreter is reported", { skip }, () => {
	const p = join(bin, "does-not-exist");
	refuse("print(1)\n", PYTHON_PROBLEMS.noInterpreter(p), { python: p });
});

test("a shims interpreter is refused unless it is plain python3", { skip }, () => {
	const shims = join(root, "pyenv", "shims");
	const p = wrapper(shims, "python3");
	refuse("print(1)\n", unsafe(p), { python: p });
	wrapper(shims, "python3.99");
	refuse("print(1)\n", unsafe(join(shims, "python3.99")), { python: "python3.99", env: { PATH: shims } });
	pass("print(1)\n", { env: { PATH: `${shims}:${env.PATH}` } });
});

test("an interpreter reporting Python 2 or no version is refused", { skip }, () => {
	const py2 = fake(join(root, "py2"), "python", 'echo "2 2.7.18 (default)"');
	refuse("print(1)\n", PYTHON_PROBLEMS.notPython3("2 2.7.18 (default)"), { python: py2 });
	const broken = fake(join(root, "broken"), "python", "exit 3");
	refuse("print(1)\n", PYTHON_PROBLEMS.notPython3("it could not report its version"), { python: broken });
});

test("a relative or run-dir PATH entry holding the interpreter is refused", { skip }, () => {
	wrapper(runDir, "pyhere");
	refuse("print(1)\n", unsafe(join(runDir, "pyhere")), { python: "pyhere", env: { PATH: `${runDir}:${env.PATH}` } });
	const v = analyzePythonScript("print(1)\n", opts({ python: "pyhere", env: { PATH: `.:${env.PATH}` } }));
	assert.ok(!v.ok);
	if (!v.ok) assert.equal(v.problem, unsafe(join(".", "pyhere")));
	// an unsafe entry that does not hold the interpreter is only skipped
	pass("print(1)\n", { env: { PATH: `.::${runDir}:${env.PATH}` } });
});

test("two interpreters never share a cached verdict", { skip }, () => {
	const script = "print('iso')\n";
	const good = wrapper(join(root, "ia"), "py");
	// Answers the version probe like python 3, then fails the analyzer run with a distinct verdict.
	const fakeAnalyzer = fake(
		join(root, "ib"),
		"py",
		`case "$*" in *version_info*) echo "3 3.99.0 fake";; *) echo '{"ok": false, "code": "syntax", "detail": "fake"}';; esac`,
	);
	assert.ok(analyzePythonScript(script, opts({ python: good })).ok);
	const second = analyzePythonScript(script, opts({ python: fakeAnalyzer }));
	assert.ok(!second.ok);
	if (!second.ok) assert.equal(second.problem, PYTHON_PROBLEMS.syntax("fake"));
	assert.ok(analyzePythonScript(script, opts({ python: good })).ok);
});
