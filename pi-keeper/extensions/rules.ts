/**
 * Permission rule evaluation for pi-keeper.
 *
 * Each mode is a fallback action plus a list of rules. Every rule whose
 * tool and matcher match the call contributes its action; the strictest
 * wins (deny > ask > allow), so an allow rule can never
 * override a dangerous-command ask or the global privilege deny. When no
 * rule matches, the mode's fallback applies.
 */

import { isAbsolute, join } from "node:path";
import {
	bashWritesInsideArtifactDirs,
	isCoveredByPrefixes,
	isDangerousCommand,
	isOutsideCwd,
	isOutsideCwdRead,
	isPrivilegedCommand,
	isProtectedPath,
	isScratchPath,
	outsideCwdBashWrites,
	isReadOnlyCommand,
	approvalBreakdown,
	formatBreakdown,
	type ApprovalBreakdown,
	type CoverSource,
	isSamePath,
	isSecretCommand,
	isSubagentArtifactPath,
	isSecretFile,
	outsideCwdReadPaths,
	outsideDestructiveTargets,
	secretSearchHits,
	secretUploads,
	type PathContext,
} from "./utils.ts";
import { ANY_TOOL, SUBAGENT_LAUNCH_TOOL } from "./modes.ts";
import { expandCommand, type ExpandOptions, type Program } from "./program.ts";
import { findMatchingRule, type ProjectPermissions } from "./project-rules.ts";
import { anyToolRuleMatches, grantableTool } from "./tool-grants.ts";

export type Action = "allow" | "ask" | "deny";

export type Matcher =
	| "readOnlyBash"
	| "unapprovedBash"
	| "rememberedBash"
	| "rememberedVerbatim"
	| "projectAllowBash"
	| "readOnlyTool"
	| "sessionEdits"
	| "scratchFile"
	| "projectAsk"
	| "projectDeny"
	/** `Tool(...)` / `Mcp(...)` deny and ask rules of the project file (tool-grants.ts); every mode. */
	| "projectAskTool"
	| "projectDenyTool"
	/** A tool grant: the call's key is a session grant, a parent's grant or a project allow rule (default mode only). */
	| "toolGrant"
	| "dangerousBash"
	| "privilegedBash"
	| "bridgeInactive"
	| "childSession"
	| "subagentArtifact"
	| "secretBash"
	| "planFile"
	| "protectedPath"
	| "outsideCwd"
	| "outsideCwdRead"
	| "outsideCwdBashWrite"
	| "outsideCwdDestructive"
	| "secretSearch"
	| "secretUpload"
	| "secretFile"
	/** Never matched by a mode rule: the gate's decision for the shell commands or the output write a `subagent_launch` call carries (see `launchNestedCalls`). */
	| "launchNested"
	/** Never matched by a mode rule: the gate's decision for a child launched outside its parent's project (child-cwd.ts). */
	| "childCwdLocked";

export interface Rule {
	/** Tool names this rule applies to, or `["*"]` for any tool. */
	tools: string[];
	/** Extra condition on the call input; omitted = every call of the tools. */
	match?: Matcher;
	action: Action;
}

export interface ModeRules {
	/** Action when no rule matches. */
	fallback: Action;
	rules: Rule[];
}

export interface EvalContext extends PathContext {
	/** Prefixes remembered via "Yes, and always allow <command>". */
	remembered: readonly (readonly string[])[];
	/** Exact commands remembered for the session ("Allow a different command pattern…"). */
	rememberedExact?: readonly (readonly string[])[];
	/** Whole commands remembered for the session ("don't ask again for this exact command"), as verbatimKey. */
	rememberedVerbatim?: readonly string[];
	/** Names of other packages' tools that only read (config.ts); allowed like read-only MCP tools. */
	readOnlyTools?: ReadonlySet<string>;
	/** The user allowed reads outside the cwd for the session. */
	outsideReadsAllowed?: boolean;
	/** The user allowed all edits for this pi session (default mode only lists the matcher). */
	sessionEdits?: boolean;
	/** User rules from `.pi/settings.local.json` (allow: trusted rules only). */
	project?: ProjectPermissions;
	/** Allow patterns of the running workflow command (`allowed-tools` frontmatter); same coverage as project allow rules. */
	commandGrants?: { prefixes: readonly (readonly string[])[]; exact: readonly (readonly string[])[] };
	/** Annotations a tool declares (MCP hints), by tool name; undefined = none known. */
	annotationsOf?: (toolName: string) => ToolHints | undefined;
	/** Subagent children will load this extension (the pi-subagents bridge is registered, or this is itself a child). */
	subagentBridge?: boolean;
	/** This session is a pi-subagents child. */
	child?: boolean;
	/** Tool grant keys (`Tool(x)`, `Mcp(server/tool)`) approved for this session, its parent's included. */
	toolGrants?: readonly string[];
	/** The session grant "allow loops over globs": the expander may unroll a loop over a glob (absent = never). */
	loopGlobs?: boolean;
	/** The session grant "allow python `while` loops": the python analyzer accepts a `while` statement (absent = never). */
	pythonWhile?: boolean;
}

