/**
 * Shell command highlighting for a dialog that asks the user to run a command.
 *
 * pi's own highlighter (`highlightCode`, highlight.js underneath) colors keywords,
 * strings, variables, numbers and comments. It never colors the name of an external
 * command — `git`, `tar`, `rm`, `sudo` are plain words to a grammar — and it paints a
 * heredoc body as one string. This module adds those two things, and nothing else:
 *
 * - the word in command position gets `style.command`, including the word after a
 *   prefix such as `sudo`, `env`, `rtk` or `xargs`, and the word after `|`, `&&`, `;`, `(` or `{`;
 * - a precommand modifier gets `style.precommand` and a language or task runner (`python`,
 *   `go`, `npm`, `make`) gets `style.runner`, so `sudo python3 x.py` reads in three weights
 *   rather than one, and an option after the command gets `style.option` (`-n`, `--json`);
 * - a heredoc body is highlighted with the language its delimiter or its opening
 *   command names, else with the language the body itself looks like (a shebang, an
 *   `import`, a `select`), else as shell — and a shell body also gets its command
 *   names colored, so `cat <<EOF` with `go build` inside reads like the rest.
 *
 * It never changes the visible characters: one line in, one line out, with ANSI codes
 * inserted around words that carried none. The tests compare the stripped output with
 * the input for every fixture.
 *
 * Nothing here reads the disk. The work runs synchronously on pi's UI thread (about
 * 30 ms for 2000 lines), so each shell run and each heredoc body is capped at
 * MAX_HIGHLIGHT_LINES lines; the cap applies per segment, so a command with several
 * segments can highlight more than that in total.
 */

import { highlightCode } from "@earendil-works/pi-coding-agent";

/**
 * Lines of one shell run or one heredoc body that get highlighted. A longer command
 * keeps its tail in `style.plain`: the highlighter is not worth a stalled UI.
 */
export const MAX_HIGHLIGHT_LINES = 400;

/** Registry key the extension publishes its highlighter under (see `extension.ts`). */
export const HIGHLIGHTER_KEY: symbol = Symbol.for("pi.shell-highlight.v1");

/** How to paint the three things this module decides, in the caller's theme. */
export interface CommandStyle {
	/** Wrap a command name in color. Must return a self-contained span (open, text, close). */
	command(text: string): string;
	/** Wrap a line that gets no language — a heredoc terminator, or a body past the cap. */
	plain(text: string): string;
	/**
	 * Wrap an assignment target in a heredoc body (`rows = [ … ]`), for the languages
	 * whose grammar leaves it plain (python, ruby, perl). Omitted: assignments keep the
	 * grammar's color.
	 */
	variable?(text: string): string;
	/**
	 * Wrap a command that runs a language or a project's tasks (`python`, `node`, `go`,
	 * `npm`, `make`), so the runner reads apart from a plain tool such as `grep`.
	 * Omitted: runners take the command color.
	 */
	runner?(text: string): string;
	/**
	 * Wrap a precommand modifier (`sudo`, `env`, `nohup`, `rtk`), the words whose job is to
	 * run another command. Omitted: they take the command color, as before.
	 */
	precommand?(text: string): string;
	/** Wrap an option (`-n`, `--json`). Omitted: options stay as the grammar painted them. */
	option?(text: string): string;
}

/** The contract: one ANSI-colored string per input line, same count and order. */
export interface CommandHighlighter {
	highlightCommand(text: string, lang: string | undefined, style: CommandStyle): string[];
}

/** Heredoc delimiter words that name a language. */
const LANGUAGE_BY_DELIMITER: Readonly<Record<string, string>> = {
	PY: "python",
	PY2: "python",
	PY3: "python",
	PYTHON: "python",
	SQL: "sql",
	JSON: "json",
	YAML: "yaml",
	YML: "yaml",
	SH: "bash",
	BASH: "bash",
	SHELL: "bash",
	JS: "javascript",
	NODE: "javascript",
	TS: "typescript",
	GO: "go",
	RB: "ruby",
	RUBY: "ruby",
	RS: "rust",
	RUST: "rust",
	PHP: "php",
	PL: "perl",
	PERL: "perl",
	LUA: "lua",
	DOCKER: "dockerfile",
	DOCKERFILE: "dockerfile",
	HTML: "html",
	XML: "xml",
	CSS: "css",
	MD: "markdown",
	MARKDOWN: "markdown",
	INI: "ini",
	TF: "hcl",
	HCL: "hcl",
};

