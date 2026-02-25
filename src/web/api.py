"""COMPaaS Web Dashboard API.

FastAPI application exposing live company state — org chart, projects,
tasks, activity stream, token metrics, agents, and model settings.
"""

import logging
import os
import json
import re
import shutil
import asyncio
import copy
import hashlib
import hmac
import ipaddress
import time
import urllib.error
import urllib.request
import yaml
from typing import Any, AsyncGenerator
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard
from src.mcp_server.company_tools import CORE_TEAM, ON_DEMAND_TEAM
from src.agents import AGENT_REGISTRY, get_agent_display_name
from src.validators import safe_path_join, validate_safe_id
from src.utils import FileLock, atomic_yaml_write, emit_activity, resolve_data_dir, resolve_project_root
from src.web.settings import get_runtime_settings
from src.web.services.run_service import RunService
from src.web.services.project_service import ProjectService
from src.web.services.integration_service import IntegrationService
from src.web.routers.v1 import V1Context, create_v1_router


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

runtime_settings = get_runtime_settings()
DATA_DIR = runtime_settings.data_dir or resolve_data_dir()
PROJECT_ROOT = runtime_settings.project_root or resolve_project_root()
WORKSPACE_ROOT = os.path.abspath(
    os.environ.get("COMPAAS_WORKSPACE_ROOT", "").strip() or runtime_settings.resolved_workspace_root()
)

state_manager = ProjectStateManager(DATA_DIR, workspace_root=WORKSPACE_ROOT)
task_board = TaskBoard(DATA_DIR)
run_service = RunService(DATA_DIR, runtime_settings)
project_service = ProjectService(DATA_DIR, state_manager, task_board)
integration_service = IntegrationService(DATA_DIR)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="COMPaaS Dashboard API",
    description="Live data API for the COMPaaS virtual company web dashboard.",
    version="0.1.0",
)

# CORS — restrict to known origins
_cors_origins_env = os.environ.get(
    "COMPAAS_CORS_ORIGINS",
    "",
)
_allowed_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()] if _cors_origins_env else [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8420",
]
_cors_methods_env = os.environ.get(
    "COMPAAS_CORS_METHODS",
    "GET",
)
_allowed_methods = [m.strip().upper() for m in _cors_methods_env.split(",") if m.strip()] or ["GET"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=_allowed_methods,
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-COMPAAS-ADMIN-TOKEN",
        "X-Hub-Signature-256",
        "X-Slack-Signature",
        "X-Slack-Request-Timestamp",
    ],
)


def _env_first(*names: str) -> str:
    """Return the first non-empty environment value from a list of names."""
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


REDACTED_SECRET = "__COMPAAS_REDACTED__"
SENSITIVE_INTEGRATION_KEYS = ("github_token", "slack_token", "vercel_token")


def _redact_config_for_response(config: dict) -> dict:
    """Return a copy of config with sensitive integration values redacted."""
    safe = copy.deepcopy(config)
    integrations = safe.get("integrations")
    if isinstance(integrations, dict):
        for key in SENSITIVE_INTEGRATION_KEYS:
            value = integrations.get(key)
            if isinstance(value, str) and value:
                integrations[key] = REDACTED_SECRET
    return safe


def _sanitize_integration_payload(payload: dict) -> dict:
    """Drop redaction placeholders so writes don't overwrite stored secrets."""
    if not isinstance(payload, dict):
        return {}
    sanitized: dict = {}
    for key, value in payload.items():
        if key in SENSITIVE_INTEGRATION_KEYS and isinstance(value, str) and value == REDACTED_SECRET:
            continue
        sanitized[key] = value
    return sanitized


def _is_loopback_client(request: Request) -> bool:
    """Check whether request origin is local (loopback)."""
    client = request.client
    if client is None or not client.host:
        return False

    host = client.host.strip().lower()
    if host in {"localhost", "127.0.0.1", "::1", "testclient"}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _require_integrations_write_auth(request: Request) -> None:
    """Protect integration mutation endpoints from unauthorised remote writes."""
    admin_token = _env_first("COMPAAS_ADMIN_TOKEN")
    provided = request.headers.get("X-COMPAAS-ADMIN-TOKEN", "").strip()
    auth_header = request.headers.get("Authorization", "").strip()
    if not provided and auth_header.lower().startswith("bearer "):
        provided = auth_header[7:].strip()

    # Explicit shared-secret auth when configured.
    if admin_token:
        if not provided or not hmac.compare_digest(provided, admin_token):
            raise HTTPException(status_code=401, detail="Unauthorized.")
        return

    # Safe default for single-user local mode.
    if not _is_loopback_client(request):
        raise HTTPException(
            status_code=403,
            detail="Remote integration updates require COMPAAS_ADMIN_TOKEN.",
        )


def _require_github_signature(request: Request, body: bytes) -> None:
    """Validate GitHub webhook signature using HMAC SHA-256."""
    secret = _env_first("COMPAAS_GITHUB_WEBHOOK_SECRET")
    if not secret:
        raise HTTPException(
            status_code=503,
            detail="GitHub webhook secret is not configured.",
        )

    signature = request.headers.get("X-Hub-Signature-256", "").strip()
    if not signature.startswith("sha256="):
        raise HTTPException(status_code=401, detail="Missing or invalid GitHub signature.")
    provided = signature.split("=", 1)[1]
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid GitHub signature.")


def _require_slack_signature(request: Request, body: bytes) -> None:
    """Validate Slack request signature + replay window."""
    secret = _env_first("COMPAAS_SLACK_SIGNING_SECRET")
    if not secret:
        raise HTTPException(
            status_code=503,
            detail="Slack signing secret is not configured.",
        )

    timestamp_raw = request.headers.get("X-Slack-Request-Timestamp", "").strip()
    signature = request.headers.get("X-Slack-Signature", "").strip()
    if not timestamp_raw or not signature.startswith("v0="):
        raise HTTPException(status_code=401, detail="Missing or invalid Slack signature headers.")

    try:
        timestamp = int(timestamp_raw)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid Slack timestamp.")

    # Reject replay attacks older/newer than 5 minutes.
    if abs(int(time.time()) - timestamp) > 300:
        raise HTTPException(status_code=401, detail="Slack request timestamp out of range.")

    try:
        body_text = body.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Invalid request encoding.")

    basestring = f"v0:{timestamp_raw}:{body_text}".encode("utf-8")
    expected = "v0=" + hmac.new(secret.encode("utf-8"), basestring, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Invalid Slack signature.")


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/api/health", summary="Health check endpoint")
def health_check() -> dict:
    return {
        "status": "healthy",
        "version": "0.1.0",
        "data_dir_exists": os.path.isdir(DATA_DIR),
    }


# ---------------------------------------------------------------------------
# Org chart
# ---------------------------------------------------------------------------

@app.get("/api/org-chart", summary="Return the full organisation chart")
def get_org_chart() -> dict:
    """Return CEO, leadership, engineering, design, on-demand and dynamically
    hired agents in a structured dict.
    """
    hiring_log_path = os.path.join(DATA_DIR, "hiring_log.yaml")
    hired: list[dict] = []
    if os.path.exists(hiring_log_path):
        with open(hiring_log_path) as f:
            log = yaml.safe_load(f) or {"hired": []}
        hired = log.get("hired", [])

    leadership = {
        name: info for name, info in CORE_TEAM.items()
        if name.startswith("cto") or name.startswith("vp-") or name in ("chief-researcher", "ciso", "cfo")
    }
    engineering = {
        name: info for name, info in CORE_TEAM.items()
        if name.startswith("lead-") or name in ("qa-lead", "devops")
    }
    design = {
        name: info for name, info in CORE_TEAM.items()
        if "designer" in info.get("role", "").lower()
    }

    # Use config values so that the org chart reflects user-set names
    cfg = _load_config()
    chairman_name = str(cfg.get("user", {}).get("name", "") or "").strip() or "Idan"
    if chairman_name:
        chairman_name = chairman_name[0].upper() + chairman_name[1:]
    ceo_name = cfg.get("agents", {}).get("ceo", "Marcus") or "Marcus"

    org: dict = {
        "board_head": {"name": chairman_name, "role": "Chairman"},
        "ceo": {"name": ceo_name, "role": "CEO — Central Orchestrator"},
        "leadership": leadership,
        "engineering": engineering,
        "design": design,
        "on_demand": ON_DEMAND_TEAM,
    }
    if hired:
        org["hired"] = [
            {
                "name": h["name"],
                "role": h["role"],
                "status": h.get("status", "active"),
                "model": h.get("model", "sonnet"),
            }
            for h in hired
        ]
    return org


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

@app.get("/api/projects", summary="List all projects with status and task progress")
def list_projects() -> list[dict]:
    """Return every project with its status and a summary of task counts by
    status (todo / in_progress / done / blocked).
    """
    projects = state_manager.list_projects()
    result: list[dict] = []
    for proj in projects:
        tasks = task_board.get_board(proj["id"])
        status_counts: dict[str, int] = {}
        for t in tasks:
            s = t.get("status", "todo")
            status_counts[s] = status_counts.get(s, 0) + 1
        try:
            plan_packet = project_service.plan_packet_status(str(proj["id"]))
        except ValueError:
            plan_packet = {
                "ready": False,
                "missing_items": ["Project metadata unavailable."],
                "summary": "Planning packet could not be evaluated.",
            }
        # Auto-derive team from task assignees if project.team is empty
        team = proj.get("team") or []
        if not team:
            assignees = sorted({
                t.get("assigned_to", "")
                for t in tasks
                if t.get("assigned_to")
            })
            if assignees:
                team = assignees
        result.append({
            **proj,
            "team": team,
            "task_counts": status_counts,
            "total_tasks": len(tasks),
            "plan_packet": plan_packet,
        })
    return result


@app.post("/api/projects", summary="Create a new project")
def create_project(request: Request, body: dict | None = None) -> dict:
    """Create a project and return full project metadata."""
    payload = body or {}
    name = str(payload.get("name", "") or "").strip()
    description = str(payload.get("description", "") or "").strip()
    project_type = str(payload.get("type", "") or "general").strip() or "general"
    requested_mode = str(payload.get("delivery_mode", "") or "").strip().lower()
    workspace_path = str(payload.get("workspace_path", "") or "").strip()
    github_repo = str(payload.get("github_repo", "") or "").strip()
    github_branch = str(payload.get("github_branch", "") or "master").strip() or "master"
    cfg = _load_config()
    integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
    if requested_mode in {"local", "github"}:
        delivery_mode = requested_mode
    else:
        delivery_mode = "github" if str(integrations.get("workspace_mode", "local") or "local").strip().lower() == "github" else "local"

    if not github_repo:
        github_repo = str(integrations.get("github_repo", "") or "").strip()
    if github_branch == "master" and "github_branch" not in payload:
        github_branch = str(integrations.get("github_default_branch", "master") or "master").strip() or "master"

    if delivery_mode == "github":
        github_token = str(integrations.get("github_token", "") or "").strip()
        github_verified = bool(integrations.get("github_verified"))
        if not github_repo or not github_token or not github_verified:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "github_not_configured",
                    "message": "GitHub mode requires a verified GitHub connector (token + repo access). Open Settings → Integrations.",
                    "settings_target": "github",
                },
            )
    if not name:
        raise HTTPException(status_code=400, detail="Project name is required.")

    idempotency_key = (
        request.headers.get("Idempotency-Key", "").strip()
        or request.headers.get("X-Idempotency-Key", "").strip()
    )
    project, created = project_service.create_project(
        name=name,
        description=description,
        project_type=project_type,
        idempotency_key=idempotency_key,
        delivery_mode=delivery_mode,
        github_repo=github_repo,
        github_branch=github_branch,
        workspace_path=workspace_path,
    )
    project_id = str(project.get("id", "") or "")
    plan_packet = project_service.plan_packet_status(project_id)
    emit_activity(
        DATA_DIR,
        "ceo",
        "CREATED",
        f"Project '{name}' initialized",
        project_id=project_id,
        metadata={
            "workspace_path": project.get("workspace_path", ""),
            "idempotency_key": idempotency_key[:80],
            "created": created,
            "delivery_mode": delivery_mode,
        },
    )
    return {"status": "ok", "created": created, "project": project, "plan_packet": plan_packet}


@app.get("/api/projects/{project_id}", summary="Get a single project with full task board")
def get_project(project_id: str) -> dict:
    """Return a project's full details including the complete task board."""
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")
    project = state_manager.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    tasks = task_board.get_board(project_id)
    try:
        plan_packet = project_service.plan_packet_status(project_id)
    except ValueError:
        plan_packet = {
            "ready": False,
            "missing_items": ["Project metadata unavailable."],
            "summary": "Planning packet could not be evaluated.",
        }
    return {**project, "tasks": tasks, "project": project, "plan_packet": plan_packet}


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

@app.get("/api/tasks/{project_id}", summary="Task board for a project with optional filters")
def get_tasks(
    project_id: str,
    status: str = Query(default="", description="Filter by task status (todo, in_progress, done, blocked)"),
    assignee: str = Query(default="", description="Filter by assignee name"),
) -> list[dict]:
    """Return the task board for a project, optionally filtered by status and/or
    assignee.
    """
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")
    project = state_manager.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    return task_board.get_board(project_id, filter_status=status, filter_assignee=assignee)


# ---------------------------------------------------------------------------
# Activity stream (SSE)
# ---------------------------------------------------------------------------

MAX_SSE_CONNECTIONS = 10
_active_sse_connections = 0


async def _tail_activity_log(activity_log_path: str) -> AsyncGenerator[str, None]:
    """Async generator that watches activity.log for new lines via polling."""
    global _active_sse_connections
    _active_sse_connections += 1
    last_size: int = 0
    last_pos: int = 0

    if os.path.exists(activity_log_path):
        last_size = os.path.getsize(activity_log_path)
        last_pos = last_size

    try:
        while True:
            await asyncio.sleep(1)
            if not os.path.exists(activity_log_path):
                yield ": keep-alive\n\n"
                continue

            current_size = os.path.getsize(activity_log_path)
            if current_size > last_size:
                with open(activity_log_path) as f:
                    f.seek(last_pos)
                    new_content = f.read()
                last_size = current_size
                last_pos = current_size

                for line in new_content.splitlines():
                    line = line.strip()
                    if line:
                        escaped = line.replace("\n", "\\n")
                        yield f"data: {escaped}\n\n"
            elif current_size < last_size:
                # File was truncated/rotated — reset position.
                last_size = current_size
                last_pos = 0
            else:
                yield ": keep-alive\n\n"
    finally:
        _active_sse_connections = max(0, _active_sse_connections - 1)


