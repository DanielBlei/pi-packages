/**
 * Thinking levels for subagent children: the `/keeper` setting
 * `subagent-thinking` decides whether a child keeps its own level (`role`,
 * the agent file's `thinking`) or follows the parent session's (`follow`).
 *
 * Follow means "never lower than the role asked for, never lower than the
 * parent": the effective level is the higher of the two. That keeps the two
 * guarantees the setup makes — thinking is always on, and a role's own floor
 * (as configured: `medium` for scout, `high` for worker and reviewer) survives a
 * parent that later drops to `low` — while a parent that goes to `high` lifts
 * every child with it.
 * `off` is the bottom of the order: an explicit `:off` on a launch is not
 * honoured under `follow` when the role or the parent is above it, because
 * "thinking off" is the one thing this setting exists to prevent; use `role`
 * or edit the agent file when that is what you want.
 *
 * Free of pi types so it is testable (like child-lane.ts).
 */

/** pi's levels, least to most thinking. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** What `/keeper subagent-thinking` accepts. */
export const SUBAGENT_THINKING_MODES = ["follow", "role"] as const;

export type SubagentThinkingMode = (typeof SUBAGENT_THINKING_MODES)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevelName {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isSubagentThinkingMode(value: unknown): value is SubagentThinkingMode {
	return typeof value === "string" && (SUBAGENT_THINKING_MODES as readonly string[]).includes(value);
}

function rank(level: ThinkingLevelName): number {
	return THINKING_LEVELS.indexOf(level);
}

/** The higher of two levels; either may be missing. */
export function maxThinking(a: ThinkingLevelName | undefined, b: ThinkingLevelName | undefined): ThinkingLevelName | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return rank(a) >= rank(b) ? a : b;
}

/**
 * The level a child should run at, or undefined when nothing should change.
 *
 * `own` is the level the child resolved for itself (its agent file's
 * `thinking`, or a level a launch pinned), `parent` the parent session's
 * current level. In `role` mode the child keeps its own level and the parent
 * is ignored. In `follow` mode the child runs at the higher of the two, so an
 * unset child takes the parent's level and a pinned child is only ever
 * raised.
 */
export function childThinkingLevel(own: ThinkingLevelName | undefined, parent: ThinkingLevelName | undefined, mode: SubagentThinkingMode): ThinkingLevelName | undefined {
	if (mode === "role") return undefined;
	return maxThinking(own, parent);
}
