/**
 * Per-project permission rules for pi-keeper, persisted in
 * `<project root>/.pi/settings.local.json` under a namespaced key:
 *
 *   { "pi-keeper": { "permissions": { "allow": ["Bash(git commit *)"],
 *     "ask": ["Bash(git push *)"], "deny": ["Bash(terraform destroy *)"] } } }
 *
 * `Bash(<tokens> *)` is a token-wise prefix rule, `Bash(<tokens>)` an exact
 * match on the whole canonical command. deny and ask only make things
 * stricter, so they always load. allow rules are code-execution consent:
 * they load only when the file's hash matches one we recorded (every time
 * we write it, or the user approves it in a review), because pi's own
 * project trust can't protect this file. Parsing, matching and the file I/O
 * live here, free of pi types, so they are testable.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { canonicalize, commandUnits, hasRemoval, isPrivilegedCommand, isRememberableExact, isRememberablePrefix } from "./utils.ts";
import { countWork } from "./perf.ts";
import { parseGrantKey } from "./tool-grants.ts";

export const NAMESPACE = "pi-keeper";

export const RULES_FILE = join(".pi", "settings.local.json");
export type RuleList = "allow" | "ask" | "deny";

export interface ParsedRule {
	/** The entry as written. */
	text: string;
	/** Canonical tokens (`rtk git add *` → git, add). */
	tokens: string[];
	/** True for `Bash(<tokens>)`: the whole command must equal the tokens. */
	exact: boolean;
}

/** `Read(<dir>/**)` in the allow list: reads from an outside directory run without asking. */
export interface ParsedReadDir {
	/** The entry as written. */
	text: string;
	/** Absolute, normalized, no trailing slash. */
	dir: string;
}

/** `Fetch(<host>)` in the allow list: a curl/wget GET to that host runs without asking. */
export interface ParsedFetchHost {
	/** The entry as written. */
	text: string;
	/** Lowercase hostname. */
	host: string;
}

/** `BashExact(<command text>)` in the allow list: that whole command, character for character, runs without asking. */
export interface ParsedVerbatim {
	/** The entry as written, trimmed. */
	text: string;
	/** The command text (trimmed), compared as verbatimKey (rules.ts). */
	command: string;
}

/** `Tool(<name>)` / `Mcp([<server>/]<tool>)` (tool-grants.ts): a tool that is not built in, or a gateway call. */
export interface ParsedToolRule {
	/** The entry as written, trimmed. */
	text: string;
	/** The canonical key (`Tool(x)`, `Mcp(server/tool)`), compared with the call's key. */
	key: string;
}

export interface ParsedRules {
	allow: ParsedRule[];
	ask: ParsedRule[];
	deny: ParsedRule[];
	/** Allow-list `Read(<dir>/**)` entries. */
	readDirs: ParsedReadDir[];
	/** Allow-list `Fetch(<host>)` entries. */
	fetchHosts: ParsedFetchHost[];
	/** Allow-list `BashExact(<command text>)` entries. */
	allowVerbatim: ParsedVerbatim[];
	/** `Tool(...)` / `Mcp(...)` entries of the allow, ask and deny lists. */
	allowTools: ParsedToolRule[];
	askTools: ParsedToolRule[];
	denyTools: ParsedToolRule[];
	/** Malformed entries and structure problems, one line each. */
	warnings: string[];
}

/** Rules in effect for decisions (see rules.ts). */
export interface ProjectPermissions {
	/** Trusted allow rules only: prefixes plus exact commands. */
	/** `verbatim`: trusted BashExact command texts (absent in hand-built permissions: read as none). */
	allow: { prefixes: string[][]; exact: string[][]; verbatim?: string[] };
	ask: ParsedRule[];
	deny: ParsedRule[];
	/** Trusted `Read(<dir>/**)` directories (outside reads that run without asking; secrets still ask). */
	readDirs: string[];
	/** Trusted `Fetch(<host>)` hosts (curl/wget GETs that run without asking). */
	fetchHosts: string[];
	/** Trusted `Tool(...)` / `Mcp(...)` allow keys (absent in hand-built permissions: read as none). */
	tools?: string[];
	/** `Tool(...)` / `Mcp(...)` ask and deny keys; they always load. */
	askTools?: string[];
	denyTools?: string[];
	/** The file exists but cannot be read or parsed: every shell command asks (see LoadedRules.broken). */
	broken?: string;
}