@app.get("/api/activity/stream", summary="SSE stream of activity.log changes")
def activity_stream() -> StreamingResponse:
    """Server-Sent Events endpoint."""
    if _active_sse_connections >= MAX_SSE_CONNECTIONS:
        raise HTTPException(status_code=429, detail="Too many SSE connections.")

    activity_log_path = os.path.join(DATA_DIR, "activity.log")
    return StreamingResponse(
        _tail_activity_log(activity_log_path),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Token metrics
# ---------------------------------------------------------------------------

@app.get("/api/metrics/tokens", summary="Token usage report from token_usage.yaml")
def token_metrics(
    project_id: str = Query(default="", description="Filter by project ID"),
    agent_name: str = Query(default="", description="Filter by agent name"),
) -> dict:
    """Return an aggregated token usage report."""
    token_usage_path = os.path.join(DATA_DIR, "token_usage.yaml")
    if not os.path.exists(token_usage_path):
        return {"records": [], "total_records": 0, "grand_total_tokens": 0, "by_agent": {}, "by_model": {}}

    with open(token_usage_path) as f:
        data = yaml.safe_load(f) or {"records": []}

    records: list[dict] = data.get("records", [])
    if project_id:
        records = [r for r in records if r.get("project_id") == project_id]
    if agent_name:
        records = [r for r in records if r.get("agent_name") == agent_name]

    by_agent: dict[str, dict] = {}
    by_model: dict[str, dict] = {}
    for rec in records:
        agent = rec.get("agent_name", "unknown")
        model = rec.get("model", "unknown")
        total = rec.get("estimated_total_tokens", 0)

        if agent not in by_agent:
            by_agent[agent] = {"model": model, "total_tokens": 0, "task_count": 0}
        by_agent[agent]["total_tokens"] += total
        by_agent[agent]["task_count"] += 1

        if model not in by_model:
            by_model[model] = {"total_tokens": 0, "task_count": 0}
        by_model[model]["total_tokens"] += total
        by_model[model]["task_count"] += 1

    grand_total = sum(r.get("estimated_total_tokens", 0) for r in records)

    return {
        "total_records": len(records),
        "grand_total_tokens": grand_total,
        "by_agent": by_agent,
        "by_model": by_model,
        "records": records,
    }


@app.get("/api/metrics/budgets", summary="Token budget status from token_budgets.yaml")
def token_budgets(
    project_id: str = Query(default="", description="Filter by project ID"),
    agent_name: str = Query(default="", description="Filter by agent name"),
) -> list[dict]:
    """Return current token budgets with usage status."""
    budgets_path = os.path.join(DATA_DIR, "token_budgets.yaml")
    token_usage_path = os.path.join(DATA_DIR, "token_usage.yaml")

    if not os.path.exists(budgets_path):
        return []

    with open(budgets_path) as f:
        budgets_data = yaml.safe_load(f) or {"budgets": []}
    budgets = budgets_data.get("budgets", [])

    # Load usage for calculations
    records: list[dict] = []
    if os.path.exists(token_usage_path):
        with open(token_usage_path) as f:
            usage_data = yaml.safe_load(f) or {"records": []}
        records = usage_data.get("records", [])

    # Filter budgets
    if project_id:
        budgets = [b for b in budgets if b.get("project_id", "") == project_id]
    if agent_name:
        budgets = [b for b in budgets if b.get("agent_name", "") == agent_name]

    result: list[dict] = []
    for b in budgets:
        b_project = b.get("project_id", "")
        b_agent = b.get("agent_name", "")
        b_limit = b.get("token_limit", 0)

        # Sum matching usage
        filtered = records
        if b_project:
            filtered = [r for r in filtered if r.get("project_id") == b_project]
        if b_agent:
            filtered = [r for r in filtered if r.get("agent_name") == b_agent]
        used = sum(r.get("estimated_total_tokens", 0) for r in filtered)

        result.append({
            "project_id": b_project,
            "agent_name": b_agent,
            "token_limit": b_limit,
            "used": used,
            "remaining": max(0, b_limit - used),
            "usage_percent": round((used / b_limit) * 100, 1) if b_limit > 0 else 0,
            "status": "OK" if used <= b_limit else "OVER BUDGET",
        })

    return result


# ---------------------------------------------------------------------------
# Configuration system
# ---------------------------------------------------------------------------

CONFIG_PATH = os.path.join(DATA_DIR, "config.yaml")
MEMORY_PATH = os.path.join(DATA_DIR, "ceo_memory.md")

DEFAULT_CONFIG: dict = {
    "setup_complete": False,
    "user": {"name": ""},
    "agents": {
        "ceo": "Marcus", "cto": "Elena", "chief-researcher": "Victor",
        "ciso": "Rachel", "cfo": "Jonathan", "vp-product": "Sarah",
        "vp-engineering": "David", "lead-backend": "James",
        "lead-frontend": "Priya", "lead-designer": "Lena",
        "qa-lead": "Carlos", "devops": "Nina",
        "security-engineer": "Alex", "data-engineer": "Maya",
        "tech-writer": "Tom",
    },
    "ui": {
        "theme": "midnight",
        "poll_interval_ms": 5000,
    },
    "server": {
        "host": "127.0.0.1",
        "port": 8420,
        "auto_open_browser": True,
    },
    "llm": {
        # "anthropic"     — use Claude via Claude Code CLI (default)
        # "openai"        — use OpenAI API (GPT-4o, etc.)
        # "openai_compat" — use any OpenAI-compatible local server (Ollama, LM Studio, …)
        "provider": "anthropic",
        # Runtime mode for Anthropic provider:
        # "cli"    — use locally installed Claude Code CLI credentials
        # "apikey" — inject API key from config into Claude Code CLI env
        "anthropic_mode": "cli",
        # Runtime mode for OpenAI provider:
        # "apikey" — call OpenAI-compatible Chat Completions API directly
        # "codex"  — run Codex CLI locally and stream its result
        "openai_mode": "apikey",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o",
        "api_key": "",
        "system_prompt": "",
        # Phase 2: route ALL agent subprocesses through a LiteLLM proxy
        "proxy_enabled": False,
        "proxy_url": "http://localhost:4000",
    },
    "chat_policy": {
        "memory_scope": "project",
        "retention_days": 30,
        "auto_summary_every_messages": runtime_settings.chat_auto_summary_interval,
    },
    "feature_flags": runtime_settings.feature_flags.model_dump(),
    "integrations": {
        "workspace_mode": "local",
        "github_token": "",
        "github_repo": "",
        "github_default_branch": "master",
        "github_auto_push": False,
        "github_auto_pr": False,
        "github_verified": False,
        "github_verified_at": "",
        "github_last_error": "",
        "vercel_token": "",
        "vercel_team_id": "",
        "vercel_project_name": "",
        "vercel_default_target": "preview",
        "vercel_verified": False,
        "vercel_verified_at": "",
        "vercel_last_error": "",
        "slack_token": "",
        "webhook_url": "",
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge override into base."""
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _load_config() -> dict:
    """Load config merged with defaults."""
    if not os.path.exists(CONFIG_PATH):
        return DEFAULT_CONFIG.copy()
    try:
        with open(CONFIG_PATH) as f:
            data = yaml.safe_load(f) or {}
        return _deep_merge(DEFAULT_CONFIG, data)
    except (yaml.YAMLError, OSError):
        return DEFAULT_CONFIG.copy()


def _save_config(config: dict) -> None:
    """Persist config to disk and re-render agent templates."""
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    # Re-render agent templates with updated config values
    try:
        from scripts.render_agents import render_templates
        render_templates()
    except Exception:
        logger.warning("Failed to re-render agent templates after config save", exc_info=True)


def _get_agent_name(agent_id: str, default: str) -> str:
    """Get custom agent name from config, falling back to default."""
    config = _load_config()
    return config.get("agents", {}).get(agent_id, default)


@app.get("/api/config", summary="Get current configuration")
def get_config() -> dict:
    return _redact_config_for_response(_load_config())


@app.post("/api/config/setup", summary="Save initial setup configuration")
def setup_config(config: dict) -> dict:
    config["setup_complete"] = True
    merged = _deep_merge(DEFAULT_CONFIG, config)
    merged["setup_complete"] = True
    _save_config(merged)
    return {"status": "ok"}


@app.patch("/api/config", summary="Update configuration settings")
def update_config(request: Request, updates: dict) -> dict:
    # Sensitive integration credentials must always pass the integration auth guard.
    if isinstance(updates, dict) and isinstance(updates.get("integrations"), dict):
        _require_integrations_write_auth(request)
        updates = updates.copy()
        updates["integrations"] = _sanitize_integration_payload(updates["integrations"])
    config = _load_config()
    merged = _deep_merge(config, updates)
    _save_config(merged)
    return {"status": "ok"}


app.include_router(
    create_v1_router(
        V1Context(
            data_dir=DATA_DIR,
            load_config=_load_config,
            save_config=_save_config,
            run_service=run_service,
            project_service=project_service,
            integration_service=integration_service,
        )
    )
)


class LlmTestRequest(dict):
    """Flexible body for LLM test — accepts base_url, model, api_key."""


@app.post("/api/llm/test", summary="Test an OpenAI-compatible LLM connection")
async def test_llm_connection(body: dict) -> dict:
    """Probe an OpenAI-compatible endpoint with a tiny request.

    Accepts optional ``base_url``, ``model``, and ``api_key`` in the request
    body so the wizard can test before saving config.  Falls back to the
    current saved config for any missing fields.
    """
    saved = _load_config().get("llm", {})
    base_url = body.get("base_url") or saved.get("base_url", "https://api.openai.com/v1")
    model    = body.get("model")    or saved.get("model", "gpt-4o")
    api_key  = body.get("api_key")  or saved.get("api_key", "local")

    try:
        from src.llm_provider import probe_connection
    except ImportError:
        return {"status": "error", "message": "llm_provider module not found"}

    ok, message = await probe_connection(base_url=base_url, model=model, api_key=api_key)
    return {"status": "ok" if ok else "error", "message": message}


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------


def _llm_runtime_snapshot() -> dict[str, str]:
    """Return normalized runtime metadata for the currently selected LLM provider."""
    cfg = _load_config()
    llm = cfg.get("llm", {}) if isinstance(cfg, dict) else {}
    provider = str(llm.get("provider", "anthropic") or "anthropic").strip().lower()
    anthropic_mode = str(llm.get("anthropic_mode", "cli") or "cli").strip().lower()
    openai_mode = str(llm.get("openai_mode", "apikey") or "apikey").strip().lower()
    configured_model = str(llm.get("model", "") or "").strip()

    if provider == "anthropic":
        mode = anthropic_mode if anthropic_mode in ("cli", "apikey") else "cli"
        label = "Anthropic Claude CLI" if mode == "cli" else "Anthropic API"
        runtime_model = configured_model or "claude"
    elif provider == "openai":
        if openai_mode == "codex":
            mode = "codex"
            label = "OpenAI Codex CLI"
            runtime_model = "codex"
        else:
            mode = "apikey"
            label = "OpenAI API"
            runtime_model = configured_model or "gpt-4o"
    else:
        provider = "openai_compat"
        mode = "local"
        label = "Local OpenAI-compatible"
        runtime_model = configured_model or "llama3.2"

    return {
        "provider": provider,
        "mode": mode,
        "label": label,
        "model": runtime_model,
    }


def _agent_runtime_model(base_model: str, runtime: dict[str, str]) -> str:
    """Return the runtime model string shown in the UI for an agent."""
    if runtime.get("provider") == "anthropic":
        return str(base_model or "sonnet")
    return str(runtime.get("model") or "unknown")


def _agent_runtime_label(base_model: str, runtime: dict[str, str]) -> str:
    """Human-readable runtime label for a specific agent."""
    runtime_model = _agent_runtime_model(base_model, runtime)
    return f"{runtime.get('label', 'LLM runtime')} · {runtime_model}"


def _is_anthropic_model_label(model_name: str) -> bool:
    """Return True when a model identifier clearly belongs to Anthropic naming."""
    normalized = str(model_name or "").strip().lower()
    if not normalized:
        return False
    if "claude" in normalized:
        return True
    return normalized.startswith(("opus", "sonnet", "haiku"))


def _resolve_routed_model_for_runtime(
    *,
    provider: str,
    openai_mode: str,
    configured_model: str,
    routed_model: str,
) -> str:
    """Route intent model overrides only when compatible with active runtime."""
    base_model = str(configured_model or "").strip()
    candidate = str(routed_model or "").strip()
    provider_normalized = str(provider or "anthropic").strip().lower()
    openai_mode_normalized = str(openai_mode or "apikey").strip().lower()

    if provider_normalized == "openai" and openai_mode_normalized == "codex":
        return "codex"
    if not candidate:
        return base_model
    if provider_normalized == "openai_compat":
        # Local runtimes are usually bound to one selected model.
        return base_model
    if provider_normalized == "openai":
        # Ignore Anthropic-routed names (sonnet/opus/haiku/claude) on OpenAI API runtime.
        return base_model if _is_anthropic_model_label(candidate) else candidate
    if provider_normalized == "anthropic":
        # Ignore non-Anthropic route names on Claude runtime.
        return candidate if _is_anthropic_model_label(candidate) else base_model
    return base_model


@app.get("/api/agents", summary="List all agents with their models and roles")
def list_agents() -> list[dict]:
    """Return every known agent (core team, on-demand, and dynamically hired)."""
    agents: list[dict] = []
    runtime = _llm_runtime_snapshot()

    for agent_id, info in AGENT_REGISTRY.items():
        base_model = str(info.get("model", "sonnet") or "sonnet")
        entry = {
            "id": agent_id,
            "name": _get_agent_name(agent_id, info["name"]),
            "role": info["role"],
            "model": base_model,
            "status": info["status"],
            "team": info["team"],
            "runtime_provider": runtime["provider"],
            "runtime_mode": runtime["mode"],
            "runtime_model": _agent_runtime_model(base_model, runtime),
            "runtime_label": _agent_runtime_label(base_model, runtime),
        }
        agents.append(entry)

    # Dynamically hired agents from hiring log.
    hiring_log_path = os.path.join(DATA_DIR, "hiring_log.yaml")
    if os.path.exists(hiring_log_path):
        with open(hiring_log_path) as f:
            log = yaml.safe_load(f) or {"hired": []}
        for h in log.get("hired", []):
            base_model = str(h.get("model", "sonnet") or "sonnet")
            entry = {
                "id": h["name"],
                "name": h["name"],
                "role": h["role"],
                "model": base_model,
                "status": h.get("status", "active"),
                "team": "hired",
                "expertise": h.get("expertise", ""),
                "hired_at": h.get("hired_at", ""),
                "runtime_provider": runtime["provider"],
                "runtime_mode": runtime["mode"],
                "runtime_model": _agent_runtime_model(base_model, runtime),
                "runtime_label": _agent_runtime_label(base_model, runtime),
            }
            agents.append(entry)

    return agents


@app.get("/api/agents/{agent_id}", summary="Get detailed info for a single agent")
def get_agent_detail(agent_id: str) -> dict:
    """Return detailed agent info including assigned tasks and recent activity."""
    runtime = _llm_runtime_snapshot()
    # Look up in registry
    info = AGENT_REGISTRY.get(agent_id)
    if not info:
        # Check hiring log
        hiring_log_path = os.path.join(DATA_DIR, "hiring_log.yaml")
        if os.path.exists(hiring_log_path):
            with open(hiring_log_path) as f:
                log = yaml.safe_load(f) or {"hired": []}
            for h in log.get("hired", []):
                if h["name"] == agent_id:
                    info = {
                        "name": h["name"], "role": h["role"],
                        "model": h.get("model", "sonnet"),
                        "status": h.get("status", "active"),
                        "team": "hired",
                    }
                    break
    if not info:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found.")

    # Find tasks assigned to this agent across all projects
    assigned_tasks: list[dict] = []
    projects = state_manager.list_projects()
    for proj in projects:
        tasks = task_board.get_board(proj["id"], filter_assignee=agent_id)
        for t in tasks:
            assigned_tasks.append({**t, "project_id": proj["id"], "project_name": proj["name"]})

    # Parse agent .md file for description/tools
    agent_def: dict = {}
    agents_dir = os.path.join(PROJECT_ROOT, ".claude", "agents")
    md_path = os.path.join(agents_dir, f"{agent_id}.md")
    if os.path.exists(md_path):
        agent_def = _parse_frontmatter(md_path)

    # Recent activity for this agent
    activity: list[dict] = []
    activity_log_path = os.path.join(DATA_DIR, "activity.log")
    if os.path.exists(activity_log_path):
        import json as _json
        with open(activity_log_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    evt = _json.loads(line)
                    if evt.get("agent") == agent_id:
                        activity.append(evt)
                except (ValueError, KeyError):
                    continue
        activity = activity[-50:]  # Last 50 events

    result = {
        "id": agent_id,
        "name": _get_agent_name(agent_id, info.get("name", agent_id)),
        "role": info.get("role", ""),
        "model": info.get("model", "sonnet"),
        "runtime_provider": runtime["provider"],
        "runtime_mode": runtime["mode"],
        "runtime_model": _agent_runtime_model(str(info.get("model", "sonnet") or "sonnet"), runtime),
        "runtime_label": _agent_runtime_label(str(info.get("model", "sonnet") or "sonnet"), runtime),
        "status": info.get("status", ""),
        "team": info.get("team", ""),
        "description": agent_def.get("description", ""),
        "tools": agent_def.get("tools", ""),
        "assigned_tasks": assigned_tasks,
        "recent_activity": activity,
    }
    return result


# ---------------------------------------------------------------------------
# Project decisions
# ---------------------------------------------------------------------------

@app.get("/api/projects/{project_id}/decisions", summary="Get decisions for a project")
def get_project_decisions(project_id: str) -> list[dict]:
    """Return the decision log for a project."""
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")
    from src.validators import safe_path_join
    decisions_path = safe_path_join(DATA_DIR, "projects", project_id, "decisions.yaml")
    if not os.path.exists(decisions_path):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    with open(decisions_path) as f:
        data = yaml.safe_load(f) or {"decisions": []}
    return data.get("decisions", [])


# ---------------------------------------------------------------------------
# Recent activity (non-SSE)
# ---------------------------------------------------------------------------

@app.get("/api/activity/recent", summary="Get recent activity events")
def recent_activity(limit: int = Query(default=100, ge=1, le=500)) -> list[dict]:
    """Return the most recent activity events as JSON (non-streaming)."""
    import json as _json
    activity_log_path = os.path.join(DATA_DIR, "activity.log")
    if not os.path.exists(activity_log_path):
        return []
    events: list[dict] = []
    with open(activity_log_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(_json.loads(line))
            except (ValueError, KeyError):
                continue
    return events[-limit:]


# ---------------------------------------------------------------------------
# Project plan and approval
# ---------------------------------------------------------------------------

@app.get("/api/projects/{project_id}/specs", summary="List spec files for a project")
def list_project_specs(project_id: str) -> list[dict]:
    """Return a list of spec/plan files stored under company_data/projects/{id}/specs/."""
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")
    from src.validators import safe_path_join
    specs_dir = safe_path_join(DATA_DIR, "projects", project_id, "specs")
    if not os.path.exists(specs_dir):
        return []
    real_specs_dir = os.path.realpath(specs_dir)
    files = []
    for fname in sorted(os.listdir(specs_dir)):
        fpath = os.path.join(specs_dir, fname)
        # Resolve symlinks and ensure file stays within specs_dir
        real_fpath = os.path.realpath(fpath)
        if not real_fpath.startswith(real_specs_dir + os.sep):
            continue
        if os.path.isfile(real_fpath) and not fname.startswith("."):
            try:
                with open(real_fpath) as f:
                    content = f.read()
            except OSError as e:
                logger.warning("Failed to read spec file %s: %s", real_fpath, e)
                content = ""
            files.append({"filename": fname, "content": content})
    return files


@app.post("/api/projects/{project_id}/approve", summary="Approve the project plan")
def approve_project_plan(project_id: str) -> dict:
    """Approve a project only when the planning packet checklist is complete."""
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")
    try:
        plan_packet = project_service.plan_packet_status(project_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    if not bool(plan_packet.get("ready")):
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Planning packet is incomplete.",
                "missing_items": plan_packet.get("missing_items", []),
                "summary": plan_packet.get("summary", ""),
            },
        )
    ok = state_manager.update_project(project_id, {"plan_approved": True, "status": "active"})
    if not ok:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    return {"status": "approved", "plan_packet": plan_packet}


# ---------------------------------------------------------------------------
# Model settings
# ---------------------------------------------------------------------------

def _parse_frontmatter(path: str) -> dict:
    """Parse YAML frontmatter from a Markdown file."""
    with open(path) as f:
        content = f.read()

    if not content.startswith("---"):
        return {}

    end = content.find("\n---", 3)
    if end == -1:
        return {}

    frontmatter_text = content[3:end].strip()
    try:
        return yaml.safe_load(frontmatter_text) or {}
    except yaml.YAMLError:
        return {}


@app.get("/api/settings/models", summary="Current model assignments per agent from .claude/agents/*.md")
def settings_models() -> list[dict]:
    """Read all .claude/agents/*.md files and return model assignments."""
    agents_dir = os.path.join(PROJECT_ROOT, ".claude", "agents")
    result: list[dict] = []

    if not os.path.exists(agents_dir):
        return result

    for filename in sorted(os.listdir(agents_dir)):
        if not filename.endswith(".md"):
            continue
        # Skip files that don't match expected naming patterns
        base = filename[:-3]
        if ".." in base or "/" in base:
            continue
        filepath = os.path.join(agents_dir, filename)
        try:
            frontmatter = _parse_frontmatter(filepath)
        except OSError:
            continue

        result.append({
            "id": base,
            "name": frontmatter.get("name", base),
            "model": frontmatter.get("model", "unknown"),
            "description": frontmatter.get("description", ""),
            "tools": frontmatter.get("tools", ""),
        })

    return result


# ---------------------------------------------------------------------------
# CEO Chat (WebSocket + REST)
# ---------------------------------------------------------------------------

CHAT_LOG_PATH = os.path.join(DATA_DIR, "chat_messages.json")
_chat_lock = asyncio.Lock()


_EXECUTION_INTENT_KEYWORDS = (
    "build",
    "create",
    "develop",
    "fix",
    "implement",
    "scaffold",
    "ship",
    "deploy",
    "code",
)
_GREETING_HINTS = (
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
)
_STATUS_HINTS = (
    "status",
    "progress",
    "update",
    "where are we",
    "how far",
    "what happened",
)
_CLARIFICATION_HINTS = (
    "what do you think",
    "can you explain",
    "help me understand",
    "clarify",
    "question",
)
_PROJECT_START_HINTS = (
    "new project",
    "start a project",
    "start project",
    "build me",
    "create an app",
    "create a project",
    "launch a project",
)
_PROJECT_CONTINUE_HINTS = (
    "continue",
    "resume",
    "next step",
    "same project",
    "this project",
    "that project",
    "pick up where we left off",
)


def _normalize_project_id(project_id: str) -> str:
    pid = (project_id or "").strip()
    if not pid:
        return ""
    try:
        validate_safe_id(pid, "project_id")
    except ValueError:
        return ""
    return pid


def _contains_keyword(text: str, keywords: tuple[str, ...]) -> bool:
    normalized = f" {text.strip().lower()} "
    for keyword in keywords:
        kw = keyword.strip().lower()
        if not kw:
            continue
        if " " in kw:
            if kw in normalized:
                return True
            continue
        if re.search(rf"\b{re.escape(kw)}\b", normalized):
            return True
    return False


def _load_chat_messages(project_id: str = "", include_global: bool = False) -> list[dict]:
    """Load chat messages from disk, optionally scoped to a project."""
    if not os.path.exists(CHAT_LOG_PATH):
        return []
    try:
        with open(CHAT_LOG_PATH) as f:
            data = json.load(f)
        messages = data.get("messages", [])
    except (json.JSONDecodeError, OSError):
        return []

    pid = _normalize_project_id(project_id)
    if not pid:
        return messages

    filtered: list[dict] = []
    for msg in messages:
        msg_pid = _normalize_project_id(str(msg.get("project_id", "") or ""))
        if msg_pid == pid:
            filtered.append(msg)
        elif include_global and not msg_pid:
            filtered.append(msg)
    return filtered


def _save_chat_messages(messages: list[dict]) -> None:
    """Persist chat messages to disk."""
    os.makedirs(os.path.dirname(CHAT_LOG_PATH), exist_ok=True)
    with open(CHAT_LOG_PATH, "w") as f:
        json.dump({"messages": messages}, f, indent=2)


def _auto_summarize_chat_scope(project_id: str, every_n_messages: int) -> bool:
    """Auto-summarize project-scoped chat when checkpoint threshold is reached."""
    if every_n_messages < 4:
        return False
    normalized_pid = _normalize_project_id(project_id)
    if not normalized_pid:
        return False
    messages = _load_chat_messages()
    scoped = [
        msg for msg in messages
        if _normalize_project_id(str(msg.get("project_id", "") or "")) == normalized_pid
    ]
    if len(scoped) < every_n_messages or (len(scoped) % every_n_messages) != 0:
        return False

    history_text = "\n".join(
        f"{'Chairman' if msg.get('role') == 'user' else 'CEO'}: {str(msg.get('content', ''))[:240]}"
        for msg in scoped[-30:]
    )
    summary_note = (
        f"[AUTO-SUMMARY checkpoint at {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}] "
        f"Recent project context:\n{history_text[:1200]}"
    )
    summary_msg = {
        "role": "system",
        "content": summary_note,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "project_id": normalized_pid,
    }
    compacted_scope = [summary_msg] + scoped[-6:]
    others = [
        msg for msg in messages
        if _normalize_project_id(str(msg.get("project_id", "") or "")) != normalized_pid
    ]
    _save_chat_messages(others + compacted_scope)
    return True


def _append_chat_message(role: str, content: str, project_id: str = "") -> dict:
    """Append a chat message and return it."""
    msg = {
        "role": role,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "project_id": _normalize_project_id(project_id),
    }
    messages = _load_chat_messages()
    messages.append(msg)
    if len(messages) > 600:
        messages = messages[-600:]
    _save_chat_messages(messages)
    return msg


def _latest_chat_project_id() -> str:
    """Return the most recent project ID present in chat history."""
    messages = _load_chat_messages()
    for msg in reversed(messages):
        msg_pid = _normalize_project_id(str(msg.get("project_id", "") or ""))
        if msg_pid:
            return msg_pid
    return ""


def _message_requests_execution(message: str) -> bool:
    lower = (message or "").strip().lower()
    if not lower:
        return False
    # Pure greetings/salutations should never trigger implementation mode.
    greeting_only = _contains_keyword(lower, _GREETING_HINTS) and len(lower.split()) <= 4
    if greeting_only:
        return False
    return _contains_keyword(lower, _EXECUTION_INTENT_KEYWORDS)


def _message_starts_new_project(message: str) -> bool:
    text = (message or "").strip().lower()
    if any(hint in text for hint in _PROJECT_START_HINTS):
        return True
    return _message_requests_execution(text) and len(text.split()) >= 4


def _message_continues_project_context(message: str) -> bool:
    text = (message or "").strip().lower()
    if not text:
        return False
    return any(hint in text for hint in _PROJECT_CONTINUE_HINTS)


def _infer_project_name_from_message(message: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9\s-]+", " ", (message or "").strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return "New Project"

    stop_words = {"build", "create", "develop", "make", "please", "me", "a", "an", "the", "to"}
    words = [w for w in cleaned.split(" ") if w and w.lower() not in stop_words]
    if not words:
        return "New Project"
    title = " ".join(words[:6]).strip()
    if len(title) > 60:
        title = title[:60].rsplit(" ", 1)[0]
    return title.title() or "New Project"


def _resolve_chat_project(project_id: str, user_message: str, user_name: str) -> tuple[str, dict | None, bool]:
    """Resolve active chat project, auto-creating one when needed."""
    pid = _normalize_project_id(project_id)
    if pid:
        project = state_manager.get_project(pid)
        if project:
            return pid, project, False

    latest_pid = _latest_chat_project_id()
    should_resume_latest = _message_requests_execution(user_message) or _message_continues_project_context(user_message)
    if latest_pid and should_resume_latest and not _message_starts_new_project(user_message):
        latest_project = state_manager.get_project(latest_pid)
        if latest_project:
            return latest_pid, latest_project, False

    if _message_starts_new_project(user_message):
        project_name = _infer_project_name_from_message(user_message)
        project_desc = f"Auto-created from CEO chat request by {user_name}."
        cfg = _load_config()
        integrations = cfg.get("integrations", {}) if isinstance(cfg.get("integrations"), dict) else {}
        delivery_mode = "github" if str(integrations.get("workspace_mode", "local") or "local").strip().lower() == "github" else "local"
        github_repo = str(integrations.get("github_repo", "") or "").strip()
        github_verified = bool(integrations.get("github_verified"))
        github_token = bool(str(integrations.get("github_token", "") or "").strip())
        if delivery_mode == "github" and not (github_token and github_repo and github_verified):
            delivery_mode = "local"
        new_pid = state_manager.create_project(
            project_name,
            project_desc,
            "app",
            delivery_mode=delivery_mode,
            github_repo=github_repo if delivery_mode == "github" else "",
            github_branch=str(integrations.get("github_default_branch", "master") or "master").strip() or "master",
        )
        try:
            project_service.ensure_metadata(new_pid)
        except Exception:
            pass
        new_project = state_manager.get_project(new_pid)
        emit_activity(
            DATA_DIR,
            "ceo",
            "CREATED",
            f"Project '{project_name}' opened from chat",
            project_id=new_pid,
            metadata={"workspace_path": (new_project or {}).get("workspace_path", "")},
        )
        return new_pid, new_project, True

    return "", None, False


def _build_context_prompt(
    user_message: str,
    history_limit: int = 8,
    user_name: str = "User",
    ceo_name: str = "CEO",
    company_name: str = "",
    project_id: str = "",
) -> str:
    """Build a prompt that includes project-aware context and conversation history."""
    messages = _load_chat_messages(project_id=project_id, include_global=False) if project_id else _load_chat_messages()
    recent = messages[-history_limit:] if len(messages) > history_limit else messages
    active_project = state_manager.get_project(project_id) if project_id else None
    cfg = _load_config()
    integrations = cfg.get("integrations", {}) if isinstance(cfg, dict) else {}

    parts: list[str] = []

    company_label = f" of {company_name}" if company_name else ""
    parts.append(
        f"[CONTEXT: You are {ceo_name}, the CEO{company_label}. "
        f"The person you are speaking with is {user_name}. "
        f"Always refer to yourself as {ceo_name} and address the user as {user_name}. "
        "Do not call the user 'Chairman' unless they explicitly ask for that title.]"
    )
    parts.append("")

    configured_agents = cfg.get("agents", {}) if isinstance(cfg.get("agents"), dict) else {}
    roster_lines: list[str] = []
    for agent_id, default_name in DEFAULT_CONFIG.get("agents", {}).items():
        assigned_name = str(configured_agents.get(agent_id, default_name) or default_name).strip()
        if not assigned_name:
            continue
        role = str(AGENT_REGISTRY.get(agent_id, {}).get("role", "") or "").strip()
        if role:
            roster_lines.append(f"- {agent_id}: {assigned_name} ({role})")
        else:
            roster_lines.append(f"- {agent_id}: {assigned_name}")
    if roster_lines:
        parts.append("[CURRENT TEAM ROSTER: Use these exact names when referring to team members.]")
        parts.extend(roster_lines)
        parts.append("[Do not fall back to baseline/default crew names if these names differ.]")
        parts.append("")

    if active_project:
        workspace_path = str(active_project.get("workspace_path", "") or "")
        project_name = active_project.get("name", project_id)
        parts.append(
            f"[ACTIVE PROJECT: {project_name} ({project_id}). "
            f"Workspace path: {workspace_path}. "
            "All generated code must stay inside this workspace path. "
            "Keep project deliverables updated in company_data: "
            "specs/00_stakeholder_meeting_summary.md, "
            "specs/01_full_execution_plan.md, "
            "artifacts/02_activation_guide.md, "
            "artifacts/03_project_handoff.md.]"
        )
        parts.append("")

    if os.path.exists(MEMORY_PATH):
        with open(MEMORY_PATH) as memory_file:
            memory_text = memory_file.read().strip()
        if memory_text:
            parts.append(f"[YOUR PERSISTENT MEMORIES from previous sessions:\n{memory_text}]")
            parts.append("")

    if recent:
        parts.append("Recent conversation context:")
        for msg in recent:
            speaker = user_name if msg["role"] == "user" else f"You ({ceo_name}, CEO)"
            parts.append(f"{speaker}: {msg['content']}")
        parts.append("")

    workspace_mode = integrations.get("workspace_mode", "local")
    project_delivery_mode = str((active_project or {}).get("delivery_mode", "") or "").strip().lower()
    effective_delivery_mode = project_delivery_mode if project_delivery_mode in {"local", "github"} else str(workspace_mode or "local").strip().lower()
    github_repo = str(integrations.get("github_repo", "") or "").strip()
    github_branch = str(integrations.get("github_default_branch", "master") or "master").strip() or "master"
    if active_project:
        github_repo = str(active_project.get("github_repo", github_repo) or github_repo).strip()
        github_branch = str(active_project.get("github_branch", github_branch) or github_branch).strip() or github_branch
    github_auto_push = bool(integrations.get("github_auto_push"))
    github_auto_pr = bool(integrations.get("github_auto_pr"))
    vercel_project_name = str(integrations.get("vercel_project_name", "") or "").strip()
    vercel_connected = bool(str(integrations.get("vercel_token", "") or "").strip())

    if effective_delivery_mode == "github":
        repo_label = github_repo or "(not configured)"
        parts.append(
            "[DELIVERY MODE: GitHub. "
            f"Target repository: {repo_label}. Default branch: {github_branch}. "
            f"Auto-push is {'enabled' if github_auto_push else 'disabled'}. "
            f"Auto-PR is {'enabled' if github_auto_pr else 'disabled'}. "
            "Provide concrete git commands, branch names, and PR summaries.]"
        )
        parts.append("")
    else:
        parts.append(
            "[DELIVERY MODE: Local workspace. "
            f"Primary workspace root is {WORKSPACE_ROOT}. "
            "Write project output files there.]"
        )
        parts.append("")

    if vercel_connected and vercel_project_name:
        parts.append(
            "[DEPLOYMENT: Vercel connector is configured. "
            f"Preferred project name: {vercel_project_name}. "
            "Offer deployment steps whenever shipping is requested.]"
        )
        parts.append("")

    parts.append(f"{user_name} says now: {user_message}")
    parts.append("")
    parts.append(
        f"Respond to {user_name}'s latest message. "
        "Use an executive, human tone for a Chairman/CEO conversation: concise, clear, respectful, practical. "
        "Do not re-introduce yourself every turn (avoid phrases like '<CEO> here'). "
        "Keep one clear final response per turn, and avoid narrating every intermediate step in prose. "
        "For build requests, execute concrete implementation actions and report files/commands explicitly."
    )
    return "\n".join(parts)


def _apply_agent_name_overrides(text: str, config: dict) -> str:
    """Replace baseline crew names and user title references in final CEO output."""
    if not text:
        return text
    configured_agents = config.get("agents", {}) if isinstance(config.get("agents"), dict) else {}
    updated = text
    for agent_id, default_name in DEFAULT_CONFIG.get("agents", {}).items():
        baseline = str(default_name or "").strip()
        if not baseline:
            continue
        configured_name = str(configured_agents.get(agent_id, baseline) or baseline).strip()
        if not configured_name or configured_name == baseline:
            continue
        updated = re.sub(rf"\b{re.escape(baseline)}\b", configured_name, updated)

    configured_user = str((config.get("user", {}) or {}).get("name", "") or "").strip()
    if configured_user:
        updated = re.sub(
            rf"\bChairman\s+{re.escape(configured_user)}\b",
            configured_user,
            updated,
            flags=re.IGNORECASE,
        )
        updated = re.sub(r"\bChairman\b", configured_user, updated, flags=re.IGNORECASE)
    return updated


def _humanize_llm_runtime_error(
    raw_error: str,
    *,
    provider: str,
    mode: str,
    base_url: str = "",
) -> str:
    """Return a concise, user-facing runtime error with actionable guidance."""
    text = str(raw_error or "").strip()
    if not text:
        return "The model runtime failed unexpectedly. Please retry."

    lower = text.lower()
    auth_error = (
        "missing bearer or basic authentication" in lower
        or "invalid_api_key" in lower
        or "incorrect api key" in lower
        or ("401" in lower and ("unauthorized" in lower or "authentication" in lower))
    )

    if auth_error:
        if provider == "openai" and mode == "codex":
            return (
                "OpenAI authentication is missing for Codex CLI. "
                "Run `codex auth login` in your terminal (or set `OPENAI_API_KEY`), "
                "then retry your message."
            )
        if provider == "openai" and mode == "apikey":
            return (
                "OpenAI API authentication failed. "
                "Add a valid OpenAI API key in Settings -> AI -> OpenAI, then retry. "
                "If you prefer CLI auth, switch to Codex CLI mode and run `codex auth login`."
            )
        if provider == "openai_compat":
            return (
                "The selected OpenAI-compatible endpoint rejected authentication. "
                "Check the base URL and API key/token in Settings, then retry."
            )

    connection_error = (
        "connection refused" in lower
        or "failed to connect" in lower
        or "connection error" in lower
        or "timed out" in lower
        or "name or service not known" in lower
        or "temporary failure in name resolution" in lower
    )
    if connection_error:
        if provider == "openai_compat":
            return (
                "Could not reach the local/OpenAI-compatible model server. "
                "Ensure it is running and the base URL is correct in Settings."
            )
        if "api.openai.com" in (base_url or "").lower():
            return (
                "Could not reach OpenAI right now. "
                "Check your network connection and try again."
            )

    return text[:300]


_MICRO_COMPLEX_KEYWORDS = (
    "architecture",
    "benchmark",
    "ci/cd",
    "compare",
    "deployment",
    "e2e",
    "end-to-end",
    "migrate",
    "migration",
    "multi-agent",
    "multi step",
    "oauth",
    "performance",
    "plan",
    "production",
    "research",
    "roadmap",
    "scale",
    "security",
    "strategy",
    "test every",
    "tradeoff",
)


def _micro_project_complexity_reason(user_message: str) -> str | None:
    """Return a reason string when a request appears too complex for micro mode."""
    text = (user_message or "").strip()
    lower = text.lower()
    reasons: list[str] = []

    if len(text) > 260:
        reasons.append("it is long and likely multi-step")
    if text.count("\n") >= 3 or lower.count(" and ") >= 3:
        reasons.append("it combines multiple objectives")

    keyword_hits = [kw for kw in _MICRO_COMPLEX_KEYWORDS if kw in lower]
    if keyword_hits:
        preview = ", ".join(keyword_hits[:3])
        reasons.append(f"it includes advanced scope ({preview})")

    if not reasons:
        return None

    return (
        "This request looks too large for Micro Project mode because "
        + "; ".join(reasons)
        + ". Switch to full crew mode for stronger planning and execution, or continue in fast solo mode."
    )


def _classify_execution_intent(user_message: str) -> dict[str, Any]:
    """Stage-gated intent classifier used for routing, delegation, and approval gating."""
    raw = (user_message or "").strip()
    text = raw.lower()
    if not text:
        return {
            "intent": "unknown",
            "class": "clarification",
            "confidence": 0.0,
            "needs_planning": False,
            "actionable": False,
            "delegate_allowed": False,
        }

    execution_terms = ("build", "implement", "create", "write", "generate", "deploy", "fix", "ship")
    planning_terms = ("plan", "architecture", "roadmap", "strategy", "research", "tradeoff", "scope")
    complex_terms = ("production", "security", "scalable", "migration", "ci/cd", "end-to-end", "compliance")
    review_terms = ("review", "qa", "test", "regression", "validate", "verify")

    execution_hits = sum(1 for t in execution_terms if _contains_keyword(text, (t,)))
    planning_hits = sum(1 for t in planning_terms if _contains_keyword(text, (t,)))
    complex_hits = sum(1 for t in complex_terms if _contains_keyword(text, (t,)))
    review_hits = sum(1 for t in review_terms if _contains_keyword(text, (t,)))
    is_greeting = _contains_keyword(text, _GREETING_HINTS) and len(text.split()) <= 6 and execution_hits == 0 and planning_hits == 0
    is_status = _contains_keyword(text, _STATUS_HINTS) and execution_hits == 0 and planning_hits == 0
    is_question = "?" in text or _contains_keyword(text, _CLARIFICATION_HINTS)

    if is_greeting:
        return {
            "intent": "qa",
            "class": "greeting",
            "confidence": 0.96,
            "needs_planning": False,
            "actionable": False,
            "delegate_allowed": False,
        }
    if is_status:
        return {
            "intent": "qa",
            "class": "status",
            "confidence": 0.82,
            "needs_planning": False,
            "actionable": False,
            "delegate_allowed": False,
        }
    if planning_hits > execution_hits:
        confidence = min(0.98, 0.62 + planning_hits * 0.08)
        return {
            "intent": "planning",
            "class": "planning",
            "confidence": round(confidence, 2),
            "needs_planning": True,
            "actionable": True,
            "delegate_allowed": True,
        }
    if execution_hits > 0:
        needs_planning = complex_hits > 0 or planning_hits > 0 or (len(text.split()) > 45)
        confidence = min(0.98, 0.64 + execution_hits * 0.07)
        # Always allow delegation for execution intents — the CEO template
        # decides whether delegation is appropriate based on complexity tiers.
        return {
            "intent": "execution",
            "class": "execution",
            "confidence": round(confidence, 2),
            "needs_planning": needs_planning,
            "actionable": True,
            "delegate_allowed": True,
        }
    if review_hits > 0:
        return {
            "intent": "qa",
            "class": "review",
            "confidence": 0.68,
            "needs_planning": False,
            "actionable": True,
            "delegate_allowed": True,
        }
    if is_question:
        return {
            "intent": "qa",
            "class": "clarification",
            "confidence": 0.6,
            "needs_planning": False,
            "actionable": False,
            "delegate_allowed": True,
        }
    # Default: allow delegation so the CEO can decide based on context
    return {
        "intent": "qa",
        "class": "general",
        "confidence": 0.52,
        "needs_planning": False,
        "actionable": True,
        "delegate_allowed": True,
    }


def _structured_response_payload(text: str) -> dict[str, Any]:
    """Best-effort structured response projection for UI automation."""
    raw = (text or "").strip()
    if not raw:
        return {"summary": "", "delegations": [], "risks": [], "next_actions": []}
    lines = [line.strip("- ").strip() for line in raw.splitlines() if line.strip()]
    summary = lines[0] if lines else raw[:240]
    delegations: list[dict[str, str]] = []
    risks: list[str] = []
    next_actions: list[str] = []
    for line in lines:
        lower = line.lower()
        if "delegat" in lower:
            delegations.append({"agent": "team", "why": line, "action": line})
        if "risk" in lower or "concern" in lower:
            risks.append(line)
        if lower.startswith(("next", "do ", "run ", "create ", "update ", "verify ")):
            next_actions.append(line)
    return {
        "summary": summary,
        "delegations": delegations[:10],
        "risks": risks[:10],
        "next_actions": next_actions[:10],
    }


def _lightweight_ceo_response(
    *,
    intent: dict[str, Any],
    user_name: str,
    ceo_name: str,
    project: dict | None,
) -> str | None:
    """Return deterministic, non-delegating chat replies for lightweight turns."""
    intent_class = str(intent.get("class", "") or "")
    if intent_class == "greeting":
        if project:
            project_name = str(project.get("name", "the project") or "the project")
            return (
                f"Hi {user_name}. Ready to move on {project_name}. "
                "Tell me the outcome you want, and I’ll take it from there."
            )
        return (
            f"Hi {user_name}. I’m ready. "
            "Share what you want to build, and once you choose a project location (Local or GitHub), I’ll execute."
        )
    if intent_class == "status":
        if not project:
            return (
                f"{user_name}, we are in conversation mode with no active project selected. "
                "Select or create a project when you want execution."
            )
        project_name = str(project.get("name", "Project") or "Project")
        status = str(project.get("status", "planning") or "planning")
        workspace = str(project.get("workspace_path", "") or "")
        return (
            f"{user_name}, current status for {project_name} is '{status}'. "
            f"Workspace path: {workspace or '(not set)'}. "
            "I can provide the next execution step as soon as you ask."
        )
    return None


def _is_vercel_verified(config: dict) -> bool:
    integrations = config.get("integrations", {}) if isinstance(config.get("integrations"), dict) else {}
    token_set = bool(str(integrations.get("vercel_token", "") or "").strip())
    project_name = str(integrations.get("vercel_project_name", "") or "").strip()
    verified = bool(integrations.get("vercel_verified"))
    return token_set and bool(project_name) and verified


def _should_offer_vercel_deploy(
    *,
    user_message: str,
    final_response: str,
    intent: dict[str, Any],
    config: dict,
) -> bool:
    if not _is_vercel_verified(config):
        return False
    if str(intent.get("intent", "")) != "execution":
        return False

    lower_user = (user_message or "").lower()
    lower_final = (final_response or "").lower()
    if "vercel.app" in lower_final:
        return False
    if "deploy" in lower_user and "vercel" in lower_user:
        return True
    completion_hints = (
        "implemented",
        "completed",
        "finished",
        "run it locally",
        "activation",
        "workspace",
        "what's included",
    )
    return any(token in lower_final for token in completion_hints)


def _build_micro_project_prompt(prompt: str, *, user_name: str, ceo_name: str) -> str:
    """Inject strict micro-project constraints into the prompt."""
    micro_rules = (
        f"[MICRO PROJECT MODE: Enabled by {user_name} with explicit quality trade-off approval. "
        f"You are {ceo_name} working solo for rapid output. "
        "Do not delegate to any specialist agent. "
        "Do not run broad research or long planning. "
        "Deliver the smallest direct solution, note key limitations briefly, and keep responses concise.]"
    )
    return f"{micro_rules}\n\n{prompt}"


def _format_tool_action(tool_name: str, tool_input: dict) -> str:
    """Convert a Claude tool-use block into a readable single-line action label."""
    if tool_name == "Bash":
        cmd = (tool_input.get("command") or "").strip()[:100]
        return f"Running: {cmd}"
    if tool_name in ("Write", "Edit", "NotebookEdit"):
        path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
        return f"{tool_name}: {path}"
    if tool_name == "Read":
        path = tool_input.get("file_path") or ""
        return f"Reading: {path}"
    if tool_name in ("Glob", "Grep"):
        pattern = tool_input.get("pattern") or tool_input.get("query") or ""
        return f"{tool_name}: {pattern}"
    if tool_name == "Task":
        desc = (tool_input.get("description") or tool_input.get("prompt") or "")[:60]
        agent = tool_input.get("subagent_type") or ""
        if agent:
            return f"Delegating to {agent}: {desc}"
        return f"Task: {desc}"
    if tool_name == "WebFetch":
        url = (tool_input.get("url") or "")[:60]
        return f"Fetching: {url}"
    if tool_name == "WebSearch":
        q = (tool_input.get("query") or "")[:60]
        return f"Searching: {q}"
    if "mcp__" in tool_name:
        parts = tool_name.split("__")
        if len(parts) >= 3:
            scope, action = parts[1], parts[2].replace("_", " ")
            return f"{scope.capitalize()} → {action}"
    return f"Using {tool_name}"


def _guardrail_violation_message(guardrails: dict[str, Any] | None) -> str:
    """Return a user-facing guardrail violation message."""
    if not guardrails:
        return "Execution budget exceeded; stopping run."
    if bool(guardrails.get("runtime_exceeded")):
        elapsed = int(guardrails.get("elapsed_seconds", 0) or 0)
        max_runtime = int(guardrails.get("max_runtime_seconds", 0) or 0)
        if max_runtime > 0:
            return f"Execution runtime budget exceeded ({elapsed}s/{max_runtime}s); stopping run."
        return "Execution runtime budget exceeded; stopping run."
    if bool(guardrails.get("command_exceeded")) or bool(guardrails.get("file_exceeded")):
        return "Tool budget exceeded; stopping run."
    return "Execution budget exceeded; stopping run."


def _normalize_chat_activity_metadata(
    agent: str,
    action: str,
    detail: str,
    *,
    project_id: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Normalize activity metadata so UI can drive deterministic live flow visuals."""
    normalized: dict[str, Any] = dict(metadata or {})
    action_upper = str(action or "").upper()

    event_kind = str(normalized.get("event_kind", "") or "").strip().lower()
    if not event_kind:
        if action_upper == "DELEGATED":
            event_kind = "delegation_start"
        elif action_upper in {"COMPLETED", "DONE"}:
            event_kind = "task_end"
        elif action_upper in {"STARTED", "CREATED", "ASSIGNED"}:
            event_kind = "task_start"
        elif action_upper in {"ERROR", "BLOCKED"}:
            event_kind = "task_error"
        else:
            event_kind = "task_progress"
    normalized["event_kind"] = event_kind

    source_agent = str(normalized.get("source_agent", "") or "").strip().lower()
    target_agent = str(normalized.get("target_agent", "") or "").strip().lower()
    if not source_agent:
        source_agent = str(agent or "").strip().lower()
    normalized["source_agent"] = source_agent
    if target_agent:
        normalized["target_agent"] = target_agent

    flow = str(normalized.get("flow", "") or "").strip().lower()
    if not flow:
        if source_agent == "ceo" and target_agent and target_agent != "ceo":
            flow = "down"
        elif target_agent == "ceo" and source_agent and source_agent != "ceo":
            flow = "up"
        else:
            flow = "internal"
    normalized["flow"] = flow

    state = str(normalized.get("state", "") or "").strip().lower()
    if not state:
        if action_upper in {"COMPLETED", "DONE"}:
            state = "completed"
        elif action_upper in {"ERROR", "BLOCKED"}:
            state = "failed"
        elif action_upper in {"STARTED", "CREATED", "ASSIGNED", "DELEGATED"}:
            state = "started"
        else:
            state = "running"
    normalized["state"] = state

    if not str(normalized.get("task", "") or "").strip():
        task = str(detail or "").strip()
        normalized["task"] = task[:280] if task else action.title()

    if project_id and not normalized.get("project_id"):
        normalized["project_id"] = project_id

    return normalized


def _emit_chat_activity(
    agent: str,
    action: str,
    detail: str,
    *,
    project_id: str = "",
    metadata: dict[str, Any] | None = None,
) -> None:
    normalized_project_id = _normalize_project_id(project_id)
    normalized_metadata = _normalize_chat_activity_metadata(
        agent,
        action,
        detail,
        project_id=normalized_project_id,
        metadata=metadata,
    )
    emit_activity(
        DATA_DIR,
        agent,
        action,
        detail,
        project_id=normalized_project_id,
        metadata=normalized_metadata,
    )


def _should_trigger_execution_bridge(
    user_message: str,
    project_id: str,
    *,
    intent: dict[str, Any] | None = None,
    project: dict | None = None,
    micro_project_mode: bool = False,
) -> bool:
    if micro_project_mode or not project_id:
        return False
    profile = intent or _classify_execution_intent(user_message)
    if str(profile.get("intent", "")) != "execution":
        return False
    if bool(profile.get("needs_planning")) and not bool((project or {}).get("plan_approved")):
        return False
    return _message_requests_execution(user_message)


_PROJECT_PHASE_TEMPLATE = [
    "Scope Alignment",
    "Implementation",
    "QA & Validation",
    "Release & Handoff",
]

_SUPPORT_AGENT_HINTS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("research", "investigate", "analyze", "compare", "strategy"), "chief-researcher"),
    (("frontend", "ui", "ux", "web", "page", "canvas", "css", "react"), "lead-frontend"),
    (("backend", "api", "server", "database", "endpoint", "auth"), "lead-backend"),
    (("design", "layout", "theme", "branding", "copy"), "lead-designer"),
    (("test", "qa", "bug", "regression", "edge case"), "qa-lead"),
    (("deploy", "release", "vercel", "docker", "infra", "ci", "cd"), "devops"),
    (("security", "token", "oauth", "permission"), "security-engineer"),
    (("data", "analytics", "metric", "dashboard"), "data-engineer"),
    (("readme", "guide", "documentation", "docs", "handoff"), "tech-writer"),
)

_SUPPORT_AGENT_TASKS: dict[str, str] = {
    "chief-researcher": "Validate scope assumptions and identify implementation constraints.",
    "cto": "Confirm architecture and quality gates for the implementation.",
    "vp-engineering": "Break implementation into concrete engineering workstreams.",
    "lead-frontend": "Implement user-facing UI flow and interaction logic.",
    "lead-backend": "Implement server/data logic and integration endpoints.",
    "lead-designer": "Refine UX copy, layout clarity, and interaction polish.",
    "qa-lead": "Define validation checks and run functional regression pass.",
    "devops": "Prepare local run instructions and deployment path.",
    "security-engineer": "Review security-sensitive surfaces and constraints.",
    "data-engineer": "Implement telemetry, analytics, or data wiring.",
    "tech-writer": "Document setup, activation, and project handoff.",
}


def _ordered_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        key = (value or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        ordered.append(key)
    return ordered


def _configured_agent_name(agent_id: str, config: dict) -> str:
    configured = config.get("agents", {}) if isinstance(config.get("agents"), dict) else {}
    value = str(configured.get(agent_id, "") or "").strip()
    if value:
        return value
    return get_agent_display_name(agent_id)


def _infer_support_agents(user_message: str, *, intent: dict[str, Any] | None = None) -> list[str]:
    """Infer specialist involvement with conservative delegation defaults."""
    text = (user_message or "").lower()
    profile = intent or _classify_execution_intent(user_message)
    intent_class = str(profile.get("class", "") or "")
    actionable = bool(profile.get("actionable"))
    delegate_allowed = bool(profile.get("delegate_allowed"))
    if intent_class in {"greeting", "clarification", "status"} or not actionable or not delegate_allowed:
        return []

    inferred: list[str] = []
    for keywords, agent_id in _SUPPORT_AGENT_HINTS:
        if any(keyword in text for keyword in keywords):
            inferred.append(agent_id)

    if intent_class == "planning":
        inferred.extend(["chief-researcher", "cto", "vp-engineering"])

    if str(profile.get("intent", "")) == "execution":
        # Add delivery defaults only for real implementation turns.
        if not any(agent in inferred for agent in ("lead-frontend", "lead-backend")):
            inferred.append("vp-engineering")
        inferred.append("qa-lead")
        inferred.append("tech-writer")

    ordered = [
        agent_id
        for agent_id in _ordered_unique(inferred)
        if agent_id in AGENT_REGISTRY and agent_id != "ceo"
    ]
    # Cap concurrent delegation to reduce noise and over-orchestration.
    return ordered[:4]


def _agent_task_summary(agent_id: str, user_message: str) -> str:
    base = _SUPPORT_AGENT_TASKS.get(agent_id, "Contribute specialist implementation output.")
    request = re.sub(r"\s+", " ", (user_message or "").strip())
    if request:
        return f"{base} Request focus: {request[:120]}"
    return base


def _seed_project_execution_scaffold(
    project_id: str,
    user_message: str,
    *,
    support_agents: list[str],
    user_name: str,
    ceo_name: str,
    config: dict,
) -> None:
    """Seed baseline team/tasks/discussions so project tabs are never empty."""
    normalized_project_id = _normalize_project_id(project_id)
    if not normalized_project_id:
        return

    project = state_manager.get_project(normalized_project_id)
    if not project:
        return

    support = [agent_id for agent_id in support_agents if agent_id in AGENT_REGISTRY and agent_id != "ceo"]
    updates: dict[str, Any] = {}

    phases = list(project.get("phases") or [])
    if not phases:
        updates["phases"] = list(_PROJECT_PHASE_TEMPLATE)

    existing_team = [str(member).strip() for member in list(project.get("team") or []) if str(member).strip()]
    desired_team = _ordered_unique(
        existing_team
        + [_configured_agent_name("ceo", config)]
        + [_configured_agent_name(agent_id, config) for agent_id in support]
    )
    if desired_team and desired_team != existing_team:
        updates["team"] = desired_team

    status = str(project.get("status", "") or "").strip().lower()
    if status in {"", "planning"}:
        updates["status"] = "active"

    if updates:
        state_manager.update_project(normalized_project_id, updates)
    seeded_tasks = False

    existing_tasks = task_board.get_board(normalized_project_id)
    if len(existing_tasks) == 0:
        seeded_tasks = True
        _msg_trimmed = re.sub(r'\s+', ' ', (user_message or '').strip())[:140]
        task_templates: list[tuple[str, str, str, str]] = [
            (
                "Kickoff scope and acceptance criteria",
                f"Capture goals and acceptance criteria for: {_msg_trimmed}",
                _configured_agent_name("ceo", config),
                "p1",
            ),
        ]
        for idx, agent_id in enumerate(support[:4]):
            task_templates.append(
                (
                    f"{_configured_agent_name(agent_id, config)} execution stream",
                    _agent_task_summary(agent_id, user_message),
                    _configured_agent_name(agent_id, config),
                    "p1" if idx < 2 else "p2",
                )
            )
        qa_owner = _configured_agent_name("qa-lead", config) if "qa-lead" in support else _configured_agent_name("ceo", config)
        task_templates.append(
            (
                "Validation and release checklist",
                "Run functional validation, verify outputs, and prepare release notes.",
                qa_owner,
                "p1",
            )
        )
        for title, description, owner, priority in task_templates:
            task_board.create_task(
                normalized_project_id,
                title=title,
                description=description,
                assigned_to=owner,
                priority=priority,
            )

    decisions_path = safe_path_join(DATA_DIR, "projects", normalized_project_id, "decisions.yaml")
    with FileLock(decisions_path):
        data: dict[str, Any] = {"decisions": []}
        if os.path.exists(decisions_path):
            try:
                with open(decisions_path) as f:
                    loaded = yaml.safe_load(f) or {}
                if isinstance(loaded, dict):
                    data = loaded
            except (OSError, yaml.YAMLError):
                data = {"decisions": []}
        decisions = data.get("decisions", [])
        if not isinstance(decisions, list):
            decisions = []
        if len(decisions) == 0:
            now = datetime.now(timezone.utc).isoformat()
            decisions.extend(
                [
                    {
                        "title": "Kickoff Alignment",
                        "decision": "Proceed with implementation in the active project workspace.",
                        "rationale": f"{user_name} requested direct execution and {ceo_name} confirmed kickoff scope.",
                        "decided_by": _configured_agent_name("ceo", config),
                        "alternatives": "Pause for additional planning.",
                        "timestamp": now,
                    },
                    {
                        "title": "Delivery Standard",
                        "decision": "Keep deliverables updated in company_data specs/artifacts and workspace files.",
                        "rationale": "Maintains traceable output for plan, activation, and handoff tabs.",
                        "decided_by": _configured_agent_name("ceo", config),
                        "alternatives": "Ad-hoc notes only.",
                        "timestamp": now,
                    },
                ]
            )
            data["decisions"] = decisions
            atomic_yaml_write(decisions_path, data)

    _emit_chat_activity(
        "ceo",
        "UPDATED",
        "Project context scaffold refreshed (team, phases, tasks, discussions).",
        project_id=normalized_project_id,
        metadata={
            "workspace_path": str(project.get("workspace_path", "") or ""),
            "team_count": len(desired_team),
            "tasks_seeded": seeded_tasks,
            "support_agents": support,
        },
    )


def _write_text_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def _generate_planning_packet(
    project_id: str,
    *,
    user_message: str,
    user_name: str,
    ceo_name: str,
) -> dict[str, Any]:
    """Create or refresh planning packet docs in business language."""
    project = state_manager.get_project(project_id) or {}
    project_name = str(project.get("name", project_id) or project_id)
    workspace_path = str(project.get("workspace_path", "") or "")
    delivery_mode = str(project.get("delivery_mode", "local") or "local")
    github_repo = str(project.get("github_repo", "") or "").strip()
    github_branch = str(project.get("github_branch", "master") or "master").strip() or "master"
    concise_request = re.sub(r"\s+", " ", (user_message or "").strip())
    now_label = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    project_root = safe_path_join(DATA_DIR, "projects", project_id)
    stakeholder_path = safe_path_join(project_root, "specs", "00_stakeholder_meeting_summary.md")
    plan_path = safe_path_join(project_root, "specs", "01_full_execution_plan.md")
    activation_path = safe_path_join(project_root, "artifacts", "02_activation_guide.md")
    handoff_path = safe_path_join(project_root, "artifacts", "03_project_handoff.md")

    meeting_summary = (
        f"# Stakeholder Meeting Summary: {project_name}\n\n"
        f"_Prepared on {now_label}_\n\n"
        "## Participants\n"
        f"- {user_name} (Chairman)\n"
        f"- {ceo_name} (CEO)\n"
        "- Specialist contributors (assigned after approval)\n\n"
        "## Business Need\n"
        f"- Request received: {concise_request or 'Clarify project objective.'}\n"
        "- Deliver a practical outcome with clear activation steps and documented handoff.\n\n"
        "## Decisions Recorded\n"
        "- Proceed with a staged plan before full execution.\n"
        "- Keep all outputs in the project workspace and project documentation folders.\n\n"
        "## Open Questions\n"
        "- Any additional constraints on deadline, budget, or preferred stack?\n"
        "- Success metric the Chairman wants to optimize first?\n"
    )

    delivery_line = (
        f"- Delivery mode: GitHub (`{github_repo or 'repository not set'}` on `{github_branch}`)"
        if delivery_mode == "github"
        else f"- Delivery mode: Local workspace (`{workspace_path}`)"
    )
    execution_plan = (
        f"# Full Execution Plan: {project_name}\n\n"
        f"_Prepared on {now_label}_\n\n"
        "## Scope\n"
        f"- Primary objective: {concise_request or 'Define the requested deliverable.'}\n"
        "- Expected deliverables: working output, validation evidence, and activation guide.\n\n"
        "## Acceptance Criteria\n"
        "- Output is runnable with clear setup/run steps.\n"
        "- Core user flow is validated and documented.\n"
        "- Handoff notes explain what was built and any known limitations.\n\n"
        "## Risks and Dependencies\n"
        "- Risk: unclear requirements can delay implementation quality.\n"
        "- Mitigation: confirm assumptions early and keep scope explicit.\n"
        "- Dependency: selected AI runtime/provider availability during execution.\n\n"
        "## Execution Waves\n"
        "1. Planning alignment and scope lock.\n"
        "2. Build implementation with tracked activity.\n"
        "3. QA verification and regression checks.\n"
        "4. Release handoff and activation walkthrough.\n\n"
        "## Delivery Context\n"
        f"{delivery_line}\n"
        f"- Workspace path: `{workspace_path}`\n"
    )

    activation_guide = (
        f"# Activation Guide: {project_name}\n\n"
        f"_Prepared on {now_label}_\n\n"
        "## Output Location\n"
        f"- Workspace path: `{workspace_path}`\n"
        f"{delivery_line}\n\n"
        "## Setup\n"
        "1. Open the workspace path above.\n"
        "2. Install dependencies used by the project.\n"
        "3. Configure required environment variables.\n\n"
        "## Run and Verify\n"
        "1. Start the application using the project run command.\n"
        "2. Validate the primary user flow and expected result.\n"
        "3. Confirm no blocking errors in runtime logs.\n\n"
        "## Deployment\n"
        "1. If GitHub mode is selected, push branch updates and create a PR.\n"
        "2. If Vercel is connected, deploy the approved branch/artifact.\n"
        "3. Record final deployment URL in the handoff note.\n"
    )

    handoff = (
        f"# Project Handoff: {project_name}\n\n"
        "## Final Summary\n"
        "- To be completed after execution.\n\n"
        "## Files and Modules\n"
        "- To be completed after execution.\n\n"
        "## Operational Notes\n"
        "- Monitoring and fallback notes to be completed after execution.\n"
    )

    _write_text_file(stakeholder_path, meeting_summary)
    _write_text_file(plan_path, execution_plan)
    _write_text_file(activation_path, activation_guide)
    if not os.path.exists(handoff_path):
        _write_text_file(handoff_path, handoff)

    try:
        metadata = project_service.get_metadata(project_id)
        charter = metadata.get("charter", {}) if isinstance(metadata.get("charter"), dict) else {}
        charter["scope"] = concise_request or charter.get("scope", "")
        charter["acceptance_criteria"] = _ordered_unique([
            "Runnable output with clear activation steps",
            "Validated core flow",
            "Documented handoff",
        ])
        notes = metadata.get("stakeholder_notes", []) if isinstance(metadata.get("stakeholder_notes"), list) else []
        notes.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "author": ceo_name,
            "note": f"Planning packet refreshed for request: {concise_request[:180]}",
        })
        project_service.update_metadata(project_id, {
            "charter": charter,
            "stakeholder_notes": notes[-50:],
        })
    except Exception:
        pass

    return project_service.plan_packet_status(project_id)


def _build_synthetic_delegation_plan(
    user_message: str,
    support_agents: list[str],
    *,
    config: dict,
) -> list[dict[str, str]]:
    """Build lightweight delegation summaries used for non-Claude runtimes."""
    plan: list[dict[str, str]] = []
    for agent_id in support_agents[:4]:
        plan.append(
            {
                "agent_id": agent_id,
                "agent_name": _configured_agent_name(agent_id, config),
                "task": _agent_task_summary(agent_id, user_message),
            }
        )
    return plan


async def _emit_synthetic_delegation_start(
    websocket: WebSocket,
    *,
    delegation_plan: list[dict[str, str]],
    project_id: str,
    runtime_metadata: dict[str, Any],
    run_id: str,
) -> None:
    for step in delegation_plan:
        agent_id = step.get("agent_id", "")
        agent_name = step.get("agent_name", agent_id)
        task = step.get("task", "").strip() or "Delegated task started."
        label = f"Delegating to {agent_name}: {task[:140]}"
        await websocket.send_json({"type": "action", "content": label})
        await websocket.send_json({
            "type": "action_detail",
            "content": {
                "label": label,
                "state": "started",
                "run_id": run_id,
                "tool": "synthetic_delegation",
                "source_agent": "ceo",
                "target_agent": agent_id,
                "actor": "ceo",
                "target": agent_id,
                "flow": "down",
                "task": task[:280],
                **runtime_metadata,
            },
        })
        _emit_chat_activity(
            "ceo",
            "DELEGATED",
            label,
            project_id=project_id,
            metadata={
                "source_agent": "ceo",
                "target_agent": agent_id,
                "flow": "down",
                "task": task[:280],
                **runtime_metadata,
            },
        )
        _emit_chat_activity(
            agent_id,
            "STARTED",
            task[:280],
            project_id=project_id,
            metadata={
                "source_agent": "ceo",
                "target_agent": agent_id,
                "flow": "down",
                "task": task[:280],
                **runtime_metadata,
            },
        )


async def _emit_synthetic_delegation_completion(
    websocket: WebSocket,
    *,
    delegation_plan: list[dict[str, str]],
    project_id: str,
    runtime_metadata: dict[str, Any],
    run_id: str,
) -> None:
    for step in delegation_plan:
        agent_id = step.get("agent_id", "")
        agent_name = step.get("agent_name", agent_id)
        task = step.get("task", "").strip() or "Delegated task completed."
        result = f"{agent_name} completed: {task[:140]}"
        await websocket.send_json({"type": "action_result", "content": result})
        await websocket.send_json({
            "type": "action_detail",
            "content": {
                "label": result,
                "state": "completed",
                "run_id": run_id,
                "tool": "synthetic_delegation",
                "source_agent": agent_id,
                "target_agent": "ceo",
                "actor": agent_id,
                "target": "ceo",
                "flow": "up",
                "task": task[:280],
                **runtime_metadata,
            },
        })
        _emit_chat_activity(
            agent_id,
            "COMPLETED",
            task[:280],
            project_id=project_id,
            metadata={
                "source_agent": agent_id,
                "target_agent": "ceo",
                "flow": "up",
                "task": task[:280],
                **runtime_metadata,
            },
        )
        _emit_chat_activity(
            "ceo",
            "UPDATED",
            f"Received update from {agent_name}: {task[:200]}",
            project_id=project_id,
            metadata={
                "source_agent": agent_id,
                "target_agent": "ceo",
                "flow": "up",
                "task": task[:280],
                **runtime_metadata,
            },
        )


def _sanitize_ceo_response(text: str, *, ceo_name: str, user_name: str) -> str:
    """Normalize verbose progress chatter into a clean final CEO response."""
    raw = (text or "").replace("\r", "").strip()
    if not raw:
        return raw

    ceo_lower = ceo_name.strip().lower()
    user_lower = user_name.strip().lower()
    seen_lines: set[str] = set()
    cleaned_lines: list[str] = []

    for line in raw.splitlines():
        stripped = line.strip()
        if user_name and ceo_name:
            stripped = re.sub(
                rf"^{re.escape(user_name)}\s*,\s*(?:ceo\s+)?{re.escape(ceo_name)}\s+",
                "",
                stripped,
                flags=re.IGNORECASE,
            )
        if ceo_name:
            stripped = re.sub(
                rf"^(?:ceo\s+)?{re.escape(ceo_name)}\s*[:,]\s*",
                "",
                stripped,
                flags=re.IGNORECASE,
            )
        if not stripped:
            if cleaned_lines and cleaned_lines[-1] != "":
                cleaned_lines.append("")
            continue
        lowered = stripped.lower()
        lowered_compact = re.sub(r"\s+", " ", lowered)
        lowered_norm = lowered_compact.replace("’", "'")

        if lowered_norm in seen_lines:
            continue
        seen_lines.add(lowered_norm)

        if ceo_lower and (
            lowered_norm.startswith(f"{ceo_lower} here")
            or lowered_norm.startswith(f"{user_lower}, {ceo_lower} here")
            or lowered_norm.startswith(f"{ceo_lower} is now ")
            or lowered_norm.startswith(f"{ceo_lower} will ")
            or lowered_norm.startswith(f"{ceo_lower} has enough context")
            or lowered_norm.startswith(f"{ceo_lower} found ")
            or lowered_norm.startswith(f"next {ceo_lower} will")
            or lowered_norm.startswith(f"{user_lower}, {ceo_lower} has")
            or lowered_norm.startswith(f"{user_lower}, {ceo_lower} will")
        ):
            continue
        if lowered_norm.startswith("quick update"):
            continue
        if (
            ("report back" in lowered_norm or "then report" in lowered_norm)
            and ("i'll run" in lowered_norm or "i will run" in lowered_norm or "will run" in lowered_norm)
        ):
            continue
        if lowered_norm.startswith(f"{user_lower}, i'll ") or lowered_norm.startswith(f"{user_lower}, i will "):
            continue
        cleaned_lines.append(stripped)

    while cleaned_lines and cleaned_lines[-1] == "":
        cleaned_lines.pop()

    cleaned = "\n".join(cleaned_lines).strip()
    return cleaned or raw


def _build_execution_bridge_prompt(
    user_message: str,
    model_response: str,
    *,
    project_name: str,
    project_id: str,
    workspace_path: str,
    user_name: str = "User",
) -> str:
    """Build a constrained implementation prompt for Codex execution bridge."""
    return (
        "You are executing implementation work for COMPaaS.\n"
        f"Project: {project_name} ({project_id})\n"
        f"Workspace path: {workspace_path}\n\n"
        "Hard constraints:\n"
        "- Create or modify files only inside the workspace path.\n"
        "- If new package files are needed, keep them minimal and runnable.\n"
        "- Do not ask for interactive approvals.\n"
        "- Print the exact files changed and commands run.\n\n"
        f"{user_name} request:\n{user_message}\n\n"
        "Execution brief from reasoning model:\n"
        f"{model_response}\n\n"
        "Now implement the requested solution directly in the workspace.\n"
        "Return one final concise CEO update only. Do not emit repeated progress narration."
    )


@app.get("/api/chat/history", summary="Get CEO chat message history")
def chat_history(
    limit: int = Query(default=50, ge=1, le=300),
    project_id: str = Query(default="", description="Optional project scope"),
) -> list[dict]:
    """Return recent chat messages."""
    normalized = _normalize_project_id(project_id)
    if (project_id or "").strip() and not normalized:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")
    messages = _load_chat_messages(project_id=normalized)
    return messages[-limit:]


@app.delete("/api/chat/history", summary="Clear chat history")
def clear_chat_history(project_id: str = Query(default="", description="Optional project scope")) -> dict:
    """Clear the chat log globally or for a single project."""
    raw_pid = (project_id or "").strip()
    pid = _normalize_project_id(project_id)
    if raw_pid and not pid:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")
    if not pid:
        _save_chat_messages([])
        return {"status": "cleared", "scope": "all"}

    messages = _load_chat_messages()
    remaining = [m for m in messages if _normalize_project_id(str(m.get("project_id", "") or "")) != pid]
    _save_chat_messages(remaining)
    return {"status": "cleared", "scope": pid}


# ---------------------------------------------------------------------------
# CEO chat: per-provider handler functions
# ---------------------------------------------------------------------------

async def _handle_ceo_claude(
    websocket: WebSocket,
    prompt: str,
    claude_path: str,
    llm_cfg: dict,
    ceo_name: str = "CEO",
    micro_project_mode: bool = False,
    project_id: str = "",
    run_id: str = "",
) -> str | None:
    """Handle a CEO chat turn using the Claude Code CLI subprocess.

    Uses --output-format stream-json so tool-use actions are streamed as they
    happen.  Text blocks are forwarded as 'chunk' messages; tool_use blocks are
    forwarded as 'action' messages; tool results are forwarded as
    'action_result' messages.  Falls back to raw-text mode if the JSON parse
    fails on a line.

    Returns the full response string, or None if an error was sent.
    """
    env = os.environ.copy()
    anthropic_mode = str(llm_cfg.get("anthropic_mode", "cli") or "cli").lower()
    runtime_metadata = {
        "provider": "anthropic",
        "mode": anthropic_mode if anthropic_mode in ("cli", "apikey") else "cli",
        "runtime": "claude_cli",
        "model": str(llm_cfg.get("model", "claude") or "claude"),
    }
    anthropic_api_key = str(llm_cfg.get("api_key", "") or "").strip()
    if llm_cfg.get("proxy_enabled") and llm_cfg.get("proxy_url"):
        env["ANTHROPIC_BASE_URL"] = llm_cfg["proxy_url"]
        env["ANTHROPIC_API_KEY"] = env.get("ANTHROPIC_API_KEY") or "litellm"
    elif anthropic_mode == "apikey":
        if anthropic_api_key:
            env["ANTHROPIC_API_KEY"] = anthropic_api_key
        elif not env.get("ANTHROPIC_API_KEY"):
            await websocket.send_json({
                "type": "error",
                "content": "Anthropic API-key mode is selected but no API key is configured.",
            })
            if run_id:
                run_service.transition_run(
                    run_id,
                    state="failed",
                    label="Anthropic API-key mode selected without configured key",
                )
            return None

    process = None
    saw_tool_use = False
    pending_delegate_agents: list[str] = []
    try:
        cmd = [claude_path, "--agent", "ceo", "-p", prompt]
        # Web dashboard runs are non-interactive, so permission prompts cannot
        # be answered. Force bypass mode to avoid silent no-op file writes.
        cmd.extend(["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"])
        cmd.extend(["--output-format", "stream-json", "--verbose"])
        _emit_chat_activity(
            "ceo",
            "STARTED",
            "Launching Claude CEO runtime (permission mode: bypassPermissions)",
            project_id=project_id,
            metadata=runtime_metadata,
        )
        if run_id:
            run_service.transition_run(
                run_id,
                state="executing",
                label="Launching Claude CEO runtime",
                metadata=runtime_metadata,
            )

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=1024 * 1024,  # 1 MB – prevents LimitOverrunError on large JSON lines
            env=env,
            cwd=PROJECT_ROOT,
        )

        response_parts: list[str] = []
        full_response: str | None = None
        assert process.stdout is not None
        idle_ticks = 0  # how many 30-s timeouts in a row

        while True:
            if run_id:
                run_state = run_service.get_run(run_id)
                if run_state and bool(run_state.get("cancel_requested")):
                    await websocket.send_json({"type": "error", "content": "Run cancelled by user."})
                    run_service.transition_run(run_id, state="cancelled", label="Run cancelled by user")
                    return None
                guardrails = run_service.guardrail_status(run_id)
                if guardrails and guardrails.get("over_budget"):
                    violation_message = _guardrail_violation_message(guardrails)
                    await websocket.send_json({"type": "error", "content": violation_message})
                    run_service.transition_run(run_id, state="failed", label=violation_message)
                    return None
            try:
                raw = await asyncio.wait_for(process.stdout.readline(), timeout=30.0)
            except asyncio.TimeoutError:
                idle_ticks += 1
                await websocket.send_json({
                    "type": "thinking",
                    "content": f"{ceo_name} is working… ({idle_ticks * 30}s)",
                })
                _emit_chat_activity(
                    "ceo",
                    "UPDATED",
                    f"Claude runtime still processing ({idle_ticks * 30}s)",
                    project_id=project_id,
                    metadata=runtime_metadata,
                )
                if process.returncode is not None:
                    break
                continue

            if not raw:
                break  # EOF
            idle_ticks = 0
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            # Try to parse as a stream-json event
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                # Plain text fallback (shouldn't normally happen with stream-json)
                response_parts.append(line + "\n")
                await websocket.send_json({"type": "chunk", "content": line + "\n"})
                continue

            event_type = event.get("type", "")

            if event_type == "assistant":
                for block in event.get("message", {}).get("content", []):
                    btype = block.get("type", "")
                    if btype == "text":
                        text = block.get("text", "")
                        if text:
                            response_parts.append(text)
                            await websocket.send_json({"type": "chunk", "content": text})
                    elif btype == "tool_use":
                        saw_tool_use = True
                        tool_name = str(block.get("name", "tool") or "tool")
                        tool_input = block.get("input", {}) if isinstance(block.get("input", {}), dict) else {}
                        if micro_project_mode and tool_name == "Task":
                            violation_message = (
                                "Micro Project mode is CEO-only. Delegation to specialist agents was blocked. "
                                "Turn Micro mode off to run the full crew."
                            )
                            await websocket.send_json({
                                "type": "action",
                                "content": "Micro mode blocked a delegation attempt.",
                            })
                            await websocket.send_json({
                                "type": "action_detail",
                                "content": {
                                    "label": "Micro mode blocked a delegation attempt.",
                                    "tool": "Task",
                                    "state": "blocked",
                                    "run_id": run_id,
                                    "actor": "ceo",
                                    "target": "delegation",
                                    "flow": "blocked",
                                    **runtime_metadata,
                                },
                            })
                            await websocket.send_json({"type": "micro_project_warning", "content": violation_message})
                            _emit_chat_activity(
                                "ceo",
                                "WARNING",
                                "Micro mode blocked specialist delegation.",
                                project_id=project_id,
                                metadata={"tool": "Task", **runtime_metadata},
                            )
                            continue
                        action_label = _format_tool_action(tool_name, tool_input)
                        activity_metadata: dict[str, Any] = {"tool": tool_name, **runtime_metadata}
                        if tool_name == "Bash":
                            activity_metadata["command"] = str(tool_input.get("command", "") or "")[:400]
                        if tool_name in ("Write", "Edit", "NotebookEdit", "Read"):
                            activity_metadata["file_path"] = str(
                                tool_input.get("file_path") or tool_input.get("notebook_path") or ""
                            )[:400]
                        await websocket.send_json({"type": "action", "content": action_label})
                        await websocket.send_json({
                            "type": "action_detail",
                            "content": {
                                "label": action_label,
                                "tool": tool_name,
                                "state": "started",
                                "run_id": run_id,
                                "actor": "ceo",
                                "target": "workspace",
                                "flow": "internal",
                                **activity_metadata,
                            },
                        })
                        is_delegation = False
                        if tool_name == "Task":
                            delegated_agent = str(tool_input.get("subagent_type", "") or "").strip().lower()
                            delegated_task = str(
                                tool_input.get("description") or tool_input.get("prompt") or ""
                            ).strip()
                            if delegated_agent:
                                is_delegation = True
                                pending_delegate_agents.append(delegated_agent)
                                delegation_metadata = {
                                    "source_agent": "ceo",
                                    "target_agent": delegated_agent,
                                    "flow": "down",
                                    "task": delegated_task[:280],
                                    "tool": tool_name,
                                    **runtime_metadata,
                                }
                                _emit_chat_activity(
                                    "ceo",
                                    "DELEGATED",
                                    f"Delegating to {delegated_agent}",
                                    project_id=project_id,
                                    metadata=delegation_metadata,
                                )
                                _emit_chat_activity(
                                    delegated_agent,
                                    "STARTED",
                                    delegated_task[:280] or "Delegated task started",
                                    project_id=project_id,
                                    metadata=delegation_metadata,
                                )
                        # Skip redundant CEO "STARTED" when work was delegated
                        # to avoid the activity stream showing CEO doing everything
                        if not is_delegation:
                            _emit_chat_activity(
                                "ceo",
                                "STARTED",
                                action_label,
                                project_id=project_id,
                                metadata=activity_metadata,
                            )

            elif event_type == "user":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "tool_result":
                        content = block.get("content", "")
                        if isinstance(content, list):
                            content = "\n".join(
                                c.get("text", "") for c in content
                                if isinstance(c, dict) and c.get("type") == "text"
                            )
                        if content and content.strip():
                            preview = content.strip()[:200].replace("\n", " ")
                            delegated_agent = pending_delegate_agents.pop(0) if pending_delegate_agents else ""
                            result_metadata: dict[str, Any] = {}
                            if delegated_agent:
                                result_metadata = {
                                    "source_agent": delegated_agent,
                                    "target_agent": "ceo",
                                    "flow": "up",
                                    **runtime_metadata,
                                }
                            else:
                                result_metadata = dict(runtime_metadata)
                            await websocket.send_json({"type": "action_result", "content": preview})
                            await websocket.send_json({
                                "type": "action_detail",
                                "content": {
                                    "label": preview,
                                    "state": "completed",
                                    "run_id": run_id,
                                    "actor": delegated_agent or "workspace",
                                    "target": "ceo",
                                    "flow": "up" if delegated_agent else "internal",
                                    **result_metadata,
                                },
                            })
                            if delegated_agent:
                                _emit_chat_activity(
                                    delegated_agent,
                                    "COMPLETED",
                                    preview,
                                    project_id=project_id,
                                    metadata=result_metadata,
                                )
                                _emit_chat_activity(
                                    "ceo",
                                    "UPDATED",
                                    f"Received update from {delegated_agent}: {preview}",
                                    project_id=project_id,
                                    metadata=result_metadata,
                                )
                            else:
                                # Only emit generic CEO COMPLETED when no agent
                                # handled the work — avoids duplicating agent events
                                _emit_chat_activity(
                                    "ceo",
                                    "COMPLETED",
                                    preview,
                                    project_id=project_id,
                                    metadata=result_metadata,
                                )

            elif event_type == "result":
                # Final result — use this as the canonical response
                full_response = event.get("result") or "".join(response_parts)
                break

            elif event_type == "error":
                err = event.get("message", "Unknown error")
                await websocket.send_json({"type": "error", "content": err})
                _emit_chat_activity("ceo", "ERROR", str(err), project_id=project_id, metadata=runtime_metadata)
                if run_id:
                    run_service.transition_run(run_id, state="failed", label=str(err))
                return None

        if full_response is None:
            full_response = "".join(response_parts).strip() or None

        try:
            await asyncio.wait_for(process.wait(), timeout=10.0)
        except asyncio.TimeoutError:
            process.kill()

        if not full_response and process.returncode and process.returncode != 0:
            stderr_text = ""
            if process.stderr:
                try:
                    stderr_data = await asyncio.wait_for(process.stderr.read(), timeout=5.0)
                    stderr_text = stderr_data.decode("utf-8", errors="replace").strip()
                except asyncio.TimeoutError:
                    pass
            error_msg = stderr_text[:500] or f"CEO agent exited with code {process.returncode}"
            await websocket.send_json({"type": "error", "content": error_msg})
            _emit_chat_activity("ceo", "ERROR", error_msg, project_id=project_id, metadata=runtime_metadata)
            if run_id:
                run_service.transition_run(run_id, state="failed", label=error_msg)
            return None

        if not full_response:
            full_response = (
                "Execution completed, but Claude returned no assistant summary text. "
                "Please retry this request."
            )
            await websocket.send_json({
                "type": "action_result",
                "content": "Claude returned an empty response. Sending fallback summary.",
            })
            _emit_chat_activity(
                "ceo",
                "WARNING",
                "Claude returned an empty response; fallback summary sent.",
                project_id=project_id,
                metadata=runtime_metadata,
            )

        if micro_project_mode and saw_tool_use:
            await websocket.send_json({
                "type": "micro_project_warning",
                "content": "Micro Project mode detected tool/delegation activity. Disable Micro Project mode for full-crew execution quality.",
            })
            _emit_chat_activity(
                "ceo",
                "WARNING",
                "Micro mode triggered tool activity; consider full crew mode.",
                project_id=project_id,
                metadata=runtime_metadata,
            )

        _emit_chat_activity(
            "ceo",
            "COMPLETED",
            "CEO response generated",
            project_id=project_id,
            metadata={"micro_project_mode": micro_project_mode, "tool_use_detected": saw_tool_use, **runtime_metadata},
        )
        if run_id:
            run_service.transition_run(
                run_id,
                state="done",
                label="CEO response generated",
                metadata={"micro_project_mode": micro_project_mode, "tool_use_detected": saw_tool_use, **runtime_metadata},
            )

        return full_response

    except OSError as exc:
        await websocket.send_json({"type": "error", "content": f"Failed to start CEO agent: {exc}"})
        _emit_chat_activity(
            "ceo",
            "ERROR",
            f"Failed to start CEO agent: {exc}",
            project_id=project_id,
            metadata=runtime_metadata,
        )
        if run_id:
            run_service.transition_run(run_id, state="failed", label=f"Failed to start CEO agent: {exc}")
        return None
    except Exception as exc:
        await websocket.send_json({"type": "error", "content": f"Chat error: {str(exc)[:200]}"})
        _emit_chat_activity(
            "ceo",
            "ERROR",
            f"Chat error: {str(exc)[:200]}",
            project_id=project_id,
            metadata=runtime_metadata,
        )
        if run_id:
            run_service.transition_run(run_id, state="failed", label=f"Chat error: {str(exc)[:200]}")
        return None
    finally:
        if process and process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass


async def _handle_ceo_codex(
    websocket: WebSocket,
    prompt: str,
    llm_cfg: dict,
    ceo_name: str = "CEO",
    project_id: str = "",
    workdir: str = "",
    activity_context: str = "chat",
    run_id: str = "",
    user_message: str = "",
    support_agents: list[str] | None = None,
    micro_project_mode: bool = False,
    config: dict | None = None,
) -> str | None:
    """Handle a CEO chat turn using local Codex CLI JSON streaming output."""
    codex_path = shutil.which("codex")
    if not codex_path:
        message = "Codex CLI not found. Install: npm install -g @openai/codex"
        await websocket.send_json({"type": "error", "content": message})
        _emit_chat_activity("ceo", "ERROR", message, project_id=project_id)
        if run_id:
            run_service.transition_run(run_id, state="failed", label=message)
        return None

    env = os.environ.copy()
    api_key = str(llm_cfg.get("api_key", "") or "").strip()
    if api_key:
        env["OPENAI_API_KEY"] = api_key

    process = None
    run_cwd = os.path.abspath(workdir or PROJECT_ROOT)
    runtime_metadata = {
        "provider": "openai",
        "mode": "codex",
        "runtime": "codex_cli",
        "model": "codex",
    }
    effective_config = config if isinstance(config, dict) else _load_config()
    delegation_plan = (
        _build_synthetic_delegation_plan(
            user_message,
            support_agents or [],
            config=effective_config,
        )
        if not micro_project_mode
        else []
    )

    def _extract_text_fragments(value: Any, *, depth: int = 0) -> list[str]:
        if depth > 4:
            return []
        if value is None:
            return []
        if isinstance(value, str):
            text = value.strip()
            return [text] if text else []
        if isinstance(value, (int, float, bool)):
            return [str(value)]
        if isinstance(value, list):
            out: list[str] = []
            for item in value:
                out.extend(_extract_text_fragments(item, depth=depth + 1))
            return out
        if isinstance(value, dict):
            out: list[str] = []
            for key in (
                "text",
                "delta",
                "message",
                "content",
                "output_text",
                "final",
                "response",
                "description",
                "title",
            ):
                if key in value:
                    out.extend(_extract_text_fragments(value.get(key), depth=depth + 1))
            return out
        return []

    await websocket.send_json({
        "type": "action",
        "content": f"Launching Codex executor in {run_cwd} (auto approvals enabled)…",
    })
    _emit_chat_activity(
        "ceo",
        "STARTED",
        f"Codex executor started ({activity_context})",
        project_id=project_id,
        metadata={"cwd": run_cwd, **runtime_metadata},
    )
    if run_id:
        run_service.transition_run(
            run_id,
            state="executing",
            label=f"Codex executor started ({activity_context})",
            metadata={"cwd": run_cwd, **runtime_metadata},
        )
    try:
        process = await asyncio.create_subprocess_exec(
            codex_path,
            "exec",
            "--json",
            "--full-auto",
            "--sandbox",
            "workspace-write",
            "--skip-git-repo-check",
            prompt,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=1024 * 1024,  # 1 MB – prevents LimitOverrunError on large JSON lines
            env=env,
            cwd=run_cwd,
        )
        if delegation_plan:
            await _emit_synthetic_delegation_start(
                websocket,
                delegation_plan=delegation_plan,
                project_id=project_id,
                runtime_metadata=runtime_metadata,
                run_id=run_id,
            )

        response_parts: list[str] = []
        assert process.stdout is not None
        seen_first_output = False
        idle_ticks = 0

        while True:
            if run_id:
                run_state = run_service.get_run(run_id)
                if run_state and bool(run_state.get("cancel_requested")):
                    await websocket.send_json({"type": "error", "content": "Run cancelled by user."})
                    run_service.transition_run(run_id, state="cancelled", label="Run cancelled by user")
                    return None
                guardrails = run_service.guardrail_status(run_id)
                if guardrails and guardrails.get("over_budget"):
                    violation_message = _guardrail_violation_message(guardrails)
                    await websocket.send_json({"type": "error", "content": violation_message})
                    run_service.transition_run(run_id, state="failed", label=violation_message)
                    return None
            try:
                raw = await asyncio.wait_for(process.stdout.readline(), timeout=30.0)
            except asyncio.TimeoutError:
                idle_ticks += 1
                await websocket.send_json({
                    "type": "thinking",
                    "content": f"{ceo_name} is working… ({idle_ticks * 30}s)",
                })
                _emit_chat_activity(
                    "ceo",
                    "UPDATED",
                    f"Codex executor still running ({idle_ticks * 30}s)",
                    project_id=project_id,
                    metadata=runtime_metadata,
                )
                if process.returncode is not None:
                    break
                continue

            if not raw:
                break
            idle_ticks = 0
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            event_type = event.get("type", "")
            if event_type in (
                "response.output_text.delta",
                "output_text.delta",
                "assistant_message.delta",
                "message.delta",
            ):
                fragments = _extract_text_fragments(event)
                joined = "".join(fragment for fragment in fragments if fragment).strip()
                if joined:
                    if not seen_first_output:
                        seen_first_output = True
                        await websocket.send_json({"type": "action_result", "content": "Execution stream connected"})
                        await websocket.send_json({"type": "action", "content": "Generating response…"})
                        _emit_chat_activity(
                            "ceo",
                            "UPDATED",
                            "Codex execution stream connected",
                            project_id=project_id,
                            metadata=runtime_metadata,
                        )
                    response_parts.append(joined)
                    await websocket.send_json({"type": "chunk", "content": joined})
                continue

            if event_type in (
                "response.output_text.done",
                "assistant_message",
                "message",
                "response.completed",
            ):
                fragments = _extract_text_fragments(event)
                joined = "\n".join(fragment for fragment in fragments if fragment).strip()
                if joined:
                    if not seen_first_output:
                        seen_first_output = True
                        await websocket.send_json({"type": "action_result", "content": "Execution stream connected"})
                        await websocket.send_json({"type": "action", "content": "Generating response…"})
                        _emit_chat_activity(
                            "ceo",
                            "UPDATED",
                            "Codex execution stream connected",
                            project_id=project_id,
                            metadata=runtime_metadata,
                        )
                    response_parts.append(joined)
                    await websocket.send_json({"type": "chunk", "content": joined})
                if event_type == "response.completed":
                    break
                continue

            if event_type in ("item.started", "item.completed"):
                item = event.get("item") or {}
                item_type = item.get("type", "")

                if item_type == "command_execution":
                    command = str(item.get("command", "") or "").strip()
                    command_hint = command or str(item.get("title", "") or item.get("description", "")).strip()
                    if event_type == "item.started":
                        label = f"Running: {command_hint[:180]}" if command_hint else "Running command (details unavailable)"
                        await websocket.send_json({"type": "action", "content": label})
                        await websocket.send_json({
                            "type": "action_detail",
                            "content": {
                                "label": label,
                                "command": command_hint[:400],
                                "cwd": run_cwd,
                                "state": "started",
                                "run_id": run_id,
                                "actor": "ceo",
                                "target": "workspace",
                                "flow": "internal",
                            },
                        })
                        _emit_chat_activity(
                            "ceo",
                            "STARTED",
                            label,
                            project_id=project_id,
                            metadata={"command": command_hint, **runtime_metadata},
                        )
                    else:
                        exit_code = item.get("exit_code")
                        output = str(item.get("aggregated_output", "") or "").strip().replace("\n", " ")
                        output_preview = output[:160] if output else ""
                        result = f"Command exit={exit_code}"
                        if output_preview:
                            result = f"{result}: {output_preview}"
                        await websocket.send_json({"type": "action_result", "content": result})
                        await websocket.send_json({
                            "type": "action_detail",
                            "content": {
                                "label": result,
                                "command": command_hint[:400],
                                "cwd": run_cwd,
                                "duration_ms": item.get("duration_ms"),
                                "exit_code": exit_code,
                                "output_preview": output_preview,
                                "state": "completed",
                                "run_id": run_id,
                                "actor": "workspace",
                                "target": "ceo",
                                "flow": "up",
                            },
                        })
                        _emit_chat_activity(
                            "ceo",
                            "COMPLETED",
                            result,
                            project_id=project_id,
                            metadata={"command": command_hint, "exit_code": exit_code, **runtime_metadata},
                        )
                        if run_id:
                            run_service.record_command(
                                run_id,
                                command=command_hint,
                                cwd=run_cwd,
                                duration_ms=item.get("duration_ms"),
                                exit_code=exit_code if isinstance(exit_code, int) else None,
                                output_preview=output_preview,
                            )
                    continue

                if item_type == "file_change":
                    changed = str(item.get("path") or item.get("file_path") or item.get("description") or "").strip()
                    if event_type == "item.started":
                        label = f"Updating file: {changed[:180]}" if changed else "Updating files"
                        await websocket.send_json({"type": "action", "content": label})
                        await websocket.send_json({
                            "type": "action_detail",
                            "content": {
                                "label": label,
                                "file_path": changed[:400],
                                "state": "started",
                                "run_id": run_id,
                                "actor": "ceo",
                                "target": changed[:160] or "workspace",
                                "flow": "down",
                            },
                        })
                        _emit_chat_activity(
                            "ceo",
                            "STARTED",
                            label,
                            project_id=project_id,
                            metadata={"file_path": changed, **runtime_metadata},
                        )
                    else:
                        result = f"Updated file: {changed[:180]}" if changed else "File update completed"
                        await websocket.send_json({"type": "action_result", "content": result})
                        await websocket.send_json({
                            "type": "action_detail",
                            "content": {
                                "label": result,
                                "file_path": changed[:400],
                                "state": "completed",
                                "run_id": run_id,
                                "actor": "workspace",
                                "target": "ceo",
                                "flow": "up",
                            },
                        })
                        _emit_chat_activity(
                            "ceo",
                            "COMPLETED",
                            result,
                            project_id=project_id,
                            metadata={"file_path": changed, **runtime_metadata},
                        )
                        if run_id and changed:
                            run_service.record_file_touch(run_id, changed)
                        if project_id and changed:
                            project_service.register_artifact(
                                project_id,
                                file_path=changed,
                                action="updated",
                                run_id=run_id,
                                agent="ceo",
                            )
                    continue

                if event_type == "item.started":
                    continue

                if item_type in ("agent_message", "assistant_message", "message", "output_text"):
                    text = "\n".join(_extract_text_fragments(item)).strip()
                    if text:
                        if not seen_first_output:
                            seen_first_output = True
                            await websocket.send_json({"type": "action_result", "content": "Execution stream connected"})
                            await websocket.send_json({"type": "action", "content": "Generating response…"})
                            _emit_chat_activity(
                                "ceo",
                                "UPDATED",
                                "Codex execution stream connected",
                                project_id=project_id,
                                metadata=runtime_metadata,
                            )
                        response_parts.append(text)
                        await websocket.send_json({"type": "chunk", "content": text})
                elif item_type == "reasoning":
                    reason = (item.get("text") or "").strip()
                    if reason:
                        await websocket.send_json({"type": "thinking", "content": reason[:240]})
                else:
                    label = (item.get("title") or item.get("text") or item_type or "Working").strip()
                    if label:
                        preview = label[:240]
                        await websocket.send_json({"type": "action", "content": preview})
                        _emit_chat_activity(
                            "ceo",
                            "STARTED",
                            preview,
                            project_id=project_id,
                            metadata=runtime_metadata,
                        )
            elif event_type == "turn.completed":
                break
            elif event_type == "error":
                message = event.get("message") or event.get("error") or "Unknown Codex error"
                err = _humanize_llm_runtime_error(
                    str(message),
                    provider="openai",
                    mode="codex",
                    base_url="https://api.openai.com/v1",
                )
                await websocket.send_json({"type": "error", "content": err})
                _emit_chat_activity("ceo", "ERROR", err, project_id=project_id, metadata=runtime_metadata)
                return None

        try:
            await asyncio.wait_for(process.wait(), timeout=10.0)
        except asyncio.TimeoutError:
            process.kill()

        full_response = "\n\n".join(part for part in response_parts if part).strip()
        if not full_response and process.returncode and process.returncode != 0:
            stderr_text = ""
            if process.stderr:
                try:
                    stderr_data = await asyncio.wait_for(process.stderr.read(), timeout=5.0)
                    stderr_text = stderr_data.decode("utf-8", errors="replace").strip()
                except asyncio.TimeoutError:
                    pass
            error_message = _humanize_llm_runtime_error(
                stderr_text[:500] or f"Codex exited with code {process.returncode}",
                provider="openai",
                mode="codex",
                base_url="https://api.openai.com/v1",
            )
            await websocket.send_json({
                "type": "error",
                "content": error_message,
            })
            _emit_chat_activity(
                "ceo",
                "ERROR",
                error_message,
                project_id=project_id,
                metadata=runtime_metadata,
            )
            if run_id:
                run_service.transition_run(
                    run_id,
                    state="failed",
                    label=error_message,
                )
            return None

        final_response = full_response or None
        if not final_response:
            fallback_note = "Execution completed, but no assistant summary text was returned by Codex."
            changed_files: list[str] = []
            if project_id and run_id:
                try:
                    metadata = project_service.get_metadata(project_id)
                    artifacts = metadata.get("artifacts", [])
                    if isinstance(artifacts, list):
                        changed_files = [
                            str(a.get("file_path", "") or "")
                            for a in artifacts
                            if isinstance(a, dict) and str(a.get("run_id", "") or "") == run_id and a.get("file_path")
                        ]
                except Exception:
                    changed_files = []
            if changed_files:
                preview = "\n".join(f"- {path}" for path in changed_files[-12:])
                final_response = f"{fallback_note}\n\nChanged files:\n{preview}"
            else:
                final_response = f"{fallback_note}\n\nWorkspace: {run_cwd}"
        if final_response:
            if delegation_plan:
                await _emit_synthetic_delegation_completion(
                    websocket,
                    delegation_plan=delegation_plan,
                    project_id=project_id,
                    runtime_metadata=runtime_metadata,
                    run_id=run_id,
                )
            if project_id:
                try:
                    metadata = project_service.get_metadata(project_id)
                    artifacts = metadata.get("artifacts", [])
                    if isinstance(artifacts, list):
                        changed = [
                            str(a.get("file_path", "") or "")
                            for a in artifacts
                            if isinstance(a, dict) and str(a.get("run_id", "") or "") == run_id and a.get("file_path")
                        ]
                        if changed and bool(_load_config().get("feature_flags", {}).get("diff_summary", True)):
                            lines = "\n".join(f"- {path}" for path in changed[-12:])
                            final_response = f"{final_response}\n\nFast diff summary:\n{lines}"
                except Exception:
                    pass
            _emit_chat_activity(
                "ceo",
                "COMPLETED",
                f"Codex execution completed ({activity_context})",
                project_id=project_id,
                metadata={"cwd": run_cwd, **runtime_metadata},
            )
            if run_id:
                run_service.transition_run(
                    run_id,
                    state="done",
                    label=f"Codex execution completed ({activity_context})",
                    metadata={"cwd": run_cwd, **runtime_metadata},
                )
        return final_response
    except OSError as exc:
        message = f"Failed to start Codex CLI: {exc}"
        await websocket.send_json({"type": "error", "content": message})
        _emit_chat_activity("ceo", "ERROR", message, project_id=project_id, metadata=runtime_metadata)
        if run_id:
            run_service.transition_run(run_id, state="failed", label=message)
        return None
    except Exception as exc:
        message = _humanize_llm_runtime_error(
            str(exc)[:300],
            provider="openai",
            mode="codex",
            base_url="https://api.openai.com/v1",
        )
        await websocket.send_json({"type": "error", "content": message})
        _emit_chat_activity("ceo", "ERROR", message, project_id=project_id, metadata=runtime_metadata)
        if run_id:
            run_service.transition_run(run_id, state="failed", label=message)
        return None
    finally:
        if process and process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass


async def _handle_ceo_openai(
    websocket: WebSocket,
    prompt: str,
    llm_cfg: dict,
    ceo_name: str,
    *,
    user_message: str = "",
    project: dict | None = None,
    project_id: str = "",
    run_id: str = "",
    support_agents: list[str] | None = None,
    micro_project_mode: bool = False,
    intent: dict[str, Any] | None = None,
    user_name: str = "User",
    config: dict | None = None,
) -> str | None:
    """Handle a CEO chat turn using an OpenAI-compatible streaming API.

    Works with the real OpenAI API (provider="openai") and any local
    OpenAI-compatible server such as Ollama or LM Studio (provider="openai_compat").

    Returns the full response string, or None if an error was sent.
    """
    from src.llm_provider import stream_openai_compat

    base_url = llm_cfg.get("base_url", "https://api.openai.com/v1")
    model = llm_cfg.get("model", "gpt-4o")
    api_key = llm_cfg.get("api_key", "")
    system_prompt = llm_cfg.get("system_prompt") or None
    runtime_metadata = {
        "provider": str(llm_cfg.get("provider", "openai") or "openai"),
        "mode": "apikey",
        "runtime": "openai_compat_api",
        "model": str(model or ""),
        "base_url": str(base_url or ""),
    }

    response_parts: list[str] = []
    first_token = True
    stream_warning: str | None = None
    should_bridge_execution = _should_trigger_execution_bridge(
        user_message,
        project_id,
        intent=intent,
        project=project,
        micro_project_mode=micro_project_mode,
    )

    def _stream_timeout_seconds(env_name: str, default_value: float) -> float:
        raw = str(os.getenv(env_name, "") or "").strip()
        if not raw:
            return default_value
        try:
            parsed = float(raw)
        except ValueError:
            return default_value
        return parsed if parsed > 0 else default_value

    first_token_timeout_s = _stream_timeout_seconds("COMPAAS_STREAM_FIRST_TOKEN_TIMEOUT_S", 25.0)
    inter_token_timeout_s = _stream_timeout_seconds("COMPAAS_STREAM_INTER_TOKEN_TIMEOUT_S", 20.0)

    # Show an action entry immediately so the ActionLog appears while connecting
    await websocket.send_json({"type": "action", "content": f"Connecting to {model}…"})
    _emit_chat_activity(
        "ceo",
        "STARTED",
        f"Connecting to {model} via OpenAI-compatible API",
        project_id=project_id,
        metadata=runtime_metadata,
    )
    if run_id:
        run_service.transition_run(
            run_id,
            state="executing",
            label=f"Connecting to {model} via OpenAI-compatible API",
            metadata=runtime_metadata,
        )

    # Background task: send periodic "thinking" pings while we wait for tokens
    thinking_event = asyncio.Event()
    stream_iter = None

    async def _thinking_pings() -> None:
        count = 0
        while not thinking_event.is_set():
            await asyncio.sleep(5)
            if thinking_event.is_set():
                break
            count += 1
            try:
                await websocket.send_json({
                    "type": "thinking",
                    "content": f"{ceo_name} is thinking… ({count * 5}s elapsed)",
                })
                _emit_chat_activity(
                    "ceo",
                    "UPDATED",
                    f"Streaming model still thinking ({count * 5}s)",
                    project_id=project_id,
                    metadata=runtime_metadata,
                )
            except Exception:
                break

    ping_task = asyncio.create_task(_thinking_pings())
    try:
        stream_iter = stream_openai_compat(
            prompt=prompt,
            base_url=base_url,
            model=model,
            api_key=api_key,
            system_prompt=system_prompt,
        )
        while True:
            if run_id:
                run_state = run_service.get_run(run_id)
                if run_state and bool(run_state.get("cancel_requested")):
                    await websocket.send_json({"type": "error", "content": "Run cancelled by user."})
                    run_service.transition_run(run_id, state="cancelled", label="Run cancelled by user")
                    return None
                guardrails = run_service.guardrail_status(run_id)
                if guardrails and guardrails.get("over_budget"):
                    violation_message = _guardrail_violation_message(guardrails)
                    await websocket.send_json({"type": "error", "content": violation_message})
                    run_service.transition_run(run_id, state="failed", label=violation_message)
                    return None
            try:
                timeout_s = first_token_timeout_s if first_token else inter_token_timeout_s
                chunk = await asyncio.wait_for(anext(stream_iter), timeout=timeout_s)
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError:
                if first_token:
                    stream_warning = (
                        f"{model} did not return tokens within {int(first_token_timeout_s)}s."
                    )
                else:
                    stream_warning = (
                        f"{model} stream paused for over {int(inter_token_timeout_s)}s."
                    )
                if should_bridge_execution:
                    await websocket.send_json({
                        "type": "action_result",
                        "content": "Model stream timed out; continuing with direct workspace execution.",
                    })
                    _emit_chat_activity(
                        "ceo",
                        "WARNING",
                        f"Model stream timeout; continuing via execution bridge ({stream_warning})",
                        project_id=project_id,
                        metadata=runtime_metadata,
                    )
                    break
                await websocket.send_json({
                    "type": "error",
                    "content": f"LLM timeout: {stream_warning}",
                })
                _emit_chat_activity(
                    "ceo",
                    "ERROR",
                    f"LLM timeout: {stream_warning}",
                    project_id=project_id,
                    metadata=runtime_metadata,
                )
                if run_id:
                    run_service.transition_run(run_id, state="failed", label=f"LLM timeout: {stream_warning}")
                return None

            if first_token:
                first_token = False
                thinking_event.set()  # stop pings
                await websocket.send_json({"type": "action_result", "content": "Connected"})
                await websocket.send_json({"type": "action", "content": "Generating response…"})
                _emit_chat_activity(
                    "ceo",
                    "UPDATED",
                    "Model stream connected",
                    project_id=project_id,
                    metadata=runtime_metadata,
                )
            response_parts.append(chunk)
            await websocket.send_json({"type": "chunk", "content": chunk})
    except RuntimeError as exc:
        # openai package not installed
        if should_bridge_execution:
            stream_warning = str(exc)
            await websocket.send_json({
                "type": "action_result",
                "content": "Model runtime unavailable; continuing with direct workspace execution.",
            })
            _emit_chat_activity(
                "ceo",
                "WARNING",
                f"Model runtime unavailable; continuing via execution bridge ({stream_warning})",
                project_id=project_id,
                metadata=runtime_metadata,
            )
        else:
            await websocket.send_json({"type": "error", "content": str(exc)})
            _emit_chat_activity("ceo", "ERROR", str(exc), project_id=project_id, metadata=runtime_metadata)
            if run_id:
                run_service.transition_run(run_id, state="failed", label=str(exc))
            return None
    except Exception as exc:
        stream_warning = str(exc)[:300]
        if should_bridge_execution:
            await websocket.send_json({
                "type": "action_result",
                "content": "Model stream failed; continuing with direct workspace execution.",
            })
            _emit_chat_activity(
                "ceo",
                "WARNING",
                f"Model stream failed; continuing via execution bridge ({stream_warning})",
                project_id=project_id,
                metadata=runtime_metadata,
            )
        else:
            provider_name = str(llm_cfg.get("provider", "openai") or "openai")
            friendly_error = _humanize_llm_runtime_error(
                stream_warning,
                provider=provider_name,
                mode="apikey",
                base_url=str(base_url or ""),
            )
            await websocket.send_json({"type": "error", "content": friendly_error})
            _emit_chat_activity(
                "ceo",
                "ERROR",
                friendly_error,
                project_id=project_id,
                metadata=runtime_metadata,
            )
            if run_id:
                run_service.transition_run(run_id, state="failed", label=friendly_error)
            return None
    finally:
        thinking_event.set()
        if stream_iter is not None:
            aclose = getattr(stream_iter, "aclose", None)
            if callable(aclose):
                try:
                    await aclose()
                except Exception:
                    pass
        ping_task.cancel()
        try:
            await ping_task
        except asyncio.CancelledError:
            pass

    reasoning_response = "".join(response_parts).strip()
    final_response = reasoning_response

    # OpenAI/Ollama text-only providers cannot execute tools directly.
    # Bridge implementation tasks through Codex when execution intent is detected.
    if should_bridge_execution:
        workspace_path = ""
        project_name = project_id
        if project:
            workspace_path = str(project.get("workspace_path", "") or "").strip()
            project_name = str(project.get("name", project_id) or project_id)
        if not workspace_path:
            workspace_path = os.path.join(WORKSPACE_ROOT, f"project-{project_id}")
            os.makedirs(workspace_path, exist_ok=True)

        await websocket.send_json({
            "type": "action",
            "content": f"Executing implementation tasks in {workspace_path}…",
        })
        _emit_chat_activity(
            "ceo",
            "STARTED",
            "Execution bridge activated for implementation request",
            project_id=project_id,
            metadata={"workspace_path": workspace_path, **runtime_metadata},
        )

        bridge_prompt = _build_execution_bridge_prompt(
            user_message=user_message,
            model_response=reasoning_response or "(empty model summary)",
            project_name=project_name,
            project_id=project_id,
            workspace_path=workspace_path,
            user_name=user_name,
        )
        bridge_response = await _handle_ceo_codex(
            websocket=websocket,
            prompt=bridge_prompt,
            llm_cfg=llm_cfg,
            ceo_name=ceo_name,
            project_id=project_id,
            workdir=workspace_path,
            activity_context="execution_bridge",
            run_id=run_id,
            user_message=user_message,
            support_agents=support_agents,
            micro_project_mode=micro_project_mode,
            config=config,
        )
        if bridge_response:
            if final_response:
                final_response = (
                    f"{final_response}\n\n"
                    f"Implementation update:\n{bridge_response}"
                )
            else:
                final_response = bridge_response

    _emit_chat_activity(
        "ceo",
        "COMPLETED",
        "OpenAI-compatible response completed",
        project_id=project_id,
        metadata={
            **runtime_metadata,
            "execution_bridge": should_bridge_execution,
            "stream_warning": stream_warning or "",
        },
    )
    if run_id:
        run_service.transition_run(
            run_id,
            state="done",
            label="OpenAI-compatible response completed",
            metadata={
                **runtime_metadata,
                "execution_bridge": should_bridge_execution,
                "stream_warning": stream_warning or "",
            },
        )
    if not final_response:
        fallback = "Execution completed, but the provider returned no assistant text."
        if stream_warning:
            fallback = f"{fallback} Stream warning: {stream_warning}"
        await websocket.send_json({
            "type": "action_result",
            "content": "Provider returned an empty response. Sending fallback summary.",
        })
        _emit_chat_activity(
            "ceo",
            "WARNING",
            "Provider returned an empty response; fallback summary sent.",
            project_id=project_id,
            metadata=runtime_metadata,
        )
        final_response = fallback
    return final_response


@app.websocket("/api/chat/ws")
async def chat_websocket(websocket: WebSocket) -> None:
    """WebSocket endpoint for real-time CEO chat."""
    await websocket.accept()
    inflight_run_id = ""
    inflight_project_id = ""

    def _close_inflight_run(reason: str, *, metadata: dict[str, Any] | None = None) -> None:
        nonlocal inflight_run_id, inflight_project_id
        if not inflight_run_id:
            return
        run_state = run_service.get_run(inflight_run_id)
        status = str((run_state or {}).get("status", "") or "")
        if status in {"queued", "planning", "executing", "verifying"}:
            run_service.transition_run(
                inflight_run_id,
                state="failed",
                label=reason,
                metadata=metadata or {},
            )
            _emit_chat_activity(
                "ceo",
                "WARNING",
                reason,
                project_id=inflight_project_id,
                metadata=metadata or {},
            )
        inflight_run_id = ""
        inflight_project_id = ""

    config = _load_config()
    llm_cfg = config.get("llm", {})
    provider = llm_cfg.get("provider", "anthropic")
    openai_mode = str(llm_cfg.get("openai_mode", "apikey") or "apikey").lower()

    # Validate configured runtime binaries early for cleaner UX.
    if provider == "anthropic":
        if not shutil.which("claude"):
            await websocket.send_json({
                "type": "error",
                "content": "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code",
            })
            await websocket.close()
            return
    elif provider == "openai" and openai_mode == "codex":
        if not shutil.which("codex"):
            await websocket.send_json({
                "type": "error",
                "content": "Codex CLI not found. Install: npm install -g @openai/codex",
            })
            await websocket.close()
            return

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "content": "Invalid JSON."})
                continue

            user_message = (data.get("message") or "").strip()
            if not user_message:
                await websocket.send_json({"type": "error", "content": "Empty message."})
                continue
            lower_message = user_message.lower()
            injection_markers = (
                "ignore previous instructions",
                "disregard all prior",
                "reveal api key",
                "print secrets",
                "exfiltrate",
                "system prompt",
            )
            if any(marker in lower_message for marker in injection_markers):
                await websocket.send_json({
                    "type": "warning",
                    "content": "Potential prompt-injection pattern detected. Continuing with guarded execution.",
                })
                _emit_chat_activity(
                    "ceo",
                    "WARNING",
                    "Prompt-injection marker detected in user input.",
                    project_id=_normalize_project_id(str(data.get("project_id", "") or "")),
                )
            micro_project_mode = bool(data.get("micro_project_mode", False))
            micro_project_override = bool(data.get("micro_project_override", False))
            no_delegation_mode = bool(data.get("no_delegation_mode", False))

            # Reload config each turn so Settings changes take effect live.
            config = _load_config()
            llm_cfg = config.get("llm", {})
            provider = llm_cfg.get("provider", "anthropic")
            openai_mode = str(llm_cfg.get("openai_mode", "apikey") or "apikey").lower()
            user_name = config.get("user", {}).get("name", "User") or "User"
            ceo_name = config.get("agents", {}).get("ceo", "CEO") or "CEO"
            company_name = config.get("company", {}).get("name", "") if isinstance(config.get("company"), dict) else ""

            incoming_project_id = _normalize_project_id(str(data.get("project_id", "") or ""))
            active_project_id, active_project, created_project = _resolve_chat_project(
                incoming_project_id,
                user_message,
                user_name,
            )
            intent = _classify_execution_intent(user_message)
            intent_class = str(intent.get("class", "clarification") or "clarification")
            planning_approved_flag = bool(data.get("planning_approved", False))
            if micro_project_mode:
                no_delegation_mode = True
            if intent_class in {"greeting", "status"}:
                no_delegation_mode = True
            support_agents = [] if micro_project_mode else _infer_support_agents(user_message, intent=intent)
            is_execution_turn = str(intent.get("intent", "")) == "execution" and bool(intent.get("actionable"))
            if active_project_id and is_execution_turn and (
                not bool(intent.get("needs_planning"))
                or planning_approved_flag
                or bool((active_project or {}).get("plan_approved"))
            ):
                _seed_project_execution_scaffold(
                    active_project_id,
                    user_message,
                    support_agents=support_agents,
                    user_name=user_name,
                    ceo_name=ceo_name,
                    config=config,
                )
                active_project = state_manager.get_project(active_project_id) or active_project
            plan_packet_status: dict[str, Any] = {"ready": False, "missing_items": [], "summary": ""}
            if active_project_id:
                try:
                    plan_packet_status = project_service.plan_packet_status(active_project_id)
                except ValueError:
                    plan_packet_status = {"ready": False, "missing_items": ["Project not found."], "summary": ""}
            # Auto-select sandbox profile based on intent complexity.
            # Frontend can override by sending an explicit sandbox_profile value.
            _raw_profile = data.get("sandbox_profile")
            if _raw_profile:
                sandbox_profile = str(_raw_profile).strip().lower()
            elif intent.get("needs_planning") and intent.get("delegate_allowed"):
                sandbox_profile = "full"  # 1800s — complex multi-agent work
            elif intent_class in ("greeting", "status"):
                sandbox_profile = "safe"  # 300s — quick responses
            else:
                sandbox_profile = "standard"  # 900s — default
            idempotency_key = str(data.get("idempotency_key", "") or "").strip()
            run_mode = "micro_project" if micro_project_mode else "full_crew"
            try:
                run_record, _ = run_service.create_run(
                    project_id=active_project_id,
                    message=user_message,
                    provider=provider,
                    sandbox_profile=sandbox_profile,
                    idempotency_key=idempotency_key,
                    mode=run_mode,
                    metadata={"intent": intent, "intent_class": intent_class, "support_agents": support_agents},
                )
            except RuntimeError as exc:
                await websocket.send_json({"type": "error", "content": str(exc)})
                await websocket.send_json({"type": "done", "content": "", "project_id": active_project_id})
                continue
            run_id = str(run_record.get("id", "") or "")
            inflight_run_id = run_id
            inflight_project_id = active_project_id
            run_service.transition_run(
                run_id,
                state="planning",
                label="Turn accepted and queued for planning",
                metadata={"intent": intent, "intent_class": intent_class, "sandbox_profile": sandbox_profile},
            )
            await websocket.send_json({
                "type": "run",
                "content": {
                    "id": run_id,
                    "status": run_record.get("status", "queued"),
                    "mode": run_mode,
                    "intent": intent,
                    "intent_class": intent_class,
                    "sandbox_profile": sandbox_profile,
                    "support_agents": support_agents,
                },
            })

            # Store user message with project scope.
            async with _chat_lock:
                user_msg = _append_chat_message("user", user_message, project_id=active_project_id)
            await websocket.send_json({"type": "user_ack", "message": user_msg, "project_id": active_project_id})
            _emit_chat_activity(
                "chairman",
                "MESSAGE",
                user_message[:260],
                project_id=active_project_id,
            )
            if active_project:
                await websocket.send_json({
                    "type": "project_context",
                    "project_id": active_project_id,
                    "created": created_project,
                    "project": active_project,
                    "plan_packet": plan_packet_status,
                })

            prompt = _build_context_prompt(
                user_message,
                user_name=user_name,
                ceo_name=ceo_name,
                company_name=company_name,
                project_id=active_project_id,
            )
            if no_delegation_mode:
                prompt = (
                    "[NO-DELEGATION GUARANTEE: Enabled by chairman. "
                    "Do not delegate to any specialist agent. Execute directly and keep scope minimal.]\n\n"
                    + prompt
                )
            feature_flags = config.get("feature_flags", {})
            effective_llm_cfg = dict(llm_cfg)
            routing_models = config.get("routing_models", {}) if isinstance(config.get("routing_models"), dict) else {}
            if feature_flags.get("execution_intent_classifier", True):
                intent_name = str(intent.get("intent", "qa") or "qa")
                route_key = "coding" if intent_name == "execution" else intent_name
                routed_model = str(routing_models.get(route_key, "") or routing_models.get("default", "")).strip()
                if routed_model:
                    effective_llm_cfg["model"] = _resolve_routed_model_for_runtime(
                        provider=provider,
                        openai_mode=openai_mode,
                        configured_model=str(llm_cfg.get("model", "") or ""),
                        routed_model=routed_model,
                    )
            if provider == "openai" and openai_mode == "codex":
                # Codex runtime is fixed regardless of intent routing settings.
                effective_llm_cfg["model"] = "codex"
            planning_gate_enabled = bool(feature_flags.get("planning_approval_gate", True))
            planning_approved = planning_approved_flag
            if (
                planning_gate_enabled
                and bool(intent.get("needs_planning"))
                and active_project_id
                and not planning_approved
                and not bool((active_project or {}).get("plan_approved"))
            ):
                if not bool(plan_packet_status.get("ready")):
                    plan_packet_status = _generate_planning_packet(
                        active_project_id,
                        user_message=user_message,
                        user_name=user_name,
                        ceo_name=ceo_name,
                    )
                    active_project = state_manager.get_project(active_project_id) or active_project
                    await websocket.send_json({
                        "type": "action_result",
                        "content": "Planning packet prepared with meeting summary, execution plan, and activation guide.",
                    })
                    _emit_chat_activity(
                        "ceo",
                        "UPDATED",
                        "Planning packet prepared and ready for Chairman approval.",
                        project_id=active_project_id,
                        metadata={"intent": intent, "plan_packet": plan_packet_status},
                    )
                run_service.transition_run(
                    run_id,
                    state="planning",
                    label="Planning approval required before execution",
                    metadata={"intent": intent, "plan_packet": plan_packet_status},
                )
                await websocket.send_json({
                    "type": "planning_approval_required",
                    "content": {
                        "reason": str(plan_packet_status.get("summary", "") or "Planning packet is ready for approval."),
                        "intent": intent,
                        "run_id": run_id,
                        "plan_packet": plan_packet_status,
                    },
                })
                await websocket.send_json({
                    "type": "done",
                    "content": "",
                    "project_id": active_project_id,
                    "run_id": run_id,
                    "intent_class": intent_class,
                    "planning_packet_status": plan_packet_status,
                })
                inflight_run_id = ""
                inflight_project_id = ""
                continue
            if micro_project_mode:
                complexity_reason = _micro_project_complexity_reason(user_message)
                if complexity_reason and not micro_project_override:
                    run_service.transition_run(
                        run_id,
                        state="cancelled",
                        label="Micro project complexity warning blocked execution",
                        metadata={"reason": complexity_reason},
                    )
                    await websocket.send_json({"type": "micro_project_warning", "content": complexity_reason})
                    await websocket.send_json({"type": "done", "content": "", "project_id": active_project_id, "run_id": run_id})
                    inflight_run_id = ""
                    inflight_project_id = ""
                    continue
                if complexity_reason and micro_project_override:
                    await websocket.send_json({
                        "type": "thinking",
                        "content": "Micro Project override accepted. Continuing with a fast solo response.",
                    })
                prompt = _build_micro_project_prompt(prompt, user_name=user_name, ceo_name=ceo_name)

            lightweight_response = _lightweight_ceo_response(
                intent=intent,
                user_name=user_name,
                ceo_name=ceo_name,
                project=active_project,
            )
            if lightweight_response and no_delegation_mode:
                full_response = lightweight_response
                run_service.transition_run(
                    run_id,
                    state="done",
                    label="Lightweight conversational response generated",
                    metadata={"intent": intent, "intent_class": intent_class},
                )
                _emit_chat_activity(
                    "ceo",
                    "COMPLETED",
                    "Lightweight conversational response generated",
                    project_id=active_project_id,
                    metadata={"intent": intent, "intent_class": intent_class},
                )
            elif provider == "openai" and openai_mode == "codex":
                project_workdir = str((active_project or {}).get("workspace_path", "") or "").strip()
                full_response = await _handle_ceo_codex(
                    websocket,
                    prompt,
                    effective_llm_cfg,
                    ceo_name=ceo_name,
                    project_id=active_project_id,
                    workdir=project_workdir,
                    activity_context="direct_codex",
                    run_id=run_id,
                    user_message=user_message,
                    support_agents=support_agents,
                    micro_project_mode=micro_project_mode,
                    config=config,
                )
            elif provider in ("openai", "openai_compat"):
                full_response = await _handle_ceo_openai(
                    websocket,
                    prompt,
                    effective_llm_cfg,
                    ceo_name,
                    user_message=user_message,
                    project=active_project,
                    project_id=active_project_id,
                    run_id=run_id,
                    support_agents=support_agents,
                    micro_project_mode=micro_project_mode,
                    intent=intent,
                    user_name=user_name,
                    config=config,
                )
            else:
                claude_path = shutil.which("claude")
                if not claude_path:
                    run_service.transition_run(
                        run_id,
                        state="failed",
                        label="Claude CLI not found",
                    )
                    await websocket.send_json({
                        "type": "error",
                        "content": "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code",
                    })
                    await websocket.send_json({
                        "type": "done",
                        "content": "",
                        "project_id": active_project_id,
                        "run_id": run_id,
                    })
                    inflight_run_id = ""
                    inflight_project_id = ""
                    continue
                full_response = await _handle_ceo_claude(
                    websocket,
                    prompt,
                    claude_path,
                    effective_llm_cfg,
                    ceo_name=ceo_name,
                    micro_project_mode=micro_project_mode,
                    project_id=active_project_id,
                    run_id=run_id,
                )

            full_response = _apply_agent_name_overrides(full_response or "", config) or None
            full_response = _sanitize_ceo_response(
                full_response or "",
                ceo_name=ceo_name,
                user_name=user_name,
            ) or None

            if full_response:
                async with _chat_lock:
                    _append_chat_message("ceo", full_response, project_id=active_project_id)
                    chat_policy = config.get("chat_policy", {}) if isinstance(config.get("chat_policy"), dict) else {}
                    auto_summary_n = int(chat_policy.get("auto_summary_every_messages", runtime_settings.chat_auto_summary_interval) or runtime_settings.chat_auto_summary_interval)
                    auto_summarized = _auto_summarize_chat_scope(active_project_id, auto_summary_n)
                    if auto_summarized:
                        await websocket.send_json({
                            "type": "action_result",
                            "content": f"Auto-summary checkpoint created for project context (every {auto_summary_n} messages).",
                        })
                run_state = run_service.get_run(run_id)
                if run_state and str(run_state.get("status", "")) in {"queued", "planning", "executing", "verifying"}:
                    run_service.transition_run(run_id, state="done", label="Chat response completed")
            else:
                run_state = run_service.get_run(run_id)
                if run_state and str(run_state.get("status", "")) in {"queued", "planning", "executing", "verifying"}:
                    run_service.transition_run(run_id, state="failed", label="Provider returned no response")
            structured_enabled = bool(feature_flags.get("structured_ceo_response", True) or data.get("structured_response"))
            if active_project_id:
                try:
                    plan_packet_status = project_service.plan_packet_status(active_project_id)
                except ValueError:
                    plan_packet_status = {"ready": False, "missing_items": ["Project metadata unavailable."], "summary": ""}
            deploy_offer: dict[str, Any] | None = None
            if (
                active_project_id
                and full_response
                and bool(feature_flags.get("vercel_deploy_lifecycle", True))
                and _should_offer_vercel_deploy(
                    user_message=user_message,
                    final_response=full_response,
                    intent=intent,
                    config=config,
                )
            ):
                integrations_cfg = config.get("integrations", {}) if isinstance(config.get("integrations"), dict) else {}
                default_target = str(integrations_cfg.get("vercel_default_target", "preview") or "preview").strip().lower()
                if default_target not in {"preview", "production"}:
                    default_target = "preview"
                deploy_offer = {
                    "project_id": active_project_id,
                    "target": default_target,
                    "project_name": str((active_project or {}).get("name", "") or ""),
                }
                await websocket.send_json({
                    "type": "action_result",
                    "content": "Build work looks complete. I can deploy this project to Vercel now if you approve.",
                })
            done_payload: dict[str, Any] = {
                "type": "done",
                "content": full_response or "",
                "project_id": active_project_id,
                "run_id": run_id,
                "intent_class": intent_class,
                "planning_packet_status": plan_packet_status,
            }
            if structured_enabled:
                done_payload["structured"] = _structured_response_payload(full_response or "")
            if deploy_offer:
                done_payload["deploy_offer"] = deploy_offer
            await websocket.send_json(done_payload)
            inflight_run_id = ""
            inflight_project_id = ""

    except WebSocketDisconnect:
        _close_inflight_run(
            "Client disconnected before run completion",
            metadata={"reason": "websocket_disconnected"},
        )
    except Exception as exc:
        _close_inflight_run(
            f"Chat websocket error: {str(exc)[:180]}",
            metadata={"reason": "websocket_exception"},
        )
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# CEO Memory
# ---------------------------------------------------------------------------


@app.get("/api/memory", summary="Get CEO persistent memories")
def get_memory() -> dict:
    """Return all stored CEO memories as a list of entries."""
    if not os.path.exists(MEMORY_PATH):
        return {"entries": [], "raw": ""}
    with open(MEMORY_PATH) as f:
        raw = f.read()
    entries = [line[2:].strip() for line in raw.splitlines() if line.startswith("- ")]
    return {"entries": entries, "raw": raw}


@app.post("/api/memory", summary="Add a CEO memory entry")
def add_memory(body: dict) -> dict:
    """Append a new memory entry (bullet point) to the CEO memory file."""
    entry = (body.get("entry") or "").strip()
    if not entry:
        raise HTTPException(status_code=400, detail="entry required")
    os.makedirs(DATA_DIR, exist_ok=True)
    existing = ""
    if os.path.exists(MEMORY_PATH):
        with open(MEMORY_PATH) as f:
            existing = f.read()
    if entry in existing:
        return {"status": "already_exists"}
    with open(MEMORY_PATH, "a") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        f.write(f"- {entry}\n")
    return {"status": "added"}


@app.delete("/api/memory", summary="Clear all CEO memories")
def clear_memory() -> dict:
    """Delete the CEO memory file."""
    if os.path.exists(MEMORY_PATH):
        os.remove(MEMORY_PATH)
    return {"status": "cleared"}


# ---------------------------------------------------------------------------
# Context auto-summary
# ---------------------------------------------------------------------------


@app.post("/api/chat/summarize", summary="Compress chat history to a summary")
async def summarize_chat() -> dict:
    """Summarise the last 30 messages into a system note and truncate history."""
    messages = await asyncio.to_thread(_load_chat_messages)
    if len(messages) < 6:
        return {"status": "too_short", "messages_kept": len(messages)}

    history_text = "\n".join(
        f"{'Chairman' if m['role'] == 'user' else 'CEO'}: {m['content'][:300]}"
        for m in messages[-30:]
    )
    summary_note = (
        f"[AUTO-SUMMARY at {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}] "
        f"Earlier conversation covered:\n{history_text[:800]}"
    )
    summary_msg: dict = {
        "role": "system",
        "content": summary_note,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    compressed = [summary_msg] + messages[-5:]
    await asyncio.to_thread(_save_chat_messages, compressed)
    return {"status": "ok", "messages_kept": len(compressed)}


# ---------------------------------------------------------------------------
# Integration: GitHub inbound webhook
# ---------------------------------------------------------------------------


@app.post("/api/integrations/telegram/send", summary="Send a mirrored chat message to Telegram")
def telegram_send_message(body: dict[str, Any]) -> dict[str, Any]:
    """Send a plain-text message to a Telegram bot chat."""
    token = str(body.get("token", "") or "").strip()
    chat_id = str(body.get("chat_id", "") or "").strip()
    text = str(body.get("text", "") or "").strip()
    if not token or not chat_id or not text:
        raise HTTPException(status_code=400, detail="token, chat_id, and text are required.")

    payload = {
        "chat_id": chat_id,
        "text": text[:4096],
        "disable_web_page_preview": True,
    }
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body_text = resp.read().decode("utf-8", errors="replace")
            parsed = json.loads(body_text) if body_text else {}
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=502, detail=f"Telegram HTTP error: {body_text[:220]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Telegram send failed: {str(exc)[:220]}") from exc

    if not bool(parsed.get("ok")):
        detail = parsed.get("description") or parsed
        raise HTTPException(status_code=502, detail=f"Telegram rejected request: {str(detail)[:220]}")
    return {"status": "ok"}


# Track last seen Telegram update_id to avoid duplicate messages
_telegram_last_update_id: int = 0


@app.post("/api/integrations/telegram/poll", summary="Poll for new Telegram messages")
def telegram_poll_messages(body: dict[str, Any]) -> dict[str, Any]:
    """Poll the Telegram Bot API for new messages from the user.

    The frontend sends the bot token so the backend can call getUpdates.
    Returns a list of new text messages since the last poll.
    """
    global _telegram_last_update_id
    token = str(body.get("token", "") or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="token is required.")

    params: dict[str, Any] = {
        "timeout": 0,
        "allowed_updates": json.dumps(["message"]),
    }
    if _telegram_last_update_id:
        params["offset"] = _telegram_last_update_id + 1

    qs = urllib.parse.urlencode(params)
    url = f"https://api.telegram.org/bot{token}/getUpdates?{qs}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body_text = resp.read().decode("utf-8", errors="replace")
            parsed = json.loads(body_text) if body_text else {}
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=502, detail=f"Telegram HTTP error: {body_text[:220]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Telegram poll failed: {str(exc)[:220]}") from exc

    if not bool(parsed.get("ok")):
        detail = parsed.get("description") or parsed
        raise HTTPException(status_code=502, detail=f"Telegram rejected request: {str(detail)[:220]}")

    results = parsed.get("result", [])
    messages: list[dict[str, Any]] = []
    for update in results:
        uid = update.get("update_id", 0)
        if uid > _telegram_last_update_id:
            _telegram_last_update_id = uid
        msg = update.get("message") or {}
        text = msg.get("text", "")
        sender = msg.get("from", {})
        if text:
            messages.append({
                "text": text,
                "from": sender.get("first_name", "") or sender.get("username", "User"),
                "date": msg.get("date", 0),
                "chat_id": str(msg.get("chat", {}).get("id", "")),
            })

    return {"status": "ok", "messages": messages}


def _append_activity_event(event: dict) -> None:
    """Append a JSON-encoded event to activity.log."""
    activity_log_path = os.path.join(DATA_DIR, "activity.log")
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(activity_log_path, "a") as f:
        f.write(json.dumps(event) + "\n")

    # Dispatch outbound webhook (fire-and-forget)
    webhook_url = _load_config().get("integrations", {}).get("webhook_url", "")
    if webhook_url:
        import threading
        import urllib.request

        def _post() -> None:
            try:
                data = json.dumps(event).encode()
                req = urllib.request.Request(
                    webhook_url,
                    data=data,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=5)
            except Exception:
                pass

        threading.Thread(target=_post, daemon=True).start()


@app.post("/api/integrations/github/webhook", summary="GitHub inbound webhook")
async def github_webhook(request: Request) -> dict:
    """Receive GitHub webhook events and append them to the activity log."""
    try:
        body = await request.body()
        _require_github_signature(request, body)
        payload = json.loads(body)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    event_type = request.headers.get("X-GitHub-Event", "ping")
    if event_type == "ping":
        return {"status": "pong"}

    repo = payload.get("repository", {}).get("full_name", "unknown/repo")

    if event_type == "push":
        commits = payload.get("commits", [])
        msg = commits[-1].get("message", "")[:80] if commits else "no commits"
        detail = f"Push to {repo}: {msg}"
        action = "PUSH"
    elif event_type == "pull_request":
        pr = payload.get("pull_request", {})
        detail = f"PR #{pr.get('number')}: {pr.get('title', '')[:80]}"
        action = "PULL_REQUEST"
    elif event_type == "issues":
        issue = payload.get("issue", {})
        detail = f"Issue #{issue.get('number')}: {issue.get('title', '')[:80]}"
        action = "ISSUE"
    elif event_type == "issue_comment":
        issue = payload.get("issue", {})
        detail = f"Comment on #{issue.get('number')}: {issue.get('title', '')[:60]}"
        action = "COMMENT"
    else:
        detail = f"GitHub {event_type} on {repo}"
        action = "GITHUB"

    _append_activity_event({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agent": "GitHub",
        "action": action,
        "detail": detail,
    })
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Integration: Slack inbound events
# ---------------------------------------------------------------------------


@app.post("/api/integrations/slack/events", summary="Slack events API endpoint")
async def slack_events(request: Request) -> dict:
    """Handle Slack Events API payloads (URL verification + messages)."""
    try:
        raw_body = await request.body()
        _require_slack_signature(request, raw_body)
        body = json.loads(raw_body)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    # Slack URL verification challenge
    if body.get("type") == "url_verification":
        return {"challenge": body.get("challenge", "")}

    event = body.get("event", {})
    if event.get("type") == "message" and not event.get("bot_id"):
        text = (event.get("text") or "").strip()
        user = event.get("user", "slack-user")
        if text:
            async with _chat_lock:
                await asyncio.to_thread(_append_chat_message, "user", f"[Slack from {user}] {text}")
            _append_activity_event({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "agent": "Slack",
                "action": "MESSAGE",
                "detail": f"From {user}: {text[:120]}",
            })

    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Integration: save integration settings
# ---------------------------------------------------------------------------


@app.patch("/api/integrations", summary="Save integration settings (tokens, webhook URL)")
def save_integrations(request: Request, body: dict) -> dict:
    """Persist integration settings under config.integrations."""
    _require_integrations_write_auth(request)
    config = _load_config()
    integrations = config.get("integrations", {})
    if not isinstance(integrations, dict):
        integrations = {}
    previous_github_token = str(integrations.get("github_token", "") or "").strip()
    previous_github_repo = str(integrations.get("github_repo", "") or "").strip()
    previous_vercel_token = str(integrations.get("vercel_token", "") or "").strip()
    previous_vercel_project = str(integrations.get("vercel_project_name", "") or "").strip()
    sanitized = _sanitize_integration_payload(body)
    for key in (
        "workspace_mode",
        "github_token",
        "github_repo",
        "github_default_branch",
        "github_auto_push",
        "github_auto_pr",
        "github_verified",
        "github_verified_at",
        "github_last_error",
        "vercel_token",
        "vercel_team_id",
        "vercel_project_name",
        "vercel_default_target",
        "vercel_verified",
        "vercel_verified_at",
        "vercel_last_error",
        "slack_token",
        "webhook_url",
    ):
        if key in sanitized:
            integrations[key] = sanitized[key]

    github_token_changed = str(integrations.get("github_token", "") or "").strip() != previous_github_token
    github_repo_changed = str(integrations.get("github_repo", "") or "").strip() != previous_github_repo
    if github_token_changed or github_repo_changed:
        integrations["github_verified"] = False
        integrations["github_last_error"] = "GitHub configuration changed. Re-verify connector."

    vercel_token_changed = str(integrations.get("vercel_token", "") or "").strip() != previous_vercel_token
    vercel_project_changed = str(integrations.get("vercel_project_name", "") or "").strip() != previous_vercel_project
    if vercel_token_changed or vercel_project_changed:
        integrations["vercel_verified"] = False
        integrations["vercel_last_error"] = "Vercel configuration changed. Re-verify connector."

    config["integrations"] = integrations
    _save_config(config)
    return {"status": "ok"}


@app.get("/api/integrations/capabilities", summary="Summarise available GitHub/Vercel capabilities")
def get_integration_capabilities() -> dict:
    """Return non-secret capability metadata for configured integrations."""
    integrations = _load_config().get("integrations", {})
    if not isinstance(integrations, dict):
        integrations = {}

    workspace_mode = integrations.get("workspace_mode", "local")
    github_token_set = bool(str(integrations.get("github_token", "") or "").strip())
    github_repo = str(integrations.get("github_repo", "") or "").strip()
    github_branch = str(integrations.get("github_default_branch", "master") or "master").strip() or "master"
    github_verified = bool(integrations.get("github_verified"))
    github_verified_at = str(integrations.get("github_verified_at", "") or "").strip()
    github_last_error = str(integrations.get("github_last_error", "") or "").strip()

    vercel_token_set = bool(str(integrations.get("vercel_token", "") or "").strip())
    vercel_project_name = str(integrations.get("vercel_project_name", "") or "").strip()
    vercel_verified = bool(integrations.get("vercel_verified"))
    vercel_verified_at = str(integrations.get("vercel_verified_at", "") or "").strip()
    vercel_last_error = str(integrations.get("vercel_last_error", "") or "").strip()
    vercel_default_target = str(integrations.get("vercel_default_target", "preview") or "preview").strip().lower()
    if vercel_default_target not in {"preview", "production"}:
        vercel_default_target = "preview"

    github_capabilities = [
        "create_branch",
        "commit_changes",
        "push_branch",
        "open_pull_request",
        "receive_webhooks",
    ]
    if github_token_set:
        github_capabilities.extend(["manage_issues", "review_diffs"])

    vercel_capabilities = [
        "deploy_preview",
        "deploy_production",
    ] if vercel_token_set else []

    return {
        "workspace_mode": workspace_mode,
        "github": {
            "configured": github_token_set and bool(github_repo),
            "verified": github_verified and github_token_set and bool(github_repo),
            "token_configured": github_token_set,
            "repo": github_repo,
            "default_branch": github_branch,
            "auto_push": bool(integrations.get("github_auto_push")),
            "auto_pr": bool(integrations.get("github_auto_pr")),
            "verified_at": github_verified_at,
            "last_error": github_last_error,
            "capabilities": github_capabilities,
            "webhook_endpoint": "/api/integrations/github/webhook",
        },
        "vercel": {
            "configured": vercel_token_set and bool(vercel_project_name),
            "verified": vercel_verified and vercel_token_set and bool(vercel_project_name),
            "token_configured": vercel_token_set,
            "project_name": vercel_project_name,
            "team_id_set": bool(str(integrations.get("vercel_team_id", "") or "").strip()),
            "default_target": vercel_default_target,
            "verified_at": vercel_verified_at,
            "last_error": vercel_last_error,
            "capabilities": vercel_capabilities,
        },
    }


# ---------------------------------------------------------------------------
# Static files (React frontend) — mounted last so API routes take priority
# ---------------------------------------------------------------------------

dist_dir = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "web-dashboard",
    "dist",
)
if os.path.exists(dist_dir):
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=dist_dir, html=True), name="static")
