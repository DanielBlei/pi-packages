# Changelog

## 0.1.0 - 2026-11-16

First public release.

- Names every pi session with a one-line topic, so `/resume` and `pi -r` show a
  readable title instead of the first prompt.
- `/topic` regenerates the title (also for old sessions) or sets it by hand.
- `/session-topic` shows and changes the settings: on/off, model, title budget
  in terminal cells, debug.
- Settings in `<agent dir>/pi-session-topic.json`, with environment overrides.
