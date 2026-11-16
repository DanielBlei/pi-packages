/**
 * Reading the Mermaid charts out of the docs, shared by the drift test
 * (tests/unit/mode-charts.test.ts) and the render check (check.ts), so
 * the convention lives in one place: a fenced ```mermaid block whose first line
 * is `%% chart: <name>`; nodes name their rules as `matcher: <x>` / `tool: <x>`;
 * layer subgraphs are `<prefix>_deny|ask|allow`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DESIGN = join(PACKAGE_ROOT, "docs", "design.md");

export interface Chart {
	/** From the `%% chart: <name>` first line, else `chart-<n>`. */
	name: string;
	/** The block as written, first line included. */
	source: string;
	/** True when the block carries the `%% chart:` tag. */
	tagged: boolean;
}

/** Every fenced mermaid block of a markdown text, in order. */
export function chartsOf(markdown: string): Chart[] {
	return [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match, index) => {
		const source = match[1];
		const tag = /^%% chart: (\w+)$/.exec(source.split("\n")[0].trim())?.[1];
		return { name: tag ?? `chart-${index + 1}`, source, tagged: tag !== undefined };
	});
}

export function chartsInFile(path: string): Chart[] {
	return chartsOf(readFileSync(path, "utf8"));
}

/** Text of every subgraph by id (a nested subgraph's text also counts for each one enclosing it). Throws on unbalanced `subgraph`/`end`. */
export function subgraphs(source: string): Map<string, string> {
	const texts = new Map<string, string>();
	const stack: string[] = [];
	for (const line of source.split("\n")) {
		const open = /^\s*subgraph\s+(\w+)\s*\[/.exec(line);
		if (open) {
			stack.push(open[1]);
			texts.set(open[1], "");
		} else if (/^\s*end\s*$/.test(line)) {
			if (stack.pop() === undefined) throw new Error("an `end` without a subgraph");
		} else {
			for (const id of stack) texts.set(id, `${texts.get(id)}${line}\n`);
		}
	}
	if (stack.length > 0) throw new Error(`unclosed subgraph: ${stack.join(", ")}`);
	return texts;
}

/** `matcher: x` and `tool: x` tags in a block of chart text, sorted. */
export function tags(text: string): string[] {
	return [...text.matchAll(/\b(matcher|tool): ([A-Za-z_]+)/g)].map((m) => `${m[1]}: ${m[2]}`).sort();
}
