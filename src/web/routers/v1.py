"""Versioned API router (/api/v1) for expanded orchestration capabilities."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from src.utils import emit_activity
from src.web.problem import problem_http_exception
from src.web.services.integration_service import IntegrationService
from src.web.services.project_service import ProjectService
from src.web.services.run_service import RunService
from src.web.services.workforce_presence import WorkforcePresenceService
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

    def _require_mutation_auth(request: Request) -> None:
        if ctx.require_write_auth is not None:
            ctx.require_write_auth(request)

    def _raise_invalid_repo_path(result: dict[str, Any]) -> None:
        if result.get("status") != "error":
            return
        if str(result.get("code", "")).startswith("invalid_repo_path"):
            raise HTTPException(status_code=400, detail=str(result.get("message", "Invalid repo_path.")))

    @router.get("/health")
    def v1_health() -> dict[str, Any]:
        cfg = ctx.load_config()
        flags = merge_feature_flags(cfg)
        return {
            "status": "ok",
            "version": "v1",
            "features": flags.model_dump(),
        }

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
                },
            },
        }

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
        return {"status": "ok", "created": created, "run": run}

    @router.get("/runs")
    def v1_list_runs(project_id: str = Query(default=""), limit: int = Query(default=100, ge=1, le=500)) -> dict[str, Any]:
        return {"status": "ok", "runs": ctx.run_service.list_runs(project_id=project_id, limit=limit)}

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
