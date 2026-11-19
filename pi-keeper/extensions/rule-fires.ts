/**
 * Lifetime fire counts for rulebook rules, kept in
 * `<agent dir>/pi-keeper/rule-fires.json`:
 *
 *   { "version": 1, "user": { "<rule>": 12 }, "projects": { "<sha256(project root)>": { "<rule>": 3 } } }
 *
 * A user rule is counted across all projects, a project rule per project.
 * The file is re-read right before every increment (another session may have
 * written it), written atomically (temp file + rename) with mode 0600 in a 0700
 * directory. A missing, unreadable or malformed file reads as empty, and a
 * failed write is ignored: a fire must never fail because of its count.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findProjectRoot, sha256 } from "./project-rules.ts";

export interface RuleFires {
	version: 1;
	user: Record<string, number>;
	projects: Record<string, Record<string, number>>;
}

export type RuleKind = "user" | "project";

export const ruleFiresFile = (agentDir: string): string => join(agentDir, "pi-keeper", "rule-fires.json");

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Only positive whole numbers survive; a hand-edited or damaged entry is dropped. */
function cleanCounts(value: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (!isObject(value)) return out;
	for (const [name, count] of Object.entries(value)) if (typeof count === "number" && Number.isInteger(count) && count > 0) out[name] = count;
	return out;
}

/** The store; anything missing, unreadable or malformed reads as empty. Never throws. */
export function readRuleFires(agentDir: string): RuleFires {
	const out: RuleFires = { version: 1, user: {}, projects: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(ruleFiresFile(agentDir), "utf8"));
		if (!isObject(parsed)) return out;
		out.user = cleanCounts(parsed.user);
		if (isObject(parsed.projects)) for (const [key, counts] of Object.entries(parsed.projects)) out.projects[key] = cleanCounts(counts);
	} catch {
		return { version: 1, user: {}, projects: {} };
	}
	return out;
}

/** The lifetime counts that apply here: the user rules' (global) and this project's. */
export function ruleFireCounts(agentDir: string, cwd: string): { user: Record<string, number>; project: Record<string, number> } {
	try {
		const store = readRuleFires(agentDir);
		return { user: store.user, project: store.projects[sha256(findProjectRoot(cwd))] ?? {} };
	} catch {
		return { user: {}, project: {} };
	}
}

/** Count one fire; returns the new count, or undefined when it could not be saved. Never throws. */
export function recordRuleFire(agentDir: string, cwd: string, kind: RuleKind, name: string): number | undefined {
	const file = ruleFiresFile(agentDir);
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		const store = readRuleFires(agentDir);
		let counts = store.user;
		if (kind === "project") {
			const key = sha256(findProjectRoot(cwd));
			counts = store.projects[key] ?? (store.projects[key] = {});
		}
		const next = (Object.hasOwn(counts, name) ? counts[name] : 0) + 1;
		counts[name] = next;
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		try { chmodSync(dirname(file), 0o700); } catch { /* not ours to change */ }
		writeFileSync(temp, `${JSON.stringify(store, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, file);
		return next;
	} catch {
		try { unlinkSync(temp); } catch { /* nothing to clean */ }
		return undefined;
	}
}
