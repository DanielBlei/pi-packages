/**
 * Check that every Mermaid chart in the docs parses and renders.
 *
 * Renders each fenced ```mermaid block with mermaid-cli (through npx, in a temp
 * dir; nothing is written to the repo) and fails when Mermaid rejects one.
 * tests/unit/mode-charts.test.ts ties the charts to modes.ts; this checks the
 * syntax with Mermaid's own parser, which needs a browser, so it is not part of
 * `npm test`.
 *
 * Needs npx and a Chrome/Chromium (on PATH, or PUPPETEER_EXECUTABLE_PATH), and
 * network on the first run to fetch mermaid-cli. Without them it says so and
 * exits 0 (--strict: exits 1).
 *
 * Usage (from pi-keeper/):
 *   npm run check:charts                      # docs/*.md, Mermaid 10.9.1
 *   npm run check:charts -- --latest          # also the newest Mermaid
 *   npm run check:charts -- --file a.md b.md  # other files
 *   npm run check:charts -- --strict          # missing tools = failure
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { chartsInFile, PACKAGE_ROOT } from "./lib.ts";

/** The oldest Mermaid worth supporting: renderers such as GitHub's lag behind the latest. */
const PINNED = "10.9.1";
const CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
const TIMEOUT_MS = 300_000;

function onPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

function findChrome(): string | undefined {
	const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (configured !== undefined && configured !== "" && existsSync(configured)) return configured;
	for (const name of CHROME_NAMES) {
		const found = onPath(name);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** null when mermaid-cli renders `source` (a .mmd file); else why not. */
function render(version: string, source: string, workdir: string, chrome: string): string | null {
	const config = join(workdir, "puppeteer.json");
	// --no-sandbox: Chrome refuses to start as root or in a container without it
	writeFileSync(config, JSON.stringify({ executablePath: chrome, args: ["--no-sandbox"] }));
	const out = join(workdir, "out.svg");
	rmSync(out, { force: true });
	const result = spawnSync("npx", ["-y", `@mermaid-js/mermaid-cli@${version}`, "-p", config, "-i", source, "-o", out], {
		cwd: workdir,
		encoding: "utf8",
		timeout: TIMEOUT_MS,
	});
	if (result.error !== undefined) return `${result.error.message}${result.signal === "SIGTERM" ? ` (timed out after ${TIMEOUT_MS / 1000}s)` : ""}`;
	if (result.status === 0 && existsSync(out)) return null;
	// the head holds Mermaid's message; the rest is a puppeteer stack trace
	const lines = `${result.stdout}${result.stderr}`.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("at "));
	return lines.slice(0, 8).join("\n") || `exit ${result.status}`;
}

function parseArgs(argv: string[]): { files: string[]; latest: boolean; strict: boolean } {
	const files: string[] = [];
	let latest = false;
	let strict = false;
	let collecting = false;
	for (const arg of argv) {
		if (arg === "--latest") latest = true;
		else if (arg === "--strict") strict = true;
		else if (arg === "--file") collecting = true;
		else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
		else if (collecting) files.push(arg);
		else throw new Error(`unexpected argument ${arg} (files go after --file)`);
	}
	return { files, latest, strict };
}

function main(): number {
	const args = parseArgs(process.argv.slice(2));
	const docs = join(PACKAGE_ROOT, "docs");
	const files = args.files.length > 0 ? args.files : readdirSync(docs).filter((f) => f.endsWith(".md")).sort().map((f) => join(docs, f));
	const charts = files.flatMap((file) => chartsInFile(file).map((chart) => ({ file: relative(process.cwd(), file), ...chart })));
	if (charts.length === 0) {
		console.error("no mermaid blocks found");
		return 1;
	}

	const chrome = findChrome();
	const npx = onPath("npx");
	if (npx === undefined || chrome === undefined) {
		const missing = npx === undefined ? "npx" : "Chrome/Chromium (set PUPPETEER_EXECUTABLE_PATH)";
		console.error(`skipped: ${missing} not found, ${charts.length} chart(s) not rendered`);
		return args.strict ? 1 : 0;
	}

	const versions = args.latest ? [PINNED, "latest"] : [PINNED];
	const workdir = mkdtempSync(join(tmpdir(), "pdf-mermaid-"));
	let failed = 0;
	try {
		for (const version of versions) {
			for (const chart of charts) {
				const source = join(workdir, `${chart.name}.mmd`);
				writeFileSync(source, chart.source);
				const problem = render(version, source, workdir, chrome);
				console.log(`${problem === null ? "ok  " : "FAIL"} mermaid ${version.padEnd(7)} ${chart.file} [${chart.name}]`);
				if (problem !== null) {
					failed++;
					console.log(`     ${problem.replaceAll("\n", "\n     ")}`);
				}
			}
		}
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
	const total = charts.length * versions.length;
	console.log(`${total - failed} of ${total} renders passed`);
	return failed > 0 ? 1 : 0;
}

try {
	process.exitCode = main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
