# Adding a package

Every package is published on its own, so a package directory has to stand
alone: npm packs that directory and nothing around it.

## 1. Directory and manifest

```text
<package>/
├── package.json      # name, version, license, author, bugs, keywords, files, pi{}, peers
├── README.md         # consumer-facing: what it does, then `pi install npm:<name>`
├── CHANGELOG.md      # pi shows new entries to users as "Extension Updates"
├── LICENSE           # a copy: npm only auto-includes the LICENSE of the package dir
├── NOTICE            # every package; third-party sections only when it ships adapted code
├── tsconfig.json     # repo typecheck only (noEmit: pi loads the .ts directly, no build); not in `files`
└── extensions/       # or a single <entry>.ts, referenced by pi.extensions
```

`package.json` has to carry:

| Field | Why |
|---|---|
| `name` | one npm name per package; unscoped `pi-<topic>` is the convention |
| `version` | semver; users on `npm:<name>` get updates from it |
| `license` | `Apache-2.0` here, plus the copied `LICENSE` |
| `keywords` | **first entry `pi-package`** — that keyword is what puts the package in https://pi.dev/packages |
| `files` | the whitelist of what ships. Tests, docs, scripts and `tsconfig.json` (the repo's typecheck config, not shipped) stay in git and out of the tarball. `NOTICE` always ships; its third-party sections only when the package ships adapted code |
| `author` | `"Daniel Blei"` |
| `bugs` | `{ "url": "https://github.com/DanielBlei/pi-packages/issues" }` |
| `pi` | `{ "extensions": ["./extensions/index.ts"] }` — pi reads nothing else to find the entry |
| `peerDependencies` | every `@earendil-works/pi-*` (and `typebox`) the code imports, with `"*"`; never put them in `dependencies` |
| `repository` | `{ "type": "git", "url": "...", "directory": "<package>" }` — no source link without it |
| `engines` | `{ "node": ">=22.19.0" }`, what pi itself requires |

Remove `private` from the package manifest when the package is meant to
publish. The root stays `private: true`.

## 2. Wire it into the repo

1. Add the directory to `workspaces` in the root `package.json`.
2. Add it to `PI` in the `Makefile`.
3. Add a row to the table in the root `README.md`.
4. `npm install` at the root to update the lockfile.

## 3. Before the first publish

```bash
make check                                   # typecheck + tests
npm pack --dry-run --workspace <package>     # read the file list: no tests/, docs/, scripts/
```

Then check the tarball actually loads, in a throwaway agent dir:

```bash
npm pack --workspace <package> --pack-destination /tmp/probe
mkdir -p /tmp/probe/extract/<package> && tar -xzf /tmp/probe/<package>-*.tgz -C /tmp/probe/extract/<package> --strip-components=1
PI_CODING_AGENT_DIR=/tmp/probe/agent pi install /tmp/probe/extract/<package>
PI_CODING_AGENT_DIR=/tmp/probe/agent pi list
```

A package that publishes but loads nothing fails silently: `pi install` does no
resource validation.

## Rules that bite

- **Never advertise `pi install git:github.com/<owner>/pi-packages`.** pi clones
  the repo and treats the root as the package: it loads nothing and runs a
  production `npm install` across every workspace. Packages install by name.
- **Host packages are peers.** In `dependencies` they resolve to a second copy
  of pi and pi warns at runtime.
- **Do not use `postinstall`**: pi's managed npm install does not pass
  `--ignore-scripts`, so any install script you ship runs on users' machines.
