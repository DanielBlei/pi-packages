/**
 * Tests for the program expander: input -> expanded text or an exact problem.
 * Every rule of plan D3 has a near-miss (refused) and a twin (expands).
 * Run: npm test
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandCommand, MAX_GLOB_WORDS, MAX_LOOP_BODIES, MAX_LOOP_WORDS, PROBLEMS } from "../../extensions/program.ts";
import { MAX_COMMAND_LENGTH } from "../../extensions/utils.ts";

const SCRATCH = "/tmp/pk-program-scratch";
const options = { cwd: "/work/proj", scratch: SCRATCH, env: {} as Record<string, string | undefined> };

type Expect = { text: string } | { problem: string };

function check(command: string, expected: Expect, env: Record<string, string | undefined> = {}): void {
	const got = expandCommand(command, { ...options, env });
	if ("text" in expected) {
		assert.equal(got.problem, undefined, `unexpected problem for ${JSON.stringify(command)}`);
		assert.equal(got.text, expected.text, `text for ${JSON.stringify(command)}`);
		assert.equal(got.changed, true);
	} else {
		assert.equal(got.problem, expected.problem, `problem for ${JSON.stringify(command)}`);
		assert.equal(got.text, command, "a refusal returns the original text");
		assert.equal(got.changed, false);
	}
}

function table(name: string, rows: ReadonlyArray<readonly [string, Expect]>): void {
	test(name, () => {
		for (const [command, expected] of rows) check(command, expected);
	});
}

test("commands without a loop or a standalone assignment are returned untouched, without a problem", () => {
	for (const command of [
		"git status",
		"cat a | grep b > /dev/null",
		"echo a\\b",
		"echo $x `date` $(pwd) {a,b} 'it''s'",
		"cat <<EOF\nhello\nEOF",
		"x=a cat $x",
		"FOO=1 BAR=2 make test",
		"echo \u00e9 for x",
		"echo 'unterminated",
		"x=a; cat 'unterminated",
		"read x; echo $x",
		"ls ${HOME:-/tmp}",
		"",
	]) {
		const got = expandCommand(command, options);
		assert.deepEqual(got, { text: command, changed: false }, JSON.stringify(command));
	}
});

table("assignments: expansion", [
	["x=docs; cat $x/f", { text: "cat docs/f" }],
	["x=docs\ncat $x/f", { text: "cat docs/f" }],
	["x=docs && cat $x/f", { text: "cat docs/f" }],
	["x='a.b'; y=\"c-d\"; echo $x $y", { text: "echo a.b c-d" }],
	["echo hi; x=a; cat $x", { text: "echo hi; cat a" }],
	["x=a; cat $x; y=b; cat $y", { text: "cat a; cat b" }],
	["x=a;", { text: "" }],
	["x=a; cat $x # note", { text: "cat a # note" }],
	["x=src; cat $x.c ${x}y \"$x\" \"a$x\" '$x' $xy", { text: "cat src.c srcy \"src\" \"asrc\" '$x' $xy" }],
	["x=a; echo \"${x}b\" $x$x", { text: 'echo "ab" aa' }],
	["x=a; cat > /dev/null $x", { text: "cat > /dev/null a" }],
	["x=a; echo $x > " + SCRATCH + "/out", { text: "echo a > " + SCRATCH + "/out" }],
	["x=" + SCRATCH + "/out; echo hi > $x", { text: "echo hi > " + SCRATCH + "/out" }],
	["x=a; echo $x $y", { text: "echo a $y" }],
	["x=a; echo $1 $@ $$ $_", { text: "echo $1 $@ $$ $_" }],
	["x=a; x2=b; echo $x2", { text: "echo b" }],
]);

table("assignments: near-miss and twin per rule", [
	// unit position: only start, `;` or newline
	["test -d d && x=d; cat $x/f", { problem: PROBLEMS.position("x", "&&") }],
	["test -d d; x=d; cat $x/f", { text: "test -d d; cat d/f" }],
	["test -d d || x=d; cat $x/f", { problem: PROBLEMS.position("x", "||") }],
	["echo a | x=d; cat $x", { problem: PROBLEMS.position("x", "|") }],
	["echo a & x=d; cat $x", { problem: PROBLEMS.position("x", "&") }],
	// the unit that follows
	["x=d || cat $x", { problem: PROBLEMS.follow("x", "||") }],
	["x=d && cat $x", { text: "cat d" }],
	["x=d | cat $x", { problem: PROBLEMS.follow("x", "|") }],
	["x=d & cat $x", { problem: PROBLEMS.follow("x", "&") }],
	// names
	["_=a; cat $_", { problem: PROBLEMS.nameUnderscore }],
	["_a=a; cat $_a", { text: "cat a" }],
	["X=a; cat $X", { problem: PROBLEMS.nameForm("X") }],
	["path=a; cat $path", { problem: PROBLEMS.nameSpecial("path") }],
	["paths=a; cat $paths", { text: "cat a" }],
	["cdpath=a; cd b", { problem: PROBLEMS.nameSpecial("cdpath") }],
	["http_proxy=a; curl b", { problem: PROBLEMS.nameSpecial("http_proxy") }],
	["x+=a; cat $x", { problem: PROBLEMS.plusEquals("x") }],
	["x=a; x=b; cat $x", { problem: PROBLEMS.rebind("x") }],
	// values
	["x=-rf; rm $x", { problem: PROBLEMS.value("x") }],
	["x=a-f; rm $x", { text: "rm a-f" }],
	["x=a,b; cat $x", { problem: PROBLEMS.value("x") }],
	["x='a b'; cat $x", { problem: PROBLEMS.value("x") }],
	["x=*; cat $x", { problem: PROBLEMS.value("x") }],
	["x=~; cat $x", { problem: PROBLEMS.value("x") }],
	["x=$y; cat $x", { problem: PROBLEMS.value("x") }],
	["x=; cat $x", { problem: PROBLEMS.value("x") }],
	["x=a=b; cat $x", { problem: PROBLEMS.value("x") }],
	["x=a'b'; cat $x", { problem: PROBLEMS.value("x") }],
	["x='-a'; cat $x", { problem: PROBLEMS.value("x") }],
	["x=a; y=b > f", { problem: PROBLEMS.assignMany }],
	["x=a y=b; cat $x", { problem: PROBLEMS.assignMany }],
	["y=1; x[0]=a; cat $y", { problem: PROBLEMS.array }],
]);

test("a name present in the environment is not bound", () => {
	check("x=a; cat $x", { problem: PROBLEMS.nameEnv("x") }, { x: "1" });
	check("x=a; cat $x", { text: "cat a" }, { y: "1" });
});

test("IFS, BASH_ENV and ENV in the environment refuse every construct, plain commands are untouched", () => {
	for (const key of ["IFS", "BASH_ENV", "ENV"]) {
		check("x=a; cat $x", { problem: PROBLEMS.envVar(key) }, { [key]: "1" });
		const plain = expandCommand("cat a", { ...options, env: { [key]: "1" } });
		assert.deepEqual(plain, { text: "cat a", changed: false });
	}
});

table("uses", [
	["x=a; cat $x", { text: "cat a" }],
	["cat $x; x=a", { problem: PROBLEMS.use("x") }],
	["x=a cat $x; y=b", { problem: PROBLEMS.use("x") }],
	["x=a; cat ${x:-y}", { problem: PROBLEMS.braceOperator }],
	["x=a; cat ${x}", { text: "cat a" }],
	["x=a; cat ${#x}", { problem: PROBLEMS.braceOperator }],
	["x=a; cat {$x,b}", { problem: PROBLEMS.brackets }],
	["x=a; cat {a,b}", { problem: PROBLEMS.brackets }],
	["x=a; cat '$x' $x", { text: "cat '$x' a" }],
	["x=a; cat \"$x\"", { text: 'cat "a"' }],
	["x=a; cat ~$x", { problem: PROBLEMS.tilde("x") }],
	["x=2; cat $x>/dev/null", { problem: PROBLEMS.digitRedirect }],
	["x=2; cat $x >/dev/null", { text: "cat 2 >/dev/null" }],
	["x=a; $x=1 cat", { problem: PROBLEMS.newAssignment }],
	["x=a; $x -l", { text: "a -l" }],
	["x=if; $x true", { problem: PROBLEMS.keyword("if") }],
	["x=read; $x y", { problem: PROBLEMS.rootBuiltin("read") }],
	["x=a; y=$x", { problem: PROBLEMS.value("y") }],
]);

table("whole-command preconditions", [
	["x=a; cat $x\\ b", { problem: PROBLEMS.backslash }],
	["x=a; cat '$x\\b'", { text: "cat '$x\\b'" }],
	["x=a; cat \"\\$x\"", { problem: PROBLEMS.backslash }],
	["x=a; cat $'a'", { problem: PROBLEMS.dollarQuote }],
	['x=a; cat $"a"', { problem: PROBLEMS.dollarQuote }],
	["x=a; cat \u00e9", { problem: PROBLEMS.chars }],
	["x=a; cat \r", { problem: PROBLEMS.chars }],
	["x=a; cat $(pwd)", { problem: PROBLEMS.substitution }],
	["x=a; cat `pwd`", { problem: PROBLEMS.substitution }],
	["x=a; cat <<EOF\nhi\nEOF", { problem: PROBLEMS.heredoc }],
	["x=a; cat <<< $x", { problem: PROBLEMS.heredoc }],
	["x=a; cat < $x", { text: "cat a | cat" }],
	["x=a; (cat $x)", { problem: PROBLEMS.brackets }],
	["x=a; { cat $x; }", { problem: PROBLEMS.brackets }],
	["x=a; IFS=, cat $x", { problem: PROBLEMS.ifs }],
	["x=a; ifs=, ; cat $x", { problem: PROBLEMS.ifs }],
	["x=a;; cat $x", { problem: PROBLEMS.separator(";;") }],
	["x=a; ; cat $x", { problem: PROBLEMS.empty }],
	["x=a; cat $x &&", { problem: PROBLEMS.dangling("&&") }],
	["x=a; cat $x |& cat", { problem: PROBLEMS.separator("|&") }],
	["x=a; cat >", { problem: PROBLEMS.redirectTarget }],
	["x=a; cat >& file", { problem: PROBLEMS.redirectDup }],
]);

table("builtins that can bind or change the shell", [
	["x=a; read y; cat $x", { problem: PROBLEMS.rootBuiltin("read") }],
	["x=a; export y=1", { problem: PROBLEMS.rootBuiltin("export") }],
	["x=a; unset x; cat $x", { problem: PROBLEMS.rootBuiltin("unset") }],
	["x=a; declare y=1", { problem: PROBLEMS.rootBuiltin("declare") }],
	["x=a; local y=1", { problem: PROBLEMS.rootBuiltin("local") }],
	["x=a; eval cat", { problem: PROBLEMS.rootBuiltin("eval") }],
	["x=a; . ./f", { problem: PROBLEMS.rootBuiltin(".") }],
	["x=a; source ./f", { problem: PROBLEMS.rootBuiltin("source") }],
	["x=a; set -- b", { problem: PROBLEMS.rootBuiltin("set") }],
	["x=a; shift", { problem: PROBLEMS.rootBuiltin("shift") }],
	["x=a; getopts ab o", { problem: PROBLEMS.rootBuiltin("getopts") }],
	["x=a; mapfile y", { problem: PROBLEMS.rootBuiltin("mapfile") }],
	["x=a; let y=1", { problem: PROBLEMS.rootBuiltin("let") }],
	["x=a; command read y", { problem: PROBLEMS.rootBuiltin("command") }],
	["x=a; y=1 read z", { problem: PROBLEMS.rootBuiltin("read") }],
	["x=a; printf -v y %s z", { problem: PROBLEMS.printfV }],
	["x=a; printf %s $x", { text: "printf %s a" }],
	["x=a; if true; then y=1; fi", { problem: PROBLEMS.keyword("if") }],
	["x=a; while true; do cat $x; done", { problem: PROBLEMS.keyword("while") }],
]);

table("for loops: expansion", [
	["for f in a b; do wc -l $f; done", { text: "wc -l a; wc -l b" }],
	["for f in a b\ndo\n  wc -l $f\ndone", { text: "wc -l a; wc -l b" }],
	["for f in a b; do\n  wc -l $f\n  echo $f\ndone\n", { text: "wc -l a\n  echo a; wc -l b\n  echo b\n" }],
	["for f in a b; do wc -l $f; done; echo end", { text: "wc -l a; wc -l b; echo end" }],
	["echo start; for f in a b; do wc -l $f; done", { text: "echo start; wc -l a; wc -l b" }],
	["echo start\nfor f in a; do wc -l $f; done", { text: "echo start\nwc -l a" }],
	["true && for f in a b; do wc -l $f; done", { text: "true && wc -l a; wc -l b" }],
	["true || for f in a; do wc -l $f; done", { text: "true || wc -l a" }],
	["for f in a b; do wc -l $f; done && echo ok", { text: "wc -l a; wc -l b && echo ok" }],
	["for f in a b; do wc -l $f; done || echo bad", { text: "wc -l a; wc -l b || echo bad" }],
	["d=src; for f in $d/a 'b.c'; do wc -l \"$f\"; done", { text: 'wc -l "src/a"; wc -l "b.c"' }],
	["for f in a b; do for g in c d; do cat $f$g; done; done", { text: "cat ac; cat ad; cat bc; cat bd" }],
	["for f in a; do cat $f.txt ${f}y $fy '$f'; done", { text: "cat a.txt ay $fy '$f'" }],
	["for f in a b; do cat $f # c\ndone", { text: "cat a; cat b" }],
	["for f in a b; do wc -l $f | sort; done", { text: "wc -l a | sort; wc -l b | sort" }],
	["for f in a b; do wc -l $f && echo $f; done", { text: "wc -l a && echo a; wc -l b && echo b" }],
	["for f in a b; do cat $f; done; for f in c; do ls $f; done", { text: "cat a; cat b; ls c" }],
]);

table("for loops: trailers", [
	["for f in a b; do wc -l $f; done > " + SCRATCH + "/o", { text: "wc -l a; wc -l b > " + SCRATCH + "/o" }],
	["for f in a b; do wc -l $f; done >> " + SCRATCH + "/o 2>&1", { text: "wc -l a; wc -l b >> " + SCRATCH + "/o 2>&1" }],
	["for f in a b; do wc -l $f; done 2>&1", { text: "wc -l a; wc -l b 2>&1" }],
	["for f in a b; do wc -l $f; done > /dev/null", { text: "wc -l a; wc -l b > /dev/null" }],
	["for f in a b; do wc -l $f; done > src/x", { problem: "writes output to a file (only /dev/null or a file in the scratch dir is allowed)" }],
	["for f in a b; do wc -l $f; done | sh", { text: "wc -l a; wc -l b | sh" }],
	["for f in a b; do wc -l $f; done | sort | head", { text: "wc -l a; wc -l b | sort | head" }],
	["for f in a b; do wc -l $f; done | sort | uniq -c", { text: "wc -l a; wc -l b | sort | uniq -c" }],
	["for f in a b; do wc -l $f; done | sort | sh", { text: "wc -l a; wc -l b | sort | sh" }],
	["for f in a b; do wc -l $f; done | sort | head > " + SCRATCH + "/o", { text: "wc -l a; wc -l b | sort | head > " + SCRATCH + "/o" }],
	["for f in a b; do wc -l $f; done | sort | head && echo ok", { text: "wc -l a; wc -l b | sort | head && echo ok" }],
	["for f in a b; do wc -l $f; done | sort | head &", { problem: PROBLEMS.loopPipeTail }],
	["for f in a b; do wc -l $f; done | sort | while read l; do echo $l; done", { problem: PROBLEMS.keyword("while") }],
	["for f in a b; do wc -l $f; done | sort | for g in c; do cat $g; done", { problem: PROBLEMS.loopPosition("|") }],
	["for f in a b; do wc -l $f; done | sort | done", { problem: PROBLEMS.loopTrailer }],
	["for f in a b; do wc -l $f; done | sort | x=a", { problem: PROBLEMS.position("x", "|") }],
	["for f in a b; do wc -l $f; done | sort | wc -l < c", { problem: PROBLEMS.inputPipe }],
	["for f in a b; do wc -l $f; done | sort >", { problem: PROBLEMS.redirectTarget }],
	["for f in a b; do cd $f; done | sort | head", { problem: PROBLEMS.loopPipeCd("cd") }],
	["for f in a b; do wc -l $f; done | sort && echo ok", { text: "wc -l a; wc -l b | sort && echo ok" }],
	["for f in a b; do cd $f; done", { text: "cd a; cd b" }],
	["for f in a b; do cd $f; done | sort", { problem: PROBLEMS.loopPipeCd("cd") }],
	["for f in a b; do pushd $f; done | sort", { problem: PROBLEMS.loopPipeCd("pushd") }],
	["for f in a b; do cd $f; done > /dev/null", { text: "cd a; cd b > /dev/null" }],
	["x | for f in a; do cat $f; done", { problem: PROBLEMS.loopPosition("|") }],
	["x & for f in a; do cat $f; done", { problem: PROBLEMS.loopPosition("&") }],
	["for f in a b; do cat $f; done &", { problem: PROBLEMS.loopAfter("&") }],
	["for f in a b; do cat $f; done | sort &", { problem: PROBLEMS.loopPipeTail }],
	["for f in a b; do cat $f; done < in", { problem: PROBLEMS.loopTrailer }],
	["for f in a b; do cat $f; done; cat $f", { problem: PROBLEMS.use("f") }],
	["for f in a b; do cat $f; done > " + SCRATCH + "/$f", { problem: PROBLEMS.use("f") }],
	["for f in a b; do cat $f; done extra", { problem: PROBLEMS.loopTrailer }],
]);

test("loop limits", () => {
	const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
	check(`for f in ${words(MAX_LOOP_WORDS)}; do cat $f; done`, {
		text: Array.from({ length: MAX_LOOP_WORDS }, (_, i) => `cat w${i}`).join("; "),
	});
	check(`for f in ${words(MAX_LOOP_WORDS + 1)}; do cat $f; done`, { problem: PROBLEMS.loopMany(MAX_LOOP_WORDS + 1) });
	check("for f in ; do cat $f; done", { problem: PROBLEMS.loopEmpty });

	// 4 * 16 bodies expand, one more does not
	const loop = `for f in ${words(16)}; do cat $f; done`;
	assert.equal(MAX_LOOP_BODIES, 64);
	assert.equal(expandCommand(`${loop}; ${loop}; ${loop}; ${loop}`, options).problem, undefined);
	check(`${loop}; ${loop}; ${loop}; ${loop}; for g in a; do cat $g; done`, { problem: PROBLEMS.loopBodies });
	// nested loops count their inner bodies once per outer copy
	check("for f in a b c d e f g h; do for g in 1 2 3 4 5 6 7 8; do cat $f$g; done; done", { problem: PROBLEMS.loopBodies });

	const longWord = "a".repeat(100);
	const long = `for f in ${Array.from({ length: 16 }, (_, i) => `${i}${longWord}`).join(" ")}; do cat $f $f $f $f; done`;
	assert.ok(expandCommand(long, options).problem === undefined);
	const longer = `for f in ${Array.from({ length: 16 }, (_, i) => `${i}${"a".repeat(2500)}`).join(" ")}; do cat $f; done`;
	assert.equal(expandCommand(longer, options).problem, PROBLEMS.tooLong);
	assert.ok(MAX_COMMAND_LENGTH >= 10_000);
});

table("for loops: rules on the loop itself", [
	// names
	["for X in a; do cat $X; done", { problem: PROBLEMS.nameForm("X") }],
	["for path in a; do cat $path; done", { problem: PROBLEMS.nameSpecial("path") }],
	["for _ in a; do cat; done", { problem: PROBLEMS.nameUnderscore }],
	["x=a; for x in b; do cat $x; done", { problem: PROBLEMS.rebind("x") }],
	["for f in a; do for f in b; do cat $f; done; done", { problem: PROBLEMS.rebind("f") }],
	// words
	["for f in a*; do cat $f; done", { problem: PROBLEMS.globNeedsGrant }],
	["for f in -a; do cat $f; done", { problem: PROBLEMS.loopWord }],
	["for f in $g; do cat $f; done", { problem: PROBLEMS.loopWord }],
	["g=a; for f in $g b; do cat $f; done", { text: "cat a; cat b" }],
	["for f in a b; do cat $f; done; for f in c; do cat $f; done", { text: "cat a; cat b; cat c" }],
	// shape
	["for f; do cat $f; done", { problem: PROBLEMS.loopSyntax }],
	["for f in a b; cat $f; done", { problem: PROBLEMS.loopSyntax }],
	["for f in a b; do cat $f", { problem: PROBLEMS.loopSyntax }],
	["for f in a b; do done", { problem: PROBLEMS.loopSyntax }],
	["for f in a b && do cat $f; done", { problem: PROBLEMS.loopSyntax }],
	["for f in a b; do cat $f &\ndone", { problem: PROBLEMS.loopSyntax }],
	["for f in a b; do cat $f; done; done", { problem: PROBLEMS.keyword("done") }],
	// body
	["for f in a b; do x=1; cat $f; done", { problem: PROBLEMS.bodyAssign }],
	["for f in a b; do x=1 cat $f; done", { problem: PROBLEMS.bodyAssign }],
	["for f in a b; do cat $f; x=1; done", { problem: PROBLEMS.bodyAssign }],
	["for f in a b; do cat $f; break; done", { problem: PROBLEMS.loopJump("break") }],
	["for f in a b; do continue; done", { problem: PROBLEMS.loopJump("continue") }],
	["for f in a b; do cat $f && break; done", { problem: PROBLEMS.loopJump("break") }],
	["for f in a b; do echo break; done", { text: "echo break; echo break" }],
	["for f in a b; do if true; then cat $f; fi; done", { problem: PROBLEMS.keyword("if") }],
	["for f in a b; do while true; do cat $f; done; done", { problem: PROBLEMS.keyword("while") }],
	["for f in a b; do read x; done", { problem: PROBLEMS.rootBuiltin("read") }],
	["for f in a b; do $f; done", { text: "a; b" }],
	// position of a loop relative to assignments
	["test -d d && for f in a; do cat $f; done; x=1; cat $x", { text: "test -d d && cat a; cat 1" }],
]);

test("no leftover use of a bound name, in any quoting context", () => {
	check("x=a; cat \"$x\" '$x' ${x}", { text: "cat \"a\" '$x' a" });
	check("for f in a; do echo $f; done; echo \"$f\"", { problem: PROBLEMS.use("f") });
	check("for f in a; do echo $f; done; echo '$f'", { text: "echo a; echo '$f'" });
	assert.deepEqual(expandCommand("x=a cat; echo $x", options), { text: "x=a cat; echo $x", changed: false });
	check("x=a cat; y=b; echo $x", { problem: PROBLEMS.use("x") });
});

// --- input redirect: `cmd < path` is judged as `cat path | cmd` --------------

table("input redirect: expansion", [
	["wc -l < src/a.ts", { text: "cat src/a.ts | wc -l" }],
	['wc -l < "a.ts"', { text: "cat a.ts | wc -l" }],
	["wc -l < 'a.ts'", { text: "cat a.ts | wc -l" }],
	["wc -l <a.ts", { text: "cat a.ts | wc -l" }],
	["wc -l< a.ts", { text: "cat a.ts | wc -l" }],
	["< a.ts wc -l", { text: "cat a.ts | wc -l" }],
	["wc -l < a.ts > " + SCRATCH + "/o", { text: "cat a.ts | wc -l > " + SCRATCH + "/o" }],
	["wc -l > " + SCRATCH + "/o < a.ts", { text: "cat a.ts | wc -l > " + SCRATCH + "/o" }],
	["wc -l < a.ts 2>&1", { text: "cat a.ts | wc -l 2>&1" }],
	["wc -l < a.ts | sort", { text: "cat a.ts | wc -l | sort" }],
	["echo hi; wc -l < a.ts; echo end", { text: "echo hi; cat a.ts | wc -l; echo end" }],
	["true && wc -l < a.ts || echo no", { text: "true && cat a.ts | wc -l || echo no" }],
	["x=a; wc -l < $x", { text: "cat a | wc -l" }],
	["x=a; wc -l < ${x}b", { text: "cat ab | wc -l" }],
	["FOO=1 wc -l < a.ts", { text: "cat a.ts | FOO=1 wc -l" }],
	["for f in a b; do wc -l < $f; done", { text: "cat a | wc -l; cat b | wc -l" }],
	["for f in a b; do wc -l < src/$f.ts; done > " + SCRATCH + "/o", { text: "cat src/a.ts | wc -l; cat src/b.ts | wc -l > " + SCRATCH + "/o" }],
	["for f in a b; do wc -l < $f; done | sort", { text: "cat a | wc -l; cat b | wc -l | sort" }],
]);

table("input redirect: near-miss and twin per rule", [
	// the path is a plain literal
	["wc -l < $x", { problem: PROBLEMS.inputPath }],
	['x=a; wc -l < "$x"', { text: 'cat a | wc -l' }],
	['x=a; wc -l < "$x".c', { problem: PROBLEMS.inputPath }],
	["wc -l < *.ts", { problem: PROBLEMS.inputPath }],
	["wc -l < a?", { problem: PROBLEMS.inputPath }],
	["wc -l < -a", { problem: PROBLEMS.inputPath }],
	["wc -l < ~/a", { problem: PROBLEMS.inputPath }],
	["wc -l < 'a b'", { problem: PROBLEMS.inputPath }],
	["wc -l < a=b", { problem: PROBLEMS.inputPath }],
	["wc -l < a,b", { problem: PROBLEMS.inputPath }],
	["wc -l < a-b", { text: "cat a-b | wc -l" }],
	["wc -l < ./a", { text: "cat ./a | wc -l" }],
	// forms
	["x=a; wc -l <& 3", { problem: PROBLEMS.inputForm }],
	["x=a; wc -l <> f", { problem: PROBLEMS.inputForm }],
	["wc -l 3< f", { problem: PROBLEMS.inputForm }],
	["wc -l < f", { text: "cat f | wc -l" }],
	["x=a; wc -l <(ls)", { problem: PROBLEMS.brackets }],
	["x=a; wc -l <<< a", { problem: PROBLEMS.heredoc }],
	["x=a; wc -l << EOF\na\nEOF", { problem: PROBLEMS.heredoc }],
	["wc -l <", { problem: PROBLEMS.redirectTarget }],
	["wc -l < > a", { problem: PROBLEMS.redirectTarget }],
	["wc -l > < a", { problem: PROBLEMS.redirectTarget }],
	// one input per command
	["wc -l < a < b", { problem: PROBLEMS.inputMany }],
	["wc -l < a; wc -l < b", { text: "cat a | wc -l; cat b | wc -l" }],
	// not a later stage of a pipe
	["sort | wc -l < a", { problem: PROBLEMS.inputPipe }],
	["wc -l < a | sort", { text: "cat a | wc -l | sort" }],
	["for f in a b; do sort | wc -l < $f; done", { problem: PROBLEMS.inputPipe }],
	["for f in a b; do cat $f; done | wc -l < c", { problem: PROBLEMS.inputPipe }],
	["wc -l < a & wc -l < b", { text: "cat a | wc -l & cat b | wc -l" }],
	// the root is not a compound keyword, builtin or loop trailer
	["while read x; do wc -l; done < f", { problem: PROBLEMS.keyword("while") }],
	["if true; then wc -l < a; fi", { problem: PROBLEMS.keyword("if") }],
	["for f in a b; do cat $f; done < in", { problem: PROBLEMS.loopTrailer }],
	["for f in a b < in; do cat $f; done", { problem: PROBLEMS.loopSyntax }],
	["read x < f", { problem: PROBLEMS.rootBuiltin("read") }],
	["x=a < f", { problem: PROBLEMS.assignMany }],
]);

test("a plain command with no construct is unchanged, also with `<` in quotes or comments", () => {
	for (const command of ["wc -l a", "cat a > /dev/null", "echo '<' a", 'echo "a < b"', "echo a # < b", "cat <<EOF\nx\nEOF", "wc -l <<< a"]) {
		assert.deepEqual(expandCommand(command, options), { text: command, changed: false }, command);
	}
});

// --- glob loops ---------------------------------------------------------

const roots: string[] = [];

/** A temp dir holding `files` (a trailing `/` makes a directory); removed at exit. */
function fixture(files: readonly string[]): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pk-program-glob-")));
	roots.push(dir);
	for (const file of files) {
		if (file.endsWith("/")) mkdirSync(join(dir, file), { recursive: true });
		else {
			mkdirSync(dirname(join(dir, file)), { recursive: true });
			writeFileSync(join(dir, file), "");
		}
	}
	return dir;
}

