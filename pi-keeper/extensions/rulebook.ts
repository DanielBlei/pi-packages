/**
 * The rulebook: behaviour rules that fire only when the model goes off-script.
 *
 * A rule lives in a Markdown file with a small frontmatter block: a one-line
 * `description`, one regex `condition`, and a body that is the correction. The
 * body never enters the prompt, so a rule costs no context until it matches the
 * model's finished answer (`turn_end` in index.ts). This is the point of the
 * module: the contract and the mode prompts are paid for on every request and
 * dilute as they grow; a rule is paid for once, on the turn it catches.
 *
 * The rule file shape (description + condition + body), once-per-session by
 * rule name, and skipping an uncompilable pattern with a warning are ideas from
 * oh-my-pi's rulebook (https://github.com/can1357/oh-my-pi, MIT); no code was
 * taken. This module is the warn path only: match the finished text,
 * deliver ONE hidden correction, record the fire, never interrupt the stream
 * and never touch a tool call.
 *
 * Deliberately free of pi types and of pi imports (like project-rules.ts), so
 * every rule in it is unit-tested with plain strings and temp dirs. That is also
 * why the frontmatter is split by hand instead of with pi's YAML parser: v1
 * accepts one flat `key: value` per line and one condition per rule.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { RULE_WARNING } from "./modes.ts";
import { findProjectRoot, sha256 } from "./project-rules.ts";

/** `customType` of the hidden correction. Never shown in the transcript. */
export const RULE_MESSAGE = "pi-keeper-rule";

/**
 * `customType` of a fired rule: one `custom` entry per rule per session. It is
 * the session record (read back from the branch) and the card (index.ts
 * registers an entry renderer for it). Custom entries never reach the model.
 */
export const RULE_FIRED_ENTRY = "pi-keeper-rule-fired";

/** Where a project keeps its rulebook: `<project>/.pi/rules/*.md`. */
export const RULE_DIR = join(".pi", "rules");

/** Where the user keeps theirs: `<agent dir>/pi-keeper/rules/*.md`. */
export const USER_RULE_DIR = "rules";

/**
 * How much of the finished answer a condition is matched against: the tail, in
 * characters. A regex is user data and runs inside an awaited turn boundary, so
 * a catastrophic pattern must not be handed a megabyte of text; violations sit
 * at the end of an answer in practice (a claim about the work just done).
 */
export const RULE_SCAN_CAP = 20_000;

/**
 * Longest rule BODY carried in one correction, in characters. Capped per rule, not
 * for the batch, so one long rule cannot crowd out a second rule that fired with
 * it. A rule is a sentence or two, not a document.
 */
export const RULE_BODY_CAP = 1_200;

/**
 * Hard ceiling for the rendered correction, in characters. Reached only by many
 * rules firing in one turn (per-body caps make a one-rule message far smaller).
 */
export const RULE_TEXT_CAP = 4_000;

/** How many fires in one run may ask for a continuation (see index.ts turn_end). */
export const RULES_PER_RUN_CAP = 2;

/** One parsed rule. */
export interface RulebookRule {
	/** The file name without `.md`; the identity for once-per-session and for `/rules`. */
	readonly name: string;
	/** Where it came from: the user's own directory, or the project's (reviewed once). */
	readonly kind: "user" | "project";
	readonly file: string;
	readonly description: string;
	/** The condition as written, for `/rules`; the compiled form is `pattern`. */
	readonly condition: string;
	readonly pattern: RegExp;
	/** The correction text: what the model is told when the rule fires. */
	readonly body: string;
	readonly hash: string;
}

/** A file that could not become a rule, and why (reported once, then skipped). */
export interface RulebookProblem {
	readonly file: string;
	readonly problem: string;
}

export interface LoadedRulebook {
	/** Usable rules, user files first (a user rule shadows a project rule of the same name). */
	readonly rules: readonly RulebookRule[];
	/** One line per skipped file. */
	readonly problems: readonly RulebookProblem[];
	/** Project files whose content the user has not reviewed yet (trust gate). */
	readonly untrusted: readonly { readonly file: string; readonly hash: string }[];
}

