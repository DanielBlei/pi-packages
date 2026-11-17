/**
 * Compatibility with pi-cc-extensions (an optional community package). It restyles
 * every tool row and, while a tool runs, shows only "↳ Pending…", which hides
 * pi-keeper's exit_plan_mode plan above the approval selector. The fix is to list
 * "exit_plan_mode" in `excludeRenderers` of `<agent dir>/pi-cc-extensions.json`,
 * keeping every other setting. At session start index.ts offers that edit in a dialog
 * when the status is needs-fix, and scripts/exclude_exit_plan_mode.py does the same from a shell.
 *
 * Detection: pi reports the registered slash commands (pi.getCommands()), and
 * pi-cc-extensions registers `/ccstyle`; the caller passes that as `loaded`. Without
 * it, the package counts as present when `<agent dir>/settings.json` lists it or
 * its settings file exists.
 *
 * Free of pi types so it is testable (like config.ts).
 */

import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./secure-file.ts";

export const CC_SETTINGS_FILE = "pi-cc-extensions.json";
const CC_PACKAGE = "pi-cc-extensions";
/** The tool whose renderer pi-cc-extensions must leave alone. */
const PLAN_TOOL = "exit_plan_mode";

/**
 * absent: not in use here. ok: the plan approval is shown. needs-fix: pi-cc-extensions is in
 * use and hides the plan. unreadable: its settings file is there but cannot be used.
 */
export type CcExtensionsStatus = "absent" | "ok" | "needs-fix" | "unreadable";

/** `<agent dir>/pi-cc-extensions.json`. */
export function ccSettingsPath(agentDir: string): string {
	return join(agentDir, CC_SETTINGS_FILE);
}

/** True when `<agent dir>/settings.json` lists pi-cc-extensions as a package (a string or an object with `source`). */
function listedInSettings(agentDir: string): boolean {
	try {
		const parsed = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown };
		if (!Array.isArray(parsed.packages)) return false;
		return parsed.packages.some((entry) => {
			const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
			return typeof source === "string" && source.includes(CC_PACKAGE);
		});
	} catch {
		return false;
	}
}

/** The status of pi-cc-extensions for this agent dir. `loaded`: pi reports its `/ccstyle` command. Never throws. */
export function ccExtensionsStatus(agentDir: string, loaded = false): CcExtensionsStatus {
	const path = ccSettingsPath(agentDir);
	const present = existsSync(path);
	if (!loaded && !present && !listedInSettings(agentDir)) return "absent";
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		// no file yet: the defaults, which hide the plan
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "needs-fix";
		return "unreadable";
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return "unreadable";
	const excluded = (value as { excludeRenderers?: unknown }).excludeRenderers;
	if (excluded === undefined) return "needs-fix";
	if (!Array.isArray(excluded)) return "unreadable";
	return excluded.includes(PLAN_TOOL) ? "ok" : "needs-fix";
}

/**
 * Add exit_plan_mode to `excludeRenderers` in the settings file (created when absent), keeping
 * every other key. Idempotent. Returns the error text, or undefined when the file is now right.
 * An unreadable file is refused and left as it is.
 */
export function excludeExitPlanMode(agentDir: string): string | undefined {
	const path = ccSettingsPath(agentDir);
	let settings: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return `${path} does not hold a JSON object; fix it by hand`;
		settings = parsed as Record<string, unknown>;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			const reason = error instanceof SyntaxError ? "not valid JSON" : error instanceof Error ? error.message : String(error);
			return `Could not read ${path}: ${reason}`;
		}
	}
	const excluded: unknown = settings.excludeRenderers ?? [];
	if (!Array.isArray(excluded)) return `excludeRenderers in ${path} is not a list; fix it by hand`;
	if (excluded.includes(PLAN_TOOL)) return undefined;
	settings.excludeRenderers = [...excluded, PLAN_TOOL];
	try {
		// another package's file: keep its permissions (writeFileAtomic creates files 0600)
		const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
		writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
		if (mode !== undefined) chmodSync(path, mode);
	} catch (error) {
		return `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
	return undefined;
}
