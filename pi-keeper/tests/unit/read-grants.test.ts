/**
 * Outside-read directory grants, the OS temp dir (never an outside read), and the service CLIs
 * recognised as read-only (gh, kubectl, docker, podman, env, printenv).
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isInTempDir, isOutsideCwdRead, isReadOnlyCommand, outsideCwdReadPaths, readGrantDir, type PathContext } from "../../extensions/utils.ts";
import { evaluate, type EvalContext } from "../../extensions/rules.ts";
import { GLOBAL_RULES, MODES } from "../../extensions/modes.ts";

const CWD = "/home/user/project";

function withTree<T>(run: (base: string) => T): T {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-grants-")));
	// The temp dir is `base/tmp`, inside the fixture rather than around it: the fixture's own files are
	// outside the temp dir, which is never an outside read (see isInTempDir). Restored afterwards.
	const savedTmp = process.env.TMPDIR;
	process.env.TMPDIR = join(base, "tmp");
	try {
		mkdirSync(join(base, "tmp"));
		mkdirSync(join(base, "data", "sub"), { recursive: true });
		mkdirSync(join(base, "other"));
		writeFileSync(join(base, "data", "a.txt"), "a");
		writeFileSync(join(base, "data", "sub", "b.txt"), "b");
		writeFileSync(join(base, "data", ".env"), "S=1");
		writeFileSync(join(base, "other", "c.txt"), "c");
		return run(base);
	} finally {
		if (savedTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmp;
		rmSync(base, { recursive: true, force: true });
	}
}

test("a granted directory covers siblings and subdirectories, not the parent or another directory", () =>
	withTree((base) => {
		const ctx: PathContext = { cwd: CWD, outsideReadDirs: [join(base, "data")] };
		assert.equal(isOutsideCwdRead(join(base, "data", "a.txt"), ctx), false);
		assert.equal(isOutsideCwdRead(join(base, "data", "sub", "b.txt"), ctx), false);
		assert.equal(isOutsideCwdRead(join(base, "data"), ctx), false);
		assert.equal(isOutsideCwdRead(base, ctx), true);
		assert.equal(isOutsideCwdRead(join(base, "other", "c.txt"), ctx), true);
		// a sibling that only shares the name prefix is not inside
		mkdirSync(join(base, "data-evil"));
		writeFileSync(join(base, "data-evil", "x"), "x");
		assert.equal(isOutsideCwdRead(join(base, "data-evil", "x"), ctx), true);
		// `..` out of the grant
		assert.equal(isOutsideCwdRead(join(base, "data", "..", "other", "c.txt"), ctx), true);
		// bash: the paths it names
		assert.deepEqual(outsideCwdReadPaths(`cat ${join(base, "data", "a.txt")}`, ctx), []);
		assert.deepEqual(outsideCwdReadPaths(`cat ${join(base, "data", "a.txt")} ${join(base, "other", "c.txt")}`, ctx), [join(base, "other", "c.txt")]);
	}));

test("grants are judged by realpath: a link out of the granted directory is not covered", () =>
	withTree((base) => {
		symlinkSync(join(base, "other"), join(base, "data", "escape"));
		const ctx: PathContext = { cwd: CWD, outsideReadDirs: [join(base, "data")] };
		assert.equal(isOutsideCwdRead(join(base, "data", "escape", "c.txt"), ctx), true);
		// a link into the granted directory from elsewhere is covered
		symlinkSync(join(base, "data"), join(base, "other", "in"));
		assert.equal(isOutsideCwdRead(join(base, "other", "in", "a.txt"), ctx), false);
	}));

test("a `cd` outside the cwd is not an outside read: a `cd` rule covers it, the reads after it still ask", () =>
	withTree((base) => {
		const other = join(base, "other");
		// the directory change names a directory, not a file it reads
		assert.deepEqual(outsideCwdReadPaths(`cd ${other}`, { cwd: CWD }), []);
		assert.deepEqual(outsideCwdReadPaths("cd ../other", { cwd: CWD }), []);
		assert.deepEqual(outsideCwdReadPaths(`cd ${base}/data && cd ../other`, { cwd: CWD }), []);
		// a `cd` rule (session remembered or project) therefore covers it, in every mode
		const granted: EvalContext = { cwd: CWD, remembered: [["cd"]], project: { allow: { prefixes: [["cd"]], exact: [] }, ask: [], deny: [], readDirs: [], fetchHosts: [] } };
		const action = (mode: "default" | "auto" | "plan", command: string, ctx: EvalContext = granted): string =>
			evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: "bash", input: { command } }, ctx).action;
		assert.equal(action("default", `cd ${other}`), "allow");
		assert.equal(action("plan", `cd ${other}`), "allow");
		// without a rule it is the ordinary "not read-only" ask, not the outside-reads one
		const decision = evaluate(MODES.default.permissions, GLOBAL_RULES, { toolName: "bash", input: { command: `cd ${other}` } }, { cwd: CWD, remembered: [] });
		assert.equal(decision.action, "ask");
		assert.notEqual(decision.rule?.match, "outsideCwdRead");
		// what runs in that directory still reads outside the cwd, `cd` rule or not
		assert.deepEqual(outsideCwdReadPaths(`cd ${other} && cat c.txt`, { cwd: CWD }), [other]);
		assert.deepEqual(outsideCwdReadPaths(`cd ${other} && ls`, { cwd: CWD }), [other]);
		assert.equal(action("default", `cd ${other} && cat c.txt`), "ask");
		assert.equal(action("default", `cd ${other} && ls`), "ask");
		// ...unless the directory was granted for the session
		assert.equal(action("default", `cd ${other} && cat c.txt`, { ...granted, outsideReadDirs: [other] }), "allow");
		// a command that reads nothing there stays covered by the `cd` rule
		assert.equal(action("default", `cd ${other} && echo hi`), "allow");
		// a `cd` that stays inside the cwd reads nothing outside either
		assert.deepEqual(outsideCwdReadPaths(`cd ${base}/data && cat a.txt`, { cwd: CWD, outsideReadDirs: [base] }), []);
	}));

test("readGrantDir: the file's directory, a directory itself; refuses /, the home dir and its ancestors", () =>
	withTree((base) => {
		assert.equal(readGrantDir(join(base, "data", "a.txt"), CWD), join(base, "data"));
		assert.equal(readGrantDir(join(base, "data"), CWD), join(base, "data"));
		assert.equal(readGrantDir(join(base, "data", "sub", "..", "a.txt"), CWD), join(base, "data"));
		// symlinked file: the real parent
		symlinkSync(join(base, "other", "c.txt"), join(base, "data", "link"));
		assert.equal(readGrantDir(join(base, "data", "link"), CWD), join(base, "other"));
		// too broad
		assert.equal(readGrantDir("/", CWD), undefined);
		assert.equal(readGrantDir("/etc/..", CWD), undefined);
		assert.equal(readGrantDir(homedir(), CWD), undefined);
		assert.equal(readGrantDir("~", CWD), undefined);
		assert.equal(readGrantDir(dirname(homedir()), CWD), undefined);
		// a file directly in the home dir would grant the home dir
		assert.equal(readGrantDir(join(homedir(), ".profile"), CWD), undefined);
		// does not exist
		assert.equal(readGrantDir(join(base, "nope", "x"), CWD), undefined);
	}));

test("a grant never covers secrets: they ask on their own rule, in every mode", () =>
	withTree((base) => {
		const dir = join(base, "data");
		for (const mode of ["default", "auto", "plan"] as const) {
			const ctx: EvalContext = { cwd: CWD, remembered: [], outsideReadDirs: [dir] };
			const action = (toolName: string, input: unknown) => evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName, input }, ctx).action;
			assert.equal(action("read", { path: join(dir, "a.txt") }), "allow", `${mode} read`);
			assert.equal(action("bash", { command: `cat ${join(dir, "a.txt")}` }), "allow", `${mode} cat`);
			assert.equal(action("read", { path: join(dir, ".env") }), "ask", `${mode} .env`);
			assert.equal(action("bash", { command: `cat ${join(dir, ".env")}` }), "ask", `${mode} cat .env`);
			assert.equal(action("read", { path: join(base, "other", "c.txt") }), "ask", `${mode} other`);
			assert.equal(action("bash", { command: `grep -r x ${dir}` }), "ask", `${mode} secret search`);
		}
	}));

test("the temp dir is never an outside read: any file in it, pi's output files included, but a link out of it is", () =>
	withTree((base) => {
		const ctx: PathContext = { cwd: CWD };
		const tmp = tmpdir();
		// pi's own output file (the full text of truncated output): a temp-dir file like any other now
		const piFile = join(tmp, `pi-bash-${"ab".repeat(8)}.log`);
		writeFileSync(piFile, "output", { mode: 0o600 });
		assert.equal(isOutsideCwdRead(piFile, ctx), false);
		// any other file, and a nested one
		const scratch = join(tmp, "scratch.txt");
		writeFileSync(scratch, "x");
		assert.equal(isOutsideCwdRead(scratch, ctx), false);
		mkdirSync(join(tmp, "nested"));
		writeFileSync(join(tmp, "nested", "n.txt"), "x");
		assert.equal(isOutsideCwdRead(join(tmp, "nested", "n.txt"), ctx), false);
		// a link in the temp dir to a file elsewhere is judged by its target: outside
		symlinkSync(join(base, "other", "c.txt"), join(tmp, "link.txt"));
		assert.equal(isOutsideCwdRead(join(tmp, "link.txt"), ctx), true);
		// a link from elsewhere into the temp dir is judged by its target: inside
		symlinkSync(scratch, join(base, "other", "into-tmp"));
		assert.equal(isOutsideCwdRead(join(base, "other", "into-tmp"), ctx), false);
		// a sibling that only shares the name prefix is not in the temp dir
		mkdirSync(join(base, "tmpfoo"));
		writeFileSync(join(base, "tmpfoo", "x"), "x");
		assert.equal(isOutsideCwdRead(join(base, "tmpfoo", "x"), ctx), true);
		assert.equal(isInTempDir(join(base, "tmpfoo", "x")), false);
		assert.equal(isInTempDir(scratch), true);
	}));

test("the temp dir is readable in default, auto and plan, by the read tool and by cat; secrets there still ask", () =>
	withTree((base) => {
		const tmp = tmpdir();
		const file = join(tmp, "scratch.txt");
		writeFileSync(file, "x");
		writeFileSync(join(tmp, ".env"), "S=1");
		const ctx: EvalContext = { cwd: CWD, remembered: [] };
		const action = (mode: "default" | "auto" | "plan", toolName: string, input: unknown) => evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName, input }, ctx).action;
		for (const mode of ["default", "auto", "plan"] as const) {
			assert.equal(action(mode, "read", { path: file }), "allow", `${mode} read`);
			assert.equal(action(mode, "bash", { command: `cat ${file}` }), "allow", `${mode} cat`);
			assert.equal(action(mode, "read", { path: join(tmp, ".env") }), "ask", `${mode} read .env`);
			assert.equal(action(mode, "bash", { command: `cat ${join(tmp, ".env")}` }), "ask", `${mode} cat .env`);
		}
		// writes and removals in the temp dir are not reads: they still ask in default
		assert.equal(action("default", "write", { path: join(tmp, "new.txt"), content: "x" }), "ask");
		assert.equal(action("default", "bash", { command: `rm ${file}` }), "ask");
	}));

const READ_ONLY = [
	"gh pr view 12",
	"gh pr view 12 --json title,body",
	"gh pr list --state open",
	"gh pr diff 12",
	"gh pr checks 12",
	"gh pr status",
	"gh issue view 3 --comments",
	"gh issue list -L 5",
	"gh run list",
	"gh run view 99 --log",
	"gh repo view owner/name",
	"gh release list",
	"gh release view v1.0",
	"gh api repos/o/r/pulls/1",
	"gh api repos/o/r/pulls -X GET",
	"gh api repos/o/r/pulls --method get",
	"gh api -XGET repos/o/r",
	"gh api repos/o/r/issues --paginate --jq '.[].title'",
	"kubectl get pods",
	"kubectl get pods -n kube-system -o yaml",
	"kubectl -n kube-system get pods",
	"kubectl describe pod x",
	"kubectl logs x -f --tail=20",
	"kubectl top nodes",
	"kubectl explain pod.spec",
	"kubectl version",
	"kubectl api-resources",
	"docker ps -a",
	"docker images",
	"docker inspect c",
	"docker logs -f c",
	"docker version",
	"docker info",
	"podman ps",
	"podman images -q",
	"podman inspect c",
	"podman logs c",
	"podman version",
	"podman info",
	"printenv HOME PATH",
];

const MUTATING = [
	// gh
	"gh pr merge 12",
	"gh pr create --title x",
	"gh pr close 12",
	"gh pr comment 1 -b hi",
	"gh pr checkout 12",
	"gh pr view 12 --web",
	"gh pr view 12 -w",
	"gh issue create",
	"gh issue close 1",
	"gh run rerun 1",
	"gh run cancel 1",
	"gh repo delete o/r",
	"gh repo create x",
	"gh repo clone o/r",
	"gh release create v1",
	"gh release delete v1",
	"gh -R o/r pr view 1",
	"gh pr",
	"gh",
	"gh auth login",
	"gh alias set x y",
	"gh extension install o/x",
	"gh api repos/o/r/issues -X POST",
	"gh api repos/o/r/issues --method POST",
	"gh api repos/o/r/issues --method=DELETE",
	"gh api repos/o/r -XPATCH",
	"gh api -X PUT repos/o/r",
	"gh api repos/o/r/issues -f title=x",
	"gh api repos/o/r/issues -F title=x",
	"gh api repos/o/r/issues --field title=x",
	"gh api repos/o/r/issues --raw-field title=x",
	"gh api repos/o/r/issues --input body.json",
	"gh api repos/o/r -H 'X-HTTP-Method-Override: DELETE'",
	"gh api graphql",
	"gh api",
	"gh pr view $X",
	"gh pr view *",
	// kubectl
	"kubectl delete pod x",
	"kubectl apply -f x.yaml",
	"kubectl create ns x",
	"kubectl edit deploy x",
	"kubectl patch deploy x -p '{}'",
	"kubectl scale deploy x --replicas=0",
	"kubectl exec -it x -- sh",
	"kubectl cp x:/a ./a",
	"kubectl port-forward x 80",
	"kubectl rollout restart deploy x",
	"kubectl config set-context x",
	"kubectl --kubeconfig /tmp/evil get pods",
	"kubectl get pods --kubeconfig=/tmp/evil",
	"kubectl get pods --server https://evil",
	"kubectl get pods -s https://evil",
	"kubectl get pods --token abc",
	"kubectl get pods --as admin",
	"kubectl get secrets",
	"kubectl get secret db -o yaml",
	"kubectl get secret/db",
	"kubectl get pods,secrets",
	"kubectl describe secret db",
	"kubectl",
	// docker / podman
	"docker run alpine",
	"docker exec c ls",
	"docker rm c",
	"docker rmi x",
	"docker stop c",
	"docker build .",
	"docker pull x",
	"docker push x",
	"docker cp c:/a .",
	"docker system prune",
	"docker compose up",
	"docker -H tcp://evil ps",
	"docker --host=tcp://evil ps",
	"docker ps -H tcp://evil",
	"docker ps --context evil",
	"docker --context evil ps",
	"docker image rm x",
	"docker",
	"podman run alpine",
	"podman exec c ls",
	"podman rm c",
	"podman machine rm",
	"podman ps --connection evil",
	"podman --remote ps",
	// env / printenv
	"env rm -rf x",
	"env FOO=bar",
	"env FOO=bar ls",
	"env -i ls",
	"env -S 'rm -rf x'",
	"env ls",
	"env > out.txt",
	"printenv > out.txt",
	"printenv -x",
	"printenv $(rm x)",
	// bare env/printenv dump every variable; credential-looking names ask
	"env",
	"env | sort",
	"printenv",
	"printenv GITHUB_TOKEN",
	"printenv AWS_SECRET_ACCESS_KEY HOME",
	"printenv db_password",
	// kubectl: raw API paths, other contexts, profiling, manifests
	"kubectl get --raw=/api/v1/namespaces/x/secrets",
	"kubectl get --raw /api/v1/namespaces/x/secrets",
	"kubectl get pods --context=other",
	"kubectl get pods --context other",
	"kubectl get pods --profile=cpu",
	"kubectl get pods --profile-output=/tmp/x",
	"kubectl get -f secret.yaml",
	"kubectl get -k dir",
	"kubectl describe --filename=secret.yaml",
	"kubectl get --kustomize=dir",
	// gh api: other hosts
	"gh api repos/o/r --hostname evil.example",
	"gh api https://evil.example/x",
	"gh api http://evil.example/x",
	// xargs appends words read from stdin, so these can't be trusted
	'echo "rm -rf /tmp/x" | xargs env',
	"echo sh | xargs env",
	"echo secrets | xargs kubectl get",
	"echo -XPOST | xargs gh api repos/a/b",
	'echo "-H tcp://x" | xargs docker ps',
	'echo "-H tcp://x" | xargs podman ps',
	'echo "-C x" | xargs git status',
	"echo HOME | xargs printenv",
	"echo status | xargs rtk git",
];

test("service CLIs: query subcommands are read-only", () => {
	for (const command of READ_ONLY) assert.equal(isReadOnlyCommand(command, CWD), true, `should allow: ${command}`);
});

test("service CLIs: mutating subcommands, flags and redirections are not read-only", () => {
	for (const command of MUTATING) assert.equal(isReadOnlyCommand(command, CWD), false, `should reject: ${command}`);
});

test("xargs: commands that are not read-only behind it stay read-only without it", () => {
	for (const command of ["env", "kubectl get pods", "gh api repos/a/b", "docker ps", "git status"]) {
		assert.equal(isReadOnlyCommand(`xargs ${command}`, CWD), false, `should reject: xargs ${command}`);
	}
	assert.equal(isReadOnlyCommand("git status", CWD), true);
	assert.equal(isReadOnlyCommand("xargs cat", CWD), true);
});

// ---------------------------------------------------------------------------
// $HOME words and `..` segments reach the outside-read and secret checks
// ---------------------------------------------------------------------------

const AGENT = `${homedir()}/.pi/agent`;
const decideIn = (mode: "default" | "plan" | "auto", command: string, cwd = CWD) =>
	evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: "bash", input: { command } }, { cwd, agentDir: AGENT, remembered: [] }).action;

test("$HOME and ${HOME} words get the same decision as ~ (secret file asks in every mode)", () => {
	for (const mode of ["default", "plan", "auto"] as const) {
		assert.equal(decideIn(mode, "cat ~/.aws/credentials"), "ask", mode);
		assert.equal(decideIn(mode, "cat $HOME/.aws/credentials"), "ask", mode);
		assert.equal(decideIn(mode, "cat ${HOME}/.aws/credentials"), "ask", mode);
	}
});

test("$HOME and ${HOME} words name the home dir as an outside read, like ~", () => {
	for (const word of ["~", "$HOME", "${HOME}"]) assert.equal(outsideCwdReadPaths(`cat ${word}`, { cwd: CWD }).length, 1, word);
});

test("$PWD and ${PWD} words expand to the command's cwd, so a `..` after them is judged", () =>
	withTree((base) => {
		const cwd = join(base, "data");
		assert.equal(outsideCwdReadPaths("cat $PWD/../other/c.txt", { cwd }).length, 1);
		assert.equal(outsideCwdReadPaths("cat ${PWD}/../other/c.txt", { cwd }).length, 1);
		assert.deepEqual(outsideCwdReadPaths("cat $PWD/a.txt", { cwd }), [], "inside the cwd stays allowed");
		for (const mode of ["default", "plan"] as const) {
			assert.equal(decideIn(mode, "cat $PWD/../../../../etc/hosts", cwd), "ask", mode);
			assert.equal(decideIn(mode, "cat ${PWD}/../../../../etc/hosts", cwd), "ask", mode);
		}
		// other forms stay as they were: ${PWD:-x} is not expanded; another account's ~name is outside (see expandHome)
		assert.deepEqual(outsideCwdReadPaths("cat ${PWD:-/x}/../other/c.txt", { cwd }), []);
		assert.deepEqual(outsideCwdReadPaths("cat ~nobody/../other/c.txt", { cwd }), ["~nobody/../other/c.txt"]);
	}));

test("a `..` segment that leaves the cwd is an outside read, the same as the absolute path", () =>
	withTree((base) => {
		const cwd = join(base, "project");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "README.md"), "r");
		writeFileSync(join(base, "x"), "x");
		assert.equal(outsideCwdReadPaths("cat src/../../../../etc/hosts", { cwd }).length, 1);
		assert.equal(outsideCwdReadPaths("cat ./../x", { cwd }).length, 1);
		for (const mode of ["default", "plan"] as const) {
			assert.equal(decideIn(mode, "cat src/../../../../etc/hosts", cwd), decideIn(mode, "cat /etc/hosts", cwd), mode);
			assert.equal(decideIn(mode, "cat src/../../../../etc/hosts", cwd), "ask", mode);
			assert.equal(decideIn(mode, "cat ./../x", cwd), "ask", mode);
			// a `..` that resolves inside the cwd stays allowed
			assert.deepEqual(outsideCwdReadPaths("cat src/../README.md", { cwd }), []);
			assert.equal(decideIn(mode, "cat src/../README.md", cwd), "allow", mode);
		}
	}));
