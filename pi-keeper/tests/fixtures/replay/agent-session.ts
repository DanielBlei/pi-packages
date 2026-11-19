/**
 * A synthetic, agent-style session tree for the replay harness: 145 recorded bash decisions, 116 of them
 * dialogs (95 relayed from background children), written the way coding agents tend to write shell:
 * loops, python heredocs, `python3 -c`, redirects into a scratch dir. Everything is invented (no real
 * hosts, users, projects or paths beyond the temp dirs). The commands are JS strings written into
 * JSONL; none is ever executed.
 *
 *   node tests/fixtures/replay/agent-session.ts <outDir>   prints the parent path, writes categories.json
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { targetOf } from "../../../extensions/telemetry.ts";
import { shrinkTarget } from "./session-tree.ts";

const T0 = Date.parse("2026-02-01T09:00:00Z");
const DIALOGS = 116;
const BACKGROUND = 95;
const SILENT = 29;
const FOREGROUND_DIALOGS = 3;
const BG_CHILDREN = 5;

export interface AgentSession {
	parentPath: string;
	projectDir: string;
	/** Dialog row key (as the harness builds it) to the command's main category. */
	categories: Record<string, string>;
	/** The per-session scratch dir (outside outDir); the caller removes it. */
	scratchDir: string;
}

interface Entry {
	cmd: string;
	cat: string;
	/** Other shapes the command also has (the reason table allows overlaps). */
	also: string[];
}

