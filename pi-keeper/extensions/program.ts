/**
 * Program expander: turns a bash command with top-level literal assignments
 * and `for` loops into the straight-line text `P` that the rules judge.
 *
 *   x=docs; for f in a b; do wc -l $x/$f; done   ->   wc -l docs/a; wc -l docs/b
 *
 * This is a security boundary: `P` is read by the permission rules, so every
 * doubt is a refusal. A refusal returns the ORIGINAL text plus a `problem`, so
 * callers see exactly today's input. A command without a `for` loop or a
 * standalone assignment is returned untouched and without a problem.
 *
 * The expander has its own small lexer (`tokenize` drops the quote context it
 * needs) and checks its result against `tokenize` at the end: `tokenize(P)`
 * must succeed and must split `P` into the same simple commands and words.
 * `cmd < path` (a literal path) is judged as `cat path | cmd`, and a loop over
 * an unquoted glob expands against the cwd when `options.globs` is set.
 * A whole-unit `python3 -c '<script>'` or `python3 - <<'DELIM'` is replaced by the
 * effect program of `analyzePythonScript` (`cat -- reads; ls -- lists; touch -- writes`).
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { analyzePythonScript, type PythonEffects } from "./python.ts";
import { isInsideScratch, isReadOnlyCommand, LITERAL_PATH_CHARS, MAX_COMMAND_LENGTH, tokenize, unparseableReason } from "./utils.ts";

export interface ExpandOptions {
	cwd: string;
	scratch?: string;
	env: Readonly<Record<string, string | undefined>>;
	/** Expand `for` loops over unquoted globs against `cwd` (a session grant). Without it such a loop is refused. */
	globs?: boolean;
}

export interface Program {
	text: string;
	changed: boolean;
	problem?: string;
}

/** The loop limits (plan D3). */
export const MAX_LOOP_WORDS = 16;
export const MAX_LOOP_BODIES = 64;
/** A loop over a glob may have this many words in all. */
export const MAX_GLOB_WORDS = 64;

/** Problem texts. Tests assert these exactly. */
export const PROBLEMS = {
	chars: "non-ASCII or control characters are not supported",
	substitution: "command substitution (`$(` or a backtick) is not supported",
	heredoc: "`<<` is not supported",
	dollarQuote: "`$'` and `$\"` quoting is not supported",
	braceOperator: "`${` with an operator is not supported",
	brackets: "`{`, `}`, `(` and `)` are not supported outside `${name}`",
	ifs: "assigning IFS is not supported",
	envVar: (key: string) => `\`${key}\` is set in the environment, so word splitting or startup files may differ`,
	backslash: "a backslash outside single quotes is not supported",
	quote: "the command has an unterminated quote",
	separator: (op: string) => `\`${op}\` is not a supported separator`,
	empty: "an empty command next to a separator is not supported",
	onlyRedirect: "a command with only redirections is not supported",
	dangling: (op: string) => `the command ends after \`${op}\``,
	inputForm: "`<&`, `<>` and a descriptor before `<` are not supported",
	inputMany: "more than one `<` input redirection in a command is not supported",
	inputPath: "the `<` input is not a plain literal path",
	inputPipe: "`<` in a later stage of a pipe is not supported",
	redirectTarget: "a redirection has no target",
	redirectDup: "`>&` needs a file descriptor or `-`",
	rootBuiltin: (name: string) => `\`${name}\` can change variables or the shell, so it is not supported with variables or loops`,
	printfV: "`printf -v` sets a variable, so it is not supported with variables or loops",
	keyword: (word: string) => `\`${word}\` is a compound command, and only \`for\` loops are expanded`,
	array: "an array element assignment is not supported",
	assignMany: "an assignment together with other words, redirections or assignments is not supported",
	nameForm: (name: string) => `\`${name}\` is not a plain lowercase variable name`,
	nameUnderscore: "`_` is a special shell variable",
	nameEnv: (name: string) => `\`${name}\` is set in the environment`,
	nameSpecial: (name: string) => `\`${name}\` is a special shell variable`,
	plusEquals: (name: string) => `\`${name}+=\` appends to a variable, so it is not supported`,
	value: (name: string) => `the value of \`${name}\` is not a plain literal`,
	position: (name: string, op: string) => `\`${name}\` is set after \`${op}\`, so it may not be set when it is used`,
	follow: (name: string, op: string) => `\`${name}\` is followed by \`${op}\`, so it may not be set when it is used`,
	rebind: (name: string) => `\`${name}\` is set more than once`,
	use: (name: string) => `\`${name}\` is used outside the place where it is set`,
	tilde: (name: string) => `\`${name}\` is used right after \`~\``,
	digitRedirect: "a substitution would make a number into a redirection descriptor",
	newAssignment: "a substitution would create an assignment",
	bodyAssign: "an assignment in a loop body is not supported",
	loopPosition: (op: string) => `a \`for\` loop after \`${op}\` is not supported`,
	loopSyntax: "the loop is not of the form `for name in words; do body; done`",
	loopEmpty: "a `for` loop with no words is not supported",
	loopMany: (n: number) => `a \`for\` loop with ${n} words is not supported, the limit is ${MAX_LOOP_WORDS}`,
	loopWord: "a `for` loop word is not a plain literal",
	globNeedsGrant: "a `for` loop over a glob needs the loop-glob grant",
	globWord: "a glob in a `for` loop must be an unquoted plain pattern with a wildcard",
	globDir: "a glob in a `for` loop may have wildcards only in its last path segment",
	globStar: "`**` in a `for` loop glob is not supported",
	globClass: "a character class like `[:alpha:]` in a `for` loop glob is not supported",
	globCd: (word: string) => `\`${word}\` runs before a \`for\` loop over a glob, so the glob may match in another directory`,
	globWrite: (text: string) => `\`${text}\` is not read-only and runs before a \`for\` loop over a glob, so the glob may match other files`,
	globScratch: "a glob in a `for` loop may not list the scratch directory",
	globNone: (word: string) => `the glob \`${word}\` matches nothing`,
	globDash: (match: string) => `the glob match \`${match}\` starts with \`-\``,
	globChars: (match: string) => `the glob match \`${match}\` has a character that is not a plain path character`,
	globMany: (n: number) => `a \`for\` loop over a glob with ${n} words is not supported, the limit is ${MAX_GLOB_WORDS}`,
	loopJump: (word: string) => `\`${word}\` in a loop body is not supported`,
	loopBodies: `the loops unroll to more than ${MAX_LOOP_BODIES} bodies`,
	loopAfter: (op: string) => `a \`for\` loop followed by \`${op}\` is not supported`,
	loopTrailer: "only output redirections and one pipe may follow `done`",
	loopPipeCd: (word: string) => `\`${word}\` in the body of a piped loop would run in a subshell`,
	loopPipeTail: "the pipe tail of a loop must end at `;`, `&&`, `||` or a newline",
	pyDouble: "`python3 -c` with a double-quoted script is not analyzed, only a single-quoted one",
	pyArgv: "`python3 -c '...'` may not be followed by arguments, redirections or other words",
	pyBackground: "`python3` followed by `&` is not analyzed",
	pyHeredoc: "a python heredoc needs a quoted delimiter and nothing else on its line",
	pyHeredocOpen: "the python heredoc has no closing delimiter line",
	pyPipe: "`python3` after a pipe reads its input from the pipe, so it is not analyzed",
	pyDir: (word: string) => `\`${word}\` changes the directory, so the run directory of python3 may differ`,
	pyPath: (path: string) => `the python path ${JSON.stringify(path)} cannot be written into the effect program`,
	leftover: (name: string) => `\`$${name}\` is still used in the expanded command`,
	tooLong: `the expanded command is longer than ${MAX_COMMAND_LENGTH} characters`,
	/** The classifier's own reason for the expanded text (`unparseableReason`). */
	notParsed: (expanded: string) => unparseableReason(expanded.trim()),
	mismatch: "the tokenizer splits the command differently than the expander",
	internal: "the expander failed",
};

