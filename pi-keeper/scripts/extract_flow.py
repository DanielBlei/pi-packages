#!/usr/bin/env python3
"""
Extract pi-keeper permission telemetry from pi session logs.

Every decision, dialog and user choice that pi-keeper records via
pi.appendEntry("pi-keeper-permission", ...) is read back from one or
more session JSONL files, correlated with the tool calls and results
around it, and printed as a compact flow summary (or as NDJSON with
--json). Sessions recorded before the telemetry existed get a
timeline-only fallback: turns, calls, errors, and toolCall->toolResult
gaps that hint at a dialog wait.

Usage:
  python3 scripts/extract_flow.py <session.jsonl> [more.jsonl ...]
  python3 scripts/extract_flow.py --latest [N]     # N newest sessions (default 1)
  python3 scripts/extract_flow.py --json ...       # NDJSON events instead of the summary
  python3 scripts/extract_flow.py --stats ...      # one aggregate over all given sessions, per model
  python3 scripts/extract_flow.py --failures <session.jsonl> [--json] [-v]
                                                   # tool-calling failure scorecard: the session
                                                   # AND its subagent children (errors by kind,
                                                   # tool, mode; retry chains; aborted calls)
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import statistics
import sys
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterator

TELEMETRY_TYPE = "pi-keeper-permission"
STATE_TYPE = "pi-keeper"
MODE_CHANGE_TYPE = "pi-keeper-mode-change"
SESSIONS_DIR = os.path.join(os.path.expanduser("~"), ".pi", "agent", "sessions")
USER_MSG_LIMIT = 100
GAP_HINT_MS = 5000
MODE_NAMES = ("default", "auto", "plan")
RETRY_WINDOW_MS = 180_000
ERROR_TEXT_LIMIT = 200
ERROR_KINDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("permission", ("requires user approval", "was not approved", "not approved", "permission denied")),
    ("timeout", ("timed out", "timeout")),
    ("aborted", ("abort", "cancel")),
    ("not-found", ("no such file", "not found", "enoent")),
    ("validation", ("invalid", "unexpected", "schema", "argument", "expected")),
)


def parse_ts(value: Any) -> float:
    """Entry timestamps are ISO strings, message timestamps epoch ms; returns ms."""
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        from datetime import datetime

        return datetime.fromisoformat(text).timestamp() * 1000
    except ValueError:
        return 0.0


def fmt_time(ts_ms: float) -> str:
    if ts_ms <= 0:
        return "??:??:??"
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%H:%M:%S")


def shrink(text: str, limit: int, head: int | None = None) -> str:
    """One line, and head+tail when too long (the tail of a command is the interesting part)."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    if head is None:
        head = max(1, int(limit * 0.6))
    tail = limit - head
    hidden = len(text) - head - tail
    return f"{text[:head]}…[+{hidden}]…{text[-tail:]}"


@dataclass
class Call:
    tool: str
    command: str
    ts: float
    error: bool | None = None
    duration_ms: float | None = None
    error_text: str = ""
    mode: str = ""
    retried: bool = False
    retry_error: bool | None = None


@dataclass
class Session:
    path: str
    session_id: str = ""
    cwd: str = ""
    started: str = ""
    model: str = ""
    name: str = ""  # session_info display name; subagent children carry "subagent-<agent>-<runId>-<index>"
    telemetry: list[dict[str, Any]] = field(default_factory=list)
    calls: dict[str, Call] = field(default_factory=dict)
    user_messages: list[tuple[float, str]] = field(default_factory=list)
    mode_changes: list[tuple[float, str]] = field(default_factory=list)
    summaries: list[dict[str, Any]] = field(default_factory=list)

    @property
    def has_telemetry(self) -> bool:
        return bool(self.telemetry)