/** Commands that run a heredoc body in their own language. */
const LANGUAGE_BY_COMMAND: Readonly<Record<string, string>> = {
	python: "python",
	python2: "python",
	python3: "python",
	node: "javascript",
	nodejs: "javascript",
	deno: "typescript",
	psql: "sql",
	mysql: "sql",
	mariadb: "sql",
	sqlite3: "sql",
	ruby: "ruby",
	perl: "perl",
	php: "php",
	rscript: "r",
	lua: "lua",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	dash: "bash",
	ksh: "bash",
};

/**
 * Commands whose job is to run a language or a project's tasks. They read apart from a
 * plain tool: the runner says which language or workflow is coming, the arguments say
 * what it does. Matched case-insensitively (`Rscript` and `R` both count).
 */
const RUNNERS: ReadonlySet<string> = new Set([
	"python",
	"python2",
	"python3",
	"pypy",
	"node",
	"nodejs",
	"deno",
	"bun",
	"bunx",
	"ruby",
	"perl",
	"php",
	"lua",
	"r",
	"rscript",
	"go",
	"cargo",
	"rustc",
	"java",
	"dotnet",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"uv",
	"uvx",
	"poetry",
	"pip",
	"pip3",
	"pytest",
	"make",
	"cmake",
	"just",
	"gradle",
	"mvn",
]);

/** `-n`, `-rf`, `--json`: an option, not `-` or `--` alone (which is a stdin/stdout argument). */
const OPTION = /^--?\w/;

/** Words that run another command, so the word after them is the command. */
const PREFIXES: ReadonlySet<string> = new Set([
	"sudo",
	"doas",
	"env",
	"xargs",
	"nohup",
	"time",
	"command",
	"exec",
	"nice",
	"ionice",
	"stdbuf",
	"builtin",
	"unbuffer",
	"watch",
	// rtk always carries the command it runs: `rtk grep …`, `rtk git status`
	"rtk",
]);

/**
 * Options of a prefix command that take the next word as their value, so the
 * command is not the word right after them (`sudo -u root git …`).
 */
const OPTION_TAKES_VALUE: ReadonlySet<string> = new Set([
	"-u",
	"-g",
	"-p",
	"-C",
	"-h",
	"-r",
	"-t",
	"-U",
	"-D",
	"-R",
	"-T",
	"-S",
	"-n",
	"-I",
	"-i",
	"-a",
	"-d",
	"-E",
	"-s",
	"-L",
	"-P",
	"-J",
	"-Z",
	"-o",
	"-c",
	"-f",
	"-k",
	"-e",
]);

/** Shell words that open or close a compound command: they do not take the command slot. */
const RESERVED: ReadonlySet<string> = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"in",
	"select",
	"function",
	"!",
	"[[",
	"]]",
]);

/**
 * `<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`, `<<\DELIM`. Never `<<<` (a here-string):
 * `(?<!<)` rejects a `<<` that follows another `<`, and `(?!<)` rejects a third `<`.
 */
const HEREDOC_OPENER = /(?<!<)<<(-?)(?!<)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/;

type Token = { kind: "escape"; text: string } | { kind: "text"; text: string; colored: boolean };

/** True when these SGR parameters leave a color or an attribute switched on. */
function opensStyle(params: string): boolean {
	if (params === "") return false; // ESC[m is a reset
	return params
		.split(";")
		.some((part) => part !== "0" && part !== "39" && part !== "49" && part !== "22" && part !== "23" && part !== "24" && part !== "27" && part !== "28" && part !== "29");
}

/** Split one highlighted line into escape sequences and text runs, keeping the order. */
function tokenize(line: string): Token[] {
	const tokens: Token[] = [];
	let colored = false;
	let text = "";
	const flush = (): void => {
		if (text !== "") tokens.push({ kind: "text", text, colored });
		text = "";
	};
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\x1b" && line[i + 1] === "[") {
			let j = i + 2;
			while (j < line.length && !/[A-Za-z]/.test(line[j] ?? "")) j++;
			const end = Math.min(j + 1, line.length);
			const sequence = line.slice(i, end);
			flush();
			tokens.push({ kind: "escape", text: sequence });
			colored = opensStyle(sequence.slice(2, -1));
			i = end - 1;
			continue;
		}
		text += ch;
	}
	flush();
	return tokens;
}

type Word = { kind: "space" | "operator" | "word"; text: string };

/** Split text into whitespace, operator runs (`|`, `&&`, `;`, `(` …) and words. */
function words(text: string): Word[] {
	const out: Word[] = [];
	for (const match of text.matchAll(/\s+|[|&;(){}]+|[^\s|&;(){}]+/g)) {
		const piece = match[0];
		const kind = /^\s+$/.test(piece) ? "space" : /^[|&;(){}]+$/.test(piece) ? "operator" : "word";
		out.push({ kind, text: piece });
	}
	return out;
}

