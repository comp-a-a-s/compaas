"""Run lifecycle service for chat/build/deploy orchestration."""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import yaml

from src.utils import FileLock, atomic_yaml_write
from src.web.settings import RuntimeSettings, resolve_sandbox_profile


ACTIVE_STATES = {"queued", "planning", "executing", "verifying"}
TERMINAL_STATES = {"done", "failed", "cancelled"}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


class RunService:
    """Persistent run/state machine with idempotency + replay support."""

    def __init__(self, data_dir: str, settings: RuntimeSettings):
        self.data_dir = data_dir
        self.settings = settings
        self.registry_path = os.path.join(data_dir, "run_registry.yaml")
        self.idempotency_path = os.path.join(data_dir, "idempotency_registry.yaml")
        os.makedirs(self.data_dir, exist_ok=True)
        self._recover_interrupted_runs()

    def _load_registry(self) -> dict[str, Any]:
        if not os.path.exists(self.registry_path):
            return {"runs": []}
        try:
            with open(self.registry_path) as f:
                parsed = yaml.safe_load(f) or {}
            runs = parsed.get("runs", [])
            if not isinstance(runs, list):
                return {"runs": []}
            return {"runs": runs}
        except (OSError, yaml.YAMLError):
            return {"runs": []}

    def _save_registry(self, data: dict[str, Any]) -> None:
        atomic_yaml_write(self.registry_path, data)

    def _load_idempotency(self) -> dict[str, Any]:
        if not os.path.exists(self.idempotency_path):
            return {"keys": {}}
        try:
            with open(self.idempotency_path) as f:
                parsed = yaml.safe_load(f) or {}
            keys = parsed.get("keys", {})
            if not isinstance(keys, dict):
                return {"keys": {}}
            return {"keys": keys}
        except (OSError, yaml.YAMLError):
            return {"keys": {}}

    def _save_idempotency(self, data: dict[str, Any]) -> None:
        atomic_yaml_write(self.idempotency_path, data)

    @staticmethod
    def _turn_checksum(project_id: str, message: str) -> str:
        payload = f"{project_id}|{message.strip().lower()}".encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def _recover_interrupted_runs(self) -> None:
        """Mark non-terminal runs as failed after process restart."""
        with FileLock(self.registry_path):
            registry = self._load_registry()
            changed = False
            for run in registry["runs"]:
                status = str(run.get("status", "") or "")
                if status in ACTIVE_STATES:
                    run["status"] = "failed"
                    run["ended_at"] = _utcnow_iso()
                    run["updated_at"] = run["ended_at"]
                    timeline = run.get("timeline", [])
                    if not isinstance(timeline, list):
                        timeline = []
                    timeline.append(
                        {
                            "timestamp": run["ended_at"],
                            "state": "failed",
                            "label": "Recovered after server restart; previous run interrupted.",
                            "metadata": {"reason": "recovered_interrupted_run"},
                        }
                    )
                    run["timeline"] = timeline
                    changed = True
            if changed:
                self._save_registry(registry)

    @staticmethod
    def _resolve_runtime_seconds(run: dict[str, Any]) -> int:
        """Return max runtime budget in seconds for a run."""
        budget = run.get("tool_budget", {})
        try:
            return max(0, int((budget or {}).get("max_runtime_seconds", 0) or 0))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _resolve_started_at(run: dict[str, Any]) -> datetime | None:
        """Return best-effort start timestamp for runtime guardrails."""
        started = _parse_iso(str(run.get("started_at", "") or ""))
        if started is not None:
            return started
        return _parse_iso(str(run.get("created_at", "") or ""))

    def _expire_overdue_runs(self, registry: dict[str, Any], now_dt: datetime | None = None) -> bool:
        """Mark active runs as failed when runtime budget is exceeded."""
        changed = False
        current = now_dt or datetime.now(timezone.utc)
        for run in registry.get("runs", []):
            status = str(run.get("status", "") or "")
            if status not in ACTIVE_STATES:
                continue

            runtime_limit_s = self._resolve_runtime_seconds(run)
            if runtime_limit_s <= 0:
                continue

            started_at = self._resolve_started_at(run)
            if started_at is None:
                continue

            elapsed_s = (current - started_at).total_seconds()
            if elapsed_s <= runtime_limit_s:
                continue

            ended_at = _utcnow_iso()
            run["status"] = "failed"
            run["ended_at"] = ended_at
            run["updated_at"] = ended_at
            timeline = run.get("timeline", [])
            if not isinstance(timeline, list):
                timeline = []
            timeline.append(
                {
                    "timestamp": ended_at,
                    "state": "failed",
                    "label": f"Runtime budget exceeded ({runtime_limit_s}s); run auto-expired.",
                    "metadata": {
                        "reason": "runtime_budget_exceeded",
                        "elapsed_seconds": round(elapsed_s, 2),
                        "max_runtime_seconds": runtime_limit_s,
                    },
                }
            )
            run["timeline"] = timeline
            changed = True
        return changed

    def list_runs(self, *, project_id: str = "", limit: int = 100) -> list[dict[str, Any]]:
        with FileLock(self.registry_path):
            registry = self._load_registry()
            runs = registry["runs"]
            if project_id:
                runs = [r for r in runs if str(r.get("project_id", "")) == project_id]
            runs = sorted(runs, key=lambda r: str(r.get("updated_at", "")), reverse=True)
            return runs[: max(1, limit)]

    def list_runs_page(
        self,
        *,
        project_id: str = "",
        status: str = "",
        offset: int = 0,
        limit: int = 100,
    ) -> tuple[list[dict[str, Any]], int]:
        with FileLock(self.registry_path):
            registry = self._load_registry()
            runs = registry["runs"]
            if project_id:
                runs = [r for r in runs if str(r.get("project_id", "")) == project_id]
            normalized_status = str(status or "").strip().lower()
            if normalized_status:
                runs = [
                    r for r in runs
                    if str(r.get("status", "") or "").strip().lower() == normalized_status
                ]
            runs = sorted(runs, key=lambda r: str(r.get("updated_at", "")), reverse=True)
            total = len(runs)
            safe_offset = max(0, int(offset or 0))
            safe_limit = max(1, int(limit or 100))
            return runs[safe_offset:safe_offset + safe_limit], total

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with FileLock(self.registry_path):
            registry = self._load_registry()
            for run in registry["runs"]:
                if run.get("id") == run_id:
                    return run
        return None

    def create_run(
        self,
        *,
        project_id: str,
        message: str,
        provider: str,
        sandbox_profile: str = "standard",
        idempotency_key: str = "",
        mode: str = "full_crew",
        metadata: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], bool]:
        """Create a run or return an existing run if deduplicated.

        Returns tuple: ``(run, created)``.
        """
        checksum = self._turn_checksum(project_id, message)
        now = _utcnow_iso()
        now_dt = _parse_iso(now) or datetime.now(timezone.utc)
        dedupe_window = timedelta(seconds=self.settings.duplicate_turn_window_seconds)

        with FileLock(self.registry_path), FileLock(self.idempotency_path):
            registry = self._load_registry()
            idem = self._load_idempotency()
            if self._expire_overdue_runs(registry):
                self._save_registry(registry)

            if idempotency_key:
                mapped = idem["keys"].get(idempotency_key)
                if isinstance(mapped, str):
                    existing = next((r for r in registry["runs"] if r.get("id") == mapped), None)
                    if existing:
                        return existing, False

            for existing in registry["runs"]:
                if existing.get("project_id") != project_id:
                    continue
                if existing.get("checksum") != checksum:
                    continue
                created_at = _parse_iso(str(existing.get("created_at", "")))
                if not created_at or now_dt - created_at > dedupe_window:
                    continue
                if str(existing.get("status", "")) in TERMINAL_STATES:
                    continue
                return existing, False

            active_count = sum(
                1
                for run in registry["runs"]
                if run.get("project_id") == project_id and str(run.get("status", "")) in ACTIVE_STATES
            )
            if active_count >= self.settings.max_project_concurrency:
                raise RuntimeError(
                    f"Project '{project_id}' already has {active_count} active run(s). "
                    "Wait for completion or cancel the running task."
                )

            profile = resolve_sandbox_profile(sandbox_profile)
            run_id = str(uuid.uuid4())[:12]
            run = {
                "id": run_id,
                "project_id": project_id,
                "provider": provider,
                "mode": mode,
                "status": "queued",
                "message": message[:2000],
                "checksum": checksum,
                "sandbox_profile": sandbox_profile,
                "tool_budget": {
                    "max_commands": profile.max_commands,
                    "max_runtime_seconds": profile.max_runtime_seconds,
                    "max_files_touched": profile.max_files_touched,
                },
                "created_at": now,
                "updated_at": now,
                "started_at": "",
                "ended_at": "",
                "timeline": [
                    {
                        "timestamp": now,
                        "state": "queued",
                        "label": "Run queued",
                        "metadata": metadata or {},
                    }
                ],
                "cancel_requested": False,
                "command_count": 0,
                "files_touched": 0,
            }
            registry["runs"].append(run)
            self._save_registry(registry)
            if idempotency_key:
                idem["keys"][idempotency_key] = run_id
                self._save_idempotency(idem)
            return run, True

    def transition_run(
        self,
        run_id: str,
        *,
        state: str,
        label: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        with FileLock(self.registry_path):
            registry = self._load_registry()
            for run in registry["runs"]:
                if run.get("id") != run_id:
                    continue
                run["status"] = state
                run["updated_at"] = _utcnow_iso()
                if state in {"planning", "executing"} and not run.get("started_at"):
                    run["started_at"] = run["updated_at"]
                if state in TERMINAL_STATES:
                    run["ended_at"] = run["updated_at"]
                timeline = run.get("timeline", [])
                if not isinstance(timeline, list):
                    timeline = []
                timeline.append(
                    {
                        "timestamp": run["updated_at"],
                        "state": state,
                        "label": label,
                        "metadata": metadata or {},
                    }
                )
                run["timeline"] = timeline
                self._save_registry(registry)
                return run
        return None

    def record_command(
        self,
        run_id: str,
        *,
        command: str,
        cwd: str,
        duration_ms: int | None = None,
        exit_code: int | None = None,
        output_preview: str = "",
    ) -> dict[str, Any] | None:
        with FileLock(self.registry_path):
            registry = self._load_registry()
            for run in registry["runs"]:
                if run.get("id") != run_id:
                    continue
                run["command_count"] = int(run.get("command_count", 0) or 0) + 1
                timeline = run.get("timeline", [])
                if not isinstance(timeline, list):
                    timeline = []
                timeline.append(
                    {
                        "timestamp": _utcnow_iso(),
                        "state": "command",
                        "label": f"Command: {command[:180]}",
                        "metadata": {
                            "command": command[:400],
                            "cwd": cwd,
                            "duration_ms": duration_ms,
                            "exit_code": exit_code,
                            "output_preview": output_preview[:240],
                        },
                    }
                )
                run["timeline"] = timeline
                run["updated_at"] = _utcnow_iso()
                self._save_registry(registry)
                return run
        return None

    def record_file_touch(self, run_id: str, file_path: str) -> dict[str, Any] | None:
        with FileLock(self.registry_path):
            registry = self._load_registry()
            for run in registry["runs"]:
                if run.get("id") != run_id:
                    continue
                run["files_touched"] = int(run.get("files_touched", 0) or 0) + 1
                run["updated_at"] = _utcnow_iso()
                timeline = run.get("timeline", [])
                if not isinstance(timeline, list):
                    timeline = []
                timeline.append(
                    {
                        "timestamp": run["updated_at"],
                        "state": "file_change",
                        "label": f"Updated file: {file_path[:180]}",
                        "metadata": {"file_path": file_path},
                    }
                )
                run["timeline"] = timeline
                self._save_registry(registry)
                return run
        return None

    def guardrail_status(self, run_id: str) -> dict[str, Any] | None:
        run = self.get_run(run_id)
        if not run:
            return None
        budget = run.get("tool_budget", {})
        command_count = int(run.get("command_count", 0) or 0)
        files_touched = int(run.get("files_touched", 0) or 0)
        max_commands = int(budget.get("max_commands", 0) or 0)
        max_files = int(budget.get("max_files_touched", 0) or 0)
        max_runtime = int(budget.get("max_runtime_seconds", 0) or 0)
        started_at = self._resolve_started_at(run)
        elapsed_seconds = 0
        if started_at is not None:
            elapsed_seconds = max(0, int((datetime.now(timezone.utc) - started_at).total_seconds()))
        command_exceeded = command_count > max_commands
        file_exceeded = files_touched > max_files
        runtime_exceeded = max_runtime > 0 and elapsed_seconds > max_runtime
        return {
            "command_count": command_count,
            "files_touched": files_touched,
            "max_commands": max_commands,
            "max_files_touched": max_files,
            "max_runtime_seconds": max_runtime,
            "elapsed_seconds": elapsed_seconds,
            "command_budget_remaining": max(0, max_commands - command_count),
            "file_budget_remaining": max(0, max_files - files_touched),
            "runtime_budget_remaining": max(0, max_runtime - elapsed_seconds) if max_runtime > 0 else 0,
            "command_exceeded": command_exceeded,
            "file_exceeded": file_exceeded,
            "runtime_exceeded": runtime_exceeded,
            "over_budget": command_exceeded or file_exceeded or runtime_exceeded,
        }

    def cancel_run(self, run_id: str, reason: str = "Cancelled by user") -> dict[str, Any] | None:
        with FileLock(self.registry_path):
            registry = self._load_registry()
            for run in registry["runs"]:
                if run.get("id") != run_id:
                    continue
                run["cancel_requested"] = True
                run["status"] = "cancelled"
                run["updated_at"] = _utcnow_iso()
                run["ended_at"] = run["updated_at"]
                timeline = run.get("timeline", [])
                if not isinstance(timeline, list):
                    timeline = []
                timeline.append(
                    {
                        "timestamp": run["updated_at"],
                        "state": "cancelled",
                        "label": reason,
                        "metadata": {},
                    }
                )
                run["timeline"] = timeline
                self._save_registry(registry)
                return run
        return None

    def replay(self, run_id: str) -> dict[str, Any] | None:
        run = self.get_run(run_id)
        if not run:
            return None
        return {
            "run_id": run["id"],
            "project_id": run.get("project_id", ""),
            "status": run.get("status", ""),
            "provider": run.get("provider", ""),
            "mode": run.get("mode", ""),
            "created_at": run.get("created_at", ""),
            "updated_at": run.get("updated_at", ""),
            "timeline": run.get("timeline", []),
            "guardrails": self.guardrail_status(run_id) or {},
        }
