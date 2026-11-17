/**
 * Mode definitions and command lists for pi-keeper.
 *
 * Single edit point for modes, permission rules, and every command list
 * (read-only allowlist, dangerous asks, privilege escalation, protected
 * paths). Logic lives in utils.ts (command analysis) and rules.ts
 * (rule evaluation); this file is data.
 *
 * Mode prompts are loaded from prompts/*.md so they can be edited without
 * touching extension code.
 */

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ModeRules } from "./rules.ts";

export type ModeName = "default" | "auto" | "plan";

export interface ModeDefinition {
	name: ModeName;
	/** Tools made active in this mode. Enforcement is in `rules`, not here. */
	tools: string[];
	/** Footer badge text, icon, and theme color (rendered bold, see formatModeStatus). */
	badge: string;
	icon: string;
	color: ThemeColor;
	/** One line per mode for the /mode selector (the README's "Use it for" column). */
	description: string;
	/** The mode's own text, the first part of its mode message (prompts/<file>). */
	prompt: string;
	/** Permission rules (see rules.ts for semantics). */
	permissions: ModeRules;
}

// Extension code lives in extensions/, prompts in ../prompts/
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadPrompt(name: string): string {
	try {
		return readFileSync(join(PACKAGE_ROOT, "prompts", name), "utf8").trim();
	} catch (error) {
		console.error(`pi-keeper: failed to load prompts/${name}:`, error);
		return "";
	}
}

/** Mode a pi-subagents child is forced into (auto only when enabled and its asks can relay). */
export type ChildMode = "plan" | "default" | "auto";

/** System prompt of a subagent child, instead of its mode's prompt (prompts/child-<mode>.md). */
export const CHILD_PROMPTS: Record<ChildMode, string> = {
	plan: loadPrompt("child-plan.md"),
	default: loadPrompt("child-default.md"),
	auto: loadPrompt("child-auto.md"),
};

/**
 * The mode-independent half of everything the models are told (prompts/contract.md):
 * the permission layer, "the newest message wins", the gates that hold in every
 * mode, rejection and privilege handling, the scratch convention. This is the only
 * part of our text that goes into the system prompt, so it must be identical on
 * every run; prompt-blocks.ts appends the rtk nudge and the todo path to it.
 */
export const CONTRACT = loadPrompt("contract.md");

/**
 * The text injected when a rulebook rule fires (prompts/rule-warning.md): what
 * happened, what to do next, then the rule's name, description and body
 * (rulebook.ts fills in the `{{name}}`, `{{description}}` and `{{body}}` slots).
 * It is never part of the prompt or of the mode message — only a hidden message,
 * only on a fire — so it costs nothing on a run where no rule matches.
 */
export const RULE_WARNING = loadPrompt("rule-warning.md");

/** Tool name in a rule that matches every tool (only with a matcher that narrows it). */
export const ANY_TOOL = "*";

/** Tool that ends plan mode (registered in index.ts). */
export const EXIT_PLAN_TOOL = "exit_plan_mode";

/**
 * Tools that never change anything. `questionnaire` is the current pi name;
 * `ask_user_question` is kept for older builds (unknown names are ignored).
 */
export const READ_TOOLS = ["read", "grep", "find", "ls", "questionnaire", "ask_user_question"];

/**
 * pi-subagents' launcher. Allowed in every mode, but only while its children
 * are guaranteed to load this extension (subagents-bridge.ts); see the
 * bridgeInactive rule in GLOBAL_RULES.
 */
export const SUBAGENT_TOOL = "subagent";

/**
 * The call pi-subagents makes before each workflow child starts (a `workflow`,
 * `parallel`, `tasks` or `chain` child; pi-subagents 0.85 and newer). It is
 * not declared to the model, and the model only sees the `subagent` call that
 * started the workflow, so the same rules must cover this name too.
 *
 * Its input carries what the parent runs after the child stops: the child's
 * `gate` and `acceptance.verify` shell commands (`commands`) and the file the
 * child's `output` writes (`output`). The gate (index.ts, `decide`) judges
 * each of them with the mode's own bash and write rules.
 */
export const SUBAGENT_LAUNCH_TOOL = "subagent_launch";

/** Every pi-subagents launch tool: one name for a single child, one per workflow child. */
export const LAUNCH_TOOLS = [SUBAGENT_TOOL, SUBAGENT_LAUNCH_TOOL];

/**
 * Tools pi-subagents gives its children: escalating to the parent
 * (`contact_supervisor`), returning schema-checked output (`structured_output`)
 * and waiting for background runs (`bg_wait`). Allowed only in a child session.
 */
export const CHILD_PROTOCOL_TOOLS = ["contact_supervisor", "structured_output", "bg_wait"];

/**
 * Built-in search tools. Off by default: search goes through `rtk grep` /
 * `rtk find` / `rtk ls` in bash (compact output, one less tool schema per
 * request). `pi --enable-builtin-tools` activates them in every mode; they
 * are always allowed by the rules, so enabling them via pi's `defaultTools`
 * works too.
 */
export const BUILTIN_SEARCH_TOOLS = ["grep", "find", "ls"];
export const BUILTIN_TOOLS_FLAG = "enable-builtin-tools";

/**
 * The search nudge of this setup: rtk is the default way to grep/find/ls, and its
 * output is trimmed, so exact edit text comes from `read`. Constant text, never
 * keyed on the active tool set, because it sits in the system prompt; it is keyed
 * on whether rtk is installed, decided once (`RTK_INSTALLED`).
 * `rtk init -g --agent pi` installs ~/.pi/agent/extensions/rtk.ts, but that only
 * rewrites bash commands and tells the model nothing, so this is the only signal.
 */
export const RTK_SEARCH_HINT =
	"Search and list with rtk in bash: `rtk grep <pattern> [path]`, `rtk find <path> -name <glob>`, `rtk ls <dir>`. They don't prompt inside the working directory, but a curl GET asks until your user allows its host (printed to stdout, `curl -s https://<host>/...`).\nrtk grep already recurses (leave out -r/-R: those also read hidden files such as .env) and trims indentation, so take the exact text for an edit from the `read` tool.";

/**
 * The same nudge where rtk is not installed: the built-in search tools when they
 * are active (`--enable-builtin-tools`), plain `grep`/`find`/`ls` in bash
 * otherwise. Telling a model to run a binary that is not on PATH only costs it a
 * failed call, so the choice is made once, here (see `searchHint`).
 */
export const BUILTIN_SEARCH_HINT =
	"Search and list with the built-in `grep`, `find` and `ls` tools when they are active, else with plain `grep`, `find` and `ls` in bash (a bash search may prompt, and a curl GET asks until your user allows its host). Take the exact text for an edit from the `read` tool.";

/**
 * Is an `rtk` executable on PATH? `RTK_DISABLED=1` — rtk's own kill switch, the one
 * `rtk-rewrite.ts` honours — counts as absent. A plain PATH scan, so it costs no
 * process and works on the first prompt.
 */
export function rtkOnPath(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
	if (env.RTK_DISABLED === "1") return false;
	const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => dir !== "");
	const names = platform === "win32" ? ["rtk.exe", "rtk.cmd", "rtk.bat"] : ["rtk"];
	return dirs.some((dir) => names.some((name) => isExecutableFile(join(dir, name))));
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Whether this installation gets the rtk nudge, decided once at load: the hint sits
 * in the system prompt, which must be byte-identical for the whole session (a
 * changing section flushes the prompt cache).
 */
export const RTK_INSTALLED = rtkOnPath();

