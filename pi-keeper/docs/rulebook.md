# The rulebook: debugging

Everything about the reactive rules: where they live, what runs when, how to find
out why a rule did or did not fire.
[docs/architecture.md](architecture.md) has the module map and the model-facing
text catalogue; this file is the operator's view.

## What ships

| Piece | File | Job |
|---|---|---|
| The example rule and `/new-rule` | `ensureUserRuleDir` and `EXAMPLE_RULE` in `extensions/rulebook.ts` (from session start and `/rules`); `prompt-templates/new-rule.md` | one `example-rule.md` in the user folder, once (`.example-seeded` marker); the template has the model write a rule file and test its regex |
| Rules: parse, discover, match, render, records | `extensions/rulebook.ts` | pi-free, unit-tested; `parseRuleFile`, `loadRulebook`, `matchRules`, `correctionText`, `firedFromBranch` |
| The correction text | `prompts/rule-warning.md` (`RULE_WARNING`) | one header, `{{rules}}` slot |
| The fire path | `extensions/index.ts`, `pi.on("turn_end")` | one hidden `pi-keeper-rule` message + one `pi-keeper-rule-fired` entry per rule; `continue` only when the turn had no tool results, at most `RULES_PER_RUN_CAP` per run |
| The card | same file, `pi.registerEntryRenderer` | `⚠ rule fired: <name> — <description>`; TUI only |
| The view | `extensions/rules-view.ts` | `/rules` in theme colors, `Enter` for one rule; `rulesText` for no-TUI |
| Trust gate for project files | `project-rules.ts` (`trustedHash`, `recordTrust`) + `reviewRules` in `index.ts` | one review per changed file set |
| Tools | `scripts/rulebook-check.ts`, `scripts/rulebook-fires.ts` | intent check and corpus estimate |

Limits that are design, not bugs: a rule fires **once per session**; matching is
the assistant's **text blocks only** (no thinking, no tool arguments); only the
last `RULE_SCAN_CAP` (20 000) characters of an answer are scanned; `continue` is
skipped when the turn made tool calls; **subagent children are not policed**; the
card needs a TUI.

## Fire counts

`/rules` shows a lifetime count next to each rule, for example `12 fires · fired this session`, `12 fires` or `not fired yet`. A user rule shows its count across all projects. A project rule shows the count for this project only. The counts live in `<agent dir>/pi-keeper/rule-fires.json` (file mode 0600, keyed by the sha256 of the project root, written atomically by `extensions/rule-fires.ts`). A fire adds one; a resume, fork or branch switch adds nothing. A count that cannot be saved is skipped and never stops the fire.

## Debugging: it does not fire

Work down this list; each step is one command or one look.

| Check | How |
|---|---|
| Is the file found? | `/rules` — a discovered rule is listed; an undiscovered one is silent. Only `*.md` in `~/.pi/agent/pi-keeper/rules/` or `<repo>/.pi/rules/`. `example-rule.md` never fires. |
| Is it skipped, and why? | `/rules` shows `skipped · <reason>` (no frontmatter, no `description:` or `condition:`, a pattern that does not compile or matches ordinary text, an empty body). One warning is also notified at session start. |
| Is it a project file awaiting review? | `/rules` shows `needs review`. The review dialog appears on the next prompt; *Ignore for this session* leaves it out. Without a UI, project files are never loaded. |
| Does the pattern match the sentence at all? | `npm run rulebook-check` — put the sentence in `fires` in `scripts/rulebook-check.ts` and see it fail or pass against the installed file. |
| Right sentence, wrong place? | Only the **last 20 000 characters** of the answer are scanned, and only **text blocks** — a claim made in thinking, or in a tool's arguments, is invisible. |
| Right sentence, right place, no fire? | Was the turn `completed`? An aborted or errored turn fires nothing. An empty answer matches nothing. |
| Already fired earlier? | `/rules` says `fired this session` (with the lifetime count). A resume or fork keeps it fired: the records are read from the branch. |
| Is it a child session? | Rules apply to the **parent** only. A subagent's answer is not policed. |
| Is the file new, mid-session? | Rules are re-read every turn, so no reload is needed. But `firedRules` is per session, and the trust gate is per content hash. |

## Rule design: blast radius, not bookkeeping

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
npm run rulebook-fires -- --evidence
```

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
| The same header twice | `correctionText` renders ONE header and a block per rule. If it returns, `prompts/rule-warning.md` lost its `{{rules}}` slot. |
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

## Cheat sheet

In a session: `/rules` (colored view), `/rules <name>` (one rule, plain),
`/permissions` (a different thing: what may run).
