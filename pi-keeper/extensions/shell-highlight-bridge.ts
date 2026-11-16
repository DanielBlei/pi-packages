/**
 * The seam to `pi-shell-highlight`: a command highlighter that colors command names
 * and the inner language of a heredoc, published by that package under a
 * process-global registry key.
 *
 * Why a global and not an import: the two packages must stay independent. This one
 * works with `previewTextColor: "builtin-syntax"` alone, and pi clears the extension
 * module cache per child, so module state does not travel between them anyway. The
 * same pattern carries the UI relay (ui-relay.ts) and the child gate (index.ts).
 *
 * Fail soft, unlike the relay: a registry we can't read, a value of the wrong shape,
 * or a highlighter that throws means "not available", and the dialog keeps pi's own
 * `highlightCode`. Nothing here throws.
 */

/** Where `pi-shell-highlight` publishes its highlighter; keep the version in step with it. */
export const HIGHLIGHTER_KEY: symbol = Symbol.for("pi.shell-highlight.v1");

/** How the dialog paints the decisions the highlighter makes. */
export interface CommandStyle {
	/** Wrap a command name in color. Must return a self-contained span. */
	command(text: string): string;
	/** Wrap a line that gets no language: a heredoc terminator, or a body past the line cap. */
	plain(text: string): string;
	/** Wrap an assignment target in a heredoc body (`rows = …`). */
	variable?(text: string): string;
	/** Wrap a command that runs a language or a project's tasks (`python`, `go`, `npm`, `make`). */
	runner?(text: string): string;
	/** Wrap a precommand modifier (`sudo`, `env`, `nohup`, `rtk`). */
	precommand?(text: string): string;
	/** Wrap an option (`-n`, `--json`). */
	option?(text: string): string;
}

/** What `pi-shell-highlight` registers. */
export type CommandHighlighter = (text: string, lang: string | undefined, style: CommandStyle) => string[];

/** The registered highlighter, or undefined when the package is not loaded or unusable. */
export function commandHighlighter(): CommandHighlighter | undefined {
	try {
		const registry = globalThis as unknown as Record<symbol, unknown>;
		const entry = registry[HIGHLIGHTER_KEY] as { highlightCommand?: unknown } | undefined;
		if (entry === null || typeof entry !== "object") return undefined;
		const highlight = entry.highlightCommand;
		if (typeof highlight !== "function") return undefined;
		return highlight as CommandHighlighter;
	} catch {
		return undefined;
	}
}
