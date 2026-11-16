# The rulebook: follow-up and debugging

Everything about the reactive rules: where they live, what runs when, how to find
out why a rule did or did not fire, and what is deliberately not built yet.
[docs/architecture.md](architecture.md) has the module map and the model-facing
text catalogue; this file is the operator's view.

## What ships (v1)

| Piece | File | Job |
|---|---|---|
| Rules: parse, discover, match, render, records | `extensions/rulebook.ts` | pi-free, unit-tested; `parseRuleFile`, `loadRulebook`, `matchRules`, `correctionText`, `firedFromBranch` |
| The correction text | `prompts/rule-warning.md` (`RULE_WARNING`) | one header, `{{rules}}` slot |
| The fire path | `extensions/index.ts`, `pi.on("turn_end")` | one hidden `pi-keeper-rule` message + one `pi-keeper-rule-fired` entry per rule; `continue` only when the turn had no tool results, at most `RULES_PER_RUN_CAP` per run |
| The card | same file, `pi.registerEntryRenderer` | `⚠ rule fired: <name> — <description>`; TUI only |
| The view | `extensions/rules-view.ts` | `/rules` in theme colours, `Enter` for one rule; `rulesText` for no-TUI |
| Trust gate for project files | `project-rules.ts` (`trustedHash`, `recordTrust`) + `reviewRules` in `index.ts` | one review per changed file set |
| Tools | `scripts/rulebook-check.ts`, `scripts/rulebook-fires.ts` | intent check and corpus estimate |

Limits that are design, not bugs: a rule fires **once per session**; matching is
the assistant's **text blocks only** (no thinking, no tool arguments); only the
last `RULE_SCAN_CAP` (20 000) characters of an answer are scanned; `continue` is
skipped when the turn made tool calls; **subagent children are not policed**; the
card needs a TUI.

## The lifecycle, once more

```
turn ends (outcome=completed)
  → text = the assistant's text blocks, joined
  → syncRulebook: user dir, then project dir (project files: trusted hash only)
  → matchRules: skip already-fired, test the tail of the text
  → fired? then in ONE turn_end return:
        custom_message pi-keeper-rule   (display:false, details.rules)
        custom        pi-keeper-rule-fired per rule (card + session record)
        continue: true                     (if no tool results, and under the cap)
  → the model reads the correction on its next request and answers
```

## Debugging: it does not fire

Work down this list; each step is one command or one look.

| Check | How |
|---|---|
| Is the file found? | `/rules` — a discovered rule is listed; an undiscovered one is silent. Only `*.md` in `~/.pi/agent/pi-keeper/rules/` or `<repo>/.pi/rules/`. |
| Is it skipped, and why? | `/rules` shows `skipped · <reason>` (no `description:`, no `condition:`, a pattern that does not compile, an empty body). One warning is also notified at session start. |
| Is it a project file awaiting review? | `/rules` shows `needs review`. The review dialog appears on the next prompt; *Ignore for this session* leaves it out. Without a UI, project files are never loaded. |
| Does the pattern match the sentence at all? | `npm run rulebook-check` — put the sentence in `fires` in `scripts/rulebook-check.ts` and see it fail or pass against the installed file. |
| Right sentence, wrong place? | Only the **last 20 000 characters** of the answer are scanned, and only **text blocks** — a claim made in thinking, or in a tool's arguments, is invisible. |
| Right sentence, right place, no fire? | Was the turn `completed`? An aborted or errored turn fires nothing. An empty answer matches nothing. |
| Already fired earlier? | `/rules` says `1 fire` for the session. A resume or fork keeps it fired: the records are read from the branch. |
| Is it a child session? | Rules apply to the **parent** only. A subagent's answer is not policed. |
| Is the file new, mid-session? | Rules are re-read every turn, so no reload is needed. But `firedRules` is per session, and the trust gate is per content hash. |

## Rule design: blast radius, not bookkeeping

