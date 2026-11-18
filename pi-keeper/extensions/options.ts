/**
 * Options of the permission dialog, split into a short primary list and a
 * secondary list behind "More…". Pure, so the shape per kind of ask is tested.
 */

import { sanitizeForTerminal } from "./preview.ts";

export const ALLOW_ONCE = "Yes";
export const SWITCH_TO_AUTO = "Yes, and switch to auto mode";
export const REJECT = "No";
export const REJECT_WITH_FEEDBACK = "No, and tell pi what to do instead";
export const ALLOW_EDITS = "Yes, allow all edits this session";
/** The same grant as ALLOW_EDITS, worded for a background subagent's ask: the answer covers the parent session too. */
export const ALLOW_EDITS_SHARED = "Yes, allow all edits this session, for the parent and its subagents";
export const ALLOW_OUTSIDE_READS = "Yes, allow reads outside the working directory for this session";
/** "Yes, and allow reading from <dir>/ this session": built per ask from the directories (see readGrantLabel). */
export function readGrantLabel(dirs: readonly string[]): string {
	const shown = dirs.slice(0, 2).map((d) => sanitizeForTerminal(d.endsWith("/") ? d : `${d}/`));
	const more = dirs.length > 2 ? ` (+${dirs.length - 2} more)` : "";
	return `Yes, and allow reading from ${shown.join(", ")}${more} this session`;
}
/** "Yes, and always allow reading from <dir>/ in this project": the `/keeper` project-read-approvals setting. */
export function projectReadGrantLabel(dirs: readonly string[]): string {
	const shown = dirs.slice(0, 2).map((d) => sanitizeForTerminal(d.endsWith("/") ? d : `${d}/`));
	const more = dirs.length > 2 ? ` (+${dirs.length - 2} more)` : "";
	return `Yes, and always allow reading from ${shown.join(", ")}${more} in this project`;
}
/** "Yes, and allow fetching from <host> this session": a curl/wget GET to a host not yet allowed. */
export function fetchGrantLabel(hosts: readonly string[]): string {
	return `Yes, and allow fetching from ${hosts.map((h) => sanitizeForTerminal(h)).join(", ")} this session`;
}
/** "Yes, and allow git in <repo>/ this session": a cd into another git repository, for the repo roots it runs git in (see gitGrantRoots). */
export function gitGrantLabel(roots: readonly string[]): string {
	const shown = roots.slice(0, 2).map((d) => sanitizeForTerminal(d.endsWith("/") ? d : `${d}/`));
	const more = roots.length > 2 ? ` (+${roots.length - 2} more)` : "";
	return `Yes, and allow git in ${shown.join(", ")}${more} this session`;
}
/** "Yes, and always allow fetching from <host> in this project": saved as Fetch(<host>). */
export function projectFetchGrantLabel(hosts: readonly string[]): string {
	return `Yes, and always allow fetching from ${hosts.map((h) => sanitizeForTerminal(h)).join(", ")} in this project`;
}
/** Offered when no prefix rule can be made for a command (an interpreter, a compound with a script): only this exact text is remembered. */
export const REMEMBER_EXACT = "Yes, and don't ask again for this exact command this session";
/** The same grant for a subagent's ask: the answer is stored in the parent session, so every child sees it. */
export const REMEMBER_EXACT_SHARED = "Yes, and don't ask again for this exact command this session, for me and my subagents";
/** Offered for the same commands when the `project-exact-commands` setting is on: the exact rule persists in .pi/settings.local.json. */
export const PROJECT_EXACT = "Yes, and always allow this exact command in this project";
export const OTHER_PATTERN = "Allow a different command pattern…";
export const MORE = "More…";