after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function globCheck(dir: string, command: string, expected: Expect, extra: { globs?: boolean; scratch?: string } = {}): void {
	const got = expandCommand(command, { cwd: dir, scratch: extra.scratch ?? SCRATCH, env: {}, globs: extra.globs ?? true });
	if ("text" in expected) {
		assert.equal(got.problem, undefined, `unexpected problem for ${JSON.stringify(command)}`);
		assert.equal(got.text, expected.text, `text for ${JSON.stringify(command)}`);
		assert.equal(got.changed, true);
	} else {
		assert.equal(got.problem, expected.problem, `problem for ${JSON.stringify(command)}`);
		assert.equal(got.text, command, "a refusal returns the original text");
		assert.equal(got.changed, false);
	}
}

test("glob loops: the grant", () => {
	const dir = fixture(["m1.log", "m2.log"]);
	const loop = "for f in *.log; do wc -l $f; done";
	globCheck(dir, loop, { problem: PROBLEMS.globNeedsGrant }, { globs: false });
	assert.equal(expandCommand(loop, { cwd: dir, env: {} }).problem, PROBLEMS.globNeedsGrant);
	globCheck(dir, loop, { text: "wc -l m1.log; wc -l m2.log" }, { globs: true });
	// a literal loop and a plain command never need the grant
	globCheck(dir, "for f in a b; do wc -l $f; done", { text: "wc -l a; wc -l b" }, { globs: false });
	assert.deepEqual(expandCommand("wc -l *.log", { cwd: dir, env: {} }), { text: "wc -l *.log", changed: false });
	// a quoted glob character is a literal word, as before
	globCheck(dir, "for f in '*.log'; do wc -l $f; done", { problem: PROBLEMS.loopWord });
	// without the grant the grant problem comes before the word rules
	globCheck(dir, "for f in *.log -a; do wc -l $f; done", { problem: PROBLEMS.globNeedsGrant }, { globs: false });
	globCheck(dir, "for f in *.log -a; do wc -l $f; done", { problem: PROBLEMS.loopWord });
});

