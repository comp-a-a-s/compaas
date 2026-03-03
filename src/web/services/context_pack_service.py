"""Persistent context-pack storage and prompt injection assembly."""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import yaml

from src.utils import atomic_yaml_write
from src.validators import safe_path_join, validate_safe_id


VALID_SCOPES = {"global", "project"}
VALID_KINDS = {"product", "tech", "design", "ops", "constraints"}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_content(value: str) -> str:
    return "\n".join(line.rstrip() for line in str(value or "").strip().splitlines()).strip()


class ContextPackService:
    """Manage global/project context packs and deterministic prompt injection."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.context_dir = os.path.join(data_dir, "context")
        self.projects_dir = os.path.join(data_dir, "projects")

    def _global_path(self) -> str:
        return os.path.join(self.context_dir, "global.yaml")

    def _project_path(self, project_id: str) -> str:
        validate_safe_id(project_id, "project_id")
        return safe_path_join(self.projects_dir, project_id, "context_packs.yaml")

    def _project_exists(self, project_id: str) -> bool:
        try:
            project_yaml = safe_path_join(self.projects_dir, project_id, "project.yaml")
        except ValueError:
            return False
        return os.path.exists(project_yaml)

    def _load_path(self, path: str) -> list[dict[str, Any]]:
        if not os.path.exists(path):
            return []
        try:
            with open(path) as f:
                parsed = yaml.safe_load(f) or {}
        except (OSError, yaml.YAMLError):
            return []
        packs = parsed.get("packs", []) if isinstance(parsed.get("packs"), list) else []
        return [item for item in packs if isinstance(item, dict)]

    def _save_path(self, path: str, packs: list[dict[str, Any]]) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        atomic_yaml_write(path, {"packs": packs[-500:]})

    def list_packs(
        self,
        *,
        scope: str = "",
        project_id: str = "",
        enabled: bool | None = None,
    ) -> list[dict[str, Any]]:
        normalized_scope = str(scope or "").strip().lower()
        results: list[dict[str, Any]] = []

        if normalized_scope in {"", "global"}:
            for item in self._load_path(self._global_path()):
                if enabled is not None and bool(item.get("enabled", True)) != enabled:
                    continue
                results.append({**item, "scope": "global", "project_id": ""})

        if normalized_scope in {"", "project"}:
            if project_id:
                if self._project_exists(project_id):
                    for item in self._load_path(self._project_path(project_id)):
                        if enabled is not None and bool(item.get("enabled", True)) != enabled:
                            continue
                        results.append({**item, "scope": "project", "project_id": project_id})
            else:
                for pid in self._list_project_ids():
                    for item in self._load_path(self._project_path(pid)):
                        if enabled is not None and bool(item.get("enabled", True)) != enabled:
                            continue
                        results.append({**item, "scope": "project", "project_id": pid})

        results.sort(key=lambda item: str(item.get("updated_at", item.get("created_at", "")) or ""), reverse=True)
        return results

    def create_pack(
        self,
        *,
        scope: str,
        project_id: str = "",
        kind: str,
        title: str,
        content: str,
        enabled: bool = True,
        pinned: bool = True,
        source: str = "manual",
    ) -> dict[str, Any]:
        normalized_scope = str(scope or "").strip().lower()
        if normalized_scope not in VALID_SCOPES:
            raise ValueError("scope must be global or project")
        if normalized_scope == "project" and not project_id:
            raise ValueError("project_id is required for project packs")
        if normalized_scope == "project" and not self._project_exists(project_id):
            raise ValueError("Project not found")

        normalized_kind = str(kind or "").strip().lower()
        if normalized_kind not in VALID_KINDS:
            raise ValueError("Invalid context pack kind")

        normalized_title = str(title or "").strip()
        if not normalized_title:
            raise ValueError("title is required")

        normalized_content = _normalize_content(content)
        if not normalized_content:
            raise ValueError("content is required")

        now = _utcnow_iso()
        record = {
            "id": str(uuid.uuid4())[:10],
            "kind": normalized_kind,
            "title": normalized_title,
            "content": normalized_content,
            "enabled": bool(enabled),
            "pinned": bool(pinned),
            "source": str(source or "manual").strip() or "manual",
            "hash": hashlib.sha256(normalized_content.encode("utf-8")).hexdigest()[:16],
            "created_at": now,
            "updated_at": now,
        }

        path = self._global_path() if normalized_scope == "global" else self._project_path(project_id)
        packs = self._load_path(path)
        packs.append(record)
        self._save_path(path, packs)
        return {
            **record,
            "scope": normalized_scope,
            "project_id": project_id if normalized_scope == "project" else "",
        }

    def update_pack(self, pack_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        target_id = str(pack_id or "").strip()
        if not target_id:
            return None

        for scope, project_id, path in self._iter_paths():
            packs = self._load_path(path)
            changed = False
            updated_pack: dict[str, Any] | None = None
            for index, item in enumerate(packs):
                if str(item.get("id", "") or "") != target_id:
                    continue
                current = dict(item)
                if "kind" in updates:
                    normalized_kind = str(updates.get("kind", current.get("kind", "")) or "").strip().lower()
                    if normalized_kind in VALID_KINDS:
                        current["kind"] = normalized_kind
                if "title" in updates:
                    title = str(updates.get("title", "") or "").strip()
                    if title:
                        current["title"] = title
                if "content" in updates:
                    content = _normalize_content(str(updates.get("content", "") or ""))
                    if content:
                        current["content"] = content
                        current["hash"] = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
                if "enabled" in updates:
                    current["enabled"] = bool(updates.get("enabled"))
                if "pinned" in updates:
                    current["pinned"] = bool(updates.get("pinned"))
                if "source" in updates:
                    current["source"] = str(updates.get("source", "manual") or "manual").strip() or "manual"
                current["updated_at"] = _utcnow_iso()

                packs[index] = current
                changed = True
                updated_pack = current
                break

            if changed and updated_pack is not None:
                self._save_path(path, packs)
                return {
                    **updated_pack,
                    "scope": scope,
                    "project_id": project_id,
                }
        return None

    def delete_pack(self, pack_id: str) -> bool:
        target_id = str(pack_id or "").strip()
        if not target_id:
            return False
        for _scope, _project_id, path in self._iter_paths():
            packs = self._load_path(path)
            next_packs = [item for item in packs if str(item.get("id", "") or "") != target_id]
            if len(next_packs) != len(packs):
                self._save_path(path, next_packs)
                return True
        return False

    def build_prompt_context(
        self,
        *,
        project_id: str = "",
        transient_packs: list[dict[str, Any]] | None = None,
        max_packs: int = 8,
        max_chars: int = 3500,
    ) -> dict[str, Any]:
        ordered: list[dict[str, Any]] = []
        transient = [item for item in (transient_packs or []) if isinstance(item, dict)]
        for item in transient:
            content = _normalize_content(str(item.get("content", "") or ""))
            if not content:
                continue
            ordered.append({
                "id": str(item.get("id", "transient")) or "transient",
                "scope": "session",
                "project_id": project_id,
                "kind": str(item.get("kind", "ops") or "ops"),
                "title": str(item.get("title", "Session Context") or "Session Context"),
                "content": content,
                "hash": hashlib.sha256(content.encode("utf-8")).hexdigest()[:16],
            })

        if project_id and self._project_exists(project_id):
            for item in self._load_path(self._project_path(project_id)):
                if not bool(item.get("enabled", True)) or not bool(item.get("pinned", False)):
                    continue
                ordered.append({**item, "scope": "project", "project_id": project_id})

        for item in self._load_path(self._global_path()):
            if not bool(item.get("enabled", True)) or not bool(item.get("pinned", False)):
                continue
            ordered.append({**item, "scope": "global", "project_id": ""})

        seen_hashes: set[str] = set()
        used: list[dict[str, Any]] = []
        consumed_chars = 0
        max_pack_count = max(1, min(30, int(max_packs or 8)))
        max_char_budget = max(400, min(12000, int(max_chars or 3500)))

        for item in ordered:
            content = _normalize_content(str(item.get("content", "") or ""))
            if not content:
                continue
            content_hash = str(item.get("hash", "") or "") or hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
            if content_hash in seen_hashes:
                continue
            projected = consumed_chars + len(content)
            if projected > max_char_budget:
                continue
            seen_hashes.add(content_hash)
            consumed_chars = projected
            used.append({
                "id": str(item.get("id", "") or ""),
                "scope": str(item.get("scope", "") or ""),
                "project_id": str(item.get("project_id", "") or ""),
                "kind": str(item.get("kind", "") or ""),
                "title": str(item.get("title", "") or ""),
                "content": content,
                "hash": content_hash,
            })
            if len(used) >= max_pack_count:
                break

        if not used:
            return {"text": "", "packs": [], "total_chars": 0}

        lines = ["[CONTEXT PACKS: Apply these constraints and preferences before responding.]"]
        for item in used:
            label = f"{item['scope']}/{item['kind']}"
            title = item["title"] or "Context"
            lines.append(f"- {title} ({label})")
            lines.append(item["content"])
        return {
            "text": "\n".join(lines),
            "packs": used,
            "total_chars": consumed_chars,
        }

    def _iter_paths(self):
        yield ("global", "", self._global_path())
        for project_id in self._list_project_ids():
            yield ("project", project_id, self._project_path(project_id))

    def _list_project_ids(self) -> list[str]:
        if not os.path.exists(self.projects_dir):
            return []
        project_ids: list[str] = []
        for entry in sorted(os.listdir(self.projects_dir)):
            try:
                validate_safe_id(entry, "project_id")
            except ValueError:
                continue
            project_yaml = safe_path_join(self.projects_dir, entry, "project.yaml")
            if os.path.exists(project_yaml):
                project_ids.append(entry)
        return project_ids
