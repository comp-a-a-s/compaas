"""Canonical live workforce presence service.

Tracks who is currently assigned/working/reporting/blocked using normalized
activity events so all UI surfaces can render from one source of truth.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from threading import RLock
from typing import Any

import yaml

from src.agents import AGENT_REGISTRY, get_agent_display_name
from src.utils import atomic_yaml_write
from src.web.services.run_service import RunService, TERMINAL_STATES

LIVE_STATES = {"assigned", "working", "reporting", "blocked"}
TERMINAL_WORK_STATES = {"completed", "failed"}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_iso(value: str) -> str:
    """Return normalized ISO-8601 value or current UTC timestamp."""
    raw = str(value or "").strip()
    if not raw:
        return _utcnow_iso()
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return _utcnow_iso()


def _agent_slug(value: str) -> str:
    return str(value or "").strip().lower().replace(" ", "-")


def _is_non_worker(agent_id: str) -> bool:
    return agent_id in {"", "ceo", "system", "workspace", "chairman", "board_head"}


class WorkforcePresenceService:
    """Maintains canonical in-memory + persisted workforce live state."""

    def __init__(self, data_dir: str, *, run_service: RunService | None = None):
        self.data_dir = data_dir
        self.run_service = run_service
        self.snapshot_path = os.path.join(data_dir, "workforce_presence.yaml")
        self._lock = RLock()
        self._workers: dict[str, dict[str, Any]] = {}
        self._seen_event_ids: list[str] = []
        self._seen_event_set: set[str] = set()
        self._max_seen_event_ids = 3000
        os.makedirs(self.data_dir, exist_ok=True)
        self._load_snapshot()

    def _load_snapshot(self) -> None:
        if not os.path.exists(self.snapshot_path):
            return
        try:
            with open(self.snapshot_path) as f:
                parsed = yaml.safe_load(f) or {}
        except (OSError, yaml.YAMLError):
            return
        workers = parsed.get("workers", [])
        if not isinstance(workers, list):
            return
        with self._lock:
            for row in workers:
                if not isinstance(row, dict):
                    continue
                work_item_id = str(row.get("work_item_id", "") or "").strip()
                agent_id = _agent_slug(str(row.get("agent_id", "") or ""))
                state = str(row.get("state", "") or "").strip().lower()
                if not work_item_id or not agent_id or state not in LIVE_STATES:
                    continue
                self._workers[work_item_id] = {
                    "work_item_id": work_item_id,
                    "agent_id": agent_id,
                    "agent_name": str(row.get("agent_name", "") or get_agent_display_name(agent_id)),
                    "state": state,
                    "project_id": str(row.get("project_id", "") or ""),
                    "run_id": str(row.get("run_id", "") or ""),
                    "task": str(row.get("task", "") or ""),
                    "source": str(row.get("source", "real") or "real"),
                    "started_at": _safe_iso(str(row.get("started_at", "") or "")),
                    "updated_at": _safe_iso(str(row.get("updated_at", "") or "")),
                }

    def _persist_locked(self) -> None:
        workers = sorted(
            self._workers.values(),
            key=lambda item: str(item.get("updated_at", "")),
            reverse=True,
        )
        counts = {
            "assigned": sum(1 for row in workers if row.get("state") == "assigned"),
            "working": sum(1 for row in workers if row.get("state") == "working"),
            "reporting": sum(1 for row in workers if row.get("state") == "reporting"),
            "blocked": sum(1 for row in workers if row.get("state") == "blocked"),
        }
        payload = {
            "as_of": _utcnow_iso(),
            "counts": counts,
            "workers": workers,
        }
        atomic_yaml_write(self.snapshot_path, payload)

    @staticmethod
    def _event_id(event: dict[str, Any]) -> str:
        meta = event.get("metadata", {}) if isinstance(event.get("metadata"), dict) else {}
        key = "|".join(
            [
                str(event.get("timestamp", "") or ""),
                str(event.get("agent", "") or ""),
                str(event.get("action", "") or ""),
                str(event.get("project_id", "") or ""),
                str(event.get("detail", "") or ""),
                str(meta.get("run_id", "") or ""),
                str(meta.get("work_item_id", "") or ""),
                str(meta.get("work_state", "") or ""),
                str(meta.get("task", "") or ""),
            ]
        )
        return hashlib.sha1(key.encode("utf-8")).hexdigest()

    def _remember_event_id_locked(self, event_id: str) -> bool:
        """Return True when event is new and should be processed."""
        if event_id in self._seen_event_set:
            return False
        self._seen_event_ids.append(event_id)
        self._seen_event_set.add(event_id)
        if len(self._seen_event_ids) > self._max_seen_event_ids:
            stale = self._seen_event_ids.pop(0)
            self._seen_event_set.discard(stale)
        return True

    @staticmethod
    def _derive_source(meta: dict[str, Any]) -> str:
        source = str(meta.get("source", "") or "").strip().lower()
        if source in {"real", "synthetic"}:
            return source
        if str(meta.get("tool", "") or "").strip().lower() == "synthetic_delegation":
            return "synthetic"
        return "real"

    @staticmethod
    def _derive_work_state(event: dict[str, Any], meta: dict[str, Any]) -> str:
        explicit = str(meta.get("work_state", "") or "").strip().lower()
        if explicit in LIVE_STATES or explicit in TERMINAL_WORK_STATES:
            return explicit

        action = str(event.get("action", "") or "").strip().upper()
        flow = str(meta.get("flow", "") or "").strip().lower()
        state = str(meta.get("state", "") or "").strip().lower()
        source_agent = _agent_slug(str(meta.get("source_agent", "") or ""))
        target_agent = _agent_slug(str(meta.get("target_agent", "") or ""))

        if action in {"BLOCKED", "ERROR", "FAILED"} or state == "failed":
            return "blocked"
        if action in {"COMPLETED", "DONE"} or state == "completed":
            return "completed"
        if action == "UPDATED" and flow == "up" and not _is_non_worker(source_agent):
            return "reporting"
        if action in {"DELEGATED", "ASSIGNED"} or (flow == "down" and _is_non_worker(source_agent) and not _is_non_worker(target_agent)):
            return "assigned"
        if state == "started":
            if not _is_non_worker(source_agent):
                return "working"
            return "assigned" if flow == "down" else "working"
        if state == "running":
            return "working"
        if flow == "up" and not _is_non_worker(source_agent):
            return "reporting"
        return "working"

    @staticmethod
    def _derive_agent_id(event: dict[str, Any], meta: dict[str, Any], work_state: str) -> str:
        source_agent = _agent_slug(str(meta.get("source_agent", "") or ""))
        target_agent = _agent_slug(str(meta.get("target_agent", "") or ""))
        event_agent = _agent_slug(str(event.get("agent", "") or ""))

        if work_state == "assigned":
            candidate = target_agent or event_agent or source_agent
        elif work_state in {"working", "reporting", "blocked", "completed"}:
            candidate = source_agent or event_agent or target_agent
        else:
            candidate = event_agent or source_agent or target_agent

        if _is_non_worker(candidate):
            fallback = target_agent if not _is_non_worker(target_agent) else source_agent
            candidate = fallback if not _is_non_worker(fallback) else ""
        return candidate

    @staticmethod
    def _derive_work_item_id(
        meta: dict[str, Any],
        *,
        project_id: str,
        run_id: str,
        agent_id: str,
        task: str,
    ) -> str:
        explicit = str(meta.get("work_item_id", "") or "").strip()
        if explicit:
            return explicit
        if run_id and agent_id:
            return f"{run_id}:{agent_id}"
        task_hash = hashlib.sha1(task.encode("utf-8")).hexdigest()[:12] if task else "notask"
        if project_id and agent_id:
            return f"{project_id}:{agent_id}:{task_hash}"
        if agent_id:
            return f"{agent_id}:{task_hash}"
        return f"work:{task_hash}"

    def _ingest_event_locked(self, event: dict[str, Any]) -> None:
        meta = event.get("metadata", {}) if isinstance(event.get("metadata"), dict) else {}
        source = self._derive_source(meta)
        work_state = self._derive_work_state(event, meta)
        run_id = str(meta.get("run_id", "") or "").strip()
        project_id = str(event.get("project_id", "") or meta.get("project_id", "") or "").strip()
        task = str(meta.get("task", "") or event.get("detail", "") or "").strip()[:280]
        agent_id = self._derive_agent_id(event, meta, work_state)
        if _is_non_worker(agent_id):
            return

        # Synthetic delegation is planning-only evidence. Keep it visible as
        # "assigned" and never promote to working/reporting/blocked/completed.
        if source == "synthetic":
            if work_state in {"working", "reporting", "blocked", "failed"}:
                work_state = "assigned"
            elif work_state == "completed":
                return

        work_item_id = self._derive_work_item_id(
            meta,
            project_id=project_id,
            run_id=run_id,
            agent_id=agent_id,
            task=task,
        )
        if not work_item_id:
            return

        timestamp = _safe_iso(str(event.get("timestamp", "") or ""))
        existing = self._workers.get(work_item_id)

        # Completed work clears immediately (explicit requirement).
        if work_state == "completed":
            if work_item_id in self._workers:
                self._workers.pop(work_item_id, None)
                self._persist_locked()
            return
        if work_state == "failed":
            work_state = "blocked"
        if work_state not in LIVE_STATES:
            return

        started_at = str(existing.get("started_at", "")) if existing else ""
        if not started_at:
            started_at = timestamp

        agent_name = AGENT_REGISTRY.get(agent_id, {}).get("name", get_agent_display_name(agent_id))
        self._workers[work_item_id] = {
            "work_item_id": work_item_id,
            "agent_id": agent_id,
            "agent_name": str(agent_name or get_agent_display_name(agent_id)),
            "state": work_state,
            "project_id": project_id,
            "run_id": run_id,
            "task": task,
            "source": source,
            "started_at": started_at,
            "updated_at": timestamp,
        }
        self._persist_locked()

    def ingest_event(self, event: dict[str, Any]) -> None:
        """Ingest one normalized activity event."""
        if not isinstance(event, dict):
            return
        event_id = self._event_id(event)
        with self._lock:
            if not self._remember_event_id_locked(event_id):
                return
            self._ingest_event_locked(event)

    def _remove_terminal_run_workers_locked(self, run_id: str, project_id: str = "") -> None:
        if not run_id:
            return
        removed = False
        for work_item_id, row in list(self._workers.items()):
            if str(row.get("run_id", "") or "") != run_id:
                continue
            if project_id and str(row.get("project_id", "") or "") != project_id:
                continue
            if str(row.get("state", "") or "") == "blocked":
                continue
            self._workers.pop(work_item_id, None)
            removed = True
        if removed:
            self._persist_locked()

    def mark_run_terminal(self, run_id: str, project_id: str = "", terminal_state: str = "") -> None:
        """Clear non-blocked workers for terminal runs."""
        state = str(terminal_state or "").strip().lower()
        if state and state not in TERMINAL_STATES:
            return
        with self._lock:
            self._remove_terminal_run_workers_locked(str(run_id or "").strip(), str(project_id or "").strip())

    def _prune_terminal_runs_locked(self, project_id: str = "") -> None:
        if self.run_service is None:
            return
        try:
            runs = self.run_service.list_runs(limit=5000)
        except Exception:
            return
        terminal_ids = {
            str(run.get("id", "") or "")
            for run in runs
            if str(run.get("status", "") or "").strip().lower() in TERMINAL_STATES
        }
        if not terminal_ids:
            return
        changed = False
        for work_item_id, row in list(self._workers.items()):
            run_id = str(row.get("run_id", "") or "")
            if not run_id or run_id not in terminal_ids:
                continue
            if project_id and str(row.get("project_id", "") or "") != project_id:
                continue
            if str(row.get("state", "") or "") == "blocked":
                continue
            self._workers.pop(work_item_id, None)
            changed = True
        if changed:
            self._persist_locked()

    def snapshot(
        self,
        *,
        project_id: str | None = None,
        include_assigned: bool = True,
        include_reporting: bool = True,
    ) -> dict[str, Any]:
        """Return live workforce view for UI/API consumers."""
        project_filter = str(project_id or "").strip()
        with self._lock:
            self._prune_terminal_runs_locked(project_filter)
            now = datetime.now(timezone.utc)
            workers: list[dict[str, Any]] = []
            for row in self._workers.values():
                state = str(row.get("state", "") or "")
                if state not in LIVE_STATES:
                    continue
                if project_filter and str(row.get("project_id", "") or "") != project_filter:
                    continue
                if not include_assigned and state == "assigned":
                    continue
                if not include_reporting and state == "reporting":
                    continue
                started = _safe_iso(str(row.get("started_at", "") or ""))
                try:
                    elapsed = max(
                        0,
                        int((now - datetime.fromisoformat(started.replace("Z", "+00:00"))).total_seconds()),
                    )
                except ValueError:
                    elapsed = 0
                workers.append(
                    {
                        "work_item_id": str(row.get("work_item_id", "") or ""),
                        "agent_id": str(row.get("agent_id", "") or ""),
                        "agent_name": str(row.get("agent_name", "") or ""),
                        "state": state,
                        "project_id": str(row.get("project_id", "") or ""),
                        "run_id": str(row.get("run_id", "") or ""),
                        "task": str(row.get("task", "") or ""),
                        "source": str(row.get("source", "real") or "real"),
                        "started_at": started,
                        "updated_at": _safe_iso(str(row.get("updated_at", "") or "")),
                        "elapsed_seconds": elapsed,
                    }
                )

        workers.sort(key=lambda item: str(item.get("updated_at", "")), reverse=True)
        counts = {
            "assigned": sum(1 for row in workers if row.get("state") == "assigned"),
            "working": sum(1 for row in workers if row.get("state") == "working"),
            "reporting": sum(1 for row in workers if row.get("state") == "reporting"),
            "blocked": sum(1 for row in workers if row.get("state") == "blocked"),
        }
        return {
            "status": "ok",
            "as_of": _utcnow_iso(),
            "project_id": project_filter or None,
            "counts": counts,
            "workers": workers,
        }

    def rebuild_from_activity_log_and_runs(
        self,
        *,
        activity_log_path: str,
        runs: list[dict[str, Any]] | None = None,
    ) -> None:
        """Rebuild live presence state from persisted activity + run history."""
        with self._lock:
            self._workers = {}
            self._seen_event_ids = []
            self._seen_event_set = set()

            if os.path.exists(activity_log_path):
                try:
                    with open(activity_log_path) as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                event = json.loads(line)
                            except (ValueError, KeyError):
                                continue
                            if not isinstance(event, dict):
                                continue
                            event_id = self._event_id(event)
                            if not self._remember_event_id_locked(event_id):
                                continue
                            self._ingest_event_locked(event)
                except OSError:
                    pass

            run_rows = runs
            if run_rows is None and self.run_service is not None:
                try:
                    run_rows = self.run_service.list_runs(limit=5000)
                except Exception:
                    run_rows = []
            for run in run_rows or []:
                run_id = str(run.get("id", "") or "").strip()
                status = str(run.get("status", "") or "").strip().lower()
                project_id = str(run.get("project_id", "") or "").strip()
                if run_id and status in TERMINAL_STATES:
                    self._remove_terminal_run_workers_locked(run_id, project_id=project_id)
            self._persist_locked()
