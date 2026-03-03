"""Run progress normalization and watchdog helpers.

This module is intentionally provider-agnostic so API and websocket layers can
share the same run status/incident contract.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any


ACTIVE_RUN_STATES = {"queued", "planning", "executing", "verifying"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _derive_phase_label(run: dict[str, Any]) -> str:
    timeline = run.get("timeline", [])
    if isinstance(timeline, list) and timeline:
        latest = timeline[-1]
        if isinstance(latest, dict):
            label = str(latest.get("label", "") or "").strip()
            if label:
                return label
    state = str(run.get("status", "") or "").strip().lower()
    if state == "queued":
        return "Run queued"
    if state == "planning":
        return "Planning"
    if state == "executing":
        return "Executing"
    if state == "verifying":
        return "Verifying"
    if state == "done":
        return "Completed"
    if state == "failed":
        return "Failed"
    if state == "cancelled":
        return "Cancelled"
    return "Running"


def _derive_elapsed_seconds(run: dict[str, Any], guardrails: dict[str, Any]) -> int:
    try:
        explicit = int(guardrails.get("elapsed_seconds", 0) or 0)
        if explicit > 0:
            return explicit
    except (TypeError, ValueError):
        pass
    started_at = _parse_iso(str(run.get("started_at", "") or "")) or _parse_iso(str(run.get("created_at", "") or ""))
    if started_at is None:
        return 0
    return max(0, int((_utcnow() - started_at).total_seconds()))


def _derive_last_activity_at(run: dict[str, Any]) -> str:
    for key in ("updated_at", "started_at", "created_at"):
        value = str(run.get(key, "") or "").strip()
        if value:
            return value
    return _utcnow_iso()


def _normalize_guardrails(guardrails: dict[str, Any]) -> dict[str, Any]:
    return {
        "command_budget_remaining": int(guardrails.get("command_budget_remaining", 0) or 0),
        "file_budget_remaining": int(guardrails.get("file_budget_remaining", 0) or 0),
        "runtime_budget_remaining": int(guardrails.get("runtime_budget_remaining", 0) or 0),
        "over_budget": bool(guardrails.get("over_budget", False)),
    }


def _sanitize_task_text(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\b\d+\s*→\s*", " ", text)
    text = text.replace("→", " ")
    text = text.replace("\n", " ").replace("\r", " ").replace("\t", " ")
    text = re.sub(r"\s+", " ", text).strip(" -:;.,")
    if not text:
        return ""
    alnum_chars = sum(1 for ch in text if ch.isalnum())
    if alnum_chars == 0:
        return "Task update in progress"
    if len(text) > 180:
        text = f"{text[:177].rstrip()}..."
    return text


def _build_active_agents(workforce_snapshot: dict[str, Any], run_id: str) -> list[dict[str, Any]]:
    workers = workforce_snapshot.get("workers", [])
    if not isinstance(workers, list):
        return []
    result: list[dict[str, Any]] = []
    for worker in workers:
        if not isinstance(worker, dict):
            continue
        if str(worker.get("run_id", "") or "") != run_id:
            continue
        agent_id = str(worker.get("agent_id", "") or "").strip()
        agent_name = str(worker.get("agent_name", "") or agent_id).strip()
        state = str(worker.get("state", "") or "").strip()
        task = _sanitize_task_text(str(worker.get("task", "") or ""))
        if not agent_id or not agent_name:
            continue
        payload: dict[str, Any] = {
            "agent_id": agent_id,
            "agent_name": agent_name,
            "state": state or "working",
        }
        if task:
            payload["task"] = task
        result.append(payload)
    return result


def build_run_status_payload(
    run: dict[str, Any],
    *,
    guardrails: dict[str, Any] | None = None,
    workforce_snapshot: dict[str, Any] | None = None,
    heartbeat_seq: int = 0,
) -> dict[str, Any]:
    """Build normalized run status payload for WS and REST surfaces."""
    run_id = str(run.get("id", "") or "")
    project_id = str(run.get("project_id", "") or "")
    state = str(run.get("status", "") or "").strip().lower() or "queued"
    guardrail_payload = _normalize_guardrails(guardrails or {})
    workforce = workforce_snapshot or {}
    return {
        "run_id": run_id,
        "project_id": project_id,
        "state": state,
        "phase_label": _derive_phase_label(run),
        "elapsed_seconds": _derive_elapsed_seconds(run, guardrails or {}),
        "last_activity_at": _derive_last_activity_at(run),
        "active_agents": _build_active_agents(workforce, run_id),
        "guardrails": guardrail_payload,
        "heartbeat_seq": max(0, int(heartbeat_seq)),
    }


def detect_run_incident(
    run_status: dict[str, Any],
    *,
    warning_seconds: int,
    critical_seconds: int,
) -> dict[str, Any] | None:
    """Return watchdog incident payload when a run appears stalled/risky."""
    state = str(run_status.get("state", "") or "").strip().lower()
    if state not in ACTIVE_RUN_STATES:
        return None
    last_activity_at = _parse_iso(str(run_status.get("last_activity_at", "") or ""))
    if last_activity_at is None:
        return None
    inactive_seconds = max(0, int((_utcnow() - last_activity_at).total_seconds()))
    warning_threshold = max(30, int(warning_seconds))
    critical_threshold = max(warning_threshold, int(critical_seconds))
    if inactive_seconds < warning_threshold:
        return None
    severity = "critical" if inactive_seconds >= critical_threshold else "warning"

    guardrails = run_status.get("guardrails", {}) if isinstance(run_status.get("guardrails"), dict) else {}
    over_budget = bool(guardrails.get("over_budget", False))
    if over_budget:
        reason = "guardrail_risk"
    elif inactive_seconds >= max(critical_threshold + 45, critical_threshold * 2):
        reason = "provider_stall"
    else:
        reason = "silent_run"

    return {
        "run_id": str(run_status.get("run_id", "") or ""),
        "severity": severity,
        "reason": reason,
        "inactive_seconds": inactive_seconds,
        "suggested_actions": ["status", "retry_step", "cancel", "continue"],
        "default_action": "status",
    }