/** The subset of tool annotations the rules read. */
export interface ToolHints {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
}

/** Tools that never count as read-only, whatever their annotations claim. */
const NEVER_READ_ONLY_TOOLS = new Set(["bash", "powershell", "edit", "write", "exit_plan_mode", "mcp", "mcpScript", "subagent", SUBAGENT_LAUNCH_TOOL]);

/** Tools that front other tools or launch agents: listing the name would allow whatever they are asked to run. */
const NEVER_LISTED_TOOLS = new Set(["mcp", "mcpScript", "subagent", SUBAGENT_LAUNCH_TOOL]);

/** How a whole command is remembered and compared: trimmed, otherwise as typed. */
export function verbatimKey(command: string): string {
	return command.trim();
}

/**
 * A child's own report in a pi-subagents output dir: allowed in every mode, not
 * "protected" and not "outside the cwd". A secret file name is not a report
 * (like scratchFile): it falls through to the mode's ask or deny.
 *
 * A shell call counts only when *every* write it makes lands in an artifact
 * dir and it deletes nothing (`mkdir -p .../outputs/<id> && echo ok`,
 * `touch .../outputs/<id>/context.md`): a background child has no user to
 * answer an outside-cwd ask, so such a call would otherwise be denied after
 * the ask timeout and the child could never make its own report dir.
 */
function isChildArtifactWrite(call: ToolCall, ctx: EvalContext): boolean {
	if (ctx.child !== true) return false;
	if (call.toolName === "bash" || call.toolName === "powershell") return bashWritesInsideArtifactDirs(commandOf(call.input), ctx);
	const path = pathOf(call.input);
	return (call.toolName === "write" || call.toolName === "edit") && isSubagentArtifactPath(path, ctx) && !isSecretFile(path, ctx);
}

export interface ToolCall {
	toolName: string;
	input: unknown;
}

export interface Decision {
	action: Action;
	/** The rule that decided, or undefined for the fallback. */
	rule?: Rule;
	/** What the call will run, when a rule about a nested call decided (`launchNested`): one line for the user. */
	detail?: string;
}

/** How strict an action is: the strictest matching rule decides a call. */
export const SEVERITY: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

/** Command text of a shell tool call. */
export function commandOf(input: unknown): string {
	const command = (input as { command?: unknown } | undefined)?.command;
	return typeof command === "string" ? command : "";
}

/** Target path of a file tool call (`path`, or `file_path` in some tools). */
export function pathOf(input: unknown): string {
	const value = input as { path?: unknown; file_path?: unknown } | undefined;
	const path = value?.path ?? value?.file_path;
	return typeof path === "string" ? path : "";
}

