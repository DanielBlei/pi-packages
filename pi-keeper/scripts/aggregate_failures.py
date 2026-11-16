#!/usr/bin/env python3
"""
Aggregate tool-calling failures across many pi sessions.

Loads the same session logs as `scripts/extract_flow.py --failures` — every
session given (or discovered under a directory), each with its subagent
children — and prints one aggregate: error rates by model, unit, agent, mode,
tool and day; retry recovery; and the paths headless children keep being
denied on. `--json` prints the same aggregate as one JSON object.

Usage:
  python3 scripts/aggregate_failures.py ~/.pi/agent/sessions   # every conversation
  python3 scripts/aggregate_failures.py --latest 20            # 20 newest conversations
  python3 scripts/aggregate_failures.py <session.jsonl> ...    # specific conversations
  python3 scripts/aggregate_failures.py --json ... > summary.json
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from extract_flow import (  # noqa: E402
    Call,
    Session,
    ChildRun,
    classify_error,
    is_child_session,
    load_children,
    load_session,
    mark_retries,
    mode_at,
    shrink,
)

SESSIONS_DIR = os.path.join(os.path.expanduser("~"), ".pi", "agent", "sessions")
HOME = os.path.expanduser("~")
DENIED_COMMAND = re.compile(r'^"([^"]*)"')
SPAN_DAYS_FOR_WEEKS = 21


@dataclass
class Unit:
    """One execution unit: a conversation's main session or one subagent child."""

    session_file: str
    session_id: str
    model: str
    unit: str  # "main" | "child"
    agent: str = ""
    run_id: str = ""
    mode_label: str = ""  # a child's fixed mode
    child_source: str = ""  # "session" | "transcript"
    exit_code: int | None = None
    calls: list[Call] = field(default_factory=list)

    @property
    def label(self) -> str:
        if self.unit == "main":
            return f"main {self.session_id[:8]}"
        return f"child {self.agent} {self.run_id[:8]}"


def top_level_sessions(root: str) -> list[str]:
    """Conversations under root: *.jsonl, newest first; subagent artifacts and
    nested child sessions excluded (children are reached through their parent)."""
    files = glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)
    return sorted(
        (path for path in files if "/subagent-artifacts/" not in path and not is_child_session(path)),
        key=os.path.getmtime,
        reverse=True,
    )


def discover(paths: list[str], latest: int | None) -> list[str]:
    files: list[str] = []
    if latest is not None:
        files.extend(top_level_sessions(SESSIONS_DIR)[: max(1, latest)])
    for path in paths:
        if os.path.isdir(path):
            files.extend(top_level_sessions(path))
        else:
            files.append(path)
    unique: list[str] = []
    seen: set[str] = set()
    for path in files:
        real = os.path.realpath(path)
        if real not in seen:
            seen.add(real)
            unique.append(path)
    return unique


def collect(path: str) -> list[Unit] | None:
    """The units of one conversation: its main session plus subagent children."""
    try:
        session = load_session(path)
    except (OSError, json.JSONDecodeError):
        return None
    children = load_children(session)
    for call in session.calls.values():
        call.mode = mode_at(session, call.ts)
    main_calls = sorted(session.calls.values(), key=lambda call: call.ts)
    mark_retries(main_calls)
    units = [
        Unit(
            session_file=path,
            session_id=session.session_id,
            model=session.model,
            unit="main",
            calls=main_calls,
        )
    ]
    for child in children:
        for call in child.calls:
            call.mode = child.mode
        mark_retries(child.calls)
        units.append(
            Unit(
                session_file=path,
                session_id=session.session_id,
                model=child.model or session.model,
                unit="child",
                agent=child.agent,
                run_id=child.run_id,
                mode_label=child.mode,
                child_source=child.source,
                exit_code=child.exit_code,
                calls=child.calls,
            )
        )
    return units


def day_key(ts_ms: float) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def week_key(ts_ms: float) -> str:
    iso = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def rate(errors: int, calls: int) -> float | None:
    return round(100 * errors / calls, 1) if calls else None


def fmt_rate(value: float | None) -> str:
    return f"{value}%" if value is not None else "-"


def bucket_path(path: str) -> str:
    """A short, comparable form of a denied path: ~/<seg>/<seg> or /<seg>/<seg>/<seg>."""
    if path.startswith(HOME):
        path = "~" + path[len(HOME):]
    if path.startswith("~"):
        parts = [part for part in path[1:].split("/") if part]
        return "~/" + "/".join(parts[:2]) if parts else "~"
    parts = [part for part in path.split("/") if part]
    return "/" + "/".join(parts[:3]) if parts else path


def denied_target(text: str) -> str:
    """The target a permission error was about: the quoted command's main path, else its first words."""
    match = DENIED_COMMAND.match(text)
    command = match.group(1) if match else text
    command = command.removeprefix("bash: ").removeprefix("powershell: ")
    if "(full command shown below)" in command:
        return "(command not shown)"
    for token in command.split():
        candidate = token.strip("\"';,()")
        if candidate.startswith("/") or candidate.startswith("~/"):
            return bucket_path(candidate)
    return shrink(" ".join(command.split()[:3]), 40)


