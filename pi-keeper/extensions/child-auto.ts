/**
 * Entry point pi-subagents loads in children of a parent in auto mode with the
 * `/keeper` setting enabled (registered by subagents-bridge.ts). Not
 * listed in package.json: pi must not load it itself.
 *
 * Auto where the child's asks can reach the parent's user: a foreground child
 * runs in the parent's process and finds its UI relay; a background child
 * (async: true) is a separate process with no relay, but with background asks
 * on (the default) it files its asks in the parent's mailbox, so it runs auto
 * too. Without a way to ask, a relay-less child falls back to default mode,
 * exactly as before background asks existed, unless the `/keeper`
 * setting `background-auto-fallback` opts it into auto: edits and commands inside the
 * project run unasked, while dangerous commands, secrets and protected paths
 * still ask (and are denied, fail-closed). The choice is relaylessChildMode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import keeperExtension from "./index.ts";
import { loadConfig } from "./config.ts";
import { canAskParent } from "./remote-relay.ts";
import { relaylessChildMode } from "./subagents-bridge.ts";
import { findUiRelay } from "./ui-relay.ts";

export default function childAuto(pi: ExtensionAPI): void {
	let childMode: "default" | "auto" = "auto";
	if (findUiRelay() === undefined) {
		const config = loadConfig(getAgentDir());
		childMode = relaylessChildMode("auto", { backgroundAsks: canAskParent(config, getAgentDir()), backgroundAutoFallback: config.backgroundAutoFallback });
	}
	keeperExtension(pi, { childMode });
}