test("glob loops: bash matching rules", () => {
	const dir = fixture(["m1.log", "m2.log", "m3.log", ".hid.log", "b.txt", "sub/s1.md", "sub/s2.md", "sub/.h.md", "B.txt", "Z.txt", "_x.txt", "a.txt"]);
	const txt = "wc -l B.txt; wc -l Z.txt; wc -l _x.txt; wc -l a.txt; wc -l b.txt";
	globCheck(dir, "for f in m*.log; do wc -l $f; done", { text: "wc -l m1.log; wc -l m2.log; wc -l m3.log" });
	// dotfiles only for a segment that starts with a dot
	globCheck(dir, "for f in *.log; do wc -l $f; done", { text: "wc -l m1.log; wc -l m2.log; wc -l m3.log" });
	globCheck(dir, "for f in .h*; do wc -l $f; done", { text: "wc -l .hid.log" });
	globCheck(dir, "for f in sub/*.md; do wc -l $f; done", { text: "wc -l sub/s1.md; wc -l sub/s2.md" });
	globCheck(dir, "for f in sub/.h*; do wc -l $f; done", { text: "wc -l sub/.h.md" });
	// byte order of the C locale: capitals, underscore, lower case
	globCheck(dir, "for f in *.txt; do wc -l $f; done", { text: txt });
	globCheck(dir, "for f in [A-Za-z_]*.txt; do wc -l $f; done", { text: txt });
	// sets, ranges, negation, `?`
	globCheck(dir, "for f in m[12].log; do wc -l $f; done", { text: "wc -l m1.log; wc -l m2.log" });
	globCheck(dir, "for f in m[!12].log; do wc -l $f; done", { text: "wc -l m3.log" });
	globCheck(dir, "for f in m[^12].log; do wc -l $f; done", { text: "wc -l m3.log" });
	globCheck(dir, "for f in m[1-2].log; do wc -l $f; done", { text: "wc -l m1.log; wc -l m2.log" });
	globCheck(dir, "for f in m?.log; do wc -l $f; done", { text: "wc -l m1.log; wc -l m2.log; wc -l m3.log" });
	globCheck(dir, "for f in ?.txt; do wc -l $f; done", { text: "wc -l B.txt; wc -l Z.txt; wc -l a.txt; wc -l b.txt" });
	// a glob in a loop with literal words, and a variable in the pattern
	globCheck(dir, "for f in z m1.* y; do wc -l $f; done", { text: "wc -l z; wc -l m1.log; wc -l y" });
	globCheck(dir, "d=sub; for f in $d/*.md; do wc -l $f; done", { text: "wc -l sub/s1.md; wc -l sub/s2.md" });
	globCheck(dir, "for f in *.md *.log; do wc -l $f; done", { problem: PROBLEMS.globNone("*.md") });
	// the loop variable is gone after done
	globCheck(dir, "for f in m*.log; do wc -l $f; done; cat $f", { problem: PROBLEMS.use("f") });
	// the body gets each match as a literal, nested loops and trailers included
	globCheck(dir, "for f in m[12].log; do for g in a; do cat $f$g; done; done", { text: "cat m1.loga; cat m2.loga" });
	globCheck(dir, "for f in m[12].log; do wc -l $f; done | sort", { text: "wc -l m1.log; wc -l m2.log | sort" });
});

