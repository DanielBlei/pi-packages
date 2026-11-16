# pi-shell-highlight

A pi extension that publishes a **command highlighter** for the process. It renders nothing and
owns no tools: another package that draws a shell command asks for it through a process-global
registry.

It exists because pi's own highlighter is a grammar. A grammar colors keywords, strings,
variables, numbers and comments. It cannot know that `git`, `tar` or `rm` are commands, so those
stay plain, and it paints a heredoc body as one string. This package adds what a grammar cannot
know:

- the word in **command position** is colored — start of line, after `|`, `&&`, `;`, `(`, `{`,
  and after a prefix such as `sudo`, `doas`, `env`, `xargs`, `nohup`, `time`, `command`, `exec`,
  `nice`, `ionice`, `stdbuf`, `builtin`, `unbuffer`, `watch` or `rtk` (with its options skipped,
  so `rtk git status` colors both `rtk` and `git`);
- a command line reads in **three weights**, as in zsh-syntax-highlighting: a **precommand**
  modifier (`sudo`, `env`, `rtk` — it only says *how* the command runs) recedes, the
  **command** stands out, and a **runner** that names a language or a task (`python`, `node`,
  `go`, `cargo`, `npm`, `uv`, `make`, …) reads apart from a plain tool such as `grep`;
- an **option** (`-n`, `-rf`, `--json`) gets its own color; `-` and `--` alone do not (they are
  a stdin/stdout argument and the end-of-options marker);
- a **heredoc body** is highlighted with the language its delimiter or its opening command
  names, else with the language the body itself looks like (a shebang, an `import`, a
  `select`), else as shell — and a shell body has its **command names** colored too, so
  `cat <<'EOF'` with `go build` inside reads like the rest. In `python`, `ruby` and `perl`
  bodies it also colors an **assignment target** (`rows = […]`, `total: int = len(x)`),
  which those grammars leave plain.

## Install

```bash
pi install npm:pi-shell-highlight    # every session; writes ~/.pi/agent/settings.json
```

