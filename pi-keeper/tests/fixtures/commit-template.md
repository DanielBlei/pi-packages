---
description: Commit the current changes (git add/commit run without asking)
argument-hint: "[message hint]"
allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status) Bash(git diff *)
---
Commit the current changes.

1. Run `git status` and `git diff` to see what changed.
2. Stage only the files that belong in this commit with `git add <files>`.
3. Commit with a short imperative message that says why, not just what. Hint from the user: ${@:-none}.

Do not push, amend, or rewrite history.
