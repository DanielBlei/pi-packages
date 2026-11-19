/**
 * Decision fixture: synthetic commands with the decision of each mode.
 * `today` is frozen (recorded from the code before the fewer-dialogs change);
 * a later phase that flips a decision appends an `after` row, it never edits `today`.
 * Data and pure helpers only. `judge` uses the injected `api`, so the replay
 * harness can run it against another code tree: extension modules are imported as types only.
 */
import { homedir } from "node:os";
import type { Action, EvalContext, Matcher, evaluate as Evaluate } from "../../extensions/rules.ts";
import type { ProjectPermissions } from "../../extensions/project-rules.ts";
import type { MODES as Modes, GLOBAL_RULES as GlobalRules, ModeName } from "../../extensions/modes.ts";
import type { bashWhy as BashWhy } from "../../extensions/rules.ts";
import type { approvalBreakdown as ApprovalBreakdown, formatBreakdown as FormatBreakdown, isReadOnlyCommand as IsReadOnly } from "../../extensions/utils.ts";

export type Expect = { action: Action; rule: Matcher | "fallback"; why?: RegExp };
export interface FixtureEnv {
	scratch: string;
	cwd: string;
}
export interface Entry {
	/** Stable id, e.g. "loop/literal-wc". */
	id: string;
	/** Synthetic commands only. */
	command: (env: FixtureEnv) => string;
	/** Default "bash"; "powershell" for group G. */
	tool?: string;
	ctx?: Partial<EvalContext>;
	/** Frozen after phase 1. */
	today: Record<ModeName, Expect>;
	/** Later phases append a row per flip; the last row naming a mode wins. */
	after?: ({ phase: string } & Partial<Record<ModeName, Expect>>)[];
	/** Must never loosen. */
	guard?: true;
	/** Id of its near-miss / positive pair. */
	twin?: string;
}
export interface DecisionApi {
	evaluate: typeof Evaluate;
	MODES: typeof Modes;
	GLOBAL_RULES: typeof GlobalRules;
	approvalBreakdown: typeof ApprovalBreakdown;
	formatBreakdown: typeof FormatBreakdown;
	isReadOnlyCommand: typeof IsReadOnly;
	/** The dialog's why lines from the expanded text; absent in a tree from before the expander (the replay baseline). */
	bashWhy?: typeof BashWhy;
}
export interface Judged {
	action: Action;
	rule: string;
	why?: string;
}

/** Same conventions as tests/unit/rules.test.ts. */
const AGENT_DIR = `${homedir()}/.pi/agent`;
const PLAN_FILE = `${AGENT_DIR}/plans/project-2026-10-04-120000-ab12.md`;

export function judge(entry: Entry, mode: ModeName, api: DecisionApi, env: FixtureEnv): Judged {
	const command = entry.command(env);
	const toolName = entry.tool ?? "bash";
	const ctx: EvalContext = { cwd: env.cwd, agentDir: AGENT_DIR, planFile: PLAN_FILE, remembered: [], scratchDir: env.scratch, ...entry.ctx };
	const decision = api.evaluate(api.MODES[mode].permissions, api.GLOBAL_RULES, { toolName, input: { command } }, ctx);
	let why: string | undefined;
	if (toolName === "bash" && !api.isReadOnlyCommand(command, env.cwd, env.scratch, ctx.fetchHosts, ctx.gitRepos)) {
		// what index.ts coverSources counts as approval: session prefixes and exact commands; project allow rules in default mode only
		const covered = [{ label: "allowed for this session", prefixes: ctx.remembered, exact: ctx.rememberedExact ?? [] }];
		if (mode === "default" && ctx.project !== undefined) covered.push({ label: "allowed in this project", prefixes: ctx.project.allow.prefixes, exact: ctx.project.allow.exact });
		why = (api.bashWhy !== undefined ? api.bashWhy(command, ctx, covered) : api.formatBreakdown(api.approvalBreakdown(command, env.cwd, covered, env.scratch, ctx.fetchHosts, ctx.gitRepos)))[0];
	}
	return { action: decision.action, rule: decision.rule?.match ?? "fallback", why };
}

