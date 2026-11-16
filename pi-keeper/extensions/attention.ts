/**
 * Terminal attention for dialogs: a BEL plus a desktop notification escape,
 * so a backgrounded terminal tab gets noticed. The text is always a fixed
 * label: command text and paths never leave the TUI.
 */

/** Env var; `0` turns the notification off. */
export const BELL_ENV = "PI_KEEPER_BELL";

export type AttentionLabel = "pi: permission needed" | "pi: plan ready for approval" | "pi: rules need review";

/**
 * The bytes to write, or "" when disabled. Kitty gets OSC 99, other
 * terminals OSC 777 (Ghostty, iTerm2, WezTerm, rxvt-unicode), as in pi's
 * notify.ts example; terminals that know neither ignore the sequence.
 */
export function attentionSequence(label: AttentionLabel, env: NodeJS.ProcessEnv = process.env): string {
	if (env[BELL_ENV] === "0") return "";
	const notify =
		env.KITTY_WINDOW_ID !== undefined && env.KITTY_WINDOW_ID !== ""
			? `\x1b]99;i=1:d=0;pi\x1b\\\x1b]99;i=1:p=body;${label}\x1b\\`
			: `\x1b]777;notify;pi;${label}\x07`;
	return `\x07${notify}`;
}
