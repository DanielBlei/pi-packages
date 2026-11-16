# pi-packages

Pi packages by [Daniel Blei](https://github.com/DanielBlei), in one repo.

| Package | What it does | Install |
|---|---|---|
| [pi-keeper](pi-keeper) | Autonomy modes with a project rulebook: arbitrates every tool call (`allow` / `ask` / `deny`) from `default`, `auto` and `plan` modes, keeps per-project rules, and lets subagents inherit the parent's mode | `pi install npm:pi-keeper` |
| [pi-session-topic](pi-session-topic) | One-line session titles, so `/resume` shows a topic instead of the first prompt | `pi install npm:pi-session-topic` |
| [pi-shell-highlight](pi-shell-highlight) | Shell command highlighting for the dialogs that ask to run a command; pi-keeper's approval dialog consumes it | `pi install npm:pi-shell-highlight` |

First npm release is pending; until then, install a checkout with
`pi install /path/to/pi-packages/<package>`.

## Working in this repo

```bash
make install     # npm ci from the root; workspaces hoist into ./node_modules
make check       # typecheck + tests for every package
make pack-dry    # what each package would publish, without writing a tarball
```

One npm workspace per package, one lockfile at the root. The root is `private`
and never published: `pi install` fetches a single package, so each of them is
its own npm name, published separately with `npm publish -w <package>`.

Adding a package: [docs/adding-a-package.md](docs/adding-a-package.md).

## Acknowledgements

pi-keeper credits the projects it draws on in its [acknowledgements](https://github.com/DanielBlei/pi-packages/tree/main/pi-keeper#acknowledgements).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The packages
are provided "AS IS", without warranties of any kind. pi-keeper is a guard, not
a sandbox; read its
[security and limitations](https://github.com/DanielBlei/pi-packages/tree/main/pi-keeper#security-and-limitations)
before you rely on it. To report a vulnerability, see [SECURITY.md](SECURITY.md).