/** A word that starts a new command: everything after `|`, `&&`, `;`, `(` or `{`. */
function startsCommand(operator: string): boolean {
	// a single `&` is a background marker (and `2>&1` splits into `2>`, `&`, `1`): not a separator
	if (operator === "&") return false;
	return /[|;({]/.test(operator) || operator.includes("&&");
}

/** A redirection, an assignment or a comment: none of them is the command. */
function isNotACommand(word: string): boolean {
	if (word.startsWith("#")) return true; // comment: the rest of the line is prose
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return true; // FOO=bar cmd
	if (/^(\d+|\*)?[<>]/.test(word)) return true; // > out, 2> err, < in
	if (/^&[<>]/.test(word)) return true; // &> out
	return false;
}

/**
 * Color the name of each command in an already-highlighted line. A word that the
 * grammar already colored keeps its color: only uncolored words are wrapped, so a
 * builtin such as `echo` is never painted twice.
 */
export function markCommandNames(line: string, style: CommandStyle): string {
	let expectCommand = true;
	/** Inside the options of a prefix command: `sudo -u root git …` colors `git`, not `-u`. */
	let afterPrefix = false;
	/** The previous word was an option that takes a value, so this word is that value. */
	let skipValue = false;
	const out: string[] = [];
	for (const token of tokenize(line)) {
		if (token.kind === "escape") {
			out.push(token.text);
			continue;
		}
		for (const word of words(token.text)) {
			if (word.kind === "space") {
				out.push(word.text);
				continue;
			}
			if (word.kind === "operator") {
				if (startsCommand(word.text)) {
					expectCommand = true;
					afterPrefix = false;
					skipValue = false;
				}
				out.push(word.text);
				continue;
			}
			const lower = word.text.toLowerCase();
			if (expectCommand) {
				if (skipValue) {
					skipValue = false; // the value of `-u` or `-I{}`: not a command
				} else if (word.text.startsWith("#")) {
					expectCommand = false; // a comment: nothing else on this line is a command
				} else if (isNotACommand(word.text) || RESERVED.has(lower)) {
					// `FOO=1 cmd`, `> out cmd`, `if cmd`: the command slot stays open
				} else if (afterPrefix && (word.text.startsWith("-") || word.text === "--")) {
					// an option of the prefix command; some take the next word as a value
					skipValue = OPTION_TAKES_VALUE.has(word.text);
				} else if (PREFIXES.has(lower)) {
					// `sudo cmd`, `sudo rtk grep`, `env A=1 cmd`: a chain of modifiers, the command is
					// the next word
					afterPrefix = true;
					if (!token.colored) {
						out.push((style.precommand ?? style.command)(word.text));
						continue;
					}
				} else {
					expectCommand = false;
					afterPrefix = false;
					if (!token.colored) {
						out.push(paintCommandWord(word.text, style));
						continue;
					}
				}
			}
			// past the command: an option of its own, unless the grammar already colored it
			if (!expectCommand && style.option !== undefined && !token.colored && OPTION.test(word.text)) {
				out.push(style.option(word.text));
				continue;
			}
			out.push(word.text);
		}
	}
	return out.join("");
}

/** A command word: a language or task runner reads apart from a plain tool. */
function paintCommandWord(word: string, style: CommandStyle): string {
	if (RUNNERS.has(word.toLowerCase())) return (style.runner ?? style.command)(word);
	return style.command(word);
}

/** Languages whose grammar leaves an assignment target plain, so `markAssignments` adds it. */
const ASSIGNMENT_LANGUAGES: ReadonlySet<string> = new Set(["python", "ruby", "perl"]);

/** `name = value`, `name: int = value`, at the start of a line (indentation allowed). */
const ASSIGNMENT = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*(?::[^=]*)?)=(?!=)/;

/**
 * Color an assignment target at the start of an already-highlighted line — `rows` in
 * `rows = [...]`, `total: int = len(x)`. The match is found on the line with its ANSI
 * codes removed, so a colored keyword or call later in the line does not hide the `=`;
 * the target itself is only painted when it carries no color yet, and `==` never counts.
 */
export function markAssignments(line: string, style: CommandStyle): string {
	if (style.variable === undefined) return line;
	const paint = style.variable.bind(style);
	const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
	const match = ASSIGNMENT.exec(plain);
	if (match === null) return line;
	const start = (match[1] ?? "").length;
	const end = start + (match[2] ?? "").length;
	const name = plain.slice(start, end);
	if (name === "") return line;
	// where those characters sit in the colored line, and whether color starts before them
	let visible = 0;
	let from = -1;
	let to = -1;
	for (let i = 0; i < line.length && to === -1; i++) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			const sequenceEnd = line.indexOf("m", i);
			if (sequenceEnd === -1) return line;
			if (from === -1 && visible < end) return line; // already colored by the grammar
			i = sequenceEnd;
			continue;
		}
		if (visible === start && from === -1) from = i;
		visible++;
		if (visible === end) to = i + 1;
	}
	if (from === -1 || to === -1) return line;
	return line.slice(0, from) + paint(name) + line.slice(to);
}

