# Smoke test: background subagent asks

Manual checks in a real pi, for what the mocks cannot show: the dialog, the
bell, the badge and the timing. Run them after a change to the ask mailbox,
the ask server or the popup policy. Each step says what you should see.

## Setup

1. Install pi-subagents. In a scratch git repo run
   `pi -e <path>/pi-keeper` (add `-e <pi-subagents>` if it is not
   already loaded). Start in `default` mode.
2. `/keeper`: *Background subagents can ask you* is **on**. If not,
   switch it on. Set *When background asks pop up* to `idle`: the default
   `always` opens the dialog at once, and the checks below assume `idle`.
3. Ask the agent to launch a subagent with the `subagent` tool's `async: true`
   parameter (run it in the background), using an agent that has bash, such
   as `worker`, for a task that needs a gated call: "Launch the `worker`
   agent in the background to run `touch x` in this directory and report
   back." A fresh session may first expose only the `subagents_enable`
   loader; have the agent call it, then launch. Keep the editor empty and the
   session idle.

## Checks

1. **Dialog and bell.** The terminal rings and a dialog opens titled
   `Background subagent <name>:` and showing `touch x`. If the title is
   missing or the bell is silent, stop here.
2. **Approve.** Choose *Yes*. The worker's `touch x` runs (`ls x` exists) and
   the worker finishes its report.
3. **Esc.** Repeat with `touch y`. Press Esc. The worker is told you declined,
   continues without the call, mentions it in its report, and `y` does not
   exist. Your own session is not stopped.
4. **Don't ask again.** Repeat with `touch z`, choose the option that allows
   the command for this session. Then launch a second worker running the same
   `touch z`: it runs with no dialog.
5. **Badge and `/approvals`.** Launch a worker that needs approval, then start
   typing in the editor before it asks. No dialog appears; the footer shows
   `1 background approval waiting · /approvals`. Run `/approvals`: the dialog
   opens. Clear the editor and wait instead: it opens at the next idle point.
6. **Parent gone, fast deny.** Launch a worker, let it ask, and leave the
   dialog open. Quit the parent with `/quit` or Ctrl-C twice (or run `/new`). The dialog
   closes, and the worker's call is denied within a few seconds with the reason
   that the parent session ended, not after the 5 minute timeout.
7. **Kill switch.** Start pi with `PI_KEEPER_BACKGROUND_ASKS=0` (or switch
   the setting off in `/keeper`) and launch the same worker. No dialog
   opens; the worker's `touch` is denied at once and it says so in its report.
8. **Mode follows the parent.** Enable *Subagents follow auto mode* in
   `/keeper`, switch the parent to `auto` (Alt+M) and launch a background
   worker that edits a file inside the project. It runs the edit with no
   dialog (auto). Have it also run `git push` or read `.env`: that one opens
   the dialog.
9. **curl now asks (fetch regression check).** In default mode have the agent (or a worker) run
   `curl -s https://api.github.com/zen`. A dialog asks about the host
   `api.github.com`; no host is allowed by default. *Yes, and allow fetching
   from `api.github.com` this session* makes the next identical call run
   silently.

## If something fails

`python3 scripts/extract_flow.py --latest` rebuilds the flow of the newest
session: look for the `remote-auto-allow`, `remote-auto-deny`,
`parent-gone` and `parent-ask` outcomes. Pending asks live under
`<agent dir>/pi-keeper/asks/<hash of the session id>/`; a missing
`alive` file there means the parent is not listening.