/**
 * The search nudge for this installation: rtk's when it is installed, else the
 * built-in one. `rtk` is the take, not the requirement — the extension works
 * either way.
 */
export function searchHint(rtk: boolean = RTK_INSTALLED): string {
	return rtk ? RTK_SEARCH_HINT : BUILTIN_SEARCH_HINT;
}

/** Tools whose `path` argument names what they read. */
const PATH_READ_TOOLS = ["read", ...BUILTIN_SEARCH_TOOLS];

/**
 * Asks shared by every mode: secrets (always ask) and the first reads
 * outside the working directory (until "allow reads outside the cwd").
 */
const READ_SAFETY_RULES: ModeRules["rules"] = [
	{ tools: PATH_READ_TOOLS, match: "secretFile", action: "ask" },
	{ tools: ["bash"], match: "secretBash", action: "ask" },
	// first, so a search over another tree offers that directory (the gate it would
	// unlock) instead of a secret ask nobody can grant; both are asks, so the order
	// only decides which dialog the user sees
	{ tools: [...PATH_READ_TOOLS, "bash"], match: "outsideCwdRead", action: "ask" },
	// ask beats the read-only and remembered allows: a rule for `grep` never covers `grep -r` over a .env
	{ tools: ["bash"], match: "secretSearch", action: "ask" },
	// uploading a secret file (`curl -d @.env`) asks in auto too
	{ tools: ["bash"], match: "secretUpload", action: "ask" },
];

/** Read tools the modes activate (built-in search tools are added by the flag). */
const ACTIVE_READ_TOOLS = READ_TOOLS.filter((name) => !BUILTIN_SEARCH_TOOLS.includes(name));
const WRITE_TOOLS = ["edit", "write"];
const SHELL_TOOLS = ["bash", "powershell"];

export const MODES: Record<ModeName, ModeDefinition> = {
	default: {
		name: "default",
		// Write tools stay declared so the model can attempt them and the user
		// gets a permission dialog. `exit_plan_mode` is declared in every mode so the
		// tool list is identical in all of them (a per-mode list changes the request
		// prefix, which flushes the cache and, behind some gateways, fails signed-thinking
		// sessions); the rule below denies it here.
		tools: [...ACTIVE_READ_TOOLS, ...WRITE_TOOLS, "bash", "mcp", EXIT_PLAN_TOOL],
		badge: "default",
		icon: "●",
		color: "mdLink",
		description: "everyday work: reads run, edits and other commands ask",
		prompt: loadPrompt("default-mode.md"),
		permissions: {
			fallback: "ask",
			rules: [
				{ tools: [...READ_TOOLS, ...LAUNCH_TOOLS], action: "allow" },
				{ tools: CHILD_PROTOCOL_TOOLS, match: "childSession", action: "allow" },
				{ tools: ["bash"], match: "readOnlyBash", action: "allow" },
				{ tools: ["bash"], match: "rememberedBash", action: "allow" },
				// a whole command approved for the session; plan mode ignores it, so planning stays read-only
				{ tools: ["bash"], match: "rememberedVerbatim", action: "allow" },
				// persisted per-project allow rules; plan mode ignores them
				{ tools: ["bash"], match: "projectAllowBash", action: "allow" },
				// tools declaring readOnlyHint (MCP): no dialog
				{ tools: [ANY_TOOL], match: "readOnlyTool", action: "allow" },
				// ask beats allow: a remembered `git` never covers `git push`
				{ tools: SHELL_TOOLS, match: "dangerousBash", action: "ask" },
				// "Yes, allow all edits this session": the asks below still win
				{ tools: WRITE_TOOLS, match: "scratchFile", action: "allow" },
				// the session plan file: the model ticks off steps while executing the plan
				{ tools: WRITE_TOOLS, match: "planFile", action: "allow" },
				// a subagent child's own report (pi-subagents output dir)
				{ tools: WRITE_TOOLS, match: "subagentArtifact", action: "allow" },
				{ tools: WRITE_TOOLS, match: "sessionEdits", action: "allow" },
				{ tools: WRITE_TOOLS, match: "protectedPath", action: "ask" },
				{ tools: WRITE_TOOLS, match: "outsideCwd", action: "ask" },
				{ tools: WRITE_TOOLS, match: "secretFile", action: "ask" },
				...READ_SAFETY_RULES,
				{ tools: [EXIT_PLAN_TOOL], action: "deny" },
			],
		},
	},
	auto: {
		name: "auto",
		tools: [...ACTIVE_READ_TOOLS, ...WRITE_TOOLS, "bash", "mcp", EXIT_PLAN_TOOL],
		badge: "auto",
		icon: "⏵⏵",
		color: "warning",
		description: "a trusted task: nearly everything runs; dangerous, secret and outside actions ask",
		prompt: loadPrompt("auto-mode.md"),
		permissions: {
			fallback: "allow",
			rules: [
				{ tools: SHELL_TOOLS, match: "dangerousBash", action: "ask" },
				// shell writes to a literal path outside the cwd (unresolvable targets stay allowed)
				{ tools: SHELL_TOOLS, match: "outsideCwdBashWrite", action: "ask" },
				// rm, mv, truncate, find -delete, git checkout/clean/... aimed outside the cwd; unlike
				// the write rule above, a target that can't be resolved (`rm $X`) asks too
				{ tools: SHELL_TOOLS, match: "outsideCwdDestructive", action: "ask" },
				{ tools: WRITE_TOOLS, match: "scratchFile", action: "allow" },
				{ tools: WRITE_TOOLS, match: "planFile", action: "allow" },
				{ tools: WRITE_TOOLS, match: "subagentArtifact", action: "allow" },
				{ tools: WRITE_TOOLS, match: "protectedPath", action: "ask" },
				{ tools: WRITE_TOOLS, match: "outsideCwd", action: "ask" },
				{ tools: WRITE_TOOLS, match: "secretFile", action: "ask" },
				...READ_SAFETY_RULES,
				{ tools: [EXIT_PLAN_TOOL], action: "deny" },
			],
		},
	},
	plan: {
		name: "plan",
		// edit/write must be active so the plan file can be written; every
		// other target is denied by the rules below.
		tools: [...ACTIVE_READ_TOOLS, ...WRITE_TOOLS, "bash", "mcp", EXIT_PLAN_TOOL],
		badge: "plan",
		icon: "⏸",
		color: "success",
		description: "researching and writing a plan: read-only except the plan file",
		prompt: loadPrompt("plan-mode.md"),
		permissions: {
			// Allowlist: any tool not named here (mcp, powershell, tools from
			// other packages, codemode tools) is denied.
			fallback: "deny",
			rules: [
				{ tools: [...READ_TOOLS, ...LAUNCH_TOOLS, EXIT_PLAN_TOOL], action: "allow" },
				{ tools: CHILD_PROTOCOL_TOOLS, match: "childSession", action: "allow" },
				// read-only MCP tools fit research; every other unknown tool stays denied
				{ tools: [ANY_TOOL], match: "readOnlyTool", action: "allow" },
				{ tools: ["bash"], match: "readOnlyBash", action: "allow" },
				// "Yes, and always allow" prefixes are shared with default mode
				{ tools: ["bash"], match: "rememberedBash", action: "allow" },
				// A dangerous command is never context-gathering: denied, so the
				// model puts the step in the plan. Beats every allow above.
				{ tools: ["bash"], match: "dangerousBash", action: "deny" },
				// e.g. running tests or a build to gather context: the user decides.
				// Bash only: other shells stay denied.
				{ tools: ["bash"], match: "unapprovedBash", action: "ask" },
				{ tools: WRITE_TOOLS, match: "planFile", action: "allow" },
				// a subagent child's own report (pi-subagents output dir)
				{ tools: WRITE_TOOLS, match: "subagentArtifact", action: "allow" },
				// the session scratch dir: notes, repros, cloned references
				{ tools: WRITE_TOOLS, match: "scratchFile", action: "allow" },
				...READ_SAFETY_RULES,
			],
		},
	},
};