def text_of_content(content: Any) -> str:
    """Text of a toolResult content: a string, or a list of text blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [str(block.get("text", "")) for block in content if isinstance(block, dict) and block.get("type") == "text"]
        return " ".join(part for part in parts if part)
    return ""


def classify_error(text: str) -> str:
    low = text.lower()
    for kind, markers in ERROR_KINDS:
        if any(marker in low for marker in markers):
            return kind
    return "other"


def command_of_block(block: dict[str, Any]) -> str:
    args = block.get("arguments") or {}
    if isinstance(args, dict):
        for key in ("command", "path", "file_path", "pattern"):
            value = args.get(key)
            if isinstance(value, str) and value:
                return value
    return json.dumps(args)[:120]


def load_session(path: str) -> Session:
    session = Session(path=path)
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = entry.get("type")
            ts = parse_ts(entry.get("timestamp"))
            if kind == "session":
                session.session_id = str(entry.get("id", ""))
                session.cwd = str(entry.get("cwd", ""))
                session.started = str(entry.get("timestamp", ""))
            elif kind == "model_change":
                model = entry.get("modelId")
                session.model = f"{entry.get('provider', '')}/{model}" if model else session.model
            elif kind == "session_info":
                name = entry.get("name")
                if isinstance(name, str) and name:
                    session.name = name
            elif kind == "custom":
                custom = entry.get("customType")
                data = entry.get("data")
                if custom == TELEMETRY_TYPE and isinstance(data, dict):
                    data = dict(data)
                    data["_ts"] = ts
                    data["_entry_ts"] = entry.get("timestamp")
                    session.telemetry.append(data)
                elif custom == STATE_TYPE and isinstance(data, dict) and "mode" in data:
                    session.mode_changes.append((ts, str(data["mode"])))
                elif custom == "agent-summary" and isinstance(data, dict):
                    session.summaries.append(dict(data, _ts=ts))
            elif kind == "custom_message":
                if entry.get("customType") == MODE_CHANGE_TYPE:
                    session.mode_changes.append((ts, shrink(str(entry.get("content", "")), 60)))
            elif kind == "message":
                message = entry.get("message", {})
                role = message.get("role")
                custom_type = message.get("customType")
                if custom_type == MODE_CHANGE_TYPE:
                    session.mode_changes.append((ts, str(message.get("content", ""))))
                    continue
                content = message.get("content")
                if role == "user" and not custom_type:
                    text = ""
                    if isinstance(content, str):
                        text = content
                    elif isinstance(content, list):
                        text = " ".join(
                            block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text"
                        )
                    if text.strip():
                        session.user_messages.append((ts, shrink(text, USER_MSG_LIMIT)))
                elif role == "assistant" and isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "toolCall":
                            session.calls[str(block.get("id", ""))] = Call(
                                tool=str(block.get("name", "?")),
                                command=command_of_block(block),
                                ts=ts,
                            )
                elif role == "toolResult":
                    call = session.calls.get(str(message.get("toolCallId", "")))
                    if call is not None:
                        call.error = bool(message.get("isError"))
                        if call.error:
                            call.error_text = shrink(text_of_content(message.get("content")), ERROR_TEXT_LIMIT)
                        result_ts = parse_ts(message.get("timestamp")) or ts
                        call.duration_ms = max(0.0, result_ts - call.ts)
    return session


def enrich(session: Session) -> Iterator[dict[str, Any]]:
    """Telemetry events with the execution outcome of their tool call attached."""
    for event in session.telemetry:
        out = dict(event)
        call_id = str(event.get("toolCallId", ""))
        call = session.calls.get(call_id)
        if call is not None:
            out["_exec"] = {"error": call.error, "durationMs": call.duration_ms}
        yield out


# ============================================================================
# Failure analytics: the session and its subagent children
# ============================================================================


def mode_timeline(session: Session) -> list[tuple[float, str]]:
    """(ts, mode) from pi-keeper state entries; announcements and other text filtered out."""
    timeline = [(ts, mode) for ts, mode in session.mode_changes if mode in MODE_NAMES]
    timeline.sort(key=lambda item: item[0])
    return timeline


def mode_at(session: Session, ts: float) -> str:
    """The session's mode when a call ran. '?' when the extension left no trace at all."""
    timeline = mode_timeline(session)
    if not timeline and not session.has_telemetry:
        return "?"
    mode = "default"
    for mode_ts, name in timeline:
        if mode_ts <= ts:
            mode = name
        else:
            break
    return mode


def mark_retries(calls: list[Call], window_ms: float = RETRY_WINDOW_MS) -> None:
    """Flag errored calls that the model retried (same tool again within the window)."""
    ordered = sorted(calls, key=lambda call: call.ts)
    for index, call in enumerate(ordered):
        if not call.error:
            continue
        for later in ordered[index + 1:]:
            if later.ts - call.ts > window_ms:
                break
            if later.tool == call.tool:
                call.retried = True
                call.retry_error = bool(later.error)
                break


