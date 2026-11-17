/**
 * Tests for the pi-cc-extensions compatibility helper: detection and the
 * excludeRenderers edit. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ccExtensionsStatus, ccSettingsPath, excludeExitPlanMode } from "../../extensions/cc-extensions-compat.ts";

function withAgentDir(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pdf-cc-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const write = (dir: string, name: string, text: string): void => writeFileSync(join(dir, name), text);
const read = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");

test("absent: no settings file, no package listed, and pi does not report the command", () => {
	withAgentDir((dir) => {
		assert.equal(ccExtensionsStatus(dir), "absent");
		write(dir, "settings.json", JSON.stringify({ packages: ["npm:some-other-package"] }));
		assert.equal(ccExtensionsStatus(dir), "absent");
	});
});

test("present through pi's command list: the loaded signal alone, with no file, needs the fix", () => {
	withAgentDir((dir) => {
		assert.equal(ccExtensionsStatus(dir, true), "needs-fix");
	});
});

test("a listed package with no settings file needs the fix (the file is created by the fix)", () => {
	withAgentDir((dir) => {
		write(dir, "settings.json", JSON.stringify({ packages: ["npm:pi-cc-extensions"] }));
		assert.equal(ccExtensionsStatus(dir), "needs-fix");
	});
	withAgentDir((dir) => {
		write(dir, "settings.json", JSON.stringify({ packages: [{ source: "npm:pi-cc-extensions@1.2.0" }] }));
		assert.equal(ccExtensionsStatus(dir), "needs-fix", "the object form of a package entry");
	});
});

test("a settings file that does not list the package is no evidence of it, and a broken one is not an error", () => {
	withAgentDir((dir) => {
		write(dir, "settings.json", "not json");
		assert.equal(ccExtensionsStatus(dir), "absent");
	});
});

test("an existing settings file without exit_plan_mode needs the fix; with it, the plan is shown", () => {
	withAgentDir((dir) => {
		write(dir, "pi-cc-extensions.json", JSON.stringify({ excludeRenderers: ["read"] }));
		assert.equal(ccExtensionsStatus(dir), "needs-fix");
		write(dir, "pi-cc-extensions.json", JSON.stringify({ excludeRenderers: ["read", "exit_plan_mode"] }));
		assert.equal(ccExtensionsStatus(dir), "ok");
	});
});

test("an unreadable settings file is reported as unreadable, not as needing a fix", () => {
	for (const text of ["{ not json", "[]", '{"excludeRenderers": "exit_plan_mode"}']) {
		withAgentDir((dir) => {
			write(dir, "pi-cc-extensions.json", text);
			assert.equal(ccExtensionsStatus(dir), "unreadable", text);
		});
	}
});

test("the fix adds exit_plan_mode and keeps every other setting, with 2-space JSON", () => {
	withAgentDir((dir) => {
		write(dir, "pi-cc-extensions.json", JSON.stringify({ theme: "dark", excludeRenderers: ["read"], nested: { a: [1, 2] } }));
		assert.equal(excludeExitPlanMode(dir), undefined);
		const text = read(dir, "pi-cc-extensions.json");
		assert.equal(text, `${JSON.stringify({ theme: "dark", excludeRenderers: ["read", "exit_plan_mode"], nested: { a: [1, 2] } }, null, 2)}\n`);
		assert.equal(ccExtensionsStatus(dir), "ok");
	});
});

test("the fix keeps the permissions of the existing settings file", () => {
	withAgentDir((dir) => {
		write(dir, "pi-cc-extensions.json", JSON.stringify({ theme: "dark" }));
		const path = ccSettingsPath(dir);
		chmodSync(path, 0o644);
		assert.equal(excludeExitPlanMode(dir), undefined);
		assert.equal(statSync(path).mode & 0o777, 0o644);
	});
});

test("the fix creates the file when there is none", () => {
	withAgentDir((dir) => {
		assert.equal(excludeExitPlanMode(dir), undefined);
		assert.deepEqual(JSON.parse(read(dir, "pi-cc-extensions.json")), { excludeRenderers: ["exit_plan_mode"] });
		assert.equal(ccSettingsPath(dir), join(dir, "pi-cc-extensions.json"));
	});
});

test("the fix is idempotent: a second run leaves the bytes alone", () => {
	withAgentDir((dir) => {
		write(dir, "pi-cc-extensions.json", JSON.stringify({ excludeRenderers: ["exit_plan_mode"] }));
		const before = read(dir, "pi-cc-extensions.json");
		assert.equal(excludeExitPlanMode(dir), undefined);
		assert.equal(read(dir, "pi-cc-extensions.json"), before);
	});
});

test("an unreadable file is refused and left untouched", () => {
	for (const text of ["{ not json", "[1]", '{"excludeRenderers": "read"}']) {
		withAgentDir((dir) => {
			write(dir, "pi-cc-extensions.json", text);
			const error = excludeExitPlanMode(dir);
			assert.equal(typeof error, "string", text);
			assert.match(error ?? "", /pi-cc-extensions\.json/, text);
			assert.equal(read(dir, "pi-cc-extensions.json"), text, text);
		});
	}
});

test("a successful write leaves no temporary file behind", () => {
	withAgentDir((dir) => {
		write(dir, "pi-cc-extensions.json", "{}");
		assert.equal(excludeExitPlanMode(dir), undefined);
		assert.deepEqual(readdirSync(dir).sort(), ["pi-cc-extensions.json"]);
	});
});
