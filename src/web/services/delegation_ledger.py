"""Delegation evidence ledger for project lanes and specialist attribution.

This service ingests normalized activity events and keeps a compact, persisted
record of who was assigned, worked, reported, or completed work per project.
"""

from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone
from threading import RLock
from typing import Any

import yaml

from src.agents import AGENT_REGISTRY, get_agent_display_name
from src.utils import atomic_yaml_write

LIVE_STATES = {"assigned", "working", "reporting", "blocked"}
TERMINAL_STATES = {"completed", "failed"}
MAX_RECORDS = 4000
NON_WORKERS = {"", "ceo", "system", "workspace", "chairman", "board_head"}


def _safe_iso(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return datetime.now(timezone.utc).isoformat()
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return datetime.now(timezone.utc).isoformat()


def _parse_iso(value: str) -> datetime:
    try:
        return datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return datetime.fromtimestamp(0, timezone.utc)


def _slug(value: str) -> str:
    return str(value or "").strip().lower().replace(" ", "-")


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
    if len(text) > 180:
        return f"{text[:177].rstrip()}..."
    return text


def _is_non_worker(agent_id: str) -> bool:
    return _slug(agent_id) in NON_WORKERS


def _derive_source(meta: dict[str, Any]) -> str:
    source = str(meta.get("source", "") or "").strip().lower()
    if source in {"real", "synthetic"}:
        return source
    if str(meta.get("tool", "") or "").strip().lower() == "synthetic_delegation":
        return "synthetic"
    return "real"


def _derive_work_state(event: dict[str, Any], meta: dict[str, Any]) -> str:
    explicit = str(meta.get("work_state", "") or "").strip().lower()
    if explicit in LIVE_STATES or explicit in TERMINAL_STATES:
        return explicit

    action = str(event.get("action", "") or "").strip().upper()
    state = str(meta.get("state", "") or "").strip().lower()
    flow = str(meta.get("flow", "") or "").strip().lower()
    source_agent = _slug(str(meta.get("source_agent", "") or ""))
    target_agent = _slug(str(meta.get("target_agent", "") or ""))

    if action in {"BLOCKED", "ERROR", "FAILED"} or state == "failed":
        return "blocked"
    if action in {"COMPLETED", "DONE"} or state == "completed":
        return "completed"
    if action in {"DELEGATED", "ASSIGNED"}:
        return "assigned"
    if action == "UPDATED" and flow == "up" and not _is_non_worker(source_agent):
        return "reporting"
    if action in {"STARTED", "CREATED"}:
        if not _is_non_worker(source_agent):
            return "working"
        if flow == "down" and not _is_non_worker(target_agent):
            return "assigned"
        return "working"
    if flow == "up" and not _is_non_worker(source_agent):
        return "reporting"
    return "working"


def _derive_agent_id(event: dict[str, Any], meta: dict[str, Any], work_state: str) -> str:
    source_agent = _slug(str(meta.get("source_agent", "") or ""))
    target_agent = _slug(str(meta.get("target_agent", "") or ""))
    event_agent = _slug(str(event.get("agent", "") or ""))

    if work_state == "assigned":
        candidate = target_agent or event_agent or source_agent
    elif work_state in {"working", "reporting", "blocked", "completed", "failed"}:
        candidate = source_agent or event_agent or target_agent
    else:
        candidate = event_agent or source_agent or target_agent

    if _is_non_worker(candidate):
        fallback = target_agent if not _is_non_worker(target_agent) else source_agent
        candidate = fallback if not _is_non_worker(fallback) else ""
    return candidate


def _lane_status_from_work_state(work_state: str) -> str:
    normalized = str(work_state or "").strip().lower()
    if normalized == "working":
        return "in_progress"
    if normalized == "reporting":
        return "review"
    if normalized in {"blocked", "failed"}:
        return "blocked"
    if normalized == "completed":
        return "done"
    return "todo"


def _lane_status_rank(status: str) -> int:
    normalized = str(status or "").strip().lower()
    if normalized == "in_progress":
        return 0
    if normalized == "blocked":
        return 1
    if normalized == "review":
        return 2
    if normalized == "todo":
        return 3
    if normalized == "done":
        return 4
    return 5


class DelegationLedgerService:
    """Stores specialist assignment/execution evidence for UI consumption."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.snapshot_path = os.path.join(data_dir, "delegation_ledger.yaml")
        self._lock = RLock()
        self._records: dict[str, dict[str, Any]] = {}
        os.makedirs(self.data_dir, exist_ok=True)
        self._load_snapshot()

    def _load_snapshot(self) -> None:
        if not os.path.exists(self.snapshot_path):
            return
        try:
            with open(self.snapshot_path) as handle:
                parsed = yaml.safe_load(handle) or {}
        except (OSError, yaml.YAMLError):
            return
        records = parsed.get("records", [])
        if not isinstance(records, list):
            return
        with self._lock:
            for row in records:
                if not isinstance(row, dict):
                    continue
                record_id = str(row.get("record_id", "") or "").strip()
                project_id = str(row.get("project_id", "") or "").strip()
                agent_id = _slug(str(row.get("agent_id", "") or ""))
                if not record_id or not project_id or not agent_id or _is_non_worker(agent_id):
                    continue
                self._records[record_id] = {
                    "record_id": record_id,
                    "project_id": project_id,
                    "run_id": str(row.get("run_id", "") or "").strip(),
                    "agent_id": agent_id,
                    "agent_name": str(row.get("agent_name", "") or get_agent_display_name(agent_id)),
                    "task": _sanitize_task_text(str(row.get("task", "") or "")),
                    "work_state": str(row.get("work_state", "assigned") or "assigned"),
                    "lane_status": str(row.get("lane_status", "todo") or "todo"),
                    "source": str(row.get("source", "real") or "real"),
                    "started_at": _safe_iso(str(row.get("started_at", "") or "")),
                    "updated_at": _safe_iso(str(row.get("updated_at", "") or "")),
                }

    def _persist_locked(self) -> None:
        rows = sorted(
            self._records.values(),
            key=lambda entry: str(entry.get("updated_at", "")),
            reverse=True,
        )[:MAX_RECORDS]
        payload = {
            "as_of": datetime.now(timezone.utc).isoformat(),
            "records": rows,
        }
        atomic_yaml_write(self.snapshot_path, payload)

    @staticmethod
    def _build_record_id(
        *,
        project_id: str,
        run_id: str,
        agent_id: str,
        task: str,
        explicit: str = "",
    ) -> str:
        raw_explicit = str(explicit or "").strip()
        if raw_explicit:
            return raw_explicit
        if run_id and agent_id:
            return f"{run_id}:{agent_id}"
        hashed = hashlib.sha1((task or "").encode("utf-8")).hexdigest()[:12] if task else "notask"
        return f"{project_id}:{agent_id}:{hashed}"

    def ingest_event(self, event: dict[str, Any]) -> None:
        if not isinstance(event, dict):
            return
        meta = event.get("metadata", {}) if isinstance(event.get("metadata"), dict) else {}
        project_id = str(event.get("project_id", "") or meta.get("project_id", "") or "").strip()
        if not project_id:
            return
        work_state = _derive_work_state(event, meta)
        if work_state not in LIVE_STATES and work_state not in TERMINAL_STATES:
            return
        source = _derive_source(meta)
        # Keep synthetic evidence as planning-only signal.
        if source == "synthetic":
            if work_state in {"working", "reporting", "blocked", "failed"}:
                work_state = "assigned"
            elif work_state == "completed":
                return

        agent_id = _derive_agent_id(event, meta, work_state)
        if not agent_id or _is_non_worker(agent_id):
            return

        task = _sanitize_task_text(
            str(meta.get("task", "") or event.get("detail", "") or "")
        )[:280]
        run_id = str(meta.get("run_id", "") or "").strip()
        timestamp = _safe_iso(str(event.get("timestamp", "") or ""))
        record_id = self._build_record_id(
            project_id=project_id,
            run_id=run_id,
            agent_id=agent_id,
            task=task,
            explicit=str(meta.get("work_item_id", "") or ""),
        )
        lane_status = _lane_status_from_work_state(work_state)
        agent_name = str(
            AGENT_REGISTRY.get(agent_id, {}).get("name", get_agent_display_name(agent_id))
            or get_agent_display_name(agent_id)
        )

        with self._lock:
            existing = self._records.get(record_id)
            started_at = str(existing.get("started_at", "")) if isinstance(existing, dict) else ""
            if not started_at:
                started_at = timestamp
            self._records[record_id] = {
                "record_id": record_id,
                "project_id": project_id,
                "run_id": run_id,
                "agent_id": agent_id,
                "agent_name": agent_name,
                "task": task or (str(existing.get("task", "")) if isinstance(existing, dict) else ""),
                "work_state": work_state,
                "lane_status": lane_status,
                "source": source,
                "started_at": started_at,
                "updated_at": timestamp,
            }
            if len(self._records) > MAX_RECORDS:
                stale_keys = sorted(
                    self._records.keys(),
                    key=lambda key: _parse_iso(str(self._records[key].get("updated_at", ""))),
                )[: max(1, len(self._records) - MAX_RECORDS)]
                for key in stale_keys:
                    self._records.pop(key, None)
            self._persist_locked()

    def project_lanes(self, project_id: str, *, limit: int = 8) -> list[dict[str, str]]:
        normalized_project_id = str(project_id or "").strip()
        if not normalized_project_id:
            return []
        with self._lock:
            rows = [
                dict(row)
                for row in self._records.values()
                if str(row.get("project_id", "") or "") == normalized_project_id
            ]
        if not rows:
            return []

        best_by_owner: dict[str, dict[str, Any]] = {}
        for row in rows:
            owner = str(row.get("agent_name", "") or get_agent_display_name(str(row.get("agent_id", "") or ""))).strip()
            headline = _sanitize_task_text(str(row.get("task", "") or "")).strip()
            lane_status = str(row.get("lane_status", "todo") or "todo").strip().lower()
            source = str(row.get("source", "real") or "real").strip().lower()
            updated_at = str(row.get("updated_at", "") or "").strip()
            run_id = str(row.get("run_id", "") or "").strip()
            if not owner:
                continue
            if not headline:
                state_name = str(row.get("work_state", "assigned") or "assigned").replace("_", " ")
                headline = f"{state_name.title()} work stream"
            candidate = {
                "owner": owner,
                "headline": headline,
                "status": lane_status,
                "source": "synthetic" if source == "synthetic" else "real",
                "evidence_level": "planned" if source == "synthetic" else "observed",
                "updated_at": updated_at,
                "run_id": run_id,
            }
            existing = best_by_owner.get(owner)
            if existing is None:
                best_by_owner[owner] = candidate
                continue
            existing_rank = _lane_status_rank(str(existing.get("status", "")))
            candidate_rank = _lane_status_rank(lane_status)
            if candidate_rank < existing_rank:
                best_by_owner[owner] = candidate
                continue
            if candidate_rank == existing_rank:
                existing_source = str(existing.get("source", "synthetic") or "synthetic")
                if existing_source == "synthetic" and source == "real":
                    best_by_owner[owner] = candidate
                    continue
                if updated_at > str(existing.get("updated_at", "") or ""):
                    best_by_owner[owner] = candidate

        lanes = sorted(
            best_by_owner.values(),
            key=lambda lane: (
                _lane_status_rank(str(lane.get("status", ""))),
                0 if str(lane.get("source", "real")) == "real" else 1,
                str(lane.get("owner", "")).lower(),
            ),
        )
        if limit > 0:
            lanes = lanes[:limit]
        return [
            {
                "owner": str(item.get("owner", "") or ""),
                "headline": str(item.get("headline", "") or ""),
                "status": str(item.get("status", "todo") or "todo"),
                "source": str(item.get("source", "real") or "real"),
                "evidence_level": str(item.get("evidence_level", "observed") or "observed"),
                "updated_at": str(item.get("updated_at", "") or ""),
                "run_id": str(item.get("run_id", "") or ""),
            }
            for item in lanes
        ]
