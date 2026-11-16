/**
 * Trusted rtk rewrite for approved bash commands.
 *
 * rtk is a semantics-preserving optimizer: when the user approved
 * `ls`, running `rtk ls` is within that approval. The rewrite is
 * applied by this package itself, after the user approved the
 * original command and before the input is locked — so no other
 * extension is involved, and the lock still holds absolutely
 * afterwards.
 *
 * Same `rtk rewrite` contract as the rtk pi extension:
 *   0 + stdout  rewrite found
 *   1           no rtk equivalent
 *   3 + stdout  rewrite (advisory)
 *
 * Fails open everywhere: if rtk is missing, too old, disabled via
 * RTK_DISABLED=1, times out, or errors, the approved command runs
 * unrewritten.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REWRITE_TIMEOUT_MS = 2_000;
const MIN_SUPPORTED_RTK_MINOR = 23;

export interface CommandRewriter {
	/** Rewritten command, or null to keep the original. Never throws. */
	rewrite(command: string, signal?: AbortSignal): Promise<string | null>;
}

/** Parse "X.Y.Z" semver, return [major, minor, patch] or null. */
function parseSemver(raw: string): [number, number, number] | null {
	const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Probe rtk once. Returns null (rewrite disabled) when rtk is absent,
 * predates 0.23.0 (no `rtk rewrite`), or RTK_DISABLED=1 — in all cases
 * the caller simply keeps approved commands as they are.
 */
export async function createRtkRewriter(pi: ExtensionAPI): Promise<CommandRewriter | null> {
	if (process.env.RTK_DISABLED === "1") return null;
	const version = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS }).catch(() => undefined);
	if (version === undefined || version.code !== 0) return null;
	const parsed = parseSemver(version.stdout.replace(/^rtk\s+/, ""));
	if (parsed && parsed[0] === 0 && parsed[1] < MIN_SUPPORTED_RTK_MINOR) return null;
	return {
		async rewrite(command: string, signal?: AbortSignal): Promise<string | null> {
			if (command.trim() === "" || command.startsWith("rtk ")) return null;
			const result = await pi
				.exec("rtk", ["rewrite", command], { timeout: REWRITE_TIMEOUT_MS, signal })
				.catch(() => undefined);
			if (result === undefined || result.killed) return null;
			if (result.code !== 0 && result.code !== 3) return null;
			return result.stdout.trim() || null;
		},
	};
}
