# Changelog

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
