/**
 * `oc` is judged like `kubectl`: query subcommands on the current cluster run, everything else asks,
 * and the destructive OpenShift commands keep asking (deny in plan mode).
 * Run: node --test tests/unit/oc.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../extensions/rules.ts";
import { GLOBAL_RULES, MODES, type ModeName } from "../../extensions/modes.ts";
import { bashWhy } from "../../extensions/rules.ts";

const CWD = "/home/user/project";
const decide = (mode: ModeName, command: string) =>
	evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: "bash", input: { command } }, { cwd: CWD, remembered: [] });
const why = (command: string): string => bashWhy(command, { cwd: CWD }, [])[0] ?? "";

test("read-only oc commands run in every mode", () => {
	for (const command of [
		"oc get pods -n app",
		"oc describe deployment web",
		"oc logs web-1 --tail 20",
		"oc whoami",
		"oc status",
		"oc projects",
		"oc project",
		"oc api-resources",
		"oc api-versions",
		"oc version",
	]) {
		for (const mode of ["default", "plan", "auto"] as const) {
			assert.equal(decide(mode, command).action, "allow", `${command} [${mode}]`);
		}
	}
});

const REFUSED: [string, RegExp][] = [
	["oc whoami -t", /`oc whoami` with -t or --show-token prints your login token/],
	["oc whoami --show-token", /prints your login token/],
	["oc project demo", /`oc project` with a name switches the project/],
	["oc get pods --server https://x.example", /`oc` pointed at another server, user or kubeconfig/],
	["oc get pods --insecure-skip-tls-verify", /`oc` pointed at another server, user or kubeconfig/],
	["oc get pods --kubeconfig k.yaml", /`oc` pointed at another server, user or kubeconfig/],
	["oc get --raw /apis", /`oc` with --raw or --profile can't be checked/],
	["oc get pods --profile cpu", /`oc` with --raw or --profile can't be checked/],
	["oc get -f deploy.yaml", /`oc get` from a file can't be checked/],
	["oc describe -k overlay", /`oc describe` from a file can't be checked/],
	["oc get secret db", /`oc get` of Secrets prints credentials/],
	["oc describe secrets/db", /`oc describe` of Secrets prints credentials/],
	["oc extract secret/db", /`oc extract` isn't a read-only oc command/],
	["oc login", /`oc login` isn't a read-only oc command/],
	["oc logout", /`oc logout` isn't a read-only oc command/],
	["oc rsh web-1", /`oc rsh` isn't a read-only oc command/],
	["oc exec web-1 -- ls", /`oc exec` isn't a read-only oc command/],
	["oc debug node/n1", /`oc debug` isn't a read-only oc command/],
	["oc port-forward web-1 8080", /`oc port-forward` isn't a read-only oc command/],
	["oc new-project demo", /`oc new-project` isn't a read-only oc command/],
	["oc new-app nginx", /`oc new-app` isn't a read-only oc command/],
	["oc start-build web", /`oc start-build` isn't a read-only oc command/],
	["oc process -f t.yaml", /`oc process` isn't a read-only oc command/],
	["oc adm top nodes", /`oc adm` isn't a read-only oc command/],
	["oc adm policy add-role-to-user admin bob", /`oc adm` isn't a read-only oc command/],
];

test("other oc commands ask, each with its own reason", () => {
	for (const [command, reason] of REFUSED) {
		for (const mode of ["default", "plan"] as const) {
			assert.notEqual(decide(mode, command).action, "allow", `${command} [${mode}]`);
		}
		assert.match(why(command), reason, command);
	}
});

const DESTRUCTIVE = [
	"oc delete pod web-1",
	"oc delete project demo",
	"oc delete all --all -n demo",
	"oc apply -f deploy.yaml",
	"oc adm drain node-1",
	"oc scale dc/web --replicas=0",
	"oc rollout restart dc/web",
];

test("destructive oc commands ask in default and auto, deny in plan", () => {
	for (const command of DESTRUCTIVE) {
		for (const mode of ["default", "auto"] as const) {
			const d = decide(mode, command);
			assert.equal(d.action, "ask", `${command} [${mode}]`);
			assert.equal(d.rule?.match, "dangerousBash", `${command} [${mode}]`);
		}
		const plan = decide("plan", command);
		assert.equal(plan.action, "deny", `${command} [plan]`);
		assert.equal(plan.rule?.match, "dangerousBash", `${command} [plan]`);
	}
});

test("destructive oc commands stay refused through the expander", () => {
	for (const command of ["x=web-1; oc delete pod $x", 'for p in web-1 web-2; do oc delete pod "$p"; done']) {
		for (const mode of ["default", "auto", "plan"] as const) {
			assert.notEqual(decide(mode, command).action, "allow", `${command} [${mode}]`);
		}
		assert.equal(decide("plan", command).action, "deny", `${command} [plan]`);
	}
});