export const NO_PROJECT_RULES: ProjectPermissions = { allow: { prefixes: [], exact: [], verbatim: [] }, ask: [], deny: [], readDirs: [], fetchHosts: [], tools: [], askTools: [], denyTools: [] };

/**
 * Parse a `Tool(<name>)` or `Mcp([<server>/]<tool>)` entry: undefined when it isn't one, an error when it names
 * something that can't be granted (bash, the gateway itself, a built-in tool, `mcpScript`).
 */
export function parseToolRule(entry: string): ParsedToolRule | { error: string } | undefined {
	const parsed = parseGrantKey(entry);
	if (parsed === undefined) return undefined;
	if ("error" in parsed) return parsed;
	return { text: entry.trim(), key: parsed.key };
}

/**
 * Parse a `Read(<dir>/**)` entry: undefined when it isn't one, an error when
 * the directory can't be granted (relative, "/", the home dir or one of its
 * ancestors — those would open every secret below them).
 */
export function parseReadDir(entry: string): ParsedReadDir | { error: string } | undefined {
	const m = /^Read\(([\s\S]*)\)$/.exec(entry.trim());
	if (m === null) return undefined;
	const body = m[1].trim();
	if (!body.endsWith("/**")) return { error: "not of the form Read(<absolute dir>/**)" };
	const dir = body.slice(0, -3);
	// the review dialog lists the path; a newline or escape could fake another line
	if (/[\x00-\x1f\x7f-\x9f]/.test(dir)) return { error: "contains control characters" };
	if (!isAbsolute(dir) || normalize(dir) !== dir || dir.endsWith("/")) return { error: "the directory must be an absolute, normalized path" };
	const home = homedir();
	if (dir === "" || dir === "/" || home === dir || home.startsWith(`${dir}/`)) return { error: "can't allow reads from / or the home directory (or its ancestors)" };
	return { text: entry.trim(), dir };
}

/** The allow entry for reads from a directory. */
export function readDirRuleFor(dir: string): string {
	return `Read(${dir}/**)`;
}

/** A hostname as curl/wget would reach it: letters, digits, dots and dashes, with a dot (no IPs-in-disguise games, no ports). */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * Parse a `Fetch(<host>)` entry, or the `WebFetch(domain:<host>)` spelling Claude Code's settings use: undefined
 * when it isn't one, an error when the host isn't a plain hostname.
 */
export function parseFetchHost(entry: string): ParsedFetchHost | { error: string } | undefined {
	const trimmed = entry.trim();
	const plain = /^Fetch\(([\s\S]*)\)$/.exec(trimmed);
	const alias = plain === null ? /^WebFetch\(([\s\S]*)\)$/.exec(trimmed) : null;
	const m = plain ?? alias;
	if (m === null) return undefined;
	let host = m[1].trim();
	if (alias !== null) {
		if (!host.startsWith("domain:")) return { error: "not of the form WebFetch(domain:<hostname>)" };
		host = host.slice("domain:".length).trim();
	}
	host = host.toLowerCase();
	if (!HOSTNAME.test(host)) return { error: `not of the form ${alias !== null ? "WebFetch(domain:<hostname>)" : "Fetch(<hostname>)"}` };
	return { text: entry.trim(), host };
}

/** The allow entry for fetches from a host. */
export function fetchRuleFor(host: string): string {
	return `Fetch(${host})`;
}

/**
 * Parse a `BashExact(<command text>)` entry: undefined when it isn't one, an
 * error when the body is empty or holds a control character other than tab
 * and newline. The body runs to the last `)`, so it may contain parentheses.
 */