function body(matcher: Matcher, call: ToolCall, ctx: EvalContext): boolean {
	switch (matcher) {
		// Read-only analysis is bash syntax: powershell never matches it (fail closed)
		case "readOnlyBash":
			return call.toolName === "bash" && isReadOnlyCommand(commandOf(call.input), ctx.cwd, ctx.scratchDir, ctx.fetchHosts, ctx.gitRepos);
		// Not read-only and not covered by "Yes, and always allow" prefixes. Excluding
		// remembered commands here keeps a rememberedBash allow from being
		// outranked by this ask (strictest wins).
		// (the seam replaces this body with the negation of the expanded allow matchers, see `matches`)
		case "unapprovedBash":
			return call.toolName === "bash" && !body("readOnlyBash", call, ctx) && !body("rememberedBash", call, ctx);
		case "rememberedBash":
			return call.toolName === "bash" && isCoveredByPrefixes(commandOf(call.input), ctx.remembered, ctx.cwd, ctx.rememberedExact ?? [], ctx.scratchDir, ctx.fetchHosts, ctx.gitRepos);
		// The whole command, character for character, was approved for the session (default mode only lists this matcher)
		case "rememberedVerbatim":
			return call.toolName === "bash" && ctx.rememberedVerbatim?.includes(verbatimKey(commandOf(call.input))) === true;
		// Persisted allow rules work like remembered prefixes (plus exact
		// rules); only default mode lists this matcher
		case "projectAllowBash": {
			const allow = ctx.project?.allow;
			const grants = ctx.commandGrants;
			const prefixes = [...(allow?.prefixes ?? []), ...(grants?.prefixes ?? [])];
			const exact = [...(allow?.exact ?? []), ...(grants?.exact ?? [])];
			if (call.toolName !== "bash" || (prefixes.length === 0 && exact.length === 0)) return false;
			return isCoveredByPrefixes(commandOf(call.input), [...ctx.remembered, ...prefixes], ctx.cwd, [...(ctx.rememberedExact ?? []), ...exact], ctx.scratchDir, ctx.fetchHosts, ctx.gitRepos);
		}
		// A tool that declares itself read-only and not destructive (MCP hints), or that the user listed in pi-keeper.json
		case "readOnlyTool": {
			if (NEVER_READ_ONLY_TOOLS.has(call.toolName)) return false;
			if (ctx.readOnlyTools?.has(call.toolName) === true && !NEVER_LISTED_TOOLS.has(call.toolName)) return true;
			const hints = ctx.annotationsOf?.(call.toolName);
			return hints?.readOnlyHint === true && hints.destructiveHint !== true;
		}
		// The session scratch dir is writable in every mode (secrets still ask)
		case "scratchFile":
			return isScratchPath(pathOf(call.input), ctx) && !isSecretFile(pathOf(call.input), ctx);
		case "sessionEdits":
			return ctx.sessionEdits === true;
		// a rules file that cannot be read or parsed asks for every shell command until it is fixed
		case "projectAsk":
			return ctx.project?.broken !== undefined || findMatchingRule(ctx.project?.ask ?? [], commandOf(call.input)) !== undefined;
		case "projectDeny":
			return findMatchingRule(ctx.project?.deny ?? [], commandOf(call.input)) !== undefined;
		// a non-built-in tool or gateway call whose key was granted for the session or allowed by the project
		case "toolGrant": {
			const grant = grantableTool(call.toolName, call.input, ctx.annotationsOf?.(call.toolName));
			return grant !== undefined && (ctx.toolGrants?.includes(grant.key) === true || ctx.project?.tools?.includes(grant.key) === true);
		}
		case "projectAskTool": {
			return anyToolRuleMatches(ctx.project?.askTools, call.toolName, call.input);
		}
		case "projectDenyTool": {
			return anyToolRuleMatches(ctx.project?.denyTools, call.toolName, call.input);
		}
		case "dangerousBash":
			return isDangerousCommand(commandOf(call.input), ctx);
		case "privilegedBash":
			return isPrivilegedCommand(commandOf(call.input));
		case "bridgeInactive":
			return ctx.subagentBridge !== true;
		case "childSession":
			return ctx.child === true;
		case "subagentArtifact":
			return isChildArtifactWrite(call, ctx);
		case "secretBash":
			return isSecretCommand(commandOf(call.input), ctx);
		case "planFile":
			return ctx.planFile !== undefined && isSamePath(pathOf(call.input), ctx.planFile, ctx.cwd);
		case "protectedPath":
			return isProtectedPath(pathOf(call.input), ctx) && !isChildArtifactWrite(call, ctx);
		case "outsideCwd":
			return isOutsideCwd(pathOf(call.input), ctx) && !isChildArtifactWrite(call, ctx);
		case "outsideCwdRead":
			if (ctx.outsideReadsAllowed === true) return false;
			if (call.toolName === "bash") return outsideCwdReadPaths(commandOf(call.input), ctx).length > 0;
			return isOutsideCwdRead(pathOf(call.input), ctx);
		// a write command naming a literal path outside the cwd (unresolvable targets don't match);
		// a child's artifact-dir writes are exempt (isChildArtifactWrite)
		case "outsideCwdBashWrite":
			return outsideCwdBashWrites(commandOf(call.input), ctx).length > 0 && !isChildArtifactWrite(call, ctx);
		// rm, mv, truncate, find -delete, destructive git aimed outside the cwd; unresolvable targets match too
		case "outsideCwdDestructive":
			return outsideDestructiveTargets(commandOf(call.input), ctx).length > 0;
		// a recursive or hidden-file search over a tree holding a secret file
		case "secretSearch":
			return call.toolName === "bash" && secretSearchHits(commandOf(call.input), ctx).length > 0;
		// curl / wget sending a secret file
		case "secretUpload":
			return call.toolName === "bash" && secretUploads(commandOf(call.input), ctx).length > 0;
		case "secretFile":
			return isSecretFile(pathOf(call.input), ctx);
		// set by the gate, never by a mode rule
		case "childCwdLocked":
			return false;
		case "launchNested":
			return false;
	}
}

/** How a matcher reads the expanded program `P` (see program.ts and the plan's D2). */
export type MatcherKind =
	/** Grants an allow: holds on the call as given or on `P`. */
	| "allow"
	/** "Exactly this text": the call as given only. */
	| "verbatim"
	/** Finds a hazard: holds on the call as given, or on `P` when an allow came through `P` (`viaP`). */
	| "scanner"
	/** The negation of the two expanded allow matchers it stands for (`unapprovedBash`). */
	| "complement"
	/** Ignores the command. */
	| "blind";