test("glob loops: pattern shape, near-miss and twin", () => {
	const dir = fixture(["a.c", "sub/s1.md", "sub/s2.md", "m1.log"]);
	// wildcards only in the last segment
	globCheck(dir, "for f in */s1.md; do wc -l $f; done", { problem: PROBLEMS.globDir });
	globCheck(dir, "for f in s?b/s1.md; do wc -l $f; done", { problem: PROBLEMS.globDir });
	globCheck(dir, "for f in sub/s*.md; do wc -l $f; done", { text: "wc -l sub/s1.md; wc -l sub/s2.md" });
	// no `**`
	globCheck(dir, "for f in **; do wc -l $f; done", { problem: PROBLEMS.globStar });
	globCheck(dir, "for f in sub/**.md; do wc -l $f; done", { problem: PROBLEMS.globStar });
	globCheck(dir, "for f in *.c; do wc -l $f; done", { text: "wc -l a.c" });
	// classes, quoted or odd words
	globCheck(dir, "for f in [[:alpha:]]*.c; do wc -l $f; done", { problem: PROBLEMS.globClass });
	globCheck(dir, "for f in [a-z]*.c; do wc -l $f; done", { text: "wc -l a.c" });
	globCheck(dir, "for f in 'a'*.c; do wc -l $f; done", { problem: PROBLEMS.globWord });
	globCheck(dir, 'for f in "a".*; do wc -l $f; done', { problem: PROBLEMS.globWord });
	globCheck(dir, "for f in a*; do wc -l $f; done", { text: "wc -l a.c" });
	globCheck(dir, "for f in ~/*.c; do wc -l $f; done", { problem: PROBLEMS.globWord });
	globCheck(dir, "for f in [a; do wc -l $f; done", { problem: PROBLEMS.globWord });
	globCheck(dir, "for f in $d/*.c; do wc -l $f; done", { problem: PROBLEMS.globWord });
	// a pattern that can match `.` or `..`
	globCheck(dir, "for f in .*; do wc -l $f; done", { problem: PROBLEMS.globWord });
	// matches
	globCheck(dir, "for f in *.zzz; do wc -l $f; done", { problem: PROBLEMS.globNone("*.zzz") });
	globCheck(dir, "for f in nodir/*; do wc -l $f; done", { problem: PROBLEMS.globNone("nodir/*") });
});

