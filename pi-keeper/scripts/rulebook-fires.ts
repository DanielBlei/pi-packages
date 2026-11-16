/**
 * How often would each installed rule fire, and on how many sessions? Run over
 * past sessions (the same logs the permission telemetry reads), so a rule can be
 * judged on real history before it is trusted, and re-judged after an edit.
 *
 * For every session it rebuilds the assistant text, then asks the rulebook (the
 * same `matchRules` pi calls) whether the rule would have fired. `evidence`
 * adds a heuristic column: does the neighbourhood of the match contain a command
 * or its output? For a claim rule, "no evidence" is the interesting half; for a
 * commit rule that column says nothing (a commit next to "committed" is exactly
 * the case where asking matters).
 *
 * Read-only. Run: `npm run rulebook-fires` (default: ~/.pi/agent/sessions),
 * `npm run rulebook-fires -- --dir <sessions dir> --evidence`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRulebook } from "../extensions/rulebook.ts";

const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir");
const withEvidence = args.includes("--evidence");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const sessionsDir = dirArg === -1 ? join(agentDir, "sessions") : (args[dirArg + 1] ?? "");
const rulesDir = join(agentDir, "pi-keeper", "rules");

if (sessionsDir === "") {
	console.error("usage: npm run rulebook-fires -- [--dir <sessions dir>] [--evidence]");
	process.exit(2);
}

/** A command or its output in the same neighbourhood: the claim looks backed. */
const EVIDENCE = /```|\bnpm test\b|\bpytest\b|\bmake test\b|ruff clean|\bOK \(\d+|\b\d+ passed\b|\bRan \d+ tests?\b|\bexit code\b/i;
/** Characters either side of a match that count as "nearby". */
const WINDOW = 400;

const book = loadRulebook({ cwd: sessionsDir, agentDir, trustedHash: () => undefined });
if (book.rules.length === 0) {
	console.log(`no rules installed in ${rulesDir}`);
	process.exit(0);
}
if (book.problems.length > 0) {
	for (const problem of book.problems) console.log(`skipped: ${problem.file} — ${problem.problem}`);
	console.log("");
}

const stats = new Map(book.rules.map((rule) => [rule.name, { sessions: new Set<string>(), turns: 0, backed: 0 }]));
let projectDirs = 0;
let sessionFiles = 0;

for (const project of readdirSync(sessionsDir, { withFileTypes: true })) {
	if (!project.isDirectory()) continue;
	projectDirs++;
	const projectDir = join(sessionsDir, project.name);
	for (const entry of readdirSync(projectDir)) {
		if (!entry.endsWith(".jsonl")) continue;
		sessionFiles++;
		const file = join(projectDir, entry);
		const text = assistantText(file);
		if (text === "") continue;
		for (const rule of book.rules) {
			const match = rule.pattern.exec(text);
			if (match === null) continue;
			const stat = stats.get(rule.name);
			if (stat === undefined) continue;
			stat.turns++;
			stat.sessions.add(file);
			if (EVIDENCE.test(text.slice(Math.max(0, match.index - WINDOW), match.index + WINDOW))) stat.backed++;
		}
	}
}

/** Every assistant text block of one session, in order, as one string. */
function assistantText(file: string): string {
	const parts: string[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"assistant"')) continue;
		let entry: { message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.message?.role !== "assistant") continue;
		const text = (entry.message.content ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
		if (text !== "") parts.push(text);
	}
	return parts.join("\n");
}

console.log(`rules: ${book.rules.map((rule) => rule.name).join(", ")}`);
console.log(`corpus: ${sessionFiles} session files in ${projectDirs} project dirs (${sessionsDir})`);
console.log("");
console.log(`${"rule".padEnd(26)} ${"sessions".padStart(8)} ${"turns".padStart(6)}${withEvidence ? `  ${"evidence nearby".padStart(15)}` : ""}`);
for (const [name, stat] of stats) {
	const share = stat.turns === 0 ? "" : `  ${`${Math.round((stat.backed / stat.turns) * 100)}%`.padStart(15)}`;
	console.log(`${name.padEnd(26)} ${String(stat.sessions.size).padStart(8)} ${String(stat.turns).padStart(6)}${withEvidence ? share : ""}`);
}
console.log("");
console.log("A rule fires at most once per session, so `sessions` is the number of extra corrections");
console.log("(each with one request) this rule would have cost over this corpus. A rule that fires in");
console.log("most sessions is too broad; one that fires in none never matches the phrasing you meant.");
if (withEvidence) console.log("`evidence nearby` reads: of the matching turns, how many already show a command or its output.");
