/**
 * Entry point pi-subagents loads in children of a parent in plan mode
 * (registered by subagents-bridge.ts). Not listed in package.json: pi must
 * not load it itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import keeperExtension from "./index.ts";

export default function childPlan(pi: ExtensionAPI): void {
	keeperExtension(pi, { childMode: "plan" });
}