export const MATCHER_KIND: Record<Matcher, MatcherKind> = {
	readOnlyBash: "allow",
	rememberedBash: "allow",
	projectAllowBash: "allow",
	subagentArtifact: "allow",
	rememberedVerbatim: "verbatim",
	dangerousBash: "scanner",
	secretBash: "scanner",
	outsideCwdRead: "scanner",
	outsideCwdBashWrite: "scanner",
	outsideCwdDestructive: "scanner",
	secretSearch: "scanner",
	secretUpload: "scanner",
	projectAsk: "scanner",
	projectDeny: "scanner",
	privilegedBash: "scanner",
	unapprovedBash: "complement",
	readOnlyTool: "blind",
	toolGrant: "blind",
	projectAskTool: "blind",
	projectDenyTool: "blind",
	scratchFile: "blind",
	sessionEdits: "blind",
	bridgeInactive: "blind",
	childSession: "blind",
	planFile: "blind",
	protectedPath: "blind",
	outsideCwd: "blind",
	secretFile: "blind",
	childCwdLocked: "blind",
	launchNested: "blind",
};

/** What the expander needs from a context. */
type ExpandContext = PathContext & { loopGlobs?: boolean; pythonWhile?: boolean };

/** The expanded program `P` of a bash command in this context (never cached: `process.env` is read each time). */
export function programOf(command: string, ctx: ExpandContext): Program {
	const options: ExpandOptions & { globs?: boolean } = { cwd: ctx.cwd, scratch: ctx.scratchDir, env: process.env, globs: ctx.loopGlobs === true, pythonWhile: ctx.pythonWhile === true };
	return expandCommand(command, options);
}

/** `command` is allowed by `holds` as typed or as expanded: the one coverage predicate of the dialog, the warning and the rules. */
function asTypedOrExpanded(command: string, ctx: ExpandContext, holds: (text: string) => boolean): boolean {
	if (holds(command)) return true;
	const program = programOf(command, ctx);
	return program.changed && holds(program.text);
}

/** `isCoveredByPrefixes` on the command as typed or as expanded (what `rememberedBash` means). */
export function coversCommand(command: string, ctx: ExpandContext, prefixes: readonly (readonly string[])[], exact: readonly (readonly string[])[]): boolean {
	return asTypedOrExpanded(command, ctx, (text) => isCoveredByPrefixes(text, prefixes, ctx.cwd, exact, ctx.scratchDir, ctx.fetchHosts, ctx.gitRepos));
}

/** The state `matches` shares within one `evaluate` call: `P` and `viaP`, each computed at most once. */
interface Seam {
	/** The call with `P` as its command; undefined when the tool is not bash or `P` is the command itself. */
	expanded(): ToolCall | undefined;
	/** `P` changed the command, no allow of the rule list holds as typed, and one holds on `P`. */
	viaP(): boolean;
}

function makeSeam(call: ToolCall, ctx: EvalContext, rules: readonly Rule[]): Seam {
	let expanded: ToolCall | undefined | null = null;
	let via: boolean | undefined;
	const seam: Seam = {
		expanded() {
			if (expanded !== null) return expanded;
			expanded = undefined;
			if (call.toolName === "bash") {
				const program = programOf(commandOf(call.input), ctx);
				if (program.changed) expanded = { toolName: call.toolName, input: { ...(call.input as object), command: program.text } };
			}
			return expanded;
		},
		viaP() {
			if (via !== undefined) return via;
			via = false;
			const p = seam.expanded();
			if (p === undefined) return via;
			const listed = new Set(rules.flatMap((rule) => (rule.match === undefined ? [] : [rule.match])));
			const allows = [...listed].filter((m) => MATCHER_KIND[m] === "allow");
			const typed = [...listed].filter((m) => MATCHER_KIND[m] === "verbatim" || MATCHER_KIND[m] === "allow");
			via = !typed.some((m) => body(m, call, ctx)) && allows.some((m) => body(m, p, ctx));
			return via;
		},
	};
	return seam;
}

/** An allow-kind matcher: as typed, or on `P`. */
function allowMatches(matcher: Matcher, call: ToolCall, ctx: EvalContext, seam: Seam): boolean {
	if (body(matcher, call, ctx)) return true;
	const p = seam.expanded();
	return p !== undefined && body(matcher, p, ctx);
}