The first version of `claims-need-evidence` fired on any "tests pass" phrasing. On
the recorded corpus (one machine's sample) that was wrong in both directions:
it nudged the model into a
full test run after trivial edits ("created two files"), and it matched prose
*about* the words ("Item 5's whole approach did not work", "every caplog assertion
passed alone and failed in the full suite").

The rule that survived asks a narrower question — **does this claim cover things
the change could break?** — and answers it with two changes:

1. **Tie the quantity to a verification noun.** `\b(all|every|everything|full|whole)\b`
   followed within a clause by `tests?|suite|checks?|build|ci|lint|typecheck` and
   then a pass word. "All 26 tests pass", "the full suite is green",
   "all checks pass" fire; "all seven stages passed" (a run report) and "every
   caplog assertion passed" (a bug description) do not.
2. **Exclude the negations and the prose.** `(?<!not )(?<!never )` before the
   sweep, and separate alternatives for the three claims that have no noun
   ("everything works", "all good", "no regressions"), plus `works? end.to.end`
   and `nothing else changed`.

The body carries the other half of the intent, because the pattern cannot see the
size of a change: *a small change needs no proof and no test run; a change with
blast radius — shared config, dependency, cross-file rename, schema, build or test
tooling, public API — gets the command and its output next to the claim.* Without
that sentence the model runs `npm test` after renaming a variable.

Measure both halves before you trust a rule:

```bash
npm run rulebook-check                       # the samples say what the intent is
npm run rulebook-fires -- --evidence         # 39/342 sessions, 18% already backed (one machine's sample)
```

This rule took three iterations, each one driven by a sample the previous version
got wrong. That loop — add the real false positive to `quiet`, watch it fail,
narrow the pattern, re-measure — is the whole method.

## Debugging: it fires when it should not

1. Add the legitimate sentence to `quiet` in `scripts/rulebook-check.ts`, run
   `npm run rulebook-check`, and watch it fail — that failure is the bug, in a
   form you can iterate on in seconds.
2. Narrow with the usual three tools: `\b` at both ends; a required object
   (`committed (the|my|all) …`) instead of a bare verb; a lookahead to exclude the
   innocent phrasing (`(?![^.\n]{0,40}\bas you asked)`), or a lookbehind for
   negations (`(?<!\bnothing is )`).
3. Prefer a *narrower* pattern with a forgiven body ("if you did run them, quote
   the line") over a wide pattern with a stern body: the cost of a wrong fire is
   one request and one card, not a broken run.
4. Measure before and after: `npm run rulebook-fires -- --evidence` gives the
   corpus-wide fire count per rule and how many of those turns already showed
   evidence.

## Debugging: the correction itself

| Symptom | Cause and fix |
|---|---|
| The same header twice | Fixed in v1.1: `correctionText` renders ONE header and a block per rule. If it returns, `prompts/rule-warning.md` lost its `{{rules}}` slot. |
| A rule's body cut off | `RULE_BODY_CAP` (1 200 chars) per body, `RULE_TEXT_CAP` (4 000) for the whole message; over the whole cap the tail points at `/rules <name>`, which always has the full body. |
| The model apologises and does nothing | The body is a scolding, not a fix. Rewrite it as the action: "run `npm test` and quote the line". |
| The card is missing | The card is an entry renderer: TUI only. `pi -p` leaves only the session entries. |

## Where a fire is recorded

Two session entries per fire, both greppable:

```bash
# the hidden correction the model received (display:false)
grep -h '"customType":"pi-keeper-rule"' ~/.pi/agent/sessions/*/*.jsonl | tail -1

# the record and the card: rule name, source, description, time
grep -h '"customType":"pi-keeper-rule-fired"' ~/.pi/agent/sessions/*/*.jsonl | tail -5
```

`/rules` reads the same entries (`firedFromBranch`), so what the view shows and
what the session holds cannot disagree. Permission telemetry
(`pi-keeper-permission`, `python3 scripts/extract_flow.py`) is a different
entry type and is not affected by the rulebook.

## Follow-up, in the order I would do it

1. **Evidence checks (tier 2, highest value).** A `requires:` field, e.g.
   `requires: tool:bash=npm test|pytest|make test`, satisfied only if a matching tool call
   *succeeded* in the same turn (or the last N turns). This turns "claimed tests
   without running them" from a wording match into a fact check: no false positive
   when the model did run them, no miss when it paraphrases. Small and pure: one
   field, one matcher in `rulebook.ts`, the tool results already in the `turn_end`
   payload (`event.toolResults`), one test per branch. Effort: a day.
2. **Fire telemetry.** Append the fire to `pi-keeper-permission`-style
   telemetry (`telemetry.ts`) so `extract_flow.py --stats` can report fires per
   model and per rule next to approval rates. Effort: an hour.
3. **Repeat policy.** Today: once per session. If a habit needs a second
   reminder, `repeat: gap` (re-eligible after N turns, as oh-my-pi does) is the
   next step, with the gap counted at `turn_end`.
4. **Judged rules (`question:`).** Only for what a regex cannot see ("does this
   reply oversell certainty?"). Shape it like the reference: opt-in per rule,
   a `condition` as required prefilter, ONE batched judge request per turn for
   every candidate question, a probability threshold, a session cap, and fail
   open — a failed judgment never fires. Anything less is a surprise generator.
5. **Children.** The same handler behind the `childMode` guard, with a rule
   field for which lanes it applies to (`agents: main|scout|*`), once the parent
   path has a month of quiet.
6. **A disable toggle.** `/rules` could flip a rule off for the session (an
   in-memory set next to `firedRules`) without editing the file. Cheap, but only
   worth it if a rule is kept despite misfiring.

Not planned: matching tool arguments or thinking, AST conditions, globs, rule
discovery from `.cursor`/`.windsurf`/`.cline`/`.github`, goal or loop modes, any
change to the prompt prefix.

## Cheat sheet

```bash
npm run rulebook-check                    # do the installed rules fire/keep quiet as intended
npm run rulebook-fires -- --evidence      # how often each rule would have fired over past sessions
npm run prompt-weight                     # what the injected text costs per mode
npm test --workspace pi-keeper      # unit + integration (rulebook has both)
make check                                # everything offline, from the repo root
```

In a session: `/rules` (coloured view), `/rules <name>` (one rule, plain),
`/permissions` (a different thing: what may run).
