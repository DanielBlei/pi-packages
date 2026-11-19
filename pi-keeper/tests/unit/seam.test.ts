/**
 * The seam between the rule table and the program expander (plan D2): how each matcher
 * reads the expanded text `P`, the complement, and the conditional scanners.
 * Run: node --test tests/unit/seam.test.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { ANY_TOOL, GLOBAL_RULES, MODES, type ModeName } from "../../extensions/modes.ts";
import type { ProjectPermissions } from "../../extensions/project-rules.ts";
import { MATCHER_KIND, bashWhy, evaluate, type Action, type EvalContext, type Matcher, type ModeRules } from "../../extensions/rules.ts";
import { parsePattern } from "../../extensions/project-rules.ts";
import { createScratchDir } from "../../extensions/utils.ts";
import { ENTRIES, type Entry, type FixtureEnv } from "../fixtures/decisions.ts";

const AGENT_DIR = `${homedir()}/.pi/agent`;
const PLAN_FILE = `${AGENT_DIR}/plans/project-2026-10-04-120000-ab12.md`;
const MODE_NAMES: ModeName[] = ["default", "auto", "plan"];
const env: FixtureEnv = { scratch: createScratchDir(), cwd: "/home/user/project" };
after(() => rmSync(env.scratch, { recursive: true, force: true }));

function denyRule(text: string) {
	const parsed = parsePattern(text, "deny");
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
}

const NO_RULES: ProjectPermissions = { allow: { prefixes: [], exact: [], verbatim: [] }, ask: [], deny: [], readDirs: [], fetchHosts: [] };

function ctxOf(extra: Partial<EvalContext> = {}): EvalContext {
	return { cwd: env.cwd, agentDir: AGENT_DIR, planFile: PLAN_FILE, remembered: [], scratchDir: env.scratch, ...extra };
}

function decide(mode: ModeRules, command: string, extra: Partial<EvalContext> = {}) {
	return evaluate(mode, GLOBAL_RULES, { toolName: "bash", input: { command } }, ctxOf(extra));
}

/** Does this one matcher hold for the command? A mode that allows exactly when it does. */
function holds(matcher: Matcher, command: string, extra: Partial<EvalContext> = {}): boolean {
	return evaluate({ fallback: "deny", rules: [{ tools: ["bash"], match: matcher, action: "allow" }] }, [], { toolName: "bash", input: { command } }, ctxOf(extra)).action === "allow";
}

/** The fixture's bash entries (not powershell). */
const bashEntries: Entry[] = ENTRIES.filter((e) => (e.tool ?? "bash") === "bash");

test("every matcher a rule lists has a kind", () => {
	const listed = new Set<Matcher>();
	for (const rule of [...GLOBAL_RULES, ...MODE_NAMES.flatMap((m) => MODES[m].permissions.rules)]) {
		if (rule.match === undefined) continue;
		if (!rule.tools.includes("bash") && !rule.tools.includes(ANY_TOOL)) continue;
		listed.add(rule.match);
	}
	assert.ok(listed.size > 0);
	for (const matcher of listed) assert.ok(MATCHER_KIND[matcher] !== undefined, `${matcher} has no kind`);
	for (const [name, kind] of Object.entries(MATCHER_KIND)) assert.ok(["allow", "verbatim", "scanner", "complement", "blind"].includes(kind), `${name}: ${kind}`);
});

test("a blind matcher ignores the command", () => {
	const blind = (Object.keys(MATCHER_KIND) as Matcher[]).filter((m) => MATCHER_KIND[m] === "blind");
	assert.ok(blind.length >= 10);
	const commands = ["ls src", 'for f in a b; do wc -l "$f"; done', "x=.en; cat \"${x}v\"", "sudo rm -rf /"];
	for (const matcher of blind) {
		for (const extra of [{}, { child: true, sessionEdits: true, subagentBridge: true }]) {
			const results = commands.map((command) => holds(matcher, command, extra));
			assert.ok(results.every((r) => r === results[0]), `${matcher} reads the command: ${results.join(",")}`);
		}
	}
});