class Refusal extends Error {}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type QuoteContext = "plain" | "double" | "single";

interface Piece {
	start: number;
	end: number;
	ctx: QuoteContext;
}

interface Word {
	start: number;
	end: number;
	pieces: Piece[];
	/** Quotes removed, nothing else expanded. */
	cooked: string;
}

interface Redirect {
	start: number;
	end: number;
	kind: "out" | "dup" | "in";
	target?: Word;
}

interface Unit {
	/** Words that are not redirect operators or targets. */
	words: Word[];
	redirs: Redirect[];
	targets: Word[];
	/** First and last-end index of the unit's tokens. */
	start: number;
	end: number;
	/** Whitespace between the previous separator and this unit. */
	gap: string;
	/** `;`, `&&`, `||`, `|`, `&`, `\n`, or "" at the end of the text. */
	sepOp: string;
	sepStart: number;
	sepEnd: number;
	/** Set by `splitDo` on the lone `do` of `do\n body`. */
	doMarker?: boolean;
	/** True when the unit that held `do` also held the first body words. */
	doBody?: boolean;
}

interface Lexed {
	units: Unit[];
	/** Text after the last separator when no unit follows it. */
	trailing: string;
}

interface Site {
	start: number;
	end: number;
	name: string;
}

/**
 * Lex into units (simple commands) and words with quote context. Strict mode
 * throws a Refusal on anything outside the supported subset. Lenient mode only
 * finds the units, for deciding whether the command holds a construct; it
 * returns null for an unterminated quote.
 */
function lex(text: string, strict: boolean): Lexed | null {
	const units: Unit[] = [];
	let words: Word[] = [];
	let redirs: Redirect[] = [];
	let targets: Word[] = [];
	let tokStart = -1;
	let tokEnd = -1;
	let prevSepEnd = 0;
	let lastOp = "";
	let cur: { start: number; cooked: string; pieces: Piece[] } | null = null;
	let expect: Redirect | null = null;
	let inSingle = false;
	let inDouble = false;
	let i = 0;

	const fail = (message: string): void => {
		if (strict) throw new Refusal(message);
	};
	const add = (ch: string, ctx: QuoteContext, idx: number): void => {
		if (cur === null) cur = { start: idx, cooked: "", pieces: [] };
		cur.cooked += ch;
		const last = cur.pieces[cur.pieces.length - 1];
		if (last !== undefined && last.ctx === ctx && last.end === idx) last.end = idx + 1;
		else cur.pieces.push({ start: idx, end: idx + 1, ctx });
	};
	const open = (idx: number): void => {
		if (cur === null) cur = { start: idx, cooked: "", pieces: [] };
	};
	const endWord = (at: number): void => {
		if (cur === null) return;
		const word: Word = { start: cur.start, end: at, pieces: cur.pieces, cooked: cur.cooked };
		cur = null;
		if (tokStart < 0) tokStart = word.start;
		tokEnd = at;
		if (expect !== null) {
			expect.target = word;
			expect.end = at;
			targets.push(word);
			expect = null;
		} else {
			words.push(word);
		}
	};
	const finishUnit = (op: string, sepStart: number, sepEnd: number): void => {
		endWord(sepStart);
		if (expect !== null) {
			fail(PROBLEMS.redirectTarget);
			expect = null;
		}
		if (words.length === 0) {
			fail(redirs.length === 0 ? PROBLEMS.empty : PROBLEMS.onlyRedirect);
		} else {
			units.push({
				words,
				redirs,
				targets,
				start: tokStart,
				end: tokEnd,
				gap: text.slice(prevSepEnd, tokStart),
				sepOp: op,
				sepStart,
				sepEnd,
			});
		}
		words = [];
		redirs = [];
		targets = [];
		tokStart = -1;
		tokEnd = -1;
		prevSepEnd = sepEnd;
		lastOp = op;
	};
	const redirectFrom = (opStart: number): void => {
		// `i` is on the first `>`
		i++;
		if (text[i] === ">") i++;
		const redir: Redirect = { start: opStart, end: i, kind: "out" };
		if (text[i] === "&") {
			i++;
			if (text[i] === "-") {
				i++;
			} else {
				const digits = i;
				while (i < text.length && /[0-9]/.test(text[i] ?? "")) i++;
				if (i === digits) fail(PROBLEMS.redirectDup);
			}
			redir.kind = "dup";
			redir.end = i;
		} else {
			expect = redir;
		}
		redirs.push(redir);
		if (tokStart < 0) tokStart = opStart;
		tokEnd = i;
	};

	while (i < text.length) {
		const ch = text[i] ?? "";
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else add(ch, "single", i);
			i++;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				fail(PROBLEMS.backslash);
				add(ch, "double", i);
				if (i + 1 < text.length) add(text[i + 1] ?? "", "double", i + 1);
				i += 2;
				continue;
			}
			if (ch === '"') inDouble = false;
			else add(ch, "double", i);
			i++;
			continue;
		}
		if (ch === "\\") {
			fail(PROBLEMS.backslash);
			add(ch, "plain", i);
			if (i + 1 < text.length) add(text[i + 1] ?? "", "plain", i + 1);
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			open(i);
			if (ch === "'") inSingle = true;
			else inDouble = true;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			endWord(i);
			i++;
			continue;
		}
		if (ch === "&" && text[i + 1] === ">") {
			endWord(i);
			const opStart = i;
			i++;
			redirectFrom(opStart);
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
			let op = ch;
			let opEnd = i + 1;
			const next = text[i + 1] ?? "";
			if (ch === ";" && ";&|".includes(next) && next !== "") {
				fail(PROBLEMS.separator(ch + next));
				opEnd = i + 2;
			} else if (ch === "&" && next === "&") {
				op = "&&";
				opEnd = i + 2;
			} else if (ch === "|" && next === "|") {
				op = "||";
				opEnd = i + 2;
			} else if (ch === "|" && next === "&") {
				fail(PROBLEMS.separator("|&"));
				opEnd = i + 2;
			}
			while (text[opEnd] === "\n") opEnd++;
			finishUnit(op, i, opEnd);
			i = opEnd;
			continue;
		}
		if (ch === "<") {
			const next = text[i + 1] ?? "";
			if (next !== "" && "&<>(".includes(next)) {
				fail(PROBLEMS.inputForm);
				endWord(i);
				i++;
				while (next === "<" && text[i] === "<") i++;
				continue;
			}
			if (expect !== null) {
				fail(PROBLEMS.redirectTarget);
				expect = null;
			}
			let opStart = i;
			if (cur !== null && /^[0-9]$/.test((cur as { cooked: string }).cooked)) {
				fail(PROBLEMS.inputForm);
				opStart = (cur as { start: number }).start;
				cur = null;
			} else {
				endWord(i);
			}
			i++;
			const redir: Redirect = { start: opStart, end: i, kind: "in" };
			expect = redir;
			redirs.push(redir);
			if (tokStart < 0) tokStart = opStart;
			tokEnd = i;
			continue;
		}
		if (ch === ">") {
			let opStart = i;
			if (cur !== null && /^[0-9]$/.test((cur as { cooked: string }).cooked)) {
				opStart = (cur as { start: number }).start;
				cur = null;
			} else {
				endWord(i);
			}
			redirectFrom(opStart);
			continue;
		}
		if (ch === "#" && cur === null) {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		add(ch, "plain", i);
		i++;
	}

	if (inSingle || inDouble) {
		if (strict) throw new Refusal(PROBLEMS.quote);
		return null;
	}
	endWord(text.length);
	if (expect !== null) {
		fail(PROBLEMS.redirectTarget);
		expect = null;
	}
	let trailing = "";
	if (words.length === 0 && redirs.length === 0) {
		trailing = text.slice(prevSepEnd);
		if (strict && (lastOp === "&&" || lastOp === "||" || lastOp === "|")) throw new Refusal(PROBLEMS.dangling(lastOp));
	} else {
		finishUnit("", text.length, text.length);
	}
	return { units, trailing };
}

