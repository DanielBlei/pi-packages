/**
 * Bridge to pi-subagents: makes its child sessions load this extension in the
 * parent's mode (plan -> plan; default -> default; auto -> auto when the
 * `/keeper` setting enables it and the child's asks can reach the
 * parent's UI). A relay-less child (a background child, another process)
 * decides its own mode in the entry it loads (relaylessChildMode): with
 * background asks on it keeps the mode of its entry, like a foreground child;
 * with them off it is default, or auto when the `background-auto-fallback` setting
 * enables it.
 *
 * pi-subagents keeps a process-global registry of "required child
 * extensions" per parent session (its `registerRequiredChildExtensions`).
 * It is written here directly instead of through a package dependency, so
 * it works whatever order the two extensions load in. The mode is baked
 * into which file the child loads (child-plan.ts / child-default.ts), so it
 * is fixed per launch and nested children inherit it.
 *
 * Fail closed: a registry we can't read or a session that is already
 * registered by someone else gives no registration, and index.ts then
 * denies the `subagent` tool. Nothing here throws.
 */

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildMode, ModeName } from "./modes.ts";

/** Where pi-subagents keeps the registry (`src/shared/required-child-extensions.js`). */
export const REGISTRY_KEY = Symbol.for("pi-subagents.required-child-extensions.v1");

/** Entry id in the registry; pi-subagents requires `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`. */
export const BRIDGE_ID = "pi-keeper";

interface RequiredEntry {
	readonly id: string;
	readonly path: string;
	readonly requireForAllRunners: true;
}

type Snapshot = readonly RequiredEntry[];

interface Registry {
	version: 1;
	bySession: Map<string, Snapshot>;
}

export interface BridgeRegistration {
	readonly childMode: ChildMode;
	/** Still the entry the registry holds for the session (nobody replaced or removed it). */
	isCurrent(): boolean;
	/** Remove the entry, unless a newer registration replaced it. */
	dispose(): void;
}

/** Test seams: the object holding the registry key (globalThis in production). */
export interface BridgeOptions {
	root?: Record<symbol, unknown>;
}

/**
 * The child mode that follows a parent mode. An auto parent gets auto
 * children only when `subagentsFollowAuto` is enabled (the `/keeper`
 * setting): child-auto.ts itself falls back to default when the child's
 * asks cannot reach the parent's user (a relay-less child with background
 * asks off), unless the `background-auto-fallback` setting opts it into auto (see
 * relaylessChildMode).
 */
export function childModeFor(mode: ModeName, subagentsFollowAuto = false): ChildMode {
	if (mode === "plan") return "plan";
	if (mode === "auto" && subagentsFollowAuto) return "auto";
	return "default";
}

/**
 * The mode a relay-less child (a background child, another process) runs in,
 * given the mode its entry file stands for (`registered`: child-default.ts or
 * child-auto.ts). With background asks on its asks reach the parent's user,
 * so it follows the parent like a foreground child. Without them every ask
 * is denied: default, or auto when the `background-auto-fallback` setting opts in.
 * The child entries, the test mock and the parent's clamp
 * (ask-server.ts backgroundChildMode) all use this one formula, so the mode
 * the parent judges a request in is the mode the child runs in.
 */
export function relaylessChildMode(registered: "default" | "auto", settings: { backgroundAsks: boolean; backgroundAutoFallback: boolean }): "default" | "auto" {
	if (settings.backgroundAsks) return registered;
	return settings.backgroundAutoFallback ? "auto" : "default";
}

// Extension code lives in extensions/, next to the child entry files
const EXTENSIONS_DIR = dirname(fileURLToPath(import.meta.url));

/** The registry in `root`, created when absent; undefined when it isn't ours to use (wrong shape or version). */
function registryOf(root: Record<symbol, unknown>): Registry | undefined {
	const existing = root[REGISTRY_KEY];
	if (existing === undefined) {
		const created: Registry = { version: 1, bySession: new Map() };
		root[REGISTRY_KEY] = created;
		return created;
	}
	const candidate = existing as { version?: unknown; bySession?: unknown } | null;
	if (candidate === null || typeof candidate !== "object" || candidate.version !== 1 || !(candidate.bySession instanceof Map)) return undefined;
	return candidate as Registry;
}

/**
 * Make children of `sessionId` load the `childMode` entry file. Undefined
 * (fail closed) when the registry is malformed or another version, the
 * session already has a registration, or the entry file can't be resolved.
 */
export function registerChildMode(sessionId: string, childMode: ChildMode, options: BridgeOptions = {}): BridgeRegistration | undefined {
	try {
		if (sessionId === "" || sessionId !== sessionId.trim() || sessionId.length > 256 || sessionId.includes("\0")) return undefined;
		const store = registryOf(options.root ?? (globalThis as Record<symbol, unknown>));
		// not ours to replace: pi-subagents allows one registration per session
		if (store === undefined || store.bySession.has(sessionId)) return undefined;
		const path = realpathSync(join(EXTENSIONS_DIR, `child-${childMode}.ts`));
		const snapshot: Snapshot = Object.freeze([Object.freeze({ id: BRIDGE_ID, path, requireForAllRunners: true as const })]);
		store.bySession.set(sessionId, snapshot);
		return {
			childMode,
			isCurrent: () => store.bySession.get(sessionId) === snapshot,
			dispose() {
				if (store.bySession.get(sessionId) === snapshot) store.bySession.delete(sessionId);
			},
		};
	} catch {
		return undefined;
	}
}
