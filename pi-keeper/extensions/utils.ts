/**
 * Command and path analysis for pi-keeper.
 *
 * Two directions, deliberately different failure modes:
 *
 * - Read-only detection (`isReadOnlyCommand`) and remembered-prefix
 *   matching FAIL CLOSED: anything that can't be parsed confidently is not
 *   read-only / not covered, so the mode's fallback (ask/deny) applies.
 * - Deny/ask detection (`isPrivilegedCommand`, `isDangerousCommand`,
 *   `isSecretCommand`) must not FAIL OPEN: when the precise tokenizer gives
 *   up (substitution, subshells, redirects), a loose split still finds
 *   commands in command position, and `sh -c` / `eval` scripts are
 *   analyzed recursively. This is an accident guard, not a security
 *   boundary (it can't see inside scripts, aliases, or `make` targets).
 *
 * Tokenizer: quote-aware (single/double quotes, backslash escapes, `#`
 * comments); splits on `;`, `&`, `&&`, `|`, `||`, `|&` and newlines. Rejects
 * (returns null) command substitution, input redirection/heredocs,
 * subshells, unbalanced quotes, and output redirection to anything but the
 * literal /dev/null, an fd duplication (`2>&1`, `2>&-`), or (when a scratch
 * dir is given) a literal absolute path inside it.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
	COMMAND_ARITY,
	COMMAND_RUNNERS,
	DANGEROUS_COMMANDS,
	DANGEROUS_RAW_PATTERNS,
	DANGEROUS_ROOT_PREFIXES,
	FILE_WRITERS,
	GLOB_SENSITIVE_COMMANDS,
	INTERPRETERS,
	MULTI_COMMAND_TOOLS,
	NEVER_REMEMBER,
	OUTPUT_FLAGS,
	OUTPUT_WRITERS,
	PRIVILEGE_COMMANDS,
	PROTECTED_DIRS,
	PROTECTED_FILES,
	READ_ONLY_BASH_COMMANDS,
	READ_ONLY_CONTAINER_SUBCOMMANDS,
	READ_ONLY_GH_GROUPS,
	READ_ONLY_GH_SUBCOMMANDS,
	READ_ONLY_KUBECTL_SUBCOMMANDS,
	READ_ONLY_GIT_SUBCOMMANDS,
	READ_ONLY_PACKAGE_SUBCOMMANDS,
	READ_ONLY_RTK_SUBCOMMANDS,
	RTK_DISPLAY_FLAGS,
	RTK_PROXY_COMMANDS,
	REMOVAL_SUBCOMMANDS,
	RTK_RUNNERS,
	RUNNER_SUBCOMMANDS,
	SAFE_ENV_PREFIXES,
	SAFE_ENV_VARS,
	SAFETY_OFF_FLAGS,
	SECRET_FILE_PATTERNS,
	SECRET_HOME_PATHS,
	SHELLS,
	WRAPPERS,
	WRITE_FLAGS,
	PROGRAM_FLAGS,
	type FlagSpec,
	type OptionSpec,
	WRITE_INDICATORS,
} from "./modes.ts";

/** Longer commands are never read-only (Claude Code uses the same cap). */
export const MAX_COMMAND_LENGTH = 10_000;

/**
 * One simple command: its words and whether each may expand into several
 * words (unquoted glob, brace, or `$` expansion).
 */
export interface Segment {
	argv: string[];
	globs: boolean[];
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Split a command into simple commands. Returns null when the command
 * cannot be parsed safely (see file header).
 */
export function tokenize(command: string, scratch?: string): Segment[] | null {
	if (command.includes("$(") || command.includes("`")) return null;

	const segments: Segment[] = [];
	let argv: string[] = [];
	let globs: boolean[] = [];
	let word = "";
	let wordStarted = false;
	let wordGlob = false;
	let inSingle = false;
	let inDouble = false;
	let failed = false;
	let i = 0;

	const endWord = (): void => {
		if (wordStarted) {
			argv.push(word);
			globs.push(wordGlob);
		}
		word = "";
		wordStarted = false;
		wordGlob = false;
	};
	const endSegment = (): void => {
		endWord();
		if (argv.length === 0) {
			failed = true; // empty sub-command: leading/doubled separator
			return;
		}
		segments.push({ argv, globs });
		argv = [];
		globs = [];
	};

	while (i < command.length && !failed) {
		const ch = command[i] ?? "";

		if (inSingle) {
			if (ch === "'") inSingle = false;
			else word += ch;
			i++;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				word += command[i + 1] ?? "";
				i += 2;
				continue;
			}
			if (ch === '"') inDouble = false;
			else word += ch;
			i++;
			continue;
		}

		if (ch === "\\") {
			word += command[i + 1] ?? "";
			wordStarted = true;
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			if (ch === "'") inSingle = true;
			else inDouble = true;
			wordStarted = true;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			endWord();
			i++;
			continue;
		}
		if (ch === "&" && command[i + 1] === ">") {
			// &> / &>> : redirect stdout+stderr; handled by the `>` branch
			endWord();
			i++;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
			endSegment();
			i++;
			// consume the rest of a compound operator (&&, ||, |&, ;;)
			while (i < command.length && ";|&\n".includes(command[i] ?? "")) i++;
			continue;
		}
		if (ch === "<" || ch === "(" || ch === ")") {
			return null; // input redirection / heredoc / process substitution / subshell
		}
		if (ch === ">") {
			// bare digit directly before `>` is an fd prefix (2>, 1>)
			if (wordStarted && /^[0-9]$/.test(word)) {
				word = "";
				wordStarted = false;
				wordGlob = false;
			} else {
				endWord();
			}
			i++;
			if (command[i] === ">") i++; // append form (>>)
			if (command[i] === "&") {
				// fd duplication or close: >&2, 2>&1, 2>&-
				i++;
				if (command[i] === "-") {
					i++;
					continue;
				}
				const fdStart = i;
				while (i < command.length && /[0-9]/.test(command[i] ?? "")) i++;
				if (i === fdStart) return null; // `>&file`
				continue;
			}
			// file target: only the literal /dev/null is write-free
			while (i < command.length && (command[i] === " " || command[i] === "\t")) i++;
			if (command.startsWith("/dev/null", i)) {
				const after = command[i + 9] ?? "";
				if (after === "" || " \t;|&\n<>".includes(after)) {
					i += 9;
					continue;
				}
			}
			const scratchEnd = scratch === undefined ? undefined : scratchRedirectEnd(command, i, scratch);
			if (scratchEnd !== undefined) {
				i = scratchEnd;
				continue;
			}
			return null;
		}
		if (ch === "#" && !wordStarted) {
			while (i < command.length && command[i] !== "\n") i++;
			continue;
		}
		// globs, brace expansion and unquoted $ expansion can turn one word
		// into several (or into flags: `{-delete,}`, `x${IFS}-delete`)
		if (ch === "*" || ch === "?" || ch === "[" || ch === "$") wordGlob = true;
		if (ch === "{" && isBraceExpansion(command, i)) wordGlob = true;
		word += ch;
		wordStarted = true;
		i++;
	}

	if (failed || inSingle || inDouble) return null;
	endWord();
	if (argv.length > 0) segments.push({ argv, globs });
	return segments;
}

/** Characters of a path literal we accept without expansion: no `$`, quotes, globs, `~`, backslash. */
const LITERAL_PATH_CHARS = "A-Za-z0-9_\\-./+@:,=";

/**
 * End index of a redirect target at `start` that is a literal absolute path
 * inside the scratch dir, else undefined. Fail closed: variables, globs,
 * `~`, escapes and command substitution are never expanded, so any of them
 * (`> $SCRATCH/out`) is rejected like a redirect to any other file.
 */
function scratchRedirectEnd(command: string, start: number, scratch: string): number | undefined {
	const quote = command[start];
	let path: string;
	let end: number;
	if (quote === "'" || quote === '"') {
		const close = command.indexOf(quote, start + 1);
		if (close === -1) return undefined;
		path = command.slice(start + 1, close);
		end = close + 1;
		if (!new RegExp(`^[${LITERAL_PATH_CHARS} ]+$`).test(path)) return undefined;
	} else {
		const m = new RegExp(`^[${LITERAL_PATH_CHARS}]+`).exec(command.slice(start));
		if (m === null) return undefined;
		path = m[0];
		end = start + path.length;
	}
	if (end < command.length && !" \t;|&\n<>".includes(command[end] ?? "")) return undefined; // adjacent text: not one literal word
	return path.startsWith("/") && isInsideScratch(path, scratch) ? end : undefined;
}

/**
 * True when the `{` at `start` opens a brace expansion: bash only expands
 * `{a,b}` and `{1..3}` forms, so `HEAD@{1}` and `stash@{0}` stay one word.
 */
function isBraceExpansion(command: string, start: number): boolean {
	let depth = 0;
	let expands = false;
	for (let j = start + 1; j < command.length; j++) {
		const ch = command[j] ?? "";
		if (" \t\n;&|<>()'\"".includes(ch)) return false; // word ends unclosed
		if (ch === "\\") {
			j++;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			if (depth === 0) return expands;
			depth--;
		} else if (ch === "," || (ch === "." && command[j + 1] === ".")) expands = true;
	}
	return false;
}

/**
 * Loose split for commands the tokenizer rejects: splits on separators,
 * substitution openers, and grouping, then takes whitespace words with
 * surrounding quotes trimmed. Only used to FIND deny/ask commands.
 */
function looseUnits(command: string): string[][] {
	return command
		.split(/\$\(|[`;&|\n(){}]/)
		.map((chunk) =>
			chunk
				// redirect operators split words; their targets stay (`x>>.git/y`)
				.split(/\s+|[0-9]*[<>]+&?/)
				.map((w) => w.replace(/^['"]+|['"]+$/g, ""))
				.filter((w) => w !== ""),
		)
		.filter((unit) => unit.length > 0);
}

/** Heredoc body or here-string, and the root of the command reading it. */
interface StdinFeed {
	consumer: string | undefined;
	/** The consumer's output is piped into a shell (`cat <<EOF | bash`). */
	pipedToShell: boolean;
	script: string;
	/**
	 * Bash expands `$(…)`, backticks and `$VAR` in the text (unquoted heredoc
	 * delimiter, or a here-string that isn't single-quoted), so the
	 * substitutions in it run as commands.
	 */
	expands: boolean;
}

const HERESTRING = /<<<\s*('[^']*'|"(?:[^"\\]|\\.)*"|(?:\$\([^)]*\)|[^\s;&|)])+)/g;
// Delimiter word: any quote or backslash in it makes the body literal
const HEREDOC = /<<(-?)[ \t]*((?:\\|['"])?[A-Za-z_][^\s;&|<>()]*)/;
const PIPE_TO_SHELL = /\|&?\s*(\S*\/)?(ba|z|da|k|fi)?sh\b/;

/** Rest of the line from `index`, without the following heredoc body. */
function restOfLine(text: string, index: number): string {
	const end = text.indexOf("\n", index);
	return text.slice(index, end === -1 ? text.length : end);
}

/**
 * Remove heredoc bodies and here-strings from a command. Their text is
 * data (`cat > f <<EOF` with a `sudo …` line writes a file), so callers
 * scan only the feeds whose consumer is a shell (`bash <<< "sudo x"`) and
 * the substitutions bash expands in unquoted ones (see feedScripts).
 */
function extractStdinFeeds(command: string): { text: string; feeds: StdinFeed[] } {
	const feeds: StdinFeed[] = [];
	const consumerAt = (text: string, index: number): string | undefined => {
		const unit = looseUnits(text.slice(0, index)).at(-1);
		const root = unit === undefined ? undefined : stripPrefixes(unit, unit.map(() => false), false)?.argv[0];
		return root === undefined ? undefined : basename(root);
	};

	let text = command.replace(HERESTRING, (match: string, word: string, offset: number, whole: string) => {
		feeds.push({
			consumer: consumerAt(whole, offset),
			pipedToShell: PIPE_TO_SHELL.test(restOfLine(whole, offset + match.length)),
			script: word.replace(/^(['"])([\s\S]*)\1$/, "$2"),
			expands: !word.startsWith("'"),
		});
		return " ";
	});

	// Each pass removes one operator, so the loop ends
	for (let m = HEREDOC.exec(text); m !== null; m = HEREDOC.exec(text)) {
		const consumer = consumerAt(text, m.index);
		const opEnd = m.index + m[0].length;
		const lineEnd = text.indexOf("\n", opEnd);
		if (lineEnd === -1) {
			text = text.slice(0, m.index) + text.slice(opEnd);
			continue;
		}
		const stripTabs = m[1] === "-";
		const delimiter = m[2].replace(/['"\\]/g, "");
		const lines = text.slice(lineEnd + 1).split("\n");
		const end = lines.findIndex((l) => (stripTabs ? l.replace(/^\t+/, "") : l) === delimiter);
		feeds.push({
			consumer,
			pipedToShell: PIPE_TO_SHELL.test(restOfLine(text, opEnd)),
			script: lines.slice(0, end === -1 ? lines.length : end).join("\n"),
			expands: !/['"\\]/.test(m[2]),
		});
		const after = end === -1 ? "" : lines.slice(end + 1).join("\n");
		text = text.slice(0, m.index) + text.slice(opEnd, lineEnd + 1) + after;
	}
	return { text, feeds };
}

/**
 * Bodies of the `$(…)` and backtick substitutions in text that bash
 * expands. Escaped openers are literal. Fails closed: an unterminated
 * substitution runs to the end of the text, so words in it are still seen.
 * Nested substitutions stay inside their parent's script (callers recurse).
 */
function substitutionScripts(text: string): string[] {
	const scripts: string[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
		} else if (ch === "$" && text[i + 1] === "(") {
			let depth = 1;
			let j = i + 2;
			for (; j < text.length && depth > 0; j++) {
				if (text[j] === "\\") j++;
				else if (text[j] === "(") depth++;
				else if (text[j] === ")") depth--;
			}
			scripts.push(text.slice(i + 2, depth === 0 ? j - 1 : j));
			i = j;
		} else if (ch === "`") {
			let j = i + 1;
			while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
			scripts.push(text.slice(i + 1, j).replace(/\\`/g, "`"));
			i = j + 1;
		} else i++;
	}
	return scripts;
}

/**
 * Scripts that run as commands: feeds a shell reads (fed to a shell
 * directly, or through a pipe: `cat <<EOF | bash`), plus the substitutions
 * in feeds bash expands (`cat <<EOF` with `$(sudo id)` in the body). Quoted
 * heredoc bodies read by anything else are data.
 */
function feedScripts(feeds: StdinFeed[]): string[] {
	return feeds.flatMap((f) => {
		const shellRead = f.pipedToShell || (f.consumer !== undefined && SHELLS.has(f.consumer));
		return [...(shellRead ? [f.script] : []), ...(f.expands ? substitutionScripts(f.script) : [])];
	});
}

// ---------------------------------------------------------------------------
// Prefix stripping (env assignments, wrappers)
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Reserved words that can precede a command (stripped in loose mode). */
const SHELL_KEYWORDS = new Set(["{", "!", "if", "then", "else", "elif", "do", "while", "until"]);

function isSafeEnvVar(name: string): boolean {
	return SAFE_ENV_VARS.has(name) || SAFE_ENV_PREFIXES.some((p) => name.startsWith(p));
}

/** Flags of wrappers that consume the next word as their value. */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	nice: new Set(["-n", "--adjustment"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	xargs: new Set(["-n", "-L", "-P", "-I", "-d", "-s", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]),
	env: new Set(["-u", "-C", "--unset", "--chdir"]),
};

/**
 * Strip leading env assignments and wrappers (`timeout 30`, `nice -n 5`,
 * bare `xargs`, ...).
 *
 * strict (read-only / allow matching): only known-safe env assignments are
 * stripped — any other assignment returns null; `env` and flagged `xargs`
 * are not stripped (they stay the root and fail the allowlist).
 * loose (deny/ask matching): every assignment, `env` (incl. `-S` scripts),
 * flagged `xargs` and leading shell keywords (`{`, `then`, `do`, ...) are
 * stripped, as Claude Code does for deny rules.
 */
function stripPrefixes(argv: string[], globs: boolean[], strict: boolean): Segment | null {
	let words = argv;
	let marks = globs;
	let i = 0;
	while (i < words.length) {
		const w = words[i];
		const assignment = ASSIGNMENT.exec(w);
		if (assignment !== null) {
			if (strict && !isSafeEnvVar(assignment[1])) return null;
			i++;
			continue;
		}
		// `if x; then sudo y; fi`: the command follows the keyword
		if (!strict && SHELL_KEYWORDS.has(w)) {
			i++;
			continue;
		}
		const isWrapper = WRAPPERS.has(w) || (!strict && w === "env");
		if (!isWrapper) break;
		if (w === "command" && (words[i + 1] === "-v" || words[i + 1] === "-V")) break; // query form
		if (w === "xargs" && strict && (words[i + 1] ?? "").startsWith("-")) break; // flagged xargs
		i++;
		const valueFlags = WRAPPER_VALUE_FLAGS[w] ?? new Set<string>();
		while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
			if (w === "env" && (words[i] === "-S" || words[i] === "--split-string")) {
				// env -S 'cmd args': the value is the command line
				const split = (words[i + 1] ?? "").split(/\s+/).filter(Boolean);
				words = [...split, ...words.slice(i + 2)];
				marks = words.map(() => false);
				i = 0;
				break;
			}
			if (valueFlags.has(words[i])) i++;
			i++;
		}
		if (w === "env") {
			while (i < words.length && ASSIGNMENT.test(words[i])) i++;
		}
		if (w === "timeout" && i < words.length) i++; // duration
		if (w === "nice" && /^-[0-9]+$/.test(words[i] ?? "")) i++;
	}
	return { argv: words.slice(i), globs: marks.slice(i) };
}

// ---------------------------------------------------------------------------
// Canonical form (rtk) and commit-message heredocs
// ---------------------------------------------------------------------------

/**
 * The real command behind an rtk invocation: `rtk git add` → `git add`,
 * `rtk -vv proxy git push` → `git push`. Only strips `rtk` for 1:1 proxies
 * (RTK_PROXY_COMMANDS) and `rtk proxy`, and only past display-only global
 * flags (RTK_DISPLAY_FLAGS); anything else (`rtk read`, `rtk run`,
 * `rtk test cmd`, an unknown flag) keeps its rtk form, so rules for it stay
 * rtk-specific. The result is always a suffix of `argv`.
 */
export function canonicalize(argv: readonly string[]): string[] {
	const [root, ...args] = argv;
	if (root === undefined || basename(root) !== "rtk") return [...argv];
	let i = 0;
	while (i < args.length && RTK_DISPLAY_FLAGS.test(args[i])) i++;
	const sub = args[i];
	if (sub === undefined || sub.startsWith("-")) return [...argv];
	if (sub === "proxy") return args.length > i + 1 ? canonicalize(args.slice(i + 1)) : [...argv];
	return RTK_PROXY_COMMANDS.has(sub) ? args.slice(i) : [...argv];
}

/** True when a remembered (canonical) prefix also matches the rtk form. */
export function viaRtkToo(prefix: readonly string[]): boolean {
	return RTK_PROXY_COMMANDS.has(basename(prefix[0] ?? ""));
}

/** Roots whose `-m`/`--body` text is data: a commit or PR message. */
const MESSAGE_COMMANDS = new Set(["git", "gh", "glab"]);

const COMMIT_HEREDOC_HEAD = /"\$\([ \t]*cat[ \t]+<<(-?)[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|\\([A-Za-z_][A-Za-z0-9_]*))[ \t]*\n/y;

/**
 * If a double-quoted word starting at `start` is exactly
 * `"$(cat <<'D'` NEWLINE body NEWLINE `D` [whitespace] `)"` (quoted
 * delimiter, `<<-` strips tabs, the FIRST line equal to `D` ends the body),
 * and a word ends right after it, returns the index after it.
 */
function commitHeredocEnd(command: string, start: number): number | undefined {
	COMMIT_HEREDOC_HEAD.lastIndex = start;
	const m = COMMIT_HEREDOC_HEAD.exec(command);
	if (m === null) return undefined;
	const delimiter = m[2] ?? m[3] ?? m[4];
	let pos = start + m[0].length;
	for (;;) {
		const lineEnd = command.indexOf("\n", pos);
		const line = command.slice(pos, lineEnd === -1 ? command.length : lineEnd);
		if ((m[1] === "-" ? line.replace(/^\t+/, "") : line) === delimiter) {
			const close = /^\s*\)"/.exec(command.slice(pos + line.length));
			if (close === null) return undefined; // more commands follow the first terminator
			const end = pos + line.length + close[0].length;
			return end === command.length || /[\s;&|]/.test(command[end] ?? "") ? end : undefined;
		}
		if (lineEnd === -1) return undefined; // unterminated
		pos = lineEnd + 1;
	}
}

/**
 * For analysis only: replaces the common `-m "$(cat <<'EOF' … EOF\n)"`
 * commit/PR body with a literal word, so the tokenizer sees
 * `git commit -m '<heredoc>'`. The body is data (`cat` prints it; a quoted
 * delimiter disables expansion), but only where the text is a message: the
 * word must start a word (after whitespace or `=`), outside quotes, in a
 * git/gh/glab command. Anything that deviates is left alone and the
 * tokenizer rejects it as before. The privilege/dangerous scanners keep
 * reading the original text.
 */
export function maskCommitHeredocs(command: string): string {
	if (!command.includes("<<")) return command;
	let out = "";
	let last = 0;
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle) {
			i++;
		} else if (inSingle) {
			if (ch === "'") inSingle = false;
		} else if (inDouble) {
			if (ch === '"') inDouble = false;
		} else if (ch === "'") {
			inSingle = true;
		} else if (ch === '"') {
			const end = /[\s=]/.test(command[i - 1] ?? " ") ? commitHeredocEnd(command, i) : undefined;
			const unit = end === undefined ? undefined : looseUnits(command.slice(0, i)).at(-1);
			const root = unit === undefined ? undefined : canonicalize(stripPrefixes(unit, unit.map(() => false), false)?.argv ?? unit)[0];
			if (end !== undefined && root !== undefined && MESSAGE_COMMANDS.has(basename(root))) {
				out += `${command.slice(last, i)}'<heredoc>'`;
				last = end;
				i = end - 1;
			} else inDouble = true;
		}
	}
	return out + command.slice(last);
}