def parse_transcript(path: str) -> list[Call]:
    """Calls from a pi-subagents child transcript (async children write no pi session file).

    Records: tool_start (toolCallId, toolName, argsPreview), tool_end (isError),
    and message records with role toolResult (isError, text).
    """
    calls: dict[str, Call] = {}
    order: list[str] = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = record.get("recordType")
            ts = parse_ts(record.get("ts")) or parse_ts(record.get("timestamp"))
            call_id = str(record.get("toolCallId", ""))
            if kind == "tool_start":
                command = record.get("argsPreview")
                if not isinstance(command, str) or not command:
                    command = json.dumps(record.get("argsPayload"))[:120]
                calls[call_id] = Call(tool=str(record.get("toolName", "?")), command=shrink(command, 120), ts=ts)
                order.append(call_id)
            elif kind == "tool_end":
                call = calls.get(call_id)
                if call is not None:
                    if record.get("isError"):
                        call.error = True
                    if ts > call.ts:
                        call.duration_ms = max(0.0, ts - call.ts)
            elif kind == "message" and record.get("role") == "toolResult":
                call = calls.get(call_id)
                if call is not None:
                    call.error = bool(record.get("isError"))
                    if call.error:
                        call.error_text = shrink(str(record.get("text", "")), ERROR_TEXT_LIMIT)
    return [calls[call_id] for call_id in order]


@dataclass
class ChildRun:
    """One subagent child of the conversation, however it was run."""

    run_id: str
    agent: str = "?"
    model: str = ""
    exit_code: int | None = None
    source: str = "session"  # "session": foreground child with a pi session file; "transcript": async child
    mode: str = "?"  # a child's mode is fixed; async children leave no telemetry to read it from
    session: Session | None = None
    calls: list[Call] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)


def child_mode_of(session: Session) -> str:
    """A foreground child's fixed mode, from its own permission telemetry (state entries are parent-only)."""
    modes = Counter(
        str(event.get("mode"))
        for event in session.telemetry
        if event.get("phase") in ("decide", "redecide") and event.get("mode") in MODE_NAMES
    )
    for mode, _ in modes.most_common():
        return mode
    for _, mode in reversed(mode_timeline(session)):
        return mode
    return "?"


def load_children(session: Session) -> list[ChildRun]:
    """The subagent children of one conversation (direct children only).

    Foreground children run in the parent's process and write a pi session file
    under the parent's sibling directory: <parent>.jsonl -> <parent>/<runId>/run-N/session.jsonl.
    Async (background) children are separate processes with no session file; their
    calls live only in subagent-artifacts/<runId>_<agent>_transcript.jsonl, linked to
    the conversation by the *_meta.json parentSessionId. Both kinds have a meta with
    agent, model and exitCode. Children of children are not followed (yet).
    """
    if not session.path.endswith(".jsonl") or not session.session_id:
        return []
    sessions_dir = os.path.dirname(session.path)
    artifacts_dir = os.path.join(sessions_dir, "subagent-artifacts")

    metas: dict[str, dict[str, Any]] = {}
    for meta_path in sorted(glob.glob(os.path.join(artifacts_dir, "*_meta.json"))):
        try:
            with open(meta_path, encoding="utf-8") as handle:
                meta = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(meta, dict) and str(meta.get("parentSessionId", "")) == session.session_id:
            run_id = str(meta.get("runId", ""))
            if run_id:
                metas[run_id] = meta

    children: list[ChildRun] = []
    seen: set[str] = set()

    nested = session.path[: -len(".jsonl")]
    for run_file in sorted(glob.glob(os.path.join(nested, "*", "run-*", "session.jsonl"))):
        dir_run_id = os.path.basename(os.path.dirname(os.path.dirname(run_file)))
        try:
            child_session = load_session(run_file)
        except (OSError, json.JSONDecodeError):
            continue
        # The nested directory id and the artifacts runId differ. The child session's
        # display name links them: "subagent-<agent>-<runId>-<childIndex>".
        meta = metas.get(dir_run_id, {})
        if not meta:
            for candidate_id, candidate in metas.items():
                if candidate_id in child_session.name:
                    meta = candidate
                    break
        run_id = str(meta.get("runId", dir_run_id))
        agent = str(meta.get("agent", ""))
        if not agent:
            match = re.match(r"^subagent-(.+?)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$", child_session.name)
            agent = match.group(1) if match else "?"
        children.append(
            ChildRun(
                run_id=run_id,
                agent=agent,
                model=child_session.model or str(meta.get("model", "")),
                exit_code=meta.get("exitCode") if isinstance(meta.get("exitCode"), int) else None,
                source="session",
                mode=child_mode_of(child_session),
                session=child_session,
                calls=sorted(child_session.calls.values(), key=lambda call: call.ts),
                meta=meta,
            )
        )
        seen.add(run_id)

    for run_id, meta in sorted(metas.items()):
        if run_id in seen:
            continue
        transcript = str(meta.get("transcriptPath") or "")
        if not os.path.isfile(transcript):
            hits = glob.glob(os.path.join(artifacts_dir, f"{run_id}_*_transcript.jsonl"))
            transcript = hits[0] if hits else ""
        children.append(
            ChildRun(
                run_id=run_id,
                agent=str(meta.get("agent", "?")),
                model=str(meta.get("model", "")),
                exit_code=meta.get("exitCode") if isinstance(meta.get("exitCode"), int) else None,
                source="transcript",
                mode="?",  # headless: transcripts carry no permission telemetry
                calls=parse_transcript(transcript) if transcript else [],
                meta=meta,
            )
        )

    children.sort(key=lambda child: child.calls[0].ts if child.calls else 0.0)
    return children


