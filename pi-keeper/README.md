# pi-keeper

Permission modes and a project rulebook for pi: `default`, `auto` and `plan`, per-project rules, and a plan → execute handoff. Each mode decides which tool calls run, which ask you, and which are blocked.

> A personal project, shared as is. pi-keeper reduces accidental damage by asking before risky actions. It is not a sandbox or a security boundary. Run untrusted work in a container or a VM.

## Install

```bash
pi install npm:pi-keeper    # every session; writes ~/.pi/agent/settings.json
```

`pi update --extensions` picks up new releases. From a checkout, see [Working from a checkout](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/development.md#working-from-a-checkout).

## Modes

| Mode | Use it for | Runs without asking | Asks | Blocked |
|---|---|---|---|---|
| `default` (blue) | everyday work: you approve changes | reads, searches, read-only bash, anything your rules cover, read-only tools | edits, other bash, other tools | `sudo` & co |
| `auto` (yellow) | a trusted task you are watching | almost everything, including deletes inside the project | dangerous or destructive commands, protected paths, writes outside the project, secrets, the first outside read | `sudo` & co |
| `plan` (green) | researching and writing a plan | reads, read-only bash, the plan file, the scratch dir | other bash | edits, other tools, dangerous commands, `sudo` & co |

In plan mode the agent writes a plan file and calls `exit_plan_mode`; you then pick `auto`, or `default` with approval for each edit. The [guide](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#modes-at-a-glance) has the full action-by-action matrix.

## Commands

| Command | What it does |
|---|---|
| **Alt+M**, **Ctrl+Shift+M** | Cycle `default → auto → plan` (Ctrl+Shift+M needs the kitty keyboard protocol) |
| `/mode` | Pick a mode |
| `/plan [prompt\|open]` | Start plan mode, or open the plan |
| `/permissions` | List every rule with its source; remove the ones you pick |
| `/approvals` | Open the permission asks that background subagents are waiting on |
| `/rules` | Open the rulebook: rules that fire when the model slips |
| `/keeper [setting value]` | Settings panel, or set one directly |

Dialogs offer *Yes* once, *Don't ask again this session*, or *Always allow … in this project*, which is saved to `.pi/settings.local.json` (default mode only). `ask` and `deny` rules apply in every mode; `allow` rules load after you review the file once. Details: [Managing rules](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#managing-rules), [The dialogs](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#the-dialogs), [/keeper](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#keeper).

## Optional companions

| Package | What it adds |
|---|---|
| [pi-subagents](https://www.npmjs.com/package/pi-subagents) | children run in your mode, and background asks reach your dialog ([Subagents](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#subagents-pi-subagents)) |
| [pi-shell-highlight](https://www.npmjs.com/package/pi-shell-highlight) | colored command names and heredocs in the permission dialog |

Without them pi-keeper works standalone.

## Security and limitations

pi-keeper decides from the command text and tool arguments. A shell is too flexible for that to be complete, so it does not guarantee a harmful command is caught.

- No mode is bulletproof; `auto` lets the most through. Prefer `plan` or `default` and add the narrowest rule that works.
- Read each dialog before you approve it, and review changes before you commit, push or deploy.
- For untrusted code or unattended runs, isolate with a container, a VM or a separate user without your credentials.

Use at your own risk. Provided "AS IS", without warranties; see sections 7 and 8 of the [LICENSE](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/LICENSE). Full text: [guide](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#security-and-limitations).

## Compatibility

Tested with pi 1.5.2, pi-subagents 0.89.0 and pi-cc-extensions 1.0.20. pi-cc-extensions can hide the plan row: list `exit_plan_mode` under `excludeRenderers` in its settings, or pi-keeper asks once per session. More in the [guide](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#compatibility).

## More

[Guide](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md) (every mode, dialog, rule and setting) · [Design](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/design.md) (reasoning and threat model) · [Architecture](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/architecture.md) · [Rulebook](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/rulebook.md) · [Development](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/development.md)

## Acknowledgements

Rule spellings such as `Bash(git add:*)` and `WebFetch(domain:<host>)` are read for compatibility with the settings format [Claude Code](https://claude.com/claude-code) documents. The modes, the plan flow and everything else are written from scratch; nothing here comes from Claude Code's code or prompts. The command arity table in `extensions/modes.ts` is adapted from [OpenCode](https://github.com/anomalyco/opencode) (MIT, see [NOTICE](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/NOTICE)). The rulebook's file shape is an idea from [oh-my-pi](https://github.com/can1357/oh-my-pi); no code was taken. Built on [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Not affiliated with or endorsed by Anthropic, OpenCode, oh-my-pi or the pi project; their names are used only to say what this works with or credits.

## License

Apache-2.0, see [LICENSE](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/LICENSE) and [NOTICE](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/NOTICE).
