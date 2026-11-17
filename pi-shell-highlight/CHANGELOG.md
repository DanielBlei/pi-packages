# Changelog

## 0.1.0 - 2026-11-16

First public release.

- Publishes a command highlighter for the process under
  `Symbol.for("pi.shell-highlight.v1")`; other packages load it with
  `import { HIGHLIGHTER_KEY } from "pi-shell-highlight/highlight.ts"`.
- Colors the word in command position (start of line, after `|`, `&&`, `;`, and
  after a precommand such as `sudo`, `env`, `rtk`), options, and a heredoc body
  by its language.
- `<<<` here-strings are not read as heredocs, so the lines after them are
  shell.
- Prose that begins with Select or Update is not coloured as SQL unless it has
  a SQL shape, such as a `from` clause.
