# pi-keeper development

Contributor notes: the test suites, the scripts, the type check and the repository layout. The user guide is [guide.md](guide.md).

## Working from a checkout

Load the extension from a checkout of this repository:

```bash
# Try once without touching settings:
pi -e ./pi-keeper

# Load it for a session from anywhere with an absolute path:
pi -e /path/to/pi-packages/pi-keeper

# Or install it for all projects:
pi install /path/to/pi-packages/pi-keeper
```

## Development

```bash
npm test                 # every suite under tests/
npm run test:unit        # tests/unit: command analysis, per-mode rules, project rules, dialogs, plan approval, read and fetch grants
npm run test:integration # tests/integration: user flows against a mock pi (no pi process)
npm run typecheck        # needs the pi peer packages: from the repo root, make install, then make check
npm run bench            # cost of a load, one tool call and one idle mailbox poll (docs/design.md, section 14)
npm run prompt-weight    # tokens this package injects per mode, and the rulebook warning (caps in tests/unit/prompt-weight.test.ts)
npm run rulebook-check   # does each installed rule fire where it should, and stay quiet where it must
npm run rulebook-fires   # how often each rule would have fired over past sessions (--evidence: was it backed?)
```

`rulebook-check` reads your installed rulebook (`~/.pi/agent/pi-keeper/rules`, or `--dir`),
runs every rule through the same matcher pi uses, and compares the result with a sample table in
`scripts/rulebook-check.ts`: sentences the rule must fire on, and legitimate ones it must leave
alone. Add a sample before you widen a pattern; a sample that cannot be satisfied means the rule
wants a judge, not a regex. It never runs in `make check`, because the rules are yours, not the repo's.

`npm run bench` prints numbers and fails on nothing; `tests/unit/perf.test.ts`
holds the same counts as budgets, so a regression breaks `npm test`.

From the repo root, `make check` runs the type check and the tests for every
package. In pi-keeper, `npm run check:charts` validates the Mermaid charts in
`docs/` with Mermaid's own parser (see the repository's root README for all targets).

pi host packages and `typebox` are `peerDependencies` only; bundling them
creates duplicate registries. There is no build step: pi loads TS via `jiti`,
and `tsconfig.json` is for type checking only. The scripts pass explicit
globs, so helpers in `tests/mocks/` never run as tests.
`tests/integration/intent.test.ts` is the intent shield: one `describe` per
user-facing promise, asserting only what the user sees; it changes only when
the intent changes.

Every permission decision and dialog answer is appended to the session log
as a `pi-keeper-permission` entry (never sent to the model). The scripts read
sessions written by this version. Read the flow back with the readers in the
repository's [`scripts/`](../scripts/)
directory (they are not in the npm package; run them from a checkout):

```bash
python3 scripts/extract_flow.py --latest     # newest session
python3 scripts/extract_flow.py <session.jsonl> [--json] [-v]
python3 scripts/extract_flow.py --stats ~/.pi/agent/sessions   # one aggregate per model
python3 scripts/extract_flow.py --failures <session.jsonl> [--json] [-v]
                                               # tool-calling failure scorecard: the session
                                               # AND its subagent children
python3 scripts/aggregate_failures.py ~/.pi/agent/sessions      # failures across ALL conversations
python3 scripts/aggregate_failures.py --latest 20               # …or the 20 newest
```

`--stats` aggregates per model: asks by matcher, approval rate, plan outcomes
and denies. The baseline and what is still open are in
[challenges.md](challenges.md); the rulebook's operator notes — where a rule lives,
why it fired or did not, and what comes next — in [rulebook.md](rulebook.md).

`--failures` scores one conversation on tool calling: error rate, error kinds
(permission / timeout / aborted / not-found / validation / other), errors by
tool and by pi-keeper mode, retry chains after errors (same tool again
within 180 s), and aborted calls (no result). Subagent children are included:
foreground children are read from their pi session files under the parent's
sibling directory (`<parent>.jsonl` → `<parent>/<runId>/run-N/session.jsonl`,
linked to their `subagent-artifacts/*_meta.json` by the child session's
`subagent-<agent>-<runId>-<index>` display name), async children from their
`subagent-artifacts` transcript when no session file exists. A child's fixed
mode is read from its own permission telemetry. `--failures --json` emits one
NDJSON record per unit (main/child aggregates) and one per errored call, so a
future aggregator can combine many sessions.

`scripts/aggregate_failures.py` is that aggregator: it loads every conversation
under a directory (or `--latest N`) with its children and prints one cross-session
scorecard — error rates by week, model, unit (main vs child), agent, mode and
tool; retry recovery; the paths headless children keep being denied on; child
exit codes; and the worst units. `--json` prints the same aggregate as one JSON
object. Subagent transcripts and nested child sessions are excluded from
discovery (children are reached through their parent), and `extract_flow.py
--latest` now skips them too.

## Layout

The module map, event flow, state inventory and "how to change X" cheat sheet
are in [architecture.md](architecture.md); the reasoning and threat
model are in [design.md](design.md); the open challenges and reference figures
are in [challenges.md](challenges.md).

```
pi-keeper/
├── extensions/   # index.ts (wiring), modes.ts (tables), rules.ts, utils.ts, project-rules.ts, dialog/plan UI, subagent glue
├── prompts/      # per-mode prompts, child prompts (read directly, none are commands)
├── docs/         # guide.md, development.md, architecture.md, design.md, challenges.md, rulebook.md
├── tests/        # unit/, integration/ (intent.test.ts), mocks/
└── scripts/      # extract_flow.py, exclude_exit_plan_mode.py, charts/ (docs chart checks)
```

`child-plan.ts`, `child-default.ts` and `child-auto.ts` are not listed in
`package.json`; only
pi-subagents loads them.