function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 116 wait times in seconds: median 2.4, p95 126, max 700, sum about 43 minutes. */
export function waitTimes(): number[] {
	const top = [700, 420, 260, 180, 140, 126];
	const rest = DIALOGS - top.length;
	const lower = Math.floor(rest / 2) + 3;
	const upper = rest - lower;
	const lowerValues = Array.from({ length: lower }, (_, i) => 0.8 * Math.pow(3, i / (lower - 1)));
	const target = 43 * 60 - top.reduce((a, b) => a + b, 0) - lowerValues.reduce((a, b) => a + b, 0);
	const upperFor = (q: number) => Array.from({ length: upper }, (_, i) => 2.4 * Math.pow(q, i / (upper - 1)));
	const total = (q: number) => upperFor(q).reduce((a, b) => a + b, 0);
	let lo = 1.01;
	let hi = 50;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (total(mid) < target) lo = mid;
		else hi = mid;
	}
	return [...lowerValues, ...upperFor(lo), ...top].map((v) => Math.round(v * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

const WORDS = [
	["alpha", "beta", "gamma"],
	["ERROR", "WARN", "INFO"],
	["parse", "render", "load", "save"],
	["north", "south", "east", "west"],
	["init", "start", "stop"],
	["red", "green", "blue", "amber"],
	["one", "two", "three", "four", "five"],
	["users", "orders", "items"],
];
const JSONS = ["data/a.json", "data/b.json", "data/c.json"];
const CSVS = ["data/a.csv", "data/b.csv"];
const SRCS = ["src/index.ts", "src/util.ts", "src/cli.ts"];

function commands(S: string, E: string): Entry[] {
	const out: Entry[] = [];
	const add = (cat: string, cmd: string, ...also: string[]) => out.push({ cmd, cat, also });

	// loops over literal word lists (16)
	const literalBodies: ((w: string[], i: number) => string)[] = [
		(w) => `for t in ${w.join(" ")}; do echo "== $t"; grep -c "$t" logs/app.log; done`,
		(w) => `for t in ${w.join(" ")}; do echo "$t: $(grep -ci "$t" README.md)"; done`,
		(w, i) => `for w in ${w.join(" ")}; do printf "%s " "$w"; grep -rl "$w" src | wc -l; done; echo pass-${i}`,
		(w) => `for level in ${w.join(" ")}; do echo "--- $level"; grep "$level" logs/app.log | head -n 3; done`,
	];
	for (let i = 0; i < 16; i++) {
		add("loop", literalBodies[i % literalBodies.length](WORDS[(i + Math.floor(i / 4)) % WORDS.length], i), ...(i % 4 === 1 ? ["subst"] : []));
	}
	// done | sort | uniq -c (8)
	for (let i = 0; i < 8; i++) {
		const bodies = [
			`for f in src/*.ts; do grep -o "import .* from" "$f"; done | sort | uniq -c`,
			`for f in data/*.csv; do cut -d, -f${(i % 2) + 2} "$f"; done | sort | uniq -c | sort -rn | head -n ${i + 3}`,
			`for f in ${SRCS.join(" ")}; do grep -o "export [a-z]*" "$f"; done | sort | uniq -c`,
			`for n in ${WORDS[i].join(" ")}; do grep -o "$n" logs/app.log; done | sort | uniq -c`,
		];
		add("loop", bodies[i % bodies.length] + (i >= 4 ? ` # pass ${i}` : ""), "pipe");
	}
	// done > "$out" (8)
	for (let i = 0; i < 8; i++) {
		const bodies = [
			`out=${S}/lines-${i}.txt; for f in data/*.csv; do echo "$f $(wc -l < "$f")"; done > "$out"`,
			`out=${S}/sizes-${i}.txt; for f in data/*.json; do echo "$f $(wc -c < "$f")"; done > "$out"; cat "$out"`,
			`out=${S}/summary-${i}.md; for f in src/*.ts; do echo "- $f: $(grep -c . "$f") lines"; done > "$out" && cat "$out"`,
			`out=${S}/words-${i}.txt; for w in ${WORDS[i].join(" ")}; do echo "$w $(grep -c "$w" logs/app.log)"; done > "$out"`,
		];
		add("loop", bodies[i % bodies.length], "assign", "subst", "redirect");
	}
	// globbed lists (10)
	for (let i = 0; i < 10; i++) {
		const bodies = [
			`for f in data/*.json; do echo "--- $f"; head -c ${100 + i * 20} "$f"; echo; done`,
			`for f in data/*.csv; do echo "$f"; head -n ${2 + (i % 3)} "$f"; done`,
			`for f in src/*.ts; do echo "== $f"; grep -n "function" "$f" | head -n ${3 + i}; done`,
			`for f in logs/*.log; do echo "$f"; tail -n ${5 + i} "$f"; done`,
			`for f in data/*.json; do python3 -m json.tool "$f" > /dev/null && echo "ok $f"; done # ${i}`,
		];
		add("loop", bodies[i % bodies.length]);
	}
	// while read (8)
	for (let i = 0; i < 8; i++) {
		const bodies = [
			`while read -r line; do echo "$line" | cut -d, -f1; done < data/a.csv`,
			`grep ERROR logs/app.log | while read -r l; do echo "$l" | awk '{print $1}'; done`,
			`while IFS=, read -r id name score; do echo "$name=$score"; done < data/b.csv`,
			`ls src | while read -r f; do echo "$f $(wc -l < src/$f)"; done`,
		];
		add("loop", bodies[i % bodies.length] + (i >= 4 ? ` | head -n ${i * 2}` : ""), ...(i % 4 === 3 ? ["subst"] : []));
	}
	// loops with cd (6)
	for (let i = 0; i < 6; i++) {
		const bodies = [
			`for d in ${E}/lib ${E}/docs; do (cd "$d" && ls -la); done`,
			`for d in ${E}/lib ${E}/docs; do cd "$d" && pwd && ls | head -n ${i + 2}; done`,
			`for d in lib docs; do cd ${E}/$d && wc -l *.txt; done`,
		];
		add("loop", bodies[i % bodies.length] + (i >= 3 ? " 2>&1 | head -n 20" : ""), "cd");
	}

	// heredocs and input redirects (20)
	const pyBodies: ((i: number) => string)[] = [
		(i) => [
			"import json",
			`for name in ["data/a.json", "data/b.json", "data/c.json"][:${(i % 3) + 1}]:`,
			"    with open(name) as fh:",
			"        doc = json.load(fh)",
			'    print(f"{name}: {len(doc[\'items\'])} items, total {doc[\'total\']}")',
		].join("\n"),
		(i) => [
			"import csv",
			"rows = list(csv.DictReader(open('data/a.csv')))",
			"total = 0",
			"for row in rows:",
			"    total += int(row['score'])",
			`    print(f"{row['name']:>10} {row['score']}")`,
			`print("total", total, "mean", total / len(rows), ${i})`,
		].join("\n"),
		(i) => [
			"from collections import Counter",
			"counts = Counter()",
			"for line in open('logs/app.log'):",
			"    parts = line.split()",
			"    if len(parts) > 1:",
			"        counts[parts[1]] += 1",
			`for level, n in counts.most_common(${(i % 3) + 2}):`,
			'    print(f"{level}: {n}")',
		].join("\n"),
		(i) => [
			"import json, csv",
			"scores = {r['name']: int(r['score']) for r in csv.DictReader(open('data/b.csv'))}",
			"known = json.load(open('data/a.json'))",
			"for item in known['items']:",
			"    mark = scores.get(item['name'], 'missing')",
			`    print(item['id'], item['name'], mark, 'run ${i}')`,
		].join("\n"),
	];
	for (let i = 0; i < 12; i++) add("heredoc", `python3 - <<'EOF'\n${pyBodies[i % pyBodies.length](i)}\nEOF`, "loop", "interp");
	for (let i = 0; i < 3; i++) {
		add("heredoc", `cat >> ${S}/notes.md <<EOF\n## Step ${i + 1}\nChecked ${CSVS[i % 2]} and ${JSONS[i]}; found ${i + 2} files.\nRun at $(date +%H:%M)\nEOF`, "redirect", "subst");
	}
	for (let i = 0; i < 3; i++) {
		add("heredoc", `cat > ${S}/plan-${i}.md <<'EOF'\n# Plan ${i}\n- read ${SRCS[i]}\n- summarize the exports\n- report $HOME-free results\nEOF`, "redirect");
	}
	add("heredoc", "wc -l < data/a.csv", "redirect");
	add("heredoc", "sort < logs/app.log | uniq -c", "pipe");

	// interpreters (14)
	const oneLiners = [
		`python3 -c 'import json; d=json.load(open("data/a.json")); print(sum(i["score"] for i in d["items"]))'`,
		`python3 -c 'import csv; r=list(csv.reader(open("data/a.csv"))); print(len(r), r[0])'`,
		`python3 -c 'import collections; c=collections.Counter(w for l in open("logs/app.log") for w in l.split()[1:2]); print(c.most_common(3))'`,
		`python3 -c 'print(len(open("README.md").read().split()))'`,
		`python3 -c 'import json; print(json.load(open("data/b.json"))["total"])'`,
		`python3 -c 'import os; print(sorted(os.listdir("src")))'`,
		`python3 -c 'import re; print(len(re.findall(r"ERROR", open("logs/app.log").read())))'`,
		`python3 -c "import json; print(json.load(open('$f'))['total'])"`,
		`python3 -c "import csv,sys; print(sum(1 for _ in csv.reader(open('$f'))))"`,
		`node -e 'const d=require("./data/a.json"); console.log(d.items.map(i=>i.name).join(","))'`,
		`node -e 'const fs=require("fs"); console.log(fs.readdirSync("src").length)'`,
		`node -e 'console.log(JSON.stringify(require("./data/c.json")).length)'`,
		`python3 ${S}/script.py data/a.json`,
		`python3 -c 'import pandas as pd; df=pd.read_csv("data/a.csv"); print(df.describe())'`,
	];
	for (const [i, cmd] of oneLiners.entries()) add("interp", cmd, ...(cmd.includes("$f") ? ["loop"] : []), ...(i === 7 ? [] : []));

	// output redirects (8)
	const redirects = [
		`ls data > ${S}/listing.txt`,
		`grep -c ERROR logs/app.log > ${S}/err-count.txt`,
		`echo "checked data files" >> ${S}/notes.md`,
		`find src -name '*.ts' | sort > ${S}/ts-files.txt`,
		`head -n 5 logs/app.log > ${S}/head.log`,
		`cat data/a.csv data/b.csv > ${S}/all.csv`,
		`grep -n function src/util.ts 2>&1 > ${S}/fns.txt`,
		`wc -l data/*.csv > ${S}/csv-lines.txt`,
	];
	for (const cmd of redirects) add("redirect", cmd, ...(cmd.includes("find") ? ["pipe"] : []));

	// $( ) (6)
	const substs = [
		'echo "total: $(wc -l < logs/app.log)"',
		"ls -la $(dirname data/a.csv)",
		'head -n $(wc -l < README.md) README.md | tail -n 3',
		'echo "errors=$(grep -c ERROR logs/app.log) warns=$(grep -c WARN logs/app.log)"',
		'grep -n "$(head -n 1 data/a.csv | cut -d, -f2)" data/a.csv',
		'echo "files: $(ls src | wc -l)"',
	];
	for (const cmd of substs) add("subst", cmd);

	// cd outside the cwd (4)
	add("cd", `cd ${E} && ls -la`);
	add("cd", `cd ${E}/lib && cat helper.txt`);
	add("cd", `cd ${E}/docs && wc -l *.txt`, "glob");
	add("cd", `cd ${E} && grep -rn note . | head -n 5`, "pipe");

	// assignments (3)
	add("assign", "n=3; head -n $n logs/app.log");
	add("assign", 'f=data/a.json; python3 -m json.tool "$f"');
	add("assign", `out=${S}/o.txt; ls src > $out; cat $out`, "redirect");

	// unquoted $var / glob on a glob-sensitive command (3)
	add("glob", `rm -f ${S}/*.tmp`);
	add("glob", `cp data/*.json ${S}/`);
	add("glob", `dest=${S}/moved.txt; mv ${S}/listing.txt $dest`, "assign");

	// checksum tools (2)
	add("checksum", "sha256sum data/*.json");
	add("checksum", "md5sum README.md data/a.csv", "pipe");

	return out;
}

/** Silent allows: read-only commands the old rules wave through. */
const SILENT_COMMANDS = [
	"ls -la", "pwd", "cat README.md", "head -n 20 README.md", "wc -l data/a.csv", "ls data", "ls src", "cat data/a.json",
	"grep -n ERROR logs/app.log", "tail -n 20 logs/app.log", "find src -name '*.ts'", "ls -la logs", "cat data/b.csv", "wc -l src/index.ts",
	"head -n 5 data/c.json", "ls -R src", "cat src/util.ts", "grep -rn export src", "cat src/cli.ts", "tail -n 5 data/b.csv",
	"wc -l logs/app.log", "ls -la data", "cat data/c.json", "head -n 3 data/a.csv", "grep -c WARN logs/app.log", "wc -c README.md",
	"cat src/index.ts", "ls -la src", "head -n 10 logs/app.log",
];

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

const line = (value: unknown) => JSON.stringify(value);

export function writeAgentSession(outDir: string): AgentSession {
	const root = resolve(outDir);
	const project = join(root, "project");
	const elsewhere = join(root, "elsewhere");
	const sessions = join(root, "sessions");
	const artifacts = join(sessions, "subagent-artifacts");
	for (const dir of [join(project, "data"), join(project, "logs"), join(project, "src"), join(elsewhere, "lib"), join(elsewhere, "docs"), artifacts]) mkdirSync(dir, { recursive: true });
	const put = (path: string, text: string) => writeFileSync(path, text);
	const doc = (names: string[]) => JSON.stringify({ items: names.map((name, i) => ({ id: i + 1, name, score: (i * 7) % 10 })), total: names.length });
	put(join(project, "data", "a.json"), doc(["alpha", "beta", "gamma"]));
	put(join(project, "data", "b.json"), doc(["delta", "epsilon"]));
	put(join(project, "data", "c.json"), doc(["zeta", "eta", "theta", "iota"]));
	put(join(project, "data", "a.csv"), "id,name,score\n1,alpha,3\n2,beta,7\n3,gamma,5\n");
	put(join(project, "data", "b.csv"), "id,name,score\n1,alpha,4\n2,delta,6\n");
	put(join(project, "logs", "app.log"), ["INFO start", "WARN slow call", "ERROR parse failed", "INFO load done", "ERROR render failed", "INFO stop"].map((l, i) => `2026-02-01T09:00:0${i} ${l}`).join("\n") + "\n");
	for (const name of ["index", "util", "cli"]) put(join(project, "src", `${name}.ts`), `import { x } from "./x";\nexport function ${name}() {\n\treturn x;\n}\n`);
	put(join(project, "README.md"), "# Sample project\n\nA tiny synthetic project.\n\nnote: nothing real here.\n");
	put(join(elsewhere, "lib", "helper.txt"), "helper note\n");
	put(join(elsewhere, "docs", "intro.txt"), "intro note\nsecond line\n");
	put(join(elsewhere, "docs", "more.txt"), "more\n");

	const scratch = mkdtempSync(join(tmpdir(), "pi-keeper-"));
	put(join(scratch, "script.py"), "import json, sys\nfor item in json.load(open(sys.argv[1]))['items']:\n    print(item['id'], item['name'])\n");

	// 116 distinct dialog commands, in a fixed shuffled order
	const entries = commands(scratch, elsewhere);
	if (entries.length !== DIALOGS) throw new Error(`expected ${DIALOGS} commands, built ${entries.length}`);
	{ const seen = new Set<string>(); for (const e of entries) { if (seen.has(e.cmd)) throw new Error("duplicate command: " + e.cmd); seen.add(e.cmd); } }
	const random = rng(20260201);
	const order = entries.map((_, i) => i);
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	const shuffled = order.map((i) => entries[i]);
	const waits = waitTimes();
	const waitOrder = waits.map((_, i) => i);
	for (let i = waitOrder.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[waitOrder[i], waitOrder[j]] = [waitOrder[j], waitOrder[i]];
	}
	const planAt = new Set([4, 19, 37, 52, 66, 90]);

	let clock = 0;
	const at = (n: number) => new Date(T0 + n * 1000).toISOString();
	const tel = (n: number, data: Record<string, unknown>) => line({ type: "custom", customType: "pi-keeper-permission", timestamp: at(n), data });
	const call = (n: number, id: string, command: string) => line({ type: "message", timestamp: at(n), message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] } });
	const target = (command: string) => shrinkTarget(targetOf({ toolName: "bash", input: { command } }));
	const decide = (n: number, id: string, command: string, mode: string, action: string, matcher: string | null, phase = "decide") =>
		tel(n, { phase, toolCallId: id, tool: "bash", mode, target: target(command), action, matcher });
	const choice = (n: number, id: string, command: string, mode: string, waitMs: number, extra: Record<string, unknown>) =>
		tel(n, { phase: "choice", toolCallId: id, tool: "bash", mode, target: target(command), matcher: null, options: { primary: [], secondary: [] }, choice: "Yes", waitMs, ...extra });

	const parentLines: string[] = [
		line({ type: "session", id: "parent-id", cwd: project, timestamp: at(0) }),
		line({ type: "custom_message", customType: "pi-keeper-mode", timestamp: at(0), content: `Scratch dir: ${scratch}\nYou may create files there.` }),
	];
	const fgLines: string[] = [
		line({ type: "session", id: "fg-id", cwd: project, timestamp: at(0) }),
		line({ type: "session_info", name: "subagent-worker-run-fg-0", timestamp: at(0) }),
	];
	const transcripts: string[][] = Array.from({ length: BG_CHILDREN }, () => []);
	const categories: Record<string, string> = {};
	const parentOwn = DIALOGS - BACKGROUND - FOREGROUND_DIALOGS;

	let silentDone = 0;
	let reqCount = 0;
	const emitSilent = () => {
		const cmd = SILENT_COMMANDS[silentDone % SILENT_COMMANDS.length];
		const id = `ps-${silentDone}`;
		clock += 1;
		parentLines.push(call(clock, id, cmd), decide(clock, id, cmd, silentDone % 10 === 7 ? "plan" : "default", "allow", "readOnlyBash"));
		silentDone++;
	};

	shuffled.forEach((entry, i) => {
		const wait = waits[waitOrder[i]];
		const waitMs = Math.round(wait * 1000);
		const mode = planAt.has(i) ? "plan" : "default";
		if (i < parentOwn + FOREGROUND_DIALOGS) {
			while (silentDone < Math.round(((i + 1) * SILENT) / (parentOwn + FOREGROUND_DIALOGS))) emitSilent();
			clock += 2;
			if (i < parentOwn) {
				const id = `p-${i}`;
				parentLines.push(call(clock, id, entry.cmd), decide(clock, id, entry.cmd, mode, "ask", null));
				clock += Math.ceil(wait);
				parentLines.push(choice(clock, id, entry.cmd, mode, waitMs, { outcome: "allow-once" }));
				categories[`parent:parent#${id}`] = entry.cat;
			} else {
				const id = `fg-${i}`;
				fgLines.push(call(clock, id, entry.cmd), decide(clock, id, entry.cmd, mode, "ask", null));
				clock += Math.ceil(wait);
				parentLines.push(choice(clock, id, entry.cmd, mode, waitMs, { outcome: "allow-once", via: "child-relay" }));
				categories[`fg-child:run-fg#${id}`] = entry.cat;
			}
			return;
		}
		// a background ask: the child's transcript holds the full command, the parent a request id
		const bgIndex = i - parentOwn - FOREGROUND_DIALOGS;
		const child = bgIndex % BG_CHILDREN;
		const req = `req-${reqCount++}`;
		clock += 2;
		transcripts[child].push(line({ recordType: "tool_start", ts: at(clock), toolCallId: `t-${bgIndex}`, toolName: "bash", argsPreview: entry.cmd.slice(0, 40), argsPayload: { command: entry.cmd } }));
		parentLines.push(tel(clock, { phase: "remote-mode", toolCallId: req, claimed: mode, mode }), decide(clock, req, entry.cmd, mode, "ask", null, "redecide"));
		clock += Math.ceil(wait);
		parentLines.push(choice(clock, req, entry.cmd, mode, waitMs, { outcome: "parent-ask", via: "background" }));
		categories[`bg-child:run-bg${child}#${req}`] = entry.cat;
	});
	while (silentDone < SILENT) emitSilent();

	const parentPath = join(sessions, "parent.jsonl");
	writeFileSync(parentPath, parentLines.join("\n") + "\n");
	const fgDir = join(sessions, "parent", "dir1", "run-0");
	mkdirSync(fgDir, { recursive: true });
	writeFileSync(join(fgDir, "session.jsonl"), fgLines.join("\n") + "\n");
	writeFileSync(join(artifacts, "run-fg_meta.json"), JSON.stringify({ runId: "run-fg", parentSessionId: "parent-id", agent: "worker" }));
	for (let child = 0; child < BG_CHILDREN; child++) {
		const transcript = join(artifacts, `run-bg${child}_worker_transcript.jsonl`);
		// unasked read-only calls too: they are pairing candidates that must not match any ask
		const quiet = [`ls -la src/${child}`, `cat README.md | head -n ${child + 1}`].map((cmd, k) => line({ recordType: "tool_start", ts: at(1), toolCallId: `q-${child}-${k}`, toolName: "bash", argsPreview: cmd, argsPayload: { command: cmd } }));
		writeFileSync(transcript, [...quiet, ...transcripts[child]].join("\n") + "\n");
		writeFileSync(join(artifacts, `run-bg${child}_meta.json`), JSON.stringify({ runId: `run-bg${child}`, parentSessionId: "parent-id", agent: "worker", transcriptPath: transcript, cwd: project }));
	}
	return { parentPath, projectDir: project, categories, scratchDir: scratch };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = process.argv[2];
	if (outDir === undefined) {
		console.error("usage: node tests/fixtures/replay/agent-session.ts <outDir>");
		process.exit(2);
	}
	const result = writeAgentSession(outDir);
	writeFileSync(join(resolve(outDir), "categories.json"), JSON.stringify(result.categories, null, 2) + "\n");
	console.log(result.parentPath);
	console.error(`scratch dir (remove when done): ${result.scratchDir}`);
}