def prepare_failures(session: Session, children: list[ChildRun]) -> None:
    """Set call.mode and retry markers before reporting or emitting events."""
    for call in session.calls.values():
        call.mode = mode_at(session, call.ts)
    mark_retries(list(session.calls.values()))
    for child in children:
        for call in child.calls:
            call.mode = child.mode
        mark_retries(child.calls)


def add_unit_lines(add, label: str, calls: list[Call], indent: str, verbose: bool) -> None:
    """The failure block of one execution unit (main session or one child)."""
    errored = [call for call in calls if call.error]
    aborted = [call for call in calls if call.error is None]
    retried = [call for call in errored if call.retried]
    repeated = [call for call in errored if call.retried and call.retry_error]
    rate = f"{100 * len(errored) / len(calls):.1f}%" if calls else "-"
    add(
        f"{indent}{label}: {len(calls)} calls · {len(errored)} errors ({rate}) · {len(aborted)} aborted · "
        f"retried-after-error {len(retried)} (recovered {len(retried) - len(repeated)}, failed again {len(repeated)})"
    )
    if not errored and not aborted:
        return

    calls_by_mode = Counter(call.mode or "?" for call in calls)
    errors_by_mode = Counter(call.mode or "?" for call in errored)
    if calls_by_mode:
        add(
            f"{indent}errors by mode: "
            + " · ".join(f"{mode} {errors_by_mode.get(mode, 0)}/{calls_by_mode[mode]}" for mode in calls_by_mode)
        )
    kinds = Counter(classify_error(call.error_text) for call in errored)
    if kinds:
        add(f"{indent}errors by kind: " + " · ".join(f"{kind} {count}" for kind, count in kinds.most_common()))

    by_tool: dict[str, list[Call]] = {}
    for call in calls:
        by_tool.setdefault(call.tool, []).append(call)
    add(f"{indent}by tool:")
    for tool, tool_calls in sorted(by_tool.items(), key=lambda item: (-sum(1 for c in item[1] if c.error), -len(item[1]))):
        tool_errors = [call for call in tool_calls if call.error]
        if not tool_errors and len(tool_calls) < 3:
            continue  # healthy and rarely used: keep the table short
        tool_kinds = Counter(classify_error(call.error_text) for call in tool_errors)
        tool_rate = f"{100 * len(tool_errors) / len(tool_calls):.1f}%" if tool_calls else "-"
        kind_text = " ".join(f"{kind}×{count}" for kind, count in tool_kinds.most_common(2))
        add(f"{indent}  {tool[:24]:<24} {len(tool_calls):>4} calls  {len(tool_errors):>3} err  {tool_rate:>6}  {kind_text}")

    top = Counter((call.tool, classify_error(call.error_text)) for call in errored)
    if top:
        add(f"{indent}top errors:")
        for (tool, kind), count in top.most_common(5):
            sample = next(call for call in errored if call.tool == tool and classify_error(call.error_text) == kind)
            add(f"{indent}  [{kind}] {tool}: {shrink(sample.error_text, 110)} ×{count}")

    if retried:
        add(f"{indent}retries after error (next same-tool call ≤{RETRY_WINDOW_MS // 1000}s):")
        for call in retried[:8]:
            outcome = "failed again" if call.retry_error else "recovered"
            add(f"{indent}  [{fmt_time(call.ts)}] {call.tool} error -> {outcome}")

    if verbose:
        for call in errored:
            add(f"{indent}  [{fmt_time(call.ts)}] [{classify_error(call.error_text)}] {call.tool}: {shrink(call.error_text, 140)}")