/** Does `matcher` hold for `call`? The one place that decides which text(s) a matcher reads (MATCHER_KIND). */
function matches(matcher: Matcher, call: ToolCall, ctx: EvalContext, seam: Seam): boolean {
	switch (MATCHER_KIND[matcher]) {
		case "allow":
			return allowMatches(matcher, call, ctx, seam);
		case "complement":
			// the negation of the expanded allow matchers, so it cannot drift from them
			return call.toolName === "bash" && !allowMatches("readOnlyBash", call, ctx, seam) && !allowMatches("rememberedBash", call, ctx, seam);
		case "scanner": {
			if (body(matcher, call, ctx)) return true;
			const p = seam.expanded();
			return p !== undefined && seam.viaP() && body(matcher, p, ctx);
		}
		case "verbatim":
		case "blind":
			return body(matcher, call, ctx);
	}
}

/**
 * Built-in tools whose input the rules inspect and whose execute never
 * mutates it, so their input can be locked after approval.
 */
export const LOCKABLE_TOOLS = new Set(["bash", "powershell", "edit", "write", "read", "grep", "find", "ls"]);

/**
 * Lock a tool call's input once the user approved it, so an extension
 * whose tool_call handler runs after this one can't change what runs.
 * Top-level properties become read-only accessors whose setter throws a
 * descriptive error (the call then fails instead of running something
 * else); nested values are frozen; new properties can't be added. pi
 * hands tools a validated clone of the arguments, so the tool call stored
 * in the session is unaffected.
 */
