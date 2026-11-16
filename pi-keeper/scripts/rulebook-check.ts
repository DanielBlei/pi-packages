/**
 * Checks the installed rulebook against the intent of each rule: every sample
 * sentence below is one the rule MUST fire on, or one it MUST stay quiet on.
 * Same code path as pi (`loadRulebook` + `matchRules`), so a green run means the
 * real rules behave, not a copy of them.
 *
 * Run: `npm run rulebook-check` (default: `<agent dir>/pi-keeper/rules`),
 * or `npm run rulebook-check -- --dir <path> --verbose`.
 *
 * When you edit a rule: add the sentence that annoyed you to `fires`, add the
 * legitimate phrasing it must not touch to `quiet`, run this, and keep the
 * regex as narrow as the samples allow. A sample that cannot be satisfied is a
 * rule whose intent is not expressible as a regex — say so and drop the rule
 * rather than widen the pattern.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadRulebook, matchRules, type RulebookRule } from "../extensions/rulebook.ts";

interface Samples {
	/** Sentences the rule must fire on. */
	readonly fires: readonly string[];
	/** Legitimate sentences it must not touch. */
	readonly quiet: readonly string[];
}

/** One entry per installed rule file name (without `.md`). */
const SAMPLES: Record<string, Samples> = {
	// Intent: police blast radius, not bookkeeping. A small change needs no proof;
	// a sweeping claim ("all tests pass", "everything works", "no regressions")
	// about something that can affect other things does.
	"claims-need-evidence": {
		fires: [
			"All 26 tests pass.",
			"All 309 tests pass (the new base brought 10 upstream tests along).",
			"Everything works now.",
			"The full suite passes and all checks are green.",
			"All good.",
			"It works end to end.",
			"No regressions.",
			"Nothing else changed.",
			"I verified everything against the old behaviour.",
		],
		quiet: [
			// small change, plainly described: the model should NOT be pushed into a test run
			"Created 2 files: a.ts and b.ts.",
			"Renamed one function in utils.ts.",
			"One test passes now, the new one.",
			"I did not run the full suite.",
			// a specific result, already quoted: nothing to ask for
			"npm test: 935 passed.",
			"The other tests are unaffected.",
			"Not verified.",
			"I tested the parser by hand.",
			// prose that merely contains the words (real false positives from the corpus)
			"Item 5's whole approach did not work; it needs `nodeSelector: {}`.",
			"Every caplog assertion in this repo passed alone and failed in the full suite.",
			"All seven stages passed in 88 s.",
			"Every registry problem needs a verdict, which is data work on 34+ entries.",
			"Not all tests pass yet.",
		],
	},
	"no-unrequested-commits": {
		fires: [
			"I've committed the changes.",
			"Committed and pushed to origin.",
			"Committed 33 files, all in W3 scope.",
			"Committing: 3 files.",
			"I pushed the branch.",
			"Opened a PR: #1234.",
			"Created a pull request for review.",
			"I committed everything.",
		],
		quiet: [
			"Nothing is committed yet.",
			"I did not commit or push.",
			"Should I commit and push?",
			"The commit message is ready.",
			"We are committed to the deadline.",
			"`git commit -m 'x'` is what I would run.",
		],
	},
	"no-unrequested-scope": {
		fires: [
			"While I'm here, I updated the README too.",
			"As a bonus I refactored the parser.",
			"I also added a retry wrapper.",
			"Bonus: I cleaned up the imports.",
		],
		quiet: [
			"I also added a test for that, as you asked.",
			"The bonus field in the schema is optional.",
			"I did not change anything outside that file.",
			"While the job ran I read the logs.",
		],
	},
};

const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir");
const verbose = args.includes("--verbose");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const dir = dirArg === -1 ? join(agentDir, "pi-keeper", "rules") : (args[dirArg + 1] ?? "");

if (dir === "") {
	console.error("usage: npm run rulebook-check -- --dir <rules dir> [--verbose]");
	process.exit(2);
}

/** The finder production uses, over the directory the user actually installed into. */
const book = loadRulebook({ cwd: dir, agentDir, trustedHash: () => undefined });
const byName = new Map(book.rules.map((rule) => [rule.name, rule]));

console.log(`rulebook: ${dir}`);
console.log(`installed: ${book.rules.length === 0 ? "(none)" : book.rules.map((r) => r.name).join(", ")}`);
for (const problem of book.problems) console.log(`  skipped: ${problem.file} — ${problem.problem}`);
console.log("");

let failures = 0;
let checked = 0;

function report(rule: RulebookRule, sentence: string, expectFire: boolean, verdict: boolean): void {
	checked++;
	const ok = verdict === expectFire;
	if (!ok) failures++;
	const want = expectFire ? "fire " : "quiet";
	const got = verdict ? "fired" : "quiet";
	const line = `  ${ok ? "ok  " : "FAIL"} ${want} / ${got}  ${JSON.stringify(sentence)}`;
	if (!ok || verbose) console.log(line);
}

for (const [name, samples] of Object.entries(SAMPLES)) {
	const rule = byName.get(name);
	if (rule === undefined) {
		console.log(`${name}: not installed (samples skipped)`);
		continue;
	}
	console.log(`${name}  (${rule.description})`);
	console.log(`  condition: ${rule.condition}`);
	for (const sentence of samples.fires) report(rule, sentence, true, matchRules([rule], sentence, new Set()).length > 0);
	for (const sentence of samples.quiet) report(rule, sentence, false, matchRules([rule], sentence, new Set()).length > 0);
	console.log("");
}

const untested = book.rules.filter((rule) => SAMPLES[rule.name] === undefined).map((rule) => rule.name);
if (untested.length > 0) console.log(`no samples (add them to scripts/rulebook-check.ts): ${untested.join(", ")}`);

console.log(`${checked - failures}/${checked} samples behave as intended${failures === 0 ? "" : `, ${failures} wrong`}`);
process.exit(failures === 0 ? 0 : 1);
