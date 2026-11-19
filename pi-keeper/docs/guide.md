# pi-keeper user guide

This is the full guide. The [README](../README.md) has the short version. The reasoning behind the rules is in [docs/design.md](design.md), and the exact lists live in the code (the design doc says where).

## Modes at a glance

Switch with **Alt+M** (or **Ctrl+Shift+M**), cycling `default → auto →
plan`, or `/mode` (a selector; `/mode <name>` jumps), or `/plan
[prompt|open]`. Alt+M works everywhere; Ctrl+Shift+M only in terminals
with the kitty/CSI-u keyboard protocol (elsewhere it arrives as Enter —
JetBrains IDE terminals among them). pi reserves Shift+Tab for thinking
levels. A startup `[Extension issues]` warning means a key didn't register.
A new session starts in `default`; the mode is restored per branch on
resume.

| Mode | Footer | Use it for | Runs without asking | Asks | Blocked |
|---|---|---|---|---|---|
| `default` | **`● default`** (blue) | everyday work: you approve changes | reads, searches, read-only bash, anything your rules cover, read-only MCP tools and [listed read-only tools](#read-only-tools-from-other-packages) | edits, other bash, other tools | `sudo` & co |
| `auto` | **`» auto`** (yellow) | a trusted task you are watching | almost everything, deletes and overwrites inside the project included | dangerous commands, destructive commands outside the project, protected paths, writes outside the project, secrets, the first outside read | `sudo` & co |
| `plan` | **`≡ plan`** (green) | researching and writing a plan | reads, read-only bash, the plan file, the scratch dir, read-only MCP tools and [listed read-only tools](#read-only-tools-from-other-packages), session rules you granted | other bash (to gather context) | edits, other tools, dangerous commands, `sudo` & co |

### What each mode allows

| | `default` | `auto` | `plan` |
|---|---|---|---|
| Reads and searches inside the project | runs | runs | runs |
| Reads outside the project (the temp dir, agent dir, plan file, scratch dir and granted dirs never ask) | asks once | asks once | asks once |
| Secret files, including searches over them and uploads | asks | asks | asks |
| File edits and writes in the project | asks | runs (protected paths ask) | blocked (plan file and scratch dir run) |
| Read-only bash (`rtk grep`, `git status`, ...) | runs | runs | runs |
| Other bash (builds, tests, `rm` in the project) | asks | runs (outside the project asks) | asks |
| Dangerous commands (push, publish, deploy, history rewrite, download-and-run) | asks | asks | blocked |
| Network fetches with `curl` or `wget` | asks (allowed hosts run) | runs | asks (allowed hosts run) |
| Subagents (with pi-subagents) | runs | runs | runs |

- **A guard, not a sandbox.** pi-keeper decides each call when the call is made.
  An extension that loads after it can still rewrite a call that a rule
  allowed (for example a command rewriter). For untrusted work, use a container
  or a VM.

## In every mode

Four kinds of call, in plain terms: what runs without asking, what asks once,
what always asks, and what is denied.

### Runs without asking

- **Reading inside the project:** reads, searches and read-only bash (`rtk
  grep`, `rtk find`, `git status`, `sed -n 1,5p`, `… | awk '{print $1}'`) never
  ask. `awk` counts only when its program cannot reach outside the pipeline (no
  `system`, `getline`, pipe, redirect or `-f`).
- **`kubectl` and `oc`:** `get`, `describe`, `logs`, `top`, `explain`, `version`
  and `api-resources` on the current cluster (plus `oc whoami`, `status`,
  `projects`, `api-versions` and `project` without a name). Secrets, tokens,
  other clusters and every other subcommand ask.
- **Small shell programs**, read as the shell would run them:
  - a `for` loop over up to 16 literal words:
    `for f in a.txt b.txt; do wc -l "$f"; done`
  - a literal lowercase variable: `dir=src; ls "$dir"`, or a redirect into the
    scratch dir through one: `out=<scratch>/n.txt; sort a.txt > "$out"` (a
    redirect into the project still asks)
  - `cmd < file`, judged like a read of that file
  - checksum tools: `sha256sum`, `md5sum`, `b2sum`, `cksum`, `sum` (not with
    `-c`)
  - a plain heredoc into the scratch dir: `cat >> <scratch>/notes.md <<EOF` when
    the body has no `$`, backtick or backslash

  The command runs when every copy of the loop is read-only or covered by a
  rule. A rule for the loop body's command covers every copy. The secret,
  outside-read and dangerous-command checks judge the expanded text too.
- **Inline python that pi-keeper can read ahead of time:** `python3 -c '<script>'`
  (single quotes) and `python3 - <<'EOF' … EOF` (quoted delimiter). The script
  may use plain standard-library modules (`json`, `csv`, `re`, `collections`,
  `pathlib`, `glob`, ...), read literal paths and list directories without
  recursion, and write literal files in the scratch dir. pi-keeper checks the
  files the script reads like `cat` would: a secret or an outside path asks for
  the same reason. A `for` loop over a literal list of names, or over
  `glob.glob`, `os.listdir`, `Path.glob` or `Path.iterdir`, runs too. The files
  it lists are judged when the command is checked, so a matching `.env` or a
  symlink out of the project still asks, and `listdir` includes dotfiles. The
  script is parsed with Python's own `ast` and never run, so `python3` must be
  on `PATH`.
- **No change to what already asked.** Expanding a program only adds allows.
  Auto mode has no read-only allow rule, so it is unchanged.

### Asks once per session

- **Loops over globs:** `for f in *.md; do wc -l "$f"; done` asks. When the
  loop is otherwise safe, the dialog offers *Yes, and allow loops over globs
  this session*. Some glob loops always ask: a match starting with `-` (unless
  the glob starts with `./` or contains `/`), an unquoted name with a space, a
  write or `cd` earlier in the command, a glob in the scratch dir, a body that is
  not read-only, more than 64 matches, or none.
- **Python `while`:** asks once, with *Yes, and allow python `while` loops this
  session (higher risk: a loop may not end or may fill memory)*. The rest of the script is still
  judged.
- **Tools and MCP calls:** see [MCP and other packages' tools that
  ask](#mcp-and-other-packages-tools-that-ask).

Subagents share these grants with their parent.

### Always asks, and why

- **Shell control flow:** `while`, `if`, `case` and functions (pi-keeper does not
  follow them), `$( )` and backticks (the output can become options or
  commands), a variable set after `&&` or `||` (it may not be set), and
  backslashes or non-ASCII text in an expanded command (the shell's reading is
  not certain).
- **`cd` out of the working directory.** It asks as an ordinary command.
- **Other heredocs** than the plain scratch-dir one above and the python one.
- **Python that is not readable ahead of time:** a third-party import
  (`requests`, `pandas`, `subprocess`), `os.system`, `os.environ`, `eval`,
  `exec`, `getattr`, a path built from a variable, input or the environment, a
  write outside the scratch dir, recursion (`os.walk`, `rglob`, `**`), anything
  that may fill memory, `.format` on built strings, `python3 script.py`,
  `python3 -m`, a double-quoted `-c`, piped stdin, python after a `cd`, a
  `PYTHON*` variable, and a project dir with a file that would shadow a loaded
  module (such as `json.py`).
- **Secrets:** `.env`, private keys, credential stores (`~/.ssh`, `~/.aws`, ...).
  So do a recursive or hidden-file search over a tree that holds one (`grep -r
  KEY .`, `rg --hidden KEY`), an upload of one (`curl -d @.env URL`, even in
  auto), a file list piped to a reader (`ls | xargs cat`), a glob under `~` or
  outside the project, and a dump of the environment (`printenv`, `env`).
  `--exclude=.env` and `rg -g '!.env'` do not ask. `echo` of a credential-named
  variable (`$GITHUB_TOKEN`, `$DB_PASSWORD`) asks in every mode; `$HOME` runs,
  and a single-quoted `'$GITHUB_TOKEN'` is literal text. A secret-looking file
  that **git tracks** (a committed demo certificate, a template `.env`) is
  repository content and does not ask.
- **Dangerous commands** (`git push`, `reset --hard`, publishing,
  infrastructure, download-and-run, `git config core.hooksPath`, ...) ask
  whatever your rules say, and are never remembered. In plan mode they are
  denied: the step goes in the plan.
- **Removals** (`rm`, `git rm`, ...) are never remembered. Commands that run
  other programs (sed's `e`, `tar --to-command`, `git -c`, `find -exec`, ...) are
  never covered by a rule.

The dialog's *Why:* line names the reason.

### Denied, and the rest

- **`sudo`, `su`, `doas`, ... are denied.** The model gives you the command to
  run yourself (`! <command>`) and waits.
- **No UI** (`pi -p`, RPC): every ask is denied. A background subagent has no UI
  either, but its asks go to your session's dialog instead
  ([Background subagents](#background-subagents)).
- **rtk is optional.** pi's built-in `grep`/`find`/`ls` tools are off and the
  model uses `rtk` in bash (`pi --enable-builtin-tools` turns them back on;
  tools enabled through pi's `defaultTools` setting are left alone). The
  extension checks `PATH` once at load; without rtk the prompt asks for the
  built-in search tools, or plain `grep`/`find`/`ls` in bash when those are off
  too. `RTK_DISABLED=1` counts as absent.

### Reads outside the project

A read outside the working directory (the read tool, or bash naming an
existing outside path such as `cat /etc/hosts` or `ls ~`) asks once. Besides
*Yes*, the dialog offers *Yes, and allow reading from `<dir>/` this
session*: that directory and everything below it, nothing above or beside
it. Secrets inside a granted directory still ask. Behind *More…* is *Yes,
allow reads outside the working directory for this session*. `/`, your home
directory and its ancestors are never offered as a directory grant.
`/permissions` lists and removes each granted directory. The plan file, the
scratch dir and pi's agent dir never ask, and neither does reading the OS
temp dir (pi's truncated-output files included): that covers reads only, so
writes and removals there still ask, a secret there still asks, and a link
is judged by the file it points to.

A `cd` that leaves the working directory is not an outside read: changing
directory names a directory, not a file it reads. It asks as an ordinary
command, so *Yes, and always allow `cd` in this project* saves a `Bash(cd *)`
rule that covers it from then on. What runs after the `cd` is still judged:
a command running in a directory outside the working directory reads there
whatever it names, so `cd ../other && cat notes.md` keeps asking (unless that
directory is granted). `cd ..` alone is covered the same way. A `~` in a path
follows the shell: `~` and `~<your name>` are home, `~+` is the working
directory, and `~user/…` or `~-` are outside the project. After a `cd` into
another git repository, the dialog offers *Yes, and allow git in `<repo>/` this
session* instead (see [the dialogs](#the-dialogs)).

### Fetching from the web

In `default` and `plan`, a `curl` or `wget` GET asks once per host, with *Yes, and allow fetching from
`<host>` this session* and (with *Offer "always allow in this project" for commands* on) *Yes, and always
allow fetching from `<host>` in this project*, saved as `Fetch(<host>)` to
`.pi/settings.local.json`. Once a host is allowed, a GET to it whose response
is printed, not saved, counts as a read and runs without a dialog in every
mode, subagents included. No host is allowed by default, GitHub included.
You can also list hosts by hand under `allow` in `.pi/settings.local.json`, for
example `"Fetch(github.com)"`, `"Fetch(api.github.com)"`,
`"Fetch(raw.githubusercontent.com)"`. `WebFetch(domain:<host>)`, the spelling
Claude Code's settings use, is the same rule, in `allow` lists only (elsewhere
it is ignored with a warning). pi asks you to review a hand-edited file the
next time it loads, and the rules apply once you accept. Subagents share the
session grant with their parent both ways and read the project rule like any
other. A grant never covers a request that sends data (`-d`, `-F`, `-T`,
`--json`, a cookie file, a non-GET method), a proxy or `--resolve` override,
or one saved to a file. Only hosts you allow qualify, never "any host".
`/permissions` lists and removes the grants.

## Day to day in default mode

1. The agent reads freely. When it wants to edit a file or run a command
   that isn't read-only, a dialog opens: the terminal rings and the working
   row reads *Waiting for approval…*.
2. The dialog shows the command (or a diff against the file on disk) and
   why it asks. For chained commands: *Needs approval: `npm test`* /
   *Already OK: `cd x`, `git status`*; each part is matched separately, so
   `npm test && rm x` still asks for the `rm`.
3. You answer:
   - **Yes.**
   - **Yes, and don't ask again for `git commit` this session:** in memory
     until a new session starts (`/new`, `/resume`, fork) or pi exits; shared
     with plan mode.
   - **Yes, and always allow `git commit` in this project:** saved to
     `.pi/settings.local.json`; default mode only.
   - **Yes, and don't ask again for this exact command this session:**
     offered instead of the two above when no prefix can cover the command
     (an interpreter running a file such as `python3 x.py`, a script inside a chain). Only
     that exact text, character for character, runs unasked; default mode
     only (plan mode still asks), in memory until a new session starts
     (`/new`, `/resume`, fork) or pi exits, listed by `/permissions`. Never
     offered for a command that removes things (`rm`, `git rm`, `docker rmi`,
     …, alone or in a chain): those stay a per-call decision.
   - **Yes, and always allow this exact command in this project:** the
     same commands as the option above, when the `project-exact-commands`
     setting is on (the default; [/keeper](#keeper)). Saves the exact rule
     (`Bash(python3 x.py)`) to `.pi/settings.local.json`; default mode
     only, trusted on the next start, listed and removable via
     `/permissions`. When no token rule can hold the command (`awk '{print $1}'`,
     a `for` loop), it saves `BashExact(<the command>)` instead. Not offered for
     removals, a flag that runs a program (`sed '1e id'`, `git -c`,
     `find -exec`) or a write outside the project: those keep the session
     option only.
   - **Yes, allow all edits this session** (edit dialogs): footer shows
     `● default · edits`; protected paths, outside paths and secrets still
     ask. Resets on `/new`, `/resume` and exit.
   - **Yes, and allow git in `<repo>/` this session:** offered after a `cd`
     into another git repository, where git would read that repository's
     config and hooks. Session only, shared with subagents, listed and
     removable in `/permissions`. Dangerous git commands still ask.
   - **No:** the agent stops and waits for you.
   - **More…:** *No, and tell pi what to do instead* (it continues with
     your message, e.g. "use pnpm"), *Allow a different command pattern…*
     (exact command, narrower or broader prefix, or a typed one; then
     session or project), *Yes, and switch to auto mode*.
4. Next time a rule covers the call, it runs silently and its row shows a
   dim note: `allowed by project rule: git commit *`.

How rules match:

- **By command prefix:** `git add *` and `git commit *` don't cover
  `git push`. The prefix depth is per tool (`gh pr create`, `docker compose
  up`, `npm run build`).
- **rtk is transparent:** `git add` and `rtk git add` are the same rule.
- **Shell keywords are never a prefix:** `for`, `do`, `if`, `while` and the
  other reserved words are never remembered. When a `for` loop over literal
  words still asks, the dialog offers its body's command instead
  (`for p in a b; do harbor repo list --project "$p"; done` offers `harbor`, for
  the session or the project), and that rule covers each copy. A loop that can't
  be expanded gets the exact-command options. `time` and `!` before a command are
  stripped, like `nice`.
- **Writes stay in the project:** a rule for a command that writes files
  (`sed -i`, `cp`, `mkdir`, `tee`, `tar -czf`, `curl -o`, `zip`, `rsync`,
  ...) covers it only while every target is inside the project (or the
  scratch dir), and not in `.git/`, `.pi/` or a secret file. The label says
  *(inside the project only)*. A redirection (`>`, `>>`) to a literal path is a
  write target too (`echo x > ~/notes.txt`).

### The dialogs

The common choices are listed
first and the rare ones sit behind *More…* (Esc in the main dialog rejects;
Esc in *More…* goes back). Long or multi-line commands are shown in full;
scroll with PgUp/PgDn or Shift+↑↓, pick with ↑↓ or j/k and Enter. There are
no number shortcuts, so a stray digit can't approve anything. Control
characters in the previewed content are shown as symbols.

Representative cases (the exact option lists are pinned by
`tests/integration/dialogs.test.ts`):

- **Bash in default mode:** Yes · session option · project option · No ·
  More…. Commands no prefix can cover (interpreters running a file, anything with a
  program-running flag or an outside write target) offer *this exact command
  this session* instead (Yes · exact · No · More…), plus *always allow this
  exact command in this project* when the `project-exact-commands` setting is on
  (the default). Dangerous commands show just Yes · No · No, and tell pi what to
  do instead. Plan mode offers the session option only.
- **Edits:** Yes · Yes, allow all edits this session · No · More…. Edits to
  protected paths, outside paths and secrets offer only Yes · No · No, and
  tell pi.
- **Auto mode asks** (dangerous command, outside destructive command,
  protected path): Yes · No · No, and tell pi.
- **Plan approval** is a selector docked under the plan; see
  [Plan mode](#plan-mode).
- **Rules review:** *Load them* · *Ignore for this session*.

**No** stops the turn; parallel calls queued behind it are rejected without a
dialog until your next message. **No, and tell pi** gives the model your text
as the rejection reason and it keeps working. Parallel tool calls show their
dialogs one at a time. After you approve a call its input is locked: if
another extension changes it afterwards the call fails instead of running
something you didn't see (the one exception is this package's own `rtk
rewrite`; see the design doc).

When a dialog opens in the TUI the terminal rings (BEL plus an OSC 777/99
desktop notification with a fixed label, never the command). Set
`PI_KEEPER_BELL=0` to turn it off.

## Managing rules

- **`/permissions`:** every rule with its source (`[session]`, `[project
  allow]`, `[project ask]`, `[project deny]`, workflow command, granted
  read directory); select one to remove it. `/permissions add
  <allow|ask|deny> <pattern>` saves to the project file, e.g.
  `/permissions add deny git push *` (a trailing ` *` is a prefix, otherwise
  the pattern is exact). Tab completes the arguments.
- **`/approvals`:** opens the permission asks that background subagents are
  waiting on, whatever the popup policy says
  ([Background subagents](#background-subagents)).
- **`/mode`:** a selector with the three modes, colored like the footer chip
  (current one marked, Esc keeps it); `/mode <name>` switches directly. Without a UI it shows the
  current mode, the rules file path and a rules summary as text instead.
- **`.pi/settings.local.json`:** editable by hand, kept out of git
  (`.git/info/exclude`). Rules live under one namespaced key:

  ```json
  { "pi-keeper": { "permissions": {
    "allow": ["Bash(git commit *)", "Read(/srv/data/**)", "Fetch(pypi.org)"],
    "ask":   ["Bash(git push *)"],
    "deny":  ["Bash(terraform destroy *)"]
  } } }
  ```

  `allow` works like a remembered prefix, persistently, in default mode only.
  An entry without a trailing ` *` is an exact rule (`Bash(npm test)`): it
  covers only that command, token for token — and, unlike a prefix, it may
  name an interpreter or script runner (`Bash(python3 x.py)`, `Bash(npm run
  build)`); removals and privilege commands are still rejected.
  `BashExact(<command text>)` is an exact rule for one whole command, matched
  character for character; the exact-command option writes it when no token
  rule can hold the command (default mode, `allow` only). `/permissions` lists
  it as *(exact text)*. `Bash(git add:*)` reads as `Bash(git add *)` in every
  list. `ask` forces
  a dialog in every mode, auto included. `deny` blocks in every
  mode and tells the model which rule. If the file cannot be read or is not valid JSON, every shell command asks until you fix it. `ask` and `deny` always load; `allow`
  rules that pi-keeper didn't write (a cloned repo, a hand or model
  edit) load only after a one-time *Load N allow rules?* review.
- **Sharing with subagents:** session grants (remembered commands, read
  directories, fetch hosts, loops over globs, python `while`, tool and MCP
  grants) reach every subagent, and a grant given in one subagent's dialog
  covers its siblings. Project rules are read by each subagent like any other.
- **A typical setup:** allow `git add *`, `git commit *`, `npm test *`; deny
  `git push *`. The agent commits freely and never pushes.

## The rulebook: rules that fire only when the model slips

A permission rule answers "may this run?". A **rulebook rule** answers "did the
model just do the thing I keep telling it not to do?" It sits in a file, costs
nothing until it matches, and then sends one correction — the only model text in
this package that is not paid for on every request.

A rule file is Markdown with three parts:

```markdown
---
description: Do not claim tests pass when they did not run.
condition: (?i)\ball tests pass\b
---
Do not claim that tests pass. Run `npm test` and quote the line that shows the
result, or say plainly that you did not run them.
```

- `description` — one line, shown by `/rules` and on the card.
- `condition` — one JavaScript regex, matched against the model's finished
  answer. Aim it at what a change could break, not at bookkeeping: the example
  above fires on "all tests pass" and stays quiet on "created two files". A leading `(?i)`, `(?m)` or `(?s)` sets the flags (`g` is never used).
  Only the last 20 000 characters of an answer are scanned.
- the body — the correction the model receives.

Where rules live:

- `<agent dir>/pi-keeper/rules/*.md` — yours, loaded as written
  (usually `~/.pi/agent/pi-keeper/rules/`). Session start and `/rules` create
  the folder and, once, if it has no rule file, `example-rule.md` to copy from.
  It never fires, and a `.example-seeded` marker stops it coming back after you
  delete it. `/new-rule <what must not happen>` (add "project" for a project
  rule) has the model write a rule file and test its regex.
- `<project>/.pi/rules/*.md` — the project's. It can change how the model
  behaves, so it loads only after a one-time review with a trust hash, like a
  project `allow` rule; a changed file is reviewed again. A user rule with the
  same file name wins.

What happens on a match (this is the whole lifecycle):

1. At the end of the turn, one hidden message carries the correction — the
   model reads it, the transcript does not show it — and asks for one more
   request so the model can fix what it just said.
2. A card appears in the transcript: `⚠ rule fired: no-claims — <description>`.
3. The fire is recorded in the session, so a rule fires **once per session**:
   a resume or a fork does not repeat it. `/rules` shows each rule's lifetime
   count (`12 fires · fired this session`): your own rules across all projects,
   a project's rules in that project.
4. Nothing is interrupted and no tool call is blocked or re-judged. That is the
   promise, and `intent.test.ts` pins it.

Commands and failure modes (`/rules` in the theme's colors, one rule on Enter):

- **`/rules`** opens the rulebook: every rule with its name, its source (user
  or project), whether it fired this session, and its description — in the
  theme's colors, not as a muted notification. Enter opens one rule (pattern,
  file, body), Esc goes back, Esc again closes. Without a TUI (print, RPC) it
  notifies the same facts as text; `/rules <name>` prints one rule in any mode.
  Permission rules are `/permissions`.
- A file that cannot become a rule is skipped with one warning at session
  start; the other rules carry on. Skipped: no frontmatter (the file must start
  with `---`), no `description:` or `condition:`, a `condition` that does not
  compile or matches ordinary text, and an empty body. `/rules` shows the reason.
- Nothing fires while a turn is aborted, and an empty answer matches nothing.
- What it costs: zero tokens on a run where no rule matches. On a fire, one
  hidden message and one extra request (only when the turn made no tool call).
  `npm run prompt-weight` prints the numbers for every mode.

Where a rule lives, why it did or did not fire, the two session entries it leaves
behind are in [docs/rulebook.md](rulebook.md).

## Read-only tools from other packages

Tools from other packages that only read (web search, page fetch, code
overview, the whole LSP read surface, ast search, MCP resources) or only record
the plan (the `todo` list) run without a dialog in default mode and are allowed
while planning, when they are named in `~/.pi/agent/pi-keeper.json`:

```json
{ "readOnlyTools": ["web_search", "fetch_content", "get_search_content", "source_check", "code_overview", "lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references", "lsp_symbols", "lsp_code_actions", "lsp_completions", "ast_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "bg_wait", "todo"] }
```

That list is also the default when the file is absent; a list you write
replaces it (`[]` turns the allowance off). Names are exact. The same file
holds the `/keeper` settings. The shell and
file writers (`bash`, `powershell`, `edit`, `write`, `exit_plan_mode`) and
the tools that front other tools (`mcp`, which runs any MCP sub-tool, and
`subagent`) can never be listed: they are ignored with a warning at session
start, because the name would allow whatever they are asked to run. The same tools never count as read-only from a tool's own `readOnlyHint`
annotation: they keep the mode's fallback (ask in default, deny in plan) whatever the server declares. The MCP
*resource* readers are listed while `mcp` is not: they only read what a server
offers. `lsp_rename` is deliberately absent — it only previews a rename today,
but the name promises a write; add it by hand if you want it. A broken file warns once at session start and the defaults
apply. Any other unknown tool still asks in default
mode and is denied in plan mode, with a message that tells the model it is
unavailable while planning.

### MCP and other packages' tools that ask

A tool that is not built in, and not read-only, asks in default mode. The dialog
offers *Yes, and don't ask again for `<key>` this session* and, with project
approvals on, *Yes, and always allow `<key>` in this project*. The keys:

- `Tool(<name>)` for a tool registered under its own name.
- `Mcp(<server>/<tool>)`, or `Mcp(<tool>)` without a server, for a call through
  the `mcp` gateway.
- `Mcp(<server>/catalog)` for a search, describe or list lookup.

A key matches exactly: the arguments are not part of it, and `Mcp(docs/search)`
does not cover `Mcp(search)`. Project rules go in `.pi/settings.local.json`,
next to your Bash rules:

```json
{ "pi-keeper": { "permissions": {
  "allow": ["Mcp(docs/catalog)", "Mcp(docs/get_page)", "Tool(tracker_list)"],
  "ask":   ["Mcp(tracker/update_issue)"],
  "deny":  ["Mcp(tracker/delete_issue)"]
} } }
```

Ask and deny rules apply in every mode. Allow rules apply in default mode only.

Never offered: `mcpScript` (it runs code, in any spelling), the gateway's
`connect` and `action`, a directly registered tool the server marks destructive,
and `bash`, `edit`, `write` and the other tools that cannot be listed. A call
through the gateway carries no such mark, so pi-keeper goes by the name: one that
looks like a write (`delete_issue`, `run_query`) shows "(may change data)" on the
option. Ask and deny rules match broadly (any case, with or without the server,
`docs_search` as well as `docs/search`), so a deny cannot be dodged by reshaping
the call; allow rules match exactly. Plan mode lets through
only tools whose annotations say read-only, as before. Auto mode is unchanged.


## Plan mode

1. `/plan <task>` (or switch to plan mode and type the task). `/plan` while
   already planning shows the plan file's path and content; `/plan open`
   opens it in pi's editor in any mode and writes your changes back.
2. The agent researches read-only. Notes, repros and cloned references go in
   a per-session scratch dir (named in its prompt); there `mkdir`, `touch`,
   `tee`, `cp`, `rm`, `cd`, `git clone` and a quoted `cat > file <<'EOF'` run
   without asking (`rm` only strictly inside it, never the dir itself).
   Commands that aren't read-only (tests, a build) ask, so you decide what it
   may run. Dangerous commands are denied: the model puts them in the plan.
   Edits and other tools stay denied, except tools that declare themselves
   read-only (MCP `readOnlyHint`) and the ones you list as
   [read-only](#read-only-tools-from-other-packages).
3. It writes the plan to one file per session,
   `~/.pi/agent/plans/<project>-<date>-<time>-<rand>.md` (`- [ ]` steps),
   and calls `exit_plan_mode`; the terminal rings. The plan opens with a
   **`## Plain-language explanation`** comes first: the goal, what exists
   now, the changes, the main risk and the checks, in short sentences in the
   style of ASD-STE100 Simplified Technical English. Then come `## Context and
   boundary`, `## Current state and reuse`, `## Ordered implementation steps`
   (one `- [ ]` per concern, naming the files), `## Verification` and `## Out of
   scope`.
   The plan appears in the
   transcript as formatted Markdown, with a selector docked under it. It is
   part of the conversation, so scrollback and search work, and a resumed
   session shows the plan as it was approved. The header tracks the outcome
   (`● Plan ready for review`, `● Plan approved · auto mode`, `● Kept
   planning: "..."`, `● Plan declined`, `· edited` after a ctrl+g edit).
4. You choose:
   - **Yes, in auto mode.**
   - **Yes, approving each edit** (default mode).
   - **Yes, approving each edit, and allow `npm test`, `git commit` for this
     session**: only when the plan lists commands (`exit_plan_mode` takes an
     optional `commands` list; dangerous, removal, interpreter and read-only
     entries are dropped).
   - **No, keep planning:** type what to change into the field and press
     Enter; the model revises the plan and asks again. Enter on an empty
     field does nothing. A note can also be a question ("where is the plan?",
     "why this order?"): the model is told to answer it in text and then ask
     again, so the review still ends with a decision. Nothing is lost by
     asking — the turn ends only when you approve, decline or cancel.
5. Keys: ↑↓ or ctrl+n/ctrl+p move; j/k and 1-9 move too, except on the field
   row; Enter confirms. **shift+tab** approves with manual approval and your
   typed note ("yes, but don't commit"): type it into the field, then
   shift+tab instead of Enter (Enter sends it as feedback and keeps
   planning). The hint under the field says so. **ctrl+g** edits the plan in your editor (your edits
   count and the model is told; draft feedback survives). **Esc** declines
   and **ctrl+c** cancels: the turn ends so the model doesn't carry on, and
   you give the next instruction. **Alt+M / Ctrl+Shift+M work in the
   selector**: the mode cycles (plan → default), the review closes and
   nothing is approved — and a draft typed into the field survives a
   shortcut that cycles back into plan mode. Without a TUI (RPC) the
   choice is a select followed by a text input; there is no shift+tab, so a
   note is always feedback and keeps planning.
6. On approval the tool result carries the plan text, so your edits count and
   it survives context compaction. The model works through the `- [ ]`
   checkboxes and ticks them off in the plan file. Editing the plan file
   never asks, in any mode (only that exact file, not its neighbours in the
   plans dir).

Re-entering plan mode in the same session reuses the plan file (the model is
told to read it first and refine or overwrite it). Leaving by hand with
`/mode` or a shortcut tells the model where the plan file is. The plan
prompt (`prompts/plan-mode.md`) has four steps: understand (read the code,
reuse what exists; read-only `scout` subagents for wide exploration; the
`questionnaire` tool only when the answer changes the design), design (one
approach), write the plan file once the task is clear, then call
`exit_plan_mode` and end the turn. A question gets a text answer and no plan.
The plan sections are listed above; the `commands` list on `exit_plan_mode` is
optional.

## Auto mode

For a task you trust and are watching: **use at your own risk inside the
project, but anything destructive outside it asks every time.** Everything
runs except the ask list: dangerous commands, deletes and overwrites outside
the project, protected paths (`.git/`, `.pi/`, shell rc files, ...), writes
outside the project, secrets, and the first outside read. Inside the project
`rm -rf src`, `git checkout -- src` and `sed -i` run silently. There is no
classifier: it is an accident guard, not a sandbox. `curl -d @data.json
https://...`, `make deploy` or a script that does something dangerous inside
will run. For unattended runs use a container or VM.

Links are followed: the secret, protected-path and outside-project checks also judge a symlink by where it points, so a link in the project to a secret, to `.git/` or to a file outside the project asks.

## Workflow commands

A prompt template or a skill can pre-approve the bash commands its run
needs:

```markdown
---
description: Commit the current changes
allowed-tools: Bash(git add *) Bash(git commit *)
---
```

While that command runs (default mode only) those patterns count like
session rules, limited to the run, with the same limits as a project rule
(never dangerous or program-running commands). Prompt commands (`/commit`)
and skill commands (`/skill:commit`) both work: the `Bash(...)` entries of
the file's `allowed-tools` frontmatter become grants; other entries are
ignored, and the `Bash(git add:*)` spelling Claude Code uses reads the same. A
skill such as the `commit` one carries its grants in its own frontmatter.
`/permissions` lists the grants and removes single ones.

The package ships one prompt template, `/new-rule <what must not happen>
[project]` (`prompt-templates/new-rule.md`); see [the rulebook](#the-rulebook-rules-that-fire-only-when-the-model-slips).
The files in `prompts/` are pi-keeper's own mode text, not commands.

## Subagents (pi-subagents)

With [pi-subagents](https://www.npmjs.com/package/pi-subagents) loaded
(`pi -e <pi-subagents> -e ./pi-keeper`, in either order), its child
agents follow your mode: plan → children run in plan (read-only, no plan
file); default → children run in default. An auto parent's children run in
default too, unless you turn on **Subagents follow auto mode** with `/keeper`: then
they run in auto as well — but only while their asks can reach your dialog
(see below). The mode is fixed per launch and nested subagents inherit it;
switching mode in the parent applies to the next launch.

### Workflow and parallel children

A `workflow`, `parallel`, `tasks` or `chain` child is a second launch: before
each child starts, pi-subagents makes a `subagent_launch` tool call that the
model never sees. This package allows that call in every mode, under the same
condition as `subagent`: the bridge to pi-subagents must be registered, so the
child loads your mode (in plan mode a child is read-only). Without pi-subagents
no session declares the tool, so nothing changes for a session that has none.

That call also carries what runs on the child's behalf after it stops: the
child's `gate` and `acceptance.verify` commands (`commands`), and the file the
child's `output` writes (`output`). Those are judged with the mode's own rules,
not allowed with the launch, and the strictest answer wins:

| Mode | The child's command or output write |
|---|---|
| default | read-only commands and commands you allowed run; anything else asks |
| auto | runs, except dangerous commands, secrets, protected paths and paths outside the project |
| plan | read-only commands run; anything else asks; dangerous commands and writes are denied |

A deny names the step (`The child leaves this behind: bash: rm -rf /tmp/x`), so
the agent can change the call instead of retrying it.

Three things ask in every mode, even for a command the rules call read-only,
because the rules would judge them as something they are not:

- a command that sets `env` (`GIT_PAGER`, `PATH` or `LD_PRELOAD` change what a
  `git log` runs). The dialog names the variables, never their values.
- a command whose `cwd` is outside the project. The rules read "inside the
  project" from your session's directory, so `rm -rf *` in your home directory
  would otherwise pass as a delete inside the project.
- a `commands` or `output` value this package cannot read. Unreadable is never
  treated as "nothing to check".

A single-child `subagent` call is judged the same way: its `gate`,
`acceptance` (the `verify` commands, also as a JSON string) and `output`. A
relative `output` lands in the run's artifacts directory and is not judged; an
absolute one is judged as a write; one with `..` asks; with `artifacts: false`
it is judged relative to the cwd. A value this check cannot read asks. A
`schedule.create` that stores a workflow asks, because its runs start later with
no tool call to judge.

Limits:

- The dialog has no *don't ask again* choice, so a workflow of N children with
  the same gate command asks N times. Approve the command once as a normal bash
  call (*don't ask again this session*), or add an allow rule for it, and the
  launches it covers stop asking.
- pi-subagents offers commands when a child launches, not when they run, and
  does not offer starts that have no tool call behind them (schedule ticks,
  auto-resume, `/prompt-workflow`, RPC launches) or the `acceptance.verify`
  commands a resumed child kept from before. This package cannot judge what it
  is never shown.
- `model`, `async`, `worktree` and `resume` are not judged. The child itself
  runs in your mode, and a child outside your project is locked.

### Which agents

The agents are pi-subagents' own builtins — this package ships none and does not
shadow them:

| Agent | Job | Thinking |
|---|---|---|
| `scout` | read-only recon that returns context for handoff | `medium` (upstream `low`, raised in settings) |
| `worker` | the single writer; also answers to `developer`, `coder`, `implementer`, `develop` | `high` |
| `reviewer` | read-only review of a diff, a plan, or a codebase | `high` |
| `oracle`, `evidence-auditor` | second opinion, evidence review | `high` |
| `researcher`, `delegate` | web research, general delegate | `medium` |

What this package adds to them is in the settings file, not in agent files: the
skills catalog (below) and the thinking floor (`/keeper
subagent-thinking`). Everything else — prompts, tools, aliases, report shapes,
acceptance roles — stays upstream, so `pi update --extensions` still improves
them.

### Thinking levels

Upstream levels are the floor, not a cage: run `/keeper subagent-thinking
follow` (the default) and a child runs at the **higher** of its own level and
your session's current one — raise the parent to `high` (Alt+T) and the next
child run is `high` too, with no file edited. Lowering the parent below a role's
own level does not lower the child; the role keeps the floor it was given.
`subagent-thinking role` restores plain upstream behavior: every child keeps
exactly the level its agent file (or a launch) asked for.

Model and effort stay per-role and per-run: pin one with
`subagents.agentOverrides.<name>.model|thinking` in `~/.pi/agent/settings.json`,
or raise a single launch with `model: "provider/id:high"` in the `subagent` call
(the `:level` suffix on a launch always wins — in `follow` mode it can only be
raised by a higher parent, never lowered). `subagents.maxThinking` is the hard
ceiling on all of it.

### Subagents get your skills

There is no
`subagents.defaultSkills`, but a settings override carries the field, so you
can enable it per role in `~/.pi/agent/settings.json` (this example covers
`scout`, `worker` and `reviewer`; add any other agent the same way):

```json
{
  "subagents": {
    "agentOverrides": {
      "scout":    { "inheritSkills": true },
      "worker":   { "inheritSkills": true },
      "reviewer": { "inheritSkills": true }
    }
  }
}
```

A child then gets the same `<available_skills>` catalog you do (metadata only;
it reads the file when the task matches). Two consequences worth knowing:

- **It is machine-local.** The setting lives in your pi config, not
  in the project, so a fresh machine needs those lines again. A stale override wins over
  everything else, which is why `agentOverrides` is the one place to look when a
  child behaves unlike its agent file.
- **Skill files are readable without an ask.** Reading `<skill-dir>/SKILL.md` and
  the files beside it is not an outside-cwd read, in every mode: the model was
  told to read exactly those files. Secrets inside a skill directory still ask,
  and so does every other path outside the working directory. The directories
  come from the prompt itself (`skillDirsFromPrompt`, `extensions/utils.ts`), not
  from a hardcoded list.
- **A missing skill only warns.** pi-subagents reports an unresolved skill in
the run's result instead of failing the child.

### Scripted fan-outs

A workflow (dependent steps, a step feeding the next) takes its source from a
fenced ```` ```js workflow ```` block **in the same reply** as the
`subagent({ workflow: true })` call. That is fragile: on some providers, text
after a tool call reaches the harness only as a summary, the block is dropped,
and the launch fails with *the workflow script block was not included* — losing
the whole fan-out. The portable form passes the source as a tool argument:

```js
subagent({
  async: true,
  options: { script: "const r = await runs.all([{ key: 'a', agent: 'scout', task: '…' }]); return r;" },
});
```

`options.script` replaces `workflow` (pass only one), takes the same source, and
cannot be dropped. `subagent({ action: "validate", options: { script } })` checks
the source without launching anything. For independent work prefer several
plain `subagent({ agent, task, async: true })` calls — no script at all.

The mode message carries the same hint while the `subagent` tool is active.

### Background subagents

A background child (`async: true`) runs in a detached pi-subagents process
with no UI of its own. When one of its tool calls needs approval, it asks
**your** session instead of being denied: the child files the call in a
mailbox under the agent dir, your session judges it with its own rules and
grants, and either settles it silently or shows the usual dialog.

- **What you see.** The terminal rings and the dialog opens with the usual
  options, titled `Background subagent <name>:` (the child's session name, or
  `subagent <pid>`). Under the default popup policy (`always`), the dialog opens as soon as no
  other dialog is open, even while the session is busy. With `idle`, a busy
  session or one with text in the editor is not interrupted: the footer shows
  `N background approvals waiting · /approvals` and the dialogs open at the next
  idle point, or when you run `/approvals`. Dialogs open one at a time.
- **Answers.** *Yes* runs the call in the child. The remember options
  (*don't ask again for this session*, *always allow in this project*, allow
  reads from a directory, *don't ask again for this exact command this
  session*, ...) are applied in your session, so the next identical call, from
  this child or another, runs without a dialog. A subagent's exact-command
  answer is stored as one exact command rule in the session list, so it is
  offered only when the command can be written as one; your own session's
  exact-command list stays yours. **Esc or *No* denies that one call**; the
  child is told you declined and carries on without it. *No, and tell pi what
  to do instead* and *switch to auto mode* are not offered here, because the
  child cannot receive a note and cannot change your mode.
- **Rules still decide first.** A call your rules allow runs without a
  dialog; one they deny (plan mode, `sudo`) is denied without a dialog. The
  child's own claim about its mode is not believed: your session uses the
  stricter of its own setup for that child and what the child says.
- **When nobody answers.** The ask is denied and the child is told why, in a
  reason clause it can report:
  - *Timeout*: no answer within `backgroundAskTimeoutMs` (default 5 minutes).
  - *The parent is gone*: you ran `/new`, `/resume`, quit pi or pressed
    Ctrl-C. Pending asks are denied and their dialogs closed. Your session
    also publishes a heartbeat while it listens, so a child that finds none
    (background asks off, no UI, a crashed parent) denies at once.
  - *No UI*: a parent running without a UI (`pi -p`, RPC) writes no heartbeat,
    so its background children find nobody listening and fall back when they
    start (default mode, or auto with `background-auto-fallback`). Only a parent that
    loses its UI while asks are pending replies that no user is available, and
    the call is denied.
  - A request the parent has held for the child's timeout plus a minute (at least 15 minutes) is dropped, and at most 100
    asks are held at once; more are denied.
  - *Asks turned off*: you turned background asks off in `/keeper` while the
    request was pending. Denied at once.
  - *Request too large*: it does not fit the mailbox's size limit. Denied at
    once, not after the timeout.
- **Mode follows the parent.** With asks reaching you, a background child of
  an auto parent (with *Subagents follow auto mode* on) runs in auto, like a foreground
  child, and a default parent's child runs in default. `background-auto-fallback`
  matters only when asks cannot reach you (see below). A relay-less child, such as
  a grandchild launched by a background child, runs in the mode
  `relaylessChildMode` gives it. With `background-asks` on, that is the mode of
  its entry. With it off, the child runs in `auto` when `background-auto-fallback` is on,
  otherwise in `default`, and in `default` its asks are denied because nobody
  can answer them.
- **Working directory.** A background child in `auto` whose environment names
  a parent session but cannot read that session's grants is locked down (every
  tool call denied except `contact_supervisor` and its report) rather than run
  without its working directory being checked. In `default` and `plan` it keeps
  working: its asks are denied anyway. A nested child (a child's own subagent)
  is in this case, because a child publishes no grants.
- **Settings.** `background-asks` (default **on**, in `/keeper`) turns
  the whole feature on or off; the environment variable
  `PI_KEEPER_BACKGROUND_ASKS=0`, set for the parent or the child, is a
  kill switch that overrides it.

Limits: a reply takes up to about half a second (polling); a parent blocked
for more than 15 seconds looks gone to its children; a child's lane text is
fixed when it starts.

### `/keeper`

`/keeper` is this package's settings command. In a TUI it opens one
panel, in sections (`Settings / Subagents`) that `Tab` and
`Shift+Tab` switch between, with every setting as a row: the label on the left,
the current value in an aligned column on the right, and the selected row's
help text below. `Enter` or `Space` flips a toggle or cycles a choice; on the
timeout row it opens a one-line input (`Enter` accepts, `Esc` goes back). A
value that cannot be saved — a duration out of range, say — is refused with the
reason in the panel's footer and the row keeps the saved value. `Esc` closes the
panel. An RPC or print host (no custom components) gets the older two-step
lists instead: pick a setting, then pick its value. `/keeper <setting>
<value>` sets one directly and also works without a UI (`on|off` for toggles, a
listed word for choices, a duration for durations). The settings live in
`~/.pi/agent/pi-keeper.json`, survive a restart and are re-read at session
start (a change made in `/keeper` also applies to the running session). A
settings file that is not valid JSON is never overwritten: a `/keeper` change
shows an error and saves nothing until you fix or remove the file.

The tabs are: **Settings**, with two headings — *Project approvals*
(`project-command-approvals`, `project-read-approvals`, `project-exact-commands`) and
*Dialog & mode line* (`command-colors`, `mode-flash`, `mode-status`, `mode-working-row`) — and
**Subagents** (`subagents-follow-auto`, `background-asks`, `background-auto-fallback`,
`subagent-thinking`, `background-ask-popup`, `background-ask-timeout`). `readOnlyTools`
and `modeInstructions` take lists and long strings, so you edit them in the file by hand.

- **Subagents follow auto mode** (`subagents-follow-auto`, default **off**): when on,
  children of an auto parent run in auto mode themselves — edits and
  commands inside the project run without asking, dangerous commands,
  secrets and protected paths still ask through your dialog as usual.
  Auto applies only to children whose asks can reach you: a foreground
  child runs in the parent's process and relays its asks to your terminal;
  a background child (`async: true`) files them in your session's mailbox
  (see [Background subagents](#background-subagents)). A child whose asks
  cannot reach you (background asks off, or a parent without a UI) stays in
  default mode — unless `background-auto-fallback` is on — so nothing runs auto with
  nobody watching. Turning the setting on or off applies to the next
  launch.
- **Subagent thinking** (`subagent-thinking`: `follow` or `role`, default **follow**):
  a child's thinking level. `follow`: the higher of the child's own level (its
  agent file's `thinking`, as configured: `medium` for `scout`, `high` for
  `worker` and `reviewer`) and this session's current one, so raising this session to `high`
  lifts the next child run and lowering it below the role's level does not lower
  the child. `role`: the child keeps what its agent file or a launch asked for
  and ignores this session. A `:level` suffix on a launch is never lowered by
  `follow`.
  Applies without restarting the child.
- **Offer "always allow in this project" for exact commands** (`project-exact-commands`, default **off**): when
  on, the approval dialog for a command no prefix can cover (an interpreter
  such as `python3 x.py`) also offers *Yes, and always allow this exact
  command in this project*, saved as an exact rule to
  `.pi/settings.local.json` — the repeated one-off approvals stop asking
  across sessions. Only that exact command, token for token, runs unasked;
  removals and commands whose rule body can't be written (a quoted
  argument) keep the session option; dangerous and secret asks are
  unaffected.
- **Background subagents can ask you** (`background-asks`, default **on**):
  a background child's gated calls open a dialog in your session instead of
  being denied. Off, such calls are denied and `background-auto-fallback` decides the
  child's mode. Turning it off also denies the asks already pending. Applies to the
  next launched child.
- **When background asks pop up** (`background-ask-popup`: `always`, `idle` or
  `badge`, default **always**): when a background child's ask opens its dialog
  in your session. `always` opens as soon as no other dialog is open; `idle`
  pops up with the bell when the session is idle and the editor is empty, and
  shows the badge otherwise; `badge` never pops up, you open asks with
  `/approvals`. Takes effect at the next poll, asks already waiting included.
  A session counts as idle only *between* runs: while any tool call is in
  flight — minutes of a foreground command, or a `subagent` wait on a
  background run — `idle` opens nothing, and an ask that arrives then waits
  for the run to end. If its child times out first, it is denied unseen. A
  parent that blocks in long waits or long commands should use `always`.
- **Background ask timeout** (`background-ask-timeout`, default **5 min**):
  how long a background child waits for your answer before the ask is
  denied. Minutes and/or seconds, each with its unit and in that order:
  `90s`, `5m`, `2m30s` (a bare number is refused), from 10 s to 30 min;
  outside that range the command errors rather than clamping. Applies to the
  next launched child. Asks already waiting here are judged against the new
  limit at the next poll, so lowering it can deny one that has waited longer;
  but your session's own limit never goes below 15 minutes, so below about 14
  minutes a lower setting mostly affects children launched afterwards.
- **Run auto when a background subagent can't ask** (`background-auto-fallback`, default **off**): only
  matters when asks cannot reach you (`background-asks` off, or a parent
  without a UI). When on, such a child runs in **auto mode** instead of
  default: its edits and commands inside the project run without asking, so
  an orchestrated worker can actually implement — while dangerous commands,
  secrets, protected and outside paths still ask, and with nobody to ask
  they are still denied. Foreground children with a relay are unaffected:
  their asks keep opening your dialog. Blast radius: the setting is global,
  so it applies to whatever project an orchestrator dispatches a background
  child to; the auto-mode ask list is the safety bound. Applies to the next
  launched child.
- **Offer "always allow in this project" for commands** (`project-command-approvals`, default **on**): the
  command dialog offers *Yes, and always allow `<prefix>` in this project*,
  and a fetch from a new host offers *Yes, and always allow fetching from
  `<host>` in this project* (`Fetch(<host>)`). Off, approvals stay once or
  for the session.
- **Offer "always allow in this project" for outside read directories** (`project-read-approvals`, default **off**):
  the outside-read dialog also offers *Yes, and always allow reading from
  `<dir>/` in this project*, saved as `Read(<dir>/**)` to
  `.pi/settings.local.json`; later sessions and every subagent read there
  without asking, secrets inside still ask. `/`, the home directory and its
  ancestors are refused. Listed and removable via `/permissions`.
- **Command colors in the dialog** (`command-colors`: `dim`, `muted`,
  `text`, `builtin-syntax` or `shell-highlight`; default **shell-highlight** when
  pi-shell-highlight is installed, else **dim**): how the dialog
  paints the full command of a long bash call (multi-line, or over 300
  characters). `dim`, `muted` and `text` are plain theme slots — `dim` is only
  just readable on some dark themes (`obsidian-harbor`'s slate sits at 4.4:1,
  `muted` reaches 10.3:1). The two syntax values color the command instead.
  `builtin-syntax` is pi's own highlighter, the one the transcript uses for
  fenced code: strings, variables, keywords and comments — but not the name of an
  external command, and a heredoc body comes out as one string, because a
  grammar cannot know that `git` or `tar` is a command. `shell-highlight` asks
  [pi-shell-highlight](https://github.com/DanielBlei/pi-packages/tree/main/pi-shell-highlight) for the richer renderer — command
  names, the inner language of a heredoc (`cat <<EOF` with Python inside), and an
  assignment target in a python/ruby/perl body —
  and falls back to `dim` when that package is not loaded (an unset value follows
  whether the package is loaded, when each dialog opens; a value you set yourself is
  kept). Install it with `pi install npm:pi-shell-highlight`. A diff
  preview keeps its added/removed colors either way. Applies to the next dialog.

- **Mode line after a switch** (`mode-flash`, file key `modeFlashSecs`, default **off**): after a
  switch while idle, the mode (`≡ plan`, `» auto`, `● default`) shows in its color above the
  prompt for this long. The panel offers `off`, `1s`, `2s`, `3s` and `5s`; in the file `0` is off and any
  value from 0.1 to 10 works. Nothing shows on session restore or in a subagent child.

- **Mode in the working row** (`mode-working-row`, file key `modeWorkingRow`, default **off**): while a
  run is active in plan or auto mode, the working row reads `» auto · Working`. Default mode keeps
  pi's own text. pi-cc-extensions rewrites the working row, so with it loaded this has no effect.

- **Mode in the footer** (`mode-status`, file key `modeStatus`, default **on**): the mode in the
  footer status line. Turn it off to hide it; the mode still applies.

Session grants (remembered commands, read directories, "all edits") stay in
memory for the session and are never written to the project; foreground
subagents share them through the relay and background subagents through a
per-session file under the agent dir, removed when pi exits (answers to a
background ask are applied in your session, so they appear there too). Every model,
parent and child, is told the rules in effect (a *rules line*: project
allow/ask/deny entries, read directories, session grants).

- **Children ask through you.** A tool call that needs approval in a
  foreground child opens the same dialog in your terminal (the title says
  *subagent*, the terminal rings) and your answer is applied to the child's
  call. The only option a child never offers is *Yes, and switch to auto
  mode*. Project rules are read from and saved to the child's own working
  directory. After a *No* in a subagent run, its later asks are denied
  without a dialog until the next prompt or message from you. A *this
  project* approval is saved in the project root of the child's working
  directory (the nearest folder with a `.git`, so a linked worktree is its
  own root), and a subagent working in another git root or worktree does
  not see it.
- **Answers apply to the whole pi session:** session rules, *allow all
  edits*, outside-read grants, granted read directories and fetch hosts are shared between
  parent and in-process children both ways.
- **Fail closed:** when an ask cannot reach a user (background asks off, no
  parent listening (a parent without a UI never listens), a timeout or a failing relay) it is
  denied with a reason the agent can report (unless the `background-auto-fallback`
  setting has such a child run in auto mode, where only the
  dangerous/secret/protected asks still deny); the child can use
  `contact_supervisor` to escalate. If this package could not register with pi-subagents the
  `subagent` tool is denied in every mode. Agents configured for another
  runner (`claude-code`, `codex-exec`, `cursor-agent`) or another machine are
  refused: they can't load this package, so they would run unchecked.
- Read-only commands and trusted project allow rules run in background
  children without asking.
- **A child's own report is writable.** pi-subagents tells a scout to write
  its findings to `<agent dir>/sessions/<dir>/subagent-artifacts/outputs/<id>/`;
  a child may `write`/`edit` files there in every mode (otherwise plan mode
  denies it and a default-mode child is silently refused). The path is
  checked by real path, so a symlink in that tree that points elsewhere does
  not count, and a secret file name (`.env`, `id_rsa`) is not a report: it
  asks in default and auto and is denied in plan. Nothing else under the agent
  dir opens up. The allowance covers every artifact dir, not just the child's
  own: the id in the path is not the child's run id, so it can't be matched.

## Where state lives

| What | Where | Lasts |
|---|---|---|
| Mode, plan file path | the pi session | per branch, restored on resume and `/tree` |
| Session rules, *outside reads*, granted read directories and fetch hosts | memory; subagent children see them through the relay (background children through a snapshot on disk) | until a new session starts (`/new`, `/resume`, fork) or exit |
| *Yes, allow all edits this session* | memory; subagent children see it through the relay | until a new session starts (`/new`, `/resume`, fork) or exit |
| Project rules | `.pi/settings.local.json` (trust hashes in `<agent dir>/pi-keeper/trusted-rules.json`) | until you remove them |
| Rulebook rules | `<agent dir>/pi-keeper/rules/*.md` (yours) and `<project>/.pi/rules/*.md` (reviewed once, hashes in the same trust store) | until you edit or delete them; read again every turn |
| Rulebook rules fired this session | `pi-keeper-rule-fired` entries in the session | per branch; a resume keeps them fired |
| Pending background asks, and the "listening" heartbeat | `<agent dir>/pi-keeper/asks/<hash of the session id>/` (mode `0700`) | until answered; denied and removed when the session ends (files of gone children too) or after the timeout plus a minute (at least 15 minutes) |
| Workflow-command grants | memory | one run |
| Plans | `~/.pi/agent/plans/` | kept |
| Scratch dir | `<tmp>/pi-keeper-XXXXXX`, mode `0700` | per session, never deleted (clean `<tmp>/pi-keeper-*` yourself) |
| Settings (`readOnlyTools`, `subagentsFollowAuto`, `projectExactCommands`, `backgroundAutoFallback`, `backgroundAsks`, `projectCommandApprovals`, `projectReadApprovals`, `backgroundAskTimeoutMs`, `backgroundAskPopup`, `modeInstructions`, `modeFlashSecs`, `commandColors`, `subagentThinking`, `modeStatus`, `modeWorkingRow`, `ccExtensionsPrompt`) | `~/.pi/agent/pi-keeper.json` (`/keeper` writes all of them but `readOnlyTools`, `modeInstructions` and `ccExtensionsPrompt`: you edit the first two by hand, and the pi-cc-extensions dialog writes the last one) | until you edit it; re-read at session start (the two background-ask settings from `/keeper` also apply live) |
| Exact commands approved for the session | memory | until a new session starts (`/new`, `/resume`, fork) or exit |

The session log's command text (`pi-keeper-permission` entries) redacts secrets:
`Authorization:` and `Bearer` values, `-u user:pass` and URL passwords,
credential-like headers (`X-Api-Key`, `Cookie`), `-p` passwords (`mysql -psecret`,
`sshpass -p`), `redis-cli -a`, credential-like `--token`/`--password` options and
`NAME=value` assignments are written as `***`. Secret-named keys in the input of
other tools are redacted the same way.

`/new` starts in `default`. Every mode declares the same tools (the mode only
decides what is allowed, asked or denied), so a switch changes no tool list and
tools from other packages and MCP keep their state.

## Compatibility

Tested with pi 1.5.2 (`@earendil-works/pi-coding-agent`), pi-subagents 0.89.0
and pi-cc-extensions 1.0.20. pi-subagents and pi-cc-extensions are optional,
not dependencies. Without pi-subagents, the subagent bridge does nothing and
pi-keeper works standalone. Without pi-cc-extensions, tool rows keep pi's own
rendering.

- **pi-cc-extensions and the plan row:** it restyles every tool row and shows
  only `↳ Pending…` while a tool has no output yet, which hides the plan. The fix
  is to list `exit_plan_mode` under `"excludeRenderers"` in
  `~/.pi/agent/pi-cc-extensions.json`. While the fix is missing, a dialog opens once
  per session at start with four choices: apply the fix (keeps every other setting,
  then run `/reload`), put a prompt for the agent in the editor (not sent), not now
  (asked again next session), or don't ask again (saved as `ccExtensionsPrompt` in
  `pi-keeper.json`). The manual edit is adding `"exit_plan_mode"` to that list,
  creating the list if it is missing. pi-cc-extensions 1.0.20 requires pi ^1.5.1 according to its
  README. The script `scripts/exclude_exit_plan_mode.py` in a checkout of this
  repository does the same edit from a shell.
- **Footer colors:** upstream pi-cc-extensions strips ANSI colors from
  extension status chips, so pi-keeper's badges render dim there.
- **Claude models behind a gateway, and mode switches:** the system prompt and
  the tool list are the same in every mode, so a switch does not change the
  request prefix. Claude's signed thinking blocks are bound to that prefix, and
  a changed prefix can end a session on a custom `anthropic-messages` provider
  with a 400.
  Why that matters and how it works: [docs/design.md](design.md) ("Why
  the prefix is frozen"). Residual: an MCP server connecting mid-session still
  adds tools, and that does change the prefix.
- **Where the mode comes from:** the system prompt holds one constant block
  (the permission contract); the mode itself, your rules and the plan file
  arrive as hidden messages in the conversation, appended only when they
  change (a session grant re-sends the whole mode message). On a small local
  model that follows the system prompt better than a message, set `"modeInstructions": "prompt"` in
  `~/.pi/agent/pi-keeper.json` to put the mode back into the prompt.
- **Where the colors reach:** `"shell-highlight"` also paints the one-line
  `bash: <command>` title of the dialog (the form a short command takes, where
  there is no preview block) and a `bash`/`sh` fenced block in the plan view,
  so a plan reads like the call that will ask for it. A command *pattern*
  (`git *`, the rows of "Which commands should be allowed?") and the
  placeholder `(full command shown below)` are not commands, so they keep the
  flat warning yellow, and the other four settings leave the title and the
  plan exactly as pi draws them.
- **Tool names:** `questionnaire` and the older `ask_user_question` are both
  recognized. Unknown names are ignored by `pi.setActiveTools()`; run
  `/tools` to verify.

## Security and limitations

pi-keeper reduces what an agent can do without asking you. It is not a sandbox,
and it cannot guarantee that a harmful command is caught.

- It decides from the command text and the tool arguments. A shell is too
  flexible for that to be complete: variables, symlinks, scripts the agent
  writes and then runs, and tools from other packages can all do things that
  pi-keeper does not see.
- No mode is bulletproof. `auto` lets the most through. Prefer `plan` or
  `default`, and add the narrowest rule that does the job.
- Read each permission dialog before you approve it, and review the agent's
  changes before you commit, push or deploy them.
- For untrusted code or unattended runs, add isolation that does not depend on
  the agent: a container, a VM or a separate user account without your
  credentials.

You use pi-keeper at your own risk. It is provided "AS IS", without warranties
or conditions of any kind; see sections 7 and 8 of the
[LICENSE](../LICENSE).