def build_aggregate(units: list[Unit], sessions: int, unreadable: int) -> dict[str, Any]:
    all_calls = [call for unit in units for call in unit.calls]
    errored = [call for call in all_calls if call.error]
    child_units = [unit for unit in units if unit.unit == "child"]
    retried = [call for call in errored if call.retried]
    failed_again = [call for call in errored if call.retried and call.retry_error]

    tss = [call.ts for call in all_calls if call.ts > 0]
    use_weeks = bool(tss) and (max(tss) - min(tss)) / 86_400_000 > SPAN_DAYS_FOR_WEEKS
    period_key = week_key if use_weeks else day_key

    by_period: dict[str, dict[str, int]] = {}
    by_model: dict[str, dict[str, int]] = {}
    by_mode: dict[str, dict[str, int]] = {}
    by_tool: dict[str, dict[str, int]] = {}
    by_agent: dict[str, dict[str, int]] = {}
    top_errors: dict[tuple[str, str], dict[str, Any]] = {}
    denied: Counter[str] = Counter()

    def add(table: dict[str, dict[str, int]], key: str, calls: int, errors: int) -> None:
        slot = table.setdefault(key, {"calls": 0, "errors": 0})
        slot["calls"] += calls
        slot["errors"] += errors

    for unit in units:
        unit_errors = sum(1 for call in unit.calls if call.error)
        add(by_model, unit.model or "?", len(unit.calls), unit_errors)
        if unit.unit == "child":
            add(by_agent, unit.agent or "?", len(unit.calls), unit_errors)
        for call in unit.calls:
            if call.ts > 0:
                add(by_period, period_key(call.ts), 1, 1 if call.error else 0)
            add(by_mode, call.mode or "?", 1, 1 if call.error else 0)
            add(by_tool, call.tool, 1, 1 if call.error else 0)
            if call.error:
                key = (call.tool, classify_error(call.error_text))
                slot = top_errors.setdefault(key, {"count": 0, "sessions": set(), "children": 0, "sample": call.error_text})
                slot["count"] += 1
                slot["sessions"].add(unit.session_file)
                if unit.unit == "child":
                    slot["children"] += 1
                if classify_error(call.error_text) == "permission":
                    denied[denied_target(call.error_text)] += 1

    exits = Counter(
        "ok" if unit.exit_code == 0 else ("nonzero" if unit.exit_code is not None else "unknown")
        for unit in child_units
    )

    return {
        "sessions": sessions,
        "unreadable": unreadable,
        "children": len(child_units),
        "childrenHeadless": sum(1 for unit in child_units if unit.child_source == "transcript"),
        "span": {
            "from": datetime.fromtimestamp(min(tss) / 1000, tz=timezone.utc).strftime("%Y-%m-%d") if tss else "",
            "to": datetime.fromtimestamp(max(tss) / 1000, tz=timezone.utc).strftime("%Y-%m-%d") if tss else "",
            "granularity": "week" if use_weeks else "day",
        },
        "calls": len(all_calls),
        "errors": len(errored),
        "errorRate": rate(len(errored), len(all_calls)),
        "aborted": sum(1 for call in all_calls if call.error is None),
        "retriedAfterError": len(retried),
        "recovered": len(retried) - len(failed_again),
        "failedAgain": len(failed_again),
        "byKind": dict(Counter(classify_error(call.error_text) for call in errored)),
        "byPeriod": [
            {"period": period, **counts, "rate": rate(counts["errors"], counts["calls"])}
            for period, counts in sorted(by_period.items())
        ],
        "byModel": [
            {"model": model, **counts, "rate": rate(counts["errors"], counts["calls"])}
            for model, counts in sorted(by_model.items(), key=lambda item: -item[1]["calls"])
        ],
        "byUnit": {
            "main": {"calls": sum(len(u.calls) for u in units if u.unit == "main"),
                      "errors": sum(1 for u in units if u.unit == "main" for c in u.calls if c.error)},
            "child": {"calls": sum(len(u.calls) for u in child_units),
                      "errors": sum(1 for u in child_units for c in u.calls if c.error)},
        },
        "byAgent": [
            {"agent": agent, **counts, "rate": rate(counts["errors"], counts["calls"])}
            for agent, counts in sorted(by_agent.items(), key=lambda item: -item[1]["calls"])
        ],
        "byMode": [
            {"mode": mode, **counts, "rate": rate(counts["errors"], counts["calls"])}
            for mode, counts in sorted(by_mode.items(), key=lambda item: -item[1]["calls"])
        ],
        "byTool": [
            {"tool": tool, **counts, "rate": rate(counts["errors"], counts["calls"])}
            for tool, counts in sorted(by_tool.items(), key=lambda item: -item[1]["errors"])
        ],
        "topErrors": [
            {
                "tool": tool,
                "kind": kind,
                "count": slot["count"],
                "sessions": len(slot["sessions"]),
                "children": slot["children"],
                "sample": slot["sample"],
            }
            for (tool, kind), slot in sorted(top_errors.items(), key=lambda item: -item[1]["count"])
        ],
        "deniedTargets": [{"target": target, "count": count} for target, count in denied.most_common()],
        "childExits": dict(exits),
        "worstSessions": [
            {"file": os.path.basename(unit.session_file), "unit": unit.label, "errors": errors,
             "calls": len(unit.calls), "rate": rate(errors, len(unit.calls))}
            for unit, errors in sorted(
                ((unit, sum(1 for call in unit.calls if call.error)) for unit in units),
                key=lambda item: -item[1],
            )[:5]
            if errors
        ],
    }


