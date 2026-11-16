/**
 * Entry point pi-subagents loads in children of a parent in default or auto mode
 * (registered by subagents-bridge.ts). Not listed in package.json: pi must
 * not load it itself.
 *
 * A foreground child runs in the parent's process and finds its UI relay, so
 * default mode works: its asks reach the parent's user. A background child
 * (`async: true`) is a separate process with no relay; with background asks
 * on (the default) its asks reach the parent's user through the mailbox, so
 * it stays in default mode too. Without a way to ask, its asks would be
 * denied; the `/keeper` setting `background-auto` then runs such a
 * relay-less child in auto mode instead: edits and commands inside the project
 * run unasked, while dangerous commands, secrets and protected paths still ask
 * (and are denied, fail-closed). The choice is relaylessChildMode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import keeperExtension from "./index.ts";
import { loadConfig } from "./config.ts";
import { canAskParent } from "./remote-relay.ts";
import { relaylessChildMode } from "./subagents-bridge.ts";
import { findUiRelay } from "./ui-relay.ts";

export default function childDefault(pi: ExtensionAPI): void {
	let childMode: "default" | "auto" = "default";
	if (findUiRelay() === undefined) {
		const config = loadConfig(getAgentDir());
		childMode = relaylessChildMode("default", { backgroundAsks: canAskParent(config, getAgentDir()), backgroundAuto: config.backgroundAuto });
	}
	keeperExtension(pi, { childMode });
}
