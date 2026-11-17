# Changelog

## 0.1.0 - 2026-11-17

First public release.

- Names every pi session with a one-line topic, so `/resume` and `pi -r` show a
  readable title instead of the first prompt.
- `/topic` regenerates the title (also for old sessions) or sets it by hand.
- `/session-topic` shows and changes the settings: on/off, model, title budget
  in terminal cells, debug. `/session-topic reset` writes the defaults.
- Titles are clipped between graphemes, so an emoji or an accented letter is
  never split. A leading label such as `Title:` is removed, but a real word
  such as `Topic-based` is kept.
- Network errors, timeouts, 429 and 5xx stop automatic naming after 5 failures
  per session.
- Settings in `<agent dir>/pi-session-topic.json`, with environment overrides;
  `PI_SESSION_TOPIC_MAX_CELLS` sets the title budget.