export function lockApprovedInput(input: unknown, description: string): void {
	if (input === null || typeof input !== "object" || !Object.isExtensible(input)) return;
	const target = input as Record<string, unknown>;
	for (const key of Object.keys(target)) {
		const value = deepFreeze(target[key]);
		Object.defineProperty(target, key, {
			enumerable: true,
			configurable: false,
			get: () => value,
			set: () => {
				throw new Error(
					`pi-keeper: the user approved "${description}"; another extension tried to change its \`${key}\` afterwards, so the call was stopped.`,
				);
			},
		});
	}
	Object.preventExtensions(target);
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Decide a tool call: strictest matching rule, else the mode fallback. */
export function evaluate(mode: ModeRules, globalRules: readonly Rule[], call: ToolCall, ctx: EvalContext): Decision {
	let decision: Decision | undefined;
	const applicable = [...globalRules, ...mode.rules].filter((rule) => rule.tools.includes(call.toolName) || rule.tools.includes(ANY_TOOL));
	const seam = makeSeam(call, ctx, applicable);
	for (const rule of applicable) {
		if (rule.match !== undefined && !matches(rule.match, call, ctx, seam)) continue;
		if (decision === undefined || SEVERITY[rule.action] > SEVERITY[decision.action]) {
			decision = { action: rule.action, rule };
		}
		if (rule.action === "deny") break;
	}
	return decision ?? { action: mode.fallback };
}

/**
 * The calls a `subagent_launch` call, a single-child `subagent` call, or a
 * `schedule.create` call (its gate and output, when given) will make
 * on this machine after its child stops: one `bash` call per entry of `commands`
 * (the child's `gate` and `acceptance.verify` commands), and one `write` call for
 * `output` (the file the child's result is written to). Empty for every other tool.
 *
 * The gate judges each with the mode's own rules, so pi-keeper's bash and write
 * rules cover what the parent runs on the child's behalf. A command runs in the
 * child's directory; relative paths in it are checked against this session's
 * working directory, which is the child's unless the call says otherwise.
 */
export function launchNestedCalls(call: ToolCall): ToolCall[] {
	if (call.toolName === "subagent") return singleLaunchNested(call);
	if (call.toolName !== SUBAGENT_LAUNCH_TOOL) return [];
	const input = call.input as { commands?: unknown; output?: unknown } | undefined;
	const nested: ToolCall[] = [];
	for (const entry of Array.isArray(input?.commands) ? input.commands : []) {
		const command = (entry as { command?: unknown } | undefined)?.command;
		if (typeof command === "string" && command.trim() !== "") nested.push({ toolName: "bash", input: { command } });
	}
	const output = input?.output;
	if (typeof output === "string" && output !== "") nested.push({ toolName: "write", input: { path: output } });
	return nested;
}

/**
 * What a `subagent_launch` call carries that the nested `bash` and `write` calls
 * of `launchNestedCalls` cannot express, one line each. The gate raises the
 * answer to at least `ask` for every line, in every mode, and never remembers it:
 *
 * - a command that sets `env`: a variable such as `GIT_PAGER`, `PATH` or
 *   `LD_PRELOAD` changes what a command the rules call read-only will run;
 * - a command whose `cwd` is outside this session's project: the rules judge
 *   relative paths and "inside the project" from the session cwd, so `rm -rf *`
 *   in `/home/me` would pass as a delete inside the project;
 * - a `commands`, `cwd`, `env` or `output` value of a shape this check cannot
 *   read: unreadable is never "nothing to check".
 *
 * A single-child `subagent` call carries the same things in its `gate`,
 * `acceptance` and `output` fields (singleLaunch reads them), so it gets the same
 * lines. Empty for every other tool.
 */
export function launchNestedHazards(call: ToolCall, ctx: PathContext): string[] {
	if (call.toolName === "subagent") return singleLaunchHazards(call, ctx);
	if (call.toolName !== SUBAGENT_LAUNCH_TOOL) return [];
	const input = call.input as { commands?: unknown; output?: unknown } | undefined;
	const hazards: string[] = [];
	const commands = input?.commands;
	if (commands !== undefined && !Array.isArray(commands)) hazards.push("commands: a list this check cannot read");
	for (const entry of Array.isArray(commands) ? commands : []) hazards.push(...commandHazards(entry, ctx));
	if (input?.output !== undefined && typeof input.output !== "string") hazards.push("write: an output path this check cannot read");
	return hazards;
}

/** The hazard lines of one `{command, cwd?, env?}` entry of a launch (`commands`, `acceptance.verify`, or a gate). */
function commandHazards(entry: unknown, ctx: PathContext): string[] {
	const item = entry as { command?: unknown; cwd?: unknown; env?: unknown } | null | undefined;
	if (typeof item !== "object" || item === null || typeof item.command !== "string") return ["bash: a command this check cannot read"];
	const hazards: string[] = [];
	const shown = item.command.length > 120 ? `${item.command.slice(0, 120)}…` : item.command;
	const names = typeof item.env === "object" && item.env !== null && !Array.isArray(item.env) ? Object.keys(item.env) : item.env === undefined ? [] : ["?"];
	if (names.length > 0) hazards.push(`bash: ${shown} (sets ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""} in its environment)`);
	if (item.cwd !== undefined && (typeof item.cwd !== "string" || isOutsideCwd(item.cwd, ctx))) {
		hazards.push(`bash: ${shown} (runs in ${typeof item.cwd === "string" ? item.cwd : "a directory this check cannot read"}, outside this project)`);
	}
	return hazards;
}

/** A field as pi-subagents reads it: the string "null" is dropped (flattenSubagentToolOptions). */
function given(value: unknown): boolean {
	return value !== undefined && value !== "null";
}

/** What a single-child launch makes the host run and write, and what this check cannot read. */
interface SingleLaunch {
	/** `{command, cwd?, env?}` entries (gate, acceptance.verify), not yet checked for shape. */
	commands: unknown[];
	/** Paths of nested `write` calls (the child's `output`). */
	writes: string[];
	/** Lines for values this check cannot read. */
	hazards: string[];
}

/** Fields that make a `subagent` call a workflow or multi-child launch: judged per child as `subagent_launch`, not here. */
const MULTI_CHILD_FIELDS = ["workflow", "workflowScript", "script", "tasks", "chain", "parallel"];

/**
 * A single-child `subagent` launch (`agent` as a string, no workflow, script or
 * multi-child field, no management `action`), read from the top level and from
 * `options` (both may be set). Undefined for any other call.
 */
function singleLaunch(call: ToolCall): SingleLaunch | undefined {
	if (call.toolName !== "subagent") return undefined;
	const { top, options } = subagentFields(call.input);
	if (given(top.action) || !given(top.agent) || typeof top.agent !== "string") return undefined;
	for (const source of [top, options]) {
		for (const key of MULTI_CHILD_FIELDS) {
			if (given(source[key]) && !(key === "workflow" && source[key] === "false")) return undefined;
		}
	}
	return readLaunch(top, options);
}

/** The top level and `options` of a `subagent` call; a value that is not a plain object is read as empty (pi-subagents refuses that call). */
function subagentFields(input: unknown): { top: Record<string, unknown>; options: Record<string, unknown> } {
	const top = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const options = (typeof top.options === "object" && top.options !== null && !Array.isArray(top.options) ? top.options : {}) as Record<string, unknown>;
	return { top, options };
}

/** The action that stores a workflow script to run later, with no tool call behind its children. */
const SCHEDULE_ACTION = "schedule.create";

/**
 * A `schedule.create` call: its gate, acceptance and output fields are judged as a
 * single launch. The workflow it stores runs later with no tool call behind it
 * (approveWorkflowChildLaunch returns without judging), and its children launch
 * from the script, which this check cannot read: so the creation itself asks.
 */
function scheduleLaunch(call: ToolCall): SingleLaunch | undefined {
	if (call.toolName !== "subagent") return undefined;
	const { top, options } = subagentFields(call.input);
	if (!given(top.action) || typeof top.action !== "string" || top.action.trim() !== SCHEDULE_ACTION) return undefined;
	const launch = readLaunch(top, options);
	if (given(top.options) && (typeof top.options !== "object" || top.options === null || Array.isArray(top.options))) {
		launch.hazards.push("schedule: launch parameters this check cannot read");
	}
	if ([top, options].some((source) => ["workflow", "workflowScript", "script"].some((key) => given(source[key]) && source[key] !== "false"))) {
		launch.hazards.push("schedule: a workflow script that runs later, with no tool call behind its children, so their gates are not judged");
	}
	return launch;
}

/** The launch a `subagent` call makes after its child stops, or a schedule it stores. */
function launchOf(call: ToolCall): SingleLaunch | undefined {
	return singleLaunch(call) ?? scheduleLaunch(call);
}

/** Judge the gate, acceptance and output fields, from the top level and from `options` (both may be set). */
function readLaunch(top: Record<string, unknown>, options: Record<string, unknown>): SingleLaunch {
	const sources = [top, options];
	const cwd = given(top.cwd) ? top.cwd : undefined;
	const artifactsOff = sources.some((source) => source.artifacts === false || source.artifacts === "false");
	const launch: SingleLaunch = { commands: [], writes: [], hazards: [] };
	for (const source of sources) {
		launch.commands.push(...gateEntries(source.gate, cwd, launch.hazards));
		launch.commands.push(...acceptanceEntries(source.acceptance, cwd, launch.hazards));
		const output = singleOutput(source.output, cwd, artifactsOff);
		if (output.write !== undefined) launch.writes.push(output.write);
		if (output.hazard !== undefined) launch.hazards.push(output.hazard);
	}
	return launch;
}

/** The entry a gate runs as: a string, or an object with a string `command`; it runs in the call's cwd. */
function gateEntries(gate: unknown, cwd: unknown, hazards: string[]): unknown[] {
	if (!given(gate)) return [];
	if (typeof gate === "string") return [{ command: gate, cwd }];
	if (typeof gate === "object" && gate !== null && typeof (gate as { command?: unknown }).command === "string") return [{ cwd, ...gate }];
	hazards.push("gate: a value this check cannot read");
	return [];
}

/** The `verify` entries of an acceptance object or JSON string; a policy name carries none. */
function acceptanceEntries(acceptance: unknown, cwd: unknown, hazards: string[]): unknown[] {
	if (!given(acceptance) || typeof acceptance === "boolean") return [];
	let spec: unknown = acceptance;
	if (typeof acceptance === "string") {
		if (acceptance.trim().startsWith("[")) {
			hazards.push("acceptance: a value this check cannot read");
			return [];
		}
		if (!acceptance.trim().startsWith("{")) return [];
		try {
			spec = JSON.parse(acceptance);
		} catch {
			hazards.push("acceptance: JSON this check cannot read");
			return [];
		}
	}
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		hazards.push("acceptance: a value this check cannot read");
		return [];
	}
	const verify = (spec as { verify?: unknown }).verify;
	if (verify === undefined) return [];
	if (!Array.isArray(verify)) {
		hazards.push("acceptance: a verify list this check cannot read");
		return [];
	}
	return verify.map((entry) => (typeof entry === "object" && entry !== null && !Array.isArray(entry) ? { cwd, ...entry } : entry));
}

