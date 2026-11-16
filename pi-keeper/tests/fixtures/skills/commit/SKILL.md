---
name: commit
description: >
  Test fixture for the skill-command grant flow: it declares the same
  `allowed-tools` shape a real skill does, so the test reads a file inside this
  package instead of another repository.
allowed-tools: Bash(git status:*) Bash(git diff:*) Bash(git add:*) Bash(git commit:*) Bash(git log:*) ask_user_question
---

# Commit (test fixture)

The body is irrelevant: a `/skill:<name>` grant comes from the `allowed-tools`
frontmatter only. Keep this file's frontmatter in step with what the test
asserts in `tests/integration/flows.test.ts` (flow 7b).
