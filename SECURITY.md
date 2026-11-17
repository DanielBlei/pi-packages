# Security policy

## Supported versions

Only the latest published version of each package receives fixes.

| Package | Supported |
|---|---|
| pi-keeper | latest 0.x |
| pi-session-topic | latest 0.x |
| pi-shell-highlight | latest 0.x |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Include:

- the package and version, and the pi version;
- the mode (`default`, `auto` or `plan`) and any project rules involved;
- the exact tool call or command, and what pi-keeper decided;
- what you expected it to decide.

This is a personal project maintained on a best-effort basis. I aim to
acknowledge a report within about a week, but this is not a guarantee. A confirmed bypass is fixed in a new release and
credited in the CHANGELOG, unless you prefer not to be named.

## Scope

In scope: a way to make pi-keeper allow a call that its documented rules say
must ask or be denied, and any problem that exposes credentials or files
outside the project.

pi-keeper is a guard, not a sandbox. The limits described in
[Security and limitations](pi-keeper/README.md#security-and-limitations) are
known; a report that shows a practical way through them is still welcome.
