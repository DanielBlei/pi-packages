---
description: Write a pi-keeper rulebook rule from a description of what the model must not say or do
argument-hint: "<what must not happen> [project]"
---
Create a pi-keeper rulebook rule for this: $@

A rule is one Markdown file. It fires once per session when the model's finished answer matches its regex, and the body is the correction the model then receives.

Where to save it:
- Default: `~/.pi/agent/pi-keeper/rules/<short-kebab-name>.md` (all projects).
- If my request says "project": `<project root>/.pi/rules/<short-kebab-name>.md` instead (pi-keeper asks me to review it once).

Format (the file name, without `.md`, is the rule name):

```markdown
---
description: One line on what must not happen. Shown by /rules and on the card.
condition: (?i)\bshould work\b
---
Do not say the change "should work". Run it and quote the result, or say plainly
that you did not run it.
```

How to write it well:
1. `condition` is one JavaScript regex, matched against the end of the answer's text blocks (not thinking, not tool arguments). A leading `(?i)` makes it case-insensitive. Use `\b` at both ends.
2. Aim at the claim, not the topic: narrow enough that an innocent sentence does not match. Use a lookbehind or lookahead to exclude negations such as "not" or "never".
3. The body says what to do instead, in one or two short sentences. A forgiving body ("if you did run it, quote the line") is better than a stern one.
4. Before you save it, test the regex with `node -e` against one sentence that must match and two that must not. Show me the results.

Then write the file, tell me its full path, and say that `/rules` lists it. Do not edit other files.
