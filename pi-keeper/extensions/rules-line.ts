/**
 * The rules line: the user's own rules in effect, appended to the parent's
 * and every child's prompt (index.ts, before_agent_start). The mode prompt
 * and the lane line describe the mode; this line names the user data on top
 * of it: the project's allow/ask/deny entries and `Read(<dir>/**)` dirs
 * (.pi/settings.local.json) and what the user granted this session.
 *
 * Which of them a mode honours is read from that mode's rules (the matcher is
 * listed or not), so the line can't promise what the gate won't do: plan mode
 * ignores project allow rules, auto mode needs no allow list at all.
 * Locked by tests/unit/rules-line.test.ts.
 *
 * Free of pi types so it is testable (like child-lane.ts).
 */

import { GLOBAL_RULES, MODES, type ChildMode } from "./modes.ts";
import type { ProjectPermissions } from "./project-rules.ts";
import type { UiRelaySessionRules } from "./ui-relay.ts";

/** Entries named before the rest is summed up as "+N more": keeps the prompt short. */
export const RULES_LINE_CAP = 20;

export interface RulesLineInput {
	readonly mode: ChildMode;
	readonly project: ProjectPermissions;
	/** The session grants: the parent's own, or the parent's as a child sees them; undefined when there are none. */
	readonly session: UiRelaySessionRules | undefined;
}

function honours(mode: ChildMode, matcher: string): boolean {
	return [...GLOBAL_RULES, ...MODES[mode].permissions.rules].some((rule) => rule.match === matcher && rule.action !== "deny");
}

const command = (tokens: readonly string[], exact: boolean): string => `\`${tokens.join(" ")}${exact ? "" : " …"}\``;
const directory = (dir: string): string => `${dir.replace(/\/+$/, "")}/`;

/** The rules line, or "" when the user has no rules this mode honours. */
export function rulesLine({ mode, project, session }: RulesLineInput): string {
	const groups: { label: string; items: string[] }[] = [];
	// ask and deny are global: they apply in every mode
	groups.push({ label: "Project rules deny", items: project.deny.map((rule) => command(rule.tokens, rule.exact)) });
	groups.push({ label: "Project rules ask before", items: project.ask.map((rule) => command(rule.tokens, rule.exact)) });
	const allowed: string[] = [];
	if (honours(mode, "projectAllowBash")) {
		allowed.push(...project.allow.prefixes.map((tokens) => command(tokens, false)), ...project.allow.exact.map((tokens) => command(tokens, true)));
	}
	if (honours(mode, "rememberedBash") && session !== undefined) {
		allowed.push(...session.prefixes.map((tokens) => command(tokens, false)), ...session.exact.map((tokens) => command(tokens, true)));
	}
	groups.push({ label: "Commands allowed without asking (dangerous ones still ask)", items: [...new Set(allowed)] });
	const dirs = [...project.readDirs, ...(session?.outsideReadDirs ?? [])].map(directory);
	groups.push({ label: "Reads allowed outside the working directory (secrets still ask)", items: [...new Set(dirs)] });
	// fetch grants make a GET read-only; auto runs every GET anyway
	if (honours(mode, "readOnlyBash")) {
		const hosts = [...project.fetchHosts, ...(session?.fetchHosts ?? [])];
		groups.push({ label: "Hosts curl/wget GETs reach without asking", items: [...new Set(hosts)] });
	}

	let budget = RULES_LINE_CAP;
	const parts: string[] = [];
	for (const { label, items } of groups) {
		if (items.length === 0) continue;
		const shown = items.slice(0, Math.max(budget, 0));
		budget -= shown.length;
		const more = items.length - shown.length;
		parts.push(`${label}: ${shown.join(", ")}${more > 0 ? `${shown.length > 0 ? ", " : ""}+${more} more` : ""}.`);
	}
	if (session?.outsideReads === true) parts.push("All reads outside the working directory are allowed this session (secrets still ask).");
	if (session?.edits === true && honours(mode, "sessionEdits")) parts.push("All file edits are allowed this session (protected paths still ask).");
	return parts.length === 0 ? "" : `Your user's rules: ${parts.join(" ")}`;
}