/** `$name` and `${name}` in unquoted or double-quoted parts of a word. */
function sitesIn(text: string, word: Word): Site[] {
	const sites: Site[] = [];
	for (const piece of word.pieces) {
		if (piece.ctx === "single") continue;
		for (let k = piece.start; k < piece.end; k++) {
			if (text[k] !== "$") continue;
			const rest = text.slice(k + 1, piece.end);
			if (rest.startsWith("{")) {
				const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
				if (m !== null) {
					sites.push({ start: k, end: k + 1 + m[0].length, name: m[1] ?? "" });
					k += m[0].length;
				}
				continue;
			}
			const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
			if (m !== null) {
				sites.push({ start: k, end: k + 1 + m[0].length, name: m[0] });
				k += m[0].length;
			}
		}
	}
	return sites;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const VALUE_CLASS = LITERAL_PATH_CHARS.replace(",=", "");
const LITERAL_VALUE = new RegExp(`^(?:([${VALUE_CLASS}]+)|'([${VALUE_CLASS}]+)'|"([${VALUE_CLASS}]+)")$`);
const NAME_FORM = /^[a-z_][a-z0-9_]*$/;
const DENIED_NAMES = new Set([
	"path",
	"cdpath",
	"fpath",
	"manpath",
	"module_path",
	"http_proxy",
	"https_proxy",
	"ftp_proxy",
	"all_proxy",
	"no_proxy",
]);
const LOOP_LIMIT_OPS_BEFORE = new Set(["", ";", "\n", "&&", "||"]);
const ASSIGN_PREV_OPS = new Set(["", ";", "\n"]);
const ASSIGN_NEXT_OPS = new Set([";", "&&", "\n", ""]);
const LOOP_NEXT_OPS = new Set([";", "&&", "||", "\n", ""]);
/** D3 roots, plus the builtins that run another builtin or leave the shell. */
const ROOT_BUILTINS = new Set([
	"read",
	"export",
	"unset",
	"declare",
	"typeset",
	"local",
	"readonly",
	"let",
	"eval",
	"source",
	".",
	"set",
	"shift",
	"getopts",
	"mapfile",
	"readarray",
	"command",
	"builtin",
	"exec",
	"wait",
]);
const KEYWORDS = new Set([
	"for",
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"function",
	"time",
	"coproc",
]);
const DIR_BUILTINS = new Set(["cd", "pushd", "popd"]);
const ASSIGN_WORD = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/;

function hasOwn(env: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(env, key);
}

/** Checks of the raw text, before and after expansion. */
function checkText(text: string): void {
	if (!/^[\x20-\x7e\n\t]*$/.test(text)) throw new Refusal(PROBLEMS.chars);
	if (text.includes("$(") || text.includes("`")) throw new Refusal(PROBLEMS.substitution);
	if (text.includes("<<")) throw new Refusal(PROBLEMS.heredoc);
	if (text.includes("$'") || text.includes('$"')) throw new Refusal(PROBLEMS.dollarQuote);
	if (/\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/.test(text)) throw new Refusal(PROBLEMS.braceOperator);
	if (/[(){}]/.test(text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ""))) throw new Refusal(PROBLEMS.brackets);
	if (/(?:^|[^A-Za-z0-9_])ifs\+?=/i.test(text)) throw new Refusal(PROBLEMS.ifs);
}

