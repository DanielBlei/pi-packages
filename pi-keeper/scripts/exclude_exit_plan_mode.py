#!/usr/bin/env python3
"""
Keep pi-cc-extensions from hiding the plan (README: Compatibility).

pi-cc-extensions restyles every tool row and, while a tool runs, shows only
"↳ Pending…" — which hides pi-keeper's exit_plan_mode plan, so the plan
never shows above the approval selector. This script adds "exit_plan_mode"
to excludeRenderers in pi-cc-extensions' settings
(~/.pi/agent/pi-cc-extensions.json), leaving every other setting alone, and
is safe to run repeatedly. Restart pi afterwards: the file is read at
startup.

Usage:
  python3 scripts/exclude_exit_plan_mode.py [pi-cc-extensions.json]
"""
from __future__ import annotations

import json
import os
import sys

TOOL = "exit_plan_mode"
DEFAULT_PATH = os.path.join(os.path.expanduser("~"), ".pi", "agent", "pi-cc-extensions.json")


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH
    created = False
    try:
        with open(path, encoding="utf-8") as handle:
            settings = json.load(handle)
    except FileNotFoundError:
        settings = {}
        created = True
    except (OSError, json.JSONDecodeError) as error:
        print(f"Could not read {path}: {error}", file=sys.stderr)
        return 1
    if not isinstance(settings, dict):
        print(f"{path} does not hold a JSON object", file=sys.stderr)
        return 1

    excluded = settings.get("excludeRenderers")
    if excluded is None:
        excluded = []
    if not isinstance(excluded, list):
        print(f"excludeRenderers in {path} is not a list; fix it by hand", file=sys.stderr)
        return 1
    if TOOL in excluded:
        print(f"No change: {path}")
        print(f'  "{TOOL}" is already in excludeRenderers, so the plan is shown.')
        return 0

    excluded.append(TOOL)
    settings["excludeRenderers"] = excluded
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(settings, handle, indent=2)
            handle.write("\n")
    except OSError as error:
        print(f"Could not write {path}: {error}", file=sys.stderr)
        return 1
    print(f"{'Created' if created else 'Updated'}: {path}")
    print(f'  change: excludeRenderers += "{TOOL}"')
    print(f"  now:    excludeRenderers = {json.dumps(excluded)}")
    print("  why:    pi-cc-extensions otherwise replaces the tool row with")
    print('          "↳ Pending…", hiding the plan above the approval selector.')
    print("          Other settings in the file were left untouched.")
    print("  next:   restart pi; the file is read at startup.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