def failures_report(session: Session, children: list[ChildRun], verbose: bool = False) -> str:
    """One conversation's tool-calling failure scorecard: main session plus subagent children."""
    lines: list[str] = []
    add = lines.append
    add(f"=== failures: {os.path.basename(session.path)} ===")
    add(f"  main {session.session_id[:8]}  model {session.model or '?'}")

    timeline = mode_timeline(session)
    if timeline:
        sequence: list[str] = []
        for _, mode in timeline:
            if not sequence or sequence[-1] != mode:
                sequence.append(mode)
        add(f"  mode timeline: {'->'.join(sequence)} ({len(timeline)} change(s))")

    main_calls = sorted(session.calls.values(), key=lambda call: call.ts)
    add_unit_lines(add, "main", main_calls, "  ", verbose)

    if children:
        with_session = sum(1 for child in children if child.source == "session")
        add("")
        add(f"  subagents: {len(children)} ({with_session} with session file, {len(children) - with_session} transcript-only/headless)")
        add("  agent      run       mode  exit  calls  err   rate  kinds")
        for child in children:
            errored = [call for call in child.calls if call.error]
            kinds = Counter(classify_error(call.error_text) for call in errored)
            rate = f"{100 * len(errored) / len(child.calls):.1f}%" if child.calls else "-"
            kind_text = " ".join(f"{kind}×{count}" for kind, count in kinds.most_common(3)) or "-"
            exit_text = str(child.exit_code) if child.exit_code is not None else "?"
            add(
                f"  {child.agent[:10]:<10} {child.run_id[:8]:<8} {child.mode:<4}  {exit_text:>4}  {len(child.calls):>5}  {len(errored):>3}  {rate:>6}  {kind_text}"
            )
        for child in children:
            if not any(call.error for call in child.calls):
                continue
            add("")
            head = "headless" if child.source == "transcript" else f"mode {child.mode}"
            add(f"  child {child.agent} {child.run_id[:8]} ({head}, exit {child.exit_code})")
            add_unit_lines(add, f"child {child.agent}", child.calls, "    ", verbose)

    all_calls = list(main_calls) + [call for child in children for call in child.calls]
    all_errors = [call for call in all_calls if call.error]
    all_kinds = Counter(classify_error(call.error_text) for call in all_errors)
    rate = f"{100 * len(all_errors) / len(all_calls):.1f}%" if all_calls else "-"
    kind_text = " · ".join(f"{kind} {count}" for kind, count in all_kinds.most_common(5))
    add("")
    add(f"  totals: {len(all_calls)} calls · {len(all_errors)} errors ({rate})" + (f" · {kind_text}" if kind_text else ""))
    return "\n".join(lines)


def failure_events(session: Session, children: list[ChildRun]) -> Iterator[dict[str, Any]]:
    """NDJSON records for aggregation across sessions: one per unit, one per errored call."""

    def unit_records(unit: str, label: str, calls: list[Call], child: ChildRun | None = None) -> Iterator[dict[str, Any]]:
        errored = [call for call in calls if call.error]
        by_tool: dict[str, dict[str, int]] = {}
        for call in calls:
            slot = by_tool.setdefault(call.tool, {"calls": 0, "errors": 0})
            slot["calls"] += 1
            if call.error:
                slot["errors"] += 1
        record: dict[str, Any] = {
            "kind": "unit",
            "unit": unit,
            "label": label,
            "sessionFile": session.path,
            "sessionId": session.session_id,
            "model": (child.model if child is not None else session.model) or "",
            "calls": len(calls),
            "errors": len(errored),
            "errorRate": round(len(errored) / len(calls), 4) if calls else None,
            "aborted": sum(1 for call in calls if call.error is None),
            "retried": sum(1 for call in errored if call.retried),
            "byTool": by_tool,
            "byKind": dict(Counter(classify_error(call.error_text) for call in errored)),
            "byMode": dict(Counter(call.mode or "?" for call in errored)),
        }
        if child is not None:
            record.update(
                {
                    "agent": child.agent,
                    "runId": child.run_id,
                    "childMode": child.mode,
                    "childSource": child.source,
                    "exitCode": child.exit_code,
                }
            )
        yield record
        for call in errored:
            yield {
                "kind": "error",
                "unit": unit,
                "label": label,
                "sessionFile": session.path,
                "sessionId": session.session_id,
                "agent": child.agent if child is not None else "",
                "runId": child.run_id if child is not None else "",
                "mode": call.mode or "?",
                "tool": call.tool,
                "classification": classify_error(call.error_text),
                "text": call.error_text,
                "ts": call.ts,
                "durationMs": call.duration_ms,
                "retried": call.retried,
                "retryError": call.retry_error,
            }

    yield from unit_records("main", "main", sorted(session.calls.values(), key=lambda call: call.ts))
    for child in children:
        yield from unit_records("child", f"child {child.agent} {child.run_id[:8]}", child.calls, child)