/** The theme calls the footer chip needs (a subset of pi's Theme). */
export interface StatusTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

/**
 * Footer chip, styled here; pi-cc-extensions' footer passes the colors through as sent.
 * Bold `<icon> <badge>` in the mode color, plus a dim ` · ` and yellow `edits` while
 * session edits are allowed.
 */
export function formatModeStatus(theme: StatusTheme, mode: ModeName, edits: boolean): string {
	const { color, icon, badge } = MODES[mode];
	const chip = theme.bold(theme.fg(color, `${icon} ${badge}`));
	return edits ? chip + theme.fg("dim", " · ") + theme.bold(theme.fg("warning", "edits")) : chip;
}

/** Rules prepended to every mode. Deny wins over everything. */
export const GLOBAL_RULES: ModeRules["rules"] = [
	{ tools: SHELL_TOOLS, match: "privilegedBash", action: "deny" },
	// no subagent launch unless its children will load this extension (not even in auto);
	// both launch names: the workflow children behind `subagent_launch` are children too
	{ tools: LAUNCH_TOOLS, match: "bridgeInactive", action: "deny" },
	// user rules from .pi/settings.local.json: deny and ask apply in every mode
	{ tools: SHELL_TOOLS, match: "projectDeny", action: "deny" },
	{ tools: SHELL_TOOLS, match: "projectAsk", action: "ask" },
];

/** Every tool any mode activates; tools outside this set are preserved as-is. */
export const MANAGED_TOOLS = new Set<string>(Object.values(MODES).flatMap((m) => m.tools));

/** Ctrl+Shift+M / Alt+M cycle in this order. */
export const MODE_CYCLE: ModeName[] = ["default", "auto", "plan"];

/**
 * The closing instruction of each mode, the last line of its mode message: what to
 * do now that the mode changed. The mode prompt above it carries the rules; this
 * only names the next step, so it never repeats the mode's own text.
 */
export const MODE_ANNOUNCEMENTS: Record<ModeName, string> = {
	default: "Continue the task.",
	auto: "Continue the task.",
	plan: "Call `exit_plan_mode` when the plan file is ready.",
};

/**
 * The short announcement steered mid-run under `modeInstructions: "prompt"`, where the mode
 * text sits in the system prompt and is only recomposed on the next prompt: it says what
 * changed now and why earlier restrictions are void, without repeating the mode's own text.
 */
export const MODE_CHANGE_NOTICES: Record<ModeName, string> = {
	default:
		"default mode: file edits and non-read-only bash now ask the user (a permission dialog is shown). Plan-mode and earlier permission instructions no longer apply. Continue the task.",
	auto: "auto mode: file edits and bash now run without asking; only dangerous commands, protected paths, changes outside the working directory and secrets still ask. Plan-mode and earlier permission restrictions no longer apply. Continue the task.",
	plan: "plan mode: read-only research. Write the plan to the plan file, then call exit_plan_mode. Commands that are not read-only ask the user: use them only to gather context. Dangerous commands are denied: put them in the plan.",
};

/** Deny reason for privilege escalation (all modes). */
export const PRIVILEGE_REASON =
	"Commands needing elevated privileges (sudo, su, doas, pkexec, run0) are never run by you. Give the user the exact command to run themselves (they can type `! <command>` in pi), explain why it is needed, then stop and wait for the user to confirm it is done before continuing.";

// ---------------------------------------------------------------------------
// Command analysis lists (used by utils.ts)
// ---------------------------------------------------------------------------

/**
 * Bash commands considered read-only in default and plan modes. Roots with
 * subcommand or flag restrictions are validated further in utils.ts.
 */
export const READ_ONLY_BASH_COMMANDS: string[] = [
	// File inspection (less/more excluded: interactive `!` shell escapes; they are INTERPRETERS)
	"cat",
	"head",
	"tail",
	"wc",
	"file",
	"stat",
	"diff",
	"cmp",
	"nl",
	// Text processing (stdout only)
	"sort",
	"uniq",
	"cut",
	"tr",
	"column",
	"jq",
	"sed", // only with a script the analyzer in utils.ts (sedBlocker) fully understands
	// Search
	"find",
	"fd",
	"grep",
	"rg",
	// Paths / directories
	"ls",
	"pwd",
	"tree",
	"du",
	"df",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"cd",
	// Subcommand-checked
	"git",
	"rtk",
	"node",
	"npm",
	"pnpm",
	"yarn",
	// Subcommand-checked service CLIs (query subcommands only; see utils.ts)
	"gh",
	"kubectl",
	"docker",
	"podman",
	// Environment listing (`env` with no command, `printenv [NAME…]`)
	"env",
	"printenv",
	// System info
	"uname",
	"whoami",
	"id",
	"hostname",
	"date",
	"uptime",
	"which",
	"type",
	// Shell builtins with no side effects
	"echo",
	"printf",
	"true",
	"false",
	"test",
	"[",
];

/**
 * Flag matchers. `exact`/`prefixes` match whole args; `shortLetters` match
 * inside single-dash clusters (`-Hx` contains `x`).
 */
export interface FlagSpec {
	exact?: string[];
	prefixes?: string[];
	shortLetters?: string;
	/** Long options (`--name`): matched as `--name`, `--name=…` and any getopt abbreviation (`--use-c`). */
	longs?: string[];
}

/**
 * Flags that make an otherwise read-only command run a program, hang, or
 * write somewhere that can't be named (effect "exec": never covered by a
 * rule). The flags that write a nameable file (`sort -o`, `tree -o`) are in
 * OUTPUT_FLAGS instead.
 */