def aggregate_report(agg: dict[str, Any]) -> str:
    lines: list[str] = []
    add = lines.append
    span = agg["span"]
    add(
        f"=== failure aggregate: {agg['sessions']} conversation(s), {agg['children']} children"
        f" ({span['from']} .. {span['to']}, by {span['granularity']}) ==="
    )
    if agg["unreadable"]:
        add(f"  ({agg['unreadable']} unreadable session file(s) skipped)")
    add(
        f"  overall: {agg['calls']:,} calls · {agg['errors']:,} errors ({agg['errorRate']}%)"
        f" · {agg['aborted']} aborted · retried-after-error {agg['retriedAfterError']}"
        f" ({agg['recovered']} recovered, {agg['failedAgain']} failed again)"
    )
    kinds = " · ".join(f"{kind} {count}" for kind, count in sorted(agg["byKind"].items(), key=lambda item: -item[1]))
    if kinds:
        add(f"  errors by kind: {kinds}")

    if agg["byPeriod"]:
        add(f"  by {span['granularity']}:")
        for row in agg["byPeriod"]:
            add(f"    {row['period']:<12} {row['calls']:>8,} calls  {row['errors']:>5,} err  {fmt_rate(row['rate']):>5}")

    if agg["byModel"]:
        add("  by model:")
        for row in agg["byModel"]:
            if not row["calls"]:
                continue  # a model switch with no calls (kept in --json)
            add(f"    {shrink(row['model'], 44):<44} {row['calls']:>8,} calls  {row['errors']:>5,} err  {fmt_rate(row['rate']):>5}")

    main, child = agg["byUnit"]["main"], agg["byUnit"]["child"]
    add(
        f"  by unit:  main {fmt_rate(rate(main['errors'], main['calls']))} of {main['calls']:,}"
        f" · child {fmt_rate(rate(child['errors'], child['calls']))} of {child['calls']:,}"
        f" ({agg['childrenHeadless']} headless)"
    )
    if agg["byAgent"]:
        agents = " · ".join(
            f"{row['agent']} {fmt_rate(row['rate'])} of {row['calls']:,}" for row in agg["byAgent"]
        )
        add(f"  by agent (children): {agents}")
    if agg["byMode"]:
        modes = " · ".join(f"{row['mode']} {fmt_rate(row['rate'])} of {row['calls']:,}" for row in agg["byMode"])
        add(f"  by mode: {modes}")

    if agg["byTool"]:
        add("  by tool (worst first):")
        for row in agg["byTool"][:10]:
            if not row["errors"]:
                break
            add(f"    {row['tool'][:24]:<24} {row['calls']:>7,} calls  {row['errors']:>5,} err  {fmt_rate(row['rate']):>6}")

    if agg["topErrors"]:
        add("  top errors:")
        for row in agg["topErrors"][:8]:
            where = f"{row['sessions']} session(s)"
            if row["children"]:
                where += f", {row['children']} in children"
            add(f"    [{row['kind']}] {row['tool']}: {shrink(row['sample'], 100)} ×{row['count']} · {where}")

    if agg["deniedTargets"]:
        add("  permission denials by target:")
        for row in agg["deniedTargets"][:8]:
            add(f"    {row['count']:>5}  {row['target']}")

    exits = agg["childExits"]
    if exits:
        add("  child exits: " + " · ".join(f"{kind} {count}" for kind, count in sorted(exits.items(), key=lambda item: -item[1])))

    if agg["worstSessions"]:
        add("  worst units:")
        for row in agg["worstSessions"]:
            add(f"    {row['file']:<44} {row['unit']:<20} {row['errors']:>3} err of {row['calls']:>5,} ({fmt_rate(row['rate'])})")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*", help="session .jsonl files or directories to scan")
    parser.add_argument("--latest", nargs="?", type=int, const=20, metavar="N", help="analyze the N newest conversations (default 20)")
    parser.add_argument("--json", action="store_true", help="print the aggregate as one JSON object")
    args = parser.parse_args()

    files = discover(args.paths, args.latest)
    if not files:
        parser.error("no session files found (pass paths or directories, or --latest [N])")

    units: list[Unit] = []
    sessions = 0
    unreadable = 0
    for path in files:
        collected = collect(path)
        if collected is None:
            unreadable += 1
            continue
        sessions += 1
        units.extend(collected)

    aggregate = build_aggregate(units, sessions, unreadable)
    if args.json:
        print(json.dumps(aggregate, ensure_ascii=False, default=str))
    else:
        print(aggregate_report(aggregate))
    return 0


if __name__ == "__main__":
    sys.exit(main())