def is_child_session(path: str) -> bool:
    """A subagent child's session file, nested under its parent's directory."""
    return os.path.basename(path) == "session.jsonl" and os.path.basename(os.path.dirname(path)).startswith("run-")


def latest_sessions(count: int) -> list[str]:
    files = sorted(glob.glob(os.path.join(SESSIONS_DIR, "**", "*.jsonl"), recursive=True), key=os.path.getmtime, reverse=True)
    files = [f for f in files if "/subagent-artifacts/" not in f and not is_child_session(f)]
    return files[:count]


def summarizer(session: Session, verbose: bool = False) -> str:
    lines: list[str] = []
    add = lines.append
    name = os.path.basename(session.path)
    add(f"=== {name} ===")
    add(f"  cwd: {session.cwd or '?'}   started: {session.started or '?'}")
    if session.model:
        add(f"  model: {session.model}")
    add(f"  turns: {len(session.user_messages)} user message(s), {len(session.calls)} tool call(s)")
    if session.mode_changes:
        timeline = ", ".join(f"[{fmt_time(ts)}] {shrink(change, 40)}" for ts, change in session.mode_changes)
        add(f"  mode timeline: {timeline}")
    if session.summaries:
        runs = ", ".join(
            "{{cmds {0}, reads {1}, edits {2}, writes {3}, failed {4}, {5:.1f}s}}".format(
                s.get("commands", 0),
                s.get("reads", 0),
                s.get("edits", 0),
                s.get("writes", 0),
                s.get("failed", 0),
                s.get("durationMs", 0) / 1000,
            )
            for s in session.summaries
        )
        add(f"  agent runs: {runs}")
    for ts, text in session.user_messages:
        add(f"  [{fmt_time(ts)}] user: {text}")

    if not session.has_telemetry:
        add("  [no pi-keeper telemetry — timeline only; session predates it or extension inactive]")
        hinted = 0
        for call_id, call in session.calls.items():
            if call.duration_ms is not None and call.duration_ms > GAP_HINT_MS:
                hinted += 1
                add(f"    [{fmt_time(call.ts)}] slow {call.tool} ({round(call.duration_ms / 1000, 1)}s, possible dialog): {shrink(call.command, 90)}")
        errors = [call for call in session.calls.values() if call.error]
        for call in errors:
            add(f"    [{fmt_time(call.ts)}] error {call.tool}: {shrink(call.command, 90)}")
        add(f"  hinted dialogs (>{GAP_HINT_MS // 1000}s): {hinted}   errored calls: {len(errors)}")
        add("")
        return "\n".join(lines)

    decisions = [e for e in session.telemetry if e.get("phase") in ("decide", "redecide")]
    choices = [e for e in session.telemetry if e.get("phase") == "choice"]

    by_action = Counter(str(e.get("action")) for e in decisions)
    add(
        f"  decisions: {len(decisions)} "
        f"(allow {by_action.get('allow', 0)}, ask {by_action.get('ask', 0)}, deny {by_action.get('deny', 0)})"
    )

    # The flow: every call in time order — silent allows and denies one line
    # each, each popup as a block with the options offered and the answer.
    add("  flow:")
    choices_by_id: dict[str, dict[str, Any]] = {}
    for event in choices:
        choices_by_id.setdefault(str(event.get("toolCallId", "")), event)
    consumed: set[str] = set()
    blocks: list[tuple[float, list[str]]] = []
    for event in session.telemetry:
        phase = event.get("phase")
        ts = event.get("_ts", 0)
        if phase == "redecide" and not verbose:
            continue
        if phase in ("decide", "redecide"):
            call_id = str(event.get("toolCallId", ""))
            choice = choices_by_id.get(call_id) if event.get("action") == "ask" else None
            if choice is not None:
                consumed.add(call_id)
            blocks.append((ts, decision_lines(event, choice, verbose)))
        elif phase in ("pattern", "plan", "rules-review"):
            blocks.append((ts, other_lines(phase, event)))
    for call_id, choice in choices_by_id.items():
        if call_id not in consumed:
            blocks.append((choice.get("_ts", 0), decision_lines(None, choice, verbose)))
    blocks.sort(key=lambda block: block[0])
    for _, block in blocks:
        lines.extend(block)

    outcomes = Counter(str(e.get("outcome")) for e in choices)
    if outcomes:
        add(f"  dialog outcomes: {', '.join(f'{k} {v}' for k, v in outcomes.most_common())}")
    waits = [e.get("waitMs", 0) for e in choices if e.get("waitMs")]
    if waits:
        add(f"  dialog waits: median {round(statistics.median(waits) / 1000, 1)}s, max {round(max(waits) / 1000, 1)}s")
    add("")
    return "\n".join(lines)


