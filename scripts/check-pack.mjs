// Fails when a package tarball would miss a file every release needs, miss an
// entry point pi loads, or ship something that belongs only in the repository.
// Usage: node scripts/check-pack.mjs <workspace>...   (run from the repo root)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";

const REQUIRED = ["package.json", "LICENSE", "NOTICE", "README.md", "CHANGELOG.md"];
const FORBIDDEN = [/^tests\//, /^scripts\//, /^docs\//, /^node_modules\//, /\.py$/, /\.tgz$/, /^tsconfig\.json$/, /(^|\/)\.env/, /(^|\/)\.pi\//];

const workspaces = process.argv.slice(2);
if (workspaces.length === 0) {
	console.error("usage: node scripts/check-pack.mjs <workspace>...");
	process.exit(2);
}

const out = execFileSync("npm", ["pack", "--dry-run", "--json", ...workspaces.flatMap((w) => ["--workspace", w])], { encoding: "utf8" });
const packs = JSON.parse(out);
let failed = false;

for (const [i, pack] of packs.entries()) {
	const paths = new Set(pack.files.map((f) => f.path));
	const manifest = JSON.parse(readFileSync(join(workspaces[i], "package.json"), "utf8"));
	const entries = (manifest.pi?.extensions ?? []).map((e) => normalize(e));
	const problems = [
		...REQUIRED.filter((p) => !paths.has(p)).map((p) => `missing ${p}`),
		...entries.filter((p) => !paths.has(p)).map((p) => `missing pi extension entry ${p}`),
		...[...paths].filter((p) => FORBIDDEN.some((re) => re.test(p))).map((p) => `ships ${p}`),
	];
	if (problems.length > 0) {
		failed = true;
		for (const problem of problems) console.error(`${pack.name}: ${problem}`);
	} else {
		console.log(`${pack.name}@${pack.version}: ${paths.size} files, ${pack.size} bytes packed`);
	}
}

process.exit(failed ? 1 : 0);