test("glob loops: limits on the matches", () => {
	// a match that starts with `-`
	const dash = fixture(["-x.log", "y.log"]);
	globCheck(dash, "for f in *.log; do wc -l $f; done", { problem: PROBLEMS.globDash("-x.log") });
	globCheck(dash, "for f in ./*.log; do wc -l $f; done", { text: "wc -l ./-x.log; wc -l ./y.log" });
	globCheck(dash, "for f in [!-]*.log; do wc -l $f; done", { text: "wc -l y.log" });
	// a character outside the plain set
	const odd = fixture(["ok.log", "we=ird.log", "o'q.txt", "dollar$.txt"]);
	globCheck(odd, "for f in *.log; do wc -l $f; done", { problem: PROBLEMS.globChars("we=ird.log") });
	globCheck(odd, "for f in o*.log; do wc -l $f; done", { text: "wc -l ok.log" });
	globCheck(odd, "for f in o*.txt; do wc -l $f; done", { problem: PROBLEMS.globChars("o'q.txt") });
	globCheck(odd, "for f in d*; do wc -l $f; done", { problem: PROBLEMS.globChars("dollar$.txt") });
	// a space is fine when every use of the variable is inside double quotes
	const sp = fixture(["a.txt", "sp ace.txt"]);
	globCheck(sp, "for f in *.txt; do wc -l $f; done", { problem: PROBLEMS.globChars("sp ace.txt") });
	globCheck(sp, 'for f in *.txt; do wc -l "$f"; done', { text: 'wc -l "a.txt"; wc -l "sp ace.txt"' });
	globCheck(sp, 'for f in *.txt; do wc -l "x $f"; echo "${f}"; done', { text: 'wc -l "x a.txt"; echo "a.txt"; wc -l "x sp ace.txt"; echo "sp ace.txt"' });
	globCheck(sp, 'for f in *.txt; do wc -l "$f" $f; done', { problem: PROBLEMS.globChars("sp ace.txt") });
	globCheck(sp, 'for f in *.txt; do wc -l "$f" > $f; done', { problem: PROBLEMS.globChars("sp ace.txt") });
	globCheck(sp, "for f in a*; do wc -l $f; done", { text: "wc -l a.txt" });
});