/** Rule files are Markdown; a directory holds nothing else we read. */
export const RULE_FILE = /\.md$/i;

/**
 * Split `---` frontmatter from the body. Flat `key: value` lines only, with
 * surrounding single or double quotes stripped; a repeat of a key keeps the
 * first. Everything after the closing `---` is the body (trimmed).
 *
 * Hand-written so this module needs no YAML and no pi import. A value may
 * contain `:` (a regex often does): the split is at the first one.
 */
export function splitFrontmatter(text: string): { readonly fields: Record<string, string>; readonly body: string } {
	const normalized = text.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
	if (!normalized.startsWith("---\n")) return { fields: {}, body: normalized.trim() };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { fields: {}, body: normalized.trim() };
	const fields: Record<string, string> = {};
	for (const line of normalized.slice(4, end).split("\n")) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const at = line.indexOf(":");
		if (at <= 0) continue;
		const key = line.slice(0, at).trim().toLowerCase();
		if (key === "" || key in fields) continue;
		fields[key] = unquote(line.slice(at + 1).trim());
	}
	return { fields, body: normalized.slice(end + 4).trim() };
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
	return value;
}

/**
 * Compile one condition. A leading inline flag group (`(?i)`, `(?m)`, `(?s)`,
 * or a combination) becomes the RegExp flags, as in the reference
 * implementation; `g` is never set, because `test()` with `g` carries state from
 * one call to the next. `undefined` means the pattern does not compile.
 */
export function compileCondition(source: string): RegExp | undefined {
	let flags = "";
	let rest = source;
	for (;;) {
		const inline = /^\(\?([ims]+)\)/.exec(rest);
		if (inline === null) break;
		flags = [...new Set(flags + inline[1])].join("");
		rest = rest.slice(inline[0].length);
	}
	try {
		return new RegExp(rest, flags);
	} catch {
		return undefined;
	}
}

/**
 * One rule file to a rule, or the reason it cannot be one. Pure: the caller
 * decides what to do with `{ problem }` (index.ts reports it once and skips).
 */
export function parseRuleFile(file: string, kind: "user" | "project", text: string): RulebookRule | RulebookProblem {
	const name = basename(file).replace(RULE_FILE, "");
	const { fields, body } = splitFrontmatter(text);
	const description = fields.description ?? "";
	const condition = fields.condition ?? "";
	if (description === "") return { file, problem: "no `description:` in the frontmatter" };
	if (condition === "") return { file, problem: "no `condition:` in the frontmatter (the regex that makes it fire)" };
	const pattern = compileCondition(condition);
	if (pattern === undefined) return { file, problem: `the condition does not compile as a regex: ${condition}` };
	if (body === "") return { file, problem: "the body is empty, so there is no correction to send" };
	return { name, kind, file, description, condition, pattern, body, hash: sha256(text) };
}

const isProblem = (parsed: RulebookRule | RulebookProblem): parsed is RulebookProblem => "problem" in parsed;

/** Sorted `.md` files of a directory; [] when it is absent or unreadable. */
function ruleFilesIn(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((entry) => RULE_FILE.test(entry))
			.sort()
			.map((entry) => join(dir, entry));
	} catch {
		return [];
	}
}

export interface LoadRulebookInput {
	readonly cwd: string;
	readonly agentDir: string;
	/**
	 * The content hash last reviewed for a project file, if any. A project rule
	 * file that instructs the model needs the same one-time review as project
	 * permission rules (docs/design.md, "Trust boundaries").
	 */
	readonly trustedHash: (file: string) => string | undefined;
}

/**
 * Every rule file of this project and this user. Never throws: an unreadable or
 * malformed file becomes one line in `problems`. An unreviewed project file is
 * left out of `rules` and reported in `untrusted`, so a cloned repository
 * cannot instruct the model before the user says yes.
 */
