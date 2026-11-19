/** A two-entry stand-in for tests/fixtures/decisions.ts: the same exports, used by the replay tests. */
import type { GLOBAL_RULES, MODES, ModeName } from "../../../extensions/modes.ts";
import type { Action, EvalContext, evaluate } from "../../../extensions/rules.ts";
import type { approvalBreakdown, formatBreakdown, isReadOnlyCommand } from "../../../extensions/utils.ts";

export interface FixtureEnv {
	scratch: string;
	cwd: string;
}
interface Expect {
	action: Action;
	rule: string;
}
export interface Entry {
	id: string;
	command: (env: FixtureEnv) => string;
	tool?: string;
	ctx?: Partial<EvalContext>;
	today: Record<ModeName, Expect>;
	guard?: true;
	twin?: string;
}
export interface DecisionApi {
	evaluate: typeof evaluate;
	MODES: typeof MODES;
	GLOBAL_RULES: typeof GLOBAL_RULES;
	approvalBreakdown: typeof approvalBreakdown;
	formatBreakdown: typeof formatBreakdown;
	isReadOnlyCommand: typeof isReadOnlyCommand;
}

const same = (action: Action): Record<ModeName, Expect> => ({ default: { action, rule: "x" }, auto: { action, rule: "x" }, plan: { action, rule: "x" } });

export const ENTRIES: Entry[] = [
	{ id: "mini/sudo", command: () => "sudo true", today: same("deny"), guard: true },
	{ id: "mini/ls", command: () => "ls", today: same("allow") },
];

export function judge(entry: Entry, mode: ModeName, api: DecisionApi, env: FixtureEnv): { action: Action; rule: string; why?: string } {
	const ctx: EvalContext = { cwd: env.cwd, scratchDir: env.scratch, remembered: [], ...entry.ctx };
	const decision = api.evaluate(api.MODES[mode].permissions, api.GLOBAL_RULES, { toolName: entry.tool ?? "bash", input: { command: entry.command(env) } }, ctx);
	return { action: decision.action, rule: decision.rule?.match ?? "fallback" };
}
