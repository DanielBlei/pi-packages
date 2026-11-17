# Challenges

What is still open, limited or unproven in pi-keeper. Problems that are
solved belong to [design.md](design.md) and are not repeated here.

## Open

- **Plan approvals often do not lead to execution:** many go back to planning or are declined, and the plan view and plan prompt have changed since, so whether that shows in outcomes is not yet known.

- **Prompts that remain:** reads outside the project, inline interpreter runs (`python3 -c`, heredocs), edits to pi's `models.json` and recursive `rtk grep -r` over a tree with a `.env` still ask by design, and each one is a cost.

- **Subagents:** background asks are limited (a reply takes up to about half a second; a parent blocked over 15 seconds looks gone to its children), and artifact writes are not scoped to the child's own directory because the artifact id is not the run id.

- **Approve with a note:** Shift+Tab approves into per-edit approval, never auto, and does not exist without a TUI, so a "yes, but ..." note costs a round trip.

- **Telemetry gaps:** a dialog wait cannot be told apart from the user being away, `promptVersion` misses lane-line, rules-line and `modes.ts` table changes, and idle cost is measured per poll, not per session.