export function loadRulebook({ cwd, agentDir, trustedHash }: LoadRulebookInput): LoadedRulebook {
	const rules: RulebookRule[] = [];
	const problems: RulebookProblem[] = [];
	const untrusted: Array<{ file: string; hash: string }> = [];
	const seen = new Set<string>();

	const read = (file: string, kind: "user" | "project"): void => {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			problems.push({ file, problem: `could not be read (${error instanceof Error ? error.message : String(error)})` });
			return;
		}
		if (kind === "project") {
			const hash = sha256(text);
			if (trustedHash(file) !== hash) {
				untrusted.push({ file, hash });
				return;
			}
		}
		const parsed = parseRuleFile(file, kind, text);
		if (isProblem(parsed)) {
			problems.push(parsed);
			return;
		}
		// the user's own rule wins over a project rule of the same name, as in the reference
		if (seen.has(parsed.name)) return;
		seen.add(parsed.name);
		rules.push(parsed);
	};

	const projectDir = join(findProjectRoot(cwd), RULE_DIR);
	const userDir = join(agentDir, "pi-keeper", USER_RULE_DIR);
	for (const file of ruleFilesIn(userDir)) read(file, "user");
	for (const file of ruleFilesIn(projectDir)) read(file, "project");
	return { rules, problems, untrusted };
}

/** The identity a fire is recorded against (rule name, once per session). */
export const ruleKey = (rule: RulebookRule): string => rule.name;

/**
 * The rules this text breaks: not fired yet, and one `test()` on the tail of the
 * text. Pure. `fired` holds `ruleKey`s already delivered this session, which is
 * what makes a rule fire once.
 */
export function matchRules(rules: readonly RulebookRule[], text: string, fired: ReadonlySet<string>): RulebookRule[] {
	if (text === "") return [];
	const tail = text.length > RULE_SCAN_CAP ? text.slice(-RULE_SCAN_CAP) : text;
	return rules.filter((rule) => !fired.has(ruleKey(rule)) && rule.pattern.test(tail));
}

/**
 * The one hidden message for a batch of fired rules: ONE header, then a block per
 * rule (name, description, body). Capped per body (`RULE_BODY_CAP`) and as a whole
 * (`RULE_TEXT_CAP`), so neither one long rule nor a dozen of them can flood the
 * context, and a second rule never loses its instruction to the first one.
 * `RULE_WARNING` is empty only if prompts/rule-warning.md went missing; one line
 * instead of nothing, like the contract's fallback.
 */
export function correctionText(rules: readonly RulebookRule[]): string {
	const template = RULE_WARNING === "" ? "A rulebook rule matched your last message. Fix a real violation in your next message.\n\n{{rules}}" : RULE_WARNING;
	const blocks = rules.map((rule) => {
		const body = rule.body.length > RULE_BODY_CAP ? `${rule.body.slice(0, RULE_BODY_CAP)}\n…(rule text truncated)` : rule.body;
		return [`## Rule: ${rule.name}`, "", rule.description, "", body].join("\n");
	});
	// a function replacement: `$&`, `$1` and `` $` `` in a rule body stay literal
const text = template.replace("{{rules}}", () => blocks.join("\n\n"));
	return text.length > RULE_TEXT_CAP ? `${text.slice(0, RULE_TEXT_CAP)}\n…(${rules.length} rules fired; the rest is in /rules <name>)` : text;
}

/** A fire as it is recorded in the session: read back by `/rules` and after a resume. */
export interface RuleFireRecord {
	readonly rule: string;
	readonly kind: "user" | "project";
	/** The rule's one-line description, so the card renders without reading the file again. */
	readonly description: string;
	/** ISO time, so a resumed session still shows when it happened. */
	readonly at: string;
}

/**
 * The rules already fired on this branch: the session entries are the source of
 * truth, so a resume, a fork or a compaction can never re-fire one. Only
 * `custom` entries of our own type count, and one whose payload is unusable is
 * ignored rather than trusted.
 */
export function firedFromBranch(branch: readonly { type?: string; customType?: string; data?: unknown }[]): Set<string> {
	const fired = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== RULE_FIRED_ENTRY) continue;
		const data = entry.data as Partial<RuleFireRecord> | undefined;
		if (data !== undefined && typeof data.rule === "string" && data.rule !== "") fired.add(data.rule);
	}
	return fired;
}

/** The user's rulebook directory for this agent dir (index.ts and docs/guide.md name it). */
export const userRuleDir = (agentDir: string): string => resolve(join(agentDir, "pi-keeper", USER_RULE_DIR));