/** The language of a heredoc, from its delimiter or from the command that opened it. */
export function heredocLanguage(delimiter: string, openerLine: string): string | undefined {
	const upper = delimiter.toUpperCase();
	const exact = LANGUAGE_BY_DELIMITER[upper];
	if (exact !== undefined) return exact;
	for (const part of upper.split(/[-_]+/)) {
		const byPart = LANGUAGE_BY_DELIMITER[part];
		if (byPart !== undefined) return byPart;
	}
	for (const match of openerLine.matchAll(/[A-Za-z0-9_./-]+/g)) {
		const word = (match[0].split("/").pop() ?? "").toLowerCase();
		const byCommand = LANGUAGE_BY_COMMAND[word];
		if (byCommand !== undefined) return byCommand;
	}
	return undefined;
}

/** Body lines the guesser reads: a shebang, an import or a `select` sits in the first few. */
const GUESS_LINES = 20;

/**
 * What a body looks like, strongest signal first. Each pattern is narrow on purpose: a
 * false hit colors a plain-text heredoc with the wrong grammar, which reads worse than
 * the shell grammar that would otherwise be used.
 */
const GUESSES: readonly { lang: string; patterns: readonly RegExp[] }[] = [
	{
		lang: "python",
		patterns: [
			/^(?:async\s+)?def\s+\w+\s*\(/,
			/^class\s+\w+\s*[(:]/,
			/^import\s+[A-Za-z_][\w.]*$/,
			/^from\s+[A-Za-z_][\w.]*\s+import\b/,
			/^print\s*\(/,
			/^(?:if|elif|while|for|with|try|except|finally|else)\b[^;]*:\s*$/,
			/^if\s+__name__\s*==/,
		],
	},
	{
		lang: "sql",
		patterns: [
			/^(?:select|with\s+\w+\s+as)\b/i,
			/^insert\s+into\b/i,
			/^update\s+\w+\s+set\b/i,
			/^delete\s+from\b/i,
			/^(?:create|alter|drop)\s+(?:table|index|view|schema|database)\b/i,
		],
	},
	{
		lang: "bash",
		patterns: [
			/^#!\s*\S*(?:ba|z|da|k)?sh\s*$/,
			/^(?:then|do|done|fi|esac|else)$/,
			/^if\s+\[\[?\s[^\]]*\]\]?/,
			/^for\s+\w+\s+in\b.*;\s*do\b/,
			/^(?:export|local|readonly|declare)\s+\w+=/,
		],
	},
	{
		lang: "go",
		patterns: [/^package\s+\w+$/, /^func\s+(?:\(\w+\s+\*?\w+\)\s*)?\w+\s*\(/, /:=/, /^import\s+\(/],
	},
	{
		lang: "rust",
		patterns: [/^fn\s+\w+\s*[<(]/, /^(?:let\s+mut|pub\s+fn|use\s+[\w:]+;)/],
	},
	{
		lang: "javascript",
		patterns: [
			/^(?:const|let|var)\s+\w+\s*=/,
			/^(?:async\s+)?function\s*\w*\s*\(/,
			/^console\.(?:log|error|warn)\s*\(/,
			/^(?:import|export)\s+.*\bfrom\s+["']/,
			/=>\s*\{?$/,
		],
	},
	{ lang: "html", patterns: [/^<[a-zA-Z!/][^>]*>/] },
	{ lang: "dockerfile", patterns: [/^(?:FROM|RUN|COPY|ADD|WORKDIR|ENTRYPOINT|CMD)\s+\S/] },
];

/** The program of a shebang line as a language (`#!/usr/bin/env python3` gives `python`). */
function languageOfProgram(program: string): string | undefined {
	const name = program.trim().toLowerCase().split("/").pop() ?? "";
	if (name === "") return undefined;
	if (/^(?:ba|z|da|k)?sh$/.test(name)) return "bash";
	return LANGUAGE_BY_COMMAND[name];
}

/** The language of a `#!` line, following `env` to the program it runs. */
function languageOfShebang(line: string): string | undefined {
	const match = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(line.trim());
	if (match === null) return undefined;
	const program = match[1] ?? "";
	const argument = match[2] ?? "";
	return (program.split("/").pop() ?? "").toLowerCase() === "env" ? languageOfProgram(argument) : languageOfProgram(program);
}

/**
 * The language a heredoc body looks like, from its first lines: a shebang, a JSON shape,
 * then the lines that only one language opens with. Undefined when the body says nothing.
 */
export function guessHeredocLanguage(body: readonly string[]): string | undefined {
	const lines = body
		.slice(0, GUESS_LINES)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const first = lines[0];
	if (first === undefined) return undefined;
	const shebang = languageOfShebang(first);
	if (shebang !== undefined) return shebang;
	const joined = lines.join("\n");
	if (/^[[{]/.test(joined) && /[\]}]$/.test(joined)) return "json";
	for (const { lang, patterns } of GUESSES) {
		if (patterns.some((pattern) => lines.some((line) => pattern.test(line)))) return lang;
	}
	return undefined;
}

/**
 * The language of a heredoc body: what its delimiter or opening command names, else what
 * the body itself looks like, else `bash` — a heredoc opened in a shell command almost
 * always holds shell, and the shell grammar colors prose far less than a wrong guess would.
 */
export function heredocBodyLanguage(delimiter: string, openerLine: string, body: readonly string[]): string {
	return heredocLanguage(delimiter, openerLine) ?? guessHeredocLanguage(body) ?? "bash";
}

type Segment =
	| { kind: "shell"; lines: string[] }
	| { kind: "heredoc"; lang: string; body: string[]; terminator: string | undefined };

/** Split the command into shell runs and heredoc bodies. */
function segmentsOf(lines: readonly string[]): Segment[] {
	const out: Segment[] = [];
	let shell: string[] = [];
	const closeShell = (): void => {
		if (shell.length > 0) out.push({ kind: "shell", lines: shell });
		shell = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		shell.push(line);
		const opener = HEREDOC_OPENER.exec(line);
		if (opener === null) continue;
		const delimiter = opener[2] ?? opener[3] ?? opener[4] ?? "";
		if (delimiter === "") continue;
		const stripTabs = opener[1] === "-";
		closeShell();
		const body: string[] = [];
		let terminator: string | undefined;
		for (let j = i + 1; j < lines.length; j++) {
			const candidate = lines[j] ?? "";
			// `<<-` strips leading tabs from the body and from the terminator; bash does that too
			const comparable = (stripTabs ? candidate.replace(/^\t+/, "") : candidate).replace(/\s+$/, "");
			if (comparable === delimiter) {
				terminator = candidate;
				i = j;
				break;
			}
			body.push(candidate);
			// an unclosed heredoc takes the rest of the text: do not walk those lines again
			i = j;
		}
		out.push({ kind: "heredoc", lang: heredocBodyLanguage(delimiter, line, body), body, terminator });
	}
	closeShell();
	return out;
}

/** The lines with their colors: pi's highlighter for shell, the inner language for a heredoc body. */
export function highlightCommand(text: string, lang: string | undefined, style: CommandStyle): string[] {
	const shellLanguage = lang ?? "bash";
	const out: string[] = [];
	for (const segment of segmentsOf(text.split("\n"))) {
		if (segment.kind === "shell") {
			const shown = segment.lines.slice(0, MAX_HIGHLIGHT_LINES);
			const highlighted = highlightCode(shown.join("\n"), shellLanguage);
			for (let i = 0; i < shown.length; i++) out.push(markCommandNames(highlighted[i] ?? shown[i] ?? "", style));
			for (const line of segment.lines.slice(MAX_HIGHLIGHT_LINES)) out.push(style.plain(line));
			continue;
		}
		const shown = segment.body.slice(0, MAX_HIGHLIGHT_LINES);
		// a shell body is a script like any other: its command names are colored too
		const marksCommands = segment.lang === "bash";
		const marksAssignments = ASSIGNMENT_LANGUAGES.has(segment.lang);
		const highlighted = shown.length > 0 ? highlightCode(shown.join("\n"), segment.lang) : [];
		for (let i = 0; i < shown.length; i++) {
			const colored = highlighted[i] ?? style.plain(shown[i] ?? "");
			out.push(marksCommands ? markCommandNames(colored, style) : marksAssignments ? markAssignments(colored, style) : colored);
		}
		for (const line of segment.body.slice(MAX_HIGHLIGHT_LINES)) out.push(style.plain(line));
		if (segment.terminator !== undefined) out.push(style.plain(segment.terminator));
	}
	return out;
}