test("the verbatim matcher reads the typed text only", () => {
	const command = "x=src; ls \"$x\"";
	assert.equal(holds("rememberedVerbatim", command, { rememberedVerbatim: [command] }), true);
	// the expanded text is not what was approved
	assert.equal(holds("rememberedVerbatim", command, { rememberedVerbatim: ['ls "src"'] }), false);
});

test("unapprovedBash holds exactly when neither expanded allow matcher holds, and plan never reaches its fallback deny", () => {
	for (const entry of bashEntries) {
		const command = entry.command(env);
		const extra = entry.ctx ?? {};
		const unapproved = holds("unapprovedBash", command, extra);
		const allowed = holds("readOnlyBash", command, extra) || holds("rememberedBash", command, extra);
		assert.equal(unapproved, !allowed, `${entry.id}: ${command}`);
		const plan = evaluate(MODES.plan.permissions, GLOBAL_RULES, { toolName: "bash", input: { command } }, ctxOf(extra));
		assert.ok(plan.rule !== undefined || plan.action !== "deny", `${entry.id}: plan reached its fallback deny`);
	}
});

test("a mode that lists unapprovedBash with fallback allow never allows through that rule", () => {
	const synthetic: ModeRules = { fallback: "allow", rules: [{ tools: ["bash"], match: "unapprovedBash", action: "deny" }] };
	for (const entry of bashEntries) {
		const command = entry.command(env);
		const extra = entry.ctx ?? {};
		const decision = decide(synthetic, command, extra);
		const allowed = holds("readOnlyBash", command, extra) || holds("rememberedBash", command, extra);
		if (decision.action === "allow") assert.ok(decision.rule === undefined && allowed || decision.rule?.match !== "unapprovedBash", entry.id);
		// the rule denies exactly the commands no expanded allow covers (global rules may only make it stricter)
		if (!allowed) assert.equal(decision.action, "deny", `${entry.id}: ${command}`);
		if (allowed) assert.notEqual(decision.rule?.match, "unapprovedBash", entry.id);
	}
});

test("a scanner judges P when an allow came through P: a secret read built from a variable asks", () => {
	const command = "x=.en; cat \"${x}v\"";
	for (const mode of ["default", "plan"] as const) {
		const decision = decide(MODES[mode].permissions, command);
		assert.equal(decision.action, "ask", mode);
		assert.equal(decision.rule?.match, "secretBash", mode);
	}
	// auto has no bash allow rule: P changes nothing, the answer is today's
	const auto = decide(MODES.auto.permissions, command);
	assert.equal(auto.action, "allow");
	assert.equal(auto.rule, undefined);
});

test("a project deny rule meets the command a variable builds", () => {
	const project: ProjectPermissions = { ...NO_RULES, deny: [denyRule("cat secrets/k *")] };
	for (const mode of MODE_NAMES) {
		assert.equal(decide(MODES[mode].permissions, 'cat "secrets/k"', { project }).action, "deny", `${mode}: typed`);
	}
	for (const mode of ["default", "plan"] as const) {
		const decision = decide(MODES[mode].permissions, 'd=secrets; cat "$d/k"', { project });
		assert.equal(decision.action, "deny", mode);
		assert.equal(decision.rule?.match, "projectDeny", mode);
	}
	// auto: no allow came through P, so the answer is today's
	assert.equal(decide(MODES.auto.permissions, 'd=secrets; cat "$d/k"', { project }).action, "allow");
});

test("a command allowed today keeps its answer when P would add a scanner hit", () => {
	const command = "x=.en; cat \"${x}v\"";
	// the exact text was approved: an allow holds as typed, so P is not consulted by the scanners (viaP is false)
	const decision = decide(MODES.default.permissions, command, { rememberedVerbatim: [command] });
	assert.equal(decision.action, "allow");
	// the same with a project deny rule that only P would meet
	const project: ProjectPermissions = { ...NO_RULES, deny: [denyRule("cat secrets/k *")] };
	const typed = 'd=secrets; cat "$d/k"';
	assert.equal(decide(MODES.default.permissions, typed, { project, rememberedVerbatim: [typed] }).action, "allow");
	assert.equal(decide(MODES.default.permissions, typed, { project }).action, "deny");
});