test("glob loops: the directory and the scratch dir", () => {
	const dir = fixture(["sub/s1.md", "sc/o1", "sc/o2", "a.txt"]);
	const scratch = join(dir, "sc");
	globCheck(dir, "for f in sc/*; do wc -l $f; done", { problem: PROBLEMS.globScratch }, { scratch });
	globCheck(dir, "for f in sc/o*; do wc -l $f; done", { problem: PROBLEMS.globScratch }, { scratch });
	globCheck(dir, "for f in sub/*; do wc -l $f; done", { text: "wc -l sub/s1.md" }, { scratch });
	// a scratch dir that is not the listed one
	globCheck(dir, "for f in sc/*; do wc -l $f; done", { text: "wc -l sc/o1; wc -l sc/o2" }, { scratch: join(dir, "elsewhere") });
	// the cwd is the scratch dir
	globCheck(scratch, "for f in *; do wc -l $f; done", { problem: PROBLEMS.globScratch }, { scratch });
	// a link into the scratch dir
	const link = fixture([]);
	symlinkSync(scratch, join(link, "ln"));
	globCheck(link, "for f in ln/*; do wc -l $f; done", { problem: PROBLEMS.globScratch }, { scratch });
});

test("glob loops: nothing earlier may change what the glob names", () => {
	const dir = fixture(["a.c", "sub/s1.md"]);
	const loop = "for f in *.c; do wc -l $f; done";
	for (const word of ["cd", "pushd", "popd"]) {
		globCheck(dir, `${word} sub; ${loop}`, { problem: PROBLEMS.globCd(word) });
		globCheck(dir, `${word} sub && ${loop}`, { problem: PROBLEMS.globCd(word) });
		globCheck(dir, `true || ${word} sub; ${loop}`, { problem: PROBLEMS.globCd(word) });
	}
	globCheck(dir, `echo cd sub; ${loop}`, { text: "echo cd sub; wc -l a.c" });
	globCheck(dir, `for d in sub; do cd $d; done; ${loop}`, { problem: PROBLEMS.globCd("cd") });
	globCheck(dir, `${loop}; cd sub`, { text: "wc -l a.c; cd sub" });
	// anything that is not read-only, scratch writes included
	globCheck(dir, `touch n; ${loop}`, { problem: PROBLEMS.globWrite("touch n") });
	globCheck(dir, `rm a.c; ${loop}`, { problem: PROBLEMS.globWrite("rm a.c") });
	globCheck(dir, `echo hi > ${SCRATCH}/o; ${loop}`, { problem: PROBLEMS.globWrite(`echo hi > ${SCRATCH}/o`) });
	globCheck(dir, `for g in a b; do touch $g; done; ${loop}`, { problem: PROBLEMS.globWrite("touch $g") });
	globCheck(dir, `for g in a b; do wc -l $g; done > ${SCRATCH}/o; ${loop}`, { problem: PROBLEMS.globWrite(`true > ${SCRATCH}/o`) });
	globCheck(dir, `wc -l a.c; echo hi > /dev/null; ${loop}`, { text: "wc -l a.c; echo hi > /dev/null; wc -l a.c" });
	globCheck(dir, `wc -l < a.c; ${loop}`, { text: "cat a.c | wc -l; wc -l a.c" });
	globCheck(dir, `x=a; for g in b c; do wc -l $g; done; ${loop}`, { text: "wc -l b; wc -l c; wc -l a.c" });
	// a later unit does not matter for a top-level loop
	globCheck(dir, `${loop}; touch n`, { text: "wc -l a.c; touch n" });
	// inside another loop, units after this loop run before the next copy
	globCheck(dir, "for d in sub; do for f in $d/*.md; do wc -l $f; done; done", { text: "wc -l sub/s1.md" });
	globCheck(dir, "for d in sub; do for f in $d/*.md; do wc -l $f; done; touch x; done", { problem: PROBLEMS.globWrite("touch x") });
	globCheck(dir, "for d in sub; do for f in $d/*.md; do wc -l $f; done; cd ..; done", { problem: PROBLEMS.globCd("cd") });
	globCheck(dir, "for d in sub; do wc -l $d; for f in $d/*.md; do wc -l $f; done; done", { text: "wc -l sub; wc -l sub/s1.md" });
});