`pi update --extensions` picks up new releases. On its own this package draws nothing: it is
loaded by a package that paints shell commands — [pi-keeper](https://www.npmjs.com/package/pi-keeper)
is one — so install both, then set `/keeper` → `previewTextColor` to `shell-highlight`.

Working in a checkout instead:

```bash
pi -e ./pi-shell-highlight    # one run, without touching settings
pi install "$PWD/pi-shell-highlight"    # every session, this checkout only
```

## The contract

```ts
import { HIGHLIGHTER_KEY, type CommandHighlighter, type CommandStyle } from "pi-shell-highlight/highlight.ts";

const highlighter = (globalThis as Record<symbol, unknown>)[HIGHLIGHTER_KEY] as CommandHighlighter | undefined;
const lines = highlighter?.highlightCommand(command, "bash", style);
```

- The key is `Symbol.for("pi.shell-highlight.v1")`. The `v1` is the contract version: bump it when
  the signature changes. The optional slots below were added without a bump: a consumer that
  does not pass them gets the earlier look, so an older `pi-keeper` keeps working.
- `highlightCommand(text, lang, style)` returns **one string per input line, in the same order**,
  with ANSI color codes. It never changes the visible characters.
- `style.command(text)` wraps a command name, `style.plain(text)` a line that gets no language,
  `style.variable(text)` an assignment target (optional — without it assignments keep the
  grammar's color), `style.runner(text)` a language or task runner, `style.precommand(text)` a
  modifier such as `sudo` or `rtk`, `style.option(text)` an option. Each must return a
  self-contained span (open, text, close), so the caller keeps its own theme. An omitted
  optional slot falls back: runner and precommand to `command`, option to the grammar's color.
- A theme decides whether any of this is visible: if `syntaxVariable` maps to the body text
  colour (obsidian-harbor maps it to `pearl`), colored variables look unchanged.
- A consumer must validate the shape and fall back to pi's `highlightCode` when this package is
  not loaded. `pi-keeper` does that in `extensions/shell-highlight-bridge.ts`.

The registry is on `globalThis` because pi clears the extension module cache per child process, so
module state does not travel.

## How it is used

[`pi-keeper`](https://github.com/DanielBlei/pi-packages/tree/main/pi-keeper) draws the permission dialog. With
`"previewTextColor": "shell-highlight"` in `~/.pi/agent/pi-keeper.json` it asks this package
for three surfaces:

- the full command of a long bash call (over 300 characters, or multi-line);
- the one-line `bash: <command>` title of the dialog, which is all a short command shows —
  the form plan mode puts in front of you most often, because every command it does not
  recognize asks;
- a `bash`/`sh` fenced block in the plan view, so a plan reads like the call it will ask for.

With `"builtin-syntax"` it uses pi's highlighter alone, which is what that dialog did before
this package existed; `dim`, `muted` and `text` paint dialog text in one plain theme slot.

Which theme slot each decision takes is the consumer's, not this package's. `pi-keeper`
picks `syntaxFunction` for a command, `syntaxType` for a runner, `syntaxVariable` for a
precommand (in obsidian-harbor that is `mist`, so `sudo` and `rtk` recede), `syntaxNumber` for
an option, and `mdCodeBlock` for a plain line — one definition in `extensions/dialog.ts`
(`shellStyle`), shared by the dialog, its title and the plan view.

## Heredoc languages

The delimiter names the language, then a part of it (`PY_EOF` → `python`), then the command that
opened the heredoc (`psql … <<EOF` → `sql`). When none of those names one, the body is read for
what it looks like; when it says nothing either, it is shell — a heredoc opened in a shell
command almost always holds shell.

| Delimiter | Language | Delimiter | Language |
| --- | --- | --- | --- |
| `PY`, `PY3`, `PYTHON` | python | `GO` | go |
| `SQL` | sql | `RB`, `RUBY` | ruby |
| `JSON` | json | `RS`, `RUST` | rust |
| `YAML`, `YML` | yaml | `PHP` | php |
| `SH`, `BASH`, `SHELL` | bash | `PL`, `PERL` | perl |
| `JS`, `NODE` | javascript | `LUA` | lua |
| `TS` | typescript | `DOCKER`, `DOCKERFILE` | dockerfile |
| `HTML`, `XML`, `CSS` | html, xml, css | `MD`, `INI`, `TF`, `HCL` | markdown, ini, hcl |

Opening commands: `python`/`python2`/`python3`, `node`/`nodejs`, `deno`, `psql`/`mysql`/`mariadb`/
`sqlite3`, `ruby`, `perl`, `php`, `Rscript`, `lua`, and `sh`/`bash`/`zsh`/`dash`/`ksh`.

What the body has to show to be read without a name, strongest signal first: a `#!` line
(`#!/usr/bin/env python3` → python, `#!/bin/bash` → bash), a JSON shape (starts with `{` or `[`
and ends with the match), then the lines only one language opens with — `def f(`, `import os`,
`print(`, `for x in …:` (python); `select …`, `insert into …` (sql); `if [ -f x ]; then`, `fi`,
`export X=1` (bash); `package main`, `:=` (go); `fn f(`, `let mut` (rust); `const x =`,
`console.log(` (javascript); `<h1>` (html); `FROM …` (dockerfile). A body that matches none of
them is shell.

## Limits

- `MAX_HIGHLIGHT_LINES` (400) caps each shell run and each heredoc body; the tail stays plain.
  Highlighting runs synchronously on pi's UI thread — measured about 30 ms per 2000 lines.
- A single heredoc opener per line; `cat <<A <<B` takes the first.
- A body that names nothing and looks like nothing is read as shell, so a **prose** heredoc
  (a commit message: `git commit -F - <<'EOF'`) gets the first word of each line colored as a
  command. Name a language in the delimiter that suits prose (`<<MD`) to keep it uncolored.
- No disk access: no flag, path or glob coloring, and no unknown-command detection.

## Development

```sh
npm run typecheck      # tsc --noEmit
npm test               # node --test "tests/**/*.test.ts"
```

The tests assert the invariant that matters most: for every fixture, the output with ANSI removed
equals the input, line for line.
