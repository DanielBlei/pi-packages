/**
 * Permission telemetry: every decision and dialog is appended to the
 * session log as a `pi-keeper-permission` custom entry (never sent to
 * the LLM), with bounded payloads. Read it back with
 * scripts/extract_flow.py.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModeName } from "./modes.ts";
import { commandOf, pathOf, type Decision, type ToolCall } from "./rules.ts";
import { SECRET_ENV_NAME } from "./utils.ts";

export const TELEMETRY_ENTRY = "pi-keeper-permission";

export const TARGET_LIMIT = 200;
const TARGET_HEAD = 120;
const LABEL_LIMIT = 160;
export const TEXT_LIMIT = 200;
const TEXT_HEAD = 120;

/** A value in a shell word: a double-quoted, single-quoted or bare run. */
const VALUE = String.raw`"[^"]*"|'[^']*'|[^\s"']+`;
/** Credential-like flag names: whole `-`/`_`-separated parts (`--token`, `--api-key`, `--password`), not `--author`. */
const SECRET_FLAG = /^--(?:[\w-]*[-_])?(?:token|tokens|password|passwd|pass|secret|secrets|credentials?|auth|apikey|api[-_]key)(?:[-_][\w-]*)?$/i;
/** Credential-like header and field names (`X-Api-Key`, `Cookie`, `PRIVATE-TOKEN`, `Authorization`; `auth` alone, not `author`). */
const SECRET_HEADER = /api[-_]?key|token|cookie|secret|password|passwd|authorization|auth(?!or)/i;
/**
 * Bounded scan between a command word and its option: keeps every match linear in the text
 * (an unbounded scan from each `mysql ` in a long run is quadratic).
 */
const SCAN = "{0,200}?";

/** Keeps the user of a `user:password` value and hides the password; a value without a colon is kept. */
function hidePassword(value: string): string {
	const colon = value.indexOf(":");
	return colon < 0 ? value : `${value.slice(0, colon + 1)}***`;
}

/**
 * The command text as the session log keeps it: the values of `Authorization:`
 * headers, `Bearer` tokens, credential-like `--flag value` / `--flag=value`
 * options and credential-like `NAME=value` assignments become `***`; the rest
 * of the command is kept. Judged by the same secret names as the rules
 * (SECRET_ENV_NAME), so a plain `--author` is untouched (a name holding
 * `AUTH`, such as `GIT_AUTHOR_NAME`, counts as credential-like and is hidden).
 */