export interface DialogOptionsInput {
	mode: "default" | "auto" | "plan";
	toolName: string;
	/** `decision.rule?.match`: undefined = the mode's fallback decided. */
	ruleMatch: string | undefined;
	/** A pattern ladder exists for "Allow a different command pattern…". */
	sessionLabel?: string;
	/** "Yes, and always allow <commands> in this project…" label. */
	projectLabel?: string;
	/** Offer REMEMBER_EXACT: the command needs approval, no prefix can cover it, and this is the user's own default-mode session. */
	exactCommand?: boolean;
	/** Offer PROJECT_EXACT after REMEMBER_EXACT: the `project-exact-commands` setting is on and the exact rule is representable. */
	projectExactCommands?: boolean;
	/** A pattern ladder exists for "Allow a different command pattern…". */
	hasLadder: boolean;
	/** "Yes, and allow reading from <dir>/ this session" label for an outside read; undefined when no directory can be granted. */
	readGrantLabel?: string;
	/** "Yes, and always allow reading from <dir>/ in this project" label; undefined unless the setting is on. */
	projectReadGrantLabel?: string;
	/** "Yes, and allow fetching from <host> this session" label; undefined when no host grant would remove the ask. */
	fetchGrantLabel?: string;
	/** "Yes, and always allow fetching from <host> in this project" label; undefined unless project options are on. */
	projectFetchGrantLabel?: string;
	/** "Yes, and allow git in <repo>/ this session" label; undefined when no repo grant would remove the ask. */
	gitGrantLabel?: string;
	/** The ask comes from a subagent child: no switching to auto mode (children can't switch). */
	child?: boolean;	/** Offer REJECT_WITH_FEEDBACK (default true). False when the answer cannot carry text back, as for a background child. */
	feedback?: boolean;
	/** Word the edits grant as covering the parent and its subagents (a background child's ask is answered in the parent). */
	sharedEdits?: boolean;
}

export interface DialogOptions {
	/** Shown first; ends with MORE when the secondary list has 2 or more options. */
	primary: string[];
	/** What MORE opens (also appended to `primary` when there are fewer than 2). */
	secondary: string[];
}

export function dialogOptions(input: DialogOptionsInput): DialogOptions {
	const fallback = input.ruleMatch === undefined;
	// only when the edit fell to the fallback: protected / outside / secret asks keep Yes only
	const canAllowEdits = input.mode === "default" && fallback && (input.toolName === "edit" || input.toolName === "write");
	const canSwitch = input.mode === "default" && fallback && input.child !== true;

	const primary = [ALLOW_ONCE];
	if (input.sessionLabel !== undefined) primary.push(input.sessionLabel);
	if (input.projectLabel !== undefined) primary.push(input.projectLabel);
	if (input.exactCommand === true && input.mode === "default" && input.sessionLabel === undefined) primary.push(input.child === true ? REMEMBER_EXACT_SHARED : REMEMBER_EXACT);
	if (input.projectExactCommands === true && input.mode === "default" && input.sessionLabel === undefined) primary.push(PROJECT_EXACT);
	if (input.readGrantLabel !== undefined) primary.push(input.readGrantLabel);
	if (input.projectReadGrantLabel !== undefined) primary.push(input.projectReadGrantLabel);
	if (input.fetchGrantLabel !== undefined) primary.push(input.fetchGrantLabel);
	if (input.projectFetchGrantLabel !== undefined) primary.push(input.projectFetchGrantLabel);
	if (input.gitGrantLabel !== undefined) primary.push(input.gitGrantLabel);
	if (canAllowEdits) primary.push(input.sharedEdits === true ? ALLOW_EDITS_SHARED : ALLOW_EDITS);
	primary.push(REJECT);

	const secondary = input.feedback === false ? [] : [REJECT_WITH_FEEDBACK];
	// all outside reads for the session: behind More…, the per-directory grant is the first choice
	if (input.ruleMatch === "outsideCwdRead") secondary.push(ALLOW_OUTSIDE_READS);
	if (input.hasLadder) secondary.push(OTHER_PATTERN);
	if (canSwitch) secondary.push(SWITCH_TO_AUTO);

	if (secondary.length >= 2) primary.push(MORE);
	else primary.push(...secondary);
	return { primary, secondary };
}