interface Cx {
	text: string;
	opts: ExpandOptions;
	units: Unit[];
	bound: Set<string>;
	env: Readonly<Record<string, string | undefined>>;
	bodies: number;
	assignWords: number;
	everBound: Set<string>;
}

interface Mode {
	body: boolean;
	noCd: boolean;
}

function rawOf(c: { text: string }, w: Word): string {
	return c.text.slice(w.start, w.end);
}

function firstKind(c: Cx, u: Unit): "for" | "done" | "other" {
	const w = u.words[0];
	if (w === undefined) return "other";
	const raw = rawOf(c, w);
	return raw === "for" ? "for" : raw === "done" ? "done" : "other";
}

function leadingAssignments(raws: readonly string[]): number {
	let n = 0;
	while (n < raws.length && ASSIGN_WORD.test(raws[n] ?? "")) n++;
	return n;
}

function checkName(c: Cx, name: string): void {
	if (name === "_") throw new Refusal(PROBLEMS.nameUnderscore);
	if (!NAME_FORM.test(name)) throw new Refusal(PROBLEMS.nameForm(name));
	if (hasOwn(c.env, name)) throw new Refusal(PROBLEMS.nameEnv(name));
	if (DENIED_NAMES.has(name)) throw new Refusal(PROBLEMS.nameSpecial(name));
}

/** The literal a value or loop word stands for, or null. */
function literalOf(raw: string): string | null {
	const m = LITERAL_VALUE.exec(raw);
	const content = m?.[1] ?? m?.[2] ?? m?.[3];
	if (content === undefined || content.startsWith("-")) return null;
	return content;
}

/** Replace `sites` inside [from, to) with their bound values. */
function renderSpan(c: Cx, from: number, to: number, sites: readonly Site[], bindings: ReadonlyMap<string, string>): string {
	let out = "";
	let at = from;
	for (const site of [...sites].filter((s) => s.start >= from && s.end <= to).sort((a, b) => a.start - b.start)) {
		const value = bindings.get(site.name);
		if (value === undefined) {
			if (c.bound.has(site.name)) throw new Refusal(PROBLEMS.use(site.name));
			continue;
		}
		if (site.start > 0 && c.text[site.start - 1] === "~") throw new Refusal(PROBLEMS.tilde(site.name));
		out += c.text.slice(at, site.start) + value;
		at = site.end;
	}
	return out + c.text.slice(at, to);
}

function renderWord(c: Cx, w: Word, bindings: ReadonlyMap<string, string>): string {
	return renderSpan(c, w.start, w.end, sitesIn(c.text, w), bindings);
}