export function redactCommand(command: string): string {
	return command
		.replace(new RegExp(String.raw`(authorization:\s*)(?:(?:bearer|basic|token)\s+)?(?:${VALUE})`, "gi"), "$1***")
		.replace(new RegExp(String.raw`(\bbearer\s+)(?:${VALUE})`, "gi"), "$1***")
		// `-u user:password` / `--user user:password`: the user name stays, the password goes
		.replace(new RegExp(String.raw`(?<![\w-])(--user(?:\s+|=)|-u\s+)(${VALUE})`, "g"), (match, flag: string, value: string) => {
			const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
			const inner = quote === "" ? value : value.slice(1, -1);
			const hidden = hidePassword(inner);
			return hidden === inner ? match : `${flag}${quote}${hidden}${quote}`;
		})
		// `-u:secret` / `-uuser:secret` (attached): the whole value goes
		.replace(/(?<![\w-])-u(?=[^\s"']*:)[^\s"']+/g, "-u***")
		// `scheme://user:password@host`: the password goes; a match starts only at a scheme boundary, so this is linear
		.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+):[^\s/@"']+@/gi, "$1:***@")
		// `-H "Name: value"`, `--header 'Name: value'`, `--header=Name: value`, `-HName:value`: a credential-like header's value goes
		.replace(/(-H\s*|--header(?:\s+|=))(["'])([\w-]+)(:\s*)[^"'\n]*\2/gi, (match, flag: string, quote: string, name: string, sep: string) =>
			SECRET_HEADER.test(name) ? `${flag}${quote}${name}${sep}***${quote}` : match,
		)
		.replace(/(-H\s*|--header(?:\s+|=))([\w-]+)(:\s*)[^\s"']+/gi, (match, flag: string, name: string, sep: string) => (SECRET_HEADER.test(name) ? `${flag}${name}${sep}***` : match))
		// a bare header line or `name: value` with a credential-like name, at the start or after a space or quote
		.replace(/(^|[\s"'])([\w-]+)(:[ \t]*)[^\s"']+/g, (match, lead: string, name: string, sep: string) => (SECRET_HEADER.test(name) ? `${lead}${name}${sep}***` : match))
		// `mysql -psecret`, `sshpass -psecret` (attached): the password goes, `-p` stays
		.replace(new RegExp(String.raw`(\b(?:mysql|mysqldump|mariadb|sshpass)\b[^;&|]${SCAN}\s)-p(?=\S)\S+`, "g"), "$1-p***")
		// `docker login -p secret`, `sshpass -p secret`
		.replace(new RegExp(String.raw`(\b(?:docker\s+login|sshpass)\b[^;&|]${SCAN}\s-p\s+)(?:${VALUE})`, "g"), "$1***")
		// `redis-cli -a secret`
		.replace(new RegExp(String.raw`(\bredis-cli\b[^;&|]${SCAN}\s-a\s+)(?:${VALUE})`, "g"), "$1***")
		.replace(/(--[\w-]+)(=|\s+)(?:"[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g, (match, flag: string, sep: string) => (SECRET_FLAG.test(flag) ? `${flag}${sep}***` : match))
		// not after `-` (that is a flag's `--name=value`, judged above)
		.replace(new RegExp(String.raw`(?<![\w-])([A-Za-z_][A-Za-z0-9_]*)=(?:${VALUE})`, "g"), (match, name: string) => (SECRET_ENV_NAME.test(name) ? `${name}=***` : match));
}

/** A string that is a JSON object or array is redacted as the JSON it is; its own text is kept when nothing in it is hidden. */
function redactJsonText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return redactCommand(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return redactCommand(text);
	}
	const redacted = JSON.stringify(redactInput(parsed));
	return redacted === JSON.stringify(parsed) ? text : redacted;
}

/** The name a record names itself by (`name`, else `key`), for the `{name, value}` shape. */
function labelOf(record: Record<string, unknown>): string | undefined {
	if (typeof record.name === "string") return record.name;
	return typeof record.key === "string" ? record.key : undefined;
}

/**
 * A copy of a non-bash input for the log: a string under a secret-named key (at any depth, SECRET_ENV_NAME or
 * a credential-like header name) becomes "***", the element after a secret flag or `-u` in an array is masked,
 * the `value` of a `{name, value}` object naming a credential is masked, and every other string goes through
 * redactCommand (or, when it is JSON, through this function again).
 */
function redactInput(value: unknown, secret = false): unknown {
	if (typeof value === "string") return secret ? "***" : redactJsonText(value);
	if (Array.isArray(value)) {
		let next: "secret" | "user" | undefined;
		return value.map((item) => {
			const mask = next;
			next = undefined;
			if (typeof item === "string" && mask !== undefined) return mask === "secret" ? "***" : hidePassword(item);
			if (typeof item === "string") {
				if (SECRET_FLAG.test(item)) next = "secret";
				else if (item === "-u" || item === "--user") next = "user";
			}
			return redactInput(item, secret);
		});
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const label = labelOf(record);
		const namedSecret = label !== undefined && SECRET_HEADER.test(label);
		return Object.fromEntries(
			Object.entries(record).map(([key, inner]) => [
				key,
				redactInput(inner, secret || SECRET_ENV_NAME.test(key) || SECRET_HEADER.test(key) || (namedSecret && key === "value")),
			]),
		);
	}
	return value;
}

function shrink(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Keep head and tail: the end of a long command (flags, redirects, targets) is the interesting part. */
function shrinkMiddle(text: string, limit: number, head: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, head)}…[+${text.length - head - (limit - head)}]…${text.slice(-(limit - head))}`;
}

function shrinkOptional(text: string | undefined, limit: number, head?: number): string | undefined {
	if (text === undefined) return undefined;
	return head === undefined ? shrink(text, limit) : shrinkMiddle(text, limit, head);
}

/** Command of a bash call, path of a file call, else a JSON snippet. */
export function targetOf(call: ToolCall): string {
	if (call.toolName === "bash" || call.toolName === "powershell") return redactCommand(commandOf(call.input));
	const path = pathOf(call.input);
	if (path !== "") return path;
	return JSON.stringify(redactInput(call.input ?? {}));
}

/** A permission decision on a tool call ("decide"), or its re-evaluation after a queued dialog ("redecide"). */
export function logDecision(
	pi: ExtensionAPI,
	phase: "decide" | "redecide",
	toolCallId: string,
	call: ToolCall,
	mode: ModeName,
	decision: Decision,
	/** How long the decision itself took, in ms. Absent when the caller did not time it. */
	decideMs?: number,
): void {
	append(pi, {
		phase,
		toolCallId,
		tool: call.toolName,
		mode,
		target: shrinkMiddle(targetOf(call), TARGET_LIMIT, TARGET_HEAD),
		action: decision.action,
		matcher: decision.rule?.match ?? null,
		...(decideMs !== undefined ? { decideMs: Math.round(decideMs * 1000) / 1000 } : {}),
	});
}

/**
 * One entry per session, not per event: the model and the version of the text
 * the model was told (mode prompts + the contract). Both are what a later
 * comparison needs and neither changes per tool call, so recording them once
 * keeps the transcript small. `model` is `provider/id`; null when the harness
 * reports none (a mock, a headless run).
 */
export function logSession(pi: ExtensionAPI, session: { model: string | null; promptVersion: string }): void {
	append(pi, { phase: "session", model: session.model, promptVersion: session.promptVersion });
}

export type ChoiceOutcome =
	| "allow-once"
	| "allow-edits"
	| "switch-auto"
	| "outside-reads"
	| "outside-read-dirs"
	| "project-read-approvals"
	| "fetch-hosts"
	| "project-fetch-hosts"
	| "remember-session"
	| "remember-project"
	| "pattern-flow"
	| "reject-feedback"
	| "reject"
	| "no-ui"
	| "auto-reject"
	// a background subagent's ask, answered in this (the parent's) session
	| "remote-allowed"
	| "remote-denied"
	| "remote-auto-allow"
	| "remote-auto-deny"
	| "remote-cancelled"
	| "parent-gone"
	// background asks were turned off in the parent while the request waited
	| "asks-off"
	// a request the parent already allowed for the session when its dialog came up: no dialog, not the user's answer
	| "covered"
	// a background child's own ask, sent to its parent (the choice holds the answer)
	| "parent-ask";

export interface ChoiceEvent {
	toolCallId: string;
	tool: string;
	mode: ModeName;
	target: string;
	matcher: string | null;
	/** Options the dialog offered; empty when no dialog was shown. */
	options: { primary: string[]; secondary: string[] };
	/** The label picked, or null for Esc/abort/no dialog. */
	choice: string | null;
	outcome: ChoiceOutcome;
	waitMs: number;
	/** Pattern(s) remembered, when the outcome saved one. */
	remembered?: string;
	scope?: "session" | "project";
	/** "No, and tell pi what to do instead" text. */
	feedback?: string;
	/** Set when the dialog was relayed from a subagent child to the parent's UI. */
	via?: "child-relay" | "background";
}

/** The user's answer to a permission dialog (or its absence: no-ui, auto-reject). */
export function logChoice(pi: ExtensionAPI, event: ChoiceEvent): void {
	append(pi, {
		phase: "choice",
		toolCallId: event.toolCallId,
		tool: event.tool,
		mode: event.mode,
		target: shrinkMiddle(event.target, TARGET_LIMIT, TARGET_HEAD),
		matcher: event.matcher,
		options: {
			primary: event.options.primary.map((o) => shrink(o, LABEL_LIMIT)),
			secondary: event.options.secondary.map((o) => shrink(o, LABEL_LIMIT)),
		},
		choice: event.choice === null ? null : shrink(event.choice, LABEL_LIMIT),
		outcome: event.outcome,
		waitMs: event.waitMs,
		...(event.via !== undefined ? { via: event.via } : {}),
		remembered: shrinkOptional(event.remembered, LABEL_LIMIT),
		scope: event.scope,
		feedback: shrinkOptional(event.feedback, TEXT_LIMIT, TEXT_HEAD),
	});
}

/** The mode a background request claimed differs from the one the parent judged it in (the parent's wins). */
export function logRemoteMode(pi: ExtensionAPI, requestId: string, claimed: string, used: ModeName): void {
	append(pi, { phase: "remote-mode", toolCallId: requestId, claimed, mode: used });
}

/** A pattern picked in "Allow a different command pattern…", and the scope it was saved to. */
export function logPattern(pi: ExtensionAPI, toolCallId: string, pattern: string, scope: "session" | "project"): void {
	append(pi, { phase: "pattern", toolCallId, pattern: shrink(redactCommand(pattern), LABEL_LIMIT), scope });
}

export type PlanOutcome = "execute-auto" | "execute-manual" | "execute-manual-commands" | "execute-manual-feedback" | "keep-planning" | "rejected" | "aborted";

/** The answer to an exit_plan_mode approval dialog. */
export function logPlanApproval(
	pi: ExtensionAPI,
	toolCallId: string,
	options: readonly string[],
	choice: string | null,
	outcome: PlanOutcome,
	commands: readonly string[] = [],
	feedback?: string,
): void {
	append(pi, {
		phase: "plan",
		toolCallId,
		options: options.map((o) => shrink(o, LABEL_LIMIT)),
		choice: choice === null ? null : shrink(choice, LABEL_LIMIT),
		outcome,
		commands: commands.map((c) => shrink(redactCommand(c), LABEL_LIMIT)),
		feedback: shrinkOptional(feedback, TEXT_LIMIT, TEXT_HEAD),
	});
}

/** The answer to the "Load N allow rules?" review of the project rules file. */
export function logRulesReview(pi: ExtensionAPI, choice: "load" | "ignore", rules: number): void {
	append(pi, { phase: "rules-review", choice, rules });
}

/** Telemetry must never break the permission flow. */
function append(pi: ExtensionAPI, data: Record<string, unknown>): void {
	try {
		pi.appendEntry(TELEMETRY_ENTRY, data);
	} catch {
		// no session to append to: drop the event
	}
}