test("glob loops: the word and body limits", () => {
	const many = (n: number) => Array.from({ length: n }, (_, i) => `n${String(i).padStart(2, "0")}`);
	const dir = fixture(many(MAX_GLOB_WORDS + 1));
	assert.equal(MAX_GLOB_WORDS, 64);
	globCheck(dir, "for f in n*; do wc -l $f; done", { problem: PROBLEMS.globMany(MAX_GLOB_WORDS + 1) });
	globCheck(dir, "for f in n[0-5]*; do wc -l $f; done", { text: many(60).map((n) => `wc -l ${n}`).join("; ") });
	const edge = fixture(many(MAX_GLOB_WORDS));
	globCheck(edge, "for f in n*; do wc -l $f; done", { text: many(MAX_GLOB_WORDS).map((n) => `wc -l ${n}`).join("; ") });
	// the 64-bodies total cap still holds
	globCheck(edge, "for f in n*; do wc -l $f; done; for g in a; do wc -l $g; done", { problem: PROBLEMS.loopBodies });
	// a literal word list keeps the 16 cap
	const words = Array.from({ length: MAX_LOOP_WORDS + 1 }, (_, i) => `w${i}`).join(" ");
	globCheck(edge, `for f in ${words}; do cat $f; done`, { problem: PROBLEMS.loopMany(MAX_LOOP_WORDS + 1) });
	globCheck(edge, `for f in ${words} n0*; do cat $f; done`, { text: [...words.split(" "), ...many(10)].map((n) => `cat ${n}`).join("; ") });
});

// ---------------------------------------------------------------------------
// Static python (plan D6): one near-miss per segment rule, each with its twin
// ---------------------------------------------------------------------------

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const pyRoot = realpathSync(mkdtempSync(join(tmpdir(), "pk-program-py-")));
const pyScratch = join(pyRoot, "scratch");
mkdirSync(pyScratch);
mkdirSync(join(pyRoot, "data"));
writeFileSync(join(pyRoot, "data", "a.json"), "{}\n");
after(() => rmSync(pyRoot, { recursive: true, force: true }));
const pyEnv = { PATH: process.env.PATH };

function pyCheck(command: string, expected: Expect): void {
	const got = expandCommand(command, { cwd: pyRoot, scratch: pyScratch, env: pyEnv });
	if ("text" in expected) {
		assert.equal(got.problem, undefined, `unexpected problem for ${JSON.stringify(command)}`);
		assert.equal(got.text, expected.text, `text for ${JSON.stringify(command)}`);
		assert.equal(got.changed, true);
	} else {
		assert.equal(got.problem, expected.problem, `problem for ${JSON.stringify(command)}`);
		assert.equal(got.text, command, "a refusal returns the original text");
		assert.equal(got.changed, false);
	}
}

const READ = `python3 -c 'print(open("data/a.json").read())'`;

test("python: the supported forms become their effect program", { skip: hasPython ? false : "python3 is not installed" }, () => {
	const rows: ReadonlyArray<readonly [string, Expect]> = [
		[READ, { text: "cat -- 'data/a.json'" }],
		["python3 -c 'print(1)'", { text: "true" }],
		[`python3 - <<'EOF'\nprint(open("data/a.json").read())\nEOF`, { text: "cat -- 'data/a.json'" }],
		[`python3 <<'EOF'\nprint(open("data/a.json").read())\nEOF`, { text: "cat -- 'data/a.json'" }],
		[`python3 - <<'EOF'\nprint(open("data/a.json").read())\nEOF\nls data`, { text: "cat -- 'data/a.json'\nls data" }],
		[`${READ} && ls data`, { text: "cat -- 'data/a.json' && ls data" }],
		[`ls data; ${READ}`, { text: "ls data; cat -- 'data/a.json'" }],
		[`${READ} | head`, { text: "cat -- 'data/a.json' | head" }],
		[`python3 -c 'import glob; print(glob.glob("data/*.json"))'`, { text: "ls -- data/*.json" }],
		[`python3 -c 'import os; print(os.listdir("data"))'`, { text: "ls -- 'data'" }],
		[`python3 -c 'open("${pyScratch}/o", "w").write("x")'`, { text: `touch -- '${pyScratch}/o'` }],
		[`for f in a b; do ${READ}; done`, { text: "cat -- 'data/a.json'; cat -- 'data/a.json'" }],
		[`for f in a b; do python3 - <<'EOF'\nprint(open("data/a.json").read())\nEOF\ndone`, { text: "cat -- 'data/a.json'; cat -- 'data/a.json'" }],
		[`for f in a b; do ${READ}; done | sort | uniq -c`, { text: "cat -- 'data/a.json'; cat -- 'data/a.json' | sort | uniq -c" }],
		["x=a; " + READ, { text: "cat -- 'data/a.json'" }],
	];
	for (const [command, expected] of rows) pyCheck(command, expected);
});

