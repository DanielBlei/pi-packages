# pi-packages

Small extensions for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), the terminal coding agent, that I use day to day. Each package installs on its own.

> **Status:** 0.x. Used daily, but settings and behavior can change between releases.

| Package | What it does | Install |
|---|---|---|
| [pi-keeper](pi-keeper) | Permission modes (`default`, `auto`, `plan`) and per-project allow, ask and deny rules that decide every tool call (the main package) | `pi install npm:pi-keeper` |
| [pi-session-topic](pi-session-topic) | One-line session titles, so `/resume` shows a topic; standalone | `pi install npm:pi-session-topic` |
| [pi-shell-highlight](pi-shell-highlight) | Shell command highlighting for permission dialogs; pi-keeper uses it when loaded | `pi install npm:pi-shell-highlight` |

From a checkout: `pi install /path/to/pi-packages/<package>`.

## Risk

Pi extensions run code on your machine. Read the source before you install. These are personal tools, provided "AS IS" (Apache-2.0). pi-keeper is a guard, not a sandbox: see its [security and limitations](pi-keeper/README.md#security-and-limitations).

## Contributing

Issues and patches for the packages above are welcome; this repo only holds my own packages. For anything beyond a small fix, open an issue first so we can agree the approach before you spend an evening on it. Replies are best effort. To report a vulnerability, see [SECURITY.md](SECURITY.md).

```bash
make install   # dev dependencies only (npm ci), not a pi install
make check     # typecheck + tests for every package
```

## Acknowledgements

Credits are in [pi-keeper's README](pi-keeper/README.md#acknowledgements).

## License

[Apache-2.0](LICENSE), see also [NOTICE](NOTICE).