function unquote(raw: string): string {
	return raw.replace(/['"]/g, "");
}

/** A simple command with its words substituted; the checks that look at the result. */
function renderUnit(c: Cx, u: Unit, from: number, bindings: ReadonlyMap<string, string>, mode: Mode, prevOp: string): string {
	const sites = [...u.words, ...u.targets].flatMap((w) => sitesIn(c.text, w));
	const inputs = u.redirs.filter((r) => r.kind === "in");
	let text: string;
	if (inputs.length === 0) {
		text = renderSpan(c, from, u.end, sites, bindings);
	} else {
		// `cmd args < path` is judged as `cat path | cmd args`
		if (inputs.length > 1) throw new Refusal(PROBLEMS.inputMany);
		if (prevOp === "|") throw new Refusal(PROBLEMS.inputPipe);
		const redir = inputs[0] as Redirect;
		if (redir.target === undefined) throw new Refusal(PROBLEMS.redirectTarget);
		const path = literalOf(renderWord(c, redir.target, bindings));
		if (path === null) throw new Refusal(PROBLEMS.inputPath);
		const before = renderSpan(c, from, redir.start, sites, bindings).trimEnd();
		const after = renderSpan(c, redir.end, u.end, sites, bindings);
		text = `cat ${path} | ${before === "" ? after.trimStart() : before + after}`;
	}
	const originals = u.words.map((w) => rawOf(c, w));
	const rendered = u.words.map((w) => renderWord(c, w, bindings));
	if (leadingAssignments(rendered) !== leadingAssignments(originals)) throw new Refusal(PROBLEMS.newAssignment);
	u.words.forEach((w, n) => {
		if (rendered[n] !== originals[n] && /^[0-9]$/.test(rendered[n] ?? "") && c.text[w.end] === ">") {
			throw new Refusal(PROBLEMS.digitRedirect);
		}
	});
	c.assignWords += leadingAssignments(rendered);
	if (mode.body) {
		const root = unquote(rendered[0] ?? "");
		if (root === "break" || root === "continue") throw new Refusal(PROBLEMS.loopJump(root));
		if (mode.noCd && DIR_BUILTINS.has(root)) throw new Refusal(PROBLEMS.loopPipeCd(root));
	}
	return text;
}

function renderSeq(
	c: Cx,
	from: number,
	to: number,
	bindings: Map<string, string>,
	mode: Mode,
	firstPrevOp: string,
	forcedGap: string | undefined,
	dropLast: boolean,
): string {
	let out = "";
	let carry: string | null = null as string | null;
	let first = true;
	let k = from;
	while (k < to) {
		const u = c.units[k] as Unit;
		const prevOp = k === from ? firstPrevOp : (c.units[k - 1] as Unit).sepOp;
		let gap: string = carry ?? u.gap;
		carry = null;
		if (first && forcedGap !== undefined) gap = forcedGap;
		const head = u.words[0] as Word;
		const headCooked = head.cooked;

		if (firstKind(c, u) === "for") {
			const loop = renderLoop(c, k, to, bindings, mode, prevOp, dropLast);
			out += gap + loop.text;
			k = loop.next;
			first = false;
			continue;
		}
		if (KEYWORDS.has(headCooked)) throw new Refusal(PROBLEMS.keyword(headCooked));
		if (/^[A-Za-z_][A-Za-z0-9_]*\[/.test(rawOf(c, head))) throw new Refusal(PROBLEMS.array);

		const raws = u.words.map((w) => rawOf(c, w));
		const assigns = leadingAssignments(raws);
		if (assigns > 0 && assigns === u.words.length) {
			// a standalone assignment
			if (mode.body) throw new Refusal(PROBLEMS.bodyAssign);
			if (assigns > 1 || u.redirs.length > 0) throw new Refusal(PROBLEMS.assignMany);
			const m = ASSIGN_WORD.exec(raws[0] ?? "") as RegExpExecArray;
			const name = m[1] ?? "";
			if (m[2] === "+=") throw new Refusal(PROBLEMS.plusEquals(name));
			checkName(c, name);
			const value = literalOf((raws[0] ?? "").slice(m[0].length));
			if (value === null) throw new Refusal(PROBLEMS.value(name));
			if (!ASSIGN_PREV_OPS.has(prevOp)) throw new Refusal(PROBLEMS.position(name, prevOp));
			if (!ASSIGN_NEXT_OPS.has(u.sepOp)) throw new Refusal(PROBLEMS.follow(name, u.sepOp));
			if (c.everBound.has(name) || bindings.has(name)) throw new Refusal(PROBLEMS.rebind(name));
			c.everBound.add(name);
			bindings.set(name, value);
			carry = gap; // the unit and its separator vanish
			k++;
			continue;
		}
		if (assigns > 0 && mode.body) throw new Refusal(PROBLEMS.bodyAssign);

		const text = renderUnit(c, u, u.start, bindings, mode, prevOp);
		const closing = dropLast && k === to - 1 ? "" : c.text.slice(u.end, u.sepEnd);
		out += gap + text + closing;
		first = false;
		k++;
	}
	return out;
}

function renderLoop(
	c: Cx,
	k: number,
	to: number,
	bindings: Map<string, string>,
	mode: Mode,
	prevOp: string,
	dropLast: boolean,
): { text: string; next: number } {
	const units = c.units;
	const h = units[k] as Unit;
	if (!LOOP_LIMIT_OPS_BEFORE.has(prevOp)) throw new Refusal(PROBLEMS.loopPosition(prevOp));
	const nameWord = h.words[1];
	const inWord = h.words[2];
	if (
		h.redirs.length > 0 ||
		nameWord === undefined ||
		inWord === undefined ||
		rawOf(c, nameWord) !== nameWord.cooked ||
		rawOf(c, inWord) !== "in" ||
		(h.sepOp !== ";" && h.sepOp !== "\n")
	) {
		throw new Refusal(PROBLEMS.loopSyntax);
	}
	const name = nameWord.cooked;
	checkName(c, name);
	if (bindings.has(name)) throw new Refusal(PROBLEMS.rebind(name));
	const wordList = h.words.slice(3);
	if (wordList.length === 0) throw new Refusal(PROBLEMS.loopEmpty);
	const hasGlob = wordList.some((w) => isGlobWord(c, w));
	if (hasGlob && c.opts.globs !== true) throw new Refusal(PROBLEMS.globNeedsGrant);
	if (!hasGlob && wordList.length > MAX_LOOP_WORDS) throw new Refusal(PROBLEMS.loopMany(wordList.length));
	// a glob word stays as its pattern until the loop's extent is known
	const items = wordList.map((w): { value: string } | { pattern: string } => {
		if (isGlobWord(c, w)) return { pattern: renderWord(c, w, bindings) };
		const value = literalOf(renderWord(c, w, bindings));
		if (value === null) throw new Refusal(PROBLEMS.loopWord);
		return { value };
	});

	const marker = k + 1 < to ? (units[k + 1] as Unit) : undefined;
	if (marker === undefined || marker.doMarker !== true) throw new Refusal(PROBLEMS.loopSyntax);
	if (marker.doBody !== true && marker.sepOp !== "\n") throw new Refusal(PROBLEMS.loopSyntax);

	let doneIdx = -1;
	let depth = 1;
	for (let j = k + 2; j < to; j++) {
		const kind = firstKind(c, units[j] as Unit);
		if (kind === "for") depth++;
		else if (kind === "done" && --depth === 0) {
			doneIdx = j;
			break;
		}
	}
	if (doneIdx < 0 || doneIdx === k + 2) throw new Refusal(PROBLEMS.loopSyntax);
	const lastBody = units[doneIdx - 1] as Unit;
	if (lastBody.sepOp !== ";" && lastBody.sepOp !== "\n") throw new Refusal(PROBLEMS.loopSyntax);

	const d = units[doneIdx] as Unit;
	const doneWord = d.words[0] as Word;
	if (d.words.length !== 1 || d.start !== doneWord.start || d.redirs.some((r) => r.kind === "in")) throw new Refusal(PROBLEMS.loopTrailer);
	let group = "";
	if (d.redirs.length > 0) {
		const sites = d.targets.flatMap((w) => sitesIn(c.text, w));
		const from = (d.redirs[0] as Redirect).start;
		group = ` ${renderSpan(c, from, d.end, sites, bindings)}`;
	}
	const piped = d.sepOp === "|";
	if (piped) {
		// plain stages: every stage but the last ends at `|`, the last at a list separator
		for (let j = doneIdx + 1; ; j++) {
			const stage = j < to ? (units[j] as Unit) : undefined;
			if (stage === undefined || firstKind(c, stage) === "done") throw new Refusal(PROBLEMS.loopTrailer);
			if (stage.sepOp === "|") continue;
			if (!LOOP_NEXT_OPS.has(stage.sepOp)) throw new Refusal(PROBLEMS.loopPipeTail);
			break;
		}
	} else if (!LOOP_NEXT_OPS.has(d.sepOp)) {
		throw new Refusal(PROBLEMS.loopAfter(d.sepOp));
	}

	let values: string[];
	if (hasGlob) {
		const spaceOk = usesAreDoubleQuoted(c, name, k + 2, doneIdx);
		values = [];
		let checked = false;
		for (const item of items) {
			if ("value" in item) {
				values.push(item.value);
				continue;
			}
			checkGlobPattern(item.pattern);
			if (!checked) {
				checkGlobContext(c, k, doneIdx, mode.body);
				checked = true;
			}
			values.push(...expandGlobWord(c, item.pattern, spaceOk));
		}
		if (values.length > MAX_GLOB_WORDS) throw new Refusal(PROBLEMS.globMany(values.length));
	} else {
		values = items.map((item) => (item as { value: string }).value);
	}

	const bodyMode: Mode = { body: true, noCd: mode.noCd || piped };
	const copies: string[] = [];
	for (const value of values) {
		if (++c.bodies > MAX_LOOP_BODIES) throw new Refusal(PROBLEMS.loopBodies);
		const inner = new Map(bindings);
		inner.set(name, value);
		copies.push(renderSeq(c, k + 2, doneIdx, inner, bodyMode, ";", "", true));
	}
	c.everBound.add(name);
	const closing = dropLast && doneIdx === to - 1 ? "" : c.text.slice(d.end, d.sepEnd);
	return { text: copies.join("; ") + group + closing, next: doneIdx + 1 };
}

// ---------------------------------------------------------------------------
// Glob loops
// ---------------------------------------------------------------------------

/** An unquoted `*`, `?` or `[` in a loop word. */
function isGlobWord(c: { text: string }, w: Word): boolean {
	return w.pieces.some((p) => p.ctx === "plain" && /[*?[]/.test(c.text.slice(p.start, p.end)));
}

const GLOB_WORD_CHARS = /^[A-Za-z0-9_\-./+@:*?[\]!^]+$/;

/** Shape checks of a rendered glob word, before anything is read. */
function checkGlobPattern(pattern: string): void {
	if (!GLOB_WORD_CHARS.test(pattern) || !/[*?[]/.test(pattern)) throw new Refusal(PROBLEMS.globWord);
	const slash = pattern.lastIndexOf("/");
	if (/[*?[]/.test(pattern.slice(0, slash + 1))) throw new Refusal(PROBLEMS.globDir);
	if (pattern.includes("**")) throw new Refusal(PROBLEMS.globStar);
	if (/\[[:=.]/.test(pattern)) throw new Refusal(PROBLEMS.globClass);
}

/** Regular expression of one glob path segment (bash, C locale), or null when it has no wildcard. */
function segmentRegExp(segment: string): RegExp | null {
	let source = "";
	let wild = false;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i] as string;
		if (ch === "*") {
			source += ".*";
			wild = true;
		} else if (ch === "?") {
			source += ".";
			wild = true;
		} else if (ch === "[") {
			let j = i + 1;
			let negate = false;
			if (segment[j] === "!" || segment[j] === "^") {
				negate = true;
				j++;
			}
			const first = j;
			if (segment[j] === "]") j++;
			while (j < segment.length && segment[j] !== "]") j++;
			if (j >= segment.length) {
				source += "\\[";
				continue;
			}
			const set = segment.slice(first, j).replace(/[\\\]^[]/g, (m) => "\\" + m);
			source += "[" + (negate ? "^" : "") + set + "]";
			wild = true;
			i = j;
		} else {
			source += ch.replace(/[.+\-:@!^\]]/g, (m) => "\\" + m);
		}
	}
	if (!wild) return null;
	try {
		return new RegExp("^" + source + "$");
	} catch {
		throw new Refusal(PROBLEMS.globWord);
	}
}

/** Bash order in the C locale: by byte. The names are ASCII, so by code unit. */
function byteOrder(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** True when every use of `name` in the loop body is inside double quotes. */
function usesAreDoubleQuoted(c: Cx, name: string, from: number, to: number): boolean {
	for (let j = from; j < to; j++) {
		const u = c.units[j] as Unit;
		for (const w of [...u.words, ...u.targets]) {
			for (const site of sitesIn(c.text, w)) {
				if (site.name !== name) continue;
				const piece = w.pieces.find((p) => site.start >= p.start && site.start < p.end);
				if (piece?.ctx !== "double") return false;
			}
		}
	}
	return true;
}

/** The text of a unit as the read-only check should see it: structure and input redirects left out. */
function judgedText(c: Cx, u: Unit): string | null {
	if (u.doMarker === true || u.words.length === 0) return null;
	const kind = firstKind(c, u);
	if (kind === "for") return null;
	if (kind === "done") return u.redirs.length === 0 ? null : "true " + c.text.slice((u.redirs[0] as Redirect).start, u.end);
	const raws = u.words.map((w) => rawOf(c, w));
	if (leadingAssignments(raws) === raws.length) return null;
	const input = u.redirs.find((r) => r.kind === "in");
	if (input === undefined) return c.text.slice(u.start, u.end);
	return (c.text.slice(u.start, input.start) + c.text.slice(input.end, u.end)).trim();
}

/**
 * A glob is read once, here, so nothing that runs earlier may change which
 * files it names: no `cd`, and nothing that is not read-only (scratch writes
 * count). Inside another loop the later copies run after the other units
 * too, so every unit outside this loop counts.
 */
function checkGlobContext(c: Cx, k: number, doneIdx: number, nested: boolean): void {
	for (let j = 0; j < c.units.length; j++) {
		if (j >= k && j <= doneIdx) continue;
		if (!nested && j > k) break;
		const u = c.units[j] as Unit;
		const text = judgedText(c, u);
		if (text === null) continue;
		const raws = u.words.map((w) => rawOf(c, w));
		const root = u.words[leadingAssignments(raws)];
		if (root !== undefined && (DIR_BUILTINS.has(root.cooked) || rawOf(c, root).includes("$"))) throw new Refusal(PROBLEMS.globCd(root.cooked));
		if (!isReadOnlyCommand(text, c.opts.cwd)) throw new Refusal(PROBLEMS.globWrite(text));
	}
}

/** The matches of one loop word, as bash lists them, each checked as a literal word. */
function expandGlobWord(c: Cx, pattern: string, spaceOk: boolean): string[] {
	const slash = pattern.lastIndexOf("/");
	const dir = pattern.slice(0, slash + 1);
	const segment = pattern.slice(slash + 1);
	const dirPath = resolve(c.opts.cwd, dir === "" ? "." : dir);
	if (c.opts.scratch !== undefined && isInsideScratch(dirPath, c.opts.scratch)) throw new Refusal(PROBLEMS.globScratch);
	const regexp = segmentRegExp(segment);
	if (regexp === null) throw new Refusal(PROBLEMS.globWord);
	if (segment.startsWith(".") && (regexp.test(".") || regexp.test(".."))) throw new Refusal(PROBLEMS.globWord);
	let names: string[];
	try {
		names = readdirSync(dirPath);
	} catch {
		names = [];
	}
	const matches = names
		.filter((name) => (!name.startsWith(".") || segment.startsWith(".")) && regexp.test(name))
		.map((name) => dir + name)
		.sort(byteOrder);
	if (matches.length === 0) throw new Refusal(PROBLEMS.globNone(pattern));
	const allowed = spaceOk ? /^[A-Za-z0-9_\-./+@: ]+$/ : /^[A-Za-z0-9_\-./+@:]+$/;
	for (const match of matches) {
		if (match.startsWith("-")) throw new Refusal(PROBLEMS.globDash(match));
		if (!allowed.test(match)) throw new Refusal(PROBLEMS.globChars(match));
	}
	return matches;
}

/** Split `do cmd` into a `do` marker and the first body unit. */
function splitDo(c: { text: string }, units: readonly Unit[]): Unit[] {
	const out: Unit[] = [];
	for (const u of units) {
		const w = u.words[0] as Word;
		if (rawOf(c, w) !== "do" || u.start !== w.start) {
			out.push(u);
			continue;
		}
		const rest = u.words.slice(1);
		const tokenStarts = [...rest.map((x) => x.start), ...u.redirs.map((r) => r.start)];
		if (tokenStarts.length === 0) {
			out.push({ ...u, doMarker: true, doBody: false });
			continue;
		}
		out.push({
			...u,
			words: [w],
			redirs: [],
			targets: [],
			end: w.end,
			sepOp: "do",
			sepStart: w.end,
			sepEnd: w.end,
			doMarker: true,
			doBody: true,
		});
		out.push({ ...u, words: rest, gap: "", start: Math.min(...tokenStarts) });
	}
	return out;
}

function isConstruct(c: { text: string }, u: Unit): boolean {
	if (u.words.length === 0) return false;
	if (rawOf(c, u.words[0] as Word) === "for") return true;
	if (u.redirs.some((r) => r.kind === "in")) return true;
	return u.words.every((w) => ASSIGN_WORD.test(rawOf(c, w)));
}

/** Checks of the expanded text `P`, on its own lexing. */
function checkExpanded(c: Cx, expanded: string, scratch: string | undefined): void {
	if (expanded.length > MAX_COMMAND_LENGTH) throw new Refusal(PROBLEMS.tooLong);
	checkText(expanded);
	const lexed = lex(expanded, true) as Lexed;
	let assignWords = 0;
	for (const u of lexed.units) {
		const raws = u.words.map((w) => expanded.slice(w.start, w.end));
		const assigns = leadingAssignments(raws);
		assignWords += assigns;
		const root = u.words[assigns];
		if (root !== undefined) {
			const word = root.cooked;
			if (KEYWORDS.has(word)) throw new Refusal(PROBLEMS.keyword(word));
			if (ROOT_BUILTINS.has(word)) throw new Refusal(PROBLEMS.rootBuiltin(word));
			if (word === "printf" && u.words.slice(assigns + 1).some((w) => w.cooked.startsWith("-v"))) {
				throw new Refusal(PROBLEMS.printfV);
			}
		}
		for (const w of [...u.words, ...u.targets]) {
			for (const site of sitesIn(expanded, w)) {
				if (c.bound.has(site.name)) throw new Refusal(PROBLEMS.leftover(site.name));
			}
		}
	}
	if (assignWords !== c.assignWords) throw new Refusal(PROBLEMS.newAssignment);

	const tokens = tokenize(expanded, scratch);
	if (tokens === null) throw new Refusal(PROBLEMS.notParsed(expanded));
	if (tokens.length !== lexed.units.length) throw new Refusal(PROBLEMS.mismatch);
	tokens.forEach((segment, n) => {
		const mine = (lexed.units[n] as Unit).words.map((w) => w.cooked);
		if (segment.argv.length !== mine.length || segment.argv.some((arg, m) => arg !== mine[m])) {
			throw new Refusal(PROBLEMS.mismatch);
		}
	});
}


// ---------------------------------------------------------------------------
// Static python
// ---------------------------------------------------------------------------

interface PySegment {
	start: number;
	end: number;
	script: string;
}

const PY_SEPARATORS = " \t\n;&|";

/** Where a `python3` word at `i` stands: true when it starts a command, null when it is not ours, a Refusal when it is piped. */
function pythonStartsUnit(text: string, i: number): boolean {
	let j = i - 1;
	while (j >= 0 && (text[j] === " " || text[j] === "\t")) j--;
	const prev = j >= 0 ? (text[j] as string) : "";
	const before = j >= 1 ? (text[j - 1] as string) : "";
	if (prev === "" || prev === "\n") return true;
	if (prev === ";") return before !== ";" && before !== "&";
	if (prev === "&") {
		if (before === "|") throw new Refusal(PROBLEMS.pyPipe);
		return before !== ">" && before !== "<";
	}
	if (prev === "|") {
		if (before === "|") return true;
		throw new Refusal(PROBLEMS.pyPipe);
	}
	let s = j;
	while (s >= 0 && !PY_SEPARATORS.includes(text[s] as string)) s--;
	if (text.slice(s + 1, j + 1) !== "do") return false;
	let k = s;
	while (k >= 0 && (text[k] === " " || text[k] === "\t")) k--;
	return k < 0 || text[k] === "\n" || text[k] === ";" || text[k] === "&";
}

/** The segment `python3 ...` at `i` when it is one of the two supported forms; null when it is some other python call. */
function pythonSegmentAt(text: string, i: number): PySegment | null {
	if (!pythonStartsUnit(text, i)) return null;
	const n = text.length;
	const after = text.slice(i + 7);
	const single = /^[ \t]+-c[ \t]+'/.exec(after);
	if (single !== null) {
		const open = i + 7 + single[0].length - 1;
		const close = text.indexOf("'", open + 1);
		if (close < 0) throw new Refusal(PROBLEMS.quote);
		let k = close + 1;
		while (k < n && (text[k] === " " || text[k] === "\t")) k++;
		const next = k < n ? (text[k] as string) : "";
		const two = text.slice(k, k + 2);
		if (next === "&" && two !== "&&") throw new Refusal(PROBLEMS.pyBackground);
		const whole =
			next === "" ||
			next === "\n" ||
			(next === ";" && text[k + 1] !== ";" && text[k + 1] !== "&" && text[k + 1] !== "|") ||
			two === "&&" ||
			two === "||" ||
			(next === "|" && text[k + 1] !== "&");
		if (!whole) throw new Refusal(PROBLEMS.pyArgv);
		return { start: i, end: close + 1, script: text.slice(open + 1, close) };
	}
	if (/^[ \t]+-c[ \t]+"/.test(after)) throw new Refusal(PROBLEMS.pyDouble);
	const doc = /^(?:[ \t]+-)?[ \t]*<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*(\n|$)/.exec(after);
	if (doc !== null) {
		const delim = doc[1] as string;
		const bodyStart = i + 7 + doc[0].length;
		if (doc[2] === "") throw new Refusal(PROBLEMS.pyHeredocOpen);
		for (let pos = bodyStart; pos <= n; ) {
			const eol = text.indexOf("\n", pos);
			const lineEnd = eol < 0 ? n : eol;
			if (text.slice(pos, lineEnd) === delim) return { start: i, end: lineEnd, script: text.slice(bodyStart, pos) };
			if (eol < 0) break;
			pos = eol + 1;
		}
		throw new Refusal(PROBLEMS.pyHeredocOpen);
	}
	if (/^(?:[ \t]+-)?[ \t]*<</.test(after)) throw new Refusal(PROBLEMS.pyHeredoc);
	return null;
}

/** The supported python segments of `text`, found with a quote-aware scan. Anything the scan misses stays in the text and meets the other checks. */
function scanPython(text: string): PySegment[] {
	const found: PySegment[] = [];
	const n = text.length;
	let i = 0;
	while (i < n) {
		const ch = text[i] as string;
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'") {
			const j = text.indexOf("'", i + 1);
			if (j < 0) break;
			i = j + 1;
			continue;
		}
		if (ch === '"') {
			let j = i + 1;
			while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			i = j + 1;
			continue;
		}
		const atWord = i === 0 || PY_SEPARATORS.includes(text[i - 1] as string);
		if (ch === "#" && atWord) {
			while (i < n && text[i] !== "\n") i++;
			continue;
		}
		if (atWord && text.startsWith("python3", i) && (i + 7 === n || " \t\n".includes(text[i + 7] as string))) {
			const seg = pythonSegmentAt(text, i);
			if (seg !== null) {
				found.push(seg);
				i = seg.end;
				continue;
			}
		}
		i++;
	}
	return found;
}

const PY_PATH = /^[\x20-\x7e]+$/;
const PY_GLOB = /^[A-Za-z0-9_\-./+@:*?[\]!^]+$/;

/** `cat -- reads; ls -- lists; touch -- writes`, or `true` when the script has no effect. */
function effectProgram(effects: PythonEffects): string {
	const quote = (path: string): string => {
		if (!PY_PATH.test(path) || path.includes("'")) throw new Refusal(PROBLEMS.pyPath(path));
		return `'${path}'`;
	};
	const list = (path: string): string => {
		if (!/[*?[]/.test(path)) return quote(path);
		if (!PY_GLOB.test(path) || path.startsWith("~")) throw new Refusal(PROBLEMS.pyPath(path));
		return path;
	};
	const parts: string[] = [];
	if (effects.reads.length > 0) parts.push(`cat -- ${effects.reads.map(quote).join(" ")}`);
	if (effects.lists.length > 0) parts.push(`ls -- ${effects.lists.map(list).join(" ")}`);
	if (effects.writes.length > 0) parts.push(`touch -- ${effects.writes.map(quote).join(" ")}`);
	return parts.length === 0 ? "true" : parts.join("; ");
}

interface PyExpansion {
	text: string;
	/** Where each effect program starts in `text`. */
	starts: number[];
}

/** Replace every python segment by its effect program; a segment that cannot be analyzed refuses the whole command. */
function expandPython(command: string, segments: readonly PySegment[], options: ExpandOptions): PyExpansion {
	let text = "";
	let at = 0;
	const starts: number[] = [];
	for (const seg of segments) {
		const verdict = analyzePythonScript(seg.script, { runDir: options.cwd, scratch: options.scratch, env: options.env });
		if (!verdict.ok) throw new Refusal(verdict.problem);
		text += command.slice(at, seg.start);
		starts.push(text.length);
		text += effectProgram(verdict.effects);
		at = seg.end;
	}
	return { text: text + command.slice(at), starts };
}

/** python runs in the session cwd: no `cd` before it (anywhere when a loop may run it again). */
function checkRunDir(lexed: Lexed, starts: readonly number[]): void {
	const loops = lexed.units.some((u) => u.words[0]?.cooked === "for");
	const last = starts[starts.length - 1] ?? 0;
	for (const u of lexed.units) {
		const word = u.words.find((w) => DIR_BUILTINS.has(w.cooked));
		if (word !== undefined && (loops || u.start < last)) throw new Refusal(PROBLEMS.pyDir(word.cooked));
	}
}

function expandStrict(source: string, segments: readonly PySegment[], options: ExpandOptions): string {
	const py = expandPython(source, segments, options);
	const command = py.text;
	for (const key of ["IFS", "BASH_ENV", "ENV"]) {
		if (hasOwn(options.env, key)) throw new Refusal(PROBLEMS.envVar(key));
	}
	checkText(command);
	const lexed = lex(command, true) as Lexed;
	if (py.starts.length > 0) checkRunDir(lexed, py.starts);

	// Today's tokenizer must see the same simple commands the expander sees.
	const original = tokenize(command, options.scratch);
	if (original !== null) {
		const same =
			original.length === lexed.units.length &&
			original.every((segment, n) => {
				const mine = (lexed.units[n] as Unit).words.map((w) => w.cooked);
				return segment.argv.length === mine.length && segment.argv.every((arg, m) => arg === mine[m]);
			});
		if (!same) throw new Refusal(PROBLEMS.mismatch);
	}

	const units = splitDo({ text: command }, lexed.units);
	const bound = new Set<string>();
	const c: Cx = { text: command, opts: options, units, bound, env: options.env, bodies: 0, assignWords: 0, everBound: new Set() };
	for (const u of units) {
		const raws = u.words.map((w) => rawOf(c, w));
		for (const raw of raws.slice(0, leadingAssignments(raws))) {
			bound.add((ASSIGN_WORD.exec(raw) as RegExpExecArray)[1] ?? "");
		}
		if (raws[0] === "for" && u.words[1] !== undefined) bound.add(u.words[1].cooked);
	}

	const body = renderSeq(c, 0, units.length, new Map(), { body: false, noCd: false }, "", undefined, false);
	const expanded = body + lexed.trailing;
	checkExpanded(c, expanded, options.scratch);
	return expanded;
}

/**
 * Expand top-level literal assignments and `for` loops of `command` into the
 * text the rules should judge. See the file header and plan D3.
 */
export function expandCommand(command: string, options: ExpandOptions): Program {
	let segments: PySegment[] = [];
	let hasConstruct = false;
	try {
		segments = scanPython(command);
		const probe = lex(command, false);
		hasConstruct = segments.length > 0 || (probe !== null && probe.units.some((u) => isConstruct({ text: command }, u)));
	} catch (error) {
		if (error instanceof Refusal) return { text: command, changed: false, problem: error.message };
		hasConstruct = false;
	}
	if (!hasConstruct) return { text: command, changed: false };
	try {
		const text = expandStrict(command, segments, options);
		return { text, changed: text !== command };
	} catch (error) {
		const problem = error instanceof Refusal ? error.message : PROBLEMS.internal;
		return { text: command, changed: false, problem };
	}
}
