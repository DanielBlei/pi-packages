/**
 * Differential oracle for the program expander: run the original command and
 * its expansion under real bash, with every command name a shell function that
 * logs its argv, and compare the logs and the set of created paths.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandCommand } from "../../extensions/program.ts";

const hasBash = spawnSync("bash", ["--version"]).status === 0;
const bashPath = hasBash ? spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() : "";
const maybe = hasBash && bashPath !== "" ? test : test.skip;

const NAMES = ["wc", "cat", "ls", "grep", "echo", "sort", "head", "sh", "rm", "cp", "git", "tr", "touch", "mkdir", "test", "true", "nl"];

/** Every command name logs one record: its name and argv, separated by 0x1f. */
const PREAMBLE = [
	`__rec() { local s="$1"; shift; local a; for a in "$@"; do s="$s"$'\\037'"$a"; done; printf '%s\\n' "$s" >>"$LOG"; }`,
	...NAMES.map((name) => `${name}() { __rec ${name} "$@"; }`),
	`false() { __rec false "$@"; return 1; }`,
	`cd() { __rec cd "$@"; builtin cd "$@"; }`,
].join("\n");

const root = realpathSync(mkdtempSync(join(tmpdir(), "pk-program-diff-")));
const logDir = realpathSync(mkdtempSync(join(tmpdir(), "pk-program-log-")));
const logFile = join(logDir, "log");
const proj = join(root, "proj");
const scratch = join(root, "scratch");

interface Outcome {
	records: string[];
	paths: string[];
	status: number | null;
	failure?: string;
}

function walk(dir: string, prefix: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		out.push(rel);
		if (entry.isDirectory()) walk(join(dir, entry.name), rel, out);
	}
}

/** Files of every fresh `proj/`: input redirects need their file, glob loops need something to match. */
const FIXTURES = [
	"a", "b", "c.txt", "d-e", "a.b", "1", "p/q", "k", "x.txt",
	"m1.log", "m2.log", "m3.log", ".hid.log", "notes.md", "sub/s1.md", "sub/s2.md", "sub/.h.md", "B.txt", "Z.txt", "_x.txt", "s p.dat",
];

/** A fresh `proj/` (cwd) with the fixtures, next to a fresh `scratch/`. */
function fresh(): void {
	for (const entry of readdirSync(root)) rmSync(join(root, entry), { recursive: true, force: true });
	mkdirSync(proj);
	mkdirSync(scratch);
	// also in scratch: after a `cd` the original `cmd < f` still finds its file, as the oracle's `cat f` pretends to
	for (const base of [proj, scratch]) {
		for (const file of FIXTURES) {
			mkdirSync(dirname(join(base, file)), { recursive: true });
			writeFileSync(join(base, file), "");
		}
	}
}

/** Run `command` in a fresh `proj/` (cwd) next to a fresh `scratch/`. */
function run(command: string): Outcome {
	fresh();
	writeFileSync(logFile, "");
	const result = spawnSync(bashPath, ["--norc", "--noprofile", "-c", `${PREAMBLE}\n${command}`], {
		cwd: proj,
		env: { PATH: "/nonexistent", HOME: root, LOG: logFile },
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		encoding: "utf8",
	});
	const paths: string[] = [];
	walk(root, "", paths);
	const outcome: Outcome = {
		records: readFileSync(logFile, "utf8").split("\n").filter((line) => line !== ""),
		paths: paths.sort(),
		status: result.status,
	};
	if (result.error !== undefined || result.signal !== null) outcome.failure = String(result.error ?? result.signal);
	return outcome;
}

function hasPipe(command: string): boolean {
	return /(^|[^|])\|([^|]|$)/.test(command);
}

/** `a || for ...` skips the loop, but `a || cat x; cat y` does not: the expansion may only add. */
function isConditionalLoop(command: string): boolean {
	return /(&&|\|\|)\s*for\b/.test(command);
}

function contained(small: readonly string[], big: readonly string[]): boolean {
	const counts = new Map<string, number>();
	for (const item of big) counts.set(item, (counts.get(item) ?? 0) + 1);
	for (const item of small) {
		const left = counts.get(item) ?? 0;
		if (left === 0) return false;
		counts.set(item, left - 1);
	}
	return true;
}

const US = "\u001f";
const FIXTURE_SET = new Set(FIXTURES);

/** Records of `list` that `base` does not account for (a multiset difference). */
function without(list: readonly string[], base: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const item of base) counts.set(item, (counts.get(item) ?? 0) + 1);
	const rest: string[] = [];
	for (const item of list) {
		const left = counts.get(item) ?? 0;
		if (left > 0) counts.set(item, left - 1);
		else rest.push(item);
	}
	return rest;
}

