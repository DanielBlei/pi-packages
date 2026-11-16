# Challenges

What is still open, limited or unproven in pi-keeper. Problems that are
solved belong to [design.md](design.md) and are not repeated here.

## Measuring

`extract_flow.py --stats` aggregates the permission telemetry per model: asks
by matcher, approval rate, plan outcomes and denies.

```bash
python3 scripts/extract_flow.py --stats ~/.pi/agent/sessions
```

Reference figures from recorded sessions, to compare later runs against. **They
are one machine's sample, not a baseline of the package.** Every row comes from
a single developer's own sessions on one machine, recorded while this version
was being written: the mode prompts, the rule tables and `promptVersion` have
changed since, and one person's habits decide most of a dialog rate. Compare
the **shape** of a run (share of asks, plan outcome mix, which prompts repeat)
with these numbers, not the absolute counts.

| Model | Sessions | Decisions (allow / ask / deny) | Dialogs approved | Plan approvals |
|---|---|---|---|---|
| Small model (local gateway) | 19 | 1,209 (1,013 / 191 / 5) | 97% (182 of 188 answered) | keep-planning 8, rejected 7, execute-auto 3, execute-manual 2 |
| Large model (OpenAI-class) | 2 | 82 (53 / 28 / 1) | 100% of 28 | execute-manual 1 |
| Claude | 1 | 10 (8 / 2 / 0) | 100% of 2 | keep-planning 1, execute-auto 1 |

The large-model and Claude samples are one session each, so any comparison
between model sizes is directional. Dialog waits include time the user was
away (median 16 s, max 51 min), so wait totals are an upper bound.

## Open

### 1. Plan approvals often do not lead to execution

Of 23 recorded plan approvals in that sample, 7 were executed; 9 went back
to planning and 7 were declined without a note. Most of the notes asked to see the plan, and in
one research task the model started doing the work instead of planning. The
plan view and the plan-mode prompt have been reworked since; whether that
shows in the numbers is not yet known.

### 2. Prompts that remain

Nearly every dialog is answered "Yes", so each remaining prompt source is a
cost. The ones left on purpose:

| Source | Why it stays / candidate |
|---|---|
| Reads outside the project (pi's install docs, rtk tee logs, agent skills) | Each asks once per directory and offers a directory grant. Candidate: grant rtk's tee dir (rtk tells the model to read it) and pi's docs by default. Not done: it widens read access beyond the session's own files. |
| Inline interpreter inspections (`python3 -c`, heredocs) | Cannot be classified read-only. The exact-command option only removes repeats. |
| Edits to pi's own `models.json` (protected path) | Legitimate. |
| Recursive `rtk grep -r` over a tree with a `.env` | The secret check is right. Models add `-r` by habit; the prompt hint says not to, and it should be watched. |

### 3. Subagents

- **Background asks have limits.** An `async: true` child now asks the parent's
  user through a file mailbox, but a reply takes up to about half a second,
  a parent blocked for more than 15 seconds looks gone to its children, and
  *No, and tell pi what to do instead* is not offered (see design.md, Background asks).
  A child of a background child cannot ask and is denied.
- **Artifact access is not scoped to the child's own directory.** The id in
  the artifact path is not the child's run id, so one child can overwrite
  another's report. Needs pi-subagents to hand the child its artifact path.
- **The skills fix lives in machine settings, not in this repo.** `scout`,
  `worker` and `reviewer` get `inheritSkills: true` from
  `subagents.agentOverrides.<agent>` in `~/.pi/agent/settings.json`:

  ```json
  {
    "subagents": {
      "agentOverrides": {
        "scout": { "inheritSkills": true },
        "worker": { "inheritSkills": true },
        "reviewer": { "inheritSkills": true }
      }
    }
  }
  ```

  A fresh machine, a new user, or a settings file that is reset loses it
  silently (children simply see no catalog again). Nothing in the repo can
  detect that — the smoke check is asking a `scout` child to list its skills.
  The same override wins over every agent definition, so it is also the first
  place to look when a role behaves unlike upstream.
- **Role levels come from settings, not from the agent files.** Upstream ships
  `scout` at `low`; it runs at `medium` here through
  `agentOverrides.scout.thinking`, one line away from upstream again. `worker`
  and `reviewer` keep upstream `high` (previously worker ran with thinking off
  through a settings override). `subagent-thinking: follow` raises a child to
  the parent's level but never lowers it, so a parent at `medium` still gets
  `high` workers — deliberate, and the reason `role` exists for anyone who wants
  the parent's level exactly. `delegate` pins nothing and follows
  `subagents.defaultThinking` / the harness default.
- **A child's skill catalog is metadata only.** The child gets names and
  descriptions; it must still decide to read `SKILL.md`. A small model that
  ignores the catalog (or a brief that does not name the skill) behaves as
  before, and `plan-orchestrate` therefore names the skill in the brief.
- **The skill-read exemption follows pi's prompt shape.** It parses
  `<location>` out of `<available_skills>`; a rewording there would silently
  turn skill reads back into asks (`skill-reads.test.ts` pins the shape).
- **A child's thinking level is a floor, not a mirror.** `subagent-thinking:
  follow` takes the higher of the child's own level and the parent's, so a
  parent that drops to `low` to save tokens still gets `medium` children, and a
  per-run `:low` is ignored. That is deliberate (thinking off is the failure
  mode this setup exists to prevent) but it is not what "follow" sounds like;
  `role` is the exact-level setting. The level is read from the child's own
  `pi.getThinkingLevel()` and applied with `pi.setThinkingLevel()`, which pi
  clamps to what the child's model supports — so a `high` parent with a child on
  a model without `high` gets that model's top level instead, not an error.
  An in-process foreground child shares the parent's process; the smoke test in
  the root README's update ritual is what proves the setter lands in the child's
  session and not the parent's (a background child is a separate process and
  cannot leak).

### 4. Approve with a note

Shift+Tab approves into *approving each edit*, never auto, and does not exist
without a TUI, where a note is feedback. Typing "yes, but …" into the
keep-planning field costs a round trip; only the hint under the field helps
today. Approving into auto with a note would need a second key.

### 5. Telemetry gaps

What is still missing after `decideMs` and the per-session `model` +
`promptVersion` entry:

- A dialog wait still cannot be told from the user being away. `waitMs` is an
  upper bound (median 16 s, max 51 min in the recorded sessions above), so wait
  totals compare two runs only loosely.
- `promptVersion` covers the contract and the mode prompts. A change to the
  lane line, the rules line or a `modes.ts` rule table is invisible in it, so
  two runs that differ only there look identical.
- Idle cost is measured per poll (`npm run bench`), not per session: nothing
  records how long a session actually polled a mailbox no child ever used.
