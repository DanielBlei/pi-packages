# Changelog

## Unreleased

### Added

- Loops over globs ask once. `for f in *.md; do …; done` gets a new option, "Yes, and
  allow loops over globs this session". Subagents share the grant.
- Dev: `npm run replay` (`scripts/replay.ts`) replays a recorded session and compares
  the decisions of two code trees.

### Changed

- More safe commands run without a dialog when every part is read-only or covered:
  literal `for` loops and literal lowercase variables, pipes and redirects after `done`,
  `cmd < file`, checksum tools (not `-c`/`--check`), plain heredocs into the scratch dir
  (unquoted delimiter with an inert body, and `cat >>`), and statically readable inline
  python (`python3 -c '…'`, `python3 - <<'EOF'`).
- The secret, outside-read and dangerous-command checks judge the expanded command.
- Dialogs name the real reason, taken from the expanded command.
- No answer of an earlier version becomes stricter. Auto mode is unchanged.

## 0.1.2 - 2026-11-18

### Added

- A preview image for the pi package gallery (`pi.image` in `package.json`). The image
  is loaded from GitHub and is not part of the npm package.

### Changed

- Mode icons are now `»` for auto and `≡` for plan. The old `⏵⏵` and `⏸` did not show
  in some fonts and broke the column alignment in some terminals.

## 0.1.1 - 2026-11-18

A review of the whole package. Most entries close a way for a call to run without the
question it should get.

### Security

- A single `subagent` call is judged by its `gate`, `acceptance` verify commands and
  `output` file, as workflow children already were. A `schedule.create` of a workflow
  asks.
- Shell keywords (`for`, `do`, `if`, ...) are never remembered as a command prefix,
  which let any loop body run without a question. A loop gets the exact-command options.
- A backslash at the end of a line joins the lines as bash does (`su\⏎do id`).
- Project `deny` and `ask` rules match the command by path or behind a launcher: with
  `Bash(make deploy *)`, `/usr/bin/make deploy` and `exec make deploy` are denied too.
  `Bash(rm:*)` is read as `Bash(rm *)`.
- More secret reads ask in every mode: `grep -f.env`, `git show HEAD:.env`,
  `ls | xargs cat`, a glob under `~` that matches a secret, and environment dumps
  (`env`, `printenv`, `/proc/*/environ`). Exclude filters (`--exclude=.env`) do not ask.
- `~user/...`, `~-` and a glob outside the project (`cat /etc/pass*`) count as outside.
- Auto mode asks before a redirection writes outside the project (`echo x > ~/notes.txt`).
  Writes to the system temp dir ask.
- `sudo` and dangerous commands are seen through more launchers and shells (`exec`,
  `find -exec`, `pwsh`, `nsenter`). `runuser` is a privilege command. `sudo` after
  `ssh host` asks instead of being denied.
- Download-and-run is caught behind a wrapper or a path (`curl x | env -i bash`).
- More commands are never remembered as a prefix (`tsx`, `uvx`, `dotnet`, `psql`, ...).
  `git rebase --exec`, `git submodule foreach` and `git bisect run` are never covered
  by a rule.
- Smaller: an awk `/` after `x++` hid a pipe to a shell; a restored plan file path must
  be inside the plans directory; with a git repository as home, a subagent's working
  directory is checked against the parent's; `/rules` prints no terminal escape
  sequences; dialogs show zero-width characters as `�`.

### Fixed

- `cd` into another repository combined with git asked again and again. The dialog now
  offers *Yes, and allow git in `<repo>/` this session*.
- The session log redacts more secrets (non-bash tool input, `-u user:pass`, URL
  passwords, token headers).
- A background ask larger than the mailbox limit made the child wait for the timeout.
  It is now denied at once. Turning background asks off in `/keeper` denies pending
  asks with "background asks were turned off in the parent session".
- A background ask that an open dialog already covers opens no second dialog.
- A malformed `trusted-rules.json` is no longer overwritten; pi-keeper warns instead.
- `/mode constructor` blocked every tool call.
- *Ignore for this session* on project rules no longer outlives `/new` and `/resume`.
- A glob with many `*` could freeze pi.
- `/rules` crashed with "Rendered line N exceeds terminal width" on long text.
- A command after `!` is matched by your rules like the same command alone.

### Changed

- `project-exact-commands` is **on by default**: the dialog for a command no prefix can
  cover offers *Yes, and always allow this exact command in this project*. Not offered
  for removals, privilege commands, program-running flags or writes outside the project.
- `/keeper` has two tabs: **Settings** and **Subagents**.
- The mode line after a switch is **off by default**; turn it on in `/keeper` (Dialog)
  or with `modeFlashSecs`.
- A rulebook file with no frontmatter, or a condition that matches ordinary text, is
  skipped with a warning.

