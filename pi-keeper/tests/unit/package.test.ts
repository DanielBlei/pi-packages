/**
 * The published package: what package.json promises pi and npm. Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const pkg = JSON.parse(read("package.json")) as {
	pi: { extensions: string[]; prompts: string[] };
	files: string[];
};

test("pi.extensions lists ./extensions/index.ts, and that file exists and default-exports the extension", async () => {
	assert.ok(pkg.pi.extensions.includes("./extensions/index.ts"), JSON.stringify(pkg.pi.extensions));
	const entry = join(ROOT, "extensions", "index.ts");
	assert.ok(existsSync(entry), `${entry} exists`);
	const mod = await import(entry);
	assert.equal(typeof mod.default, "function", "the extension is the default export, a function pi calls with its API");
});

test("every directory in pi.prompts exists", () => {
	assert.ok(pkg.pi.prompts.length > 0);
	for (const dir of pkg.pi.prompts) {
		const path = join(ROOT, dir);
		assert.ok(existsSync(path), `${dir} exists`);
		assert.ok(statSync(path).isDirectory(), `${dir} is a directory`);
	}
});

test("prompt-templates/new-rule.md has a description and an argument-hint in its frontmatter, and its body uses $@", () => {
	const text = read("prompt-templates/new-rule.md");
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	assert.ok(match !== null, "the file starts with a frontmatter block");
	const [, frontmatter, body] = match;
	assert.match(frontmatter, /^description:\s*\S/m);
	assert.match(frontmatter, /^argument-hint:\s*\S/m);
	assert.match(body, /\$@/, "the body receives the arguments through $@");
});

test("the files list covers extensions, prompts, prompt-templates, README.md, CHANGELOG.md and NOTICE, and each exists", () => {
	for (const entry of ["extensions", "prompts", "prompt-templates", "README.md", "CHANGELOG.md", "NOTICE"]) {
		assert.ok(pkg.files.includes(entry), `files lists ${entry}`);
		assert.ok(existsSync(join(ROOT, entry)), `${entry} exists`);
	}
});