/**
 * The oracle: same argv records and same created paths (a superset of both for a loop behind `&&` / `||`).
 * A rewritten `cmd < path` adds one `cat path` record: `cats` lists those paths, or "derive" accepts exactly
 * one extra `cat <fixture>` record per `nl` record (the fuzz uses `nl` only for input redirects).
 */
function agree(original: string, expanded: string, cats: readonly string[] | "derive" = []): { ok: boolean; detail: string } {
	// a python segment becomes its effect program (`cat`, `ls`, `touch` of the paths it names): not argv-equivalent, so never part of the oracle
	assert.ok(!/\bpython3\b/.test(original), `python cases are excluded from the differential oracle: ${JSON.stringify(original)}`);
	const a = run(original);
	const b = run(expanded);
	if (a.failure !== undefined || b.failure !== undefined) return { ok: false, detail: `bash failed: ${a.failure} / ${b.failure}` };
	const conditional = isConditionalLoop(original);
	let expectedA = a.records;
	if (cats === "derive") {
		if (!conditional) {
			const extra = without(b.records, a.records);
			const nl = b.records.filter((r) => r === "nl" || r.startsWith(`nl${US}`)).length;
			const shaped = extra.every((r) => r.startsWith(`cat${US}`) && FIXTURE_SET.has(r.slice(4).replace(/^\.\//, "")));
			if (!shaped || extra.length !== nl) return { ok: false, detail: `extra records ${JSON.stringify(extra)} for ${nl} nl records\noriginal ${JSON.stringify(a.records)}\nexpanded ${JSON.stringify(b.records)}` };
			expectedA = [...a.records, ...extra];
		}
	} else {
		expectedA = [...a.records, ...cats.map((path) => `cat${US}${path}`)];
	}
	const sorted = hasPipe(original) || cats === "derive" || cats.length > 0;
	const order = sorted ? (list: readonly string[]) => [...list].sort() : (list: readonly string[]) => [...list];
	const recA = order(expectedA);
	const recB = order(b.records);
	const ok = conditional
		? contained([...a.records].sort(), [...recB].sort()) && contained(a.paths, b.paths)
		: JSON.stringify(recA) === JSON.stringify(recB) && JSON.stringify(a.paths) === JSON.stringify(b.paths);
	return { ok, detail: `original ${JSON.stringify(recA)} ${JSON.stringify(a.paths)}\nexpanded ${JSON.stringify(recB)} ${JSON.stringify(b.paths)}` };
}

function expand(command: string): { text: string; problem?: string; changed: boolean } {
	fresh();
	return expandCommand(command, { cwd: proj, scratch, env: {}, globs: true });
}

maybe("positive controls: hand cases agree with their expansion", () => {
	const S = scratch;
	const cases = [
		"for f in a b; do wc -l $f; done",
		"x=docs; cat $x/f; ls $x",
		"x=docs; for f in a b; do cat $x/$f.txt; done",
		"for f in a b; do for g in c d; do echo $f$g; done; done",
		"for f in a b\ndo\n  wc -l \"$f\"\n  echo '$f' ${f}y $f.z\ndone",
		`for f in a b; do wc -l $f; done > ${S}/out`,
		`for f in a b; do wc -l $f; done >> ${S}/out 2>&1`,
		`for f in a b; do echo $f > ${S}/$f; done`,
		"for f in a b; do wc -l $f; done | sort",
		"for f in a b; do wc -l $f; done | sort | head",
		"for f in a b; do wc -l $f; done | sort | uniq -c",
		`for f in a b; do wc -l $f; done | sort | head > ${S}/out`,
		"for f in a b; do wc -l $f; done | sort | head && echo ok",
		"for f in a b; do cat $f | grep x; done",
		"true && for f in a b; do wc -l $f; done; echo end",
		"for f in a b; do wc -l $f; done && echo ok || echo bad",
		"x=a; y=b; echo $x$y \"$x $y\" ${x}$y",
		"echo start # c\nx=a\ncat $x",
		"for f in a b; do cat $f # note\ndone",
	];
	for (const command of cases) {
		const p = expand(command);
		assert.equal(p.problem, undefined, `${JSON.stringify(command)}: ${p.problem}`);
		assert.equal(p.changed, true);
		const verdict = agree(command, p.text);
		assert.ok(verdict.ok, `${JSON.stringify(command)} -> ${JSON.stringify(p.text)}\n${verdict.detail}`);
	}
	// a loop that a failed condition skips: the expansion judges more, never less
	const skipped = expand("false && for f in a b; do wc -l $f; done");
	assert.equal(skipped.problem, undefined);
	assert.ok(agree("false && for f in a b; do wc -l $f; done", skipped.text).ok);
});

maybe("positive controls: input redirects become `cat path | cmd`", () => {
	const S = scratch;
	const cases: Array<[string, string[]]> = [
		["wc -l < a", ["a"]],
		["wc -l <a", ["a"]],
		["< a wc -l", ["a"]],
		["wc -l < p/q 2>&1", ["p/q"]],
		[`wc -l < a > ${S}/o`, ["a"]],
		[`wc -l > ${S}/o < a`, ["a"]],
		["wc -l < a | sort", ["a"]],
		["echo s; wc -l < c.txt; echo e", ["c.txt"]],
		["true && wc -l < a || echo no", ["a"]],
		["false && wc -l < a; echo e", []],
		["x=a; wc -l < $x; ls $x", ["a"]],
		['x=a; wc -l < "$x"', ["a"]],
		["wc -l < a; grep x < b", ["a", "b"]],
		["for f in a b; do wc -l < $f; done", ["a", "b"]],
		["for f in a b; do wc -l < $f | sort; done", ["a", "b"]],
		[`for f in a b; do wc -l < $f; done > ${S}/out`, ["a", "b"]],
		["for f in a b; do for g in k; do grep $g < $f; done; done", ["a", "b"]],
	];
	for (const [command, cats] of cases) {
		const p = expand(command);
		assert.equal(p.problem, undefined, `${JSON.stringify(command)}: ${p.problem}`);
		assert.equal(p.changed, true);
		const verdict = agree(command, p.text, cats);
		assert.ok(verdict.ok, `${JSON.stringify(command)} -> ${JSON.stringify(p.text)}\n${verdict.detail}`);
	}
	const nl = expand("nl < a; nl < b");
	assert.ok(agree("nl < a; nl < b", nl.text, "derive").ok);
	// bash does not run a command whose input file is missing, so the oracle sees it: the fuzz keeps every path real
	assert.equal(agree("wc -l < nofile", "cat nofile | wc -l", ["nofile"]).ok, false);
});

maybe("positive controls: glob loops agree with bash's own expansion", () => {
	const S = scratch;
	const cases = [
		"for f in m*.log; do wc -l $f; done",
		'for f in *.log; do wc -l "$f"; done',
		"for f in *.txt; do ls $f; done",
		"for f in ?.txt; do ls $f; done",
		"for f in [a-c]*; do ls $f; done",
		"for f in m[12].log; do wc -l $f; done",
		"for f in m[!12].log; do wc -l $f; done",
		"for f in .h*; do wc -l $f; done",
		"for f in sub/*.md; do wc -l $f; done",
		"for f in sub/.h* sub/s1*; do wc -l $f; done",
		'for f in *.dat; do wc -l "$f"; done',
		"for f in a z m*.log; do wc -l $f; done",
		"d=sub; for f in $d/*.md; do wc -l $f; done",
		"echo s; for f in m*.log; do wc -l $f; done; echo e",
		"for f in m*.log; do wc -l $f; done | sort",
		`for f in m*.log; do wc -l $f; done > ${S}/out`,
		"for d in sub; do for f in $d/*.md; do wc -l $f; done; done",
		"for f in m*.log; do for g in a b; do cat $f$g; done; done",
		"true && for f in m*.log; do wc -l $f; done",
		"for f in m*.log; do wc -l < $f; done",
	];
	for (const command of cases) {
		const p = expand(command);
		assert.equal(p.problem, undefined, `${JSON.stringify(command)}: ${p.problem}`);
		assert.equal(p.changed, true);
		const cats = command.includes("< $f") ? ["m1.log", "m2.log", "m3.log"] : [];
		const verdict = agree(command, p.text, cats);
		assert.ok(verdict.ok, `${JSON.stringify(command)} -> ${JSON.stringify(p.text)}\n${verdict.detail}`);
	}
	// without the grant nothing is expanded
	assert.equal(expandCommand("for f in m*.log; do wc -l $f; done", { cwd: proj, scratch, env: {} }).changed, false);
	// a wrong match list is flagged
	assert.equal(agree("for f in m*.log; do wc -l $f; done", "wc -l m1.log; wc -l m2.log").ok, false);
	assert.equal(agree("for f in m*.log; do wc -l $f; done", "wc -l m3.log; wc -l m2.log; wc -l m1.log").ok, false);
});

maybe("negative controls: the oracle flags a wrong expansion", () => {
	const original = "for f in a b; do wc -l $f; done";
	assert.ok(agree(original, "wc -l a; wc -l b").ok);
	assert.equal(agree(original, "wc -l a; wc -l a").ok, false, "wrong word");
	assert.equal(agree(original, "wc -l a").ok, false, "missing copy");
	assert.equal(agree(original, "wc -l a; wc -l b; wc -l c").ok, false, "extra copy");
	assert.equal(agree(original, "wc -l b; wc -l a").ok, false, "wrong order");
	assert.equal(agree("echo a > " + scratch + "/o", "echo a").ok, false, "missing file");
	assert.equal(agree("cat a; cat b", "cat b; cat a").ok, false, "different record order");
	assert.ok(agree("wc -l < a", "cat a | wc -l", ["a"]).ok);
	assert.equal(agree("wc -l < a", "cat a | wc -l").ok, false, "an unaccounted cat record");
	assert.equal(agree("wc -l < a", "cat a | wc -l", ["b"]).ok, false, "the wrong cat path");
	assert.equal(agree("wc -l < a", "wc -l", ["a"]).ok, false, "a missing cat record");
	assert.equal(agree("nl < a", "cat a | nl; cat b | nl", "derive").ok, false, "too many derived records");
	assert.equal(agree("nl < a", "cat nofile | nl", "derive").ok, false, "a cat of a path that is not a fixture");
});

// --- seeded fuzz ----------------------------------------------------------

function prng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const VARS = ["x", "y", "f", "g", "xy"];
const VALUES = ["a", "b", "c.txt", "d-e", "a.b", "p/q", "1"];
const CMDS = ["wc", "cat", "ls", "grep", "echo", "head", "sort"];
const GLOB_WORDS = ["m*.log", "m[12].log", "*.md", "sub/*.md", "sub/s?.md", ".h*", "?.txt", "*.txt", "*.dat", "[a-c]*", "./m*", "*"];

function generate(rand: () => number): string {
	const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
	const chance = (p: number): boolean => rand() < p;

	const arg = (scope: readonly string[]): string => {
		if (scope.length > 0 && chance(0.7)) {
			const v = pick(scope);
			return pick([
				`$${v}`,
				`"$${v}"`,
				`\${${v}}`,
				`\${${v}}y`,
				`$${v}.y`,
				`"$${v}".c`,
				`a$${v}`,
				`'$${v}'`,
				`"a $${v} b"`,
				`$${v}/f`,
				`\${${v}}$${v}`,
				`$${v}y`,
				`$${v}$${v}`,
				chance(0.1) ? `{$${v},b}` : `$${v}`,
				chance(0.1) ? `~$${v}` : `"$${v}"`,
			]);
		}
		return pick(["a", "-n", "x.txt", "dir/f", "'q r'", '"s t"', "*.c", "~", chance(0.1) ? "{a,b}" : "k"]);
	};
	const redirect = (scope: readonly string[]): string => {
		const options = [`> ${scratch}/o`, `>> ${scratch}/o`, "2>&1", "> /dev/null"];
		if (scope.length > 0) options.push(`> ${scratch}/$${pick(scope)}`);
		return pick(options);
	};
	const unit = (scope: readonly string[]): string => {
		const parts = [pick(CMDS)];
		for (let n = Math.floor(rand() * 3); n >= 0; n--) parts.push(arg(scope));
		if (chance(0.15)) parts.push(redirect(scope));
		if (chance(0.08)) return `cd ../scratch`;
		if (chance(0.12)) {
			// `nl` is used for input redirects only, so the oracle can tell them apart
			const source =
				scope.length > 0 && chance(0.6)
					? pick([`$${pick(scope)}`, `"$${pick(scope)}"`, `\${${pick(scope)}}`])
					: pick(["a", "b", "c.txt", "p/q", "k", "-a", "'a'"]);
			const text = `nl${chance(0.5) ? " " + arg(scope) : ""} < ${source}${chance(0.2) ? " " + redirect(scope) : ""}`;
			return chance(0.1) ? `${pick(CMDS)} | ${text}` : chance(0.25) ? `${text} | ${pick(CMDS)}` : text;
		}
		if (chance(0.12)) return `${parts.join(" ")} | ${pick(CMDS)} ${arg(scope)}`;
		return parts.join(" ");
	};
	const sep = (): string => pick(["; ", "; ", "\n", "\n", " && ", " || "]);
	const comment = (): string => (chance(0.15) ? ` # note $${pick(VARS)} 'q` : "");
	const literal = (scope: readonly string[]): string =>
		scope.length > 0 && chance(0.15) ? pick([`$${pick(scope)}`, `"$${pick(scope)}"`]) : chance(0.2) ? pick(GLOB_WORDS) : pick(VALUES);

	const loop = (scope: string[], depth: number): string => {
		const v = chance(0.85) ? pick(["f", "g", "y"]) : pick(VARS);
		const words: string[] = [];
		for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) words.push(literal(scope));
		const inner = [...scope, v];
		const body: string[] = [];
		for (let n = 1 + Math.floor(rand() * 2); n > 0; n--) {
			body.push(depth < 2 && chance(0.2) ? loop(inner, depth + 1) : unit(inner));
		}
		const newline = chance(0.35);
		const bodyText = newline
			? body.map((b) => `  ${b}${comment()}`).join("\n")
			: body.map((b) => b).join(pick(["; ", "; ", " && "]) === " && " ? "; " : "; ");
		const header = `for ${v} in ${words.join(" ")}`;
		let text = newline ? `${header}\ndo\n${bodyText}\ndone` : `${header}; do ${bodyText}; done`;
		if (chance(0.3)) text += ` ${pick([`> ${scratch}/o`, `>> ${scratch}/o`, "2>&1", "| sort", "| head -n 1", "> src/o", `> ${scratch}/$${v}`])}`;
		return text;
	};

	const scope: string[] = [];
	const items: string[] = [];
	for (let n = 1 + Math.floor(rand() * 4); n > 0; n--) {
		const roll = rand();
		if (roll < 0.28) {
			const v = pick(VARS);
			const value = pick(VALUES);
			const form = pick([`${v}=${value}`, `${v}='${value}'`, `${v}="${value}"`, `${v}=${value}`, chance(0.1) ? `${v}=$${pick(VARS)}` : `${v}=${value}`]);
			items.push(form);
			if (!scope.includes(v)) scope.push(v);
		} else if (roll < 0.62) {
			items.push(loop(scope, 0));
		} else if (roll < 0.68) {
			const v = pick(VARS);
			items.push(`${pick(["test -d proj", "true", "false"])} ${pick(["&&", "||"])} ${v}=${pick(VALUES)}`);
			if (!scope.includes(v)) scope.push(v);
		} else {
			items.push(unit(scope));
		}
	}
	let text = "";
	items.forEach((item, n) => {
		const last = n === items.length - 1;
		const separator = last ? "" : sep();
		const tail = separator.startsWith("\n") ? comment() : "";
		text += item + tail + separator;
	});
	return text;
}

maybe("fuzz: every expansion that is accepted behaves like the original", (t) => {
	const rand = prng(20260101);
	const total = 300;
	let expanded = 0;
	let refused = 0;
	let plain = 0;
	let globLoops = 0;
	let redirects = 0;
	const problems = new Map<string, number>();
	for (let n = 0; n < total; n++) {
		const command = generate(rand);
		const p = expand(command);
		if (p.problem !== undefined) {
			refused++;
			problems.set(p.problem, (problems.get(p.problem) ?? 0) + 1);
			assert.equal(p.text, command);
			continue;
		}
		if (!p.changed) {
			plain++;
			continue;
		}
		expanded++;
		if (/for \w+ in [^;\n]*[*?[]/.test(command)) globLoops++;
		if (/ < /.test(command)) redirects++;
		const original = run(command);
		assert.notEqual(original.status, 2, `the generator wrote a syntax error: ${JSON.stringify(command)}`);
		const verdict = agree(command, p.text, "derive");
		assert.ok(verdict.ok, `case ${n}: ${JSON.stringify(command)} -> ${JSON.stringify(p.text)}\n${verdict.detail}`);
	}
	t.diagnostic(`fuzz: ${total} cases, ${expanded} expanded, ${refused} refused, ${plain} untouched, ${globLoops} with a glob loop, ${redirects} with an input redirect`);
	for (const [problem, count] of [...problems].sort((a, b) => b[1] - a[1]).slice(0, 12)) t.diagnostic(`  ${count} x ${problem}`);
	assert.ok(expanded >= total * 0.3, `only ${expanded} of ${total} fuzz cases expanded`);
});

maybe("python segments are excluded from the oracle: the expansion is an effect program, not the same argv", () => {
	const command = `python3 -c 'print(open("a").read())'`;
	const p = expand(command);
	if (p.problem !== undefined) return; // python3 missing: nothing to compare
	assert.equal(p.text, "cat -- 'a'");
	assert.throws(() => agree(command, p.text), /excluded from the differential oracle/);
	// and the fuzz generator never writes one
	const rand = prng(7);
	for (let n = 0; n < 200; n++) assert.ok(!generate(rand).includes("python3"));
});
