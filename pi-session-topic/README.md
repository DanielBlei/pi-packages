# pi-session-topic

Gives every pi session a **one-line topic**, so `/resume` (and `pi -r`) shows a readable name instead of the whole first prompt.

```
before   when I run /resume in pi I see the whole first prompt, can we show ...
after    Session topics in the resume picker
```

## Install

```bash
pi install npm:pi-session-topic    # every session; writes ~/.pi/agent/settings.json
```

`pi update --extensions` picks up new releases. From a checkout: `pi -e ./pi-session-topic` (one run) or `pi install "$PWD/pi-session-topic"` (absolute path; pi resolves relative paths against `~/.pi/agent`).

## How it works

On the first prompt of an unnamed session, it asks a model for a 3–8 word title and writes it with `pi.setSessionName()`.

- The title call is a separate side-channel request. It adds nothing to the session, so the conversation's prompt cache is untouched, and it never blocks the agent loop (capped at 20 s).
- A name you set (`/name`, `--name`, `/topic <title>`) always wins, and a late reply never names the wrong session.
- Failures are silent: network errors, timeouts, 429 and 5xx retry on your next message (up to 5 per session); an empty title or a 4xx stops after 2 attempts. `/topic` is not limited.
- Titles are clipped by terminal cell width, so CJK text fits.

## Commands

| Command | What it does |
|---|---|
| `/topic` | Regenerate the title from the first user message (works on old sessions) |
| `/topic <title>` | Set the title by hand |
| `/session-topic` | Show the settings and the file they came from |
| `/session-topic enabled on\|off` | Turn automatic naming on or off |
| `/session-topic model <provider/id>` | Use a specific model for the title request |
| `/session-topic model session` | Go back to the session's current model |
| `/session-topic maxCells <8-200>` | Title budget in terminal cells |
| `/session-topic debug on\|off` | Write request outcomes to stderr |
| `/session-topic reset` | Back to the defaults |

## Settings

`<agent dir>/pi-session-topic.json`, re-read on `session_start`:

```json
{ "enabled": true, "model": null, "maxCells": 48, "debug": false }
```

`model: null` uses your current model and provider, so your prompt goes nowhere new. Set `provider/model-id` to a cheap, fast model to keep the cost near zero.

Environment variables win over the file:

| Variable | Meaning |
|---|---|
| `PI_SESSION_TOPIC_OFF=1` | Disable automatic naming |
| `PI_SESSION_TOPIC_MODEL=provider/model-id` | Title model (a bare id is matched against the catalogue) |
| `PI_SESSION_TOPIC_MAX_CELLS=48` | Title budget in terminal cells |
| `PI_SESSION_TOPIC_DEBUG=1` | Write request outcomes to stderr |

## Limits

- The title comes from the first prompt; a session that changes topic keeps it until you run `/topic`.
- `--print` runs can end before the title lands, and `--no-session` runs are not persisted.
- Any session that already has a name is skipped, so subagent sessions named by another tool are not renamed.
- The title request's tokens are not in `/session` totals.

## License

Apache-2.0, see [LICENSE](https://github.com/DanielBlei/pi-packages/blob/main/pi-session-topic/LICENSE) and [NOTICE](https://github.com/DanielBlei/pi-packages/blob/main/pi-session-topic/NOTICE).