/**
 * What a launch's `output` makes the host write: an absolute path, or (with
 * `artifacts: false`) a relative path under the call's cwd. A relative path
 * otherwise lands in the run's artifacts directory, unless it climbs out of it.
 */
function singleOutput(output: unknown, cwd: unknown, artifactsOff: boolean): { write?: string; hazard?: string } {
	if (output === undefined || typeof output === "boolean" || output === "true" || output === "false" || output === "null" || output === "") return {};
	if (typeof output !== "string") return { hazard: "write: an output path this check cannot read" };
	if (isAbsolute(output)) return { write: output };
	if (artifactsOff) return { write: join(typeof cwd === "string" ? cwd : ".", output) };
	if (output.split(/[\\/]/).includes("..")) return { hazard: `write: output path ${output} leaves the run's directory` };
	return {};
}

function singleLaunchNested(call: ToolCall): ToolCall[] {
	const launch = launchOf(call);
	if (launch === undefined) return [];
	const nested: ToolCall[] = [];
	for (const entry of launch.commands) {
		const command = (entry as { command?: unknown } | null)?.command;
		if (typeof command === "string" && command.trim() !== "") nested.push({ toolName: "bash", input: { command } });
	}
	for (const path of launch.writes) nested.push({ toolName: "write", input: { path } });
	return nested;
}

function singleLaunchHazards(call: ToolCall, ctx: PathContext): string[] {
	const launch = launchOf(call);
	if (launch === undefined) return [];
	const hazards = [...launch.hazards];
	for (const entry of launch.commands) hazards.push(...commandHazards(entry, ctx));
	return hazards;
}

