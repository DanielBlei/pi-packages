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
npm run bench            # cost of a load, one tool call and one idle mailbox poll (docs/design.md, section 13)
npm run prompt-weight    # tokens this package injects per mode, and the rulebook warning (caps in tests/unit/prompt-weight.test.ts)
npm run rulebook-check   # does each installed rule fire where it should, and stay quiet where it must
npm run rulebook-fires   # how often each rule would have fired over past sessions (--evidence: was it backed?)
```

`rulebook-check` reads your installed rulebook (`~/.pi/agent/pi-keeper/rules`, or `--dir`),
runs every rule through the same matcher pi uses, and compares the result with a sample table in
`scripts/rulebook-check.ts`: sentences the rule must fire on, and legitimate ones it must leave
alone. Add a sample before you widen a pattern; a sample that cannot be satisfied means the rule
wants a judge, not a regex.

`npm run bench` prints numbers and fails on nothing; `tests/unit/perf.test.ts`
holds the same counts as budgets, so a regression breaks `npm test`.

From the repo root, `make check` runs the type check and the tests for every
package. In pi-keeper, `npm run check:charts` validates the Mermaid charts in
`docs/` with Mermaid's own parser (run `make` at the repository root to list every target).

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
and denies. What is still open is in
[challenges.md](challenges.md); the rulebook's operator notes — where a rule lives,
why it fired or did not — in [rulebook.md](rulebook.md).

## Replaying a session

`scripts/replay.ts` re-decides every recorded bash command of a session (and of its direct
subagent children) with the decision code of a given tree, so a change to the rules can be
measured on real work. It is dev-only and reads private sessions, so its output stays out of
the repository: `--out` inside a git repository is refused, and the default is
`$TMPDIR/pi-keeper-replay-<timestamp>/`. Rows hold keys, modes and rule names, never commands.

```bash
# one process per tree; <tree> is a package dir (the working tree, or an export of extensions/, prompts/, package.json)
git -C .. archive <ref> pi-keeper/extensions pi-keeper/prompts pi-keeper/package.json | tar -x -C /tmp/baseline
npm run replay -- run --session <parent.jsonl> --code /tmp/baseline/pi-keeper --out /tmp/old.jsonl
npm run replay -- run --session <parent.jsonl> --code . --out /tmp/new.jsonl
npm run replay -- compare /tmp/old.jsonl /tmp/new.jsonl [--fixture tests/fixtures/decisions.ts]
```

`compare` prints each row (`key | origin | old -> new | old reason`), the totals (recorded
dialogs, old dialogs recomputed with each disagreement listed, new dialogs), the flips grouped
by old reason, the rows that became allow, and then runs the `guard: true` fixture entries on
both trees in every mode. It exits 1 on any new allow. It warns when the two runs have
different environment fingerprints (node, platform, tmpdir, env names, project rules).

What the replay cannot know: session grants are not in the log, so every row is decided with
none (the self-check shows where that differs from what happened). A second, labelled count
adds the prefix grants parsed from recorded choices. A background ask is paired with the
child call whose command, redacted and shortened like the log's `target`, equals the
recorded target; ambiguous or missing pairs are listed and left out of the counts. The scratch
dir comes from the session's `Scratch dir:` message, or from the single
`<tmpdir>/pi-keeper-XXXXXX` prefix in its commands.

## Layout

The module map, event flow, state inventory and "how to change X" cheat sheet
are in [architecture.md](architecture.md); the reasoning and threat
model are in [design.md](design.md); the open challenges
are in [challenges.md](challenges.md).

Directories: `extensions/` (wiring, tables, rules, UI, subagent glue), `prompts/`, `docs/`, `tests/` (`unit/`, `integration/`, `mocks/`) and `scripts/`.
Docs in `docs/`: guide.md, development.md, architecture.md, design.md, challenges.md, rulebook.md and smoke-background-asks.md.