test("python: near-misses are refused with their problem, twins expand", { skip: hasPython ? false : "python3 is not installed" }, () => {
	const rows: ReadonlyArray<readonly [string, Expect]> = [
		// double quotes
		[`python3 -c "print(1)"`, { problem: PROBLEMS.pyDouble }],
		// extra argv, redirect, background
		[`${READ} a.txt`, { problem: PROBLEMS.pyArgv }],
		[`${READ} > out`, { problem: PROBLEMS.pyArgv }],
		[`${READ} < in`, { problem: PROBLEMS.pyArgv }],
		[`${READ} 2>&1`, { problem: PROBLEMS.pyArgv }],
		[`${READ} &`, { problem: PROBLEMS.pyBackground }],
		[`${READ} # c`, { problem: PROBLEMS.pyArgv }],
		[`${READ};; ls`, { problem: PROBLEMS.pyArgv }],
		// heredoc forms
		[`python3 - <<EOF\nprint(1)\nEOF`, { problem: PROBLEMS.pyHeredoc }],
		[`python3 - <<"EOF"\nprint(1)\nEOF`, { problem: PROBLEMS.pyHeredoc }],
		[`python3 - <<-'EOF'\nprint(1)\nEOF`, { problem: PROBLEMS.pyHeredoc }],
		[`python3 - <<< 'print(1)'`, { problem: PROBLEMS.pyHeredoc }],
		[`python3 - <<'EOF' && ls\nprint(1)\nEOF`, { problem: PROBLEMS.pyHeredoc }],
		[`python3 - <<'EOF'\nprint(1)\n EOF`, { problem: PROBLEMS.pyHeredocOpen }],
		[`python3 - <<'EOF'\nprint(1)`, { problem: PROBLEMS.pyHeredocOpen }],
		[`python3 - <<'EOF'`, { problem: PROBLEMS.pyHeredocOpen }],
		// after a pipe
		[`ls | ${READ}`, { problem: PROBLEMS.pyPipe }],
		[`ls |& ${READ}`, { problem: PROBLEMS.pyPipe }],
		[`ls | python3 - <<'EOF'\nprint(1)\nEOF`, { problem: PROBLEMS.pyPipe }],
		[`ls || ${READ}`, { text: "ls || cat -- 'data/a.json'" }],
		// the run directory
		[`cd data && ${READ}`, { problem: PROBLEMS.pyDir("cd") }],
		[`c''d data; ${READ}`, { problem: PROBLEMS.pyDir("cd") }],
		[`pushd data; ${READ}`, { problem: PROBLEMS.pyDir("pushd") }],
		[`for f in a b; do ${READ}; cd data; done`, { problem: PROBLEMS.pyDir("cd") }],
		[`${READ}; cd data`, { text: "cat -- 'data/a.json'; cd data" }],
		// an analyzer problem refuses the whole command
		[`python3 -c 'import requests'`, { problem: "python: import requests is not on the allow-list" }],
		[`python3 -c 'import os; os.system("ls")'`, { problem: "python: os.system is not on the allow-list" }],
		// not our form: today's answer, no problem
		["python -c 'print(1)'", { problem: "" }],
	];
	for (const [command, expected] of rows) {
		if ("problem" in expected && expected.problem === "") {
			assert.deepEqual(expandCommand(command, { cwd: pyRoot, scratch: pyScratch, env: pyEnv }), { text: command, changed: false }, command);
		} else {
			pyCheck(command, expected);
		}
	}
});

test("python: other interpreters, wrappers, prefixes, modules and files keep today's answer", () => {
	for (const command of [
		"python -c 'print(1)'",
		"python3.11 -c 'print(1)'",
		"python3 -m json.tool a.json",
		"python3 x.py",
		"python3",
		"env python3 -c 'print(1)'",
		"PYTHONPATH=src python3 -c 'print(1)'",
		"time python3 -c 'print(1)'",
		"sudo python3 -c 'print(1)'",
		"echo do python3 -c 'print(1)'",
		"echo 'python3 -c \"print(1)\"'",
		"ls # python3 -c 'print(1)'",
	]) {
		assert.deepEqual(expandCommand(command, { cwd: pyRoot, scratch: pyScratch, env: pyEnv }), { text: command, changed: false }, command);
	}
});

test("python: a `<<` that is not a python segment keeps its refusal", { skip: hasPython ? false : "python3 is not installed" }, () => {
	pyCheck(`cat <<'EOF'\nhi\nEOF\n${READ}`, { problem: PROBLEMS.heredoc });
	pyCheck(`${READ}; cat <<EOF\nhi\nEOF`, { problem: PROBLEMS.heredoc });
	pyCheck(`${READ}; wc -l <<< a`, { problem: PROBLEMS.heredoc });
});

test("python: a path that cannot be quoted refuses", { skip: hasPython ? false : "python3 is not installed" }, () => {
	pyCheck(`python3 -c 'print(open("a b").read())'`, { text: "cat -- 'a b'" });
	pyCheck(`python3 -c 'print(open("a(1)").read())'`, { problem: PROBLEMS.brackets });
	pyCheck(`python3 -c 'import glob; print(glob.glob("a b/*"))'`, { problem: PROBLEMS.pyPath("a b/*") });
});

test("python: literal-list and listing loops, and the while switch", { skip: hasPython ? false : "python3 is not installed" }, () => {
	pyCheck(`python3 -c 'for n in ["a.json", "b.json"]: print(open("data/" + n).read())'`, { text: "cat -- 'data/a.json' 'data/b.json'" });
	pyCheck(`python3 -c 'import glob\nfor f in glob.glob("data/*.json"): print(open(f).read())'`, { text: "cat -- data/*.json; ls -- data/*.json" });
	pyCheck(`python3 -c 'import os\nfor n in os.listdir("data"): print(os.path.getsize("data/" + n))'`, { text: "cat -- data/*; ls -- 'data'" });
	pyCheck(`python3 -c 'from pathlib import Path\nfor p in Path("data").glob("*.json"): print(p.read_text())'`, { text: "cat -- data/*.json; ls -- data/*.json" });
	const whileCmd = `python3 -c 'n = 2\nwhile n: n -= 1'`;
	pyCheck(whileCmd, { problem: "python: a `while` loop may not end or may fill memory, so it needs the session option" });
	const on = expandCommand(whileCmd, { cwd: pyRoot, scratch: pyScratch, env: pyEnv, pythonWhile: true });
	assert.deepEqual(on, { text: "true", changed: true });
	const pow = expandCommand(`python3 -c 'n = 2\nwhile n: n = n ** 2'`, { cwd: pyRoot, scratch: pyScratch, env: pyEnv, pythonWhile: true });
	assert.match(pow.problem ?? "", /can run without end or fill memory/);
	assert.equal(pow.changed, false);
});

test("python: dotfile patterns become the dotfiles that exist", { skip: hasPython ? false : "python3 is not installed" }, () => {
	mkdirSync(join(pyRoot, "dots"), { recursive: true });
	writeFileSync(join(pyRoot, "dots", "x.json"), "{}\n");
	writeFileSync(join(pyRoot, "dots", ".env"), "T=1\n");
	writeFileSync(join(pyRoot, "dots", ".hid.json"), "{}\n");
	pyCheck(`python3 -c 'import os\nfor n in os.listdir("dots"): print(open(os.path.join("dots", n)).read())'`, { text: "cat -- dots/* 'dots/.env' 'dots/.hid.json'; ls -- 'dots'" });
	pyCheck(`python3 -c 'from pathlib import Path\nfor p in Path("dots").glob("*.json"): print(p.read_text())'`, { text: "cat -- dots/*.json 'dots/.hid.json'; ls -- dots/*.json" });
});