export function parseVerbatim(entry: string): ParsedVerbatim | { error: string } | undefined {
	const m = /^BashExact\(([\s\S]*)\)$/.exec(entry.trim());
	if (m === null) return undefined;
	const command = m[1].trim();
	if (command === "") return { error: "names no command" };
	if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(command)) return { error: "contains control characters" };
	// the same limits as an exact token rule: nothing that removes or escalates, anywhere in the text
	if (hasRemoval(command) || isPrivilegedCommand(command)) return { error: "can't be allowed (removal or privilege command)" };
	return { text: entry.trim(), command };
}

/** The allow entry for one exact command text (the text is trimmed, as verbatimKey does). */
export function verbatimRuleFor(command: string): string {
	return `BashExact(${command.trim()})`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse one rule entry, or return why it was rejected. */
export function parseRule(entry: string, list: RuleList): ParsedRule | { error: string } {
	const m = /^Bash\(([\s\S]*)\)$/.exec(entry.trim());
	if (m === null) return { error: "not of the form Bash(<command>) or Bash(<command> *)" };
	// Claude Code's `Bash(rm:*)` is the same prefix rule as `Bash(rm *)`
	let body = m[1].trim().replace(/:\*$/, " *");
	let exact = true;
	if (body.endsWith(" *")) {
		exact = false;
		body = body.slice(0, -2).trim();
	}
	if (/[\x00-\x1f\x7f-\x9f]/.test(body)) return { error: "contains control characters" };
	if (/[;&|<>()$`"'\\*?[\]{}\n]/.test(body)) return { error: "contains shell syntax or a wildcard (only a trailing ` *` is supported)" };
	const tokens = canonicalize(body.split(/\s+/).filter((t) => t !== ""));
	if (tokens.length === 0) return { error: "names no command" };
	// the same limits as "Yes, and always allow": nothing that runs any program
	// (an exact rule may: it names one command token-for-token), no removals
	if (list === "allow") {
		const rememberable = exact ? isRememberableExact(tokens) : isRememberablePrefix(tokens);
		if (!rememberable) return { error: exact ? "can't be allowed (removal or privilege command)" : "can't be allowed (interpreter, runner, removal or privilege command)" };
	}
	return { text: entry.trim(), tokens, exact };
}

/**
 * Parse a rule typed by the user: `git commit *`, `npm test`, or the full
 * `Bash(git commit *)`. Same checks as a file entry (allow: rememberable only).
 */
export function parsePattern(text: string, list: RuleList): ParsedRule | { error: string } {
	const t = text.trim();
	return parseRule(/^Bash\(/.test(t) ? t : `Bash(${t})`, list);
}

/** Parse the file's JSON. Malformed entries are skipped and reported. */
export function parseRules(json: unknown): ParsedRules {
	const out: ParsedRules = { allow: [], ask: [], deny: [], readDirs: [], fetchHosts: [], allowVerbatim: [], allowTools: [], askTools: [], denyTools: [], warnings: [] };
	const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
	if (!isObject(json)) return out;
	const ns = json[NAMESPACE];
	if (ns === undefined) return out;
	const permissions = isObject(ns) ? ns.permissions : undefined;
	if (!isObject(permissions)) {
		if (!isObject(ns) || ns.permissions !== undefined) out.warnings.push(`\`${NAMESPACE}.permissions\` is not an object`);
		return out;
	}
	for (const list of ["allow", "ask", "deny"] as const) {
		const entries = permissions[list];
		if (entries === undefined) continue;
		if (!Array.isArray(entries)) {
			out.warnings.push(`\`${list}\` is not a list`);
			continue;
		}
		for (const entry of entries) {
			const label = typeof entry === "string" ? entry : JSON.stringify(entry);
			const readDir = typeof entry === "string" ? parseReadDir(entry) : undefined;
			if (readDir !== undefined) {
				if (list !== "allow") out.warnings.push(`${list}: ignored \`${label}\` (Read(...) entries belong in allow)`);
				else if ("error" in readDir) out.warnings.push(`${list}: ignored \`${label}\` (${readDir.error})`);
				else out.readDirs.push(readDir);
				continue;
			}
			const fetchHost = typeof entry === "string" ? parseFetchHost(entry) : undefined;
			if (fetchHost !== undefined) {
				if (list !== "allow") out.warnings.push(`${list}: ignored \`${label}\` (Fetch(...) entries belong in allow)`);
				else if ("error" in fetchHost) out.warnings.push(`${list}: ignored \`${label}\` (${fetchHost.error})`);
				else out.fetchHosts.push(fetchHost);
				continue;
			}
			const verbatim = typeof entry === "string" ? parseVerbatim(entry) : undefined;
			if (verbatim !== undefined) {
				if (list !== "allow") out.warnings.push(`${list}: ignored \`${label}\` (BashExact(...) entries belong in allow)`);
				else if ("error" in verbatim) out.warnings.push(`${list}: ignored \`${label}\` (${verbatim.error})`);
				else out.allowVerbatim.push(verbatim);
				continue;
			}
			const toolRule = typeof entry === "string" ? parseToolRule(entry) : undefined;
			if (toolRule !== undefined) {
				if ("error" in toolRule) out.warnings.push(`${list}: ignored \`${label}\` (${toolRule.error})`);
				else out[`${list}Tools`].push(toolRule);
				continue;
			}
			const parsed = typeof entry === "string" ? parseRule(entry, list) : { error: "not a string" };
			if ("error" in parsed) out.warnings.push(`${list}: ignored \`${label}\` (${parsed.error})`);
			else out[list].push(parsed);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Matching (ask / deny)
// ---------------------------------------------------------------------------

/**
 * A prefix rule matches a command's tokens from the start, skipping flags
 * and their values between the rule's tokens (`git -C x push` matches
 * `git push *`, `kubectl -n ns apply` matches `kubectl apply *`); an exact
 * rule needs equality. Skipping only makes ask/deny match more.
 */
function unitMatches(rule: ParsedRule, unit: readonly string[]): boolean {
	const [root, ...wanted] = rule.tokens;
	// a bare name in the rule also matches the command named by path (`/usr/bin/make`, `./make`)
	const named = (t: string): boolean => t === root || (!root.includes("/") && basename(t) === root);
	if (rule.exact) return unit.length === rule.tokens.length && unit.every((t, k) => (k === 0 ? named(t) : t === rule.tokens[k]));
	if (!named(unit[0])) return false;
	let u = 1;
	for (const token of wanted) {
		while (u < unit.length && unit[u] !== token && (unit[u].startsWith("-") || unit[u - 1].startsWith("-"))) u++;
		if (unit[u] !== token) return false;
		u++;
	}
	return true;
}

/** The first rule that matches any simple command in `command`, if any. */
export function findMatchingRule(rules: readonly ParsedRule[], command: string): ParsedRule | undefined {
	if (rules.length === 0) return undefined;
	const units = commandUnits(command).map((unit) => canonicalize(unit));
	return rules.find((rule) => units.some((unit) => unitMatches(rule, unit)));
}

/** Rules that take effect: ask/deny always, allow only when `allowActive`. */
export function compilePermissions(rules: ParsedRules, allowActive: boolean, broken?: string): ProjectPermissions {
	const allow = allowActive ? rules.allow : [];
	return {
		allow: { prefixes: allow.filter((r) => !r.exact).map((r) => r.tokens), exact: allow.filter((r) => r.exact).map((r) => r.tokens), verbatim: allowActive ? rules.allowVerbatim.map((r) => r.command) : [] },
		ask: rules.ask,
		deny: rules.deny,
		readDirs: allowActive ? rules.readDirs.map((r) => r.dir) : [],
		fetchHosts: allowActive ? rules.fetchHosts.map((r) => r.host) : [],
		tools: allowActive ? rules.allowTools.map((r) => r.key) : [],
		askTools: rules.askTools.map((r) => r.key),
		denyTools: rules.denyTools.map((r) => r.key),
		...(broken === undefined ? {} : { broken }),
	};
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Nearest ancestor of `cwd` with a `.git` entry (file or directory), else `cwd`. */
export function findProjectRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (;;) {
		countWork("fs");
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

export function rulesPath(cwd: string): string {
	return join(findProjectRoot(cwd), RULES_FILE);
}

/** True when `path` lies strictly inside `dir` (both resolved; a path prefix alone is not enough). */
export function isInsideDir(path: string, dir: string): boolean {
	return resolve(path).startsWith(`${resolve(dir)}${sep}`);
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Cheap change detector for the rules file (stat only). */
export function fileSignature(file: string): string {
	try {
		countWork("fs");
		const st = statSync(file);
		return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
	} catch {
		return "absent";
	}
}

function trustStorePath(agentDir: string): string {
	return join(agentDir, NAMESPACE, "trusted-rules.json");
}

/** The trust store: recorded approvals of project rule files, by absolute path. Absent or unusable reads as empty. */
function readTrustStore(agentDir: string): Record<string, string> {
	try {
		const data: unknown = JSON.parse(readFileSync(trustStorePath(agentDir), "utf8"));
		if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
		return Object.fromEntries(Object.entries(data).filter((e): e is [string, string] => typeof e[1] === "string"));
	} catch {
		return {};
	}
}

/** Throws when the trust store exists but is not a JSON object: recording over it would drop every other approval. */
function assertTrustStoreUsable(agentDir: string): void {
	const path = trustStorePath(agentDir);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new Error(`${path} cannot be read; fix or delete it`);
	}
	// an empty file holds no approval to lose
	if (text.trim() === "") return;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		data = undefined;
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`${path} is not valid JSON; fix or delete it`);
}

/** Record `hash` as reviewed for `file`. Throws (and writes nothing) when the trust store is malformed. */
export function recordTrust(agentDir: string, file: string, hash: string): void {
	assertTrustStoreUsable(agentDir);
	const store = readTrustStore(agentDir);
	store[resolve(file)] = hash;
	atomicWrite(trustStorePath(agentDir), `${JSON.stringify(store, null, 2)}\n`);
}

/**
 * The content hash last reviewed for `file`, if any. One store for every file
 * that can write model instructions: the project's permission rules here and
 * the project's rulebook files (rulebook.ts), keyed by absolute path.
 */
export function trustedHash(agentDir: string, file: string): string | undefined {
	return readTrustStore(agentDir)[resolve(file)];
}

/** Write via a temp file in the same directory, then rename. */
export function atomicWrite(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, content, { mode: 0o600 });
		renameSync(tmp, file);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// nothing to clean up
		}
		throw error;
	}
}

export interface LoadedRules {
	file: string;
	exists: boolean;
	/** sha256 of the content; undefined when the file is absent. */
	hash?: string;
	/** The hash is one we recorded (or there is no file). */
	trusted: boolean;
	rules: ParsedRules;
	/**
	 * Why the file exists but its rules are unknown (not valid JSON, or unreadable such as EACCES or EISDIR).
	 * While set, every shell command asks: a broken file must not silently drop the user's rules.
	 */
	broken?: string;
}

const NO_RULES: ParsedRules = { allow: [], ask: [], deny: [], readDirs: [], fetchHosts: [], allowVerbatim: [], allowTools: [], askTools: [], denyTools: [], warnings: [] };

/** Read, parse and trust-check the project's rules file. Never throws. */
export function loadProjectRules(cwd: string, agentDir: string): LoadedRules {
	const file = rulesPath(cwd);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, exists: false, trusted: true, rules: NO_RULES };
		const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
		return { file, exists: true, trusted: true, rules: NO_RULES, broken: `the file cannot be read (${code})` };
	}
	const hash = sha256(text);
	const trusted = readTrustStore(agentDir)[resolve(file)] === hash;
	if (text.trim() === "") return { file, exists: true, hash, trusted, rules: NO_RULES };
	try {
		return { file, exists: true, hash, trusted, rules: parseRules(JSON.parse(text)) };
	} catch {
		return { file, exists: true, hash, trusted, rules: { ...NO_RULES, warnings: ["the file is not valid JSON; no rules loaded"] }, broken: "the file is not valid JSON" };
	}
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface SaveResult {
	file: string;
	/** Rule entries newly added (empty when all were already there). */
	added: string[];
	/** The new content was recorded as trusted (false when the file held unreviewed content). */
	trusted: boolean;
}

/** `Bash(git commit *)` for a prefix. */
export function ruleFor(prefix: readonly string[]): string {
	return `Bash(${prefix.join(" ")} *)`;
}

/** `Bash(npm test)` for an exact command. */
export function exactRuleFor(tokens: readonly string[]): string {
	return `Bash(${tokens.join(" ")})`;
}

/** The file's JSON object (`{}` when absent or empty) and whether the content it holds is trusted. Throws on invalid JSON / non-objects. */
function readRulesDoc(file: string, agentDir: string, approvedHash: string | undefined): { doc: Record<string, unknown>; existing: string | undefined; wasTrusted: boolean } {
	let existing: string | undefined;
	try {
		existing = readFileSync(file, "utf8");
	} catch {
		existing = undefined;
	}
	let doc: Record<string, unknown> = {};
	if (existing !== undefined && existing.trim() !== "") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(existing);
		} catch {
			throw new Error(`${file} is not valid JSON; not overwriting it`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object; not overwriting it`);
		doc = parsed as Record<string, unknown>;
	}
	const wasTrusted =
		existing === undefined || existing.trim() === "" || readTrustStore(agentDir)[resolve(file)] === sha256(existing) || approvedHash === sha256(existing);
	return { doc, existing, wasTrusted };
}

const asObject = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Add rule entries (`Bash(...)` text) to one list of the project's file,
 * keeping every other key, deduping, with stable 2-space formatting. Each
 * entry must pass parseRule for that list (allow: rememberable only). The
 * new content is recorded as trusted only when the content it replaces was:
 * the file is absent, its hash is recorded, or it equals `approvedHash` (the
 * user reviewed it this session). Otherwise unreviewed rules would be
 * blessed by our write. Throws on I/O errors, an invalid entry, or a file
 * that isn't a JSON object (it is never overwritten).
 */
export function saveRules(cwd: string, agentDir: string, list: RuleList, entries: readonly string[], approvedHash?: string): SaveResult {
	const root = findProjectRoot(cwd);
	const file = join(root, RULES_FILE);
	for (const entry of entries) {
		const special = list === "allow" ? (parseReadDir(entry) ?? parseFetchHost(entry) ?? parseVerbatim(entry)) : undefined;
		const parsed = special ?? parseToolRule(entry) ?? parseRule(entry, list);
		if ("error" in parsed) throw new Error(`${entry}: ${parsed.error}`);
	}
	const { doc, wasTrusted } = readRulesDoc(file, agentDir, approvedHash);
	const ns = asObject(doc[NAMESPACE]);
	const permissions = asObject(ns.permissions);
	const current: unknown[] = Array.isArray(permissions[list]) ? (permissions[list] as unknown[]) : [];
	const added: string[] = [];
	for (const entry of entries) {
		if (!current.includes(entry) && !added.includes(entry)) added.push(entry);
	}
	if (added.length > 0) {
		doc[NAMESPACE] = { ...ns, permissions: { ...permissions, [list]: [...current, ...added] } };
		const content = `${JSON.stringify(doc, null, 2)}\n`;
		atomicWrite(file, content);
		ensureGitExclude(root);
		if (wasTrusted) recordTrust(agentDir, file, sha256(content));
	}
	return { file, added, trusted: wasTrusted };
}

/** Add allow rules for prefixes (see saveRules). */
export function saveAllowRules(cwd: string, agentDir: string, prefixes: readonly (readonly string[])[], approvedHash?: string): SaveResult {
	return saveRules(cwd, agentDir, "allow", prefixes.map(ruleFor), approvedHash);
}

export interface RemoveResult {
	file: string;
	/** The entry was in the list and is gone. */
	removed: boolean;
	/** The new content was recorded as trusted (same rule as saveRules). */
	trusted: boolean;
}

/**
 * Remove the entry `ruleText` (as written, trimmed) from one list of the
 * project's file. Other keys and entries are kept; an emptied list is
 * dropped. Trust works as in saveRules: the new hash is recorded only if the
 * replaced content was trusted or equals `approvedHash`. Nothing is written
 * when the entry isn't there. Throws on I/O errors or a file that isn't a
 * JSON object.
 */
export function removeRule(cwd: string, agentDir: string, list: RuleList, ruleText: string, approvedHash?: string): RemoveResult {
	const root = findProjectRoot(cwd);
	const file = join(root, RULES_FILE);
	const { doc, existing, wasTrusted } = readRulesDoc(file, agentDir, approvedHash);
	if (existing === undefined) return { file, removed: false, trusted: wasTrusted };
	const ns = asObject(doc[NAMESPACE]);
	const permissions = asObject(ns.permissions);
	const current: unknown[] = Array.isArray(permissions[list]) ? (permissions[list] as unknown[]) : [];
	const wanted = ruleText.trim();
	const kept = current.filter((e) => !(typeof e === "string" && e.trim() === wanted));
	if (kept.length === current.length) return { file, removed: false, trusted: wasTrusted };
	const { [list]: _dropped, ...rest } = permissions;
	doc[NAMESPACE] = { ...ns, permissions: kept.length > 0 ? { ...rest, [list]: kept } : rest };
	const content = `${JSON.stringify(doc, null, 2)}\n`;
	atomicWrite(file, content);
	if (wasTrusted) recordTrust(agentDir, file, sha256(content));
	return { file, removed: true, trusted: wasTrusted };
}

/** The `info/exclude` file for the repo at `root`, when simple to find. */
function gitExcludePath(root: string): string | undefined {
	const dotGit = join(root, ".git");
	try {
		if (statSync(dotGit).isDirectory()) return join(dotGit, "info", "exclude");
		// worktree/submodule: `.git` is a file `gitdir: <path>`; excludes live in the common dir
		const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
		if (m === null) return undefined;
		const gitdir = resolve(root, m[1].trim());
		let common = gitdir;
		try {
			common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
		} catch {
			// no commondir: a plain gitdir (submodule)
		}
		return join(common, "info", "exclude");
	} catch {
		return undefined;
	}
}

/** Best effort: list the rules file in `.git/info/exclude` (never `.gitignore`). */
export function ensureGitExclude(root: string): void {
	const exclude = gitExcludePath(root);
	if (exclude === undefined) return;
	try {
		let current = "";
		try {
			current = readFileSync(exclude, "utf8");
		} catch {
			// created below
		}
		const entry = ".pi/settings.local.json";
		if (current.split("\n").some((line) => [entry, `/${entry}`].includes(line.trim()))) return;
		mkdirSync(dirname(exclude), { recursive: true });
		appendFileSync(exclude, `${current === "" || current.endsWith("\n") ? "" : "\n"}${entry}\n`);
	} catch {
		// read-only repo or unusual layout: skip quietly
	}
}

// ---------------------------------------------------------------------------
// Workflow commands (prompt templates)
// ---------------------------------------------------------------------------

/**
 * The `Bash(...)` grants of a prompt template's `allowed-tools` frontmatter:
 * a string (`Bash(git add *) Bash(git commit *)`) or a list of such strings.
 * Other tools are ignored; the legacy `Bash(git commit:*)` spelling is read
 * as `git commit *`. Each grant gets the same checks as an "Yes, and always allow"
 * rule; rejected ones are reported, never applied.
 */
export function parseAllowedTools(value: unknown): { rules: ParsedRule[]; warnings: string[] } {
	const rules: ParsedRule[] = [];
	const warnings: string[] = [];
	const texts = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	for (const text of texts) {
		for (const m of text.matchAll(/Bash\(([^()]*)\)/g)) {
			const parsed = parsePattern(m[1].replace(/:\*$/, " *"), "allow");
			if ("error" in parsed) warnings.push(`ignored \`${m[0]}\` (${parsed.error})`);
			else if (!rules.some((r) => r.text === parsed.text)) rules.push(parsed);
		}
	}
	return { rules, warnings };
}