/**
 * For analysis only: removes a quoted heredoc that feeds `cat` when the line
 * redirects `cat`'s output (`cat > /scratch/x <<'EOF' … EOF`), leaving
 * `cat > /scratch/x`, so the tokenizer can judge the redirect target (only a
 * literal path in the scratch dir passes). The body is data: the delimiter is
 * quoted (no expansion), `cat` only prints it, and it is not piped to a
 * shell. Any other consumer (`sh <<'EOF' > f` runs the body), an unquoted
 * delimiter or an unterminated body is left alone and the tokenizer rejects
 * it as before. Without a scratch dir there is nothing to relax.
 */
export function maskScratchHeredocs(command: string, scratch: string | undefined): string {
	if (scratch === undefined || !command.includes("<<")) return command;
	let text = command;
	for (let from = 0; ; ) {
		const m = HEREDOC.exec(text.slice(from));
		if (m === null) return text;
		const at = from + m.index;
		from = at + 2;
		if (text[at - 1] === "<" || !/['"\\]/.test(m[2])) continue; // here-string, or an unquoted delimiter (expands)
		const opEnd = at + m[0].length;
		const lineStart = text.lastIndexOf("\n", at - 1) + 1;
		const lineEnd = text.indexOf("\n", opEnd);
		if (lineEnd === -1) continue;
		const consumer = looseUnits(text.slice(lineStart, at)).at(-1)?.[0];
		const rest = restOfLine(text, opEnd);
		if (consumer === undefined || basename(consumer) !== "cat" || PIPE_TO_SHELL.test(rest) || !/>/.test(text.slice(lineStart, at) + rest)) continue;
		const delimiter = m[2].replace(/['"\\]/g, "");
		const lines = text.slice(lineEnd + 1).split("\n");
		const end = lines.findIndex((l) => (m[1] === "-" ? l.replace(/^\t+/, "") : l) === delimiter);
		if (end === -1) continue;
		const after = lines.slice(end + 1);
		text = text.slice(0, at) + text.slice(opEnd, lineEnd) + (after.length > 0 ? `\n${after.join("\n")}` : "");
		from = at;
	}
}

/** Both analysis-only rewrites: commit/PR message heredocs and scratch-bound `cat` heredocs. */
function maskForAnalysis(command: string, scratch: string | undefined): string {
	return maskScratchHeredocs(maskCommitHeredocs(command), scratch);
}

// ---------------------------------------------------------------------------
// Read-only detection
// ---------------------------------------------------------------------------

/** The first arg that makes `root` write, execute, or hang (WRITE_FLAGS). */
function writeFlag(root: string, args: string[], table: Record<string, FlagSpec> = WRITE_FLAGS): string | undefined {
	const spec = Object.hasOwn(table, root) ? table[root] : undefined;
	if (spec === undefined) return undefined;
	return args.find((a) => {
		if (spec.exact?.includes(a)) return true;
		if (spec.longs !== undefined && a.startsWith("--") && a.length > 2) {
			const name = a.split("=")[0];
			// getopt accepts any unambiguous abbreviation: fail closed on every prefix
			if (spec.longs.some((l) => l.startsWith(name))) return true;
		}
		if (spec.prefixes?.some((p) => a.startsWith(p))) return true;
		if (spec.shortLetters !== undefined && /^-[^-]/.test(a)) {
			return [...a.slice(1)].some((c) => spec.shortLetters?.includes(c));
		}
		return false;
	});
}

/** The first exec-capable flag of a non-read-only command (PROGRAM_FLAGS); old-style `tar xIf prog` counts. */
function execFlag(name: string, args: string[]): string | undefined {
	const old = name === "tar" && /^[A-Za-z]+$/.test(args[0] ?? "") ? [`-${args[0]}`, ...args.slice(1)] : args;
	return writeFlag(name, old, PROGRAM_FLAGS);
}

// --- sed analyzer -----------------------------------------------------------

/** Short sed flags that cannot write or run anything. */
const SED_SHORT_SAFE = "nErsuz";
const SED_LONG_SAFE = new Set(["--quiet", "--silent", "--regexp-extended", "--posix", "--debug", "--follow-symlinks", "--separate", "--unbuffered", "--null-data"]);

const SED_UNSAFE_SCRIPT = "`sed` script uses `e`/`r` or can't be checked";

/**
 * Index after the delimited part starting at `i` (just past the opening
 * delimiter), honouring backslash escapes; undefined when unterminated or a
 * raw newline appears (an escaped one is fine). Like GNU's match_slash, brackets
 * get no special treatment.
 */
function sedPart(script: string, i: number, delim: string): number | undefined {
	for (; i < script.length; i++) {
		const ch = script[i];
		if (ch === "\\") i++;
		else if (ch === delim) return i + 1;
		else if (ch === "\n") return undefined;
	}
	return undefined;
}

/** A sed regex address `/re/` or `\cREc`, plus I/M flags; returns the index after it. */
function sedRegexAddr(script: string, i: number): number | undefined {
	let delim = "/";
	if (script[i] === "\\") {
		delim = script[i + 1] ?? "";
		i += 2;
	} else i++;
	if (!/^[^\w\s\\]$/.test(delim)) return undefined;
	let end = sedPart(script, i, delim);
	if (end === undefined) return undefined;
	while (script[end] === "I" || script[end] === "M") end++;
	return end;
}

/** One address (line number, `$`, `first~step`, regex); returns the index after it. */
function sedAddr(script: string, i: number): number | undefined {
	const num = /^\d+(~\d+)?/.exec(script.slice(i));
	if (num !== null) return i + num[0].length;
	if (script[i] === "$") return i + 1;
	if (script[i] === "/" || script[i] === "\\") return sedRegexAddr(script, i);
	return undefined;
}

/**
 * File name of a sed `w`/`W` command or `s///w` flag at `i`: the rest of the
 * line after optional blanks. undefined when empty (sed errors).
 */
function sedFileName(script: string, i: number): { name: string; end: number } | undefined {
	while (script[i] === " " || script[i] === "\t") i++;
	const nl = script.indexOf("\n", i);
	const end = nl === -1 ? script.length : nl;
	const name = script.slice(i, end);
	return name === "" ? undefined : { name, end };
}

/** awk implementations that take the same forms of a command-line program. */
const AWK_COMMANDS = new Set(["awk", "gawk", "mawk", "nawk"]);

/**
 * Why an `awk` command line isn't read-only, or undefined when it is. Only a
 * command-line program is analysed: `-f`, `-i`/`--include` and `-l`/`--load`
 * name a program file, and any other flag is unknown, so all of those ask.
 * A file operand needs no analysis: the outside-read and secret rules judge
 * the paths of the whole command on their own.
 */
function awkBlocker(args: string[], argGlobs: boolean[]): Blocker | undefined {
	const programs: string[] = [];
	let sourceNamed = false;
	let operandProgram = false;
	let positional = false;
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (!positional && a !== "-" && a.startsWith("-")) {
			if (a === "--") {
				positional = true;
				continue;
			}
			const name = a.startsWith("--") ? a.split("=")[0] : a.slice(0, 2);
			// the option's value: attached (`-F,`, `--source=…`) or the next word
			const attached = a.slice(name.length).replace(/^=/, "");
			const take = (): string | undefined => (attached !== "" ? attached : args[++k]);
			switch (name) {
				case "-F":
				case "--field-separator":
				case "-v":
				case "--assign":
					if (take() === undefined) return plain(`\`awk ${name}\` is missing its value, which can't be checked`);
					continue;
				case "-e":
				case "--source": {
					const value = take();
					if (value === undefined) return plain(`\`awk ${name}\` is missing its program, which can't be checked`);
					programs.push(value);
					sourceNamed = true;
					continue;
				}
				case "-f":
				case "--file":
					return execBlock("`awk -f` runs a program file");
				case "-i":
				case "--include":
				case "-l":
				case "--load":
				case "-E":
					return execBlock(`\`awk ${name}\` loads a program file`);
				default:
					return plain(`\`awk ${a}\` isn't a flag that can be checked`);
			}
		}
		// an operand is the program unless `-e`/`-f` named one; then it is a file to read
		if (sourceNamed || operandProgram || a === "-") continue;
		if (argGlobs[k] === true) return execBlock(globReason("awk", a));
		programs.push(a);
		operandProgram = true;
	}
	if (programs.length === 0) return plain("`awk` without a program can't be checked");
	const problem = awkProgramProblem(programs.join("\n"));
	return problem === undefined ? undefined : execBlock(problem);
}

/**
 * Why an awk program isn't safe to run as a read-only command, or undefined
 * when it is. The raw text is checked for what always reaches outside the
 * pipeline (`system(`, `getline`, gawk's `@include`/`@load`); strings and
 * regex literals are then blanked out, so a pipe or a redirect shows up only
 * where it is code (`awk '$1 > 2'` is a comparison and stays read-only).
 */
function awkProgramProblem(program: string): string | undefined {
	if (/\bsystem\s*\(/.test(program)) return "`awk` program runs a command (`system`)";
	if (/\bgetline\b/.test(program)) return "`awk` program reads from a command or a file (`getline`)";
	if (/@(?:include|load)\b/.test(program)) return "`awk` program loads another program (`@include`/`@load`)";
	const code = awkCode(program);
	// a single `|` pipes into a command; `||` is a comparison
	if (/(^|[^|])\|([^|]|$)/.test(code)) return "`awk` program pipes into a command";
	if (/\bprintf?\b[^;{}]*>>?/.test(code)) return "`awk` program writes to a file";
	return undefined;
}

/**
 * The code of an awk program: string and regex literals, and `#` comments,
 * blanked out. A `/` starts a regex only where an expression starts; after a
 * word, a number or `)` it is a division and stays, so nothing can hide in
 * what this function removes.
 */
function awkCode(program: string): string {
	let out = "";
	let prev = "";
	let i = 0;
	while (i < program.length) {
		const ch = program[i];
		if (ch === "#") {
			while (i < program.length && program[i] !== "\n") i++;
			continue;
		}
		if (ch === '"') {
			i++;
			while (i < program.length && program[i] !== '"' && program[i] !== "\n") i += program[i] === "\\" ? 2 : 1;
			i++;
			out += '""';
			prev = '"';
			continue;
		}
		if (ch === "/" && awkRegexStartsAfter(prev)) {
			let j = i + 1;
			let closed = false;
			while (j < program.length && program[j] !== "\n") {
				if (program[j] === "\\") {
					j += 2;
					continue;
				}
				if (program[j] === "/") {
					closed = true;
					break;
				}
				j++;
			}
			if (closed) {
				i = j + 1;
				out += "//";
				prev = "/";
				continue;
			}
		}
		out += ch;
		if (!/\s/.test(ch)) prev = ch;
		i++;
	}
	return out;
}

/** True when the last code character lets a `/` start a regex rather than a division. */
function awkRegexStartsAfter(prev: string): boolean {
	return prev === "" || "({[;,:?=~!&|+-*%<>^".includes(prev);
}

/**
 * The files a sed script writes (`w`/`W` commands, `s///w`), or undefined
 * when some command isn't understood or can execute: optional address
 * (`N`, `$`, `N,M`, `/re/`, `\cREc`, `first~step`, `addr,+N`, `addr,~N`) and
 * `!`, then p P d D q Q = l n N g G h H x, `y`, `{…}`, `w`/`W file` or `s`
 * with flags from g p i I m M, digits and a final `w file`. Not `e r R`, not
 * `a i c`, labels, comments or `s///e`: unknown means unsafe.
 */
function sedScriptWrites(script: string): string[] | undefined {
	const writes: string[] = [];
	let i = 0;
	let depth = 0;
	const space = () => {
		while (script[i] === " " || script[i] === "\t") i++;
	};
	for (;;) {
		while (/[\s;]/.test(script[i] ?? "x")) i++;
		if (i >= script.length) return depth === 0 ? writes : undefined;
		if (script[i] === "}") {
			if (--depth < 0) return undefined;
			i++;
			continue;
		}
		const first = sedAddr(script, i);
		if (first !== undefined) {
			i = first;
			if (script[i] === ",") {
				i++;
				const plus = /^[+~]\d+/.exec(script.slice(i));
				const second = plus !== null ? i + plus[0].length : sedAddr(script, i);
				if (second === undefined) return undefined;
				i = second;
			}
		}
		space();
		if (script[i] === "!") {
			i++;
			space();
		}
		const cmd = script[i++];
		if (cmd === "{") {
			depth++;
			continue;
		}
		if (cmd === "s") {
			const delim = script[i++] ?? "";
			if (!/^[^\w\s\\]$/.test(delim)) return undefined;
			const regexEnd = sedPart(script, i, delim);
			const replEnd = regexEnd === undefined ? undefined : sedPart(script, regexEnd, delim);
			if (replEnd === undefined) return undefined;
			i = replEnd;
			while (/[gpiImM\d]/.test(script[i] ?? "")) i++;
			if (script[i] === "w") {
				const file = sedFileName(script, i + 1);
				if (file === undefined) return undefined;
				writes.push(file.name);
				i = file.end;
			}
		} else if (cmd === "w" || cmd === "W") {
			const file = sedFileName(script, i);
			if (file === undefined) return undefined;
			writes.push(file.name);
			i = file.end;
		} else if (cmd === "y") {
			const delim = script[i++] ?? "";
			if (!/^[^\w\s\\]$/.test(delim)) return undefined;
			const fromEnd = sedPart(script, i, delim);
			const toEnd = fromEnd === undefined ? undefined : sedPart(script, fromEnd, delim);
			if (toEnd === undefined) return undefined;
			i = toEnd;
		} else if (cmd === "q" || cmd === "Q" || cmd === "l") {
			space();
			while (/\d/.test(script[i] ?? "")) i++;
		} else if (cmd === undefined || !"pPdDnNgGhHx=".includes(cmd)) return undefined;
		space();
		// a command ends at ; newline } or the end of the script
		if (i < script.length && !";\n}".includes(script[i])) return undefined;
	}
}

/** `a`, `b`, `c` and `…` for a reason line. */
function listTargets(words: readonly string[]): string {
	const shown = words.slice(0, 3).map((w) => `\`${shortWord(w)}\``);
	return shown.join(", ") + (words.length > 3 ? ", …" : "");
}

/** A path word cut for a reason line. */
function shortWord(word: string): string {
	return word.length > 60 ? `${word.slice(0, 59)}…` : word;
}

/**
 * Why a `sed` invocation isn't read-only, or undefined when it can't write or
 * run anything: only the allowed flags (-n -E -r -s -u -z --posix --debug,
 * -e/--expression scripts) and a script sedScriptWrites accepts, with no
 * `w` file and no -i. `-i`/`w file` are write-effect blockers whose targets
 * are the file operands (-i only) and the `w` files; `-f`, `e`/`r`/… and
 * anything not understood are exec-effect (fail closed).
 */
function sedBlocker(args: string[]): Blocker | undefined {
	const expressions: string[] = [];
	const operands: string[] = [];
	let inPlace = false;
	let positional = false;
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (positional || a === "-" || !a.startsWith("-")) {
			operands.push(a);
			continue;
		}
		if (a === "--") {
			positional = true;
		} else if (a.startsWith("--")) {
			const name = a.split("=")[0];
			if (name === "--expression") {
				const value = a.includes("=") ? a.slice(name.length + 1) : args[++k];
				if (value === undefined) return execBlock(SED_UNSAFE_SCRIPT);
				expressions.push(value);
			} else if (name === "--file" || name.startsWith("--file")) {
				return execBlock("`sed -f` runs a script file");
			} else if (name.startsWith("--in-place")) {
				// a suffix with `/` or `*` can put the backup elsewhere
				if (/[/*]/.test(a.slice("--in-place".length))) return execBlock("`sed -i` suffix names another directory");
				inPlace = true;
			} else if (!SED_LONG_SAFE.has(a)) {
				return execBlock(`\`sed ${a}\` isn't a flag that can be checked`);
			}
		} else {
			// short cluster: safe letters, optionally ending in `e` (script follows); `i` takes the rest as the backup suffix
			for (let c = 1; c < a.length; c++) {
				const ch = a[c];
				if (ch === "i" || ch === "I") {
					if (/[/*]/.test(a.slice(c + 1))) return execBlock("`sed -i` suffix names another directory");
					inPlace = true;
					break;
				}
				if (ch === "f") return execBlock("`sed -f` runs a script file");
				if (ch === "e" && c === a.length - 1) {
					const value = args[++k];
					if (value === undefined) return execBlock(SED_UNSAFE_SCRIPT);
					expressions.push(value);
				} else if (!SED_SHORT_SAFE.includes(ch)) {
					return execBlock(`\`sed -${ch}\` isn't a flag that can be checked`);
				}
			}
		}
	}
	// -e fragments are joined with newlines, as sed does; without -e the first operand is the script
	const script = expressions.length > 0 ? expressions.join("\n") : operands.shift();
	const wrote = script === undefined ? undefined : sedScriptWrites(script);
	if (wrote === undefined) return execBlock(SED_UNSAFE_SCRIPT);
	if (!inPlace && wrote.length === 0) return undefined;
	const words = [...(inPlace ? operands : []), ...wrote];
	const label = inPlace ? "sed -i" : "sed";
	const reason = words.length === 0 ? "`sed -i` edits files in place" : `\`${label}\` ${inPlace ? "edits" : "writes"} ${listTargets(words)}`;
	return writeBlock(reason, label, words.map((word) => ({ word, glob: false })));
}

/** A word a command writes (or may write), with whether the shell could expand it into several. */
interface Target {
	word: string;
	glob: boolean;
	/** A destination directory (`-t DIR`, `tar -C`), as opposed to a file operand. */
	dir?: boolean;
	/** Names a remote host (`rsync x host:path`): always outside the project. */
	remote?: boolean;
}

/**
 * Why a command isn't read-only, and what kind of problem it is. `effect`
 * separates:
 * - undefined (plain): just not on the read-only list (`npm test`,
 *   `git commit`); a remembered rule may cover it.
 * - "write": writes files it names (`sed -i`, `sort -o`, `cp`, `tee`);
 *   `targets` (null = unknown) must all pass the project check
 *   (targetProblem) before a rule covers it.
 * - "exec": runs a program or writes somewhere unknowable (`sed -f`,
 *   `git -c`, `find -exec`, an unquoted glob); never covered, so `git log`
 *   can't cover `git log --output=…` outside the project nor `-c`.
 */
interface Blocker {
	reason: string;
	effect?: "write" | "exec";
	/** Command as the reasons name it (`sed -i`, `cp`). */
	label?: string;
	targets?: Target[] | null;
}

const plain = (reason: string): Blocker => ({ reason });
const execBlock = (reason: string): Blocker => ({ reason, effect: "exec" });
const writeBlock = (reason: string, label: string, targets: Target[] | null): Blocker => ({ reason, effect: "write", label, targets });

function writeFlagReason(label: string, flag: string): string {
	return `\`${label} ${flag}\` can write files or run programs`;
}

function globReason(label: string, word: string): string {
	return `\`${label}\` has an unquoted glob or \`$\` expansion (\`${word}\`), which could expand into flags; quote it`;
}

/**
 * Values of one option in `args`: `-<short>` (the next word, or the rest of
 * its cluster when `attached`) and the `longs` (`--name=v`, `--name v`, any
 * abbreviation of at least `minLong` characters). `valueShort` lists other
 * short options that take a value, so their text is not scanned for the
 * flag. [] when the option is absent; null when a value can't be read
 * (missing, or attached where that isn't allowed). Stops at `--`.
 */
function optionValues(args: readonly string[], short: string, longs: readonly string[], valueShort: string, attached: boolean, minLong = 3): string[] | null {
	const values: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (a === "--") break;
		if (a.startsWith("--")) {
			const name = a.split("=")[0];
			if (name.length < minLong || !longs.some((l) => l.startsWith(name))) continue;
			const value = a.includes("=") ? a.slice(name.length + 1) : args[++k];
			if (value === undefined) return null;
			values.push(value);
		} else if (/^-[^-]/.test(a)) {
			for (let c = 1; c < a.length; c++) {
				const ch = a[c];
				if (short !== "" && ch === short) {
					const rest = a.slice(c + 1);
					if (rest !== "") {
						if (!attached) return null;
						values.push(rest);
					} else {
						const value = args[++k];
						if (value === undefined) return null;
						values.push(value);
					}
					break;
				}
				if (valueShort.includes(ch)) {
					if (c === a.length - 1) k++; // its value is the next word
					break;
				}
			}
		}
	}
	return values;
}

/** Git globals that point git at another repository (its hooks/config run). */
const GIT_REPO_FLAGS = new Set(["-C", "--git-dir", "--work-tree"]);

/**
 * Why a git invocation isn't read-only, or undefined when it is (also used
 * for `rtk git ...`; `label` names the command in the reason).
 */
function gitBlocker(args: string[], cwd: string | undefined, label = "git"): Blocker | undefined {
	const outputs = optionValues(args, "", ["--output"], "", false, 4);
	if (outputs === null || outputs.length > 0) {
		const words = outputs ?? [];
		return writeBlock(
			words.length === 0 ? `\`${label} --output\` writes a file` : `\`${label} --output\` writes ${listTargets(words)}`,
			`${label} --output`,
			outputs === null ? null : words.map((word) => ({ word, glob: false })),
		);
	}
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const a = args[i];
		// -c / --config-env / --exec-path can make git run arbitrary programs
		if (a === "-c" || a.startsWith("--config-env") || a.startsWith("--exec-path")) {
			return execBlock(`\`${label} ${a.split("=")[0]}\` can make git run programs`);
		}
		// another repo's config can run programs (core.fsmonitor): cwd only
		const eq = a.startsWith("--") ? a.indexOf("=") : -1;
		const flag = eq === -1 ? a : a.slice(0, eq);
		const inline = eq === -1 ? undefined : a.slice(eq + 1);
		if (GIT_REPO_FLAGS.has(flag)) {
			const dir = inline ?? args[i + 1];
			// the target must be inside the cwd and in the cwd's own repo (a nested repo's hooks and fsmonitor would run)
			if (cwd === undefined || dir === undefined || crossesRepoBoundary(resolvePath(dir, cwd), cwd)) {
				return execBlock(`\`${label} ${flag}\` points git outside the working directory (that repo's config and hooks would run)`);
			}
			if (inline === undefined) i++;
		} else if (a === "--namespace") {
			i++;
		}
		i++;
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (sub === undefined) return plain(`\`${label}\` without a subcommand`);
	if (READ_ONLY_GIT_SUBCOMMANDS.includes(sub)) {
		// git grep -O opens matches in a pager/editor command
		const opensPager = sub === "grep" && rest.some((a) => /^-O/.test(a) || a.startsWith("--open-files-in-pager"));
		return opensPager ? execBlock(`\`${label} grep -O\` opens matches in another program`) : undefined;
	}
	const withArgs = plain(`\`${[label, sub, rest[0]].filter((w) => w !== undefined).join(" ")}\` can change the repository`);
	switch (sub) {
		case "branch":
			return checkGitBranchArgs(rest) ? undefined : withArgs;
		case "tag": {
			if (rest.length === 0) return undefined;
			const listing = rest.includes("-l") || rest.includes("--list");
			const writing = rest.some((a) =>
				["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-f", "--force", "-m", "-F", "-u", "--message", "--file"].some(
					(f) => a === f || a.startsWith(`${f}=`),
				),
			);
			return listing && !writing ? undefined : withArgs;
		}
		case "remote":
			return rest.every((a) => a === "-v" || a === "--verbose") || rest[0] === "show" || rest[0] === "get-url" ? undefined : withArgs;
		case "stash":
			return rest[0] === "list" || rest[0] === "show" ? undefined : withArgs;
		case "reflog":
			return rest[0] === undefined || rest[0] === "show" || rest[0].startsWith("-") ? undefined : withArgs;
		case "worktree":
			return rest[0] === "list" ? undefined : withArgs;
		case "config": {
			if (rest[0] === "get" || rest[0] === "list") return undefined;
			const reading = rest.some((a) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(a));
			const writing = rest.some((a) =>
				["--unset", "--unset-all", "--add", "--replace-all", "--edit", "-e", "--rename-section", "--remove-section"].includes(a),
			);
			return reading && !writing ? undefined : withArgs;
		}
		default:
			return plain(`\`${label} ${sub}\` isn't a read-only git command`);
	}
}

function checkGitBranchArgs(rest: string[]): boolean {
	const shortWrite = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "-t"]);
	const longWrite = ["--delete", "--move", "--copy", "--force", "--set-upstream", "--unset-upstream", "--edit-description", "--track", "--no-track", "--create-reflog"];
	if (rest.some((a) => shortWrite.has(a) || longWrite.some((l) => a.startsWith(l)))) return false;
	// Positional args create a branch unless listing or a filter flag's value
	const valueFlags = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);
	const listing = rest.includes("-l") || rest.includes("--list");
	for (let j = 0; j < rest.length; j++) {
		const a = rest[j];
		if (a.startsWith("-")) {
			if (valueFlags.has(a)) j++;
			continue;
		}
		if (!listing) return false;
	}
	return true;
}

/** rtk subcommands that pass their args to a native command. */
const RTK_NATIVE: Record<string, string> = { find: "find", rg: "rg", grep: "rg", tree: "tree" };

/** Why an rtk invocation isn't read-only, or undefined when it is. */
function rtkBlocker(args: string[], globs: boolean[], cwd: string | undefined): Blocker | undefined {
	let i = 0;
	// only display-only global flags are known; any other changes what rtk does
	while (i < args.length && args[i].startsWith("-")) {
		if (!RTK_DISPLAY_FLAGS.test(args[i])) return plain(`\`rtk ${args[i]}\` is an rtk option that can't be checked`);
		i++;
	}
	const sub = args[i];
	if (sub === undefined) return plain("`rtk` without a subcommand");
	const rest = args.slice(i + 1);
	const restGlobs = globs.slice(i + 1);
	if (sub === "git") return gitBlocker(rest, cwd, "rtk git");
	const native = RTK_NATIVE[sub];
	if (native !== undefined) {
		const glob = rest.find((_, k) => restGlobs[k]);
		if (glob !== undefined) return execBlock(globReason(`rtk ${sub}`, glob));
		return flagBlocker(native, rest, `rtk ${sub}`);
	}
	return READ_ONLY_RTK_SUBCOMMANDS.includes(sub) ? undefined : plain(`\`rtk ${sub}\` isn't on the read-only rtk list`);
}

/**
 * Why a `gh` invocation isn't read-only, or undefined when it is: `gh <pr|issue|run|repo|release>
 * <view|list|diff|status|checks>` (no leading flags, no --web), or `gh api` that can only GET.
 */
function ghBlocker(args: string[]): Blocker | undefined {
	const [group, sub] = args;
	const label = ["gh", group, sub].filter((w) => w !== undefined).join(" ");
	if (group === "api") return ghApiBlocker(args.slice(1));
	if (group === undefined || sub === undefined || !READ_ONLY_GH_GROUPS.includes(group) || !READ_ONLY_GH_SUBCOMMANDS.includes(sub)) {
		return plain(`\`${label}\` isn't a read-only gh command`);
	}
	// --web opens a browser
	if (args.slice(2).some((a) => a === "--web" || /^-[A-Za-z]*w/.test(a) && !a.startsWith("--"))) return execBlock(`\`${label} --web\` opens a browser`);
	return undefined;
}

/** `gh api` is read-only when it can only send a GET: no fields, no input, no method but GET, no method-override header, not graphql. */
function ghApiBlocker(args: string[]): Blocker | undefined {
	const plainApi = plain("`gh api` can send a request that changes something (only plain GET requests are read-only)");
	let endpoint: string | undefined;
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (a === "--") return plainApi;
		if (!a.startsWith("-")) {
			endpoint ??= a;
			continue;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = eq === -1 ? a : a.slice(0, eq);
			const value = eq === -1 ? undefined : a.slice(eq + 1);
			if (["--field", "--raw-field", "--input"].includes(name)) return plainApi;
			// another host gets the request (and the credentials for it)
			if (name === "--hostname") return plain("`gh api --hostname` sends the request to another host");
			if (name === "--method") {
				if ((value ?? args[++k])?.toUpperCase() !== "GET") return plainApi;
			} else if (name === "--header") {
				if (/override/i.test(value ?? args[++k] ?? "")) return plainApi;
			}
			continue;
		}
		// short cluster: -f/-F send fields, -X sets the method (value attached or next), -H a header
		if (/[fF]/.test(a)) return plainApi;
		const x = a.indexOf("X");
		if (x !== -1) {
			const rest = a.slice(x + 1);
			if ((rest !== "" ? rest : args[++k])?.toUpperCase() !== "GET") return plainApi;
		}
		const h = a.indexOf("H");
		if (h !== -1) {
			const rest = a.slice(h + 1);
			if (/override/i.test(rest !== "" ? rest : args[++k] ?? "")) return plainApi;
		}
	}
	// an absolute URL can point at any server
	if (endpoint !== undefined && /^https?:\/\//i.test(endpoint)) return plain("`gh api` with a full URL sends the request to another host");
	// graphql carries mutations in its query
	if (endpoint === undefined || /^\/?graphql/i.test(endpoint)) return plainApi;
	return undefined;
}

/** kubectl options that point it at another cluster, user or kubeconfig (a kubeconfig can run a credential plugin). */
const KUBECTL_CONNECTION_FLAGS = new Set([
	"--kubeconfig", "--server", "-s", "--token", "--as", "--as-group", "--as-uid", "--username", "--password",
	"--client-certificate", "--client-key", "--certificate-authority", "--tls-server-name", "--proxy-url", "--cluster", "--user", "--context",
]);

/** kubectl options that read an arbitrary API path, write a profile file, or take a manifest (which may be a Secret). */
const KUBECTL_UNCHECKED_FLAGS = new Set(["--raw", "--profile", "--profile-output"]);

/** `kubectl get|describe|logs|top|explain|version|api-resources` on the current cluster; Secrets still ask. */
function kubectlBlocker(args: string[]): Blocker | undefined {
	const sub = args[0];
	if (sub === undefined || !READ_ONLY_KUBECTL_SUBCOMMANDS.includes(sub)) {
		return plain(`\`${["kubectl", sub].filter(Boolean).join(" ")}\` isn't a read-only kubectl command`);
	}
	const rest = args.slice(1);
	if (rest.some((a) => KUBECTL_CONNECTION_FLAGS.has(a.split("=")[0]) || /^-s./.test(a))) {
		return execBlock("`kubectl` pointed at another server, user or kubeconfig can't be checked");
	}
	if (rest.some((a) => KUBECTL_UNCHECKED_FLAGS.has(a.split("=")[0]))) {
		return plain("`kubectl` with --raw or --profile can't be checked");
	}
	// a manifest or kustomization can name a Secret
	if ((sub === "get" || sub === "describe") && rest.some((a) => /^-[fk]/.test(a) || /^--(filename|kustomize)(=|$)/.test(a))) {
		return plain(`\`kubectl ${sub}\` from a file can't be checked (the manifest may be a Secret)`);
	}
	// Secret contents are credentials: reading them asks
	if (rest.some((a) => !a.startsWith("-") && /(^|[,/])secrets?(\.[a-z0-9.]+)?([,/]|$)/i.test(a))) {
		return plain(`\`kubectl ${sub}\` of Secrets prints credentials`);
	}
	return undefined;
}

/** `docker` / `podman` ps, images, inspect, logs, version, info: the subcommand comes first, and no flag redirects the engine. */
function containerBlocker(root: string, args: string[]): Blocker | undefined {
	const sub = args[0];
	if (sub === undefined || !READ_ONLY_CONTAINER_SUBCOMMANDS.includes(sub)) {
		return plain(`\`${[root, sub].filter(Boolean).join(" ")}\` isn't a read-only ${root} command`);
	}
	// -H / --host / --context / --config / --connection / --url point at another engine or config
	const redirect = args.slice(1).find((a) => /^(-H|-c|--host|--context|--config|--connection|--url|--remote|--identity)(=|$)/.test(a) || /^-H./.test(a));
	if (redirect !== undefined) return execBlock(`\`${root} ${redirect.split("=")[0]}\` points ${root} at another engine`);
	return undefined;
}

const HOSTNAME_READ_FLAGS = new Set(["-s", "-f", "-d", "-i", "-I", "-a", "-A", "--short", "--fqdn", "--long", "--domain", "--ip-address", "--all-ip-addresses", "--alias", "--all-fqdns"]);

/** Variable names that usually hold credentials. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASS|CRED|AUTH/i;

/** Commands whose read-only classification depends on every argument, so it can't hold behind xargs. */
const XARGS_UNTRUSTED = new Set(["git", "rtk", "gh", "kubectl", "docker", "podman", "env", "printenv"]);

/** Shell syntax words that start a loop, conditional or function. */
const SHELL_SYNTAX_WORDS = new Set(["for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "case", "esac", "select", "function", "{", "}", "!", "[["]);

/**
 * Why one simple command isn't read-only, or undefined when it is. The
 * single source of truth for read-only detection: isReadOnlySegment and
 * the dialog's "Why" line both come from here.
 */
function segmentBlocker(segment: Segment, cwd: string | undefined, scratch?: string, viaXargs = false, dir?: string, fetchHosts?: readonly string[]): Blocker | undefined {
	const stripped = stripPrefixes(segment.argv, segment.globs, true);
	if (stripped === null) {
		const name = segment.argv.map((w) => ASSIGNMENT.exec(w)?.[1]).find((n) => n !== undefined && !isSafeEnvVar(n));
		return plain(`sets \`${name ?? "a variable"}=…\` (only known-safe variables keep a command read-only)`);
	}
	// xargs appends words read from stdin, so the arguments seen here are not the ones that run
	viaXargs ||= segment.argv.slice(0, segment.argv.length - stripped.argv.length).includes("xargs");
	// a 1:1 rtk proxy is analysed as the real command (`rtk npm test` → `npm test`)
	const canon = canonicalize(stripped.argv);
	if (canon.length !== stripped.argv.length) {
		return segmentBlocker({ argv: canon, globs: stripped.globs.slice(stripped.argv.length - canon.length) }, cwd, scratch, viaXargs, dir, fetchHosts);
	}
	const [root, ...args] = stripped.argv;
	const argGlobs = stripped.globs.slice(1);
	if (root === undefined) return plain("has no command after its prefixes");
	if (root === "command") return args[0] === "-v" || args[0] === "-V" ? undefined : plain("`command` runs another command");
	if (SHELL_SYNTAX_WORDS.has(root)) return plain("uses a shell loop, conditional or function, which can't be checked");
	if (scratchWriteOk(root, args, argGlobs, scratch, dir)) return undefined;
	if (isShellSyntaxCheck(basename(root), args, argGlobs)) return undefined;
	// exec flags first: a remembered prefix (`tar`, `rsync`) must not cover them
	const execName = basename(root);
	const exec = execFlag(execName, args);
	if (exec !== undefined) return execBlock(writeFlagReason(execName, exec));
	if (execName === "sed") {
		// also `/usr/bin/sed`: a saved `sed` rule must never cover exec-capable sed
		const sedGlob = args.find((_, k) => argGlobs[k]);
		if (sedGlob !== undefined) return execBlock(globReason("sed", sedGlob));
		const sed = sedBlocker(args);
		if (sed !== undefined) return sed;
	}
	// awk is an interpreter (never remembered), but a program that can't reach outside counts as a read
	if (AWK_COMMANDS.has(execName)) return awkBlocker(args, argGlobs);
	if (Object.hasOwn(FILE_WRITERS, execName)) {
		const generic = `\`${execName}\` isn't on the read-only list`;
		return writeBlock(generic, execName, fileWriterTargets(execName, args, argGlobs));
	}
	if (Object.hasOwn(OUTPUT_WRITERS, execName)) {
		// a GET to a host the user allowed, printed to stdout: a read, not a write
		if (!viaXargs && fetchHost(execName, args, argGlobs, fetchHosts) !== undefined) return undefined;
		const generic = `\`${execName}\` isn't on the read-only list`;
		const targets = outputWriterTargets(execName, args, argGlobs);
		// nothing written (`curl URL` to stdout, `tar -t`): a plain blocker, a rule covers it anywhere
		return targets !== null && targets.length === 0 ? plain(generic) : writeBlock(generic, execName, targets);
	}
	if (!READ_ONLY_BASH_COMMANDS.includes(root)) return plain(`\`${root}\` isn't on the read-only list`);
	const glob = args.find((_, k) => argGlobs[k]);
	if (GLOB_SENSITIVE_COMMANDS.has(root) && glob !== undefined) return execBlock(globReason(root, glob));
	const flagged = flagBlocker(root, args, root);
	if (flagged !== undefined) return flagged;
	// these are read-only only for the exact arguments seen: words from xargs' stdin could add -C, -H, -X, a name to print, ...
	if (viaXargs && XARGS_UNTRUSTED.has(root)) return plain(`\`${root}\` run through xargs gets arguments that can't be checked`);

	switch (root) {
		case "git":
			return gitBlocker(args, cwd);
		case "rtk":
			return rtkBlocker(args, argGlobs, cwd);
		case "node":
			return args.length > 0 && args.every((a) => a === "--version" || a === "-v") ? undefined : plain("`node` runs code (only `node --version` is read-only)");
		case "npm":
		case "pnpm":
		case "yarn":
			return args[0] !== undefined && (READ_ONLY_PACKAGE_SUBCOMMANDS[root] ?? []).includes(args[0])
				? undefined
				: plain(`\`${[root, args[0]].filter(Boolean).join(" ")}\` isn't a read-only ${root} command`);
		case "cd":
			return cwd !== undefined && args.length === 1 && (isInside(resolvePath(args[0], cwd), resolve(cwd)) || cdIntoScratch(args[0], dir ?? cwd, scratch))
				? undefined
				: plain("`cd` leaves the working directory");
		case "uniq":
			// `uniq in out` writes `out`
			return uniqBlocker(args);
		case "gh":
			return ghBlocker(args);
		case "kubectl":
			return kubectlBlocker(args);
		case "docker":
		case "podman":
			return containerBlocker(root, args);
		case "env":
			// `env` alone prints every variable, credentials included; with arguments it sets variables or runs a command
			return args.length === 0 ? plain("`env` prints the whole environment, including credentials") : execBlock("`env` with arguments runs a command");
		case "printenv": {
			if (!args.every((a) => a === "-0" || a === "--null" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(a))) return plain("`printenv` with options that can't be checked");
			const names = args.filter((a) => !a.startsWith("-"));
			if (names.length === 0) return plain("`printenv` prints the whole environment, including credentials");
			const secret = names.find((n) => SECRET_ENV_NAME.test(n));
			return secret === undefined ? undefined : plain(`\`printenv ${secret}\` prints a credential`);
		}
		case "hostname":
			return args.every((a) => HOSTNAME_READ_FLAGS.has(a)) ? undefined : execBlock("`hostname` with arguments can change the hostname");
		default:
			return undefined;
	}
}

/**
 * Flags the scratch-dir writers accept (anything else, such as `cp -t` or
 * `cp -s`, goes through the normal write check). `cp`/`mv` without them
 * would also be fine, but links and target-directory forms are not worth
 * analysing for a convenience.
 */
const SCRATCH_FLAGS: Record<string, { short: string; longs: string[] }> = {
	mkdir: { short: "pv", longs: ["--parents", "--verbose"] },
	touch: { short: "", longs: [] },
	cp: { short: "RrapvfnT", longs: ["--recursive", "--archive", "--preserve", "--verbose", "--force", "--no-clobber"] },
	mv: { short: "fnvT", longs: ["--force", "--no-clobber", "--verbose"] },
	tee: { short: "a", longs: ["--append"] },
	rm: { short: "rRfdv", longs: ["--recursive", "--force", "--dir", "--verbose"] },
	rmdir: { short: "pv", longs: ["--parents", "--verbose"] },
};

/** git clone options that can't run a program (no -c/--config, --template, -u/--upload-pack). */
const CLONE_FLAGS = new Set(["-q", "--quiet", "-v", "--verbose", "--progress", "--single-branch", "--no-single-branch", "--no-tags", "--shallow-submodules", "--recurse-submodules", "--bare", "--mirror", "-n", "--no-checkout", "--sparse"]);
const CLONE_VALUE_FLAGS = new Set(["--depth", "-b", "--branch", "-j", "--jobs", "--filter"]);

/**
 * Writes that count as read-only for permission purposes because every
 * target is a literal path inside the scratch dir (the common need in plan
 * mode): `mkdir [-p]`, `touch`, `tee`, `cp` (the sources may be anywhere;
 * outside and secret ones still ask on their own), `mv` (sources too, since
 * it removes them: scratch to scratch only), `rm`/`rmdir` (strictly inside:
 * never the scratch dir itself) and `git clone <url> <path>` with options
 * that can't run a program. A target is absolute, or relative once an
 * earlier `cd` put the command inside the scratch dir (`dir`, the directory
 * the segment runs in). A secret file
 * name there still asks. Nothing else about these commands is relaxed.
 */
function scratchWriteOk(root: string, args: string[], globs: boolean[], scratch: string | undefined, dir?: string): boolean {
	if (scratch === undefined) return false;
	const literal = new RegExp(`^[${LITERAL_PATH_CHARS}]+$`);
	const inScratchDir = dir !== undefined && isInsideScratch(dir, scratch);
	const place = (word: string, glob: boolean | undefined): string | undefined => {
		if (glob === true || !literal.test(word)) return undefined;
		if (word.startsWith("/")) return word;
		return inScratchDir ? resolve(dir as string, word) : undefined;
	};
	const inScratch = (word: string, glob: boolean | undefined): boolean => {
		const path = place(word, glob);
		return path !== undefined && isInsideScratch(path, scratch);
	};
	if (root === "git") return args[0] === "clone" && scratchCloneOk(args.slice(1), globs.slice(1), inScratch);
	const flags = Object.hasOwn(SCRATCH_FLAGS, root) ? SCRATCH_FLAGS[root] : undefined;
	if (flags === undefined) return false;
	const operands: Array<{ word: string; glob: boolean | undefined }> = [];
	let end = false;
	for (const [k, a] of args.entries()) {
		if (!end && a === "--") end = true;
		else if (end || a === "-" || !a.startsWith("-")) operands.push({ word: a, glob: globs[k] });
		else if (a.startsWith("--") ? !flags.longs.includes(a) : ![...a.slice(1)].every((c) => flags.short.includes(c))) return false;
	}
	if (operands.length === 0) return false;
	// the written paths: every operand, except the sources of cp (read, possibly from the project)
	const written = root === "cp" ? operands.slice(-1) : operands;
	if (root === "cp" && operands.length < 2) return false;
	if (root === "mv" && operands.length < 2) return false;
	const removes = root === "rm" || root === "rmdir";
	return written.every((o) => {
		if (!inScratch(o.word, o.glob)) return false;
		// deleting the scratch dir itself is not "inside" it
		if (removes && !isStrictlyInsideScratch(place(o.word, o.glob) as string, scratch)) return false;
		return root === "mkdir" || root === "touch" || removes || !isSecretFile(o.word);
	});
}

/** Shells whose `-n` only parses a script. */
const SYNTAX_CHECK_SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);

/**
 * `bash -n script.sh` (also sh, dash, zsh, ksh): the shell parses the files
 * and runs nothing. Exactly `-n` plus literal file names: no `-c`, `-s`,
 * `-i`, `--rcfile` or any other flag, no glob or expansion in a name.
 */
function isShellSyntaxCheck(name: string, args: string[], globs: boolean[]): boolean {
	if (!SYNTAX_CHECK_SHELLS.has(name) || args[0] !== "-n") return false;
	const files = args.slice(args[1] === "--" ? 2 : 1);
	const literal = new RegExp(`^[${LITERAL_PATH_CHARS}]+$`);
	return files.length > 0 && files.every((word, k) => !word.startsWith("-") && literal.test(word) && globs[(args[1] === "--" ? 2 : 1) + k] !== true);
}

/** `cd <literal path>` landing in the scratch dir (or a directory in it): the shell is then still in a place the session owns. */
function cdIntoScratch(word: string, cwd: string, scratch: string | undefined): boolean {
	return scratch !== undefined && new RegExp(`^[${LITERAL_PATH_CHARS}]+$`).test(word) && isInsideScratch(resolvePath(word, cwd), scratch);
}

/** `git clone [safe options] <url> <scratch path>`: exactly a source and a destination. */
function scratchCloneOk(args: string[], globs: boolean[], inScratch: (word: string, glob: boolean | undefined) => boolean): boolean {
	const operands: Array<{ word: string; glob: boolean | undefined }> = [];
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (a === "--") {
			operands.push(...args.slice(k + 1).map((word, j) => ({ word, glob: globs[k + 1 + j] })));
			break;
		}
		if (!a.startsWith("-")) {
			operands.push({ word: a, glob: globs[k] });
			continue;
		}
		const name = a.split("=")[0];
		if (CLONE_FLAGS.has(a)) continue;
		if (!CLONE_VALUE_FLAGS.has(name)) return false;
		if (!a.includes("=")) k++;
	}
	if (operands.length !== 2) return false;
	const [url, dest] = operands;
	// `ext::cmd` transports run a program; variables and globs hide what is fetched
	return url.glob !== true && !/[$`]|::/.test(url.word) && inScratch(dest.word, dest.glob);
}

/**
 * Flag-level blocker of a read-only-listed command (`root` = native name):
 * a WRITE_FLAGS flag is exec; an OUTPUT_FLAGS flag (`sort -o`, `tree -o`)
 * is a write to the named file. `label` names the command in the reason.
 */
function flagBlocker(root: string, args: string[], label: string): Blocker | undefined {
	const flag = writeFlag(root, args);
	if (flag !== undefined) return execBlock(writeFlagReason(label, flag));
	const spec = Object.hasOwn(OUTPUT_FLAGS, root) ? OUTPUT_FLAGS[root] : undefined;
	if (spec === undefined) return undefined;
	const values = optionValues(args, spec.short, spec.longs, spec.valueShort, spec.attached);
	if (values !== null && values.length === 0) return undefined;
	const flagLabel = `${label} -${spec.short}`;
	const reason = values === null ? `\`${flagLabel}\` writes a file` : `\`${flagLabel}\` writes ${listTargets(values)}`;
	return writeBlock(reason, flagLabel, values === null ? null : values.map((word) => ({ word, glob: false })));
}

/** `uniq in out` writes `out`; options that take a value are skipped when counting operands. */
function uniqBlocker(args: string[]): Blocker | undefined {
	const operands: string[] = [];
	let end = false;
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (end || a === "-" || !a.startsWith("-")) operands.push(a);
		else if (a === "--") end = true;
		else if (a.startsWith("--")) {
			if (!a.includes("=") && a.length >= 4 && ["--skip-fields", "--skip-chars", "--check-chars"].some((l) => l.startsWith(a))) k++;
		} else if (/^-[A-Za-z0-9]*[fsw]$/.test(a)) k++; // `-f N`; `-f1` carries its value
	}
	if (operands.length <= 1) return undefined;
	const reason = "`uniq` with two files writes the second";
	return operands.length === 2 ? writeBlock(`\`uniq\` writes ${listTargets([operands[1]])}`, "uniq", [{ word: operands[1], glob: false }]) : writeBlock(reason, "uniq", null);
}

/**
 * Targets of a FILE_WRITERS command: every operand, plus the directory of
 * `-t` / `--target-directory` (sources count too). null when they can't be
 * known: a flag not in the table (it might take a value), a missing flag
 * value, or no operands at all.
 */
function fileWriterTargets(name: string, args: string[], globs: boolean[]): Target[] | null {
	const spec = FILE_WRITERS[name];
	const targets: Target[] = [];
	let end = false;
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (end || a === "-" || !a.startsWith("-")) {
			targets.push({ word: a, glob: globs[k] === true });
			continue;
		}
		if (a === "--") {
			end = true;
		} else if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const long = (eq === -1 ? a : a.slice(0, eq)).slice(2);
			if (spec.dir === true && long === "target-directory") {
				const value = eq === -1 ? args[++k] : a.slice(eq + 1);
				if (value === undefined) return null;
				targets.push({ word: value, glob: globs[k] === true, dir: true });
			} else if (spec.valueLongs.includes(long)) {
				if (eq === -1 && args[++k] === undefined) return null;
			} else if (spec.optionalLongs.includes(long)) {
				// optional value is attached only
			} else if (!spec.longs.includes(long) || eq !== -1) {
				return null;
			}
		} else {
			for (let c = 1; c < a.length; c++) {
				const ch = a[c];
				if (spec.dir === true && ch === "t") {
					const rest = a.slice(c + 1);
					const value = rest !== "" ? rest : args[++k];
					if (value === undefined) return null;
					targets.push({ word: value, glob: globs[k] === true, dir: true });
					break;
				}
				if (spec.valueFlags.includes(ch)) {
					if (c === a.length - 1 && args[++k] === undefined) return null;
					break;
				}
				if (!spec.flags.includes(ch)) return null;
			}
		}
	}
	return targets.length > 0 ? targets : null;
}

/** What `scanOptions` found in a command line. */
interface OptionScan {
	/** Flags seen, as `-x` or `--name`. */
	present: Set<string>;
	/** Values of the flags that take one, by flag. */
	values: Map<string, Target[]>;
	operands: Target[];
}

/**
 * Splits a command line by an OptionSpec: flags, flag values and operands.
 * null when a flag isn't in the table or lacks its value (the caller then
 * treats the targets as unknown). Long options must match exactly (no
 * getopt abbreviations: an abbreviation is just unknown), `--no-<flag>`
 * negates a listed flag, `--` ends the options, and a list flag swallows the
 * words after it up to the next flag.
 */
function scanOptions(spec: OptionSpec, args: readonly string[], globs: readonly boolean[]): OptionScan | null {
	const present = new Set<string>();
	const values = new Map<string, Target[]>();
	const operands: Target[] = [];
	const add = (flag: string, word: string, glob: boolean): void => {
		present.add(flag);
		values.set(flag, [...(values.get(flag) ?? []), { word, glob }]);
	};
	let end = false;
	let list: string | undefined;
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		const glob = globs[k] === true;
		if (end) {
			operands.push({ word: a, glob });
			continue;
		}
		if (list !== undefined && (!a.startsWith("-") || a === "-")) {
			add(list, a, glob);
			continue;
		}
		list = undefined;
		if (a === "--") {
			end = true;
		} else if (a === "-" || !a.startsWith("-")) {
			operands.push({ word: a, glob });
		} else if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = (eq === -1 ? a : a.slice(0, eq)).slice(2);
			const inline = eq === -1 ? undefined : a.slice(eq + 1);
			if (spec.longs.includes(name) || (name.startsWith("no-") && spec.longs.includes(name.slice(3)))) {
				if (inline !== undefined) return null;
				present.add(`--${name}`);
			} else if (spec.valueLongs.includes(name) || spec.outLongs.includes(name)) {
				const value = inline ?? args[++k];
				if (value === undefined) return null;
				add(`--${name}`, value, glob || globs[k] === true);
			} else return null;
		} else {
			for (let c = 1; c < a.length; c++) {
				const ch = a[c];
				if (spec.outFlags.includes(ch) || spec.valueFlags.includes(ch)) {
					const rest = a.slice(c + 1);
					const value = rest !== "" ? rest : args[++k];
					if (value === undefined) return null;
					add(`-${ch}`, value, glob || globs[k] === true);
					break;
				}
				if (spec.listFlags.includes(ch)) {
					present.add(`-${ch}`);
					list = `-${ch}`;
					if (a.slice(c + 1) !== "") add(list, a.slice(c + 1), glob);
					break;
				}
				if (!spec.flags.includes(ch)) return null;
				present.add(`-${ch}`);
			}
		}
	}
	return { present, values, operands };
}

/** `rsync x host:path`, `rsync://…`: a destination on another machine. */
function isRemoteSpec(word: string): boolean {
	return /^[a-z+]+:\/\//i.test(word) || /^[^/]*:/.test(word);
}

/** The old tar style `tar czf out.tgz dir`: letters without a dash, each value-taking letter followed by its word, in order. */
function expandOldTar(args: string[], globs: boolean[]): { args: string[]; globs: boolean[] } | null {
	if (!/^[A-Za-z]+$/.test(args[0] ?? "")) return { args, globs };
	const outArgs: string[] = [];
	const outGlobs: boolean[] = [];
	let next = 1;
	for (const letter of args[0]) {
		outArgs.push(`-${letter}`);
		outGlobs.push(false);
		if (OUTPUT_WRITERS.tar.outFlags.includes(letter) || OUTPUT_WRITERS.tar.valueFlags.includes(letter)) {
			if (next >= args.length) return null;
			outArgs.push(args[next]);
			outGlobs.push(globs[next] === true);
			next++;
		}
	}
	return { args: [...outArgs, ...args.slice(next)], globs: [...outGlobs, ...globs.slice(next)] };
}

/**
 * Files a curl `-w`/`--write-out` format writes: each `%output{FILE}` (curl 8.3+,
 * a leading `>>` appends). A format read from a file (`@f`, `-` for stdin) can't
 * be inspected and an unterminated `%output{` has no file, so both are unknown
 * targets (glob = never judged safe), as is the `-` that `%output{-}` could mean.
 */
function writeOutTargets(formats: readonly Target[]): Target[] {
	const unknown = (): Target => ({ word: "-", glob: true });
	return formats.flatMap((format) => {
		if (format.word.startsWith("@") || format.word === "-") return [unknown()];
		const targets: Target[] = [];
		let rest = format.word;
		for (let at = rest.indexOf("%output{"); at !== -1; at = rest.indexOf("%output{")) {
			rest = rest.slice(at + "%output{".length);
			const end = rest.indexOf("}");
			if (end === -1) return [...targets, unknown()];
			const file = rest.slice(0, end).replace(/^>>/, "");
			targets.push(file === "" || file === "-" ? unknown() : { word: file, glob: format.glob });
			rest = rest.slice(end + 1);
		}
		return targets;
	});
}

/**
 * Write targets of an OUTPUT_WRITERS command (the files and directories it
 * writes or extracts into), [] when it writes nothing (`curl URL` prints,
 * `tar -t` lists), null when they can't be known (an unlisted flag, a missing
 * value, no mode). What the flags mean:
 * - curl: the output flags; `-O`/`--remote-name[-all]` saves into the cwd.
 * - wget: the output flags; without `-O` and `-P` it saves into the cwd.
 * - tar: creating (`c r u A`) writes `-f`; extracting (`x`) writes `-C` or
 *   the cwd; listing/diffing (`t d`) writes nothing; any other mix is unknown.
 * - zip: the archive operand (or `-O`), plus `-b`.
 * - unzip: `-d`, else the cwd; `-l -t -p -v` write nothing.
 * - rsync: the destination (the last operand of two or more), plus the
 *   backup, temp, partial-dir, log and batch outputs.
 */
function outputWriterTargets(name: string, args: string[], globs: boolean[]): Target[] | null {
	const spec = OUTPUT_WRITERS[name];
	let argv = args;
	let marks = globs;
	if (name === "tar") {
		const expanded = expandOldTar(args, globs);
		if (expanded === null) return null;
		argv = expanded.args;
		marks = expanded.globs;
	}
	const scan = scanOptions(spec, argv, marks);
	if (scan === null) return null;
	const has = (...flags: string[]): boolean => flags.some((f) => scan.present.has(f));
	const get = (...flags: string[]): Target[] => flags.flatMap((f) => scan.values.get(f) ?? []);
	const cwd: Target = { word: ".", glob: false };
	const outs = [...spec.outFlags].flatMap((c) => get(`-${c}`)).concat(spec.outLongs.flatMap((l) => get(`--${l}`)));
	switch (name) {
		case "curl": {
			const saved = has("-O", "--remote-name", "--remote-name-all") && get("--output-dir").length === 0 ? [...outs, cwd] : outs;
			return [...saved, ...writeOutTargets(get("-w", "--write-out"))];
		}
		case "wget":
			return has("-O", "--output-document") || get("-P", "--directory-prefix").length > 0 ? outs : [...outs, cwd];
		case "tar": {
			const creating = has("-c", "-r", "-u", "-A", "--create", "--append", "--update", "--catenate", "--concatenate");
			const extracting = has("-x", "--extract", "--get");
			const reading = has("-t", "-d", "--list", "--diff", "--compare");
			if (Number(creating) + Number(extracting) + Number(reading) !== 1) return null;
			if (reading) return [];
			if (creating) return get("-f", "--file").length > 0 ? get("-f", "--file") : null;
			return get("-C", "--directory").length > 0 ? get("-C", "--directory") : [cwd];
		}
		case "zip": {
			const archive = get("-O", "--output-file");
			const written = archive.length > 0 ? archive : scan.operands.slice(0, 1);
			return written.length === 0 ? null : [...written, ...get("-b", "--temp-path")];
		}
		case "unzip":
			if (has("-l", "-t", "-p", "-v")) return [];
			return get("-d").length > 0 ? get("-d") : [cwd];
		case "rsync": {
			const dest = scan.operands.length >= 2 ? scan.operands[scan.operands.length - 1] : undefined;
			return dest === undefined ? outs : [...outs, { ...dest, remote: isRemoteSpec(dest.word) }];
		}
		default:
			return null;
	}
}

/** Flags that send something besides the URL (a body, a local file, a cookie file) or move the request elsewhere. */
const FETCH_SENDING_FLAGS: Record<"curl" | "wget", readonly string[]> = {
	curl: ["-d", "-F", "-T", "-b", "-x", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "--form", "--form-string", "--upload-file", "--cookie", "--proxy", "--resolve", "--connect-to", "--unix-socket", "--quote", "--request-target"],
	wget: ["-i", "-B", "--post-data", "--post-file", "--body-data", "--body-file", "--input-file", "--base", "--load-cookies", "--save-cookies", "-r", "--recursive", "--mirror", "-p", "--page-requisites", "--span-hosts"],
};

/**
 * curl flags that also disqualify an auto-allowed fetch: local key material
 * (`-E`, `--cert`, `--key`) and `--location-trusted` (forwards credentials to
 * redirect hosts). Together with FETCH_SENDING_FLAGS.curl this classifies every
 * curl flag that takes a value or changes where credentials go; the rest are
 * allowed. A test pins that each OUTPUT_WRITERS.curl entry is in one list or
 * the other, so a new flag can't slip in unjudged.
 */
export const CURL_FETCH_DISQUALIFIERS: readonly string[] = [...FETCH_SENDING_FLAGS.curl, "-E", "-Q", "--cert", "--key", "--location-trusted"];

/** The lowercase host of an absolute http(s) URL word, undefined for anything else. */
export function urlHost(word: string): string | undefined {
	// strict authority: curl and WHATWG disagree on `\`, `@`, `%` and non-ASCII hosts, so only plain ones pass
	if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?([/?#]|$)/i.test(word) || /[$`\s]/.test(word)) return undefined;
	try {
		const url = new URL(word);
		return url.username === "" && url.password === "" ? url.hostname.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Hosts whose fetch grant would make `command` read-only: the hosts of its
 * URLs not yet allowed, kept only when granting them is what removes the
 * ask (a minimal set). [] when no grant helps (it writes, uploads, runs
 * something else, or is read-only already).
 */
export function fetchGrantHosts(command: string, cwd: string | undefined, scratch: string | undefined, granted: readonly string[] = []): string[] {
	if (isReadOnlyCommand(command, cwd, scratch, granted)) return [];
	const known = new Set(granted.map((h) => h.toLowerCase()));
	let hosts = [...new Set((command.match(/https?:\/\/[^\s'"|;&<>()]+/gi) ?? []).flatMap((url) => urlHost(url) ?? []))].filter((h) => !known.has(h));
	if (hosts.length === 0 || hosts.length > 5) return [];
	if (!isReadOnlyCommand(command, cwd, scratch, [...granted, ...hosts])) return [];
	for (const host of [...hosts]) {
		const without = hosts.filter((h) => h !== host);
		if (isReadOnlyCommand(command, cwd, scratch, [...granted, ...without])) hosts = without;
	}
	return hosts;
}

/**
 * The host of a curl/wget command that only fetches: GET or HEAD, every URL
 * on `granted`, nothing sent besides the URL (no body,
 * upload, cookie file, proxy or resolve override) and the response printed,
 * not saved (curl without an output flag, `wget -O -`). undefined when it is
 * anything else, so the caller judges it as before. A GET still carries its
 * URL, which is why only hosts the user allowed qualify, never "any host".
 */
export function fetchHost(name: string, args: readonly string[], globs: readonly boolean[], granted: readonly string[] = []): string | undefined {
	if (name !== "curl" && name !== "wget") return undefined;
	const scan = scanOptions(OUTPUT_WRITERS[name], args, globs);
	if (scan === null) return undefined;
	const disqualifiers = name === "curl" ? CURL_FETCH_DISQUALIFIERS : FETCH_SENDING_FLAGS[name];
	if (disqualifiers.some((flag) => scan.present.has(flag))) return undefined;
	// `@file` on a curl value flag reads a local file and sends it (`-H @creds.json`)
	if (name === "curl") {
		const spec = OUTPUT_WRITERS.curl;
		for (const [flag, values] of scan.values) {
			const valued = flag.startsWith("--") ? spec.valueLongs.includes(flag.slice(2)) : spec.valueFlags.includes(flag[1]);
			if (valued && values.some((v) => v.word.startsWith("@"))) return undefined;
		}
	}
	const method = [...(scan.values.get("-X") ?? []), ...(scan.values.get("--request") ?? []), ...(scan.values.get("--method") ?? [])];
	if (method.some((m) => !/^(GET|HEAD)$/i.test(m.word))) return undefined;
	const targets = outputWriterTargets(name, [...args], [...globs]);
	if (targets === null || !targets.every((t) => !t.glob && (t.word === "-" || HARMLESS_DEVICES.has(t.word)))) return undefined;
	const urls = [...scan.operands, ...(scan.values.get("--url") ?? [])];
	if (urls.length === 0) return undefined;
	const allowed = new Set(granted.map((h) => h.toLowerCase()));
	let host: string | undefined;
	for (const url of urls) {
		const h = url.glob ? undefined : urlHost(url.word);
		if (h === undefined || !allowed.has(h)) return undefined;
		host ??= h;
	}
	return host;
}

type TargetProblem = "unchecked" | "outside" | "protected" | "secret";

/** Devices a command may name as a target without leaving the project. */
const HARMLESS_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/**
 * Whether one write target stays inside the project: a literal word (no
 * `$`, glob, brace expansion, `~user`, `..`), resolving by realpath of the
 * nearest existing ancestor inside the cwd or the scratch dir, and neither
 * a protected path nor a secret file. `dir` is where the command runs
 * (undefined = the cwd, null = unknown after an unresolvable `cd`). A
 * leading `~` resolves to home and is judged like any path.
 */
function targetProblem(target: Target, cwd: string | undefined, dir: string | null | undefined, scratch: string | undefined): TargetProblem | undefined {
	const word = target.word;
	if (target.remote === true) return "outside";
	if (HARMLESS_DEVICES.has(word)) return undefined;
	if (cwd === undefined) return "unchecked";
	const where = dir === undefined ? cwd : (dir ?? undefined);
	if (target.glob || word === "" || /[$`]/.test(word) || (word.startsWith("~") && word !== "~" && !word.startsWith("~/"))) return "unchecked";
	if (where === undefined && !/^[/~]/.test(word)) return "unchecked";
	const resolved = resolvePath(word, where ?? "/");
	const inScratch = scratch !== undefined && isInsideScratch(resolved, scratch);
	if (/(^|\/)\.\.(\/|$)/.test(word)) {
		// symlinks make `a/../b` unknowable; one that leaves the project anyway is just outside
		return inScratch || isInside(resolved, resolve(cwd)) ? "unchecked" : "outside";
	}
	const real = realpathLoose(resolved);
	if (!isInside(real, realpathLoose(resolve(cwd))) && !inScratch) return "outside";
	const ctx: PathContext = { cwd: where ?? cwd, scratchDir: scratch };
	if (isProtectedPath(resolved, ctx) || isProtectedPath(real, ctx)) return "protected";
	if (isSecretFile(resolved, { cwd: ctx.cwd }) || isSecretFile(real, { cwd: ctx.cwd })) return "secret";
	return undefined;
}

const PROBLEM_TEXT: Record<TargetProblem, string> = {
	unchecked: "target",
	outside: "writes outside the working directory:",
	protected: "writes a protected path:",
	secret: "writes a secret file:",
};

/**
 * Why a write-effect blocker's targets don't pass the project check, or
 * undefined when every target does (or the blocker doesn't write). Unknown
 * targets give the blocker's own reason.
 */
function writeProblem(blocker: Blocker, cwd: string | undefined, dir: string | null | undefined, scratch: string | undefined): string | undefined {
	if (blocker.effect !== "write") return undefined;
	const targets = blocker.targets;
	if (targets === undefined || targets === null || targets.length === 0) return blocker.reason;
	const label = blocker.label ?? "command";
	for (const target of targets) {
		const problem = targetProblem(target, cwd, dir, scratch);
		if (problem === undefined) continue;
		const word = `\`${shortWord(target.word)}\``;
		return problem === "unchecked" ? `\`${label}\` target ${word} can't be checked` : `\`${label}\` ${PROBLEM_TEXT[problem]} ${word}`;
	}
	return undefined;
}

/** The blocker's reason, naming the failing target when that is why no rule covers it. */
function reasonOf(blocker: Blocker, cwd: string | undefined, dir: string | null | undefined, scratch: string | undefined): string {
	return writeProblem(blocker, cwd, dir, scratch) ?? blocker.reason;
}

/**
 * The directory each segment runs in (null = unknown after a `cd` that
 * can't be resolved), following `cd`/`pushd`/`popd` like gitRunsInOtherRepo.
 */
function segmentDirs(segments: readonly Segment[], cwd: string | undefined): (string | null)[] {
	let dir: string | undefined = cwd;
	return segments.map((segment) => {
		const before = dir ?? null;
		const stripped = stripPrefixes(segment.argv, segment.globs, true);
		const argv = canonicalize(stripped?.argv ?? []);
		const name = basename(argv[0] ?? "");
		if (DIR_CHANGERS.has(name)) dir = changedDir(name, argv.slice(1), dir);
		return before;
	});
}

/**
 * The effect of each simple command of `command` (see Blocker): "read-only",
 * "plain" (just not on the list), "write" or "exec". undefined when the
 * command can't be parsed. For tests and diagnostics.
 */
export function commandEffects(command: string, cwd?: string, scratch?: string, fetchHosts?: readonly string[]): Array<"read-only" | "plain" | "write" | "exec"> | undefined {
	const tokens = tokenize(maskForAnalysis(command.trim(), scratch), scratch);
	return tokens?.map((segment) => segmentBlocker(segment, cwd, scratch, false, undefined, fetchHosts)).map((b) => (b === undefined ? "read-only" : (b.effect ?? "plain")));
}

/** True when one simple command is read-only. */
function isReadOnlySegment(segment: Segment, cwd: string | undefined, scratch?: string, fetchHosts?: readonly string[]): boolean {
	return segmentBlocker(segment, cwd, scratch, false, undefined, fetchHosts) === undefined;
}

function rootOf(segment: Segment): string | undefined {
	return stripPrefixes(segment.argv, segment.globs, false)?.argv[0];
}

/** Why the tokenizer rejected a command (see its header). */
function unparseableReason(command: string): string {
	if (command.includes("$(") || command.includes("`")) return "uses command substitution (`$(…)`), which can't be checked";
	// quoted text can't trigger the remaining rejections
	const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
	if (unquoted.includes("<")) return "reads from a heredoc or input redirect";
	if (unquoted.includes("(") || unquoted.includes(")")) return "uses a subshell or process substitution";
	if (unquoted.includes(">")) return "writes output to a file (only /dev/null is allowed)";
	return "can't be parsed safely (unbalanced quotes or an empty command)";
}

/** Rules that count as approval, with how the dialog names them ("allowed for this session"). */
export interface CoverSource {
	label: string;
	prefixes: readonly (readonly string[])[];
	exact: readonly (readonly string[])[];
}

/** What `approvalBreakdown` says about a command. */
export interface ApprovalBreakdown {
	/** Simple commands that still need approval, with why. `segment` is "" when the whole command is the problem (unparseable). */
	needs: { segment: string; reason: string }[];
	/** Simple commands that don't, formatted `` `cmd` (read-only) `` or `` `cmd` (allowed for this session) ``. */
	ok: string[];
}

/** Longest segment text shown in the dialog. */
export const SEGMENT_DISPLAY_LIMIT = 60;

/** A simple command as shell-ish text: words with spaces or metacharacters single-quoted. */
function segmentText(segment: Segment): string {
	const text = segment.argv.map((w) => (w === "" || /[^A-Za-z0-9_@%+=:,./~-]/.test(w) ? `'${w.replace(/'/g, "'\\''")}'` : w)).join(" ");
	return text.length > SEGMENT_DISPLAY_LIMIT ? `${text.slice(0, SEGMENT_DISPLAY_LIMIT - 1)}…` : text;
}

interface ClassifiedSegment {
	segment: Segment;
	blocker?: Blocker;
	/** The blocker's reason, naming the failing write target when that is the problem. */
	reason?: string;
	/** Label of the first source that covers it. */
	coveredBy?: string;
}

/**
 * Per simple command: its blocker (undefined = read-only) and the rule
 * source covering it. The single place read-only / covered logic is
 * combined: readOnlyBlockers, isReadOnlyCommand and approvalBreakdown all
 * use it. `problem` is set for a command that can't be analysed at all.
 */
function classifySegments(
	command: string,
	cwd: string | undefined,
	covered: readonly CoverSource[],
	scratch: string | undefined,
	fetchHosts?: readonly string[],
): { problem?: string; items: ClassifiedSegment[]; changesDirWithGit: boolean } {
	const none = { items: [], changesDirWithGit: false };
	const original = command.trim();
	if (original === "") return none;
	if (original.length > MAX_COMMAND_LENGTH) return { ...none, problem: `is longer than ${MAX_COMMAND_LENGTH} characters` };
	const trimmed = maskForAnalysis(original, scratch);
	const segments = tokenize(trimmed, scratch);
	if (segments === null) return { ...none, problem: unparseableReason(trimmed) };
	if (segments.length === 0) return { ...none, problem: "has no command (only a comment)" };
	// coverage is judged on the git -C normalized form, like isCoveredByPrefixes
	const normalized = normalizeGitSegments(segments, cwd);
	const dirs = segmentDirs(segments, cwd);
	const items = segments.map((segment, k): ClassifiedSegment => {
		const blocker = segmentBlocker(segment, cwd, scratch, false, dirs[k] ?? undefined, fetchHosts);
		if (blocker === undefined) return { segment };
		const source = covered.find((c) => isCoveredSegment(normalized[k], c.prefixes, cwd, c.exact, scratch, dirs[k]));
		return { segment, blocker, reason: reasonOf(blocker, cwd, dirs[k], scratch), coveredBy: source?.label };
	});
	// git after a cd into a nested repo, outside the cwd, or an unresolvable
	// dir; a subdirectory of the same repo uses the same config and hooks
	// (-C left after normalization is gitBlocker's reason, not this one)
	const changesDir = segments.some((s) => DIR_CHANGERS.has(basename(rootOf(s) ?? "")));
	const changesDirWithGit = cwd !== undefined && changesDir && gitRunsInOtherRepo(normalized, cwd, false);
	return { items, changesDirWithGit };
}

const CD_GIT_REASON = "`cd` into another repository or outside the working directory combined with git (that repo's config and hooks would run)";

/**
 * Which simple commands of `command` still need approval and why, and which
 * don't (read-only, or covered by one of `covered`). An unparseable command
 * is one `needs` entry with an empty segment.
 */
export function approvalBreakdown(command: string, cwd?: string, covered: readonly CoverSource[] = [], scratch?: string, fetchHosts?: readonly string[]): ApprovalBreakdown {
	const { problem, items, changesDirWithGit } = classifySegments(command, cwd, covered, scratch, fetchHosts);
	if (problem !== undefined) return { needs: [{ segment: "", reason: problem }], ok: [] };
	const needs: ApprovalBreakdown["needs"] = [];
	const ok: string[] = [];
	for (const { segment, blocker, reason, coveredBy } of items) {
		const text = segmentText(segment);
		if (blocker !== undefined && coveredBy === undefined) {
			const why = reason ?? blocker.reason;
			if (!needs.some((n) => n.segment === text && n.reason === why)) needs.push({ segment: text, reason: why });
		} else {
			const entry = `\`${text}\` (${blocker === undefined ? "read-only" : coveredBy})`;
			if (!ok.includes(entry)) ok.push(entry);
		}
	}
	if (changesDirWithGit) needs.push({ segment: "", reason: CD_GIT_REASON });
	return { needs, ok };
}

/** How many "Already OK" entries are listed before `+N more`. */
const OK_LIMIT = 4;

/**
 * Dialog lines for a breakdown. One simple command (or an unparseable one):
 * `Why: <reason>.` Otherwise `Needs approval:` and `Already OK:` lines.
 */
export function formatBreakdown(breakdown: ApprovalBreakdown): string[] {
	const { needs, ok } = breakdown;
	if (needs.length === 0) return [];
	if (needs.length === 1 && ok.length === 0) return [`Why: ${needs[0].reason}.`];
	const lines = [`Needs approval: ${needs.map((n) => (n.segment === "" ? n.reason : `\`${n.segment}\` \u2014 ${n.reason}`)).join("; ")}`];
	if (ok.length > 0) {
		const shown = ok.slice(0, OK_LIMIT).join(", ");
		lines.push(`Already OK: ${shown}${ok.length > OK_LIMIT ? `, +${ok.length - OK_LIMIT} more` : ""}`);
	}
	return lines;
}

/**
 * Why the command isn't read-only: distinct reasons, at most `limit`
 * (empty when it is read-only). Simple commands `covered` by remembered
 * prefixes are left out, so the reasons name what still needs approval. `cwd` enables `cd <dir inside cwd>`; a
 * `cd` that changes directory combined with git is not read-only (git
 * would run that directory's hooks/config).
 */
export function readOnlyBlockers(command: string, cwd?: string, limit = 3, covered: readonly (readonly string[])[] = [], scratch?: string, fetchHosts?: readonly string[]): string[] {
	const sources = covered.length === 0 ? [] : [{ label: "covered", prefixes: covered, exact: [] }];
	const { problem, items, changesDirWithGit } = classifySegments(command, cwd, sources, scratch, fetchHosts);
	if (problem !== undefined) return [problem];
	const reasons = new Set<string>();
	for (const { blocker, reason, coveredBy } of items) if (blocker !== undefined && coveredBy === undefined) reasons.add(reason ?? blocker.reason);
	if (changesDirWithGit) reasons.add(CD_GIT_REASON);
	return [...reasons].slice(0, limit);
}

/** True when the command is read-only (see readOnlyBlockers). */
export function isReadOnlyCommand(command: string, cwd?: string, scratch?: string, fetchHosts?: readonly string[]): boolean {
	return readOnlyBlockers(command, cwd, 1, [], scratch, fetchHosts).length === 0;
}

// ---------------------------------------------------------------------------
// Deny / ask detection
// ---------------------------------------------------------------------------

/**
 * Every simple command in `command`, prefix-stripped (loose), including
 * commands inside `sh -c '<script>'` and `eval ...`. Falls back to a loose
 * split when the tokenizer rejects the command.
 */
function scanUnits(command: string, depth = 0): string[][] {
	const segments = command.length <= MAX_COMMAND_LENGTH ? tokenize(command) : null;
	const units: string[][] = [];
	let raw: string[][];
	if (segments !== null) {
		raw = segments.map((s) => s.argv);
	} else {
		// heredoc/here-string text is data, except when a shell reads it or bash expands substitutions in it
		const { text, feeds } = extractStdinFeeds(command);
		raw = looseUnits(text);
		if (depth < 4) for (const script of feedScripts(feeds)) units.push(...scanUnits(script, depth + 1));
	}
	for (const argv of raw) {
		const unit = stripPrefixes(argv, argv.map(() => false), false)?.argv ?? argv;
		if (unit.length === 0) continue;
		units.push(unit);
		if (depth >= 4) continue;
		const [root, ...args] = unit;
		if (SHELLS.has(basename(root))) {
			const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
			// the script is the first operand: options may follow -c (`bash -c -- 'x'`)
			let s = c + 1;
			while (c !== -1 && s < args.length && /^[-+]/.test(args[s])) {
				if (args[s] === "-o" || args[s] === "+o") s++;
				s++;
			}
			const script = c === -1 ? undefined : args[s];
			if (script !== undefined) units.push(...scanUnits(script, depth + 1));
		}
		if (root === "eval") units.push(...scanUnits(args.join(" "), depth + 1));
		if (root === "rtk") units.push(...rtkInnerUnits(args, depth));
	}
	return units;
}

/**
 * Every simple command in `command` (loose-stripped; includes `sh -c`,
 * `eval`, rtk-proxied and heredoc-substituted commands). For matching user
 * ask/deny rules, which only make things stricter.
 */
export function commandUnits(command: string): string[][] {
	return scanUnits(command);
}

/**
 * Commands proxied by rtk: `rtk git push` → `git push`, `rtk proxy cmd`
 * (also err/test/summary) → `cmd`, `rtk run "<script>"` → the script's
 * commands.
 */
function rtkInnerUnits(args: string[], depth: number): string[][] {
	const rest = args.slice(args.findIndex((a) => !a.startsWith("-")));
	if (rest.length === 0 || rest[0].startsWith("-")) return [];
	const [sub, ...subArgs] = rest;
	if (sub === "run") return scanUnits(subArgs.join(" "), depth + 1);
	if (RTK_RUNNERS.has(sub)) return subArgs.length > 0 ? scanUnits(subArgs.join(" "), depth + 1) : [];
	return [rest];
}

/** Flags of find/fd after which the next word is a command they execute. */
const EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-x", "-X", "--exec", "--exec-batch"]);

/**
 * Inner commands run by a command runner (`xargs git push`,
 * `find . -exec rm {} ;`). For find/fd only words after an exec flag; for
 * other runners the first two non-flag positions.
 */
function innerCommands(unit: string[]): string[][] {
	const [root, ...args] = unit;
	if (!COMMAND_RUNNERS.has(basename(root))) return [];
	if (root === "find" || root === "fd") {
		return args.flatMap((a, j) => (EXEC_FLAGS.has(a) && j + 1 < args.length ? [args.slice(j + 1)] : []));
	}
	const positions = args.flatMap((a, j) => (a.startsWith("-") ? [] : [j])).slice(0, 2);
	return positions.map((j) => args.slice(j)).filter((inner) => inner[0] !== root);
}

function isPrivilegedUnit(unit: string[], depth = 0): boolean {
	const root = basename(unit[0] ?? "");
	if (PRIVILEGE_COMMANDS.has(root)) return true;
	if (root === "rtk" && depth < 3) {
		const inner = rtkInnerUnits(unit.slice(1), depth).map((u) => stripPrefixes(u, u.map(() => false), false)?.argv ?? u);
		if (inner.some((u) => isPrivilegedUnit(u, depth + 1))) return true;
	}
	return innerCommands(unit).some((inner) => PRIVILEGE_COMMANDS.has(basename(inner[0] ?? "")));
}

/**
 * True when the command runs privilege escalation anywhere (sudo, su, doas,
 * pkexec, run0), including through a variable as the command when the
 * command names one (`x=sudo; $x ls`).
 */
export function isPrivilegedCommand(command: string): boolean {
	const units = scanUnits(command);
	if (units.some(isPrivilegedUnit)) return true;
	if (!units.some((unit) => (unit[0] ?? "").startsWith("$"))) return false;
	return looseUnits(command)
		.flat()
		.some((w) => PRIVILEGE_COMMANDS.has(basename(w.replace(ASSIGNMENT, ""))));
}

export interface PathContext {
	cwd: string;
	/** Per-session scratch dir: writable in every mode, not "outside the cwd", not protected. */
	scratchDir?: string;
	/** pi agent dir (~/.pi/agent); its contents are protected. */
	agentDir?: string;
	/** The session plan file; exempt from protected/outside-cwd checks. */
	planFile?: string;
	/** Realpaths of directories whose contents the user allowed reading for this session (outside-cwd reads only; secrets still ask). */
	outsideReadDirs?: readonly string[];
	/**
	 * Realpaths of the skill directories the model was told about (the
	 * `dirname` of each `<available_skills>` `<location>`): pi names those
	 * files as readable, so reading them is not an outside-cwd read. Secrets
	 * still ask.
	 */
	skillDirs?: readonly string[];
	/** Hosts the user allowed fetching from (session and project grants); no host is allowed by default. */
	fetchHosts?: readonly string[];
}

/**
 * `cwd` is the directory the unit runs in: the session cwd, changed by an
 * earlier `cd`/`pushd` in the same command, or undefined when that `cd`
 * can't be resolved (`cd "$X"`, `cd -`).
 */
function isDangerousUnit(unit: string[], ctx: PathContext, cwd: string | undefined, depth = 0): boolean {
	const [rootPath, ...args] = unit;
	if (rootPath === undefined) return false;
	// A variable as the command (`x=sudo; $x rm y`) hides what runs: ask
	if (rootPath.startsWith("$")) return true;
	const root = basename(rootPath);
	if (args.some((a) => SAFETY_OFF_FLAGS.has(a))) return true;
	if (root === "rm" || root === "rmdir") return isDangerousRm(args, ctx.cwd, cwd, ctx.scratchDir);
	if (root === "find" && args.includes("-delete")) return isDangerousFindDelete(args, ctx.cwd, cwd);
	if (DANGEROUS_ROOT_PREFIXES.some((p) => root.startsWith(p))) return true;
	if (DANGEROUS_COMMANDS[root]?.(args) === true) return true;
	// rtk proxies the command after it (`rtk kubectl apply`, `rtk git push`)
	if (root === "rtk" && depth < 3) {
		const inner = rtkInnerUnits(args, depth).map((u) => stripPrefixes(u, u.map(() => false), false)?.argv ?? u);
		if (inner.some((u) => isDangerousUnit(u, ctx, cwd, depth + 1))) return true;
	}
	if (depth < 3) return innerCommands(unit).some((inner) => isDangerousUnit(inner, ctx, cwd, depth + 1));
	return false;
}

/** Commands that change the shell's directory for the rest of the command. */
const DIR_CHANGERS = new Set(["cd", "pushd", "popd"]);

/** Directory after `cd`/`pushd`/`popd`; undefined when it can't be known. */
function changedDir(root: string, args: string[], cwd: string | undefined): string | undefined {
	if (root === "popd") return undefined;
	const operands = args.filter((a) => !a.startsWith("-") || a === "-");
	const target = operands[0] ?? (root === "cd" ? "~" : undefined);
	// `cd -`, `pushd +1`, bare `pushd` (swap), or an expansion
	if (target === undefined || target === "-" || /^\+|[$*?[{`]/.test(target)) return undefined;
	if (cwd === undefined && !/^[/~]/.test(target)) return undefined;
	return resolvePath(target, cwd ?? "/");
}

/** Root, a top-level dir, or home. */
function isCriticalPath(resolved: string): boolean {
	return resolved === "/" || dirname(resolved) === "/" || resolved === homedir();
}

/**
 * rm/rmdir targeting a critical path (Claude Code's list): `/`, top-level
 * dirs, home, the cwd or a parent, `*` at the cwd root, a glob under a
 * variable. Recursive deletes of variable targets or paths outside the cwd
 * also count. `rm -rf build` inside the cwd does not, and neither does a
 * literal target inside the session scratch dir (the dir itself still does).
 */
function isDangerousRm(args: string[], projectCwd: string, cwd: string | undefined, scratchDir?: string): boolean {
	let recursive = false;
	let endOfOptions = false;
	const targets: string[] = [];
	for (const a of args) {
		if (!endOfOptions && a === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && a.startsWith("-") && a !== "-") {
			if (a === "--recursive" || /^-[a-zA-Z]*[rR]/.test(a)) recursive = true;
			continue;
		}
		targets.push(a);
	}
	return targets.some((t) => {
		if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/\*?$/.test(t)) return true; // "$X"/* or "$X"/
		if (t.includes("$")) return recursive; // unresolvable target
		const target = t === "*" ? "." : t.endsWith("/*") ? t.slice(0, -2) || "/" : t;
		// relative target after a `cd` that can't be resolved
		if (cwd === undefined && !/^[/~]/.test(target)) return recursive;
		const resolved = resolvePath(target, cwd ?? "/");
		if (isCriticalPath(resolved)) return true;
		if (scratchDir !== undefined && isStrictlyInsideScratch(resolved, scratchDir)) return false;
		// the session cwd, the directory the command cd'ed into, or a parent of either
		const dirs = cwd === undefined ? [projectCwd] : [projectCwd, cwd];
		if (dirs.some((d) => resolved === resolve(d) || isInside(resolve(d), resolved))) return true;
		return recursive && !isInside(resolved, resolve(projectCwd));
	});
}

/**
 * `find <paths> -delete` starting at a critical path or outside the session
 * cwd. Filters make it narrower than `rm -rf`, so `find . -name '*.log'
 * -delete` inside the cwd is fine.
 */
function isDangerousFindDelete(args: string[], projectCwd: string, cwd: string | undefined): boolean {
	const end = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
	const paths = args.slice(0, end === -1 ? args.length : end);
	return (paths.length > 0 ? paths : ["."]).some((p) => {
		if (p.includes("$")) return true;
		if (cwd === undefined && !/^[/~]/.test(p)) return true;
		const resolved = resolvePath(p, cwd ?? "/");
		return isCriticalPath(resolved) || !isInside(resolved, resolve(projectCwd));
	});
}

/** Word that names a path, for protected-path detection in bash. */
function looksLikePath(word: string): boolean {
	return word.includes("/") || word.startsWith(".") || word.startsWith("~");
}

/**
 * True when the command looks dangerous (ask in default and auto):
 * DANGEROUS_COMMANDS, critical-path rm, safety-off flags, download-and-run,
 * and writes that name a protected path. Accident guard only.
 */
export function isDangerousCommand(command: string, ctx: PathContext): boolean {
	// heredoc/here-string text is data, except when a shell reads it or bash expands substitutions in it
	const { text, feeds } = extractStdinFeeds(command);
	if (feedScripts(feeds).some((script) => isDangerousCommand(script, ctx))) return true;
	if (DANGEROUS_RAW_PATTERNS.some((pattern) => pattern.test(text))) return true;
	const units = scanUnits(command);
	// units run in order: a `cd` changes where later relative paths point
	let cwd: string | undefined = ctx.cwd;
	for (const unit of units) {
		const root = basename(unit[0] ?? "");
		if (DIR_CHANGERS.has(root)) cwd = changedDir(root, unit.slice(1), cwd);
		else if (isDangerousUnit(unit, ctx, cwd)) return true;
	}
	if (WRITE_INDICATORS.test(text)) {
		const words = units.flat().concat(looseUnits(text).flat());
		if (words.some((w) => looksLikePath(w) && isProtectedPath(w, ctx))) return true;
	}
	return false;
}

/**
 * True when the command names a secret file anywhere (see isSecretFile),
 * directly or through a glob that can match a .env file (`.en*`, `.e[n]v`).
 */
export function isSecretCommand(command: string, ctx?: SecretContext): boolean {
	return scanUnits(command).some((unit) => unit.some((w) => isSecretFile(w, ctx) || globMatchesSecretFile(w)));
}

/** Commands whose arguments are not paths they read. */
const NON_READING_COMMANDS = new Set(["echo", "printf", "which", "type", "command", "true", "false"]);

/**
 * Existing paths outside the cwd that the command reads (`cat /etc/hosts`,
 * `ls ~`, `rg x ../other`, `--file=/x`, and `cd ../other && cat notes.md`).
 * Only words that look like paths (`/`, `~`, `..`) and exist on disk count,
 * so `rg '/api/v1'` doesn't.
 *
 * A `cd` target is not a read: changing directory is what the read-only
 * analysis calls a plain command, so the ask belongs to the fallback (where a
 * `cd` rule covers it) instead of the outside-reads gate, which only a
 * directory grant lifts. The commands run after the `cd` are still judged:
 * one running in a directory outside the cwd reads there whatever it names,
 * so that directory is reported for it.
 */
export function outsideCwdReadPaths(command: string, ctx: PathContext): string[] {
	const found = new Set<string>();
	// units run in order: a `cd` changes which directory later relative words name
	let cwd: string | undefined = ctx.cwd;
	for (const [root, ...args] of scanUnits(command)) {
		if (root === undefined) continue;
		const name = basename(root);
		if (DIR_CHANGERS.has(name)) {
			cwd = changedDir(name, args, cwd);
			continue;
		}
		if (NON_READING_COMMANDS.has(name)) continue;
		// the command runs outside the cwd (after a `cd`): the directory it reads in
		if (cwd !== undefined && !isSamePath(cwd, ctx.cwd, ctx.cwd) && isOutsideCwdRead(cwd, ctx)) found.add(cwd);
		for (const arg of args) {
			// $HOME is expanded first, so `$HOME/x` is judged like `~/x`; a `..` segment can climb out of the cwd anywhere in the word
			const value = expandHome(arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg);
			if (/^(\/|~|\.\.)|(^|\/)\.\.(\/|$)/.test(value) && isOutsideCwdRead(value, ctx)) found.add(value);
		}
	}
	return [...found];
}

/** Names of the files pi writes for the model to read back (`<prefix>-<16 hex>.<ext>`): truncated tool output, MCP resources, codemode output. */
const PI_OUTPUT_FILE = /^pi-(?:bash|powershell|output|mcp|codemode)-[0-9a-f]{16}\.[A-Za-z0-9]+$/;

/**
 * True for a file pi itself wrote for this user in the OS temp dir (the full
 * text of truncated output; see pi's output-files.ts): a direct child of the
 * temp dir with pi's generated name, a regular file (not a link) owned by the
 * current user. Anything else in the temp dir is someone else's.
 */
export function isPiOutputFile(resolved: string): boolean {
	try {
		if (!PI_OUTPUT_FILE.test(basename(resolved))) return false;
		const parent = dirname(resolved);
		if (parent !== tmpdir() && parent !== realpathSync(tmpdir())) return false;
		const info = lstatSync(resolved);
		return info.isFile() && (typeof process.getuid !== "function" || info.uid === process.getuid());
	} catch {
		return false;
	}
}

/**
 * The directory a read grant would cover for `path`: the realpath of the
 * directory itself, or of the parent for a file. Undefined when the path
 * doesn't exist, or the directory is too broad to grant ("/", the home dir
 * or one of its ancestors): those keep asking, or take the all-reads option.
 */
export function readGrantDir(path: string, cwd: string): string | undefined {
	try {
		const real = realpathSync(resolvePath(path, cwd));
		const dir = statSync(real).isDirectory() ? real : dirname(real);
		const home = realpathLoose(homedir());
		// "/", the home dir, and any ancestor of it (/home) are too broad
		if (dir === dirname(dir) || isInside(home, dir)) return undefined;
		return dir;
	} catch {
		return undefined;
	}
}

/**
 * A read outside the cwd that asks until the user allows them for the
 * session: an existing path, not the plan file, not /dev, not pi's agent dir
 * (skills and prompts are read from there; auth.json is a secret and asks
 * separately), not pi's own output files, and not inside a directory the user
 * granted (judged by realpath, so a link out of a granted dir isn't covered).
 */
export function isOutsideCwdRead(target: string, ctx: PathContext): boolean {
	if (!isOutsideCwd(target, ctx)) return false;
	const resolved = resolvePath(target, ctx.cwd);
	if (isInside(resolved, "/dev")) return false;
	if (ctx.agentDir !== undefined && isInside(resolved, resolve(ctx.agentDir))) return false;
	if (!existsSync(resolved)) return false;
	if (isPiOutputFile(resolved)) return false;
	if (ctx.outsideReadDirs !== undefined && ctx.outsideReadDirs.length > 0) {
		const real = realpathLoose(resolved);
		if (ctx.outsideReadDirs.some((dir) => isInside(real, dir))) return false;
	}
	if (ctx.skillDirs !== undefined && ctx.skillDirs.length > 0) {
		const real = realpathLoose(resolved);
		if (ctx.skillDirs.some((dir) => isInside(real, dir))) return false;
	}
	return true;
}

/**
 * The skill directories a system prompt names: every `<location>` of the
 * `<available_skills>` block pi adds (see `formatSkillsForPrompt` in pi), as
 * the realpath of its `dirname`. The model is told to read exactly those
 * files, so the directories holding them are not outside-cwd reads. Empty
 * when the prompt has no catalog (a child without inherited skills, a
 * parent with no skills installed).
 */
export function skillDirsFromPrompt(prompt: string): string[] {
	if (prompt === "" || !prompt.includes("<available_skills>")) return [];
	const start = prompt.indexOf("<available_skills>");
	const end = prompt.indexOf("</available_skills>", start);
	const block = end === -1 ? prompt.slice(start) : prompt.slice(start, end);
	const dirs: string[] = [];
	for (const match of block.matchAll(/<location>([\s\S]*?)<\/location>/g)) {
		const location = unescapeXmlText(match[1] ?? "").trim();
		if (location === "" || !location.startsWith("/")) continue;
		const dir = realpathLoose(dirname(location));
		if (!dirs.includes(dir)) dirs.push(dir);
	}
	return dirs;
}

/** Undo the five XML entities pi escapes in a skill's name, description and location. */
function unescapeXmlText(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/**
 * One write target of a shell command, judged for the artifact-dir exemption:
 * a literal word (no `$`, glob, brace, `~user`, `..`), resolving by realpath of
 * the nearest existing ancestor inside a pi-subagents artifact dir, and not a
 * secret file. Same strictness as targetProblem, which is why unresolvable
 * targets are refused rather than excused.
 */
function targetIsArtifactLiteral(target: Target, ctx: PathContext, dir: string | null | undefined): boolean {
	const word = target.word;
	if (target.remote === true || target.glob || word === "" || /[$`*?[{]/.test(word)) return false;
	if (word.startsWith("~") && !word.startsWith("~/")) return false; // ~user
	if (/(^|\/)\.\.(\/|$)/.test(word)) return false; // symlinks make `a/../b` unknowable
	const where = dir === null ? undefined : (dir ?? ctx.cwd);
	if (where === undefined && !/^[/~]/.test(word)) return false;
	const resolved = resolvePath(word, where ?? "/");
	const real = realpathLoose(resolved);
	if (!isInsideSubagentArtifactDir(resolved, ctx) || !isInsideSubagentArtifactDir(real, ctx)) return false;
	return !isSecretFile(resolved, ctx) && !isSecretFile(real, ctx);
}

/**
 * True when the segment only moves into an artifact dir (`cd <artifact dir>`):
 * it writes nothing, and the segments after it resolve their targets there.
 * Any other segment that is neither read-only nor a write is refused.
 */
function isArtifactDirChange(segment: Segment, ctx: PathContext, dir: string | null | undefined): boolean {
	if (!DIR_CHANGERS.has(basename(segment.argv[0] ?? ""))) return false;
	const operands = segment.argv.slice(1).filter((word) => !word.startsWith("-"));
	if (operands.length === 0) return false; // a bare `cd` goes home
	return operands.every((word) => targetIsArtifactLiteral({ word, glob: false }, ctx, dir));
}

/**
 * True when every write a shell command makes lands inside a pi-subagents
 * artifact dir and the command deletes nothing: the shape a child uses to
 * create its own report directory (`mkdir -p .../outputs/<id> && echo ok`,
 * `touch .../outputs/<id>/context.md`). Read-only commands and a `cd` into the
 * artifact dir mixed in are fine; one target that can't be checked, one
 * deletion, or nothing written at all makes it false, so the mode's ask stays.
 */
export function bashWritesInsideArtifactDirs(command: string, ctx: PathContext): boolean {
	const trimmed = command.trim();
	if (trimmed === "" || trimmed.length > MAX_COMMAND_LENGTH) return false;
	if (hasRemoval(trimmed)) return false;
	const tokens = tokenize(maskForAnalysis(trimmed, ctx.scratchDir), ctx.scratchDir);
	if (tokens === null) return false;
	const dirs = segmentDirs(tokens, ctx.cwd);
	let wrote = false;
	for (const [k, segment] of tokens.entries()) {
		if (REMOVERS.has(basename(segment.argv[0] ?? ""))) return false;
		const blocker = segmentBlocker(segment, ctx.cwd, ctx.scratchDir);
		if (blocker === undefined) continue; // read-only: nothing to judge
		if (blocker.effect === "write") {
			if (!Array.isArray(blocker.targets) || blocker.targets.length === 0) return false;
			for (const target of blocker.targets) {
				if (HARMLESS_DEVICES.has(target.word)) continue;
				if (!targetIsArtifactLiteral(target, ctx, dirs[k])) return false;
				wrote = true;
			}
			continue;
		}
		// neither read-only nor a write: only a `cd` into an artifact dir passes
		if (!isArtifactDirChange(segment, ctx, dirs[k])) return false;
	}
	return wrote;
}

/**
 * Literal write targets outside the cwd and the scratch dir that a shell
 * command names (write-effect commands and FILE_WRITERS: `cp x ~/foo`,
 * `sed -i s/a/b/ /etc/hosts`). Unresolvable targets (`$OUT`, globs) are not
 * listed: auto mode is an accident guard and stays permissive for them.
 */
export function outsideCwdBashWrites(command: string, ctx: PathContext): string[] {
	const trimmed = command.trim();
	if (trimmed === "" || trimmed.length > MAX_COMMAND_LENGTH) return [];
	const tokens = tokenize(maskForAnalysis(trimmed, ctx.scratchDir), ctx.scratchDir);
	if (tokens === null) return [];
	const dirs = segmentDirs(tokens, ctx.cwd);
	const found: string[] = [];
	for (const [k, segment] of tokens.entries()) {
		const blocker = segmentBlocker(segment, ctx.cwd, ctx.scratchDir);
		if (blocker?.effect !== "write" || !Array.isArray(blocker.targets)) continue;
		for (const target of blocker.targets) {
			if (targetProblem(target, ctx.cwd, dirs[k], ctx.scratchDir) === "outside") found.push(target.word);
		}
	}
	return found;
}

/**
 * Every simple command of `command` with the directory it runs in (the
 * session cwd, moved by earlier `cd`/`pushd`; undefined after one that can't
 * be resolved), like isDangerousCommand walks them.
 */
function unitsWithDirs(command: string, ctx: PathContext): Array<{ unit: string[]; dir: string | undefined }> {
	let dir: string | undefined = ctx.cwd;
	const out: Array<{ unit: string[]; dir: string | undefined }> = [];
	for (const unit of scanUnits(command)) {
		const root = basename(unit[0] ?? "");
		if (DIR_CHANGERS.has(root)) dir = changedDir(root, unit.slice(1), dir);
		else out.push({ unit, dir });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Destructive commands aimed outside the project (auto mode asks)
// ---------------------------------------------------------------------------

/** Commands that delete what their operands name. */
const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred"]);

/** The operands of a command line: words that aren't flags, and everything after `--`. */
function operandsOf(args: readonly string[]): string[] {
	const out: string[] = [];
	let end = false;
	for (const a of args) {
		if (!end && a === "--") end = true;
		else if (end || a === "-" || !a.startsWith("-")) out.push(a);
	}
	return out;
}

/**
 * Whether a destructive command's target word is outside the project: a
 * literal path outside the cwd and the scratch dir, a protected path, or a
 * word that can't be resolved (`$X`, a relative path after an unresolvable
 * `cd`). A glob is judged by the directory in front of it (`/tmp/x/*` is
 * `/tmp/x`, `*.o` is the cwd). Unlike the write rule, unresolvable counts:
 * deleting the wrong thing can't be undone.
 */
function destructiveOutside(word: string, ctx: PathContext, dir: string | undefined): boolean {
	if (/[$`]/.test(word)) return true;
	let path = word;
	const glob = path.search(/[*?[{]/);
	if (glob !== -1) {
		const slash = path.lastIndexOf("/", glob);
		path = slash === -1 ? "." : slash === 0 ? "/" : path.slice(0, slash);
	}
	const problem = targetProblem({ word: path, glob: false }, ctx.cwd, dir === undefined ? null : dir, ctx.scratchDir);
	return problem === "unchecked" || problem === "outside" || problem === "protected";
}

/** Git subcommands that overwrite or discard work (`reset` only with --hard, `stash` only drop/clear). */
function isDestructiveGit(sub: string | undefined, rest: readonly string[]): boolean {
	if (sub === "checkout" || sub === "restore" || sub === "clean") return true;
	if (sub === "reset") return rest.includes("--hard");
	return sub === "stash" && (rest[0] === "drop" || rest[0] === "clear");
}

/**
 * The directories a destructive git command acts on: where it runs, moved by
 * `-C <dir>` (repeatable), plus `--git-dir` / `--work-tree`. undefined entries
 * can't be resolved. Empty when the command isn't destructive.
 */
function gitDestructiveDirs(args: readonly string[], dir: string | undefined): Array<string | undefined> {
	const dirs: Array<string | undefined> = [];
	let where = dir;
	const resolveIn = (value: string, base: string | undefined): string | undefined =>
		/[$*?[{`]/.test(value) || (base === undefined && !/^[/~]/.test(value)) ? undefined : resolvePath(value, base ?? "/");
	let i = 0;
	for (; i < args.length && args[i].startsWith("-"); i++) {
		const a = args[i];
		const eq = a.startsWith("--") ? a.indexOf("=") : -1;
		const flag = eq === -1 ? a : a.slice(0, eq);
		const takesValue = flag === "-C" || flag === "-c" || flag === "--git-dir" || flag === "--work-tree" || flag === "--namespace" || flag === "--exec-path";
		const value = eq !== -1 ? a.slice(eq + 1) : takesValue ? args[++i] : undefined;
		if (flag === "-C") where = value === undefined ? undefined : resolveIn(value, where);
		else if (flag === "--git-dir" || flag === "--work-tree") dirs.push(value === undefined ? undefined : resolveIn(value, where));
	}
	if (!isDestructiveGit(args[i], args.slice(i + 1))) return [];
	return [where, ...dirs];
}

/**
 * Targets of deleting or overwriting commands that are outside the project
 * (see destructiveOutside), for auto mode's "asks every time" rule:
 * `rm`/`rmdir`/`unlink`/`shred` operands, `find … -delete` and `-exec rm`
 * start paths, `truncate` operands, the sources of `mv`, and git
 * `checkout`/`restore`/`clean`/`reset --hard`/`stash drop|clear` aimed at
 * another directory (`-C`, or after a `cd`). Unknown targets (an unlisted
 * flag of `mv`/`truncate`) are listed as "(targets unknown)". Inside the
 * project nothing matches: auto stays permissive there. `dd of=` and the
 * critical-path cases are already dangerous commands.
 */
export function outsideDestructiveTargets(command: string, ctx: PathContext): string[] {
	const found: string[] = [];
	const check = (word: string, dir: string | undefined): void => {
		if (destructiveOutside(word, ctx, dir)) found.push(word);
	};
	for (const { unit, dir } of unitsWithDirs(command, ctx)) {
		const name = basename(unit[0] ?? "");
		const args = unit.slice(1);
		if (REMOVERS.has(name)) {
			for (const word of operandsOf(args)) check(word, dir);
		} else if (name === "find") {
			const execs = args.flatMap((a, j) => (EXEC_FLAGS.has(a) ? [basename(args[j + 1] ?? "")] : []));
			if (!args.includes("-delete") && !execs.some((c) => REMOVERS.has(c) || c === "truncate" || c === "mv")) continue;
			const stop = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
			const paths = args.slice(0, stop === -1 ? args.length : stop);
			for (const word of paths.length > 0 ? paths : ["."]) check(word, dir);
		} else if (name === "truncate" || name === "mv") {
			const targets = fileWriterTargets(name, args, args.map(() => false));
			if (targets === null) {
				found.push("(targets unknown)");
				continue;
			}
			// mv removes its sources; its destination is a write, which auto leaves to the write rule
			const sources = name === "truncate" ? targets : targets.some((t) => t.dir === true) ? targets.filter((t) => t.dir !== true) : targets.slice(0, -1);
			for (const t of sources) check(t.word, dir);
		} else if (name === "git") {
			for (const gitDir of gitDestructiveDirs(args, dir)) {
				if (gitDir === undefined) found.push("(git directory unknown)");
				else if (destructiveOutside(gitDir, ctx, ctx.cwd)) found.push(gitDir);
			}
		}
	}
	return found;
}

// ---------------------------------------------------------------------------
// Searches that reach secret files
// ---------------------------------------------------------------------------

/**
 * How deep and how wide a recursive search is scanned for secret files; hitting
 * either asks. Generous enough for a real project tree (a benchmark suite with
 * demo apps is tens of thousands of files), bounded so a search over `/` or the
 * home directory still gives up quickly instead of walking the disk.
 */
const SEARCH_SCAN_DEPTH = 16;
const SEARCH_SCAN_ENTRIES = 200_000;
/** Directories the scan skips: huge, and not where secrets live. Dependencies, virtualenvs and build output; a project's own source stays scanned. */
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "__pycache__", "site-packages", "dist", "build", "target", ".gradle", ".next", ".cache"]);

type SearchKind = "grep" | "rg" | "fd" | "rtkgrep";

/** Options of search tools that take a value (short letters; long names), so their value isn't taken for a path or the pattern. */
const SEARCH_VALUES: Record<SearchKind, { short: string; longs: string[] }> = {
	grep: { short: "efmABCdD", longs: ["regexp", "file", "max-count", "after-context", "before-context", "context", "directories", "devices", "include", "exclude", "exclude-from", "exclude-dir", "label", "binary-files"] },
	rg: { short: "efgtTmABCjMEdr", longs: ["regexp", "file", "glob", "iglob", "type", "type-not", "type-add", "type-clear", "max-count", "after-context", "before-context", "context", "threads", "max-columns", "encoding", "max-depth", "replace", "sort", "sortr", "colors", "engine", "pre", "pre-glob", "path-separator", "ignore-file", "max-filesize", "hostname-bin"] },
	// rtk grep: its own -l/-m/-t, then ripgrep's extra args; -r and -R are not rg's --replace here but a grep habit
	rtkgrep: { short: "lmtefgABCjMEd", longs: ["max-len", "max", "file-type", "regexp", "file", "glob", "iglob", "type", "type-not", "max-count", "after-context", "before-context", "context", "threads", "max-depth", "sort", "sortr", "engine", "pre", "ignore-file", "max-filesize"] },
	fd: { short: "dtecEjSox", longs: ["max-depth", "type", "extension", "exclude", "threads", "size", "owner", "color", "changed-within", "changed-before", "search-path"] },
};

interface SearchScan {
	/** Searches directories recursively (`grep -r`, `rtk grep -r`). */
	recursive: boolean;
	/** Looks at hidden or git-ignored files (`--hidden`, `-u`, `--no-ignore`). */
	unrestricted: boolean;
	/** Paths searched; "." when none were given. */
	roots: string[];
	includes: string[];
	excludes: string[];
	excludeDirs: string[];
}

/** Flags, pattern and paths of one grep / rg / fd / rtk grep command line. */
function scanSearch(kind: SearchKind, args: readonly string[]): SearchScan {
	const values = SEARCH_VALUES[kind];
	const scan: SearchScan = { recursive: false, unrestricted: false, roots: [], includes: [], excludes: [], excludeDirs: [] };
	const operands: string[] = [];
	let patternFlag = false;
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (a === "--") {
			operands.push(...args.slice(k + 1));
			break;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = (eq === -1 ? a : a.slice(0, eq)).slice(2);
			const takesValue = values.longs.includes(name);
			const value = eq !== -1 ? a.slice(eq + 1) : takesValue ? args[k + 1] : undefined;
			if (takesValue && eq === -1) k++;
			if (name === "recursive" || (name === "directories" && value === "recurse")) scan.recursive = true;
			if (name === "hidden" || name === "unrestricted" || name.startsWith("no-ignore")) scan.unrestricted = true;
			if (name === "regexp" || name === "file" || name === "files") patternFlag = true;
			if (value !== undefined && kind === "grep") {
				if (name === "include") scan.includes.push(value);
				else if (name === "exclude") scan.excludes.push(value);
				else if (name === "exclude-dir") scan.excludeDirs.push(value);
			}
		} else if (a.startsWith("-") && a !== "-") {
			for (let c = 1; c < a.length; c++) {
				const ch = a[c];
				if ((kind === "grep" || kind === "rtkgrep") && (ch === "r" || ch === "R")) scan.recursive = true;
				if (kind === "grep" && ch === "d" && (a.slice(c + 1) || args[k + 1]) === "recurse") scan.recursive = true;
				if (ch === "u" || (ch === "." && kind !== "grep") || (kind === "fd" && (ch === "H" || ch === "I"))) scan.unrestricted = true;
				if ((ch === "e" || ch === "f") && kind !== "fd") patternFlag = true;
				if (values.short.includes(ch)) {
					if (c === a.length - 1) k++;
					break;
				}
			}
		} else operands.push(a);
	}
	// the first operand is the pattern, unless -e/-f/--files gave it
	if (!patternFlag) operands.shift();
	scan.roots = operands.length > 0 ? operands : ["."];
	return scan;
}

/** What makes a recursive search ask: a secret file it can reach, or something that can't be checked. */
export interface SearchHit {
	path: string;
	why: "secret" | "unchecked" | "limit";
}

/** A glob pattern matched against a file name; null patterns match everything (fail closed). */
function globMatches(glob: string, name: string): boolean {
	return globToRegExp(glob)?.test(name) ?? true;
}

/**
 * How many "tracked by git" answers are cached (the check is one git process per file).
 */
const TRACKED_CACHE_LIMIT = 200;
const trackedFiles = new Map<string, boolean>();

/**
 * True when git tracks `file` in the repository that holds it. That is how a
 * committed fixture (a demo certificate, a template `.env`) is told from a
 * credential the user keeps next to it: `git -C <its dir> ls-files
 * --error-unmatch -- <name>` resolves the enclosing repository, so a file in
 * a submodule is judged by the submodule. No git, no repository, an error or
 * a timeout all answer false, so the search still asks.
 */
function isTrackedFile(file: string): boolean {
	const cached = trackedFiles.get(file);
	if (cached !== undefined) return cached;
	let tracked = false;
	try {
		// the file's own name, from its own directory: no pattern a shell could expand
		const result = spawnSync("git", ["-C", dirname(file), "ls-files", "--error-unmatch", "--", basename(file)], { stdio: "ignore", timeout: 5_000, windowsHide: true });
		tracked = result.status === 0;
	} catch {
		tracked = false;
	}
	if (trackedFiles.size >= TRACKED_CACHE_LIMIT) trackedFiles.clear();
	trackedFiles.set(file, tracked);
	return tracked;
}

/**
 * Secret files a search would read that the user did not commit: a file git
 * tracks in the searched project is repository content (a fixture, a template),
 * and searching it is what working in that project means. A file git does not
 * track stays a reason to ask, and so does every secret in a tree the user may
 * not read: outside the cwd and outside the granted read directories.
 */
function uncommittedSecrets(secrets: readonly string[], readable: boolean): string[] {
	return readable ? secrets.filter((file) => !isTrackedFile(file)) : [...secrets];
}

/**
 * Secret files under `root` (see isSecretFile), a bounded walk: at most
 * SEARCH_SCAN_DEPTH levels and SEARCH_SCAN_ENTRIES entries, skipping `.git`,
 * `node_modules` and the dependency/vendor directories in SEARCH_SKIP_DIRS,
 * and symlinks. `limit` is set when a bound was hit: the tree can't be ruled
 * out.
 */
function secretFilesUnder(root: string, ctx: PathContext, scan: SearchScan): { secrets: string[]; limit: boolean } {
	const secrets: string[] = [];
	const sctx = { cwd: ctx.cwd, agentDir: ctx.agentDir };
	const fileOk = (name: string): boolean =>
		(scan.includes.length === 0 || scan.includes.some((g) => globMatches(g, name))) && !scan.excludes.some((g) => globMatches(g, name));
	let entries = 0;
	let limit = false;
	const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	while (stack.length > 0 && secrets.length < 3) {
		const { dir, depth } = stack.pop() as { dir: string; depth: number };
		let listing;
		try {
			listing = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of listing) {
			if (++entries > SEARCH_SCAN_ENTRIES) return { secrets, limit: true };
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SEARCH_SKIP_DIRS.has(entry.name) || scan.excludeDirs.some((g) => globMatches(g, entry.name))) continue;
				if (depth + 1 > SEARCH_SCAN_DEPTH) limit = true;
				else stack.push({ dir: full, depth: depth + 1 });
			} else if (entry.isFile() && fileOk(entry.name) && isSecretFile(full, sctx)) secrets.push(full);
		}
	}
	return { secrets, limit };
}

/** The paths a root word stands for: itself, or for a glob its directory-level matches (what the shell would pass). */
function expandSearchRoot(word: string, dir: string): string[] {
	const glob = word.search(/[*?[{]/);
	if (glob === -1) return [resolvePath(word, dir)];
	const slash = word.lastIndexOf("/", glob);
	const prefix = resolvePath(slash === -1 ? "." : slash === 0 ? "/" : word.slice(0, slash), dir);
	const last = word.slice(slash + 1);
	const pattern = /[/{]/.test(last) ? null : globToRegExp(last);
	if (pattern === null) return [prefix]; // glob in a directory name, or a brace: search the whole prefix
	try {
		return readdirSync(prefix)
			.filter((name) => pattern.test(name) && (!name.startsWith(".") || last.startsWith(".")))
			.map((name) => join(prefix, name));
	} catch {
		return [prefix];
	}
}

/**
 * Secret files a recursive search in `command` can reach, for the
 * `secretSearch` ask (every mode, beating any allow). Searches that count:
 * - `grep -r`/`-R`/`--recursive` (and egrep/fgrep): hidden files included;
 * - `rg`, `rtk rg` and `fd` with `--hidden`, `-u`/`-uu`/`-uuu`, `--no-ignore`:
 *   plain `rg` skips dotfiles and git-ignored files by default (ripgrep's
 *   `--hidden` docs: "hidden files and directories are skipped"), so a `.env`
 *   stays unread and a plain `rg KEY` is silent;
 * - `rtk grep` with `-r`/`-R`/`--recursive` or those rg flags. A plain
 *   `rtk grep KEY .` runs ripgrep, which skips dotfiles like plain `rg`
 *   (checked with rtk 0.42: `.env` is not read), so it is silent; with `-r`
 *   rtk does read `.env`.
 * The walk is bounded (see secretFilesUnder); a bound hit, or a search path
 * that can't be resolved (`$DIR`, a relative path after an unresolvable
 * `cd`), fails closed. A named file (`grep -r x .env`) is secretBash's job.
 */
export function secretSearchHits(command: string, ctx: PathContext): SearchHit[] {
	const hits: SearchHit[] = [];
	const shown = (path: string): string => {
		const rel = relative(ctx.cwd, path);
		return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) ? rel : path;
	};
	for (const { unit, dir } of unitsWithDirs(command, ctx)) {
		const viaRtk = basename(unit[0] ?? "") === "rtk";
		let name = basename(unit[0] ?? "");
		let args = unit.slice(1);
		if (viaRtk) {
			const at = args.findIndex((a) => !RTK_DISPLAY_FLAGS.test(a));
			name = args[at] ?? "";
			args = at === -1 ? [] : args.slice(at + 1);
		}
		let kind: SearchKind | undefined;
		if (name === "grep") kind = viaRtk ? "rtkgrep" : "grep";
		else if (name === "egrep" || name === "fgrep") kind = viaRtk ? undefined : "grep";
		else if (name === "rg") kind = "rg";
		else if (name === "fd" || name === "fdfind") kind = viaRtk ? undefined : "fd";
		if (kind === undefined) continue;
		const scan = scanSearch(kind, args);
		const roots = scan.roots.flatMap((word): Array<string | undefined> => {
			if (/[$`]/.test(word) || (dir === undefined && !/^[/~]/.test(word))) return [undefined];
			return expandSearchRoot(word, dir ?? "/");
		});
		const triggers = kind === "grep" ? scan.recursive : kind === "rtkgrep" ? scan.recursive || scan.unrestricted : scan.unrestricted;
		if (!triggers) continue;
		for (const root of roots) {
			if (root === undefined) {
				hits.push({ path: "(search path)", why: "unchecked" });
				continue;
			}
			const { secrets, limit } = secretFilesUnder(root, ctx, scan);
			// a committed fixture under a directory this session may read is repository content, not the user's credential
			const real = realpathLoose(resolve(root));
			const readable = isInside(real, resolve(ctx.cwd)) || (ctx.outsideReadDirs ?? []).some((dir) => isInside(real, dir));
			for (const secret of uncommittedSecrets(secrets, readable)) hits.push({ path: shown(secret), why: "secret" });
			if (limit && secrets.length === 0) hits.push({ path: shown(root), why: "limit" });
		}
	}
	return hits;
}

// ---------------------------------------------------------------------------
// Uploads of secret files
// ---------------------------------------------------------------------------

/** Files a curl command line sends: `-d @f`, `--data-binary @f`, `--data-urlencode name@f`, `-F name=@f` / `name=<f`, `-T f`. */
function curlUploadFiles(args: readonly string[]): string[] {
	const files: string[] = [];
	const spec = OUTPUT_WRITERS.curl;
	const fromData = (v: string): void => {
		if (v.startsWith("@")) files.push(v.slice(1));
	};
	const fromUrlencode = (v: string): void => {
		const m = /^[^=@]*@(.+)$/.exec(v);
		if (m !== null) files.push(m[1]);
	};
	const fromForm = (v: string): void => {
		const m = /^[^=]*=[@<]([^;]*)/.exec(v) ?? /^[@<]([^;]*)/.exec(v);
		if (m !== null) files.push(m[1], ...m[1].split(","));
	};
	const take = (flag: string, value: string): void => {
		if (flag === "d" || /^(data|data-raw|data-binary|data-ascii|json)$/.test(flag)) fromData(value);
		else if (flag === "data-urlencode") fromUrlencode(value);
		else if (flag === "F" || flag === "form") fromForm(value);
		else if (flag === "T" || flag === "upload-file") files.push(value);
	};
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = (eq === -1 ? a : a.slice(0, eq)).slice(2);
			const takesValue = spec.valueLongs.includes(name) || spec.outLongs.includes(name);
			const value = eq !== -1 ? a.slice(eq + 1) : takesValue ? args[++k] : undefined;
			if (value !== undefined) take(name, value);
		} else if (a.startsWith("-") && a !== "-") {
			for (let c = 1; c < a.length; c++) {
				const ch = a[c];
				if (spec.valueFlags.includes(ch) || spec.outFlags.includes(ch)) {
					const rest = a.slice(c + 1);
					const value = rest !== "" ? rest : args[++k];
					if (value !== undefined) take(ch, value);
					break;
				}
			}
		}
	}
	return files;
}

/** Files a wget command line sends: `--post-file`, `--body-file`. */
function wgetUploadFiles(args: readonly string[]): string[] {
	const files: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const m = /^--(post-file|body-file)(?:=(.*))?$/.exec(args[k]);
		if (m === null) continue;
		const value = m[2] ?? args[++k];
		if (value !== undefined) files.push(value);
	}
	return files;
}

/**
 * Secret files (isSecretFile, or a glob that can match a .env) that a curl or
 * wget command uploads (`curl -d @.env URL`, `-F f=@key.pem`, `-T id_rsa`,
 * `wget --post-file=.env`; also through `rtk curl`). For the `secretUpload`
 * ask in every mode, auto included. Uploads of other files are untouched.
 */
export function secretUploads(command: string, ctx: PathContext): string[] {
	const found: string[] = [];
	for (const { unit, dir } of unitsWithDirs(command, ctx)) {
		const name = basename(unit[0] ?? "");
		const files = name === "curl" ? curlUploadFiles(unit.slice(1)) : name === "wget" ? wgetUploadFiles(unit.slice(1)) : [];
		for (const file of files) {
			const path = expandHome(file);
			if (isSecretFile(path, { cwd: dir, agentDir: ctx.agentDir }) || globMatchesSecretFile(path)) found.push(file);
		}
	}
	return found;
}

const SECRET_FILE_SAMPLES = [".env", ".env.local", ".env.development", ".env.production", ".env.test"];

/** A glob whose basename can match a .env file. Leading `*`/`?`/`[` never match dotfiles. */
function globMatchesSecretFile(word: string): boolean {
	const name = basename(word);
	if (!name.startsWith(".") || !/[*?[]/.test(name)) return false;
	const pattern = globToRegExp(name);
	return pattern !== null && SECRET_FILE_SAMPLES.some((sample) => pattern.test(sample));
}

function globToRegExp(glob: string): RegExp | null {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") source += ".*";
		else if (ch === "?") source += ".";
		else if (ch === "[" && glob.indexOf("]", i + 2) !== -1) {
			const end = glob.indexOf("]", i + 2);
			const set = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
			source += `[${set}]`;
			i = end;
		} else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	try {
		return new RegExp(`^${source}$`);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Remembered command prefixes ("Yes, and always allow <command>")
// ---------------------------------------------------------------------------

/**
 * Prefixes to remember for "Yes, and always allow" — one per simple command that
 * is not already read-only (`rtk grep x && npm test` → [["npm","test"]]).
 * undefined when remembering must not be offered: unparseable commands,
 * removals (`rm`, `git rm`), interpreters/runners (a remembered `python`
 * or `find` allows anything), privilege escalation, dangerous commands, a
 * multi-command tool with no subcommand (or flags before it), or a runner
 * script that is an interpreter. Also undefined for an exec-effect segment
 * and for a write-effect one (`sed -i`, `cp`, `tee`) with a target that is
 * outside the project or can't be checked: the rule would never cover it.
 */
export function deriveCommandPrefixes(command: string, ctx: PathContext): string[][] | undefined {
	const trimmed = command.trim();
	if (trimmed.length > MAX_COMMAND_LENGTH) return undefined;
	const tokens = tokenize(maskForAnalysis(trimmed, ctx.scratchDir), ctx.scratchDir);
	if (tokens === null) return undefined;
	const segments = normalizeGitSegments(tokens, ctx.cwd);
	const dirs = segmentDirs(tokens, ctx.cwd);
	const prefixes: string[][] = [];
	for (const [k, segment] of segments.entries()) {
		const blocker = segmentBlocker(segment, ctx.cwd, ctx.scratchDir);
		if (blocker === undefined) continue;
		// exec can't be covered; a write is offered only when this call's targets stay in the project
		if (blocker.effect === "exec" || writeProblem(blocker, ctx.cwd, dirs[k], ctx.scratchDir) !== undefined) return undefined;
		const stripped = stripPrefixes(segment.argv, segment.globs, true);
		if (stripped === null || stripped.argv.length === 0) return undefined;
		if (isDangerousUnit(stripped.argv, ctx, ctx.cwd) || isPrivilegedUnit(stripped.argv)) return undefined;
		const prefix = prefixFor(stripped.argv);
		if (prefix === undefined) return undefined;
		if (!prefixes.some((p) => p.join(" ") === prefix.join(" "))) prefixes.push(prefix);
	}
	return prefixes.length > 0 ? prefixes : undefined;
}

/** Label suffix for rules that only cover writes inside the project. */
const INSIDE_ONLY = " (inside the project only)";

/**
 * " (inside the project only)" when a segment of `command` that needs a rule
 * writes files (write effect: `sed -i`, `sort -o`, `cp`, `tee`, ...), else
 * "": such a rule covers it only while every target stays in the project.
 */
export function scopeSuffix(command: string, ctx: PathContext): string {
	const tokens = tokenize(maskForAnalysis(command.trim(), ctx.scratchDir), ctx.scratchDir);
	if (tokens === null) return "";
	return normalizeGitSegments(tokens, ctx.cwd).some((segment) => segmentBlocker(segment, ctx.cwd, ctx.scratchDir)?.effect === "write") ? INSIDE_ONLY : "";
}

/** One choice of the "different command pattern" picker. */
export interface PatternChoice {
	label: string;
	/** Canonical tokens; with `exact` the whole command must equal them, else they are a prefix. */
	tokens: string[];
	exact: boolean;
}

/** Words that survive a round trip through a `Bash(...)` rule: no whitespace, quotes, expansion or wildcards. */
const RULE_SAFE_WORD = /^[^\s;&|<>()$`"'\\*?[\]{}]+$/;

/**
 * Patterns the user may pick for the one simple command that needs approval,
 * narrowest first: the exact command (the only flag-level choice; prefix
 * matching on flags is unsound: `tsc --noEmit *` would cover `--outDir x`),
 * then token prefixes from the arity prefix down to the root. Prefixes hold
 * no flags and pass isRememberablePrefix; a shorter prefix whose next token
 * runs programs (`npm *` for `npm run build`) is left out. Shorter than the
 * arity prefix is marked `(broad)`. undefined when the command is compound
 * (several segments need approval), can't be remembered (see
 * deriveCommandPrefixes), or never covered: exec-effect (`sed -f`) or a
 * write whose targets leave the project (`sed -i … /etc/hosts`). Labels of
 * write commands end in " (inside the project only)".
 */
export function patternLadder(command: string, ctx: PathContext): PatternChoice[] | undefined {
	const derived = deriveCommandPrefixes(command, ctx);
	if (derived === undefined || derived.length !== 1) return undefined;
	const trimmed = command.trim();
	const tokens = tokenize(maskForAnalysis(trimmed, ctx.scratchDir), ctx.scratchDir);
	if (tokens === null) return undefined;
	const dirs = segmentDirs(tokens, ctx.cwd);
	const needing = normalizeGitSegments(tokens, ctx.cwd).flatMap((segment, k) => (isReadOnlySegment(segment, ctx.cwd, ctx.scratchDir) ? [] : [{ segment, dir: dirs[k] }]));
	if (needing.length !== 1) return undefined;
	const blocker = segmentBlocker(needing[0].segment, ctx.cwd, ctx.scratchDir);
	const stripped = stripPrefixes(needing[0].segment.argv, needing[0].segment.globs, true);
	if (stripped === null || blocker?.effect === "exec" || (blocker !== undefined && writeProblem(blocker, ctx.cwd, needing[0].dir, ctx.scratchDir) !== undefined)) return undefined;
	const suffix = blocker?.effect === "write" ? INSIDE_ONLY : "";
	const argv = canonicalize(stripped.argv);
	const globs = stripped.globs.slice(stripped.argv.length - argv.length);
	const prefix = canonicalize(derived[0]);
	const choices: PatternChoice[] = [];
	if (argv.every((w, k) => RULE_SAFE_WORD.test(w) && globs[k] !== true) && isRememberableExact(argv)) {
		choices.push({ label: `\`${argv.join(" ")}\` (exactly)${suffix}`, tokens: argv, exact: true });
	}
	for (let len = prefix.length; len >= 1; len--) {
		const candidate = prefix.slice(0, len);
		if (len < prefix.length && RUNNER_SUBCOMMANDS.has(prefix[len])) continue;
		if (candidate.some((t) => t.startsWith("-") || !RULE_SAFE_WORD.test(t)) || !isRememberablePrefix(candidate)) continue;
		choices.push({ label: `\`${candidate.join(" ")} *\`${len < prefix.length ? " (broad)" : ""}${suffix}`, tokens: candidate, exact: false });
	}
	return choices.length > 0 ? choices : undefined;
}

/**
 * The token form an exact rule for `command` needs (the same form
 * isCoveredSegment compares against): the one segment needing approval,
 * stripped of safe wrappers and canonicalized. Undefined when no single
 * exact rule can cover the command: it is compound (several segments need
 * approval), can't be tokenized, has an exec effect, its writes leave the
 * project, or a token can't appear in a rule body (a quoted argument with
 * spaces). Whether the tokens also pass the rule-file checks
 * (isRememberableExact, the body regex) is parseRule's call.
 */
export function exactRuleTokens(command: string, ctx: PathContext): string[] | undefined {
	const trimmed = command.trim();
	if (trimmed === "") return undefined;
	const tokens = tokenize(maskForAnalysis(trimmed, ctx.scratchDir), ctx.scratchDir);
	if (tokens === null) return undefined;
	const dirs = segmentDirs(tokens, ctx.cwd);
	const needing = normalizeGitSegments(tokens, ctx.cwd).flatMap((segment, k) => (isReadOnlySegment(segment, ctx.cwd, ctx.scratchDir) ? [] : [{ segment, dir: dirs[k] }]));
	if (needing.length !== 1) return undefined;
	const blocker = segmentBlocker(needing[0].segment, ctx.cwd, ctx.scratchDir);
	const stripped = stripPrefixes(needing[0].segment.argv, needing[0].segment.globs, true);
	// removals never get a rule (privilege and the file-format checks are parseRule's call)
	if (stripped === null || isRemoval(stripped.argv) || blocker?.effect === "exec" || (blocker !== undefined && writeProblem(blocker, ctx.cwd, needing[0].dir, ctx.scratchDir) !== undefined)) return undefined;
	const argv = canonicalize(stripped.argv);
	// a token with spaces or shell characters (a quoted argument) can't be
	// written as a rule body that tokenizes back to the same command
	if (!argv.every((word) => RULE_SAFE_WORD.test(word))) return undefined;
	return argv;
}

/**
 * Prefixes to pre-approve for the shell commands a plan says it will run:
 * deriveCommandPrefixes per command (rtk canonicalized), dropping what can't
 * be remembered (dangerous, privileged, removals, interpreters,
 * unparseable) and read-only commands, deduped.
 */
export function planCommandPrefixes(commands: readonly string[], ctx: PathContext): string[][] {
	const out: string[][] = [];
	for (const command of commands) {
		if (typeof command !== "string") continue;
		for (const prefix of deriveCommandPrefixes(command, ctx) ?? []) {
			if (!out.some((p) => p.join(" ") === prefix.join(" "))) out.push(prefix);
		}
	}
	return out;
}

/**
 * Prefix to remember for one simple command (see deriveCommandPrefixes), in
 * canonical form: `rtk git commit -m x` and `git commit -m x` both give
 * `["git","commit"]`. Depth comes from COMMAND_ARITY (default: the command
 * alone). undefined when a flag falls inside the arity window
 * (`git -C x commit`: prefixes match token-wise from the start, so it would
 * never match) or the command has fewer tokens than its arity (`gh pr`
 * would be broader than the table intends).
 */
function prefixFor(command: string[]): string[] | undefined {
	const argv = canonicalize(command);
	const [root, ...args] = argv;
	if (root === undefined || isRemoval(argv)) return undefined;
	const name = basename(root);
	if (INTERPRETERS.has(name) || COMMAND_RUNNERS.has(name) || PRIVILEGE_COMMANDS.has(name)) return undefined;

	if (name === "rtk") {
		// not a 1:1 proxy: remember the rtk form (`rtk test cargo test`, `rtk read`)
		const sub = args[0];
		if (sub === undefined || sub.startsWith("-") || sub === "run") return undefined;
		if (!RTK_RUNNERS.has(sub)) {
			const inner = prefixFor(args);
			return inner === undefined ? undefined : [root, ...inner];
		}
		const inner = prefixFor(args.slice(1));
		return inner === undefined ? undefined : [root, sub, ...inner];
	}

	let arity = 1;
	for (let len = Math.min(argv.length, 3); len >= 1; len--) {
		const key = [name, ...argv.slice(1, len)].join(" ");
		if (Object.hasOwn(COMMAND_ARITY, key)) {
			arity = COMMAND_ARITY[key];
			break;
		}
	}
	// `docker exec`/`kubectl exec`/`npm exec` take a program: the program joins the prefix
	if (arity === 2 && RUNNER_SUBCOMMANDS.has(args[0] ?? "")) arity = 3;
	if (argv.length < arity) return undefined;
	const prefix = argv.slice(0, arity);
	if (prefix.slice(1).some((t) => t.startsWith("-"))) return undefined;
	// `uv run python` would allow any program
	if (prefix.length >= 3 && RUNNER_SUBCOMMANDS.has(prefix[1]) && INTERPRETERS.has(basename(prefix[2]))) return undefined;
	return prefix;
}

/** A removal (`rm`, `git rm`, `rtk proxy rm`): always asks, never remembered. */
function isRemoval(command: string[]): boolean {
	const argv = canonicalize(command);
	const [root, ...args] = argv;
	if (root === undefined) return false;
	const name = basename(root);
	if (NEVER_REMEMBER.has(name)) return true;
	if (name === "rtk") {
		const inner = args.slice(args.findIndex((a) => !a.startsWith("-"))); // past rtk global flags
		return args.some((a) => !a.startsWith("-")) && isRemoval(RTK_RUNNERS.has(inner[0] ?? "") ? inner.slice(1) : inner);
	}
	if (!MULTI_COMMAND_TOOLS.has(name) && !Object.hasOwn(COMMAND_ARITY, name)) return false;
	// first subcommand positions, past global flags (`git -C . rm`, `docker container rm`)
	return args
		.filter((a) => !a.startsWith("-"))
		.slice(0, 3)
		.some((a) => NEVER_REMEMBER.has(a) || REMOVAL_SUBCOMMANDS.has(a));
}

/**
 * True when a prefix the user typed for "Yes, and always allow" is safe to remember:
 * not an interpreter, runner or privilege command (a remembered `bash` or
 * `find` allows anything), not a removal, and not a bare script runner
 * (`npm run` would allow every script).
 */
export function isRememberablePrefix(typed: readonly string[]): boolean {
	const tokens = canonicalize(typed);
	const [root, ...args] = tokens;
	if (root === undefined || isRemoval([...tokens])) return false;
	const name = basename(root);
	if (INTERPRETERS.has(name) || COMMAND_RUNNERS.has(name) || PRIVILEGE_COMMANDS.has(name)) return false;
	if (name === "rtk") {
		const sub = args[0];
		if (sub === undefined || sub.startsWith("-") || sub === "run") return false;
		return isRememberablePrefix(RTK_RUNNERS.has(sub) ? args.slice(1) : args);
	}
	if ((MULTI_COMMAND_TOOLS.has(name) || Object.hasOwn(COMMAND_ARITY, name)) && RUNNER_SUBCOMMANDS.has(args[0] ?? "")) {
		const script = args[1];
		return script !== undefined && !script.startsWith("-") && !INTERPRETERS.has(basename(script));
	}
	return true;
}

/**
 * True when an exact rule the user approved is safe to remember: not a
 * removal and not a privilege command. Unlike a prefix, an exact rule names
 * one command token-for-token, so interpreters (`python3 x.py`) and script
 * runners (`npm run build`) are fine: only that command runs unasked.
 */
export function isRememberableExact(typed: readonly string[]): boolean {
	const tokens = canonicalize(typed);
	const [root, ...args] = tokens;
	if (root === undefined || isRemoval([...tokens])) return false;
	const name = basename(root);
	if (PRIVILEGE_COMMANDS.has(name)) return false;
	if (name === "rtk") {
		const sub = args[0];
		if (sub === undefined || sub.startsWith("-") || sub === "run") return false;
		return isRememberableExact(RTK_RUNNERS.has(sub) ? args.slice(1) : args);
	}
	return true;
}

/**
 * True when every simple command is read-only or starts with one of the
 * remembered prefixes (token-wise, after stripping safe env/wrappers).
 * `npm test && rm x` is not covered by `npm test`, and removals are never
 * covered, even by a prefix the user typed (`git` does not cover `git rm`).
 */
export function isCoveredByPrefixes(command: string, prefixes: readonly (readonly string[])[], cwd: string, exact: readonly (readonly string[])[] = [], scratch?: string, fetchHosts?: readonly string[]): boolean {
	if (prefixes.length === 0 && exact.length === 0) return false;
	const trimmed = command.trim();
	if (trimmed === "" || trimmed.length > MAX_COMMAND_LENGTH) return false;
	const tokens = tokenize(maskForAnalysis(trimmed, scratch), scratch);
	if (tokens === null || tokens.length === 0) return false;
	const segments = normalizeGitSegments(tokens, cwd);
	const dirs = segmentDirs(tokens, cwd);
	if (!segments.every((segment, k) => isReadOnlySegment(segment, cwd, scratch, fetchHosts) || isCoveredSegment(segment, prefixes, cwd, exact, scratch, dirs[k]))) return false;
	return !gitRunsInOtherRepo(segments, cwd);
}

/**
 * True when a git (or `rtk git`) command runs after a `cd` into another
 * directory that is outside the cwd, can't be resolved, or sits in a nested
 * repo: that repo's hooks and config (fsmonitor) would run. A `cd` into a
 * plain subdirectory of the same repo is fine.
 */
function gitRunsInOtherRepo(segments: Segment[], cwd: string, checkRepoFlags = true): boolean {
	let dir: string | undefined = cwd;
	for (const segment of segments) {
		const stripped = stripPrefixes(segment.argv, segment.globs, true);
		const [root, ...args] = canonicalize(stripped?.argv ?? []);
		if (root === undefined) continue;
		const name = basename(root);
		if (DIR_CHANGERS.has(name)) {
			dir = changedDir(name, args, dir);
		} else if (name === "git") {
			// -C / --git-dir / --work-tree left after normalization point at another repo
			const flags = args.slice(0, Math.max(0, args.findIndex((x) => !x.startsWith("-"))));
			if (checkRepoFlags && flags.some((f) => f === "-C" || /^--(git-dir|work-tree)(=|$)/.test(f))) return true;
			if (dir === undefined || (dir !== cwd && crossesRepoBoundary(dir, cwd))) return true;
		}
	}
	return false;
}

/**
 * True when running git in `dir` would use a different repo than the one at
 * `cwd`: `dir` is outside `cwd`, or it or an ancestor strictly below `cwd`
 * has a `.git` entry (directory, or file for worktrees/submodules). Symlinks
 * are resolved. Reusable for `git -C <dir>`.
 */
export function crossesRepoBoundary(dir: string, cwd: string): boolean {
	const root = realpathLoose(resolve(cwd));
	let current = realpathLoose(resolve(cwd, dir));
	if (!isInside(current, root)) return true;
	while (current !== root) {
		if (existsSync(join(current, ".git"))) return true;
		const parent = dirname(current);
		if (parent === current) return true; // defensive: never reached the root
		current = parent;
	}
	return false;
}

/** realpath, resolving the nearest existing ancestor when `path` doesn't exist. */
function realpathLoose(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(realpathLoose(parent), basename(path));
	}
}

/** Git globals that only change display or locking; the rest of the list is deliberately tiny. */
const GIT_HARMLESS_FLAGS = new Set(["--no-pager", "--no-optional-locks"]);

/**
 * Index where the subcommand starts when `git [-C <dir>]… [harmless flags]
 * <sub> …` can be treated as `git <sub> …`: the only globals are `-C <dir>`
 * (repeatable, relative to `dir`) and GIT_HARMLESS_FLAGS, and the final
 * directory is inside the cwd and not in a nested repo. Never for `-c`,
 * `--git-dir`, `--work-tree`, `--exec-path`, `--namespace`, `--config-env`.
 */
function gitSubcommandStart(argv: readonly string[], globs: readonly boolean[], dir: string | undefined, cwd: string | undefined): number | undefined {
	if (basename(argv[0] ?? "") !== "git") return undefined;
	let i = 1;
	let target = dir;
	while (i < argv.length && argv[i].startsWith("-")) {
		if (GIT_HARMLESS_FLAGS.has(argv[i])) {
			i++;
		} else if (argv[i] === "-C") {
			const value = argv[i + 1];
			if (value === undefined || globs[i + 1] === true || value.includes("$") || target === undefined) return undefined; // quoted "$D" still expands
			target = resolvePath(value, target);
			i += 2;
		} else return undefined;
	}
	if (i === 1 || i >= argv.length) return undefined; // nothing to normalize, or no subcommand left
	if (target !== dir && (cwd === undefined || crossesRepoBoundary(target ?? "", cwd))) return undefined;
	return i;
}

/**
 * Rewrites `git -C <dir> <sub>` segments (also `rtk git -C …`) to `git <sub>`
 * where gitSubcommandStart allows it, tracking `cd` like gitRunsInOtherRepo,
 * so prefixes and coverage treat them as the plain command.
 */
function normalizeGitSegments(segments: Segment[], cwd: string | undefined): Segment[] {
	let dir: string | undefined = cwd;
	return segments.map((segment) => {
		const stripped = stripPrefixes(segment.argv, segment.globs, true);
		if (stripped === null) return segment;
		const argv = canonicalize(stripped.argv);
		const globs = stripped.globs.slice(stripped.argv.length - argv.length);
		const name = basename(argv[0] ?? "");
		if (DIR_CHANGERS.has(name)) dir = changedDir(name, argv.slice(1), dir);
		const start = gitSubcommandStart(argv, globs, dir, cwd);
		return start === undefined ? segment : { argv: [argv[0], ...argv.slice(start)], globs: [globs[0], ...globs.slice(start)] };
	});
}

/**
 * One simple command starts with a remembered prefix (or equals an exact
 * rule). Removals never are covered. Exec-effect commands (`sed -f`, `git
 * -c`, `find -exec`; see Blocker) never are. Write-effect ones (`sed -i`,
 * `sort -o`, `git log --output=x`, `cp`, `tee`) are covered only when every
 * target stays in the project (targetProblem), by exact rules too. `dir`:
 * where the segment runs (default the cwd; null = unknown).
 */
function isCoveredSegment(segment: Segment, prefixes: readonly (readonly string[])[], cwd: string | undefined, exact: readonly (readonly string[])[] = [], scratch?: string, dir?: string | null): boolean {
	const stripped = stripPrefixes(segment.argv, segment.globs, true);
	if (stripped === null || isRemoval(stripped.argv)) return false;
	const blocker = segmentBlocker(segment, cwd, scratch);
	if (blocker?.effect === "exec" || (blocker !== undefined && writeProblem(blocker, cwd, dir, scratch) !== undefined)) return false;
	// compare canonical forms: `git add` covers `rtk git add` and vice versa
	const argv = canonicalize(stripped.argv);
	if (exact.some((raw) => {
		const e = canonicalize(raw);
		return e.length === argv.length && e.every((t, k) => argv[k] === t);
	})) return true;
	return prefixes.some((raw) => {
		const p = canonicalize(raw);
		return p.length <= argv.length && p.every((t, k) => argv[k] === t);
	});
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Expands a leading `~`, `$HOME` or `${HOME}` (each followed by `/` or the end)
 * to the home dir, so `$HOME/.aws/credentials` is judged like `~/.aws/credentials`.
 */
export function expandHome(path: string, home = homedir()): string {
	const prefix = /^(?:~|\$\{HOME\}|\$HOME)(?=\/|$)/.exec(path);
	return prefix === null ? path : home + path.slice(prefix[0].length);
}

function resolvePath(path: string, cwd: string): string {
	return resolve(cwd, expandHome(path));
}

function isInside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * True when `path` is the scratch dir or inside it, judged by realpath
 * (nearest existing ancestor, as crossesRepoBoundary does), so a symlink
 * in the scratch dir that points elsewhere is not inside it.
 */
export function isInsideScratch(path: string, scratch: string): boolean {
	return isInside(realpathLoose(resolve(path)), realpathLoose(resolve(scratch)));
}

/** True when any simple command of `command` (also inside `sh -c`, behind rtk or a package manager) removes things: `rm`, `git rm`, `docker rmi`, `pip uninstall`, ... */
export function hasRemoval(command: string): boolean {
	return scanUnits(command).some((unit) => isRemoval(unit));
}

/** Like isInsideScratch, but not the scratch dir itself. */
function isStrictlyInsideScratch(path: string, scratch: string): boolean {
	return isInsideScratch(path, scratch) && realpathLoose(resolve(path)) !== realpathLoose(resolve(scratch));
}

/** True when a file tool's `target` (relative to cwd, `~` expanded) is inside the scratch dir. */
export function isScratchPath(target: string, ctx: PathContext): boolean {
	return target !== "" && ctx.scratchDir !== undefined && isInsideScratch(resolvePath(target, ctx.cwd), ctx.scratchDir);
}

/**
 * The pi-subagents output artifact dir a target names, or undefined:
 * `<agent dir>/sessions/<session dir>/subagent-artifacts/outputs/<id>` for a
 * target at or under it. Only the agent dir's own sessions tree counts, and a
 * resolved `..` cannot leave it. Any child may use any artifact dir: the id
 * pi-subagents puts in the path is not the child's own run id, so it can't be
 * matched against the child.
 */
function artifactDirOf(target: string, ctx: PathContext): string | undefined {
	if (target === "" || ctx.agentDir === undefined) return undefined;
	const sessions = join(resolve(ctx.agentDir), "sessions");
	const resolved = resolvePath(target, ctx.cwd);
	if (!isInside(resolved, sessions) || resolved === sessions) return undefined;
	const parts = relative(sessions, resolved).split(sep);
	// <session dir>/subagent-artifacts/outputs/<id>[/...]
	if (parts.length < 4 || parts[1] !== "subagent-artifacts" || parts[2] !== "outputs") return undefined;
	return join(sessions, parts[0], parts[1], parts[2], parts[3]);
}

/**
 * True when `target` is a pi-subagents artifact dir (`.../outputs/<id>`) or
 * anything under it, judged by realpath, so a symlink inside the dir that
 * points elsewhere does not count. The dir itself counts: a child makes it
 * with `mkdir -p` before it writes its report into it.
 */
export function isInsideSubagentArtifactDir(target: string, ctx: PathContext): boolean {
	const artifactDir = artifactDirOf(target, ctx);
	if (artifactDir === undefined) return false;
	return isInside(realpathLoose(resolvePath(target, ctx.cwd)), realpathLoose(artifactDir));
}

/**
 * True when `target` is a file *in* a pi-subagents output artifact dir,
 * `<agent dir>/sessions/<session dir>/subagent-artifacts/outputs/<id>/<file>`:
 * where a child is told to write its report (`context.md`). The dir itself is
 * not a file (see isInsideSubagentArtifactDir).
 */
export function isSubagentArtifactPath(target: string, ctx: PathContext): boolean {
	const artifactDir = artifactDirOf(target, ctx);
	if (artifactDir === undefined) return false;
	const real = realpathLoose(resolvePath(target, ctx.cwd));
	const realDir = realpathLoose(artifactDir);
	return real !== realDir && isInside(real, realDir);
}

/** Create the per-session scratch dir: `<tmp>/pi-keeper-XXXXXX`, owner-only (0700). */
export function createScratchDir(base = tmpdir()): string {
	const dir = mkdtempSync(join(base, "pi-keeper-"));
	chmodSync(dir, 0o700);
	return dir;
}

/** True when `target` (relative to cwd, `~` expanded) is exactly `file`. */
export function isSamePath(target: string, file: string, cwd: string): boolean {
	if (target === "") return false;
	return resolvePath(target, cwd) === resolve(file);
}

/** Protected path (ask in auto): agent dir, .git/.pi/..., shell rc files, ... */
export function isProtectedPath(target: string, ctx: PathContext): boolean {
	if (target === "") return false;
	const resolved = resolvePath(target, ctx.cwd);
	if (ctx.planFile !== undefined && resolved === resolve(ctx.planFile)) return false;
	if (ctx.scratchDir !== undefined && isInsideScratch(resolved, ctx.scratchDir)) return false; // a cloned repo's .git is fair game there
	if (ctx.agentDir !== undefined && isInside(resolved, resolve(ctx.agentDir))) return true;
	if (resolved.split(sep).some((part) => PROTECTED_DIRS.has(part))) return true;
	if (resolved.includes(`${sep}.config${sep}git`)) return true;
	return PROTECTED_FILES.has(basename(resolved));
}

/** Outside the working directory (ask in auto); the plan file is exempt. */
export function isOutsideCwd(target: string, ctx: PathContext): boolean {
	if (target === "") return false;
	const resolved = resolvePath(target, ctx.cwd);
	if (ctx.planFile !== undefined && resolved === resolve(ctx.planFile)) return false;
	if (ctx.scratchDir !== undefined && isInsideScratch(resolved, ctx.scratchDir)) return false;
	return !isInside(resolved, resolve(ctx.cwd));
}

export interface SecretContext {
	/** Resolves relative paths for the home-directory checks. */
	cwd?: string;
	/** pi agent dir, when not the default ~/.pi/agent (its auth.json is a secret). */
	agentDir?: string;
}

/**
 * Secret file (asks in every mode): `.env` / `.env.*` (except
 * example/sample/template files), private keys (`id_rsa`, `*.pem`,
 * `*.key`), and credential stores under home (`~/.ssh`, `~/.aws`, pi's
 * `auth.json`, ...). Public keys (`*.pub`) are not secret.
 */
export function isSecretFile(path: string, ctx?: SecretContext): boolean {
	if (path === "") return false;
	const name = basename(path);
	if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|template|dist)$/.test(name);
	if (name.endsWith(".pub")) return false;
	if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name))) return true;
	// relative paths only resolve with a cwd
	if (ctx?.cwd === undefined && !/^[/~]/.test(expandHome(path))) return false;
	const resolved = resolvePath(path, ctx?.cwd ?? "/");
	if (ctx?.agentDir !== undefined && resolved === join(resolve(ctx.agentDir), "auth.json")) return true;
	const home = homedir();
	return SECRET_HOME_PATHS.some((p) => isInside(resolved, join(home, p)));
}
