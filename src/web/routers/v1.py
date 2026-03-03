"""Versioned API router (/api/v1) for expanded orchestration capabilities."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
import shutil
import uuid
from typing import Any, Callable

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from src.utils import emit_activity
from src.validators import validate_safe_id
from src.web.problem import problem_http_exception
from src.web.services.integration_service import IntegrationService
from src.web.services.project_service import ProjectService
from src.web.services.context_pack_service import ContextPackService
from src.web.services.review_service import ReviewService
from src.web.services.run_service import RunService
from src.web.services.workforce_presence import WorkforcePresenceService
from src.web.services.run_supervisor import ACTIVE_RUN_STATES, build_run_status_payload, detect_run_incident
from src.web.services.autopilot_policy import evaluate_guarded_autopilot
from src.web.settings import FeatureFlags, merge_feature_flags, resolve_sandbox_profile


@dataclass
class V1Context:
    data_dir: str
    load_config: Callable[[], dict]
    save_config: Callable[[dict], None]
    run_service: RunService
    project_service: ProjectService
    integration_service: IntegrationService
    workforce_presence_service: WorkforcePresenceService
    require_write_auth: Callable[[Request], None] | None = None
    app_version: str = "v0.1.0"
    update_status: Callable[[bool], dict[str, Any]] | None = None
    apply_update: Callable[[str], dict[str, Any]] | None = None


class RunCreateRequest(BaseModel):
    project_id: str = Field(default="")
    message: str = Field(min_length=1, max_length=4000)
    provider: str = Field(default="anthropic")
    mode: str = Field(default="full_crew")
    sandbox_profile: str = Field(default="standard")
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    description: str = Field(default="", max_length=5000)
    type: str = Field(default="general", max_length=100)


class GithubRepoCreateRequest(BaseModel):
    token: str = Field(min_length=8)
    name: str = Field(min_length=1, max_length=120)
    private: bool = True
    description: str = ""


class GithubVerifyRequest(BaseModel):
    token: str = ""
    repo: str = ""


class GithubBranchRequest(BaseModel):
    repo_path: str = Field(min_length=1)
    base_branch: str = Field(default="master")
    new_branch: str = Field(min_length=1)


class GithubSyncRequest(BaseModel):
    repo_path: str = Field(min_length=1)
    default_branch: str = Field(default="master")


class GithubRollbackRequest(BaseModel):
    repo_path: str = Field(min_length=1)
    commit_sha: str = Field(min_length=6)


class VercelLinkRequest(BaseModel):
    token: str = Field(min_length=8)
    project_name: str = Field(min_length=1)
    team_id: str = ""


class VercelVerifyRequest(BaseModel):
    token: str = ""
    project_name: str = ""
    team_id: str = ""


class VercelDeployRequest(BaseModel):
    token: str = Field(min_length=8)
    project_name: str = Field(min_length=1)
    team_id: str = ""
    target: str = Field(default="preview")
    git_source: dict[str, Any] | None = None


class VercelDomainRequest(BaseModel):
    token: str = Field(min_length=8)
    project_name: str = Field(min_length=1)
    domain: str = Field(min_length=3)
    team_id: str = ""


class VercelEnvRequest(BaseModel):
    token: str = Field(min_length=8)
    project_name: str = Field(min_length=1)
    key: str = Field(min_length=1)
    value: str = Field(min_length=1)
    target: list[str] = Field(default_factory=lambda: ["preview", "production"])
    team_id: str = ""


class ProjectVercelDeployRequest(BaseModel):
    target: str = Field(default="preview")


class UpdateApplyRequest(BaseModel):
    version: str = Field(default="")


class RunControlRequest(BaseModel):
    action: str = Field(default="status")
    step: str = Field(default="")
    force: bool = Field(default=False)


class PrQualityProfileRequest(BaseModel):
    profile: str = Field(default="balanced")


class ReviewSessionCreateRequest(BaseModel):
    deployment_url: str = Field(min_length=1, max_length=500)
    run_id: str = Field(default="", max_length=120)
    source: str = Field(default="vercel_preview", max_length=80)
    created_by: str = Field(default="chairman", max_length=120)


class ReviewCommentCreateRequest(BaseModel):
    route: str = Field(default="", max_length=240)
    element_hint: str = Field(default="", max_length=240)
    note: str = Field(min_length=1, max_length=4000)
    severity: str = Field(default="medium", max_length=20)
    status: str = Field(default="open", max_length=20)
    author: str = Field(default="chairman", max_length=120)
    tags: list[str] = Field(default_factory=list)


class ReviewCommentPatchRequest(BaseModel):
    status: str = Field(default="", max_length=20)
    severity: str = Field(default="", max_length=20)
    note: str = Field(default="", max_length=4000)
    route: str = Field(default="", max_length=240)
    element_hint: str = Field(default="", max_length=240)
    tags: list[str] = Field(default_factory=list)


class ContextPackCreateRequest(BaseModel):
    scope: str = Field(default="project", max_length=20)
    project_id: str = Field(default="", max_length=80)
    kind: str = Field(default="ops", max_length=30)
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=15000)
    enabled: bool = True
    pinned: bool = True
    source: str = Field(default="manual", max_length=80)


class ContextPackUpdateRequest(BaseModel):
    kind: str = Field(default="", max_length=30)
    title: str = Field(default="", max_length=160)
    content: str = Field(default="", max_length=15000)
    enabled: bool | None = None
    pinned: bool | None = None
    source: str = Field(default="", max_length=80)


class StripeVerifyRequest(BaseModel):
    secret_key: str = Field(default="")


class StripeBillingApplyRequest(BaseModel):
    scaffold_files: bool = Field(default=False)
    sync_vercel_env: bool = Field(default=False)


def _classify_intent(message: str) -> dict[str, Any]:
    text = (message or "").strip().lower()
    if not text:
        return {"intent": "unknown", "confidence": 0.0, "needs_planning": False}

    execution_terms = ("build", "implement", "create", "generate", "write code", "deploy", "fix")
    planning_terms = ("plan", "architecture", "roadmap", "requirements", "research")
    simple_terms = ("quick", "small", "tiny", "simple", "micro")

    execution_hits = sum(1 for t in execution_terms if t in text)
    planning_hits = sum(1 for t in planning_terms if t in text)
    simple_hits = sum(1 for t in simple_terms if t in text)

    if planning_hits > execution_hits:
        confidence = min(0.98, 0.55 + (planning_hits * 0.15))
        return {"intent": "planning", "confidence": round(confidence, 2), "needs_planning": True}
    if execution_hits:
        complexity_hint = len(text.split()) > 30 or planning_hits > 0
        confidence = min(0.98, 0.62 + (execution_hits * 0.08))
        needs_planning = complexity_hint and simple_hits == 0
        return {"intent": "execution", "confidence": round(confidence, 2), "needs_planning": needs_planning}
    return {"intent": "qa", "confidence": 0.52, "needs_planning": False}


def create_v1_router(ctx: V1Context) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["v1"])
    review_service = ReviewService(ctx.data_dir)
    context_pack_service = ContextPackService(ctx.data_dir)

    def _require_mutation_auth(request: Request) -> None:
        if ctx.require_write_auth is not None:
            ctx.require_write_auth(request)

    def _feature_enabled(flag_name: str) -> bool:
        flags = merge_feature_flags(ctx.load_config())
        return bool(getattr(flags, flag_name, False))

    def _ensure_feature(flag_name: str, title: str, path_hint: str) -> None:
        if _feature_enabled(flag_name):
            return
        raise problem_http_exception(
            status=404,
            title=title,
            detail=f"{title} is disabled by feature flag '{flag_name}'.",
            type_=f"https://compaas.dev/problems/{path_hint}",
        )

    def _raise_invalid_repo_path(result: dict[str, Any]) -> None:
        if result.get("status") != "error":
            return
        if str(result.get("code", "")).startswith("invalid_repo_path"):
            raise HTTPException(status_code=400, detail=str(result.get("message", "Invalid repo_path.")))

    def _system_readiness_payload() -> dict[str, Any]:
        cfg = ctx.load_config()
        llm_cfg = cfg.get("llm", {}) if isinstance(cfg.get("llm"), dict) else {}
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        ui_cfg = cfg.get("ui", {}) if isinstance(cfg.get("ui"), dict) else {}

        provider = str(llm_cfg.get("provider", "anthropic") or "anthropic").strip().lower()
        anthropic_mode = str(llm_cfg.get("anthropic_mode", "cli") or "cli").strip().lower()
        openai_mode = str(llm_cfg.get("openai_mode", "apikey") or "apikey").strip().lower()
        model = str(llm_cfg.get("model", "") or "").strip()

        claude_cli = shutil.which("claude") or ""
        codex_cli = shutil.which("codex") or ""
        node_bin = shutil.which("node") or ""
        npm_bin = shutil.which("npm") or ""
        python_bin = shutil.which("python3") or shutil.which("python") or ""

        provider_ready = True
        provider_reason = ""
        if provider == "anthropic" and anthropic_mode == "cli":
            provider_ready = bool(claude_cli)
            if not provider_ready:
                provider_reason = "Claude CLI binary not found."
        elif provider == "openai" and openai_mode == "codex":
            provider_ready = bool(codex_cli)
            if not provider_ready:
                provider_reason = "Codex CLI binary not found."
        else:
            api_key = str(llm_cfg.get("api_key", "") or "").strip()
            base_url = str(llm_cfg.get("base_url", "") or "").strip()
            provider_ready = bool(api_key) and bool(base_url)
            if not provider_ready:
                provider_reason = "Provider API key or base URL is not configured."

        workspace_mode = str(integrations.get("workspace_mode", "local") or "local").strip().lower()
        workspace_root = str(ctx.project_service.state_manager.workspace_root or "").strip()
        workspace_exists = bool(workspace_root) and os.path.isdir(workspace_root)
        workspace_writable = bool(workspace_exists and os.access(workspace_root, os.W_OK | os.X_OK))

        github_repo = str(integrations.get("github_repo", "") or "").strip()
        github_token = str(integrations.get("github_token", "") or "").strip()
        github_verified = bool(integrations.get("github_verified"))
        vercel_project_name = str(integrations.get("vercel_project_name", "") or "").strip()
        vercel_token = str(integrations.get("vercel_token", "") or "").strip()
        vercel_verified = bool(integrations.get("vercel_verified"))
        stripe_secret = str(integrations.get("stripe_secret_key", "") or "").strip()
        stripe_verified = bool(integrations.get("stripe_verified"))

        warning_seconds = max(30, int(ui_cfg.get("run_stall_warning_seconds", 90) or 90))
        critical_seconds = max(warning_seconds, int(ui_cfg.get("run_stall_critical_seconds", 180) or 180))
        active_run: dict[str, Any] | None = None
        active_incident: dict[str, Any] | None = None
        recent_runs = ctx.run_service.list_runs(limit=200)
        for run in recent_runs:
            if not isinstance(run, dict):
                continue
            status = str(run.get("status", "") or "").strip().lower()
            if status not in ACTIVE_RUN_STATES:
                continue
            run_id = str(run.get("id", "") or "").strip()
            guardrails = ctx.run_service.guardrail_status(run_id) or {}
            project_id = str(run.get("project_id", "") or "").strip()
            workforce = ctx.workforce_presence_service.snapshot(
                project_id=project_id or None,
                include_assigned=True,
                include_reporting=True,
            )
            run_status = build_run_status_payload(
                run,
                guardrails=guardrails,
                workforce_snapshot=workforce,
                heartbeat_seq=0,
            )
            active_incident = detect_run_incident(
                run_status,
                warning_seconds=warning_seconds,
                critical_seconds=critical_seconds,
            )
            active_run = {
                "run_id": run_id,
                "project_id": project_id,
                "status": status,
                "phase_label": str(run_status.get("phase_label", "") or ""),
                "elapsed_seconds": int(run_status.get("elapsed_seconds", 0) or 0),
                "last_activity_at": str(run_status.get("last_activity_at", "") or ""),
            }
            break

        tools = {
            "claude_cli": {"available": bool(claude_cli), "path": claude_cli},
            "codex_cli": {"available": bool(codex_cli), "path": codex_cli},
            "node": {"available": bool(node_bin), "path": node_bin},
            "npm": {"available": bool(npm_bin), "path": npm_bin},
            "python": {"available": bool(python_bin), "path": python_bin},
        }
        integrations_payload = {
            "workspace_mode": workspace_mode,
            "github": {
                "configured": bool(github_token and github_repo),
                "verified": github_verified,
                "repo": github_repo,
            },
            "vercel": {
                "configured": bool(vercel_token and vercel_project_name),
                "verified": vercel_verified,
                "project_name": vercel_project_name,
            },
            "stripe": {
                "configured": bool(stripe_secret),
                "verified": stripe_verified,
            },
        }

        status = "ok"
        if not provider_ready or not workspace_exists or not workspace_writable:
            status = "degraded"
        if active_incident and str(active_incident.get("severity", "")).lower() == "critical":
            status = "degraded"

        return {
            "status": status,
            "app_version": ctx.app_version,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "provider": {
                "name": provider,
                "model": model,
                "mode": anthropic_mode if provider == "anthropic" else openai_mode if provider == "openai" else "apikey",
                "ready": provider_ready,
                "reason": provider_reason,
            },
            "tools": tools,
            "workspace": {
                "root": workspace_root,
                "exists": workspace_exists,
                "writable": workspace_writable,
            },
            "integrations": integrations_payload,
            "active_run": active_run,
            "latest_incident": active_incident,
        }

    @router.get("/health")
    def v1_health() -> dict[str, Any]:
        cfg = ctx.load_config()
        flags = merge_feature_flags(cfg)
        return {
            "status": "ok",
            "version": "v1",
            "app_version": ctx.app_version,
            "features": flags.model_dump(),
        }

    @router.get("/system/readiness")
    def v1_system_readiness() -> dict[str, Any]:
        return _system_readiness_payload()

    @router.get("/feature-flags")
    def v1_feature_flags() -> dict[str, Any]:
        cfg = ctx.load_config()
        flags = merge_feature_flags(cfg)
        return {"status": "ok", "feature_flags": flags.model_dump()}

    @router.patch("/feature-flags")
    def v1_update_feature_flags(request: Request, updates: dict[str, Any]) -> dict[str, Any]:
        _require_mutation_auth(request)
        cfg = ctx.load_config()
        existing = cfg.get("feature_flags", {})
        if not isinstance(existing, dict):
            existing = {}
        for key, value in (updates or {}).items():
            if key in FeatureFlags.model_fields:
                existing[key] = bool(value)
        cfg["feature_flags"] = existing
        ctx.save_config(cfg)
        return {"status": "ok", "feature_flags": merge_feature_flags(cfg).model_dump()}

    @router.get("/chat/response-schema")
    def v1_response_schema() -> dict[str, Any]:
        return {
            "status": "ok",
            "schema": {
                "type": "object",
                "required": ["summary", "delegations", "risks", "next_actions"],
                "properties": {
                    "summary": {"type": "string"},
                    "delegations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["agent", "why", "action"],
                            "properties": {
                                "agent": {"type": "string"},
                                "why": {"type": "string"},
                                "action": {"type": "string"},
                            },
                        },
                    },
                    "risks": {"type": "array", "items": {"type": "string"}},
                    "next_actions": {"type": "array", "items": {"type": "string"}},
                    "deliverables": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["label", "target", "kind"],
                            "properties": {
                                "label": {"type": "string"},
                                "target": {"type": "string"},
                                "kind": {"type": "string", "enum": ["url", "path"]},
                            },
                        },
                    },
                    "validation": {"type": "array", "items": {"type": "string"}},
                    "run_commands": {"type": "array", "items": {"type": "string"}},
                    "open_links": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["label", "target", "kind"],
                            "properties": {
                                "label": {"type": "string"},
                                "target": {"type": "string"},
                                "kind": {"type": "string", "enum": ["url", "path"]},
                            },
                        },
                    },
                    "completion_kind": {"type": "string", "enum": ["build_complete", "general"]},
                },
            },
        }

    @router.get("/update/status")
    def v1_update_status() -> dict[str, Any]:
        if ctx.update_status is None:
            return {
                "status": "error",
                "channel": "release_tags",
                "current_version": ctx.app_version,
                "latest_version": ctx.app_version,
                "update_available": False,
                "dirty_repo": False,
                "can_update": False,
                "block_reason": "Updater is not configured for this deployment.",
            }
        payload = ctx.update_status(False)
        if not isinstance(payload, dict):
            return {"status": "error", "block_reason": "Invalid updater response."}
        payload.pop("_available_tags", None)
        return payload

    @router.post("/update/check")
    def v1_update_check() -> dict[str, Any]:
        if ctx.update_status is None:
            return {
                "status": "error",
                "channel": "release_tags",
                "current_version": ctx.app_version,
                "latest_version": ctx.app_version,
                "update_available": False,
                "dirty_repo": False,
                "can_update": False,
                "block_reason": "Updater is not configured for this deployment.",
            }
        payload = ctx.update_status(True)
        if not isinstance(payload, dict):
            return {"status": "error", "block_reason": "Invalid updater response."}
        payload.pop("_available_tags", None)
        return payload

    @router.post("/update/apply")
    def v1_update_apply(request: Request, body: UpdateApplyRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        if ctx.apply_update is None:
            return {
                "status": "error",
                "channel": "release_tags",
                "from_version": ctx.app_version,
                "to_version": ctx.app_version,
                "update_applied": False,
                "restart_required": False,
                "dirty_repo": False,
                "can_update": False,
                "block_reason": "Updater is not configured for this deployment.",
                "error": "Updater is not configured for this deployment.",
            }
        payload = ctx.apply_update((body.version or "").strip())
        if not isinstance(payload, dict):
            return {
                "status": "error",
                "channel": "release_tags",
                "from_version": ctx.app_version,
                "to_version": ctx.app_version,
                "update_applied": False,
                "restart_required": False,
                "dirty_repo": False,
                "can_update": False,
                "block_reason": "Invalid updater response.",
                "error": "Invalid updater response.",
            }
        return payload

    @router.post("/chat/intents")
    def v1_classify_intent(body: dict[str, Any]) -> dict[str, Any]:
        message = str(body.get("message", "") or "")
        result = _classify_intent(message)
        return {"status": "ok", **result}

    @router.post("/chat/planning-approval")
    def v1_planning_approval(body: dict[str, Any]) -> dict[str, Any]:
        message = str(body.get("message", "") or "")
        classification = _classify_intent(message)
        required = bool(classification.get("needs_planning", False))
        return {
            "status": "ok",
            "planning_required": required,
            "reason": "Task complexity suggests planning before execution." if required else "No planning gate required.",
            "classification": classification,
        }

    @router.get("/chat/memory-policy")
    def v1_memory_policy() -> dict[str, Any]:
        cfg = ctx.load_config()
        policy = cfg.get("chat_policy", {})
        if not isinstance(policy, dict):
            policy = {}
        return {
            "status": "ok",
            "scope": policy.get("memory_scope", "project"),
            "retention_days": int(policy.get("retention_days", 30) or 30),
            "auto_summary_every_messages": int(policy.get("auto_summary_every_messages", 18) or 18),
        }

    @router.patch("/chat/memory-policy")
    def v1_update_memory_policy(request: Request, body: dict[str, Any]) -> dict[str, Any]:
        _require_mutation_auth(request)
        cfg = ctx.load_config()
        policy = cfg.get("chat_policy", {})
        if not isinstance(policy, dict):
            policy = {}
        scope = str(body.get("scope", policy.get("memory_scope", "project")) or "project").lower()
        if scope not in {"global", "project", "session-only"}:
            raise problem_http_exception(
                status=400,
                title="Invalid Memory Scope",
                detail="Scope must be one of: global, project, session-only.",
                type_="https://compaas.dev/problems/invalid-memory-scope",
            )
        policy["memory_scope"] = scope
        policy["retention_days"] = max(1, int(body.get("retention_days", policy.get("retention_days", 30)) or 30))
        policy["auto_summary_every_messages"] = max(
            4, int(body.get("auto_summary_every_messages", policy.get("auto_summary_every_messages", 18)) or 18)
        )
        cfg["chat_policy"] = policy
        ctx.save_config(cfg)
        return {"status": "ok", "chat_policy": policy}

    @router.get("/context/packs")
    def v1_list_context_packs(
        scope: str = Query(default="", description="global | project"),
        project_id: str = Query(default="", description="Project ID for project-scoped packs"),
        enabled: str = Query(default="", description="Filter enabled state: true/false"),
    ) -> dict[str, Any]:
        _ensure_feature("context_packs", "Context Packs", "context-packs-disabled")
        enabled_filter: bool | None = None
        normalized_enabled = str(enabled or "").strip().lower()
        if normalized_enabled in {"true", "1", "yes"}:
            enabled_filter = True
        elif normalized_enabled in {"false", "0", "no"}:
            enabled_filter = False
        packs = context_pack_service.list_packs(
            scope=scope,
            project_id=project_id,
            enabled=enabled_filter,
        )
        return {"status": "ok", "packs": packs}

    @router.post("/context/packs")
    def v1_create_context_pack(request: Request, body: ContextPackCreateRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        _ensure_feature("context_packs", "Context Packs", "context-packs-disabled")
        try:
            pack = context_pack_service.create_pack(
                scope=body.scope,
                project_id=body.project_id.strip(),
                kind=body.kind,
                title=body.title,
                content=body.content,
                enabled=body.enabled,
                pinned=body.pinned,
                source=body.source,
            )
        except ValueError as exc:
            raise problem_http_exception(
                status=400,
                title="Invalid Context Pack",
                detail=str(exc),
                type_="https://compaas.dev/problems/invalid-context-pack",
            )
        emit_activity(
            ctx.data_dir,
            "ceo",
            "CREATED",
            f"Context pack '{pack.get('title', '')}' created",
            project_id=str(pack.get("project_id", "") or ""),
            metadata={"scope": pack.get("scope", ""), "kind": pack.get("kind", "")},
        )
        return {"status": "ok", "pack": pack}

    @router.patch("/context/packs/{pack_id}")
    def v1_update_context_pack(request: Request, pack_id: str, body: ContextPackUpdateRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        _ensure_feature("context_packs", "Context Packs", "context-packs-disabled")
        updates: dict[str, Any] = {}
        if body.kind:
            updates["kind"] = body.kind
        if body.title:
            updates["title"] = body.title
        if body.content:
            updates["content"] = body.content
        if body.enabled is not None:
            updates["enabled"] = body.enabled
        if body.pinned is not None:
            updates["pinned"] = body.pinned
        if body.source:
            updates["source"] = body.source
        pack = context_pack_service.update_pack(pack_id, updates)
        if not pack:
            raise problem_http_exception(
                status=404,
                title="Context Pack Not Found",
                detail=f"Context pack '{pack_id}' was not found.",
                type_="https://compaas.dev/problems/context-pack-not-found",
            )
        emit_activity(
            ctx.data_dir,
            "ceo",
            "UPDATED",
            f"Context pack '{pack.get('title', '')}' updated",
            project_id=str(pack.get("project_id", "") or ""),
            metadata={"pack_id": pack_id, "scope": pack.get("scope", "")},
        )
        return {"status": "ok", "pack": pack}

    @router.delete("/context/packs/{pack_id}")
    def v1_delete_context_pack(request: Request, pack_id: str) -> dict[str, Any]:
        _require_mutation_auth(request)
        _ensure_feature("context_packs", "Context Packs", "context-packs-disabled")
        deleted = context_pack_service.delete_pack(pack_id)
        if not deleted:
            raise problem_http_exception(
                status=404,
                title="Context Pack Not Found",
                detail=f"Context pack '{pack_id}' was not found.",
                type_="https://compaas.dev/problems/context-pack-not-found",
            )
        emit_activity(
            ctx.data_dir,
            "ceo",
            "DELETED",
            f"Context pack '{pack_id}' deleted",
            metadata={"pack_id": pack_id},
        )
        return {"status": "ok", "deleted": True, "pack_id": pack_id}

    @router.post("/projects")
    def v1_create_project(
        request: Request,
        body: ProjectCreateRequest,
        idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        _require_mutation_auth(request)
        project, created = ctx.project_service.create_project(
            name=body.name,
            description=body.description,
            project_type=body.type,
            idempotency_key=idempotency_key.strip(),
        )
        project_id = str(project.get("id", "") or "")
        emit_activity(
            ctx.data_dir,
            "ceo",
            "CREATED",
            f"Project '{body.name}' initialized",
            project_id=project_id,
            metadata={"idempotency_key": idempotency_key[:80]},
        )
        return {"status": "ok", "created": created, "project": project}

    @router.get("/projects/{project_id}/metadata")
    def v1_project_metadata(project_id: str) -> dict[str, Any]:
        try:
            metadata = ctx.project_service.get_metadata(project_id)
        except ValueError as exc:
            raise problem_http_exception(
                status=404,
                title="Project Not Found",
                detail=str(exc),
                type_="https://compaas.dev/problems/project-not-found",
            )
        return {"status": "ok", "metadata": metadata}

    @router.patch("/projects/{project_id}/metadata")
    def v1_project_metadata_update(request: Request, project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        _require_mutation_auth(request)
        try:
            metadata = ctx.project_service.update_metadata(project_id, body)
        except ValueError as exc:
            raise problem_http_exception(
                status=404,
                title="Project Not Found",
                detail=str(exc),
                type_="https://compaas.dev/problems/project-not-found",
            )
        return {"status": "ok", "metadata": metadata}

    @router.get("/projects/{project_id}/reviews/sessions")
    def v1_list_review_sessions(
        project_id: str,
        status: str = Query(default="", description="Filter by session status"),
        cursor: str = Query(default="", description="Offset cursor"),
        limit: int = Query(default=20, ge=1, le=200),
    ) -> dict[str, Any]:
        _ensure_feature("preview_review_layer", "Preview Review Layer", "preview-review-disabled")
        try:
            payload = review_service.list_sessions(
                project_id,
                status=status,
                cursor=cursor,
                limit=limit,
            )
        except ValueError as exc:
            raise problem_http_exception(
                status=404,
                title="Project Not Found",
                detail=str(exc),
                type_="https://compaas.dev/problems/project-not-found",
            )
        return {"status": "ok", **payload}

    @router.post("/projects/{project_id}/reviews/sessions")
    def v1_create_review_session(
        request: Request,
        project_id: str,
        body: ReviewSessionCreateRequest,
    ) -> dict[str, Any]:
        _require_mutation_auth(request)
        _ensure_feature("preview_review_layer", "Preview Review Layer", "preview-review-disabled")
        try:
            session = review_service.create_session(
                project_id,
                deployment_url=body.deployment_url,
                run_id=body.run_id,
                source=body.source,
                created_by=body.created_by,
            )
        except ValueError as exc:
            raise problem_http_exception(
                status=400,
                title="Invalid Review Session",
                detail=str(exc),
                type_="https://compaas.dev/problems/invalid-review-session",
            )
        emit_activity(
            ctx.data_dir,
            "ceo",
            "REVIEW_OPENED",
            f"Preview review opened for project {project_id}.",
            project_id=project_id,
            metadata={
                "session_id": session.get("id", ""),
                "deployment_url": session.get("deployment_url", ""),
            },
        )
        return {"status": "ok", "session": session}

    @router.get("/reviews/sessions/{session_id}")
    def v1_get_review_session(session_id: str) -> dict[str, Any]:
        _ensure_feature("preview_review_layer", "Preview Review Layer", "preview-review-disabled")
        payload = review_service.get_session(session_id)
        if not payload:
            raise problem_http_exception(
                status=404,
                title="Review Session Not Found",
                detail=f"Review session '{session_id}' was not found.",
                type_="https://compaas.dev/problems/review-session-not-found",
            )
        return {"status": "ok", **payload}

    @router.post("/reviews/sessions/{session_id}/comments")
    def v1_add_review_comment(
        request: Request,
        session_id: str,
        body: ReviewCommentCreateRequest,
    ) -> dict[str, Any]:
        _require_mutation_auth(request)
        _ensure_feature("preview_review_layer", "Preview Review Layer", "preview-review-disabled")
        try:
            comment = review_service.add_comment(
                session_id,
                route=body.route,
                element_hint=body.element_hint,
                note=body.note,
                severity=body.severity,
                status=body.status,
                author=body.author,
                tags=body.tags,
            )
        except ValueError as exc:
            raise problem_http_exception(
                status=400,
                title="Invalid Review Comment",
                detail=str(exc),
                type_="https://compaas.dev/problems/invalid-review-comment",
            )
        session_payload = review_service.get_session(session_id)
        project_id_value = str((session_payload or {}).get("project_id", "") or "")
        emit_activity(
            ctx.data_dir,
            "ceo",
            "REVIEW_COMMENTED",
            "Review comment added.",
            project_id=project_id_value,
            metadata={
                "session_id": session_id,
                "comment_id": comment.get("id", ""),
                "severity": comment.get("severity", ""),
            },
        )
        return {"status": "ok", "comment": comment}

    @router.patch("/reviews/comments/{comment_id}")
    def v1_update_review_comment(
        request: Request,
        comment_id: str,
        body: ReviewCommentPatchRequest,
    ) -> dict[str, Any]:
        _require_mutation_auth(request)
        _ensure_feature("preview_review_layer", "Preview Review Layer", "preview-review-disabled")
        updates: dict[str, Any] = {}
        if body.status:
            updates["status"] = body.status
        if body.severity:
            updates["severity"] = body.severity
        if body.note:
            updates["note"] = body.note
        if body.route:
            updates["route"] = body.route
        if body.element_hint:
            updates["element_hint"] = body.element_hint
        if body.tags:
            updates["tags"] = body.tags
        comment = review_service.update_comment(comment_id, updates)
        if not comment:
            raise problem_http_exception(
                status=404,
                title="Review Comment Not Found",
                detail=f"Review comment '{comment_id}' was not found.",
                type_="https://compaas.dev/problems/review-comment-not-found",
            )
        action = "REVIEW_RESOLVED" if str(comment.get("status", "")).lower() == "resolved" else "REVIEW_COMMENTED"
        session_payload = review_service.get_session(str(comment.get("session_id", "") or ""))
        project_id_value = str((session_payload or {}).get("project_id", "") or "")
        emit_activity(
            ctx.data_dir,
            "ceo",
            action,
            "Review comment updated.",
            project_id=project_id_value,
            metadata={"comment_id": comment_id, "status": comment.get("status", "")},
        )
        return {"status": "ok", "comment": comment}

    @router.post("/projects/{project_id}/clone")
    def v1_clone_project(request: Request, project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        _require_mutation_auth(request)
        new_name = str(body.get("name", "") or "")
        try:
            cloned = ctx.project_service.clone_project(project_id, new_name=new_name)
        except ValueError as exc:
            raise problem_http_exception(
                status=404,
                title="Project Not Found",
                detail=str(exc),
                type_="https://compaas.dev/problems/project-not-found",
            )
        return {"status": "ok", "project": cloned}

    @router.post("/projects/{project_id}/archive")
    def v1_archive_project(request: Request, project_id: str) -> dict[str, Any]:
        _require_mutation_auth(request)
        try:
            meta = ctx.project_service.set_archived(project_id, True)
        except ValueError as exc:
            raise problem_http_exception(
                status=404,
                title="Project Not Found",
                detail=str(exc),
                type_="https://compaas.dev/problems/project-not-found",
            )
        return {"status": "ok", "metadata": meta}

    @router.post("/projects/{project_id}/restore")
    def v1_restore_project(request: Request, project_id: str) -> dict[str, Any]:
        _require_mutation_auth(request)
        try:
            project = ctx.project_service.restore_project(project_id)
        except ValueError as exc:
            raise problem_http_exception(
                status=404,
                title="Project Not Found",
                detail=str(exc),
                type_="https://compaas.dev/problems/project-not-found",
            )
        return {"status": "ok", "project": project}

    @router.get("/projects/archived")
    def v1_archived_projects() -> dict[str, Any]:
        return {"status": "ok", "projects": ctx.project_service.list_archived()}

    @router.get("/projects/{project_id}/delta")
    def v1_project_delta(project_id: str, since: str = Query(default="")) -> dict[str, Any]:
        return {"status": "ok", "delta": ctx.project_service.delta_since(project_id, since_iso=since or None)}

    @router.get("/projects/{project_id}/readme-quality")
    def v1_readme_quality(project_id: str) -> dict[str, Any]:
        try:
            report = ctx.project_service.readme_quality(project_id)
        except ValueError as exc:
            raise problem_http_exception(
                status=404,
                title="Project Not Found",
                detail=str(exc),
                type_="https://compaas.dev/problems/project-not-found",
            )
        return {"status": "ok", "report": report}

    @router.get("/projects/{project_id}/analytics")
    def v1_project_analytics(project_id: str) -> dict[str, Any]:
        try:
            analytics = ctx.project_service.analytics(project_id)
        except ValueError as exc:
            raise problem_http_exception(
                status=404,
                title="Project Not Found",
                detail=str(exc),
                type_="https://compaas.dev/problems/project-not-found",
            )
        return {"status": "ok", "analytics": analytics}

    @router.get("/projects/{project_id}/artifacts")
    def v1_project_artifacts(project_id: str) -> dict[str, Any]:
        metadata = ctx.project_service.get_metadata(project_id)
        artifacts = metadata.get("artifacts", [])
        return {"status": "ok", "artifacts": artifacts if isinstance(artifacts, list) else []}

    @router.post("/projects/{project_id}/artifacts")
    def v1_register_artifact(request: Request, project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        _require_mutation_auth(request)
        file_path = str(body.get("file_path", "") or "").strip()
        action = str(body.get("action", "created") or "created").strip()
        if not file_path:
            raise problem_http_exception(
                status=400,
                title="Invalid Artifact",
                detail="file_path is required.",
                type_="https://compaas.dev/problems/invalid-artifact",
            )
        meta = ctx.project_service.register_artifact(
            project_id,
            file_path=file_path,
            action=action,
            run_id=str(body.get("run_id", "") or ""),
            agent=str(body.get("agent", "ceo") or "ceo"),
        )
        return {"status": "ok", "metadata": meta}

    @router.post("/runs")
    def v1_create_run(
        request: Request,
        body: RunCreateRequest,
        idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        _require_mutation_auth(request)
        correlation_id = str(uuid.uuid4())[:12]
        try:
            run, created = ctx.run_service.create_run(
                project_id=body.project_id,
                message=body.message,
                provider=body.provider,
                sandbox_profile=body.sandbox_profile,
                idempotency_key=idempotency_key.strip(),
                mode=body.mode,
                metadata=body.metadata,
            )
        except RuntimeError as exc:
            raise problem_http_exception(
                status=409,
                title="Concurrency Limit Reached",
                detail=str(exc),
                type_="https://compaas.dev/problems/project-concurrency-limit",
            )
        return {"status": "ok", "created": created, "run": run, "correlation_id": correlation_id}

    @router.get("/activity/recent")
    def v1_recent_activity(
        limit: int = Query(default=100, ge=1, le=500),
        cursor: str = Query(default=""),
    ) -> dict[str, Any]:
        """Cursor-based activity pagination using newest-window offsets."""
        activity_log_path = os.path.join(ctx.data_dir, "activity.log")
        if not os.path.exists(activity_log_path):
            return {
                "status": "ok",
                "events": [],
                "next_cursor": "",
                "total_estimate": 0,
            }

        events: list[dict[str, Any]] = []
        try:
            with open(activity_log_path, encoding="utf-8") as f:
                for line in f:
                    row = line.strip()
                    if not row:
                        continue
                    try:
                        payload = json.loads(row)
                    except (ValueError, TypeError):
                        continue
                    if isinstance(payload, dict):
                        events.append(payload)
        except OSError:
            return {
                "status": "ok",
                "events": [],
                "next_cursor": "",
                "total_estimate": 0,
            }

        total = len(events)
        if total <= 0:
            return {
                "status": "ok",
                "events": [],
                "next_cursor": "",
                "total_estimate": 0,
            }

        offset = 0
        raw_cursor = str(cursor or "").strip()
        if raw_cursor:
            try:
                offset = max(0, int(raw_cursor))
            except ValueError:
                offset = 0
        window_end = max(0, total - offset)
        window_start = max(0, window_end - limit)
        page = events[window_start:window_end]
        next_cursor = ""
        if window_start > 0:
            next_cursor = str(offset + len(page))
        return {
            "status": "ok",
            "events": page,
            "next_cursor": next_cursor,
            "total_estimate": total,
        }

    @router.get("/runs")
    def v1_list_runs(
        project_id: str = Query(default=""),
        status: str = Query(default=""),
        limit: int = Query(default=100, ge=1, le=500),
        cursor: str = Query(default=""),
    ) -> dict[str, Any]:
        offset = 0
        if cursor.strip():
            try:
                offset = max(0, int(cursor.strip()))
            except ValueError:
                offset = 0
        page, total = ctx.run_service.list_runs_page(
            project_id=project_id,
            status=status,
            offset=offset,
            limit=limit,
        )
        next_cursor = ""
        if (offset + len(page)) < total:
            next_cursor = str(offset + len(page))
        return {
            "status": "ok",
            "runs": page,
            "next_cursor": next_cursor,
            "total_estimate": total,
        }

    @router.get("/workforce/live")
    def v1_workforce_live(
        project_id: str = Query(default=""),
        include_assigned: bool = Query(default=True),
        include_reporting: bool = Query(default=True),
    ) -> dict[str, Any]:
        scoped_project_id = str(project_id or "").strip()
        return ctx.workforce_presence_service.snapshot(
            project_id=scoped_project_id or None,
            include_assigned=include_assigned,
            include_reporting=include_reporting,
        )

    @router.get("/runs/{run_id}")
    def v1_get_run(run_id: str) -> dict[str, Any]:
        run = ctx.run_service.get_run(run_id)
        if not run:
            raise problem_http_exception(
                status=404,
                title="Run Not Found",
                detail=f"Run '{run_id}' does not exist.",
                type_="https://compaas.dev/problems/run-not-found",
            )
        return {"status": "ok", "run": run}

    @router.get("/runs/{run_id}/live")
    def v1_run_live(run_id: str) -> dict[str, Any]:
        correlation_id = str(uuid.uuid4())[:12]
        run = ctx.run_service.get_run(run_id)
        if not run:
            raise problem_http_exception(
                status=404,
                title="Run Not Found",
                detail=f"Run '{run_id}' does not exist.",
                type_="https://compaas.dev/problems/run-not-found",
            )
        cfg = ctx.load_config()
        ui_cfg = cfg.get("ui", {}) if isinstance(cfg.get("ui"), dict) else {}
        warning_seconds = max(30, int(ui_cfg.get("run_stall_warning_seconds", 90) or 90))
        critical_seconds = max(warning_seconds, int(ui_cfg.get("run_stall_critical_seconds", 180) or 180))
        guardrails = ctx.run_service.guardrail_status(run_id) or {}
        project_id = str(run.get("project_id", "") or "").strip()
        workforce = ctx.workforce_presence_service.snapshot(
            project_id=project_id or None,
            include_assigned=True,
            include_reporting=True,
        )
        run_status = build_run_status_payload(
            run,
            guardrails=guardrails,
            workforce_snapshot=workforce,
            heartbeat_seq=0,
        )
        incident = detect_run_incident(
            run_status,
            warning_seconds=warning_seconds,
            critical_seconds=critical_seconds,
        )
        return {
            "status": "ok",
            "correlation_id": correlation_id,
            "run": run,
            "run_status": run_status,
            "guardrails": guardrails,
            "workforce": workforce,
            "incident": incident,
        }

    @router.post("/runs/{run_id}/control")
    def v1_control_run(request: Request, run_id: str, body: RunControlRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        correlation_id = str(uuid.uuid4())[:12]
        action = str(body.action or "status").strip().lower()
        if action not in {"status", "retry_step", "cancel", "continue"}:
            raise problem_http_exception(
                status=400,
                title="Invalid Run Control Action",
                detail="action must be one of: status, retry_step, cancel, continue.",
                type_="https://compaas.dev/problems/invalid-run-control-action",
            )
        run = ctx.run_service.get_run(run_id)
        if not run:
            raise problem_http_exception(
                status=404,
                title="Run Not Found",
                detail=f"Run '{run_id}' does not exist.",
                type_="https://compaas.dev/problems/run-not-found",
            )

        acknowledged = True
        message = ""
        step = str(body.step or "manual retry").strip() or "manual retry"
        if action == "cancel":
            cancelled = ctx.run_service.cancel_run(run_id, reason="Cancelled by user control")
            if cancelled:
                run = cancelled
                ctx.workforce_presence_service.mark_run_terminal(
                    run_id=str(run.get("id", "") or run_id),
                    project_id=str(run.get("project_id", "") or ""),
                    terminal_state="cancelled",
                )
                message = "Run cancelled."
            else:
                acknowledged = False
                message = "Unable to cancel run."
        elif action == "retry_step":
            transitioned = ctx.run_service.transition_run(
                run_id,
                state="executing",
                label=f"Retry requested: {step}",
                metadata={"retry_step": step},
            )
            if transitioned:
                run = transitioned
                message = f"Retry started for step: {step}"
            else:
                acknowledged = False
                message = "Unable to retry step."
        elif action == "continue":
            guardrails = ctx.run_service.guardrail_status(run_id) or {}
            autopilot = evaluate_guarded_autopilot(
                guardrails=guardrails,
                transition_label="continue",
                transition_metadata={"step": step},
                runtime_risk_threshold_pct=80,
            )
            if autopilot.get("requires_confirmation") and not bool(body.force):
                acknowledged = False
                reasons = autopilot.get("reasons", [])
                message = "Continue blocked by guarded autopilot."
                if isinstance(reasons, list) and reasons:
                    message = f"{message} {reasons[0]}"
            else:
                transitioned = ctx.run_service.transition_run(
                    run_id,
                    state="executing",
                    label=f"Continue requested: {step}",
                    metadata={"continue_step": step, "forced": bool(body.force)},
                )
                if transitioned:
                    run = transitioned
                    message = "Run continued."
                else:
                    acknowledged = False
                    message = "Unable to continue run."
        else:
            message = "Run status fetched."

        cfg = ctx.load_config()
        ui_cfg = cfg.get("ui", {}) if isinstance(cfg.get("ui"), dict) else {}
        warning_seconds = max(30, int(ui_cfg.get("run_stall_warning_seconds", 90) or 90))
        critical_seconds = max(warning_seconds, int(ui_cfg.get("run_stall_critical_seconds", 180) or 180))
        guardrails = ctx.run_service.guardrail_status(run_id) or {}
        project_id = str(run.get("project_id", "") or "").strip()
        workforce = ctx.workforce_presence_service.snapshot(
            project_id=project_id or None,
            include_assigned=True,
            include_reporting=True,
        )
        run_status = build_run_status_payload(
            run,
            guardrails=guardrails,
            workforce_snapshot=workforce,
            heartbeat_seq=0,
        )
        incident = detect_run_incident(
            run_status,
            warning_seconds=warning_seconds,
            critical_seconds=critical_seconds,
        )
        return {
            "status": "ok",
            "correlation_id": correlation_id,
            "run": run,
            "run_status": run_status,
            "guardrails": guardrails,
            "workforce": workforce,
            "incident": incident,
            "run_control_ack": {
                "run_id": run_id,
                "action": action,
                "acknowledged": acknowledged,
                "message": message,
            },
        }

    @router.post("/runs/{run_id}/cancel")
    def v1_cancel_run(request: Request, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        _require_mutation_auth(request)
        reason = str(body.get("reason", "Cancelled by user") or "Cancelled by user")
        run = ctx.run_service.cancel_run(run_id, reason=reason)
        if not run:
            raise problem_http_exception(
                status=404,
                title="Run Not Found",
                detail=f"Run '{run_id}' does not exist.",
                type_="https://compaas.dev/problems/run-not-found",
            )
        ctx.workforce_presence_service.mark_run_terminal(
            run_id=str(run.get("id", "") or run_id),
            project_id=str(run.get("project_id", "") or ""),
            terminal_state="cancelled",
        )
        return {"status": "ok", "run": run}

    @router.get("/runs/{run_id}/replay")
    def v1_replay(run_id: str) -> dict[str, Any]:
        replay = ctx.run_service.replay(run_id)
        if not replay:
            raise problem_http_exception(
                status=404,
                title="Run Not Found",
                detail=f"Run '{run_id}' does not exist.",
                type_="https://compaas.dev/problems/run-not-found",
            )
        return {"status": "ok", "replay": replay}

    @router.get("/runs/{run_id}/guardrails")
    def v1_guardrails(run_id: str) -> dict[str, Any]:
        guardrails = ctx.run_service.guardrail_status(run_id)
        if guardrails is None:
            raise problem_http_exception(
                status=404,
                title="Run Not Found",
                detail=f"Run '{run_id}' does not exist.",
                type_="https://compaas.dev/problems/run-not-found",
            )
        return {"status": "ok", "guardrails": guardrails}

    @router.post("/runs/{run_id}/retry-step")
    def v1_retry_step(request: Request, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        _require_mutation_auth(request)
        step_label = str(body.get("step", "manual retry") or "manual retry").strip()
        run = ctx.run_service.transition_run(
            run_id,
            state="executing",
            label=f"Retry requested: {step_label}",
            metadata={"retry_step": step_label},
        )
        if not run:
            raise problem_http_exception(
                status=404,
                title="Run Not Found",
                detail=f"Run '{run_id}' does not exist.",
                type_="https://compaas.dev/problems/run-not-found",
            )
        return {"status": "ok", "run": run}

    @router.get("/sandbox/profiles")
    def v1_sandbox_profiles() -> dict[str, Any]:
        return {
            "status": "ok",
            "profiles": {
                "safe": resolve_sandbox_profile("safe").model_dump(),
                "standard": resolve_sandbox_profile("standard").model_dump(),
                "full": resolve_sandbox_profile("full").model_dump(),
            },
        }

    @router.post("/github/repos")
    def v1_github_repos(body: dict[str, Any]) -> dict[str, Any]:
        token = str(body.get("token", "") or "").strip()
        if not token:
            raise HTTPException(status_code=400, detail="token is required")
        return ctx.integration_service.list_github_repos(token)

    @router.post("/github/verify")
    def v1_github_verify(request: Request, body: GithubVerifyRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        cfg = ctx.load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        token = body.token.strip() or str(integrations.get("github_token", "") or "").strip()
        repo = body.repo.strip() or str(integrations.get("github_repo", "") or "").strip()
        result = ctx.integration_service.github_verify_connection(token, repo=repo)

        if token:
            integrations["github_token"] = token
        if repo:
            integrations["github_repo"] = repo

        verified = bool(result.get("ok")) and bool(result.get("repo_ok"))
        integrations["github_verified"] = verified
        integrations["github_last_error"] = "" if verified else str(result.get("message", "") or "GitHub verification failed.")
        if verified:
            integrations["github_verified_at"] = datetime.now(timezone.utc).isoformat()

        cfg["integrations"] = integrations
        ctx.save_config(cfg)

        account = result.get("account", {})
        return {
            "ok": verified,
            "account": account if isinstance(account, dict) else {},
            "repo_ok": bool(result.get("repo_ok")),
            "message": result.get("message", ""),
        }

    @router.post("/github/repo/create")
    def v1_github_repo_create(request: Request, body: GithubRepoCreateRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        return ctx.integration_service.create_github_repo(
            body.token,
            name=body.name,
            private=body.private,
            description=body.description,
        )

    @router.post("/github/branch/create")
    def v1_github_branch_create(request: Request, body: GithubBranchRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        result = ctx.integration_service.create_branch(
            body.repo_path,
            base_branch=body.base_branch,
            new_branch=body.new_branch,
        )
        _raise_invalid_repo_path(result)
        return result

    @router.post("/github/pr/template")
    def v1_github_pr_template(body: dict[str, Any]) -> dict[str, Any]:
        title = str(body.get("title", "") or "AI-generated update")
        summary = str(body.get("summary", "") or "")
        run_id = str(body.get("run_id", "") or "unknown")
        provider = str(body.get("provider", "") or "unknown")
        label = ctx.integration_service.infer_change_type_label(summary)
        template = ctx.integration_service.build_pr_template(
            title=title,
            summary=summary,
            run_id=run_id,
            provider=provider,
        )
        return {"status": "ok", "label": label, "template": template}

    @router.get("/github/pr-quality-profile")
    def v1_github_pr_quality_profile() -> dict[str, Any]:
        cfg = ctx.load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        profile = str(integrations.get("pr_quality_profile", "balanced") or "balanced").strip().lower()
        if profile not in {"strict", "balanced", "fast"}:
            profile = "balanced"
        return {
            "status": "ok",
            "profile": profile,
            "options": ["strict", "balanced", "fast"],
        }

    @router.patch("/github/pr-quality-profile")
    def v1_set_github_pr_quality_profile(request: Request, body: PrQualityProfileRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        profile = str(body.profile or "balanced").strip().lower()
        if profile not in {"strict", "balanced", "fast"}:
            raise HTTPException(status_code=400, detail="profile must be strict, balanced, or fast")
        cfg = ctx.load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        integrations["pr_quality_profile"] = profile
        cfg["integrations"] = integrations
        ctx.save_config(cfg)
        emit_activity(
            ctx.data_dir,
            "ceo",
            "UPDATED",
            f"PR quality profile set to {profile}.",
            metadata={"profile": profile},
        )
        return {"status": "ok", "profile": profile}

    @router.post("/github/prepush/scan")
    def v1_github_secret_scan(request: Request, body: dict[str, Any]) -> dict[str, Any]:
        _require_mutation_auth(request)
        repo_path = str(body.get("repo_path", "") or "").strip()
        if not repo_path:
            raise HTTPException(status_code=400, detail="repo_path is required")
        result = ctx.integration_service.pre_push_secret_scan(repo_path)
        _raise_invalid_repo_path(result)
        return result

    @router.post("/github/sync")
    def v1_github_sync(request: Request, body: GithubSyncRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        result = ctx.integration_service.sync_remote(body.repo_path, default_branch=body.default_branch)
        _raise_invalid_repo_path(result)
        return result

    @router.post("/github/drift")
    def v1_github_drift(request: Request, body: GithubSyncRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        result = ctx.integration_service.detect_drift(body.repo_path, default_branch=body.default_branch)
        _raise_invalid_repo_path(result)
        return result

    @router.post("/github/rollback")
    def v1_github_rollback(request: Request, body: GithubRollbackRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        result = ctx.integration_service.rollback_commit(body.repo_path, body.commit_sha)
        _raise_invalid_repo_path(result)
        return result

    @router.post("/github/issues/sync")
    def v1_github_issue_sync(request: Request, body: dict[str, Any]) -> dict[str, Any]:
        _require_mutation_auth(request)
        project_id = str(body.get("project_id", "") or "").strip()
        if not project_id:
            raise HTTPException(status_code=400, detail="project_id is required")
        tasks = ctx.project_service.task_board.get_board(project_id)
        issues = []
        for task in tasks:
            issues.append(
                {
                    "title": task.get("title", ""),
                    "body": task.get("description", ""),
                    "labels": [ctx.integration_service.infer_change_type_label(task.get("title", ""))],
                    "state": "closed" if str(task.get("status", "")).lower() == "done" else "open",
                }
            )
        return {"status": "ok", "issues": issues, "count": len(issues)}

    def _resolve_vercel_creds(
        token: str = "",
        project_name: str = "",
        team_id: str = "",
    ) -> tuple[str, str, str]:
        """Resolve Vercel credentials from request body, falling back to saved config."""
        cfg = ctx.load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        return (
            token.strip() or str(integrations.get("vercel_token", "") or "").strip(),
            project_name.strip() or str(integrations.get("vercel_project_name", "") or "").strip(),
            team_id.strip() or str(integrations.get("vercel_team_id", "") or "").strip(),
        )

    @router.post("/vercel/link")
    def v1_vercel_link(request: Request, body: VercelLinkRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        token, project_name, team_id = _resolve_vercel_creds(body.token, body.project_name, body.team_id)
        return ctx.integration_service.vercel_link_project(token, name=project_name, team_id=team_id)

    @router.post("/vercel/verify")
    def v1_vercel_verify(request: Request, body: VercelVerifyRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        cfg = ctx.load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        token, project_name, team_id = _resolve_vercel_creds(body.token, body.project_name, body.team_id)
        result = ctx.integration_service.vercel_verify_connection(
            token,
            project_name=project_name,
            team_id=team_id,
        )

        if token:
            integrations["vercel_token"] = token
        if team_id:
            integrations["vercel_team_id"] = team_id
        if project_name:
            integrations["vercel_project_name"] = project_name

        verified = bool(result.get("ok")) and bool(result.get("project_ok"))
        integrations["vercel_verified"] = verified
        integrations["vercel_last_error"] = "" if verified else str(result.get("message", "") or "Vercel verification failed.")
        if verified:
            integrations["vercel_verified_at"] = datetime.now(timezone.utc).isoformat()

        cfg["integrations"] = integrations
        ctx.save_config(cfg)

        account = result.get("account", {})
        return {
            "ok": verified,
            "account": account if isinstance(account, dict) else {},
            "project_ok": bool(result.get("project_ok")),
            "message": result.get("message", ""),
        }

    @router.post("/stripe/verify")
    def v1_stripe_verify(request: Request, body: StripeVerifyRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        _ensure_feature("stripe_billing_pack", "Stripe Billing Pack", "stripe-billing-disabled")
        cfg = ctx.load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        secret = body.secret_key.strip() or str(integrations.get("stripe_secret_key", "") or "").strip()
        result = ctx.integration_service.stripe_verify_connection(secret)
        if secret:
            integrations["stripe_secret_key"] = secret
        verified = bool(result.get("ok"))
        integrations["stripe_verified"] = verified
        integrations["stripe_last_error"] = "" if verified else str(result.get("message", "") or "Stripe verification failed.")
        if verified:
            integrations["stripe_verified_at"] = datetime.now(timezone.utc).isoformat()
        cfg["integrations"] = integrations
        ctx.save_config(cfg)

        account = result.get("account", {})
        return {
            "ok": verified,
            "account": account if isinstance(account, dict) else {},
            "message": result.get("message", ""),
        }

    @router.post("/vercel/deploy")
    def v1_vercel_deploy(request: Request, body: VercelDeployRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        token, project_name, team_id = _resolve_vercel_creds(body.token, body.project_name, body.team_id)
        target = body.target.lower().strip() or "preview"
        if target not in {"preview", "production"}:
            raise HTTPException(status_code=400, detail="target must be preview or production")
        return ctx.integration_service.vercel_deploy(
            token,
            project_name=project_name,
            team_id=team_id,
            target=target,
            git_source=body.git_source,
        )

    @router.post("/vercel/domain")
    def v1_vercel_domain(request: Request, body: VercelDomainRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        token, project_name, team_id = _resolve_vercel_creds(body.token, body.project_name, body.team_id)
        return ctx.integration_service.vercel_assign_domain(
            token,
            project_name=project_name,
            domain=body.domain,
            team_id=team_id,
        )

    @router.post("/vercel/env")
    def v1_vercel_env(request: Request, body: VercelEnvRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        token, project_name, team_id = _resolve_vercel_creds(body.token, body.project_name, body.team_id)
        return ctx.integration_service.vercel_set_env(
            token,
            project_name=project_name,
            key=body.key,
            value=body.value,
            target=body.target,
            team_id=team_id,
        )

    @router.post("/projects/{project_id}/deploy/vercel")
    def v1_project_vercel_deploy(request: Request, project_id: str, body: ProjectVercelDeployRequest) -> dict[str, Any]:
        _require_mutation_auth(request)
        project = ctx.project_service.state_manager.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found.")

        cfg = ctx.load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        vercel_token = str(integrations.get("vercel_token", "") or "").strip()
        vercel_project_name = str(integrations.get("vercel_project_name", "") or "").strip()
        vercel_verified = bool(integrations.get("vercel_verified"))

        if not vercel_token or not vercel_project_name:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "vercel_not_configured",
                    "message": "Vercel is not configured yet. Open Settings → Integrations and connect Vercel.",
                    "settings_target": "vercel",
                },
            )
        if not vercel_verified:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "vercel_not_verified",
                    "message": "Vercel is configured but not verified yet. Verify the connector in Settings.",
                    "settings_target": "vercel",
                },
            )

        target = (body.target or str(integrations.get("vercel_default_target", "preview") or "preview")).strip().lower()
        if target not in {"preview", "production"}:
            target = "preview"

        deploy_result = ctx.integration_service.vercel_deploy_saved(integrations, target=target)
        if deploy_result.get("status") != "ok":
            raise HTTPException(
                status_code=502,
                detail=deploy_result.get("message", "Failed to deploy project to Vercel."),
            )

        deployment_url = str(deploy_result.get("deployment_url", "") or "").strip()
        deployment_payload = deploy_result.get("deployment")
        emit_activity(
            ctx.data_dir,
            "ceo",
            "DEPLOY_PREVIEW" if target == "preview" else "DEPLOY_PRODUCTION",
            f"Vercel deployment created for {project.get('name', project_id)}",
            project_id=project_id,
            metadata={
                "target": target,
                "deployment_url": deployment_url,
                "deployment": deployment_payload if isinstance(deployment_payload, dict) else {},
            },
        )

        metadata = ctx.project_service.get_metadata(project_id)
        deployments = metadata.get("deployments", [])
        if not isinstance(deployments, list):
            deployments = []
        deployments.append(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "target": target,
                "url": deployment_url,
                "provider": "vercel",
            }
        )
        ctx.project_service.update_metadata(project_id, {"deployments": deployments[-50:]})

        return {
            "ok": True,
            "target": target,
            "deployment_url": deployment_url,
        }

    @router.post("/projects/{project_id}/deploy/promote")
    def v1_project_promote_to_production(request: Request, project_id: str) -> dict[str, Any]:
        """Promote a project by creating a production deployment."""
        return v1_project_vercel_deploy(
            request=request,
            project_id=project_id,
            body=ProjectVercelDeployRequest(target="production"),
        )

    @router.get("/projects/{project_id}/billing/stripe/status")
    def v1_project_stripe_billing_status(project_id: str) -> dict[str, Any]:
        _ensure_feature("stripe_billing_pack", "Stripe Billing Pack", "stripe-billing-disabled")
        try:
            validate_safe_id(project_id, "project_id")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid project ID format.")
        project = ctx.project_service.state_manager.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found.")

        cfg = ctx.load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        artifact_path = os.path.join(ctx.data_dir, "projects", project_id, "artifacts", "04_billing_pack.md")
        artifact_exists = os.path.exists(artifact_path)
        artifact_updated_at = ""
        if artifact_exists:
            try:
                artifact_updated_at = datetime.fromtimestamp(os.path.getmtime(artifact_path), tz=timezone.utc).isoformat()
            except OSError:
                artifact_updated_at = ""
        metadata = ctx.project_service.get_metadata(project_id)
        billing_meta = metadata.get("billing", {}) if isinstance(metadata.get("billing"), dict) else {}
        stripe_meta = billing_meta.get("stripe", {}) if isinstance(billing_meta.get("stripe"), dict) else {}
        return {
            "status": "ok",
            "project_id": project_id,
            "artifact_exists": artifact_exists,
            "artifact_path": artifact_path if artifact_exists else "",
            "artifact_updated_at": artifact_updated_at,
            "stripe_configured": bool(str(integrations.get("stripe_secret_key", "") or "").strip()),
            "stripe_verified": bool(integrations.get("stripe_verified")),
            "stripe_publishable_configured": bool(str(integrations.get("stripe_publishable_key", "") or "").strip()),
            "stripe_last_error": str(integrations.get("stripe_last_error", "") or "").strip(),
            "last_applied_at": str(stripe_meta.get("last_applied_at", "") or "").strip(),
            "detected_stack": str(stripe_meta.get("stack", "") or "").strip(),
        }

    @router.post("/projects/{project_id}/billing/stripe/apply")
    def v1_project_apply_stripe_billing(
        request: Request,
        project_id: str,
        body: StripeBillingApplyRequest,
    ) -> dict[str, Any]:
        _require_mutation_auth(request)
        _ensure_feature("stripe_billing_pack", "Stripe Billing Pack", "stripe-billing-disabled")
        try:
            validate_safe_id(project_id, "project_id")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid project ID format.")

        project = ctx.project_service.state_manager.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found.")

        cfg = ctx.load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        stripe_secret = str(integrations.get("stripe_secret_key", "") or "").strip()
        stripe_publishable = str(integrations.get("stripe_publishable_key", "") or "").strip()
        if not stripe_secret:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "stripe_not_configured",
                    "message": "Stripe is not configured yet. Add Stripe keys in Settings → Integrations.",
                    "settings_target": "stripe",
                },
            )
        if not bool(integrations.get("stripe_verified")):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "stripe_not_verified",
                    "message": "Stripe is configured but not verified yet. Verify the connector in Settings.",
                    "settings_target": "stripe",
                },
            )

        project_name = str(project.get("name", project_id) or project_id)
        workspace_path = str(project.get("workspace_path", "") or "").strip()
        stack = ctx.integration_service.detect_project_stack(workspace_path)
        markdown = ctx.integration_service.build_stripe_billing_pack(
            project_name=project_name,
            workspace_path=workspace_path,
            stack=stack,
            publishable_key=stripe_publishable,
            has_secret_key=bool(stripe_secret),
            price_basic=str(integrations.get("stripe_price_basic", "") or "").strip(),
            price_pro=str(integrations.get("stripe_price_pro", "") or "").strip(),
        )
        artifacts_dir = os.path.join(ctx.data_dir, "projects", project_id, "artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        artifact_path = os.path.join(artifacts_dir, "04_billing_pack.md")
        with open(artifact_path, "w") as f:
            f.write(markdown)

        scaffolded_files: list[str] = []
        if body.scaffold_files and workspace_path and os.path.isdir(workspace_path):
            env_example = os.path.join(workspace_path, ".env.billing.example")
            with open(env_example, "w") as f:
                f.write(
                    "STRIPE_SECRET_KEY=\n"
                    "STRIPE_PUBLISHABLE_KEY=\n"
                    "STRIPE_WEBHOOK_SECRET=\n"
                    "STRIPE_PRICE_BASIC=\n"
                    "STRIPE_PRICE_PRO=\n"
                )
            scaffolded_files.append(env_example)

        if body.sync_vercel_env:
            vercel_token = str(integrations.get("vercel_token", "") or "").strip()
            vercel_project_name = str(integrations.get("vercel_project_name", "") or "").strip()
            vercel_team_id = str(integrations.get("vercel_team_id", "") or "").strip()
            if vercel_token and vercel_project_name:
                if stripe_publishable:
                    ctx.integration_service.vercel_set_env(
                        vercel_token,
                        project_name=vercel_project_name,
                        key="STRIPE_PUBLISHABLE_KEY",
                        value=stripe_publishable,
                        target=["preview", "production"],
                        team_id=vercel_team_id,
                    )
                if str(integrations.get("stripe_price_basic", "") or "").strip():
                    ctx.integration_service.vercel_set_env(
                        vercel_token,
                        project_name=vercel_project_name,
                        key="STRIPE_PRICE_BASIC",
                        value=str(integrations.get("stripe_price_basic", "") or "").strip(),
                        target=["preview", "production"],
                        team_id=vercel_team_id,
                    )
                if str(integrations.get("stripe_price_pro", "") or "").strip():
                    ctx.integration_service.vercel_set_env(
                        vercel_token,
                        project_name=vercel_project_name,
                        key="STRIPE_PRICE_PRO",
                        value=str(integrations.get("stripe_price_pro", "") or "").strip(),
                        target=["preview", "production"],
                        team_id=vercel_team_id,
                    )

        metadata = ctx.project_service.get_metadata(project_id)
        billing_meta = metadata.get("billing", {}) if isinstance(metadata.get("billing"), dict) else {}
        billing_meta["stripe"] = {
            "artifact_path": artifact_path,
            "stack": stack,
            "last_applied_at": datetime.now(timezone.utc).isoformat(),
            "scaffolded_files": scaffolded_files,
        }
        ctx.project_service.update_metadata(project_id, {"billing": billing_meta})

        emit_activity(
            ctx.data_dir,
            "ceo",
            "UPDATED",
            f"Stripe billing pack generated for {project_name}.",
            project_id=project_id,
            metadata={
                "artifact_path": artifact_path,
                "stack": stack,
                "scaffolded_files": scaffolded_files,
            },
        )
        return {
            "status": "ok",
            "project_id": project_id,
            "stack": stack,
            "artifact_path": artifact_path,
            "scaffolded_files": scaffolded_files,
        }

    @router.get("/projects/{project_id}/release-notes")
    def v1_project_release_notes(project_id: str, run_id: str = Query(default="")) -> dict[str, Any]:
        project = ctx.project_service.state_manager.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found.")
        candidate_run_id = run_id.strip()
        run_obj: dict[str, Any] | None = None
        if candidate_run_id:
            run_obj = ctx.run_service.get_run(candidate_run_id)
        if run_obj is None:
            runs = ctx.run_service.list_runs(project_id=project_id, limit=100)
            for row in runs:
                status = str(row.get("status", "") or "").strip().lower()
                if status == "done":
                    run_obj = row
                    break

        timeline_labels: list[str] = []
        if isinstance(run_obj, dict):
            timeline = run_obj.get("timeline", [])
            if isinstance(timeline, list):
                for entry in timeline[-12:]:
                    if not isinstance(entry, dict):
                        continue
                    label = str(entry.get("label", "") or entry.get("state", "") or "").strip()
                    if label:
                        timeline_labels.append(label)

        metadata = ctx.project_service.get_metadata(project_id)
        artifact_lines: list[str] = []
        artifacts = metadata.get("artifacts", [])
        if isinstance(artifacts, list):
            for artifact in artifacts[-8:]:
                if not isinstance(artifact, dict):
                    continue
                path = str(artifact.get("file_path", "") or "").strip()
                if not path:
                    continue
                artifact_lines.append(f"- {path}")

        deliverables: list[str] = []
        if artifact_lines:
            deliverables.extend(artifact_lines[:5])
        run_instructions = str(project.get("run_instructions", "") or "").strip()
        run_cmd_lines = [line.strip() for line in run_instructions.splitlines() if line.strip()]
        summary = str(project.get("description", "") or "").strip()
        project_name = str(project.get("name", project_id) or project_id)
        release_note_lines = [
            f"# Release Notes — {project_name}",
            "",
            "## Summary",
            summary or "- Build completed and ready for handoff.",
            "",
            "## Key Progress",
        ]
        if timeline_labels:
            release_note_lines.extend([f"- {line}" for line in timeline_labels[-6:]])
        else:
            release_note_lines.append("- Run timeline unavailable.")
        release_note_lines.extend(["", "## Deliverables"])
        if deliverables:
            release_note_lines.extend(deliverables)
        else:
            release_note_lines.append("- No explicit artifacts recorded.")
        release_note_lines.extend(["", "## Run Commands"])
        if run_cmd_lines:
            release_note_lines.extend([f"- `{line}`" for line in run_cmd_lines[:6]])
        else:
            release_note_lines.append("- No run commands captured.")
        notes = "\n".join(release_note_lines).strip()
        return {
            "status": "ok",
            "project_id": project_id,
            "run_id": str((run_obj or {}).get("id", "") or ""),
            "notes": notes,
            "summary": summary,
            "timeline": timeline_labels[-12:],
            "artifacts": artifacts[-8:] if isinstance(artifacts, list) else [],
            "run_commands": run_cmd_lines[:6],
        }

    @router.get("/deployment/live-feed")
    def v1_deployment_live_feed(limit: int = Query(default=100, ge=1, le=500)) -> dict[str, Any]:
        # Uses activity.log as single source; client can filter deployment actions.
        activity_path = f"{ctx.data_dir}/activity.log"
        events: list[dict[str, Any]] = []
        try:
            with open(activity_path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = __import__("json").loads(line)
                    except Exception:
                        continue
                    if str(payload.get("action", "")).upper() in {
                        "DEPLOY",
                        "DEPLOY_PREVIEW",
                        "DEPLOY_PRODUCTION",
                        "ROLLBACK",
                    }:
                        events.append(payload)
        except OSError:
            pass
        return {"status": "ok", "events": events[-limit:]}

    return router