def decision_lines(event: dict[str, Any] | None, choice: dict[str, Any] | None, verbose: bool) -> list[str]:
    """One line for a silent allow/deny; a block for a popup with its answer."""
    if choice is None and event is not None:
        matcher = event.get("matcher") or "fallback"
        redecide = " (redecide)" if event.get("phase") == "redecide" else ""
        error = " [call errored]" if verbose and (event.get("_exec") or {}).get("error") else ""
        return [f"    [{fmt_time(event.get('_ts', 0))}] {event.get('mode', '?')} {event.get('action', '?')}/{matcher}{redecide} \"{shrink(str(event.get('target', '')), 80)}\"{error}"]
    if event is None:
        # a choice without its decision (shouldn't happen)
        event = choice if choice is not None else {}
    ts = fmt_time(event.get("_ts", 0) or (choice or {}).get("_ts", 0))
    matcher = event.get("matcher") or "fallback"
    lines = [f"    [{ts}] {event.get('mode', '?')} ASK/{matcher} {event.get('tool', '?')} \"{shrink(str(event.get('target', '')), 80)}\""]
    if choice is not None:
        options = (choice.get("options") or {}).get("primary") or []
        if options:
            lines.append(f"        options: {' · '.join(shrink(o, 50) for o in options)}")
        answer = choice.get("choice")
        outcome = str(choice.get("outcome", "?"))
        if answer:
            answer_text = f'"{shrink(str(answer), 60)}"'
        elif outcome == "no-ui":
            answer_text = "(no dialog: headless run)"
        elif outcome == "auto-reject":
            answer_text = "(no dialog: auto-rejected after an earlier Reject)"
        else:
            answer_text = "(no answer: Esc/abort)"
        extras = []
        if choice.get("remembered"):
            extras.append(f"remembered {choice['remembered']}")
        if choice.get("feedback"):
            extras.append(f'feedback "{shrink(str(choice["feedback"]), 60)}"')
        suffix = f" ({'; '.join(extras)})" if extras else ""
        wait = round(choice.get("waitMs", 0) / 1000, 1)
        lines.append(f"        answer: {answer_text} -> {outcome} in {wait}s{suffix}")
    else:
        lines.append("        (no answer recorded: headless run or session ended)")
    return lines


def other_lines(phase: str, event: dict[str, Any]) -> list[str]:
    ts = fmt_time(event.get("_ts", 0))
    if phase == "pattern":
        return [f"    [{ts}] pattern {event.get('pattern')} -> {event.get('scope')}"]
    if phase == "plan":
        feedback = f" ({shrink(str(event.get('feedback')), 60)})" if event.get("feedback") else ""
        return [f"    [{ts}] plan approval -> {event.get('outcome')}{feedback}"]
    return [f"    [{ts}] rules review ({event.get('rules', '?')} rules) -> {event.get('choice')}"]


# Dialog outcomes by what the user decided: the rest (no-ui, auto-reject) never reached a person.
APPROVING = {
    "allow-once", "remember-session", "remember-project", "pattern-flow", "allow-edits",
    "switch-auto", "outside-reads", "outside-read-dirs", "project-read-approvals",
}
REJECTING = {"reject", "reject-feedback"}


def percentile(values: list[float], p: float) -> float:
    """The p-th percentile by nearest rank: no interpolation, so a small sample stays honest."""
    ordered = sorted(values)
    if not ordered:
        return 0.0
    rank = max(1, min(len(ordered), round(p / 100 * len(ordered) + 0.5)))
    return ordered[rank - 1]


