/**
 * pi-shell-highlight — publishes a command highlighter for the process.
 *
 * This extension renders nothing and owns no tools. It exists so that a package
 * which *does* draw a command can color it without carrying the algorithm:
 *
 *   import { HIGHLIGHTER_KEY } from "pi-shell-highlight/highlight.ts";
 *   const highlighter = (globalThis as Record<symbol, unknown>)[HIGHLIGHTER_KEY];
 *
 * The key is `Symbol.for("pi.shell-highlight.v1")` — a process-global registry, the
 * same pattern pi-keeper uses for its UI relay, because pi clears the extension
 * module cache per child and module state does not travel. The consumer validates the
 * shape and falls back to pi's own highlighter when this package is not loaded.
 *
 * The version in the key (v1) is the contract: `highlightCommand(text, lang, style)`
 * returns one ANSI-colored line per input line, same count and order, and never changes
 * the visible characters.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HIGHLIGHTER_KEY, highlightCommand, type CommandHighlighter } from "./highlight.ts";

const highlighter: CommandHighlighter = { highlightCommand };

export default function piShellHighlight(_pi: ExtensionAPI): void {
	(globalThis as unknown as Record<symbol, unknown>)[HIGHLIGHTER_KEY] = highlighter;
}