/** The decision a mode must give now: the last `after` row naming it, else `today`. */
export function expected(entry: Entry, mode: ModeName): Expect {
	for (let i = (entry.after?.length ?? 0) - 1; i >= 0; i--) {
		const row = entry.after![i][mode];
		if (row !== undefined) return row;
	}
	return entry.today[mode];
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const x = (action: Action, rule: Expect["rule"], why?: RegExp): Expect => ({ action, rule, why });
const NO_RULES: ProjectPermissions = { allow: { prefixes: [], exact: [], verbatim: [] }, ask: [], deny: [], readDirs: [], fetchHosts: [] };

export const ENTRIES: Entry[] = [
	// A
	{ id: "base/ls", command: () => "ls src", today: { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") } },
	{ id: "base/git-chain", command: () => "git status && git diff --stat", today: { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") } },
	{ id: "base/rm-rf-build", command: () => "rm -rf build", today: { default: x("ask", "fallback", /`rm` isn't on the read-only list/), auto: x("allow", "fallback", /`rm` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`rm` isn't on the read-only list/) } },
	{ id: "base/npm-test", command: () => "npm test", today: { default: x("ask", "fallback", /`npm test` isn't a read-only npm command/), auto: x("allow", "fallback", /`npm test` isn't a read-only npm command/), plan: x("ask", "unapprovedBash", /`npm test` isn't a read-only npm command/) } },
	{ id: "base/npm-test-remembered", command: () => "npm test", ctx: { remembered: [["npm", "test"]] }, today: { default: x("allow", "rememberedBash"), auto: x("allow", "fallback"), plan: x("allow", "rememberedBash") } },
	{ id: "base/project-allow", command: () => "make build", ctx: { project: { ...NO_RULES, allow: { prefixes: [["make"]], exact: [] } } }, today: { default: x("allow", "projectAllowBash"), auto: x("allow", "fallback", /`make` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`make` isn't on the read-only list/) } },
	{ id: "base/sudo", command: () => "sudo ls", today: { default: x("deny", "privilegedBash", /`sudo` isn't on the read-only list/), auto: x("deny", "privilegedBash", /`sudo` isn't on the read-only list/), plan: x("deny", "privilegedBash", /`sudo` isn't on the read-only list/) }, guard: true },
	{ id: "base/force-push", command: () => "git push --force", today: { default: x("ask", "dangerousBash", /`git push` isn't a read-only git command/), auto: x("ask", "dangerousBash", /`git push` isn't a read-only git command/), plan: x("deny", "dangerousBash", /`git push` isn't a read-only git command/) }, guard: true },
	{ id: "base/cat-env", command: () => "cat .env", today: { default: x("ask", "secretBash"), auto: x("ask", "secretBash"), plan: x("ask", "secretBash") }, guard: true },
	{ id: "base/cat-etc-hosts", command: () => "cat /etc/hosts", today: { default: x("ask", "outsideCwdRead"), auto: x("ask", "outsideCwdRead"), plan: x("ask", "outsideCwdRead") }, guard: true },
	{ id: "base/cp-t-scratch", command: (env) => `cp -t ${env.scratch} a`, today: { default: x("ask", "fallback", /`cp` isn't on the read-only list/), auto: x("allow", "fallback", /`cp` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`cp` isn't on the read-only list/) }, guard: true, twin: "base/cp-scratch" },
	{ id: "base/cp-scratch", command: (env) => `cp src/a.ts ${env.scratch}/b`, today: { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") }, twin: "base/cp-t-scratch" },
	{ id: "base/rg-scratch-var", command: () => "rg foo > $SCRATCH/out.txt", today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) }, guard: true, twin: "base/rg-scratch-literal" },
	{ id: "base/rg-scratch-literal", command: (env) => `rg foo > ${env.scratch}/out.txt`, today: { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") }, twin: "base/rg-scratch-var" },
	{ id: "base/rg-tmp", command: () => "rg foo > /tmp/out.txt", today: { default: x("ask", "fallback", /writes output to a file/), auto: x("ask", "outsideCwdBashWrite", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) }, guard: true },
	// B
	{ id: "loop/literal-wc", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/newline-form", command: () => "for f in a.txt b.txt\ndo\n\twc -l \"$f\"\ndone", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/then-echo", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done; echo ok", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/pipe-sort", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done | sort", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/pipe-sort-uniq", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done | sort | uniq -c", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/redirect-scratch", command: (env) => `for f in a.txt b.txt; do wc -l "$f"; done > ${env.scratch}/o`, today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/append-var", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done >> \"$out\"", today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) } },
	{ id: "loop/stderr-null", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done 2>/dev/null", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/nested", command: () => "for a in x y; do for b in 1 2; do wc -l \"$a$b\"; done; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/after-and", command: () => "test -d src && for f in a.txt b.txt; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/remembered-body", command: () => "for d in a b; do npm test \"$d\"; done", ctx: { remembered: [["npm", "test"]] }, today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/write-body", command: () => "for f in a b; do rm \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("ask", "outsideCwdDestructive", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "loop/glob-words", command: () => "for f in *.txt; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true },
	{ id: "loop/project-allow-body", command: () => "for t in a b; do make \"$t\"; done", ctx: { project: { ...NO_RULES, allow: { prefixes: [["make"]], exact: [] } } }, today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	// C
	{ id: "assign/dir", command: () => "d=src; ls \"$d\"", today: { default: x("ask", "fallback", /sets `d=/), auto: x("allow", "fallback", /sets `d=/), plan: x("ask", "unapprovedBash", /sets `d=/) } },
	{ id: "assign/two", command: () => "a=src; b=lib; ls \"$a\" \"$b\"", today: { default: x("ask", "fallback", /sets `a=/), auto: x("allow", "fallback", /sets `a=/), plan: x("ask", "unapprovedBash", /sets `a=/) } },
	{ id: "assign/redirect-scratch", command: (env) => `out=${env.scratch}/r; rg -n x src > "$out"`, today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) } },
	{ id: "assign/append-scratch", command: (env) => `out=${env.scratch}/r; rg -n x src >> "$out"`, today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) } },
	{ id: "assign/redirect-in-loop-body", command: (env) => `for f in a b; do rg x "$f" > ${env.scratch}/o; done`, today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) } },
	{ id: "assign/awk-single-quote", command: () => "x=1; awk '{print $x}' a.txt", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) } },
	{ id: "assign/relative-redirect", command: () => "rg -n x src > out.txt", today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) } },
	// D
	{ id: "near/cond-binding", command: () => "test -d d && x=d; cat $x/f", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/cond-binding" },
	{ id: "pos/cond-binding", command: () => "x=d; cat $x/f", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/cond-binding" },
	{ id: "near/name-underscore", command: () => "_=src; ls \"$_\"", today: { default: x("ask", "fallback", /sets `_=/), auto: x("allow", "fallback", /sets `_=/), plan: x("ask", "unapprovedBash", /sets `_=/) }, guard: true, twin: "pos/name-underscore" },
	{ id: "pos/name-underscore", command: () => "s=src; ls \"$s\"", today: { default: x("ask", "fallback", /sets `s=/), auto: x("allow", "fallback", /sets `s=/), plan: x("ask", "unapprovedBash", /sets `s=/) }, twin: "near/name-underscore" },
	{ id: "near/name-uppercase", command: () => "D=src; ls \"$D\"", today: { default: x("ask", "fallback", /sets `D=/), auto: x("allow", "fallback", /sets `D=/), plan: x("ask", "unapprovedBash", /sets `D=/) }, guard: true, twin: "pos/name-uppercase" },
	{ id: "pos/name-uppercase", command: () => "d=src; ls \"$d\"", today: { default: x("ask", "fallback", /sets `d=/), auto: x("allow", "fallback", /sets `d=/), plan: x("ask", "unapprovedBash", /sets `d=/) }, twin: "near/name-uppercase" },
	{ id: "near/name-path", command: () => "path=src; ls \"$path\"", today: { default: x("ask", "fallback", /sets `path=/), auto: x("allow", "fallback", /sets `path=/), plan: x("ask", "unapprovedBash", /sets `path=/) }, guard: true, twin: "pos/name-path" },
	{ id: "pos/name-path", command: () => "p=src; ls \"$p\"", today: { default: x("ask", "fallback", /sets `p=/), auto: x("allow", "fallback", /sets `p=/), plan: x("ask", "unapprovedBash", /sets `p=/) }, twin: "near/name-path" },
	{ id: "near/value-leading-dash", command: () => "x=-a; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/value-leading-dash" },
	{ id: "pos/value-leading-dash", command: () => "x=a; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/value-leading-dash" },
	{ id: "near/value-comma", command: () => "x=a,b; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/value-comma" },
	{ id: "pos/value-comma", command: () => "x=a.b; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/value-comma" },
	{ id: "near/value-space", command: () => "x=\"a b\"; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/value-space" },
	{ id: "pos/value-space", command: () => "x=ab; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/value-space" },
	{ id: "near/value-glob", command: () => "x=*.ts; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/value-glob" },
	{ id: "pos/value-glob", command: () => "x=a.ts; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/value-glob" },
	{ id: "near/value-tilde", command: () => "x=~/src; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/value-tilde" },
	{ id: "pos/value-tilde", command: () => "x=src; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/value-tilde" },
	{ id: "near/value-dollar", command: () => "x=$HOME; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/value-dollar" },
	{ id: "pos/value-dollar", command: () => "x=home; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/value-dollar" },
	{ id: "near/value-backslash", command: () => "x=a\\ b; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/value-backslash" },
	{ id: "pos/value-backslash", command: () => "x=ab; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/value-backslash" },
	{ id: "near/value-ansi-c", command: () => "x=$'a'; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/value-ansi-c" },
	{ id: "pos/value-ansi-c", command: () => "x=a; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/value-ansi-c" },
	{ id: "near/value-non-ascii", command: () => "x=é; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/value-non-ascii" },
	{ id: "pos/value-non-ascii", command: () => "x=e; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/value-non-ascii" },
	{ id: "near/after-pipe", command: () => "ls | x=src; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/after-pipe" },
	{ id: "pos/after-pipe", command: () => "ls; x=src; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/after-pipe" },
	{ id: "near/before-ampersand", command: () => "x=src & ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/before-ampersand" },
	{ id: "pos/before-ampersand", command: () => "x=src; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/before-ampersand" },
	{ id: "near/prefix-form", command: () => "x=src ls src", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/prefix-form" },
	{ id: "pos/prefix-form", command: () => "x=src; ls src", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/prefix-form" },
	{ id: "near/use-before-binding", command: () => "ls \"$x\"; x=src", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/use-before-binding" },
	{ id: "pos/use-before-binding", command: () => "x=src; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/use-before-binding" },
	{ id: "near/param-op", command: () => "x=src; ls \"${x:-y}\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true, twin: "pos/param-op" },
	{ id: "pos/param-op", command: () => "x=src; ls \"${x}\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/param-op" },
	{ id: "near/body-assignment", command: () => "for f in a b; do g=1; wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/body-assignment" },
	{ id: "pos/body-assignment", command: () => "for f in a b; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/body-assignment" },
	{ id: "near/loop-var-after-done", command: () => "for f in a b; do wc -l \"$f\"; done; ls \"$f\"", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/loop-var-after-done" },
	{ id: "pos/loop-var-after-done", command: () => "for f in a b; do wc -l \"$f\"; done; ls src", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/loop-var-after-done" },
	{ id: "near/break", command: () => "for f in a b; do wc -l \"$f\"; break; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/break" },
	{ id: "pos/break", command: () => "for f in a b; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/break" },
	{ id: "near/words-17", command: () => "for f in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/words-17" },
	{ id: "pos/words-17", command: () => "for f in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/words-17" },
	{ id: "near/bodies-65", command: () => "for a in 1 2 3 4 5 6 7 8 9; do for b in 1 2 3 4 5 6 7 8; do wc -l \"$a$b\"; done; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/bodies-65" },
	{ id: "pos/bodies-65", command: () => "for a in 1 2 3 4 5 6 7 8; do for b in 1 2 3 4 5 6 7 8; do wc -l \"$a$b\"; done; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/bodies-65" },
	{ id: "near/expanded-too-long", command: () => "for f in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do wc -l \"$f\" " + "src/a.ts ".repeat(100) + "; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/expanded-too-long" },
	{ id: "pos/expanded-too-long", command: () => "for f in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do wc -l \"$f\" " + "src/a.ts ".repeat(10) + "; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/expanded-too-long" },
	{ id: "near/cd-in-piped-body", command: () => "for d in src lib; do cd \"$d\"; wc -l a; done | sort", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/cd-in-piped-body" },
	{ id: "pos/cd-in-piped-body", command: () => "for d in src lib; do cd \"$d\"; wc -l a; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/cd-in-piped-body" },
	{ id: "near/done-redirect-src", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done > src/x", today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) }, guard: true, twin: "pos/done-redirect-src" },
	{ id: "pos/done-redirect-src", command: (env) => `for f in a.txt b.txt; do wc -l "$f"; done > ${env.scratch}/x`, today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/done-redirect-src" },
	{ id: "near/done-pipe-sh", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done | sh", today: { default: x("ask", "dangerousBash", /shell loop/), auto: x("ask", "dangerousBash", /shell loop/), plan: x("deny", "dangerousBash", /shell loop/) }, guard: true, twin: "pos/done-pipe-sh" },
	{ id: "pos/done-pipe-sh", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done | sort", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/done-pipe-sh" },
	{ id: "near/pipe-reading-side", command: () => "ls | for f in a b; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/pipe-reading-side" },
	{ id: "pos/pipe-reading-side", command: () => "ls; for f in a b; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/pipe-reading-side" },
	{ id: "near/done-background", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done &", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/done-background" },
	{ id: "pos/done-background", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/done-background" },
	{ id: "near/done-input-redirect", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done < in", today: { default: x("ask", "fallback", /heredoc or input redirect/), auto: x("allow", "fallback", /heredoc or input redirect/), plan: x("ask", "unapprovedBash", /heredoc or input redirect/) }, guard: true, twin: "pos/done-input-redirect" },
	{ id: "pos/done-input-redirect", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/done-input-redirect" },
	{ id: "near/heredoc", command: () => "x=src; cat <<EOF\n$x\nEOF", today: { default: x("ask", "fallback", /heredoc or input redirect/), auto: x("allow", "fallback", /heredoc or input redirect/), plan: x("ask", "unapprovedBash", /heredoc or input redirect/) }, guard: true, twin: "pos/heredoc" },
	{ id: "pos/heredoc", command: () => "x=src; cat \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/heredoc" },
	{ id: "near/command-substitution", command: () => "x=$(echo src); ls \"$x\"", today: { default: x("ask", "fallback", /command substitution/), auto: x("allow", "fallback", /command substitution/), plan: x("ask", "unapprovedBash", /command substitution/) }, guard: true, twin: "pos/command-substitution" },
	{ id: "pos/command-substitution", command: () => "x=src; ls \"$x\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, twin: "near/command-substitution" },
	{ id: "near/out-tmp", command: () => "out=/tmp/o; rg x src > \"$out\"", today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) }, guard: true, twin: "pos/out-tmp" },
	{ id: "pos/out-tmp", command: (env) => `out=${env.scratch}/o; rg x src > "$out"`, today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) }, twin: "near/out-tmp" },
	{ id: "near/out-dotdot", command: (env) => `out=${env.scratch}/../o; rg x src > "$out"`, today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) }, guard: true, twin: "pos/out-dotdot" },
	{ id: "pos/out-dotdot", command: (env) => `out=${env.scratch}/o; rg x src > "$out"`, today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) }, twin: "near/out-dotdot" },
	{ id: "near/unbound-var-target", command: () => "rg x src > \"$out\"", today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) }, guard: true, twin: "pos/unbound-var-target" },
	{ id: "pos/unbound-var-target", command: (env) => `out=${env.scratch}/o; rg x src > "$out"`, today: { default: x("ask", "fallback", /writes output to a file/), auto: x("allow", "fallback", /writes output to a file/), plan: x("ask", "unapprovedBash", /writes output to a file/) }, twin: "near/unbound-var-target" },
	{ id: "near/cd-outside-through-loop", command: () => "for d in /etc /usr; do cd \"$d\"; ls; done", today: { default: x("ask", "outsideCwdRead", /shell loop/), auto: x("ask", "outsideCwdRead", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true, twin: "pos/cd-outside-through-loop" },
	{ id: "pos/cd-outside-through-loop", command: () => "for d in src lib; do cd \"$d\"; ls; done", today: { default: x("ask", "fallback", /shell loop/), auto: x("allow", "fallback", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, twin: "near/cd-outside-through-loop" },
	// E
	{ id: "strict/dotenv-through-var", command: () => "x=.en; cat \"${x}v\"", today: { default: x("ask", "fallback", /sets `x=/), auto: x("allow", "fallback", /sets `x=/), plan: x("ask", "unapprovedBash", /sets `x=/) }, guard: true },
	{ id: "strict/sudo-through-var", command: () => "x=sudo; $x ls", today: { default: x("deny", "privilegedBash", /sets `x=/), auto: x("deny", "privilegedBash", /sets `x=/), plan: x("deny", "privilegedBash", /sets `x=/) }, guard: true },
	{ id: "strict/project-deny-through-var", command: () => "x=terraform; $x destroy", ctx: { project: { ...NO_RULES, deny: [{ text: "terraform destroy *", tokens: ["terraform", "destroy"], exact: false }] } }, today: { default: x("ask", "dangerousBash", /sets `x=/), auto: x("ask", "dangerousBash", /sets `x=/), plan: x("deny", "dangerousBash", /sets `x=/) }, guard: true },
	{ id: "strict/sudo-in-loop", command: () => "for c in sudo; do $c ls; done", today: { default: x("deny", "privilegedBash", /shell loop/), auto: x("deny", "privilegedBash", /shell loop/), plan: x("deny", "privilegedBash", /shell loop/) }, guard: true },
	{ id: "strict/secret-in-loop", command: () => "for f in .env a; do cat \"$f\"; done", today: { default: x("ask", "secretBash", /shell loop/), auto: x("ask", "secretBash", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true },
	{ id: "strict/outside-read-in-loop", command: () => "for f in /etc/hosts a; do cat \"$f\"; done", today: { default: x("ask", "outsideCwdRead", /shell loop/), auto: x("ask", "outsideCwdRead", /shell loop/), plan: x("ask", "unapprovedBash", /shell loop/) }, guard: true },
	// F
	{ id: "py/open-read", command: () => "python3 -c 'print(open(\"a.txt\").read())'", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, twin: "py/double-quoted" },
	{ id: "py/json-read", command: () => "python3 -c 'import json; print(json.load(open(\"a.json\")))'", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, twin: "py/os-system" },
	{ id: "py/double-quoted", command: () => "python3 -c \"print(open('a.txt').read())\"", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true, twin: "py/open-read" },
	{ id: "py/os-system", command: () => "python3 -c 'import os; os.system(\"ls\")'", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true, twin: "py/json-read" },
	{ id: "py/script-file", command: () => "python3 x.py", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true },
	{ id: "py/read-etc", command: () => "python3 -c 'print(open(\"/etc/hosts\").read())'", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true },
	{ id: "py/read-env", command: () => "python3 -c 'print(open(\".env\").read())'", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true },
	{ id: "py/write-cwd", command: () => "python3 -c 'open(\"out.txt\", \"w\").write(\"x\")'", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true },
	{ id: "py/unknown-import", command: () => "python3 -c 'import nosuchmod_x; nosuchmod_x.run()'", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true },
	{ id: "py/exec", command: () => "python3 -c 'exec(\"print(1)\")'", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true },
	{ id: "py/extra-argv", command: () => "python3 -c 'print(1)' a.txt", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true },
	{ id: "py/wrapped", command: () => "env python3 -c 'print(open(\"a.txt\").read())'", today: { default: x("ask", "fallback", /`env` with arguments/), auto: x("allow", "fallback", /`env` with arguments/), plan: x("ask", "unapprovedBash", /`env` with arguments/) }, guard: true },
	{ id: "py/after-pipe", command: () => "ls | python3 -c 'print(open(\"a.txt\").read())'", today: { default: x("ask", "fallback", /`python3` isn't on the read-only list/), auto: x("allow", "fallback", /`python3` isn't on the read-only list/), plan: x("ask", "unapprovedBash", /`python3` isn't on the read-only list/) }, guard: true },
	{ id: "py/with-env", command: () => "PYTHONPATH=src python3 -c 'print(open(\"a.txt\").read())'", today: { default: x("ask", "fallback", /sets `PYTHONPATH=/), auto: x("allow", "fallback", /sets `PYTHONPATH=/), plan: x("ask", "unapprovedBash", /sets `PYTHONPATH=/) }, guard: true },
	// G
	{ id: "ps/loop-text", command: () => "for f in a.txt b.txt; do wc -l \"$f\"; done", tool: "powershell", today: { default: x("ask", "fallback"), auto: x("allow", "fallback"), plan: x("deny", "fallback") }, guard: true },
	{ id: "ps/foreach", command: () => "foreach ($f in 'a.txt','b.txt') { Get-Content $f }", tool: "powershell", today: { default: x("ask", "dangerousBash"), auto: x("ask", "dangerousBash"), plan: x("deny", "fallback") }, guard: true },
];
/** Phase 3b: the expander is wired into the rules (flips: ask to allow for literal loops and assignments; Why text from the expanded command). */
const AFTER_3B: Record<string, Partial<Record<ModeName, Expect>>> = {
	"loop/literal-wc": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"loop/newline-form": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"loop/then-echo": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"loop/pipe-sort": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"loop/pipe-sort-uniq": { default: x("ask", "fallback", /Why: a piped loop may have only one pipe tail\./), auto: x("allow", "fallback", /Why: a piped loop may have only one pipe tail\./), plan: x("ask", "unapprovedBash", /Why: a piped loop may have only one pipe tail\./) },
	"loop/redirect-scratch": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"loop/append-var": { default: x("ask", "fallback", /Why: the tokenizer does not accept the expanded command\./), auto: x("allow", "fallback", /Why: the tokenizer does not accept the expanded command\./), plan: x("ask", "unapprovedBash", /Why: the tokenizer does not accept the expanded command\./) },
	"loop/stderr-null": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"loop/nested": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"loop/after-and": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"loop/remembered-body": { default: x("allow", "rememberedBash"), auto: x("allow", "fallback"), plan: x("allow", "rememberedBash") },
	"loop/write-body": { default: x("ask", "fallback", /Why: `rm` isn't on the read-only list\./), auto: x("ask", "outsideCwdDestructive", /Why: `rm` isn't on the read-only list\./), plan: x("ask", "unapprovedBash", /Why: `rm` isn't on the read-only list\./) },
	"loop/glob-words": { default: x("ask", "fallback", /Why: a `for` loop word is not a plain literal\./), auto: x("allow", "fallback", /Why: a `for` loop word is not a plain literal\./), plan: x("ask", "unapprovedBash", /Why: a `for` loop word is not a plain literal\./) },
	"loop/project-allow-body": { default: x("allow", "projectAllowBash"), auto: x("allow", "fallback", /Why: `make` isn't on the read-only list\./), plan: x("ask", "unapprovedBash", /Why: `make` isn't on the read-only list\./) },
	"assign/dir": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"assign/two": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"assign/redirect-scratch": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"assign/append-scratch": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"assign/redirect-in-loop-body": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"assign/awk-single-quote": { default: x("ask", "fallback", /Why: `\{`, `\}`, `\(` and `\)` are not supported outside `\$\{name\}`\./), auto: x("allow", "fallback", /Why: `\{`, `\}`, `\(` and `\)` are not supported outside `\$\{name\}`\./), plan: x("ask", "unapprovedBash", /Why: `\{`, `\}`, `\(` and `\)` are not supported outside `\$\{name\}`\./) },
	"near/cond-binding": { default: x("ask", "fallback", /Why: `x` is set after `&&`, so it may not be set when it is used\./), auto: x("allow", "fallback", /Why: `x` is set after `&&`, so it may not be set when it is used\./), plan: x("ask", "unapprovedBash", /Why: `x` is set after `&&`, so it may not be set when it is used\./) },
	"pos/cond-binding": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/name-underscore": { default: x("ask", "fallback", /Why: `_` is a special shell variable\./), auto: x("allow", "fallback", /Why: `_` is a special shell variable\./), plan: x("ask", "unapprovedBash", /Why: `_` is a special shell variable\./) },
	"pos/name-underscore": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/name-uppercase": { default: x("ask", "fallback", /Why: `D` is not a plain lowercase variable name\./), auto: x("allow", "fallback", /Why: `D` is not a plain lowercase variable name\./), plan: x("ask", "unapprovedBash", /Why: `D` is not a plain lowercase variable name\./) },
	"pos/name-uppercase": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/name-path": { default: x("ask", "fallback", /Why: `path` is a special shell variable\./), auto: x("allow", "fallback", /Why: `path` is a special shell variable\./), plan: x("ask", "unapprovedBash", /Why: `path` is a special shell variable\./) },
	"pos/name-path": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/value-leading-dash": { default: x("ask", "fallback", /Why: the value of `x` is not a plain literal\./), auto: x("allow", "fallback", /Why: the value of `x` is not a plain literal\./), plan: x("ask", "unapprovedBash", /Why: the value of `x` is not a plain literal\./) },
	"pos/value-leading-dash": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/value-comma": { default: x("ask", "fallback", /Why: the value of `x` is not a plain literal\./), auto: x("allow", "fallback", /Why: the value of `x` is not a plain literal\./), plan: x("ask", "unapprovedBash", /Why: the value of `x` is not a plain literal\./) },
	"pos/value-comma": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/value-space": { default: x("ask", "fallback", /Why: the value of `x` is not a plain literal\./), auto: x("allow", "fallback", /Why: the value of `x` is not a plain literal\./), plan: x("ask", "unapprovedBash", /Why: the value of `x` is not a plain literal\./) },
	"pos/value-space": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/value-glob": { default: x("ask", "fallback", /Why: the value of `x` is not a plain literal\./), auto: x("allow", "fallback", /Why: the value of `x` is not a plain literal\./), plan: x("ask", "unapprovedBash", /Why: the value of `x` is not a plain literal\./) },
	"pos/value-glob": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/value-tilde": { default: x("ask", "fallback", /Why: the value of `x` is not a plain literal\./), auto: x("allow", "fallback", /Why: the value of `x` is not a plain literal\./), plan: x("ask", "unapprovedBash", /Why: the value of `x` is not a plain literal\./) },
	"pos/value-tilde": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/value-dollar": { default: x("ask", "fallback", /Why: the value of `x` is not a plain literal\./), auto: x("allow", "fallback", /Why: the value of `x` is not a plain literal\./), plan: x("ask", "unapprovedBash", /Why: the value of `x` is not a plain literal\./) },
	"pos/value-dollar": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/value-backslash": { default: x("ask", "fallback", /Why: a backslash outside single quotes is not supported\./), auto: x("allow", "fallback", /Why: a backslash outside single quotes is not supported\./), plan: x("ask", "unapprovedBash", /Why: a backslash outside single quotes is not supported\./) },
	"pos/value-backslash": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/value-ansi-c": { default: x("ask", "fallback", /Why: `\$'` and `\$"` quoting is not supported\./), auto: x("allow", "fallback", /Why: `\$'` and `\$"` quoting is not supported\./), plan: x("ask", "unapprovedBash", /Why: `\$'` and `\$"` quoting is not supported\./) },
	"pos/value-ansi-c": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/value-non-ascii": { default: x("ask", "fallback", /Why: non-ASCII or control characters are not supported\./), auto: x("allow", "fallback", /Why: non-ASCII or control characters are not supported\./), plan: x("ask", "unapprovedBash", /Why: non-ASCII or control characters are not supported\./) },
	"pos/value-non-ascii": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/after-pipe": { default: x("ask", "fallback", /Why: `x` is set after `\|`, so it may not be set when it is used\./), auto: x("allow", "fallback", /Why: `x` is set after `\|`, so it may not be set when it is used\./), plan: x("ask", "unapprovedBash", /Why: `x` is set after `\|`, so it may not be set when it is used\./) },
	"pos/after-pipe": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/before-ampersand": { default: x("ask", "fallback", /Why: `x` is followed by `&`, so it may not be set when it is used\./), auto: x("allow", "fallback", /Why: `x` is followed by `&`, so it may not be set when it is used\./), plan: x("ask", "unapprovedBash", /Why: `x` is followed by `&`, so it may not be set when it is used\./) },
	"pos/before-ampersand": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"pos/prefix-form": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/use-before-binding": { default: x("ask", "fallback", /Why: `x` is used outside the place where it is set\./), auto: x("allow", "fallback", /Why: `x` is used outside the place where it is set\./), plan: x("ask", "unapprovedBash", /Why: `x` is used outside the place where it is set\./) },
	"pos/use-before-binding": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/param-op": { default: x("ask", "fallback", /Why: `\$\{` with an operator is not supported\./), auto: x("allow", "fallback", /Why: `\$\{` with an operator is not supported\./), plan: x("ask", "unapprovedBash", /Why: `\$\{` with an operator is not supported\./) },
	"pos/param-op": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/body-assignment": { default: x("ask", "fallback", /Why: an assignment in a loop body is not supported\./), auto: x("allow", "fallback", /Why: an assignment in a loop body is not supported\./), plan: x("ask", "unapprovedBash", /Why: an assignment in a loop body is not supported\./) },
	"pos/body-assignment": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/loop-var-after-done": { default: x("ask", "fallback", /Why: `f` is used outside the place where it is set\./), auto: x("allow", "fallback", /Why: `f` is used outside the place where it is set\./), plan: x("ask", "unapprovedBash", /Why: `f` is used outside the place where it is set\./) },
	"pos/loop-var-after-done": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/break": { default: x("ask", "fallback", /Why: `break` in a loop body is not supported\./), auto: x("allow", "fallback", /Why: `break` in a loop body is not supported\./), plan: x("ask", "unapprovedBash", /Why: `break` in a loop body is not supported\./) },
	"pos/break": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/words-17": { default: x("ask", "fallback", /Why: a `for` loop with 17 words is not supported, the limit is 16\./), auto: x("allow", "fallback", /Why: a `for` loop with 17 words is not supported, the limit is 16\./), plan: x("ask", "unapprovedBash", /Why: a `for` loop with 17 words is not supported, the limit is 16\./) },
	"pos/words-17": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/bodies-65": { default: x("ask", "fallback", /Why: the loops unroll to more than 64 bodies\./), auto: x("allow", "fallback", /Why: the loops unroll to more than 64 bodies\./), plan: x("ask", "unapprovedBash", /Why: the loops unroll to more than 64 bodies\./) },
	"pos/bodies-65": { default: x("ask", "fallback", /Why: the loops unroll to more than 64 bodies\./), auto: x("allow", "fallback", /Why: the loops unroll to more than 64 bodies\./), plan: x("ask", "unapprovedBash", /Why: the loops unroll to more than 64 bodies\./) },
	"near/expanded-too-long": { default: x("ask", "fallback", /Why: the expanded command is longer than 10000 characters\./), auto: x("allow", "fallback", /Why: the expanded command is longer than 10000 characters\./), plan: x("ask", "unapprovedBash", /Why: the expanded command is longer than 10000 characters\./) },
	"pos/expanded-too-long": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/cd-in-piped-body": { default: x("ask", "fallback", /Why: `cd` in the body of a piped loop would run in a subshell\./), auto: x("allow", "fallback", /Why: `cd` in the body of a piped loop would run in a subshell\./), plan: x("ask", "unapprovedBash", /Why: `cd` in the body of a piped loop would run in a subshell\./) },
	"pos/cd-in-piped-body": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/done-redirect-src": { default: x("ask", "fallback", /Why: the tokenizer does not accept the expanded command\./), auto: x("allow", "fallback", /Why: the tokenizer does not accept the expanded command\./), plan: x("ask", "unapprovedBash", /Why: the tokenizer does not accept the expanded command\./) },
	"pos/done-redirect-src": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/done-pipe-sh": { default: x("ask", "dangerousBash", /Needs approval: `sh` — `sh` isn't on the read-only list/), auto: x("ask", "dangerousBash", /Needs approval: `sh` — `sh` isn't on the read-only list/), plan: x("deny", "dangerousBash", /Needs approval: `sh` — `sh` isn't on the read-only list/) },
	"pos/done-pipe-sh": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/pipe-reading-side": { default: x("ask", "fallback", /Why: a `for` loop after `\|` is not supported\./), auto: x("allow", "fallback", /Why: a `for` loop after `\|` is not supported\./), plan: x("ask", "unapprovedBash", /Why: a `for` loop after `\|` is not supported\./) },
	"pos/pipe-reading-side": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/done-background": { default: x("ask", "fallback", /Why: a `for` loop followed by `&` is not supported\./), auto: x("allow", "fallback", /Why: a `for` loop followed by `&` is not supported\./), plan: x("ask", "unapprovedBash", /Why: a `for` loop followed by `&` is not supported\./) },
	"pos/done-background": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/done-input-redirect": { default: x("ask", "fallback", /Why: `<` input redirection is not supported\./), auto: x("allow", "fallback", /Why: `<` input redirection is not supported\./), plan: x("ask", "unapprovedBash", /Why: `<` input redirection is not supported\./) },
	"pos/done-input-redirect": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/heredoc": { default: x("ask", "fallback", /Why: `<<` is not supported\./), auto: x("allow", "fallback", /Why: `<<` is not supported\./), plan: x("ask", "unapprovedBash", /Why: `<<` is not supported\./) },
	"pos/heredoc": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"pos/command-substitution": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/out-tmp": { default: x("ask", "fallback", /Why: the tokenizer does not accept the expanded command\./), auto: x("allow", "fallback", /Why: the tokenizer does not accept the expanded command\./), plan: x("ask", "unapprovedBash", /Why: the tokenizer does not accept the expanded command\./) },
	"pos/out-tmp": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/out-dotdot": { default: x("ask", "fallback", /Why: the tokenizer does not accept the expanded command\./), auto: x("allow", "fallback", /Why: the tokenizer does not accept the expanded command\./), plan: x("ask", "unapprovedBash", /Why: the tokenizer does not accept the expanded command\./) },
	"pos/out-dotdot": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"pos/unbound-var-target": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"near/cd-outside-through-loop": { default: x("ask", "outsideCwdRead", /Needs approval: `cd \/etc` \(\+1 more\) — `cd` leaves the working directory/), auto: x("ask", "outsideCwdRead", /Needs approval: `cd \/etc` \(\+1 more\) — `cd` leaves the working directory/), plan: x("ask", "unapprovedBash", /Needs approval: `cd \/etc` \(\+1 more\) — `cd` leaves the working directory/) },
	"pos/cd-outside-through-loop": { default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") },
	"strict/dotenv-through-var": { default: x("ask", "secretBash"), auto: x("allow", "fallback"), plan: x("ask", "secretBash") },
	"strict/sudo-through-var": { default: x("deny", "privilegedBash", /Why: `sudo` isn't on the read-only list\./), auto: x("deny", "privilegedBash", /Why: `sudo` isn't on the read-only list\./), plan: x("deny", "privilegedBash", /Why: `sudo` isn't on the read-only list\./) },
	"strict/project-deny-through-var": { default: x("ask", "dangerousBash", /Why: `terraform` isn't on the read-only list\./), auto: x("ask", "dangerousBash", /Why: `terraform` isn't on the read-only list\./), plan: x("deny", "dangerousBash", /Why: `terraform` isn't on the read-only list\./) },
	"strict/sudo-in-loop": { default: x("deny", "privilegedBash", /Why: `sudo` isn't on the read-only list\./), auto: x("deny", "privilegedBash", /Why: `sudo` isn't on the read-only list\./), plan: x("deny", "privilegedBash", /Why: `sudo` isn't on the read-only list\./) },
	"strict/secret-in-loop": { default: x("ask", "secretBash"), auto: x("ask", "secretBash"), plan: x("ask", "secretBash") },
	"strict/outside-read-in-loop": { default: x("ask", "outsideCwdRead"), auto: x("ask", "outsideCwdRead"), plan: x("ask", "outsideCwdRead") },
};
for (const entry of ENTRIES) {
	const row = AFTER_3B[entry.id];
	if (row !== undefined) (entry.after ??= []).push({ phase: "3b", ...row });
}

/** Phase 3c (input redirects and glob loops in the expander): only the reason of two refused shapes changes. */
const AFTER_3C: Record<string, Partial<Record<ModeName, Expect>>> = {
	"loop/glob-words": { default: x("ask", "fallback", /Why: a `for` loop over a glob needs the loop-glob grant\./), auto: x("allow", "fallback", /Why: a `for` loop over a glob needs the loop-glob grant\./), plan: x("ask", "unapprovedBash", /Why: a `for` loop over a glob needs the loop-glob grant\./) },
	"near/done-input-redirect": { default: x("ask", "fallback", /Why: only output redirections and one pipe may follow `done`\./), auto: x("allow", "fallback", /Why: only output redirections and one pipe may follow `done`\./), plan: x("ask", "unapprovedBash", /Why: only output redirections and one pipe may follow `done`\./) },
};
for (const entry of ENTRIES) {
	const row = AFTER_3C[entry.id];
	if (row !== undefined) (entry.after ??= []).push({ phase: "3c", ...row });
}

/** Phase 3d (dialog text): a refused redirect now names the classifier's own reason instead of the tokenizer. */
const REDIRECT_WHY = /Why: writes output to a file \(only \/dev\/null or a file in the scratch dir is allowed\)\./;
for (const entry of ENTRIES) {
	if (!["loop/append-var", "near/done-redirect-src", "near/out-tmp", "near/out-dotdot"].includes(entry.id)) continue;
	(entry.after ??= []).push({ phase: "3d", default: x("ask", "fallback", REDIRECT_WHY), auto: x("allow", "fallback", REDIRECT_WHY), plan: x("ask", "unapprovedBash", REDIRECT_WHY) });
}

/**
 * Phase 4b (static python wired into the expander) and the multi-stage pipe tail. The fixture cwd does not exist,
 * so no python entry can flip here (the analyzer cannot read the run dir): only the Why line changes.
 * The python flips (ask to allow) are asserted in tests/unit/python-wiring.test.ts on real temp dirs.
 * The pipe tail `done | sort | uniq -c` is a real flip: ask to allow in default and plan.
 */
const AFTER_4B_WHY: Record<string, string> = {
	"py/open-read": "python: the run directory cannot be read",
	"py/json-read": "python: the run directory cannot be read",
	"py/read-etc": "python: the run directory cannot be read",
	"py/read-env": "python: the run directory cannot be read",
	"py/double-quoted": "`python3 -c` with a double-quoted script is not analyzed, only a single-quoted one",
	"py/os-system": "python: os.system is not on the allow-list",
	"py/write-cwd": "python: writing out.txt is not inside the scratch directory",
	"py/unknown-import": "python: import nosuchmod_x is not on the allow-list",
	"py/exec": "python: exec can run or reach arbitrary code",
	"py/extra-argv": "`python3 -c '...'` may not be followed by arguments, redirections or other words",
	"py/after-pipe": "`python3` after a pipe reads its input from the pipe, so it is not analyzed",
};
for (const entry of ENTRIES) {
	const problem = AFTER_4B_WHY[entry.id];
	if (problem === undefined) continue;
	const why = new RegExp(`^Why: ${problem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`);
	(entry.after ??= []).push({ phase: "4b", default: x("ask", "fallback", why), auto: x("allow", "fallback", why), plan: x("ask", "unapprovedBash", why) });
}
const PIPE_ENTRY = ENTRIES.find((e) => e.id === "loop/pipe-sort-uniq");
if (PIPE_ENTRY !== undefined) (PIPE_ENTRY.after ??= []).push({ phase: "4b", default: x("allow", "readOnlyBash"), auto: x("allow", "fallback"), plan: x("allow", "readOnlyBash") });