def stats_report(sessions: list[Session]) -> str:
    """Aggregate permission telemetry per model: what asks, what the user answers, what plans do.

    Waits include time the user was away, so the wait totals are an upper
    bound. The model comes from the session's last model_change entry.
    """
    groups: dict[str, list[Session]] = {}
    skipped = 0
    for session in sessions:
        if not session.has_telemetry:
            skipped += 1
            continue
        groups.setdefault(session.model or "?", []).append(session)
    lines: list[str] = []
    add = lines.append
    add(f"sessions with telemetry: {sum(len(g) for g in groups.values())} (skipped without: {skipped})")
    for model, group in sorted(groups.items()):
        events = [e for session in group for e in session.telemetry]
        decisions = [e for e in events if e.get("phase") == "decide"]
        choices = [e for e in events if e.get("phase") == "choice"]
        plans = [e for e in events if e.get("phase") == "plan"]
        by_action = Counter(str(e.get("action")) for e in decisions)
        add("")
        add(f"== {model}: {len(group)} session(s), {len(decisions)} decisions "
            f"(allow {by_action.get('allow', 0)}, ask {by_action.get('ask', 0)}, deny {by_action.get('deny', 0)})")
        versions = sorted({str(e.get("promptVersion")) for e in events if e.get("phase") == "session" and e.get("promptVersion")})
        if versions:
            add(f"  prompt version(s): {', '.join(versions)}")
        timed = [float(e["decideMs"]) for e in events if isinstance(e.get("decideMs"), (int, float))]
        if timed:
            add(f"  decision cost: p50 {percentile(timed, 50):.2f} ms, p95 {percentile(timed, 95):.2f} ms, max {max(timed):.2f} ms (n={len(timed)})")
        asks = Counter((str(e.get("mode")), str(e.get("matcher") or "fallback"), str(e.get("tool"))) for e in decisions if e.get("action") == "ask")
        if asks:
            add("  asks by (mode, matcher, tool):")
            for (mode, matcher, tool), count in asks.most_common(12):
                add(f"    {count:4d}  {mode}/{matcher}  {tool}")
        denies = Counter((str(e.get("mode")), str(e.get("tool"))) for e in decisions if e.get("action") == "deny")
        if denies:
            add("  denies by (mode, tool): " + ", ".join(f"{m}/{t} {n}" for (m, t), n in denies.most_common(8)))
        outcomes = Counter(str(e.get("outcome")) for e in choices)
        if outcomes:
            approved = sum(n for k, n in outcomes.items() if k in APPROVING)
            rejected = sum(n for k, n in outcomes.items() if k in REJECTING)
            answered = approved + rejected
            rate = f"{100 * approved / answered:.0f}%" if answered else "n/a"
            add(f"  dialogs: {sum(outcomes.values())} ({', '.join(f'{k} {v}' for k, v in outcomes.most_common())})")
            add(f"  approval rate: {rate} ({approved} approved, {rejected} rejected)")
        waits = [e.get("waitMs", 0) for e in choices if e.get("waitMs")]
        if waits:
            add(f"  dialog wait (upper bound, includes time away): median {statistics.median(waits) / 1000:.1f}s, p95 {percentile([float(w) for w in waits], 95) / 1000:.1f}s, max {max(waits) / 1000:.1f}s, total {sum(waits) / 60000:.1f} min")
        if plans:
            add("  plan approvals: " + ", ".join(f"{k} {v}" for k, v in Counter(str(e.get("outcome")) for e in plans).most_common()))
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*", help="session .jsonl files (or directories to scan)")
    parser.add_argument("--latest", nargs="?", type=int, const=1, metavar="N", help="analyze the N newest sessions (default 1)")
    parser.add_argument("--json", action="store_true", help="print enriched events as NDJSON instead of the summary")
    parser.add_argument("--stats", action="store_true", help="print one aggregate per model over all given sessions instead of per-session flows")
    parser.add_argument("--failures", action="store_true", help="tool-calling failure scorecard: the session AND its subagent children (errors by kind, tool and mode; retries; aborted calls; --json emits NDJSON units and error events for aggregation)")
    parser.add_argument("-v", "--verbose", action="store_true", help="also show redecide events and errored calls in the flow")
    args = parser.parse_args()

    files: list[str] = []
    if args.latest is not None:
        files.extend(latest_sessions(max(1, args.latest)))
    for path in args.paths:
        if os.path.isdir(path):
            files.extend(sorted(glob.glob(os.path.join(path, "**", "*.jsonl"), recursive=True)))
        else:
            files.append(path)
    if not files:
        parser.error("no session files given (pass paths, or --latest [N])")

    exit_code = 0
    loaded: list[Session] = []
    for path in files:
        try:
            session = load_session(path)
        except (OSError, json.JSONDecodeError) as error:
            print(f"error reading {path}: {error}", file=sys.stderr)
            exit_code = 1
            continue
        if args.failures:
            children = load_children(session)
            prepare_failures(session, children)
            if args.json:
                for event in failure_events(session, children):
                    print(json.dumps(event, ensure_ascii=False))
            else:
                print(failures_report(session, children, verbose=args.verbose))
            continue
        if args.stats:
            loaded.append(session)
            continue
        if args.json:
            for event in enrich(session):
                event["session"] = {"id": session.session_id, "file": path, "cwd": session.cwd}
                print(json.dumps(event, ensure_ascii=False))
        else:
            print(summarizer(session, verbose=args.verbose))
    if args.stats:
        print(stats_report(loaded))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
