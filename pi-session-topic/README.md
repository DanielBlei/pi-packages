# pi-session-topic

Give every pi session a **one-line topic**, so `/resume` (and `pi -r`) shows a
readable name instead of the whole first prompt.

```
before   when I do /resume in pi I see full blow first prompt, can we have ...
after    Session topics in the resume picker
```

## Install

```bash
pi install npm:pi-session-topic    # every session; writes ~/.pi/agent/settings.json
```

`pi update --extensions` picks up new releases.

## Why it is needed

The session selector renders `session.name ?? firstMessage`
(`pi` source: `modes/interactive/components/session-selector.js`). A session has
a name only when something sets one — `/name`, `--name`, or
`pi.setSessionName()`. Long first prompts (pasted context, a big instruction
block) therefore fill the selector row and every session looks the same.

## What it does

1. On the **first prompt of an unnamed session**, before the run starts.
2. It asks a model for a 3–8 word title through a side-channel call
   (`ctx.modelRegistry.streamSimple()`).
3. It writes the title with `pi.setSessionName()`, which appends a
   `session_info` entry to the session file.

### The title call is separate from the conversation

`streamSimple()` is a plain provider request with the context this extension
builds: one system prompt, one user message, no tools. It appends **nothing** to
the session — no message entry, no usage record. So:

- the agent's own prompt prefix is byte-identical to what it would be without
  this extension, and **the conversation's prompt cache is neither invalidated
  nor missed**;
- the title request is too small to be worth caching, so it passes
  `cacheRetention: "none"`; its tokens are a normal one-off input cost;
- the agent loop is not blocked: the trigger handler returns synchronously and
  the request is detached, capped at 20 s.

A reasoning model asked at its default effort can spend the whole output budget
on thinking and never write the title, so the request uses the lowest reasoning
effort with a small thinking budget, and an empty reply retries once with a
larger budget.

### Rules the code enforces

- **A manual name always wins.** Nothing is generated when the session already
  has a name, and the name is re-read right before writing, so `/name` during an
  in-flight request is never overwritten.
- **A late reply cannot name the wrong session.** The session id is checked
  again at write time; a switch drops the result. pi's "ctx is stale" error after
  `/new`, `/resume`, `/fork` or `/reload` is treated as a drop, not a failure.
- **Failures are silent and bounded.** Network errors, timeouts, 429 and 5xx
  retry on your next message, up to 5 times per session. An empty title or a 4xx
  counts toward a limit of two attempts per session. `/topic` is not limited.
- **Titles are short by width, not length.** The budget counts terminal cells,
  so CJK titles are clipped correctly.

## Load a checkout

```bash
pi -e ./pi-session-topic            # one run, without touching settings
pi install "$PWD/pi-session-topic"  # every session, this checkout only
```

`pi install` resolves a relative path against the settings file's directory
(`~/.pi/agent`), not the shell's cwd, so pass an absolute path.

## Commands

| Command | What it does |
|---|---|
| `/topic` | Regenerate the title from the session's first user message (works on old sessions too) |
| `/topic <title>` | Set the title by hand |
| `/session-topic` | Show the settings and the file they came from |
| `/session-topic enabled on\|off` | Turn automatic naming on or off |
| `/session-topic model <provider/id>` | Use a specific model for the title request |
| `/session-topic model session` | Go back to the session's current model |
| `/session-topic maxCells <8-200>` | Title budget in terminal cells |
| `/session-topic debug on\|off` | Write request outcomes to stderr |
| `/session-topic reset` | Back to the defaults |

## Settings

Stored in `<agent dir>/pi-session-topic.json`, re-read on `session_start`, so a
change applies to the next session without a reload.

```json
{
  "enabled": true,
  "model": null,
  "maxCells": 48,
  "debug": false
}
```

`model: null` keeps the title request on the model and provider you already use,
so your prompt goes nowhere new. Set `provider/model-id` to a cheap, fast model
to keep the cost near zero.

Environment variables stay as one-off overrides and win over the file:

| Variable | Meaning |
|---|---|
| `PI_SESSION_TOPIC_OFF=1` | Disable automatic naming |
| `PI_SESSION_TOPIC_MODEL=provider/model-id` | Title model; a bare model id is matched against the catalogue |
| `PI_SESSION_TOPIC_MAX_CELLS=48` | Title budget in terminal cells |
| `PI_SESSION_TOPIC_DEBUG=1` | Write request outcomes to stderr |

## Limits

- One title request per session on success; an empty reply is retried once with a
  larger budget. Network errors, timeouts, 429 and 5xx retry on your next message,
  up to 5 times per session; an empty title or 4xx stops after 2 attempts (see Rules).
- The title comes from the first prompt; a session that changes topic keeps its
  first title. `/topic` regenerates it.
- `--print` runs can end before the title lands, and `--no-session` runs are not
  persisted, so neither reliably keeps a title.
- Any session that already has a name is skipped, whatever set the name, so
  subagent child sessions that another tool has named are not renamed.
- The title request's tokens are not in `/session` totals: pi records usage only
  for the agent loop, compaction and cache warming.

## Development

```bash
npm test --workspace pi-session-topic        # node --test, 25 cases
node ../node_modules/typescript/bin/tsc --noEmit
```

- `extensions/title.ts` — pure logic (cells, clipping, normalization) plus
  `generateAndApply()`, which takes injected dependencies so every guard is
  tested without a pi runtime or a provider.
- `extensions/config.ts` — the settings file: tolerant load, per-field
  validation, merge-and-save, environment overrides.
- `extensions/index.ts` — the pi wiring: events, commands, model call.