test("a scanner of the typed text still decides when P allows", () => {
	// P = `ls src; sudo ls` is not read-only, but the typed `sudo` check is the typed text's own
	for (const mode of MODE_NAMES) assert.equal(decide(MODES[mode].permissions, "sudo ls").action, "deny", mode);
	for (const mode of MODE_NAMES) assert.equal(decide(MODES[mode].permissions, 'for f in .env; do cat "$f"; done').action, "ask", mode);
});

test("a child's artifact write from a loop is judged on the same text as its scanner", () => {
	const dir = `${AGENT_DIR}/sessions/--home-user-project--/subagent-artifacts/outputs/run-1`;
	const loop = `for d in a b; do mkdir -p ${dir}/$d; done`;
	assert.equal(decide(MODES.auto.permissions, loop, { child: true }).action, "allow");
	assert.equal(decide(MODES.auto.permissions, `mkdir -p ${dir}/a && mkdir -p ${dir}/b`, { child: true }).action, "allow");
	// a loop that leaves the artifact dirs is not exempt: P is no allow, so auto answers as it does today (the typed loop has no literal target)
	const out = `for d in a b; do mkdir -p /opt/x/$d; done`;
	assert.equal(decide(MODES.auto.permissions, out, { child: true }).action, decide(MODES.auto.permissions, out, { child: true, scratchDir: undefined }).action);
	assert.equal(decide(MODES.auto.permissions, "mkdir -p /opt/x/a && mkdir -p /opt/x/b", { child: true }).action, "ask");
	// a deletion stays dangerous in a loop
	assert.equal(decide(MODES.auto.permissions, `for d in a b; do rm -rf ${dir}/$d; done`, { child: true }).action, "ask");
});

test("powershell is never expanded", () => {
	const loop = 'for f in a.txt b.txt; do wc -l "$f"; done';
	const got = (mode: ModeName): Action => evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: "powershell", input: { command: loop } }, ctxOf()).action;
	assert.equal(got("default"), "ask");
	assert.equal(got("plan"), "deny");
});

test("bashWhy names the problem first, then the body's blocker; a loop reads as one entry per reason", () => {
	const ctx = ctxOf();
	const loop = 'for f in a b c; do npm test "$f"; done';
	assert.deepEqual(bashWhy(loop, ctx, []), ["Why: `npm test` isn't a read-only npm command."]);
	const mixed = 'for f in a b c; do npm test "$f"; wc -l "$f"; done';
	const lines = bashWhy(mixed, ctx, []);
	assert.match(lines[0], /^Needs approval: `npm test a` \(\+2 more\) — `npm test` isn't a read-only npm command$/);
	assert.match(lines[1], /^Already OK: /);
	// the expander refused: its problem first
	const refused = bashWhy('for f in *.txt; do wc -l "$f"; done', ctx, []);
	assert.equal(refused[0], "Why: a `for` loop over a glob needs the loop-glob grant.");
	// one coherent block: no second "Why:" and no generic shell-loop line
	assert.equal(refused.filter((l) => l.startsWith("Why:")).length, 1);
	assert.equal(refused.some((l) => /shell loop/.test(l)), false, refused.join("\n"));
	const redirect = bashWhy("for f in a b; do wc -l $f; done > src/x", ctx, []);
	assert.deepEqual(redirect, ["Why: writes output to a file (only /dev/null or a file in the scratch dir is allowed)."]);
	// nothing to expand: today's lines
	assert.deepEqual(bashWhy("npm test", ctx, []), ["Why: `npm test` isn't a read-only npm command."]);
});

test("a multi-stage pipe tail after done: read-only stages allow, a dangerous stage is judged on P", () => {
	const loop = 'for f in a.txt b.txt; do wc -l "$f"; done';
	for (const mode of ["default", "plan"] as const) {
		assert.equal(decide(MODES[mode].permissions, `${loop} | sort | uniq -c`).action, "allow", mode);
		const dangerous = decide(MODES[mode].permissions, `${loop} | sort | sh`);
		assert.equal(dangerous.action, mode === "plan" ? "deny" : "ask", mode);
		assert.equal(dangerous.rule?.match, "dangerousBash", mode);
		assert.equal(decide(MODES[mode].permissions, `${loop} | sort | while read l; do echo $l; done`).action, "ask", mode);
	}
});
