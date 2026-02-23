"""Project service layer for metadata, artifact tracking, and lifecycle helpers."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any

import yaml

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard
from src.utils import FileLock, atomic_yaml_write


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProjectService:
    """Service abstraction around project state + metadata extensions."""

    def __init__(self, data_dir: str, state_manager: ProjectStateManager, task_board: TaskBoard):
        self.data_dir = data_dir
        self.state_manager = state_manager
        self.task_board = task_board
        self.projects_dir = os.path.join(data_dir, "projects")
        self.idempotency_path = os.path.join(data_dir, "project_idempotency.yaml")

    def _metadata_path(self, project_id: str) -> str:
        return os.path.join(self.projects_dir, project_id, "metadata.yaml")

    def _load_metadata(self, project_id: str) -> dict[str, Any]:
        path = self._metadata_path(project_id)
        if not os.path.exists(path):
            return {}
        try:
            with open(path) as f:
                return yaml.safe_load(f) or {}
        except (OSError, yaml.YAMLError):
            return {}

    def _save_metadata(self, project_id: str, metadata: dict[str, Any]) -> None:
        atomic_yaml_write(self._metadata_path(project_id), metadata)

    def ensure_metadata(self, project_id: str) -> dict[str, Any]:
        project = self.state_manager.get_project(project_id)
        if not project:
            raise ValueError(f"Unknown project: {project_id}")

        defaults: dict[str, Any] = {
            "project_id": project_id,
            "charter": {
                "scope": "",
                "constraints": [],
                "acceptance_criteria": [],
            },
            "definition_of_done": [
                {"label": "Functional checks pass", "done": False},
                {"label": "Security checks pass", "done": False},
                {"label": "Documentation updated", "done": False},
            ],
            "stakeholder_notes": [],
            "artifacts": [],
            "branch_policy": {
                "pattern": "feature/{project_id}-{task_id}",
                "enforced": True,
                "merge_strategy": "squash",
            },
            "dependency_graph": {"nodes": [], "edges": []},
            "archived": False,
            "created_at": _utcnow_iso(),
            "updated_at": _utcnow_iso(),
        }
        current = self._load_metadata(project_id)
        merged = self._deep_merge(defaults, current)
        merged["updated_at"] = _utcnow_iso()
        self._save_metadata(project_id, merged)
        return merged

    def create_project(
        self,
        *,
        name: str,
        description: str,
        project_type: str = "general",
        idempotency_key: str = "",
        delivery_mode: str = "local",
        github_repo: str = "",
        github_branch: str = "master",
        workspace_path: str = "",
    ) -> tuple[dict[str, Any], bool]:
        """Create project with optional idempotency key.

        Returns ``(project, created)``.
        """
        if idempotency_key:
            with FileLock(self.idempotency_path):
                mapped = self._load_project_idempotency()
                existing_id = mapped.get(idempotency_key)
                if isinstance(existing_id, str):
                    existing = self.state_manager.get_project(existing_id)
                    if existing:
                        return existing, False

        project_id = self.state_manager.create_project(
            name,
            description,
            project_type,
            workspace_path=workspace_path,
            delivery_mode=delivery_mode,
            github_repo=github_repo,
            github_branch=github_branch,
        )
        project = self.state_manager.get_project(project_id) or {"id": project_id, "name": name}
        self.ensure_metadata(project_id)
        if idempotency_key:
            with FileLock(self.idempotency_path):
                mapped = self._load_project_idempotency()
                mapped[idempotency_key] = project_id
                atomic_yaml_write(self.idempotency_path, {"keys": mapped})
        return project, True

    def get_metadata(self, project_id: str) -> dict[str, Any]:
        return self.ensure_metadata(project_id)

    def update_metadata(self, project_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.ensure_metadata(project_id)
        merged = self._deep_merge(current, updates if isinstance(updates, dict) else {})
        merged["updated_at"] = _utcnow_iso()
        self._save_metadata(project_id, merged)
        return merged

    def register_artifact(
        self,
        project_id: str,
        *,
        file_path: str,
        action: str,
        run_id: str = "",
        agent: str = "ceo",
    ) -> dict[str, Any]:
        metadata = self.ensure_metadata(project_id)
        artifacts = metadata.get("artifacts", [])
        if not isinstance(artifacts, list):
            artifacts = []
        rel_path = file_path
        project = self.state_manager.get_project(project_id) or {}
        workspace = str(project.get("workspace_path", "") or "").strip()
        if workspace and file_path.startswith(workspace):
            rel_path = os.path.relpath(file_path, workspace)
        artifacts.append(
            {
                "id": str(uuid.uuid4())[:10],
                "timestamp": _utcnow_iso(),
                "file_path": rel_path,
                "action": action,
                "run_id": run_id,
                "agent": agent,
            }
        )
        metadata["artifacts"] = artifacts[-1000:]
        metadata["updated_at"] = _utcnow_iso()
        self._save_metadata(project_id, metadata)
        return metadata

    def clone_project(self, project_id: str, new_name: str = "") -> dict[str, Any]:
        source = self.state_manager.get_project(project_id)
        if not source:
            raise ValueError("Project not found")
        clone_name = new_name.strip() or f"{source.get('name', 'Project')} Clone"
        cloned_project, _ = self.create_project(
            name=clone_name,
            description=str(source.get("description", "")),
            project_type=str(source.get("type", "general")),
            delivery_mode=str(source.get("delivery_mode", "local") or "local"),
            github_repo=str(source.get("github_repo", "") or ""),
            github_branch=str(source.get("github_branch", "master") or "master"),
        )
        cloned_id = str(cloned_project.get("id", "") or "")

        source_meta = self.ensure_metadata(project_id)
        cloned_meta = self.ensure_metadata(cloned_id)
        cloned_meta["charter"] = source_meta.get("charter", {})
        cloned_meta["definition_of_done"] = source_meta.get("definition_of_done", [])
        cloned_meta["dependency_graph"] = source_meta.get("dependency_graph", {"nodes": [], "edges": []})
        cloned_meta["stakeholder_notes"] = [
            {
                "timestamp": _utcnow_iso(),
                "author": "system",
                "note": f"Cloned from {project_id}",
            }
        ]
        self._save_metadata(cloned_id, cloned_meta)

        return self.state_manager.get_project(cloned_id) or {"id": cloned_id, "name": clone_name}

    def plan_packet_status(self, project_id: str) -> dict[str, Any]:
        """Return planning packet completeness for Chairman approval gating."""
        project = self.state_manager.get_project(project_id)
        if not project:
            raise ValueError("Project not found")

        project_root = os.path.join(self.projects_dir, project_id)
        specs_dir = os.path.join(project_root, "specs")
        artifacts_dir = os.path.join(project_root, "artifacts")
        files = {
            "stakeholder_summary": os.path.join(specs_dir, "00_stakeholder_meeting_summary.md"),
            "execution_plan": os.path.join(specs_dir, "01_full_execution_plan.md"),
            "activation_guide": os.path.join(artifacts_dir, "02_activation_guide.md"),
            "project_handoff": os.path.join(artifacts_dir, "03_project_handoff.md"),
        }

        missing_items: list[str] = []
        sections: dict[str, dict[str, Any]] = {}
        total_char_count = 0

        for key, path in files.items():
            exists = os.path.exists(path)
            content = ""
            if exists:
                try:
                    with open(path) as f:
                        content = f.read()
                except OSError:
                    content = ""
            cleaned = content.strip()
            length_ok = len(cleaned) >= 120
            looks_template = (
                "Decision 1:" in cleaned
                or "Problem statement:" in cleaned
                or "- What was built:" in cleaned
                or "Steps to reproduce" in cleaned
            )
            if key in {"stakeholder_summary", "execution_plan", "activation_guide"}:
                if not exists:
                    missing_items.append(f"Missing file: {os.path.basename(path)}")
                elif not length_ok:
                    missing_items.append(f"File too short: {os.path.basename(path)}")
                elif looks_template:
                    missing_items.append(f"Replace template placeholders in: {os.path.basename(path)}")
            total_char_count += len(cleaned)
            sections[key] = {
                "path": path,
                "exists": exists,
                "length": len(cleaned),
                "looks_template": looks_template,
            }

        ready = len(missing_items) == 0
        summary = (
            "Planning packet is complete and ready for Chairman approval."
            if ready
            else "Planning packet is not ready yet. Complete missing items before approval."
        )
        return {
            "ready": ready,
            "missing_items": missing_items,
            "summary": summary,
            "updated_at": _utcnow_iso(),
            "wording": "business",
            "total_characters": total_char_count,
            "sections": sections,
        }

    def set_archived(self, project_id: str, archived: bool) -> dict[str, Any]:
        metadata = self.ensure_metadata(project_id)
        metadata["archived"] = bool(archived)
        metadata["updated_at"] = _utcnow_iso()
        self._save_metadata(project_id, metadata)
        # Keep project status explicit for list view.
        self.state_manager.update_project(project_id, {"status": "archived" if archived else "planning"})
        return metadata

    def list_archived(self) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for project in self.state_manager.list_projects():
            metadata = self.ensure_metadata(project["id"])
            if metadata.get("archived"):
                results.append(project)
        return results

    def restore_project(self, project_id: str) -> dict[str, Any]:
        self.set_archived(project_id, False)
        return self.state_manager.get_project(project_id) or {"id": project_id}

    def delta_since(self, project_id: str, since_iso: str | None = None) -> dict[str, Any]:
        since = since_iso or ""
        activity_path = os.path.join(self.data_dir, "activity.log")
        items: list[dict[str, Any]] = []
        if os.path.exists(activity_path):
            try:
                with open(activity_path) as f:
                    for raw in f:
                        raw = raw.strip()
                        if not raw:
                            continue
                        try:
                            entry = yaml.safe_load(raw)
                        except Exception:
                            continue
                        if not isinstance(entry, dict):
                            continue
                        if str(entry.get("project_id", "")) != project_id:
                            continue
                        if since and str(entry.get("timestamp", "")) <= since:
                            continue
                        items.append(entry)
            except OSError:
                pass
        metadata = self.ensure_metadata(project_id)
        artifacts = metadata.get("artifacts", [])
        return {
            "project_id": project_id,
            "since": since,
            "events": items[-200:],
            "artifacts": artifacts[-200:] if isinstance(artifacts, list) else [],
        }

    def readme_quality(self, project_id: str) -> dict[str, Any]:
        project = self.state_manager.get_project(project_id)
        if not project:
            raise ValueError("Project not found")
        workspace = str(project.get("workspace_path", "") or "").strip()
        readme_path = os.path.join(workspace, "README.md") if workspace else ""
        text = ""
        if readme_path and os.path.exists(readme_path):
            try:
                with open(readme_path) as f:
                    text = f.read()
            except OSError:
                text = ""

        checks = {
            "has_title": text.strip().startswith("# "),
            "has_setup_section": "## setup" in text.lower() or "## installation" in text.lower(),
            "has_run_section": "## run" in text.lower() or "## usage" in text.lower(),
            "has_env_section": "environment" in text.lower() or ".env" in text.lower(),
            "has_deploy_section": "deploy" in text.lower(),
        }
        score = int(sum(1 for ok in checks.values() if ok) / max(1, len(checks)) * 100)
        return {"project_id": project_id, "readme_path": readme_path, "score": score, "checks": checks}

    def analytics(self, project_id: str) -> dict[str, Any]:
        project = self.state_manager.get_project(project_id)
        if not project:
            raise ValueError("Project not found")
        tasks = self.task_board.get_board(project_id)
        total_tasks = len(tasks)
        done = len([t for t in tasks if str(t.get("status", "")).lower() == "done"])
        started = project.get("created_at", "")
        duration_hours = 0.0
        try:
            if started:
                dt = datetime.fromisoformat(str(started))
                duration_hours = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0)
        except ValueError:
            duration_hours = 0.0

        metadata = self.ensure_metadata(project_id)
        artifacts = metadata.get("artifacts", [])
        run_registry_path = os.path.join(self.data_dir, "run_registry.yaml")
        run_count = 0
        if os.path.exists(run_registry_path):
            try:
                with open(run_registry_path) as f:
                    parsed = yaml.safe_load(f) or {}
                runs = parsed.get("runs", [])
                if isinstance(runs, list):
                    run_count = len([r for r in runs if str(r.get("project_id", "")) == project_id])
            except (OSError, yaml.YAMLError):
                run_count = 0

        return {
            "project_id": project_id,
            "tasks_total": total_tasks,
            "tasks_done": done,
            "completion_percent": int((done / total_tasks) * 100) if total_tasks else 0,
            "duration_hours": round(duration_hours, 2),
            "artifact_count": len(artifacts) if isinstance(artifacts, list) else 0,
            "run_count": run_count,
        }

    @staticmethod
    def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
        result = dict(base)
        for key, value in override.items():
            if isinstance(result.get(key), dict) and isinstance(value, dict):
                result[key] = ProjectService._deep_merge(result[key], value)
            else:
                result[key] = value
        return result

    def _load_project_idempotency(self) -> dict[str, str]:
        if not os.path.exists(self.idempotency_path):
            return {}
        try:
            with open(self.idempotency_path) as f:
                parsed = yaml.safe_load(f) or {}
            keys = parsed.get("keys", {})
            return keys if isinstance(keys, dict) else {}
        except (OSError, yaml.YAMLError):
            return {}
