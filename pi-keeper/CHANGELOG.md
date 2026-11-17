# Changelog

## Unreleased

- Workflow, `parallel`, `tasks` and `chain` children (pi-subagents 0.85 and
  newer) no longer fail in plan mode. pi-subagents makes a `subagent_launch`
  call for each child that the model never sees; it is now allowed in every
  mode under the same condition as `subagent` (the bridge must be registered),
  and it is never read-only or listable.
- A launch also runs what the child leaves behind: its `gate` and
  `acceptance.verify` commands and the file its `output` writes. Each command is
  judged as a bash call and the file as a write, with the mode's own rules, and
  the strictest answer wins. The dialog and a deny name the step.
- A command that sets `env`, a command whose `cwd` is outside the project, and a
  `commands` or `output` value of a shape the check cannot read ask in every
  mode, even for a command the rules call read-only.
- An `output` path whose artifact directory is a link that leads out of the
  sessions directory is no longer taken for the child's report.
- `rtk grep`, `rtk rg`, `rtk find` and `rtk tree` no longer ask for an unquoted
  glob that cannot become a flag: `src/*.py`, `./*.py` and `--include=*.py` run,
  because every expansion keeps its literal prefix. `*.py`, `--pre=*.sh`, `$VAR`,
  `{-a,b}` and any glob that leaves the project (`../*`, `/etc/pass*`, `~/*`)
  still ask: a file named `--pre=x.sh` would reach `rg` as an option.
- A glob operand is now checked against what it matches on disk. `cat conf/*`
  asks when `conf/` holds an `id_rsa`; a glob, or a plain name, that is a link
  leading out of the project (`src/link.py` pointing at a file elsewhere) asks as
  an outside read; a glob that matches more than 2000 files asks. Before, only a
  pattern that could match `.env` was seen, and a link inside the project was
  taken for a file inside it.
- The user guide moved to `docs/guide.md`, and the contributor notes to
  `docs/development.md`. The README is a short install and overview page. The
  package descriptions of pi-keeper, pi-session-topic and pi-shell-highlight
  were reworded.

## 0.1.0 - 2026-11-16

First public release, as `pi-keeper`.

- Three modes — `default`, `auto`, `plan` — cycled with Alt+M / Ctrl+Shift+M,
  `/mode` or `/plan`; the mode is restored per branch on resume.
- Per-project rulebook: `allow` / `ask` / `deny` entries that persist in
  `.pi/settings.local.json`, plus session grants and one-run grants. A rules
  file that cannot be read or parsed makes every shell command ask.
- Checks fail closed: a tool call whose check throws is blocked, not run.
  Malformed `pi-keeper.json` is never overwritten when a setting is saved.
- Command and path checks: `echo` and `printf` of a credential-named variable
  ask; global options before the subcommand of `docker`, `podman`, `cargo`,
  `gem`, `poetry`, `twine` and `gh` no longer hide a dangerous subcommand;
  `mcp` and `subagent` are never read-only by annotation; symlinks are judged
  by their target; `$PWD` at the start of a path expands like `$HOME`; reads
  under the system temp dir never ask, writes there still do.
- The rulebook proper: regex rules that fire only when the model slips, with an
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
- Background asks pop up as soon as no other dialog is open (*When background
  asks pop up*: `always` by default; `idle` waits for an idle session, `badge`
  only opens through `/approvals`).
- Permission telemetry in the session log, with secrets redacted from bash
  commands, plus the `scripts/extract_flow.py` and
  `scripts/aggregate_failures.py` readers, which live in the repository rather
  than the npm package.
