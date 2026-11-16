# Changelog

## 0.1.0 - 2026-11-16

First public release, as `pi-keeper`.

- Three modes — `default`, `auto`, `plan` — cycled with Alt+M / Ctrl+Shift+M,
  `/mode` or `/plan`; the mode is restored per branch on resume.
- Per-project rulebook: `allow` / `ask` / `deny` entries that persist in
  `.pi/settings.local.json`, plus session grants and one-run grants.
- The rulebook proper: regex rules that fire only when the model slips, with an
  evidence column and a warning injected into the prompt.
- Plan mode: the plan is written to a plan file, reviewed in the transcript and
  approved before anything else is written.
- Subagents: children inherit the parent's mode through a bridge into
  pi-subagents; background children can ask the parent's user.
- Permission telemetry in the session log, plus the `scripts/extract_flow.py`
  and `scripts/aggregate_failures.py` readers, which live in the repository
  rather than the npm package.