export const WRITE_FLAGS: Record<string, FlagSpec> = {
	find: { exact: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls"], prefixes: ["-fprint"] },
	fd: { exact: ["--exec", "--exec-batch"], prefixes: ["--exec=", "--exec-batch="], shortLetters: "xX" },
	// --hostname-bin runs its value to build hyperlinks
	rg: { exact: ["--pre", "--hostname-bin"], prefixes: ["--pre=", "--hostname-bin="] },
	// tree -R writes 00Tree.html files
	tree: { exact: ["--fromfile"], shortLetters: "R" },
	// --compress-program runs its value
	sort: { longs: ["--compress-program"] },
	file: {
		exact: ["--compile", "--magic-file", "--files-from"],
		prefixes: ["--magic-file=", "--files-from="],
		shortLetters: "Cmf",
	},
	tail: { exact: ["--follow"], prefixes: ["--follow="], shortLetters: "fF" },
	date: { exact: ["-s", "--set"], prefixes: ["--set=", "-s"] },
	printf: { exact: ["-v"] },
};

/**
 * Output-file flags of read-only commands: the value is a write target
 * (effect "write", coverable when the target is inside the project).
 * `valueShort` lists the other short options that take a value (their text
 * is not scanned for flags); `attached` allows `-ofile`.
 */
export const OUTPUT_FLAGS: Record<string, { short: string; longs: string[]; valueShort: string; attached: boolean }> = {
	sort: { short: "o", longs: ["--output"], valueShort: "kStT", attached: true },
	tree: { short: "o", longs: [], valueShort: "PIHTL", attached: false },
};

/**
 * Roots whose args can be turned into flags or extra operands by an
 * unquoted glob, brace, or `$` expansion (a file named `-delete` makes
 * `find *` destructive; `uniq *` writes its second file). → not read-only,
 * and exec-effect: the targets are unknowable.
 */
export const GLOB_SENSITIVE_COMMANDS = new Set(["find", "fd", "rg", "git", "sort", "tree", "file", "uniq", "sed", "gh", "kubectl", "docker", "podman"]);

/**
 * Commands that only write files named by their operands. Not read-only;
 * a remembered rule covers one only when every target passes the project
 * check (utils.ts `targetProblem`). Flags are listed so a value
 * (`install -m 644`, `truncate -s 0`) is never mistaken for a target: an
 * unlisted flag makes the targets unknown (not covered). `dir` = `-t` /
 * `--target-directory` names a destination directory. Every operand counts
 * as a target, sources of cp/mv/ln/install included (reading an outside or
 * secret file into the project should ask, and mv removes its sources).
 * Removals (rm, rmdir, unlink, shred) are NEVER_REMEMBER, not here.
 * The extractor is `fileWriterTargets` in utils.ts (it reads this table).
 */
export interface WriterSpec {
	/** Short flags without a value. */
	flags: string;
	/** Short flags taking a value (next word, or attached). */
	valueFlags: string;
	/** Long flags without a value. */
	longs: string[];
	/** Long flags with a value (`--x=v` or `--x v`). */
	valueLongs: string[];
	/** Long flags with an optional attached value (`--backup[=CTL]`). */
	optionalLongs: string[];
	/** `-t` / `--target-directory` take a destination directory. */
	dir?: boolean;
}

export const FILE_WRITERS: Record<string, WriterSpec> = {
	cp: {
		flags: "abcdfHiLlnPpRrsTuUvxZ",
		valueFlags: "S",
		longs: ["archive", "attributes-only", "copy-contents", "debug", "dereference", "force", "interactive", "link", "no-clobber", "no-dereference", "no-target-directory", "one-file-system", "parents", "recursive", "remove-destination", "strip-trailing-slashes", "symbolic-link", "verbose"],
		valueLongs: ["suffix", "no-preserve", "sparse"],
		optionalLongs: ["backup", "preserve", "reflink", "update", "context"],
		dir: true,
	},
	mv: {
		flags: "bfinTuvZ",
		valueFlags: "S",
		longs: ["debug", "force", "interactive", "no-clobber", "no-target-directory", "strip-trailing-slashes", "verbose"],
		valueLongs: ["suffix"],
		optionalLongs: ["backup", "update", "context"],
		dir: true,
	},
	ln: {
		flags: "bdFfiLnPrsTv",
		valueFlags: "S",
		longs: ["directory", "force", "interactive", "logical", "no-dereference", "no-target-directory", "physical", "relative", "symbolic", "verbose"],
		valueLongs: ["suffix"],
		optionalLongs: ["backup"],
		dir: true,
	},
	// -s / --strip-program run a program: left out, so they make the targets unknown
	install: {
		flags: "bCcDdpTv",
		valueFlags: "gmoS",
		longs: ["compare", "debug", "directory", "no-target-directory", "preserve-timestamps", "verbose"],
		valueLongs: ["group", "mode", "owner", "suffix"],
		optionalLongs: ["backup", "context"],
		dir: true,
	},
	mkdir: { flags: "pvZ", valueFlags: "m", longs: ["parents", "verbose"], valueLongs: ["mode"], optionalLongs: ["context"] },
	touch: {
		flags: "acfhm",
		valueFlags: "drtA",
		longs: ["no-create", "no-dereference"],
		valueLongs: ["date", "reference", "time"],
		optionalLongs: [],
	},
	tee: { flags: "aip", valueFlags: "", longs: ["append", "ignore-interrupts"], valueLongs: [], optionalLongs: ["output-error"] },
	truncate: { flags: "co", valueFlags: "rs", longs: ["no-create", "io-blocks"], valueLongs: ["reference", "size"], optionalLongs: [] },
};

/**
 * Commands that write only where specific options say (not "every operand",
 * as FILE_WRITERS). Same coverage rule: a remembered rule covers one only
 * when every target stays in the project, and auto asks for a literal target
 * outside it. A flag that isn't listed (it might take a value, or write
 * somewhere) makes the targets unknown. The extractor is `outputWriterTargets`
 * in utils.ts; the per-command meaning of the flags is documented there.
 * Tables are deliberately small: the common flags of each tool, no more.
 */
export interface OptionSpec {
	/** Short flags without a value. */
	flags: string;
	/** Short flags taking a value that is not a write target (next word, or attached). */
	valueFlags: string;
	/** Short flags taking a value that is a path the command writes or extracts into. */
	outFlags: string;
	/** Short flags followed by a list of words up to the next flag (`zip -x a b`). */
	listFlags: string;
	/** Long flags without a value (`--no-<name>` is accepted too). */
	longs: string[];
	/** Long flags with a value that is not a target. */
	valueLongs: string[];
	/** Long flags with a value that is a path written. */
	outLongs: string[];
}

export const OUTPUT_WRITERS: Record<string, OptionSpec> = {
	// -o/--output, -c/--cookie-jar, -D/--dump-header, --trace*, --stderr, --etag-save and --output-dir
	// write; -O/--remote-name writes into the cwd. -K/--config and --next are left out (unknown).
	curl: {
		flags: "0123456#GIJLNORSZafghijklnpqsvV",
		valueFlags: "AbCdeEFHmPQrTuUwxXyYzt",
		outFlags: "ocD",
		listFlags: "",
		longs: ["silent", "show-error", "location", "fail", "fail-with-body", "insecure", "include", "head", "verbose", "compressed", "globoff", "get", "no-progress-meter", "progress-bar", "remote-name", "remote-name-all", "remote-header-name", "create-dirs", "http1.1", "http2", "http3", "ipv4", "ipv6", "no-buffer", "netrc", "raw", "tcp-nodelay", "junk-session-cookies", "location-trusted", "remote-time", "parallel", "retry-connrefused", "retry-all-errors", "negotiate", "anyauth", "basic", "digest", "ntlm", "tlsv1.2", "tlsv1.3", "path-as-is", "disable", "list-only", "fail-early"],
		valueLongs: ["header", "request", "user", "user-agent", "referer", "cookie", "max-time", "connect-timeout", "retry", "retry-delay", "retry-max-time", "proxy", "proxy-user", "cert", "cacert", "capath", "key", "resolve", "write-out", "range", "url", "upload-file", "limit-rate", "proto", "proto-redir", "oauth2-bearer", "aws-sigv4", "time-cond", "continue-at", "request-target", "max-redirs", "expect100-timeout", "interface", "noproxy", "keepalive-time", "data", "data-raw", "data-binary", "data-ascii", "data-urlencode", "json", "form", "form-string", "max-filesize", "speed-limit", "speed-time", "connect-to", "unix-socket", "ciphers", "pinnedpubkey", "quote"],
		outLongs: ["output", "output-dir", "cookie-jar", "dump-header", "trace", "trace-ascii", "stderr", "etag-save"],
	},
	// -O/--output-document and -P/--directory-prefix; with neither it saves into the cwd.
	// -o/-a (log files) and --save-cookies write too. -e/--execute is left out (wgetrc commands).
	wget: {
		flags: "cdhkmnpqrvxEFHKLNSV46",
		valueFlags: "tTwQlUiBARDIX",
		outFlags: "OPoa",
		listFlags: "",
		longs: ["quiet", "verbose", "no-verbose", "continue", "recursive", "no-clobber", "no-parent", "no-directories", "no-host-directories", "timestamping", "mirror", "convert-links", "page-requisites", "no-check-certificate", "content-disposition", "adjust-extension", "server-response", "spider", "show-progress", "inet4-only", "inet6-only", "no-cache", "no-cookies", "force-directories", "span-hosts", "relative", "backup-converted"],
		valueLongs: ["tries", "timeout", "wait", "waitretry", "read-timeout", "dns-timeout", "connect-timeout", "limit-rate", "user-agent", "referer", "header", "user", "password", "http-user", "http-password", "post-data", "post-file", "body-data", "body-file", "level", "accept", "reject", "domains", "include-directories", "exclude-directories", "bind-address", "quota", "input-file", "base", "load-cookies", "method"],
		outLongs: ["output-document", "directory-prefix", "output-file", "append-output", "save-cookies"],
	},
	// creating (-c -r -u -A): -f/--file is written; extracting (-x): -C/--directory, else the cwd;
	// listing/diffing (-t -d): nothing. No mode, or two, makes the targets unknown. Program flags
	// (--to-command, -I, ...) are PROGRAM_FLAGS; --remove-files and --listed-incremental are unlisted.
	tar: {
		flags: "cruxtAdzjJavpPkhmoOSUwWBl",
		valueFlags: "XTbNVH",
		outFlags: "fC",
		listFlags: "",
		longs: ["create", "append", "update", "catenate", "concatenate", "extract", "get", "list", "diff", "compare", "gzip", "gunzip", "ungzip", "bzip2", "xz", "zstd", "lzma", "lzop", "auto-compress", "verbose", "preserve-permissions", "same-permissions", "no-same-permissions", "same-owner", "no-same-owner", "numeric-owner", "keep-old-files", "keep-newer-files", "skip-old-files", "overwrite", "unlink-first", "one-file-system", "dereference", "hard-dereference", "absolute-names", "anchored", "wildcards", "totals", "sparse", "ignore-failed-read", "ignore-zeros", "verify", "recursion", "touch", "exclude-vcs", "exclude-caches", "exclude-backups", "no-overwrite-dir", "preserve", "acls", "xattrs", "selinux", "null"],
		valueLongs: ["exclude", "exclude-from", "files-from", "transform", "xform", "strip-components", "owner", "group", "mode", "mtime", "format", "newer", "newer-mtime", "blocking-factor", "label"],
		outLongs: ["file", "directory"],
	},
	// the archive operand is written (-O/--output-file names it instead; -b/--temp-path is a temp dir).
	// -m (moves: deletes the sources) and -d (deletes entries) are left out. -T/-TT are PROGRAM_FLAGS.
	zip: {
		flags: "rqjDXyufgvV0123456789",
		valueFlags: "tnPs",
		outFlags: "Ob",
		listFlags: "ix",
		longs: ["recurse-paths", "quiet", "junk-paths", "no-dir-entries", "no-extra", "symlinks", "update", "freshen", "filesync", "verbose"],
		valueLongs: ["password", "split-size"],
		outLongs: ["output-file", "temp-path"],
	},
	// extracts into -d DIR, else the cwd; -l -t -p -v only list, test or print.
	unzip: { flags: "oqnjaCLMUXVKfuvltpT", valueFlags: "P", outFlags: "d", listFlags: "x", longs: [], valueLongs: [], outLongs: [] },
	// the last operand (the destination) is written; a remote `host:path` counts as outside.
	// -e/--rsh/--rsync-path are PROGRAM_FLAGS; --remove-source-files is unlisted (deletes the sources).
	rsync: {
		flags: "avzrlptgoDHnPucxhqiSWRbLKkmyAXOJUE8",
		valueFlags: "fB",
		outFlags: "T",
		listFlags: "",
		longs: ["archive", "verbose", "compress", "recursive", "links", "perms", "times", "group", "owner", "devices", "specials", "dry-run", "progress", "update", "checksum", "partial", "inplace", "append", "append-verify", "delete", "delete-before", "delete-during", "delete-after", "delete-excluded", "human-readable", "stats", "itemize-changes", "whole-file", "relative", "backup", "copy-links", "copy-dirlinks", "keep-dirlinks", "hard-links", "xattrs", "acls", "sparse", "one-file-system", "prune-empty-dirs", "quiet", "numeric-ids", "list-only", "existing", "ignore-existing", "size-only", "ignore-times", "omit-dir-times", "mkpath", "protect-args", "cvs-exclude", "delay-updates", "fuzzy"],
		valueLongs: ["exclude", "include", "exclude-from", "include-from", "filter", "files-from", "port", "bwlimit", "timeout", "contimeout", "chmod", "chown", "usermap", "groupmap", "max-size", "min-size", "suffix", "password-file", "link-dest", "copy-dest", "compare-dest", "info", "debug", "modify-window", "block-size", "iconv", "skip-compress", "sockopts", "address", "max-delete", "compress-level", "out-format"],
		outLongs: ["backup-dir", "temp-dir", "partial-dir", "log-file", "write-batch", "only-write-batch"],
	},
};

/**
 * Flags that make a command that is NOT read-only run a program (checked
 * before the read-only list, so a remembered prefix such as `tar` never
 * covers them: they always ask). Small on purpose: single-token commands
 * that "Yes, and always allow" would otherwise remember. Same matching as
 * WRITE_FLAGS.
 */
export const PROGRAM_FLAGS: Record<string, FlagSpec> = {
	// --to-command / --checkpoint-action=exec / compress, info and rsh programs; old-style `tar xIf prog`
	tar: {
		longs: ["--to-command", "--checkpoint-action", "--use-compress-program", "--info-script", "--new-volume-script", "--rsh-command"],
		shortLetters: "IF",
	},
	// -e / --rsh and --rsync-path run a program
	rsync: { longs: ["--rsh", "--rsync-path"], shortLetters: "e" },
	// -T tests with unzip, -TT <cmd> runs <cmd>
	zip: { exact: ["-T", "-TT"], prefixes: ["-TT"], longs: ["--unzip-command", "--test"] },
	// -S <program> and -o ProxyCommand=… run programs
	scp: { shortLetters: "So" },
	sftp: { shortLetters: "So" },
	// pager / browser programs
	man: { longs: ["--pager", "--html", "--browser"], shortLetters: "PHB" },
};

/** Git subcommands that only read (no further arg checks). */
export const READ_ONLY_GIT_SUBCOMMANDS: string[] = [
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"cat-file",
	"shortlog",
	"describe",
	"grep",
	"merge-base",
	"rev-list",
	"for-each-ref",
	"name-rev",
];
// Also read-only with arg checks in utils.ts: branch (list forms), tag
// (list forms), remote (-v/show/get-url), stash list/show, reflog [show],
// worktree list, config --get/--list.

/** npm-family subcommands that only read. `run` executes scripts. */
export const READ_ONLY_PACKAGE_SUBCOMMANDS: Record<string, string[]> = {
	npm: ["list", "ls", "outdated", "info", "view"],
	pnpm: ["list", "ls", "outdated", "info", "why"],
	yarn: ["list", "info", "outdated", "why"],
};

/** gh command groups and the subcommands of them that only read (`gh api` is checked on its own). */
export const READ_ONLY_GH_GROUPS = ["pr", "issue", "run", "repo", "release"];
export const READ_ONLY_GH_SUBCOMMANDS = ["view", "list", "diff", "status", "checks"];

/** kubectl subcommands that only query the cluster. */
export const READ_ONLY_KUBECTL_SUBCOMMANDS = ["get", "describe", "logs", "top", "explain", "version", "api-resources"];

/** docker / podman subcommands that only query the engine. */
export const READ_ONLY_CONTAINER_SUBCOMMANDS = ["ps", "images", "inspect", "logs", "version", "info"];

/**
 * rtk subcommands that only read/filter. `rtk env` is excluded (prints
 * environment secrets). `rtk git|find|rg` follow the native checks.
 */
export const READ_ONLY_RTK_SUBCOMMANDS: string[] = [
	"ls",
	"tree",
	"read",
	"smart",
	"grep",
	"wc",
	"diff",
	"log",
	"json",
	"deps",
	"help",
	"gain",
	"cc-economics",
	"discover",
	"session",
];

/**
 * Leading env assignments that keep a command read-only (a short allowlist of
 * display and locale variables). Any other assignment makes it not read-only.
 */
export const SAFE_ENV_VARS = new Set(["LANG", "LANGUAGE", "NO_COLOR", "TERM", "FORCE_COLOR", "CI", "NODE_ENV", "RUST_BACKTRACE", "TZ", "COLUMNS", "PAGER", "GIT_PAGER"]);
export const SAFE_ENV_PREFIXES = ["LC_"];

/** Wrappers stripped before matching (they run their argument). */
export const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob", "xargs"]);

/** Shells whose `-c <script>` argument is analyzed recursively. */
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/**
 * Commands that run arbitrary code: "Yes, and always allow" is never offered for
 * them (a remembered `python` prefix would allow everything).
 */
export const INTERPRETERS = new Set([
	...SHELLS,
	// awk: system(), pipes, `print > file`, getline from a command (busybox runs any applet)
	"awk",
	"gawk",
	"mawk",
	"nawk",
	"busybox",
	// editors and pagers with shell escapes (`:!cmd`, `!cmd`)
	"vim",
	"vi",
	"view",
	"vimdiff",
	"nvim",
	"emacs",
	"nano",
	"pico",
	"ed",
	"ex",
	"less",
	"more",
	// other scripting languages / debuggers
	"lua",
	"luajit",
	"tclsh",
	"expect",
	"Rscript",
	"julia",
	"gdb",
	"python",
	"python3",
	"node",
	"deno",
	"bun",
	"perl",
	"ruby",
	"php",
	"eval",
	"exec",
	"source",
	".",
	"env",
	"npx",
	"bunx",
	"pnpx",
	"ssh",
	"watch",
	"parallel",
]);

/**
 * Roots whose subcommands name what they do, so removal subcommands are
 * looked for after them (`git rm`, `docker rmi`). Roots listed in
 * COMMAND_ARITY count too. The remembered prefix depth comes from
 * COMMAND_ARITY.
 */
export const MULTI_COMMAND_TOOLS = new Set([
	"git",
	"npm",
	"pnpm",
	"yarn",
	"cargo",
	"go",
	"uv",
	"pip",
	"pip3",
	"poetry",
	"make",
	"just",
	"docker",
	"podman",
	"kubectl",
	"oc",
	"helm",
	"gh",
	"terraform",
	"tofu",
	"systemctl",
	"brew",
	"dnf",
	"apt",
	"mvn",
	"gradle",
	"dotnet",
]);

/** Subcommands that run a named script: the script name joins the prefix. */
export const RUNNER_SUBCOMMANDS = new Set(["run", "exec", "x", "dlx", "run-script"]);

/**
 * Removals always ask: never offered for "Yes, and always allow" and never covered
 * by a remembered prefix, as a root (`rm`) or a subcommand (`git rm`,
 * `docker rm`).
 */
export const NEVER_REMEMBER = new Set(["rm", "rmdir", "unlink", "shred"]);

/**
 * Subcommands that remove things (`git rm`, `docker container rm`,
 * `docker rmi`, `pip uninstall`). Matched in the first subcommand
 * positions, after global flags, so `git -C . rm` is still a removal.
 */
export const REMOVAL_SUBCOMMANDS = new Set(["rm", "rmi", "rmdir", "remove", "uninstall", "prune", "purge"]);

/** rtk subcommands that run the command given in their args (`rtk test cargo test`). */
export const RTK_RUNNERS = new Set(["proxy", "err", "test", "summary"]);

/**
 * rtk subcommands that are 1:1 proxies of the real command of the same name
 * (`rtk git add` runs `git add`; `rtk rewrite` maps `git status` →
 * `rtk git status`), only filtering the output. They canonicalize to the
 * real command. Left out on purpose: rtk-native commands and name
 * collisions (`read`, `test`, `diff`, `log`, `ls`, `find`, `grep`, `err`,
 * `summary`, `json`, `env`, `run`), renames (`lint` = eslint, `next` =
 * next build, `format`), `pnpm` (has rtk-only subcommands such as
 * `typecheck`) and `wget` (own syntax).
 */
export const RTK_PROXY_COMMANDS = new Set([
	"git",
	"gh",
	"glab",
	"gt",
	"aws",
	"psql",
	"npm",
	"npx",
	"docker",
	"kubectl",
	"dotnet",
	"cargo",
	"go",
	"golangci-lint",
	"pip",
	"pytest",
	"ruff",
	"mypy",
	"tsc",
	"rake",
	"rubocop",
	"rspec",
	"jest",
	"vitest",
	"playwright",
	"prisma",
	"curl",
]);

/**
 * rtk global flags that only change how output is displayed (checked with
 * `rtk --help`): `-v`, `-vv`, `-vvv`, `--verbose`, `--ultra-compact`. Any
 * other flag before the subcommand (`--skip-env` sets a child env var) means
 * no canonicalization.
 */
export const RTK_DISPLAY_FLAGS = /^(-v{1,3}|--verbose|--ultra-compact)$/;

/**
 * How many leading tokens identify a command for "Yes, and always allow" (`git`: 2 →
 * `git commit`; `gh`: 3 → `gh pr create`). Longest key wins; a key only
 * appears when its arity differs from its parent's. Commands not listed use
 * their first token only. Adapted from OpenCode's permission/arity.ts (MIT):
 * https://github.com/anomalyco/opencode/blob/219b473e660994ac69a0c5d753ac65da951f3bf8/packages/opencode/src/permission/arity.ts
 * (see NOTICE).
 * Interpreters and removals are refused separately, so they are not listed.
 */
export const COMMAND_ARITY: Record<string, number> = {
	aws: 3,
	az: 3,
	bazel: 2,
	brew: 2,
	cargo: 2,
	"cargo add": 3,
	"cargo run": 3,
	cdk: 2,
	cmake: 2,
	composer: 2,
	consul: 2,
	"consul kv": 3,
	crictl: 2,
	dnf: 2,
	doctl: 3,
	docker: 2,
	"docker builder": 3,
	"docker compose": 3,
	"docker container": 3,
	"docker image": 3,
	"docker network": 3,
	"docker volume": 3,
	dotnet: 2,
	eksctl: 2,
	"eksctl create": 3,
	firebase: 2,
	flyctl: 2,
	gcloud: 3,
	gh: 3,
	git: 2,
	"git config": 3,
	"git remote": 3,
	"git stash": 3,
	glab: 3,
	go: 2,
	gradle: 2,
	apt: 2,
	helm: 2,
	heroku: 2,
	hugo: 2,
	ip: 2,
	"ip addr": 3,
	"ip link": 3,
	"ip netns": 3,
	"ip route": 3,
	just: 2,
	kind: 2,
	"kind create": 3,
	kubectl: 2,
	"kubectl kustomize": 3,
	"kubectl rollout": 3,
	kustomize: 2,
	make: 2,
	mc: 2,
	"mc admin": 3,
	minikube: 2,
	mvn: 2,
	ng: 2,
	npm: 2,
	"npm exec": 3,
	"npm init": 3,
	"npm run": 3,
	"npm view": 3,
	nx: 2,
	oc: 2,
	openssl: 2,
	"openssl req": 3,
	"openssl x509": 3,
	pip: 2,
	pip3: 2,
	pipenv: 2,
	pnpm: 2,
	"pnpm dlx": 3,
	"pnpm exec": 3,
	"pnpm run": 3,
	podman: 2,
	"podman container": 3,
	"podman image": 3,
	poetry: 2,
	"poetry run": 3,
	pulumi: 2,
	"pulumi stack": 3,
	rake: 2,
	rustup: 2,
	serverless: 2,
	skaffold: 2,
	sls: 2,
	sst: 2,
	swift: 2,
	systemctl: 2,
	terraform: 2,
	"terraform workspace": 3,
	tmux: 2,
	tofu: 2,
	turbo: 2,
	ufw: 2,
	uv: 2,
	"uv run": 3,
	vault: 2,
	"vault auth": 3,
	"vault kv": 3,
	vercel: 2,
	volta: 2,
	yarn: 2,
	"yarn dlx": 3,
	"yarn run": 3,
};

/** Privilege escalation — denied in every mode. */
export const PRIVILEGE_COMMANDS = new Set(["sudo", "sudoedit", "su", "doas", "pkexec", "run0"]);

/** Commands that execute another command given in their args. */
export const COMMAND_RUNNERS = new Set(["xargs", "find", "fd", "parallel", "watch", "setsid", "nohup", "exec", "eval", "script", "flock", "chroot", "unbuffer", "env", "nice", "timeout", "stdbuf", "time", "command"]);

/** Flags that disarm a safety guard; dangerous on any command. */
export const SAFETY_OFF_FLAGS = new Set(["--no-verify", "--insecure", "--dangerously-skip-permissions", "--yolo", "--no-sandbox"]);

/**
 * Dangerous commands (ask in default and auto). Matched per command unit
 * (after stripping wrappers/env) and inside `sh -c` / `eval` scripts.
 * `args` excludes the root. Accident guard, not a security boundary.
 */
export const DANGEROUS_COMMANDS: Record<string, (args: string[]) => boolean> = {
	git: (args) => isDangerousGit(args),
	npm: (args) => hasAny(args, ["publish", "unpublish", "deprecate"]) || isGlobalInstall(args),
	pnpm: (args) => hasAny(args, ["publish"]) || isGlobalInstall(args),
	yarn: (args) => hasAny(args, ["publish"]) || (args[0] === "global" && args[1] === "add"),
	cargo: (args) => hasAny(fromSubcommand(args, CARGO_GLOBAL_VALUE_FLAGS, true).slice(0, 1), ["publish", "yank"]),
	gem: (args) => hasAny(fromSubcommand(args, GEM_GLOBAL_VALUE_FLAGS).slice(0, 1), ["push", "yank"]),
	poetry: (args) => hasAny(fromSubcommand(args, POETRY_GLOBAL_VALUE_FLAGS).slice(0, 1), ["publish"]),
	twine: (args) => hasAny(fromSubcommand(args, TWINE_GLOBAL_VALUE_FLAGS).slice(0, 1), ["upload"]),
	docker: (args) => hasAny(fromSubcommand(args, DOCKER_GLOBAL_VALUE_FLAGS).slice(0, 2), ["push"]),
	podman: (args) => hasAny(fromSubcommand(args, PODMAN_GLOBAL_VALUE_FLAGS).slice(0, 2), ["push"]),
	gh: (args) => isDangerousGh(args),
	terraform: (args) => hasAny(args, ["apply", "destroy"]),
	tofu: (args) => hasAny(args, ["apply", "destroy"]),
	terragrunt: (args) => hasAny(args, ["apply", "destroy", "run-all"]),
	pulumi: (args) => hasAny(args, ["up", "destroy"]),
	cdk: (args) => hasAny(args, ["deploy", "destroy"]),
	kubectl: (args) => hasAny(args, KUBE_WRITE_VERBS),
	oc: (args) => hasAny(args, KUBE_WRITE_VERBS),
	helm: (args) => hasAny(args, ["install", "upgrade", "uninstall", "delete", "rollback"]),
	aws: (args) => args.some((a) => /^(delete|remove|terminate|destroy)/.test(a) || a === "rm" || a === "rb") || args.includes("--delete"),
	gcloud: (args) => args.some((a) => /^(delete|remove)/.test(a)),
	az: (args) => args.some((a) => /^(delete|remove)/.test(a)),
	ngrok: () => true,
	cloudflared: (args) => args.includes("tunnel"),
	ssh: (args) => args.some((a) => /^-[a-zA-Z]*R/.test(a)),
	nc: (args) => args.some((a) => /^-[a-zA-Z]*[le]/.test(a)),
	ncat: (args) => args.some((a) => /^-[a-zA-Z]*[le]/.test(a)),
	netcat: (args) => args.some((a) => /^-[a-zA-Z]*[le]/.test(a)),
	dd: () => true,
	shutdown: () => true,
	reboot: () => true,
	halt: () => true,
	poweroff: () => true,
	systemctl: (args) => hasAny(args, ["start", "stop", "restart", "enable", "disable", "mask", "kill", "isolate"]),
	chmod: (args) => args.some((a) => a === "--recursive" || /^-[a-zA-Z]*R/.test(a) || /^0?777$/.test(a)),
	chown: (args) => args.some((a) => a === "--recursive" || /^-[a-zA-Z]*R/.test(a)),
	crontab: (args) => args.some((a) => /^-[a-zA-Z]*[re]/.test(a)) || args.some((a) => !a.startsWith("-")),
};

/** Roots matched by prefix (mkfs, mkfs.ext4, ...). */
export const DANGEROUS_ROOT_PREFIXES = ["mkfs"];

/**
 * Raw-string patterns for forms the unit analysis can't see (download and
 * run, substitution as an rm target).
 */
export const DANGEROUS_RAW_PATTERNS: RegExp[] = [
	// curl/wget piped into a shell or interpreter
	/\b(curl|wget)\b[^;&\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/,
	/\b(curl|wget)\b[^;&\n]*\|\s*(sudo\s+)?(python3?|perl|ruby|node)\b/,
	// bash <(curl ...) / sh -c "$(curl ...)"
	/<\(\s*(curl|wget)\b/,
	/\$\(\s*(curl|wget)\b/,
	// anything piped into a shell as its script (`… | bash`, `… | sh -s`)
	/\|&?\s*(\S*\/)?(ba|z|da|k|fi)?sh(\s+-[a-zA-Z]+)*\s*($|[;&|)\n])/,
	/\|&?\s*(\S*\/)?(ba|z|da|k|fi)?sh\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*s\b/,
	// shell or source reading a process substitution (`bash <(…)`, `. <(…)`)
	/(^|[\s;&|(])(\S*\/)?((ba|z|da|k|fi)?sh|source|\.)\s+(-[a-zA-Z]+\s+)*<\(/,
	// rm whose target comes from command substitution
	/\brm\b[^;&|\n]*(\$\(|`)/,
];

/** Global options that take a separate value, per tool, placed before the subcommand. */
const DOCKER_GLOBAL_VALUE_FLAGS = new Set(["-H", "--host", "-c", "--context", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]);
const PODMAN_GLOBAL_VALUE_FLAGS = new Set(["-c", "--connection", "--url", "--identity", "--log-level", "--root", "--runroot", "--runtime", "--storage-driver", "--cgroup-manager", "--conmon", "--tmpdir", "--namespace"]);
const CARGO_GLOBAL_VALUE_FLAGS = new Set(["-C", "--config", "-Z", "--color"]);
const GEM_GLOBAL_VALUE_FLAGS = new Set(["-C", "--config-file"]);
const POETRY_GLOBAL_VALUE_FLAGS = new Set(["--directory"]);
const TWINE_GLOBAL_VALUE_FLAGS = new Set(["--config-file"]);
/** gh options that take a value; `-R` is accepted before the group and between group and action. */
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-H", "--hostname"]);

/**
 * The words from the subcommand on: leading options are skipped, and so is the
 * separate value of each option in `valueFlags` (`-H tcp://x`). `--flag=value`
 * is one word. With `skipToolchain`, a leading `+toolchain` word is skipped too.
 */
function fromSubcommand(args: string[], valueFlags: Set<string>, skipToolchain = false): string[] {
	let i = 0;
	while (i < args.length && (args[i].startsWith("-") || (skipToolchain && args[i].startsWith("+")))) {
		i += valueFlags.has(args[i]) ? 2 : 1;
	}
	return args.slice(i);
}

/** The non-option words of a gh command, so the group and action can follow options. */
function ghWords(args: string[]): string[] {
	const words: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (!args[i].startsWith("-")) words.push(args[i]);
		else if (GH_VALUE_FLAGS.has(args[i])) i++;
	}
	return words;
}

const KUBE_WRITE_VERBS = ["apply", "create", "delete", "replace", "patch", "edit", "scale", "drain", "cordon", "rollout", "taint"];

function hasAny(args: string[], words: string[]): boolean {
	return args.some((a) => words.includes(a));
}

function isGlobalInstall(args: string[]): boolean {
	return hasAny(args, ["i", "install", "add"]) && hasAny(args, ["-g", "--global"]);
}

function isDangerousGit(args: string[]): boolean {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		if (args[i] === "-C" || args[i] === "-c") i++;
		i++;
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	switch (sub) {
		case "push":
		case "filter-branch":
		case "filter-repo":
			return true;
		case "reset":
			return rest.includes("--hard");
		case "checkout":
			return rest.includes(".") || rest.includes(":/");
		case "restore":
			return rest.includes(".") || rest.includes(":/");
		case "clean":
			return rest.some((a) => a === "--force" || /^-[a-zA-Z]*f/.test(a));
		case "stash":
			return rest[0] === "drop" || rest[0] === "clear";
		case "commit":
			return rest.includes("--amend");
		case "branch":
			return rest.some((a) => a === "-D" || (/^-[a-zA-Z]*d/.test(a) && rest.some((b) => b === "-f" || b === "--force")));
		case "remote":
			return rest[0] === "add" || rest[0] === "set-url";
		case "config":
			return (hasAny(rest, ["--global", "--system"]) && !hasAny(rest, ["--get", "--get-all", "--get-regexp", "--list", "-l"])) || setsCodeRunningConfig(rest);
		default:
			return false;
	}
}

/**
 * Git config keys whose value makes git run a program (hooks, fsmonitor, ssh,
 * pager, editor, askpass, aliases, textconv/external diff and diff/merge
 * drivers, filters, credential helpers, includes, upload/receive hooks).
 * Matched on the lower-cased key; `*` stands for a subsection.
 */
const CODE_RUNNING_CONFIG_KEYS: RegExp[] = [
	/^core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass)$/,
	/^alias\./,
	/^diff\.external$/,
	/^diff\..+\.(textconv|command)$/,
	/^merge\..+\.driver$/,
	/^filter\./,
	/^credential\.(.+\.)?helper$/,
	/^include\.path$/,
	/^includeif\./,
	/^uploadpack\./,
	/^receive\./,
];

/** Config flags whose next word is a value, not the key. */
const CONFIG_VALUE_FLAGS = new Set(["-f", "--file", "--blob", "-t", "--type", "--default", "--comment"]);

/**
 * `git config <key> <value>` (also --add, --replace-all, `set`) for a
 * CODE_RUNNING_CONFIG_KEYS key, at local or worktree scope (--global and
 * --system are dangerous on their own). A key with a `$` can't be checked and
 * counts. Reads, --unset and removals don't.
 */
function setsCodeRunningConfig(rest: string[]): boolean {
	if (hasAny(rest, ["--get", "--get-all", "--get-regexp", "--list", "-l", "--unset", "--unset-all", "--remove-section", "--rename-section"])) return false;
	const words: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--") {
			words.push(...rest.slice(i + 1));
			break;
		}
		if (a.startsWith("-") && a !== "-") {
			if (CONFIG_VALUE_FLAGS.has(a)) i++;
			continue;
		}
		words.push(a);
	}
	if (words[0] === "set") words.shift();
	else if (words[0] === "get" || words[0] === "list" || words[0] === "unset") return false;
	if (words.length < 2) return false;
	const key = words[0].toLowerCase();
	return key.includes("$") || CODE_RUNNING_CONFIG_KEYS.some((pattern) => pattern.test(key));
}

function isDangerousGh(args: string[]): boolean {
	const [group, action] = ghWords(args);
	if (group === "release") return action === "create" || action === "delete" || action === "upload";
	if (group === "pr") return action === "merge" || (action === "review" && hasAny(args, ["--approve", "-a"]));
	if (group === "repo") return hasAny([action ?? ""], ["delete", "edit", "archive", "rename"]);
	if (group === "secret" || group === "variable") return action === "set" || action === "delete";
	if (group === "api") {
		const methodIdx = args.findIndex((a) => a === "-X" || a === "--method");
		if (methodIdx !== -1) return (args[methodIdx + 1] ?? "").toUpperCase() !== "GET";
		const inline = args.find((a) => a.startsWith("--method=") || /^-X[A-Za-z]/.test(a));
		if (inline !== undefined) return !/GET$/i.test(inline);
		// -f/-F/--input default the method to POST
		return args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a));
	}
	return false;
}

/**
 * Protected paths (ask in auto). Directories match any path segment;
 * files match the basename. `~/.pi/agent` (pi's own settings, extensions,
 * sessions) is protected separately in utils.ts, except the plan file.
 */
export const PROTECTED_DIRS = new Set([".git", ".husky", ".vscode", ".idea", ".devcontainer", ".pi"]);
export const PROTECTED_FILES = new Set([
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".bash_login",
	".bash_aliases",
	".bash_logout",
	".zshrc",
	".zprofile",
	".zshenv",
	".zlogin",
	".zlogout",
	".profile",
	".envrc",
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	".mcp.json",
	".pre-commit-config.yaml",
	"lefthook.yml",
	"lefthook.yaml",
	".lefthook.yml",
	".lefthook.yaml",
]);

/**
 * Secret locations under the home directory (ask in every mode, never
 * covered by "allow reads outside the cwd"). Directories cover everything
 * inside them; public keys (`*.pub`) are exempt.
 */
export const SECRET_HOME_PATHS = [
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".config/gcloud",
	".config/gh/hosts.yml",
	".docker/config.json",
	".kube/config",
	".netrc",
	".pgpass",
	".git-credentials",
	".pi/agent/auth.json",
];

/** Secret file names anywhere: private keys and certificates bundles. */
export const SECRET_FILE_PATTERNS: RegExp[] = [/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/, /\.(pem|key|p12|pfx)$/];

/** Bash commands that write; with a protected path in the command → ask. */
export const WRITE_INDICATORS: RegExp = /(^|[\s;&|])(tee|cp|mv|rm|ln|chmod|chown|truncate|install|rsync|dd)\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|>(?!\s*\/dev\/null)(?!&)/;
