/**
 * Permission telemetry: every decision and dialog is appended to the
 * session log as a `pi-keeper-permission` custom entry (never sent to
 * the LLM), with bounded payloads. Read it back with
 * scripts/extract_flow.py.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModeName } from "./modes.ts";
import { commandOf, pathOf, type Decision, type ToolCall } from "./rules.ts";

export const TELEMETRY_ENTRY = "pi-keeper-permission";

export const TARGET_LIMIT = 200;
const TARGET_HEAD = 120;
const LABEL_LIMIT = 160;
export const TEXT_LIMIT = 200;
const TEXT_HEAD = 120;

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
	if (call.toolName === "bash" || call.toolName === "powershell") return commandOf(call.input);
	const path = pathOf(call.input);
	if (path !== "") return path;
	return JSON.stringify(call.input ?? {});
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
	| "project-read-dirs"
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
	append(pi, { phase: "pattern", toolCallId, pattern: shrink(pattern, LABEL_LIMIT), scope });
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
		commands: commands.map((c) => shrink(c, LABEL_LIMIT)),
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
