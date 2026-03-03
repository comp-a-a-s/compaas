"""Preview review session/comment persistence for project deployments."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any

import yaml

from src.utils import atomic_yaml_write
from src.validators import safe_path_join, validate_safe_id


VALID_SESSION_STATUS = {"open", "closed"}
VALID_COMMENT_STATUS = {"open", "resolved"}
VALID_SEVERITY = {"low", "medium", "high", "critical"}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ReviewService:
    """Store and query review sessions/comments under each project directory."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.projects_dir = os.path.join(data_dir, "projects")

    def _project_dir(self, project_id: str) -> str:
        validate_safe_id(project_id, "project_id")
        return safe_path_join(self.projects_dir, project_id)

    def _reviews_path(self, project_id: str) -> str:
        return safe_path_join(self._project_dir(project_id), "reviews.yaml")

    def _project_exists(self, project_id: str) -> bool:
        try:
            project_yaml = safe_path_join(self._project_dir(project_id), "project.yaml")
        except ValueError:
            return False
        return os.path.exists(project_yaml)

    def _load(self, project_id: str) -> dict[str, Any]:
        path = self._reviews_path(project_id)
        if not os.path.exists(path):
            return {"sessions": [], "comments": []}
        try:
            with open(path) as f:
                parsed = yaml.safe_load(f) or {}
        except (OSError, yaml.YAMLError):
            parsed = {}
        sessions = parsed.get("sessions", []) if isinstance(parsed.get("sessions"), list) else []
        comments = parsed.get("comments", []) if isinstance(parsed.get("comments"), list) else []
        return {
            "sessions": [item for item in sessions if isinstance(item, dict)],
            "comments": [item for item in comments if isinstance(item, dict)],
        }

    def _save(self, project_id: str, payload: dict[str, Any]) -> None:
        path = self._reviews_path(project_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        atomic_yaml_write(path, payload)

    @staticmethod
    def _session_counts(session_id: str, comments: list[dict[str, Any]]) -> dict[str, int]:
        total = 0
        unresolved = 0
        for item in comments:
            if str(item.get("session_id", "") or "") != session_id:
                continue
            total += 1
            if str(item.get("status", "open") or "open").strip().lower() != "resolved":
                unresolved += 1
        return {"total": total, "unresolved": unresolved}

    @staticmethod
    def _normalize_pagination(cursor: str, limit: int) -> tuple[int, int]:
        safe_limit = max(1, min(200, int(limit or 20)))
        try:
            offset = max(0, int(str(cursor or "0").strip() or "0"))
        except ValueError:
            offset = 0
        return offset, safe_limit

    def list_sessions(
        self,
        project_id: str,
        *,
        status: str = "",
        cursor: str = "",
        limit: int = 20,
    ) -> dict[str, Any]:
        if not self._project_exists(project_id):
            raise ValueError("Project not found")
        store = self._load(project_id)
        sessions = list(store["sessions"])
        comments = list(store["comments"])
        normalized_status = str(status or "").strip().lower()
        if normalized_status:
            sessions = [
                item for item in sessions
                if str(item.get("status", "open") or "open").strip().lower() == normalized_status
            ]

        sessions.sort(key=lambda item: str(item.get("created_at", "") or ""), reverse=True)
        offset, safe_limit = self._normalize_pagination(cursor, limit)
        window = sessions[offset:offset + safe_limit]
        enriched: list[dict[str, Any]] = []
        for session in window:
            sid = str(session.get("id", "") or "")
            enriched.append({**session, "counts": self._session_counts(sid, comments)})

        next_cursor = ""
        if offset + safe_limit < len(sessions):
            next_cursor = str(offset + safe_limit)
        return {
            "sessions": enriched,
            "next_cursor": next_cursor,
            "total": len(sessions),
        }

    def create_session(
        self,
        project_id: str,
        *,
        deployment_url: str,
        run_id: str = "",
        source: str = "vercel_preview",
        created_by: str = "chairman",
    ) -> dict[str, Any]:
        if not self._project_exists(project_id):
            raise ValueError("Project not found")
        deployment_url = str(deployment_url or "").strip()
        if not deployment_url:
            raise ValueError("deployment_url is required")

        store = self._load(project_id)
        now = _utcnow_iso()
        session = {
            "id": str(uuid.uuid4())[:10],
            "project_id": project_id,
            "run_id": str(run_id or "").strip(),
            "deployment_url": deployment_url,
            "source": str(source or "manual").strip() or "manual",
            "status": "open",
            "created_at": now,
            "updated_at": now,
            "created_by": str(created_by or "chairman").strip() or "chairman",
            "counts": {"total": 0, "unresolved": 0},
        }
        store["sessions"].append(session)
        self._save(project_id, store)
        return session

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        sid = str(session_id or "").strip()
        if not sid:
            return None
        for project_id in self._list_project_ids():
            store = self._load(project_id)
            sessions = store.get("sessions", [])
            comments = store.get("comments", [])
            for session in sessions:
                if str(session.get("id", "") or "") != sid:
                    continue
                session_with_counts = {**session, "counts": self._session_counts(sid, comments)}
                session_comments = [
                    item for item in comments
                    if str(item.get("session_id", "") or "") == sid
                ]
                session_comments.sort(key=lambda item: str(item.get("created_at", "") or ""))
                return {
                    "project_id": project_id,
                    "session": session_with_counts,
                    "comments": session_comments,
                }
        return None

    def add_comment(
        self,
        session_id: str,
        *,
        route: str = "",
        element_hint: str = "",
        note: str,
        severity: str = "medium",
        status: str = "open",
        author: str = "chairman",
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        lookup = self.get_session(session_id)
        if not lookup:
            raise ValueError("Session not found")

        project_id = str(lookup["project_id"])
        store = self._load(project_id)
        normalized_severity = str(severity or "medium").strip().lower()
        if normalized_severity not in VALID_SEVERITY:
            normalized_severity = "medium"
        normalized_status = str(status or "open").strip().lower()
        if normalized_status not in VALID_COMMENT_STATUS:
            normalized_status = "open"

        cleaned_note = str(note or "").strip()
        if not cleaned_note:
            raise ValueError("note is required")

        tag_list = []
        for raw in tags or []:
            tag = str(raw or "").strip().lower()
            if tag and tag not in tag_list:
                tag_list.append(tag)
            if len(tag_list) >= 8:
                break

        now = _utcnow_iso()
        comment = {
            "id": str(uuid.uuid4())[:10],
            "session_id": str(session_id),
            "route": str(route or "").strip(),
            "element_hint": str(element_hint or "").strip(),
            "note": cleaned_note,
            "severity": normalized_severity,
            "status": normalized_status,
            "author": str(author or "chairman").strip() or "chairman",
            "created_at": now,
            "resolved_at": now if normalized_status == "resolved" else "",
            "tags": tag_list,
        }
        store["comments"].append(comment)
        self._touch_session(store, str(session_id))
        self._save(project_id, store)
        return comment

    def update_comment(self, comment_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        cid = str(comment_id or "").strip()
        if not cid:
            return None
        for project_id in self._list_project_ids():
            store = self._load(project_id)
            changed = False
            target_session = ""
            for index, comment in enumerate(store.get("comments", [])):
                if str(comment.get("id", "") or "") != cid:
                    continue
                status = str(updates.get("status", comment.get("status", "open")) or "open").strip().lower()
                if status not in VALID_COMMENT_STATUS:
                    status = str(comment.get("status", "open") or "open").strip().lower()
                severity = str(updates.get("severity", comment.get("severity", "medium")) or "medium").strip().lower()
                if severity not in VALID_SEVERITY:
                    severity = str(comment.get("severity", "medium") or "medium").strip().lower()

                next_comment = {**comment}
                next_comment["status"] = status
                next_comment["severity"] = severity
                if "note" in updates:
                    note = str(updates.get("note", "") or "").strip()
                    if note:
                        next_comment["note"] = note
                if "route" in updates:
                    next_comment["route"] = str(updates.get("route", "") or "").strip()
                if "element_hint" in updates:
                    next_comment["element_hint"] = str(updates.get("element_hint", "") or "").strip()
                if "tags" in updates and isinstance(updates.get("tags"), list):
                    tag_list = []
                    for raw in updates.get("tags", []):
                        tag = str(raw or "").strip().lower()
                        if tag and tag not in tag_list:
                            tag_list.append(tag)
                        if len(tag_list) >= 8:
                            break
                    next_comment["tags"] = tag_list

                if status == "resolved":
                    next_comment["resolved_at"] = str(comment.get("resolved_at", "") or "") or _utcnow_iso()
                else:
                    next_comment["resolved_at"] = ""

                store["comments"][index] = next_comment
                changed = True
                target_session = str(next_comment.get("session_id", "") or "")
                break

            if changed:
                self._touch_session(store, target_session)
                self._save(project_id, store)
                for comment in store.get("comments", []):
                    if str(comment.get("id", "") or "") == cid:
                        return comment
        return None

    def _touch_session(self, store: dict[str, Any], session_id: str) -> None:
        now = _utcnow_iso()
        for idx, session in enumerate(store.get("sessions", [])):
            if str(session.get("id", "") or "") != session_id:
                continue
            current = dict(session)
            current["updated_at"] = now
            if current.get("status") not in VALID_SESSION_STATUS:
                current["status"] = "open"
            store["sessions"][idx] = current
            break

    def _list_project_ids(self) -> list[str]:
        if not os.path.exists(self.projects_dir):
            return []
        project_ids: list[str] = []
        for entry in sorted(os.listdir(self.projects_dir)):
            try:
                validate_safe_id(entry, "project_id")
            except ValueError:
                continue
            if os.path.exists(safe_path_join(self.projects_dir, entry, "project.yaml")):
                project_ids.append(entry)
        return project_ids