### Added

- `BashExact(<command>)` entries in `.pi/settings.local.json` (`allow` only): this exact
  command text runs without a question in default mode. The project option saves one
  when the command cannot be written as `Bash(...)`, such as a `for` loop.
  `/permissions` lists them as "(exact text)".
- *Yes, and allow git in `<repo>/` this session*: after `cd` into another repository,
  git there runs without the question (dangerous git commands still ask). Session only,
  shared with subagents, removable in `/permissions`.
- `/keeper mode-working-row` (`modeWorkingRow`, default off): the mode in the working
  row (`⏵⏵ auto · Working`).
- `/keeper mode-status` (`modeStatus`, default on): off hides the mode in the footer.
- `example-rule.md`, a dummy rule that never fires, is created in
  `~/.pi/agent/pi-keeper/rules/` when it holds no rule file.
- `/new-rule <what must not happen>`: the model writes a rule file and tests its regex.

## 0.1.0 - 2026-11-17

First public release.

- Three modes — `default`, `auto`, `plan` — cycled with Alt+M / Ctrl+Shift+M,
  `/mode` or `/plan`; the mode is restored per branch on resume.
- Per-project rules: `allow` / `ask` / `deny` entries that persist in
  `.pi/settings.local.json`, plus session grants and one-run grants. A rules
  file that cannot be read or parsed makes every shell command ask.
- Checks fail closed: a tool call whose check throws is blocked, not run.
  Malformed `pi-keeper.json` is never overwritten when a setting is saved.
- Command and path checks: `echo` and `printf` of a credential-named variable
  ask; global options before the subcommand of `docker`, `podman`, `cargo`,
  `gem`, `poetry`, `twine` and `gh` do not hide a dangerous subcommand;
  `mcp` and `subagent` are never read-only by annotation; symlinks are judged
  by their target; `$PWD` at the start of a path expands like `$HOME`; reads
  under the system temp dir never ask, writes there still do.
- A glob operand is judged by what it matches on disk. `cat conf/*` asks when
  `conf/` holds an `id_rsa`; a glob, or a plain name, that is a link leading
  out of the project (`src/link.py` pointing at a file elsewhere) asks as an
  outside read; a glob that matches more than 2000 files asks.
- `rtk grep`, `rtk rg`, `rtk find` and `rtk tree` run an unquoted glob that
  cannot become a flag without asking: `src/*.py`, `./*.py` and
  `--include=*.py` keep their literal prefix in every expansion. `*.py`,
  `--pre=*.sh`, `$VAR`, `{-a,b}` and any glob that leaves the project (`../*`,
  `/etc/pass*`, `~/*`) ask: a file named `--pre=x.sh` would reach `rg` as an
  option.
- The rulebook: regex rules that fire only when the model slips, with an
  evidence column and a warning injected into the prompt.
- Plan mode: the plan is written to a plan file, reviewed in the transcript and
  approved before anything else is written.
- Command colors default to `shell-highlight` when pi-shell-highlight is
  installed and to `dim` when not (resolved when each dialog opens); an explicit
  `shell-highlight` without that package means `dim`.
- pi-cc-extensions' plan approval: a one-time dialog at session start offers to
  add `exit_plan_mode` to `excludeRenderers` (apply it, put a prompt for the agent
  in the editor, not now, or don't ask again).
- Subagents: children inherit the parent's mode through a bridge into
  pi-subagents; background children can ask the parent's user. A queued ask
  already covered by an approval in another subagent opens no dialog. A
  background child in auto whose parent's grants cannot be read is locked.
- Workflow, `parallel`, `tasks` and `chain` children (pi-subagents 0.85 and
  newer) work in every mode, plan included: the `subagent_launch` call that
  pi-subagents makes for each child, which the model never sees, is allowed
  under the same condition as `subagent` (the bridge must be registered) and is
  never read-only or listable.
- A launch is judged by what the child leaves behind too: its `gate` and
  `acceptance.verify` commands as bash calls and the file its `output` writes as
  a write, with the mode's own rules; the strictest answer wins, and the dialog
  or the deny names the step. A command that sets `env`, a command whose `cwd`
  is outside the project, and a `commands` or `output` value of a shape the
  check cannot read ask in every mode, even for a command the rules call
  read-only. An `output` path whose artifact directory is a link leading out of
  the sessions directory is not taken for the child's report.
- Background asks pop up as soon as no other dialog is open (*When background
  asks pop up*: `always` by default; `idle` waits for an idle session, `badge`
  only opens through `/approvals`).
- Permission telemetry in the session log, with secrets redacted from bash
  commands, plus the `scripts/extract_flow.py` and
  `scripts/aggregate_failures.py` readers, which live in the repository rather
  than the npm package.
