# pi-keeper

**Keeps the flow, gates the calls.**

Autonomy modes and a project rulebook for pi: Claude Code / OpenCode-style
permission modes (`default`, `auto`, `plan`), with per-project rules and a
plan → execute handoff. Use `plan` to research and write a plan first,
`default` for everyday work where you approve changes, and `auto` for a
trusted task you are watching. Each mode decides which calls run, which ask
you, and which are blocked.

> **Status:** a personal project, maintained in my spare time and shared as is.
> pi-keeper reduces accidental damage by asking before risky actions. It is
> not a sandbox or a security boundary, and a determined model can get around
> it. Run untrusted work in a container or a VM.

## Install

```bash
pi install npm:pi-keeper    # every session; writes ~/.pi/agent/settings.json
```

`pi update --extensions` picks up new releases.

Two companion packages are optional — pi-keeper runs without them, and adds
what each one enables when it is loaded:

| Package | What it adds |
|---|---|
| [pi-subagents](https://www.npmjs.com/package/pi-subagents) | children that inherit your mode, and background asks that reach your dialog |
| [pi-shell-highlight](https://www.npmjs.com/package/pi-shell-highlight) | command names and heredoc languages colored in the permission dialog |

To try it from a checkout, or load it for one session, see
[Working from a checkout](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/development.md#working-from-a-checkout).

## What each mode allows

| Mode | Use it for | Runs without asking | Asks | Blocked |
|---|---|---|---|---|
| `default` (**● default**, blue) | everyday work: you approve changes | reads, searches, read-only bash, anything your rules cover, read-only MCP tools and [listed read-only tools](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#read-only-tools-from-other-packages) | edits, other bash, other tools | `sudo` & co |
| `auto` (**⏵⏵ auto**, yellow) | a trusted task you are watching | almost everything, deletes and overwrites inside the project included | dangerous commands, destructive commands outside the project, protected paths, writes outside the project, secrets, the first outside read | `sudo` & co |
| `plan` (**⏸ plan**, green) | researching and writing a plan | reads, read-only bash, the plan file, the scratch dir, read-only MCP tools and [listed read-only tools](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#read-only-tools-from-other-packages), session rules you granted | other bash (to gather context) | edits, other tools, dangerous commands, `sudo` & co |

Switch with **Alt+M** or **Ctrl+Shift+M** (the mode cycles `default → auto →
plan`), with `/mode`, or with `/plan [prompt|open]`. Ctrl+Shift+M works only in
terminals with the kitty keyboard protocol. The
[guide](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#modes-at-a-glance)
has the full action-by-action matrix.

## How you use it

- **Plan, approve, execute.** In plan mode the agent writes a plan file and
  calls `exit_plan_mode`. You then pick auto, or default with an approval for
  each edit. See [Plan mode](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#plan-mode).
- **Dialog choices.** A dialog offers *Yes* once, or a remembered answer.
  *Don't ask again this session* lasts until `/new`, `/resume`, a fork or exit.
  *Always allow … in this project* is saved to `.pi/settings.local.json`, and
  applies in default mode only. See
  [The dialogs](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#the-dialogs).
- **Project rules.** Allow, ask and deny rules live in
  `.pi/settings.local.json`, which stays out of git. `ask` and `deny` apply in
  every mode. `allow` rules load after you review the file once. See
  [Managing rules](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#managing-rules).
- **`/permissions` and `/rules`.** `/permissions` lists every rule with its
  source, and removes the ones you pick. `/rules` opens the rulebook, the rules
  that fire when the model slips. See
  [Managing rules](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#managing-rules) and
  [The rulebook](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#the-rulebook-rules-that-fire-only-when-the-model-slips).
- **`/keeper` settings.** One panel holds the settings for saving approvals,
  subagents and the dialog. `/keeper <setting> <value>` sets one directly. See
  [/keeper](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#keeper).
- **Subagents (optional).** With [pi-subagents](https://www.npmjs.com/package/pi-subagents)
  loaded, child agents run in your mode, and background children can ask you.
  This needs that package. See
  [Subagents](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#subagents-pi-subagents) and
  [Background subagents](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#background-subagents).

## Security and limitations

pi-keeper reduces what an agent can do without asking you. It does not
guarantee that a harmful command is caught.

- It decides from the command text and the tool arguments. A shell is too
  flexible for that to be complete.
- No mode is bulletproof. `auto` lets the most through. Prefer `plan` or
  `default`, and add the narrowest rule that does the job.
- Read each permission dialog before you approve it. Review the agent's
  changes before you commit, push or deploy them.
- For untrusted code or unattended runs, add isolation that does not depend on
  the agent: a container, a VM or a separate user account without your
  credentials.

You use pi-keeper at your own risk. It is provided "AS IS", without warranties
or conditions of any kind; see sections 7 and 8 of the
[LICENSE](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/LICENSE).

The full text is in the
[guide](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#security-and-limitations).

## Compatibility

Tested with pi 1.5.2 (`@earendil-works/pi-coding-agent`), pi-subagents 0.89.0
and pi-cc-extensions 1.0.20. pi-subagents and pi-cc-extensions are optional,
not dependencies. Without pi-subagents, pi-keeper works standalone, and the
subagent bridge does nothing.

pi-cc-extensions can hide the plan row. Until you list `exit_plan_mode` under
`excludeRenderers` in its settings, pi-keeper asks once per session at start.
Other notes, such as footer colors and Claude models behind a gateway, are in
the
[guide](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md#compatibility).

## Documentation

- [Guide](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/guide.md):
  every mode, dialog, rule and setting, in detail.
- [Design](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/design.md):
  the reasoning and threat model behind the rules.
- [Architecture](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/architecture.md):
  the module map, event flow, state, and where to change what.
- [Rulebook](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/rulebook.md):
  operator notes for rulebook rules: where they live and why they fire.
- [Development](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/docs/development.md):
  test suites, scripts, the type check and the repository layout.

## Acknowledgements

The permission modes, the plan flow and the per-project allow/ask/deny rule
format follow [Claude Code](https://claude.com/claude-code), and some built-in
command lists are modelled on its documented defaults.
The command arity table in `extensions/modes.ts` is adapted from
[OpenCode](https://github.com/anomalyco/opencode) under the MIT license (see the
[NOTICE](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/NOTICE)).
The rulebook's file shape and once-per-session firing are ideas from
[oh-my-pi](https://github.com/can1357/oh-my-pi); no code was taken from it. The
package runs on [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

## License

Apache-2.0. See the
[LICENSE](https://github.com/DanielBlei/pi-packages/blob/main/pi-keeper/LICENSE).
