# pi-shell-highlight

A pi extension that publishes a **shell command highlighter** for the process. It draws nothing itself: another package that shows a shell command asks for it through a process-global registry. [pi-keeper](https://www.npmjs.com/package/pi-keeper)'s permission dialog is the consumer.

pi's own highlighter is a grammar: it cannot know that `git`, `tar` or `rm` are commands, and it paints a heredoc body as one string. This package adds:

- the word in **command position** is colored (line start, after `|`, `&&`, `;`, `(`, `{`, and after a prefix such as `sudo`, `env`, `xargs`, `time`, `rtk`, with its options skipped);
- **three weights**: a precommand (`sudo`, `env`, `rtk`) recedes, the command stands out, and a runner (`python`, `node`, `go`, `cargo`, `npm`, `make`, …) reads apart from a plain tool such as `grep`;
- **options** (`-n`, `--json`) get their own color;
- a **heredoc body** is highlighted with the language its delimiter or opening command names, else the language it looks like, else shell (with command names colored).

## Install

```bash
pi install npm:pi-shell-highlight    # every session; writes ~/.pi/agent/settings.json
```

`pi update --extensions` picks up new releases. On its own it draws nothing: install it with a consumer, then for pi-keeper set `/keeper` → `previewTextColor` to `shell-highlight` (`builtin-syntax` is the old look). From a checkout: `pi -e ./pi-shell-highlight`.

## The contract

```ts
import { HIGHLIGHTER_KEY, type CommandHighlighter, type CommandStyle } from "pi-shell-highlight/highlight.ts";

const highlighter = (globalThis as Record<symbol, unknown>)[HIGHLIGHTER_KEY] as CommandHighlighter | undefined;
const lines = highlighter?.highlightCommand(command, "bash", style);
```

- The key is `Symbol.for("pi.shell-highlight.v1")`; `v1` is the contract version. The registry lives on `globalThis` because pi clears the module cache per child process.
- `highlightCommand(text, lang, style)` returns one string per input line, same order, with ANSI codes, and never changes the visible characters.
- `style` wraps spans: `command`, `plain`, and the optional `variable`, `runner`, `precommand`, `option`. Each returns a self-contained span so the caller keeps its theme. A missing optional slot falls back (runner and precommand to `command`, option to the grammar's color).
- A consumer must validate the shape and fall back to pi's `highlightCode` when this package is not loaded. pi-keeper does that in `extensions/shell-highlight-bridge.ts`.

## Heredoc languages

The delimiter names the language, then a part of it (`PY_EOF` → python), then the opening command (`psql … <<EOF` → sql). Otherwise the body is read for a shebang, a JSON shape, or lines only one language opens with; if none match, it is shell.

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

## Limits

- `MAX_HIGHLIGHT_LINES` (400) caps each shell run and each heredoc body; the tail stays plain.
- One heredoc opener per line: `cat <<A <<B` takes the first.
- A prose heredoc (`git commit -F - <<'EOF'`) is read as shell and gets the first word of each line colored. Use a prose delimiter such as `<<MD` to avoid that.
- No disk access: no path or glob coloring, no unknown-command detection.

## License

Apache-2.0, see [LICENSE](https://github.com/DanielBlei/pi-packages/blob/main/pi-shell-highlight/LICENSE).