/** A named list of allow patterns (session memory, project rules, a workflow command's grants). */
export interface PatternSource {
	label: string;
	prefixes: readonly (readonly string[])[];
	exact: readonly (readonly string[])[];
}

/** `git commit *`, or `npm test (exact)`. */
export function patternString(tokens: readonly string[], exact: boolean): string {
	return exact ? `${tokens.join(" ")} (exact)` : `${tokens.join(" ")} *`;
}

/** Most patterns considered by `coveringPatterns` (it makes one coverage check per pattern). */
const MAX_EXPLAINED_PATTERNS = 40;

/**
 * Which patterns let `command` run without a dialog: a minimal subset of the
 * sources' patterns that still covers it (earlier sources are kept over later
 * ones). Empty when the command is not covered (e.g. it is read-only).
 */
export function coveringPatterns(command: string, sources: readonly PatternSource[], cwd: string, scratch?: string, fetchHosts?: readonly string[], gitRepos?: readonly string[], loopGlobs?: boolean): Array<{ label: string; tokens: readonly string[]; exact: boolean }> {
	let items = sources.flatMap((s) => [
		...s.prefixes.map((tokens) => ({ label: s.label, tokens, exact: false })),
		...s.exact.map((tokens) => ({ label: s.label, tokens, exact: true })),
	]);
	if (items.length === 0 || items.length > MAX_EXPLAINED_PATTERNS) return [];
	// the same text(s) the rules read: as typed, or as expanded
	const ctx: ExpandContext = { cwd, scratchDir: scratch, fetchHosts, gitRepos, loopGlobs };
	const covers = (set: typeof items): boolean =>
		asTypedOrExpanded(command, ctx, (text) =>
			set.length === 0 ? isReadOnlyCommand(text, cwd, scratch, fetchHosts, gitRepos) : isCoveredByPrefixes(text, set.filter((i) => !i.exact).map((i) => i.tokens), cwd, set.filter((i) => i.exact).map((i) => i.tokens), scratch, fetchHosts, gitRepos));
	if (!covers(items)) return [];
	for (let k = items.length - 1; k >= 0; k--) {
		const without = items.filter((_, j) => j !== k);
		if (covers(without)) items = without;
	}
	return items;
}

/**
 * The dialog's "why" lines for a bash command, from the same text the rules judged:
 * `Why: <problem>.` first when the expander refused; when it expanded, the breakdown of
 * `P` with one entry per reason (the first segment and `(+N more)`); else the breakdown
 * of the command as typed.
 */
export function bashWhy(command: string, ctx: ExpandContext, covered: readonly CoverSource[]): string[] {
	const program = programOf(command, ctx);
	const breakdown = approvalBreakdown(program.changed ? program.text : command, ctx.cwd, covered, ctx.scratchDir, ctx.fetchHosts, ctx.gitRepos);
	if (program.problem === undefined) return program.changed ? formatGrouped(breakdown) : formatBreakdown(breakdown);
	// one block: the problem first, then only the entries that say more than the problem and the generic loop/assignment blocker
	const problem = `${program.problem}.`;
	const needs = breakdown.needs.filter((n) => !GENERIC_BLOCKER.test(n.reason) && `${n.reason}.` !== problem);
	const lines = formatBreakdown({ needs, ok: breakdown.ok }).map((line) => (line.startsWith("Why: ") ? `Also: ${line.slice(5)}` : line));
	return [`Why: ${problem}`, ...lines];
}

/** The loop/function and `NAME=…` blockers: they only restate that the command is a loop or an assignment, which the problem already explains. */
const GENERIC_BLOCKER = /^(uses a shell loop, conditional or function|sets `[^`]*=…`)/;

/** `formatBreakdown` with the needs grouped by reason: `wc -l a` (+15 more) instead of 16 entries. */
function formatGrouped(breakdown: ApprovalBreakdown): string[] {
	const groups: { segment: string; reason: string; more: number }[] = [];
	for (const need of breakdown.needs) {
		const group = need.segment === "" ? undefined : groups.find((g) => g.reason === need.reason && g.segment !== "");
		if (group === undefined) groups.push({ segment: need.segment, reason: need.reason, more: 0 });
		else group.more++;
	}
	if (groups.length === 0) return [];
	if (groups.length === 1 && breakdown.ok.length === 0) return [`Why: ${groups[0].reason}.`];
	const needs = groups.map((g) => (g.segment === "" ? g.reason : `\`${g.segment}\`${g.more > 0 ? ` (+${g.more} more)` : ""} \u2014 ${g.reason}`));
	const ok = formatBreakdown({ needs: breakdown.needs, ok: breakdown.ok }).slice(1);
	return [`Needs approval: ${needs.join("; ")}`, ...ok];
}
