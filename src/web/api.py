"""COMPaaS Web Dashboard API.

FastAPI application exposing live company state — org chart, projects,
tasks, activity stream, token metrics, agents, and model settings.
"""

import logging
import os
import json
import re
import shlex
import shutil
import asyncio
import copy
import hashlib
import hmac
import ipaddress
import time
import uuid
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import yaml
from typing import Any, AsyncGenerator
from datetime import datetime, timezone

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python <3.11 fallback
    import tomli as tomllib  # type: ignore

logger = logging.getLogger(__name__)

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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
from src.web.services.context_pack_service import ContextPackService
from src.web.services.review_service import ReviewService
from src.web.services.workforce_presence import WorkforcePresenceService
from src.web.services.run_supervisor import ACTIVE_RUN_STATES, build_run_status_payload, detect_run_incident
from src.web.routers.v1 import V1Context, create_v1_router
from src.web.template_rendering import render_agent_templates
from src.web.problem import PROBLEM_JSON


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
integration_service = IntegrationService(DATA_DIR, workspace_root=WORKSPACE_ROOT)
context_pack_service = ContextPackService(DATA_DIR)
review_service = ReviewService(DATA_DIR)
workforce_presence_service = WorkforcePresenceService(DATA_DIR, run_service=run_service)
try:
    workforce_presence_service.rebuild_from_activity_log_and_runs(
        activity_log_path=os.path.join(DATA_DIR, "activity.log"),
        runs=run_service.list_runs(limit=5000),
    )
except Exception:
    logger.warning("Failed to rebuild workforce presence snapshot at startup.", exc_info=True)

UPDATE_LOG_PATH = os.path.join(DATA_DIR, "update_events.log")


def _run_git_command(*args: str, timeout_seconds: float = 30.0) -> tuple[bool, str]:
    """Run a git command in project root and return (ok, output/error)."""
    if not os.path.isdir(os.path.join(PROJECT_ROOT, ".git")):
        return False, "Git repository not found."
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except Exception as exc:
        return False, str(exc)
    output = (result.stdout or "").strip()
    error = (result.stderr or "").strip()
    if result.returncode != 0:
        return False, error or output or f"git {' '.join(args)} failed with code {result.returncode}"
    return True, output or error


def _parse_semver_tag(value: str) -> tuple[int, int, int] | None:
    match = re.match(r"^v?(\d+)\.(\d+)\.(\d+)$", (value or "").strip())
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def _normalize_semver_tag(value: str) -> str:
    parsed = _parse_semver_tag(value)
    if not parsed:
        return ""
    major, minor, patch = parsed
    return f"v{major}.{minor}.{patch}"


def _read_pyproject_version() -> str:
    pyproject_path = os.path.join(PROJECT_ROOT, "pyproject.toml")
    if not os.path.exists(pyproject_path):
        return "v0.1.0"
    try:
        with open(pyproject_path, "rb") as handle:
            parsed = tomllib.load(handle)
        version = str(parsed.get("project", {}).get("version", "") or "").strip()
        normalized = _normalize_semver_tag(version)
        if normalized:
            return normalized
    except Exception:
        logger.warning("Failed to read pyproject version.", exc_info=True)
    return "v0.1.0"


def _release_tags_local() -> list[str]:
    ok, output = _run_git_command("tag", "--list", "v*.*.*")
    if not ok:
        return []
    tags = [line.strip() for line in output.splitlines() if _parse_semver_tag(line.strip())]
    tags.sort(key=lambda value: _parse_semver_tag(value) or (0, 0, 0))
    return tags


def _highest_release_tag(tags: list[str]) -> str:
    if not tags:
        return ""
    return tags[-1]


def _head_release_tag() -> str:
    ok, output = _run_git_command("tag", "--points-at", "HEAD")
    if not ok:
        return ""
    tags = [line.strip() for line in output.splitlines() if _parse_semver_tag(line.strip())]
    if not tags:
        return ""
    tags.sort(key=lambda value: _parse_semver_tag(value) or (0, 0, 0))
    return tags[-1]


def _is_git_dirty() -> bool:
    ok, output = _run_git_command("status", "--porcelain")
    if not ok:
        return True
    return bool(output.strip())


def _record_update_event(event: dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(UPDATE_LOG_PATH), exist_ok=True)
        payload = {"timestamp": datetime.now(timezone.utc).isoformat(), **event}
        with open(UPDATE_LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=True) + "\n")
    except Exception:
        logger.warning("Failed to append update event.", exc_info=True)


def _resolve_app_version() -> str:
    explicit = _normalize_semver_tag(os.environ.get("COMPAAS_VERSION", "").strip())
    if explicit:
        return explicit
    head_tag = _head_release_tag()
    if head_tag:
        return head_tag
    return _read_pyproject_version()


APP_VERSION = _resolve_app_version()


def _update_status_snapshot(*, refresh_remote: bool) -> dict[str, Any]:
    """Compute updater status from release tags."""
    baseline = {
        "status": "ok",
        "channel": "release_tags",
        "current_version": _resolve_app_version(),
        "latest_version": "",
        "update_available": False,
        "dirty_repo": False,
        "can_update": False,
        "block_reason": "",
    }
    if not os.path.isdir(os.path.join(PROJECT_ROOT, ".git")):
        baseline.update(
            {
                "status": "error",
                "can_update": False,
                "block_reason": "Local git repository not found.",
            }
        )
        return baseline

    if refresh_remote:
        _run_git_command("fetch", "--tags", "--force", "origin", timeout_seconds=90.0)

    tags = _release_tags_local()
    latest = _highest_release_tag(tags)
    current = _head_release_tag() or baseline["current_version"]
    dirty = _is_git_dirty()
    baseline["current_version"] = current
    baseline["latest_version"] = latest or current
    baseline["dirty_repo"] = dirty
    baseline["_available_tags"] = tags

    current_semver = _parse_semver_tag(current)
    latest_semver = _parse_semver_tag(latest)
    if latest_semver and current_semver:
        baseline["update_available"] = latest_semver > current_semver
    elif latest and latest != current:
        baseline["update_available"] = True

    if dirty:
        baseline["block_reason"] = "Local repository has uncommitted changes. Commit or stash before updating."
        baseline["can_update"] = False
        return baseline

    if not latest:
        baseline["block_reason"] = "No release tags were found."
        baseline["can_update"] = False
        return baseline

    if baseline["update_available"]:
        baseline["can_update"] = True
    else:
        baseline["can_update"] = False
        baseline["block_reason"] = "Already on the latest release."

    return baseline


def _apply_release_tag_update(version: str = "") -> dict[str, Any]:
    status = _update_status_snapshot(refresh_remote=True)
    from_version = str(status.get("current_version", "") or "")
    response: dict[str, Any] = {
        "status": "ok",
        "channel": "release_tags",
        "from_version": from_version,
        "to_version": from_version,
        "update_applied": False,
        "restart_required": False,
        "dirty_repo": bool(status.get("dirty_repo")),
        "can_update": bool(status.get("can_update")),
        "block_reason": str(status.get("block_reason", "") or ""),
    }

    if status.get("status") != "ok":
        response["status"] = "error"
        response["error"] = str(status.get("block_reason", "Update status unavailable."))
        _record_update_event({"action": "apply", "result": "blocked", "reason": response["error"]})
        return response

    requested = _normalize_semver_tag(version)
    available_tags = [tag for tag in status.get("_available_tags", []) if isinstance(tag, str)]
    target = requested or str(status.get("latest_version", "") or "")
    if not target or target not in available_tags:
        response["status"] = "error"
        response["error"] = "Requested release tag was not found."
        _record_update_event({"action": "apply", "result": "error", "reason": response["error"], "target": target})
        return response

    if _is_git_dirty():
        response["dirty_repo"] = True
        response["can_update"] = False
        response["block_reason"] = "Local repository has uncommitted changes. Commit or stash before updating."
        _record_update_event({"action": "apply", "result": "blocked", "reason": response["block_reason"]})
        return response

    if _parse_semver_tag(target) and _parse_semver_tag(from_version):
        if (_parse_semver_tag(target) or (0, 0, 0)) <= (_parse_semver_tag(from_version) or (0, 0, 0)):
            response["can_update"] = False
            response["block_reason"] = "Selected release is not newer than the current version."
            _record_update_event({"action": "apply", "result": "blocked", "reason": response["block_reason"], "target": target})
            return response

    ok_fetch, out_fetch = _run_git_command("fetch", "--tags", "--force", "origin", timeout_seconds=90.0)
    if not ok_fetch:
        response["status"] = "error"
        response["error"] = out_fetch or "Failed to fetch remote release tags."
        _record_update_event({"action": "apply", "result": "error", "reason": response["error"]})
        return response

    ok_reset, out_reset = _run_git_command("reset", "--hard", target, timeout_seconds=90.0)
    if not ok_reset:
        response["status"] = "error"
        response["error"] = out_reset or "Failed to switch to requested release tag."
        _record_update_event({"action": "apply", "result": "error", "reason": response["error"], "target": target})
        return response

    resolved_after = _head_release_tag() or target
    response["to_version"] = resolved_after
    response["update_applied"] = True
    response["restart_required"] = True
    response["can_update"] = False
    response["block_reason"] = "Update applied. Restart COMPaaS to load the new version."
    _record_update_event({"action": "apply", "result": "ok", "from": from_version, "to": resolved_after})
    return response

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="COMPaaS Dashboard API",
    description="Live data API for the COMPaaS virtual company web dashboard.",
    version=APP_VERSION,
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
_cors_methods_env = os.environ.get("COMPAAS_CORS_METHODS", "")
_allowed_methods = (
    [m.strip().upper() for m in _cors_methods_env.split(",") if m.strip()]
    if _cors_methods_env
    else ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]
)

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


def _request_correlation_id(request: Request) -> str:
    value = str(getattr(getattr(request, "state", object()), "correlation_id", "") or "").strip()
    return value or str(uuid.uuid4())[:12]


def _normalize_http_exception_payload(detail: Any) -> tuple[Any, str, str, list[dict[str, Any]], bool]:
    """Normalize heterogeneous HTTPException details into a consistent envelope."""
    code = ""
    message = ""
    actions: list[dict[str, Any]] = []
    action_required = False

    if isinstance(detail, dict):
        payload = dict(detail)
        code = str(payload.get("code", "") or "").strip()
        message = str(payload.get("detail", "") or payload.get("message", "") or "").strip()
        maybe_actions = payload.get("actions")
        if isinstance(maybe_actions, list):
            actions = [row for row in maybe_actions if isinstance(row, dict)]
        if "action_required" in payload:
            action_required = bool(payload.get("action_required"))
        else:
            action_required = bool(actions)
        return payload, message, code, actions, action_required

    if isinstance(detail, str):
        message = detail.strip()
    else:
        message = str(detail or "").strip()
    return message or "Request failed.", message or "Request failed.", code, actions, action_required


@app.middleware("http")
async def correlation_id_middleware(request: Request, call_next):
    incoming = (
        request.headers.get("X-Correlation-ID", "").strip()
        or request.headers.get("X-Request-ID", "").strip()
    )
    request.state.correlation_id = incoming or str(uuid.uuid4())[:12]
    response = await call_next(request)
    response.headers["X-Correlation-ID"] = _request_correlation_id(request)
    return response


@app.exception_handler(HTTPException)
async def http_exception_guidance_handler(request: Request, exc: HTTPException):
    correlation_id = _request_correlation_id(request)
    normalized_detail, message, code, actions, action_required = _normalize_http_exception_payload(exc.detail)
    if isinstance(normalized_detail, dict):
        payload = dict(normalized_detail)
        payload.setdefault("correlation_id", correlation_id)
        if code and not payload.get("code"):
            payload["code"] = code
        if actions and not payload.get("actions"):
            payload["actions"] = actions
        if "action_required" not in payload:
            payload["action_required"] = action_required
        response_payload: dict[str, Any] = {
            "detail": payload,
            "correlation_id": correlation_id,
        }
        if payload.get("code"):
            response_payload["code"] = payload.get("code")
        if payload.get("actions"):
            response_payload["actions"] = payload.get("actions")
            response_payload["action_required"] = bool(payload.get("action_required", True))
        return JSONResponse(status_code=exc.status_code, content=response_payload, media_type=PROBLEM_JSON)
    response_payload = {
        "detail": message or "Request failed.",
        "correlation_id": correlation_id,
    }
    if code:
        response_payload["code"] = code
    if actions:
        response_payload["actions"] = actions
        response_payload["action_required"] = action_required
    return JSONResponse(status_code=exc.status_code, content=response_payload)


@app.exception_handler(RequestValidationError)
async def request_validation_guidance_handler(request: Request, exc: RequestValidationError):
    correlation_id = _request_correlation_id(request)
    return JSONResponse(
        status_code=422,
        content={
            "detail": "Request validation failed.",
            "code": "request_validation_failed",
            "correlation_id": correlation_id,
            "action_required": True,
            "actions": [
                {
                    "id": "retry",
                    "label": "Retry with corrected input",
                    "kind": "retry",
                }
            ],
            "errors": exc.errors(),
        },
    )


@app.exception_handler(Exception)
async def unexpected_exception_guidance_handler(request: Request, exc: Exception):
    correlation_id = _request_correlation_id(request)
    logger.exception("Unhandled API error", extra={"correlation_id": correlation_id})
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Unexpected server error. Open Event Log and retry.",
            "code": "unexpected_server_error",
            "correlation_id": correlation_id,
            "action_required": True,
            "actions": [
                {
                    "id": "retry",
                    "label": "Retry",
                    "kind": "retry",
                },
                {
                    "id": "open_events",
                    "label": "View Event Log",
                    "kind": "view_events",
                },
            ],
        },
    )


def _env_first(*names: str) -> str:
    """Return the first non-empty environment value from a list of names."""
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


REDACTED_SECRET = "__COMPAAS_REDACTED__"
SENSITIVE_INTEGRATION_KEYS = (
    "github_token",
    "slack_token",
    "vercel_token",
    "stripe_secret_key",
    "stripe_webhook_secret",
)


def _redact_config_for_response(config: dict) -> dict:
    """Return a copy of config with sensitive integration values redacted."""
    safe = copy.deepcopy(config)
    integrations = safe.get("integrations")
    if isinstance(integrations, dict):
        for key in SENSITIVE_INTEGRATION_KEYS:
            value = integrations.get(key)
            if isinstance(value, str) and value:
                integrations[key] = REDACTED_SECRET
    llm = safe.get("llm")
    if isinstance(llm, dict):
        api_key = llm.get("api_key")
        if isinstance(api_key, str) and api_key:
            llm["api_key"] = REDACTED_SECRET
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


def _require_write_auth(request: Request) -> None:
    """Protect mutation endpoints from unauthorised remote writes."""
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


def _require_integrations_write_auth(request: Request) -> None:
    """Backwards-compatible alias for integration mutation auth."""
    _require_write_auth(request)


def _hostname_matches_allowlist(hostname: str, allowlist: set[str]) -> bool:
    """Return True when hostname matches an explicit allowlist entry."""
    if not hostname or not allowlist:
        return False
    normalized = hostname.strip().lower().rstrip(".")
    for entry in allowlist:
        token = entry.strip().lower().rstrip(".")
        if not token:
            continue
        if token.startswith("*.") and normalized.endswith(token[1:]):
            return True
        if token.startswith(".") and normalized.endswith(token):
            return True
        if normalized == token:
            return True
    return False


def _llm_test_allowlist() -> set[str]:
    """Return explicit host allowlist for /api/llm/test URL checks."""
    raw = _env_first("COMPAAS_LLM_TEST_ALLOWLIST")
    if not raw:
        return set()
    parsed: set[str] = set()
    for item in raw.split(","):
        token = item.strip()
        if not token:
            continue
        if "://" in token:
            host = urllib.parse.urlparse(token).hostname or ""
            if host:
                parsed.add(host)
            continue
        parsed.add(token)
    return parsed


def _validate_llm_test_base_url(base_url: str) -> tuple[bool, str]:
    """Validate /api/llm/test base URL to reduce SSRF risk."""
    raw = str(base_url or "").strip()
    if not raw:
        return False, "base_url is required."

    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return False, "Invalid base_url."
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return False, "Only http/https base_url values are allowed."

    hostname = (parsed.hostname or "").strip().lower().rstrip(".")
    if not hostname:
        return False, "base_url must include a hostname."

    allowlist = _llm_test_allowlist()
    if _hostname_matches_allowlist(hostname, allowlist):
        return True, ""

    if hostname == "localhost":
        return True, ""

    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        # Block common internal-only DNS suffixes by default unless allowlisted.
        if hostname.endswith(".local") or hostname.endswith(".internal"):
            return False, "base_url host is blocked by default policy."
        return True, ""

    if ip.is_loopback:
        return True, ""
    if ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
        return False, "base_url host is blocked by default policy."
    return True, ""


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
        "version": APP_VERSION,
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


def _normalize_project_tags(values: Any, *, limit: int = 8) -> list[str]:
    if isinstance(values, str):
        raw_values: list[str] = [part for part in values.split(",")]
    elif isinstance(values, list):
        raw_values = [str(item or "") for item in values]
    else:
        return []

    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        tag = re.sub(r"\s+", " ", str(raw or "").strip().lower())
        tag = re.sub(r"[^a-z0-9 _-]", "", tag).strip(" -_")
        if not tag or tag in seen:
            continue
        seen.add(tag)
        normalized.append(tag)
        if len(normalized) >= limit:
            break
    return normalized


def _backfill_project_run_instructions(project_id: str) -> str:
    """Best-effort run command backfill from artifacts/02_activation_guide.md."""
    if not project_id:
        return ""
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        return ""

    activation_guide_path = safe_path_join(
        state_manager.projects_dir,
        project_id,
        "artifacts",
        "02_activation_guide.md",
    )
    if not os.path.exists(activation_guide_path):
        return ""

    try:
        with open(activation_guide_path) as f:
            activation_guide = f.read()
    except OSError:
        return ""

    parsed = _structured_response_payload(activation_guide)
    run_commands = _normalize_unique_strings(parsed.get("run_commands"), limit=16)
    if not run_commands:
        return ""

    run_instructions = "\n".join(run_commands).strip()
    project = state_manager.get_project(project_id)
    if isinstance(project, dict):
        current = str(project.get("run_instructions", "") or "").strip()
        if not current and run_instructions:
            state_manager.update_project(project_id, {"run_instructions": run_instructions})
    return run_instructions


_GENERIC_TASK_TITLE_RE = re.compile(
    r"\b(execution stream|delivery stream|work stream|workstream|implementation stream|task stream)\b",
    flags=re.IGNORECASE,
)


def _normalize_lane_status(raw_status: Any) -> str:
    status = str(raw_status or "").strip().lower().replace(" ", "_")
    if status in {"todo", "in_progress", "review", "done", "blocked"}:
        return status
    if status in {"completed", "complete"}:
        return "done"
    if status in {"inprogress", "working", "active"}:
        return "in_progress"
    return "todo"


def _lane_status_rank(status: str) -> int:
    normalized = _normalize_lane_status(status)
    if normalized == "in_progress":
        return 0
    if normalized == "blocked":
        return 1
    if normalized in {"todo", "review"}:
        return 2
    if normalized == "done":
        return 3
    return 4


def _compact_headline(text: str, *, max_chars: int = 96) -> str:
    collapsed = re.sub(r"\s+", " ", str(text or "").strip())
    if not collapsed:
        return ""
    if len(collapsed) <= max_chars:
        return collapsed
    return f"{collapsed[: max_chars - 3].rstrip()}..."


def _headline_from_description(description: str) -> str:
    raw = re.sub(r"\s+", " ", str(description or "").strip())
    if not raw:
        return ""

    focus_match = re.search(r"request focus:\s*(.+)$", raw, flags=re.IGNORECASE)
    if focus_match:
        return _compact_headline(focus_match.group(1))

    lowered = raw.lower()
    if lowered.startswith("contribute specialist implementation output."):
        trimmed = raw[len("Contribute specialist implementation output.") :].strip(" -:")
        if trimmed:
            return _compact_headline(trimmed)

    sentence = re.split(r"(?<=[.!?])\s+", raw, maxsplit=1)[0]
    return _compact_headline(sentence)


def _lane_headline_for_task(task: dict[str, Any], project: dict[str, Any]) -> str:
    title = _compact_headline(str(task.get("title", "") or ""))
    if title and not _GENERIC_TASK_TITLE_RE.search(title):
        return title

    description_headline = _headline_from_description(str(task.get("description", "") or ""))
    if description_headline:
        return description_headline

    project_summary = _compact_headline(str(project.get("description", "") or ""))
    if project_summary and not project_summary.lower().startswith("auto-created from ceo chat request"):
        return project_summary

    project_name = _compact_headline(str(project.get("name", "project") or "project"), max_chars=60)
    return f"Advance {project_name} delivery scope".strip()


def _compute_project_high_level_tasks(
    project: dict[str, Any],
    tasks: list[dict[str, Any]],
    *,
    limit: int = 12,
) -> tuple[list[dict[str, str]], str]:
    best_by_owner: dict[str, dict[str, str]] = {}
    best_rank: dict[str, tuple[int, str]] = {}
    latest_update = ""

    for task in tasks:
        owner = str(task.get("assigned_to", "") or "").strip()
        if not owner:
            continue
        status = _normalize_lane_status(task.get("status"))
        rank = _lane_status_rank(status)
        updated_at = str(task.get("updated_at", "") or task.get("created_at", "") or "").strip()
        if updated_at and updated_at > latest_update:
            latest_update = updated_at

        headline = _lane_headline_for_task(task, project)
        if not headline:
            continue

        existing = best_rank.get(owner)
        if existing is not None:
            existing_rank, existing_updated = existing
            if rank > existing_rank:
                continue
            if rank == existing_rank and existing_updated and updated_at and updated_at <= existing_updated:
                continue

        best_rank[owner] = (rank, updated_at)
        best_by_owner[owner] = {
            "owner": owner,
            "headline": headline,
            "status": status,
        }

    ordered = sorted(
        best_by_owner.values(),
        key=lambda row: (
            _lane_status_rank(str(row.get("status", "") or "")),
            str(row.get("owner", "") or "").lower(),
        ),
    )
    if limit > 0:
        ordered = ordered[:limit]
    return ordered, latest_update


def _workspace_path_allowed(path_value: str) -> bool:
    manager_root = str(getattr(state_manager, "workspace_root", "") or "").strip()
    root = os.path.realpath(manager_root or WORKSPACE_ROOT)
    candidate = os.path.realpath(path_value)
    if candidate == root:
        return False
    return candidate.startswith(root.rstrip(os.sep) + os.sep)


@app.get("/api/projects", summary="List all projects with status and task progress")
def list_projects() -> list[dict]:
    """Return every project with its status and a summary of task counts by
    status (todo / in_progress / done / blocked).
    """
    projects = state_manager.list_projects()
    result: list[dict] = []
    for proj in projects:
        run_instructions = str(proj.get("run_instructions", "") or "").strip()
        if not run_instructions:
            run_instructions = _backfill_project_run_instructions(str(proj.get("id", "") or ""))
            if run_instructions:
                proj = {**proj, "run_instructions": run_instructions}
        tasks = task_board.get_board(proj["id"])
        high_level_tasks, high_level_tasks_updated_at = _compute_project_high_level_tasks(proj, tasks)
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
            "high_level_tasks": high_level_tasks,
            "high_level_tasks_updated_at": high_level_tasks_updated_at,
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
    tags = _normalize_project_tags(payload.get("tags"))
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

    if not name:
        raise HTTPException(status_code=400, detail="Project name is required.")

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
    if project_id and tags:
        state_manager.update_project(project_id, {"tags": tags})
        project = state_manager.get_project(project_id) or project
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
    high_level_tasks, high_level_tasks_updated_at = _compute_project_high_level_tasks(project, tasks)
    try:
        plan_packet = project_service.plan_packet_status(project_id)
    except ValueError:
        plan_packet = {
            "ready": False,
            "missing_items": ["Project metadata unavailable."],
            "summary": "Planning packet could not be evaluated.",
        }
    return {
        **project,
        "tasks": tasks,
        "project": project,
        "plan_packet": plan_packet,
        "high_level_tasks": high_level_tasks,
        "high_level_tasks_updated_at": high_level_tasks_updated_at,
    }


def _delete_project_impl(request: Request, project_id: str) -> dict:
    _require_write_auth(request)
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")

    existing = state_manager.get_project(project_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    try:
        outcome = state_manager.delete_project(project_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete project: {str(exc)}")

    if not isinstance(outcome, dict):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    workspace_path = str(outcome.get("workspace_path", "") or "").strip()
    workspace_skip_reason = str(outcome.get("workspace_skip_reason", "") or "").strip()
    payload = {
        "status": "ok",
        "project_id": project_id,
        "project_deleted": bool(outcome.get("project_deleted")),
        "workspace_deleted": bool(outcome.get("workspace_deleted")),
    }
    if workspace_path:
        payload["workspace_path"] = workspace_path
    if workspace_skip_reason:
        payload["workspace_skip_reason"] = workspace_skip_reason

    emit_activity(
        DATA_DIR,
        "ceo",
        "DELETED",
        f"Project '{existing.get('name', project_id)}' deleted",
        project_id=project_id,
        metadata={
            "workspace_deleted": payload["workspace_deleted"],
            "workspace_path": workspace_path,
            "workspace_skip_reason": workspace_skip_reason,
        },
    )
    return payload


@app.delete("/api/projects/{project_id}", summary="Delete a project and workspace")
def delete_project(request: Request, project_id: str) -> dict:
    return _delete_project_impl(request, project_id)


@app.post("/api/projects/{project_id}/delete", summary="Delete a project and workspace (POST alias)")
def delete_project_post_alias(request: Request, project_id: str) -> dict:
    return _delete_project_impl(request, project_id)


@app.post("/api/projects/{project_id}", summary="Project mutation actions (POST alias)")
def project_post_action(request: Request, project_id: str, body: dict | None = None) -> dict:
    payload = body or {}
    action = str(payload.get("action", "") or "").strip().lower()
    if action == "delete":
        return _delete_project_impl(request, project_id)
    raise HTTPException(status_code=400, detail="Unsupported project action.")


@app.post("/api/projects/{project_id}/workspace/open", summary="Open project workspace folder on host OS")
def open_project_workspace(request: Request, project_id: str) -> dict:
    _require_write_auth(request)
    correlation_id = uuid.uuid4().hex[:12]
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")

    project = state_manager.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    workspace_path = str(project.get("workspace_path", "") or "").strip()
    resolved_workspace = os.path.realpath(os.path.abspath(workspace_path)) if workspace_path else ""

    base_payload = {
        "path": workspace_path,
        "correlation_id": correlation_id,
    }
    copy_action = {
        "id": "copy-workspace-path",
        "label": "Copy workspace path",
        "kind": "copy",
        "payload": {"text": workspace_path},
    }
    if not workspace_path:
        return {
            "status": "error",
            "opened": False,
            "launcher": "none",
            "detail": "Workspace path is not configured for this project.",
            "actions": [copy_action],
            **base_payload,
        }
    if not os.path.isdir(resolved_workspace):
        return {
            "status": "error",
            "opened": False,
            "launcher": "none",
            "detail": "Workspace path does not exist on this machine.",
            "actions": [copy_action],
            **base_payload,
        }
    if not _workspace_path_allowed(resolved_workspace):
        return {
            "status": "error",
            "opened": False,
            "launcher": "none",
            "detail": "Workspace path is outside the allowed workspace root.",
            "actions": [copy_action],
            **base_payload,
        }
    if not _is_loopback_client(request):
        return {
            "status": "error",
            "opened": False,
            "launcher": "none",
            "detail": "Workspace opening is only available from the local COMPaaS host.",
            "actions": [copy_action],
            **base_payload,
        }

    if sys.platform == "darwin":
        launcher = "open"
        command = ["open", resolved_workspace]
    elif os.name == "nt":
        launcher = "explorer"
        command = ["explorer", resolved_workspace]
    else:
        launcher = "xdg-open"
        if not shutil.which("xdg-open"):
            return {
                "status": "error",
                "opened": False,
                "launcher": "none",
                "detail": "xdg-open is unavailable on this host.",
                "actions": [copy_action],
                **base_payload,
            }
        command = ["xdg-open", resolved_workspace]

    try:
        subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        return {
            "status": "error",
            "opened": False,
            "launcher": "none",
            "detail": f"Failed to launch workspace folder: {str(exc)}",
            "actions": [copy_action],
            **base_payload,
        }

    emit_activity(
        DATA_DIR,
        "ceo",
        "OPENED",
        "Workspace folder opened from project panel.",
        project_id=project_id,
        metadata={"workspace_path": resolved_workspace, "launcher": launcher, "correlation_id": correlation_id},
    )
    return {
        "status": "ok",
        "opened": True,
        "path": resolved_workspace,
        "launcher": launcher,
        "detail": "Workspace folder opened.",
        "correlation_id": correlation_id,
    }


@app.patch("/api/projects/{project_id}", summary="Update mutable project metadata")
def patch_project(request: Request, project_id: str, body: dict | None = None) -> dict:
    _require_write_auth(request)
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")

    project = state_manager.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    payload = body or {}
    updates: dict[str, Any] = {}

    if "tags" in payload:
        updates["tags"] = _normalize_project_tags(payload.get("tags"))

    if not updates:
        return {"status": "ok", "project": project, "updated_fields": []}

    updated = state_manager.update_project(project_id, updates)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update project.")

    refreshed = state_manager.get_project(project_id) or project
    emit_activity(
        DATA_DIR,
        "ceo",
        "UPDATED",
        f"Project '{project_id}' metadata updated",
        project_id=project_id,
        metadata={"fields": sorted(updates.keys())},
    )
    return {"status": "ok", "project": refreshed, "updated_fields": sorted(updates.keys())}


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
        "ciso": "Rachel", "cfo": "Jonathan", "vp-product": "Olivia",
        "vp-engineering": "David", "lead-backend": "James",
        "lead-frontend": "Priya", "lead-designer": "Lena",
        "qa-lead": "Carlos", "devops": "Nina",
        "security-engineer": "Alex", "data-engineer": "Maya",
        "tech-writer": "Tom",
    },
    "ui": {
        "theme": "midnight",
        "poll_interval_ms": 5000,
        "always_on_mode": "guarded_autopilot",
        "run_progress_surface": "inline_chat",
        "run_heartbeat_seconds": 5,
        "run_stall_warning_seconds": 90,
        "run_stall_critical_seconds": 180,
        "completion_celebration_enabled": True,
        "completion_celebration_mode": "subtle_burst",
        "activity_stream_fallback_enabled": True,
        "activity_stream_fallback_ms": 15000,
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
        "claude_passive_retry_max": 3,
        "system_prompt": "",
        # Phase 2: route ALL agent subprocesses through a LiteLLM proxy
        "proxy_enabled": False,
        "proxy_url": "http://localhost:4000",
    },
    "chat_policy": {
        "memory_scope": "project",
        "retention_days": 30,
        "auto_summary_every_messages": runtime_settings.chat_auto_summary_interval,
        "delegation_strategy": "executive_first",
        "delegation_max_agents": 4,
        "delegation_include_qa_docs_early": False,
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
        "stripe_secret_key": "",
        "stripe_publishable_key": "",
        "stripe_webhook_secret": "",
        "stripe_price_basic": "",
        "stripe_price_pro": "",
        "stripe_verified": False,
        "stripe_verified_at": "",
        "stripe_last_error": "",
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
        render_agent_templates(PROJECT_ROOT)
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
def setup_config(request: Request, config: dict) -> dict:
    existing = _load_config()
    if bool(existing.get("setup_complete")):
        _require_write_auth(request)
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
            workforce_presence_service=workforce_presence_service,
            require_write_auth=_require_write_auth,
            app_version=APP_VERSION,
            update_status=lambda refresh_remote=False: _update_status_snapshot(refresh_remote=refresh_remote),
            apply_update=lambda version="": _apply_release_tag_update(version),
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
    allowed, reason = _validate_llm_test_base_url(str(base_url))
    if not allowed:
        return {"status": "error", "message": reason}

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
def list_agents(activity_limit: int = Query(default=5, ge=0, le=50)) -> list[dict]:
    """Return every known agent (core team, on-demand, and dynamically hired)."""
    agents: list[dict] = []
    runtime = _llm_runtime_snapshot()

    # Pre-scan activity log once for all agents (last 500 lines, ~10 min window).
    # This lets the frontend know which agents are recently active without needing
    # the per-agent detail endpoint.
    activity_by_agent: dict[str, list[dict]] = {}
    activity_log_path = os.path.join(DATA_DIR, "activity.log")
    if os.path.exists(activity_log_path):
        cutoff = time.time() - 600  # 10 minutes
        try:
            with open(activity_log_path, "rb") as bf:
                bf.seek(0, 2)
                fsize = bf.tell()
                # Read last 64KB to avoid scanning huge files
                read_size = min(fsize, 65536)
                bf.seek(max(0, fsize - read_size))
                tail = bf.read().decode("utf-8", errors="replace")
            for raw_line in tail.splitlines():
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    evt = json.loads(raw_line)
                    ts_str = evt.get("timestamp", "")
                    if ts_str:
                        try:
                            ts_val = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
                        except Exception:
                            ts_val = 0
                        if ts_val < cutoff:
                            continue
                    agent_key = str(evt.get("agent", "")).strip().lower()
                    if agent_key:
                        activity_by_agent.setdefault(agent_key, []).append(evt)
                        # Also index by target_agent from metadata
                        meta = evt.get("metadata") or {}
                        target_agent = str(meta.get("target_agent", "")).strip().lower()
                        if target_agent and target_agent != agent_key:
                            activity_by_agent.setdefault(target_agent, []).append(evt)
                except (ValueError, KeyError):
                    continue
        except OSError:
            pass

    for agent_id, info in AGENT_REGISTRY.items():
        base_model = str(info.get("model", "sonnet") or "sonnet")
        raw = activity_by_agent.get(agent_id, [])
        agent_activity = raw[-activity_limit:] if activity_limit else []
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
            "recent_activity": agent_activity,
        }
        agents.append(entry)

    # Dynamically hired agents from hiring log.
    hiring_log_path = os.path.join(DATA_DIR, "hiring_log.yaml")
    if os.path.exists(hiring_log_path):
        with open(hiring_log_path) as f:
            log = yaml.safe_load(f) or {"hired": []}
        for h in log.get("hired", []):
            base_model = str(h.get("model", "sonnet") or "sonnet")
            hired_id = str(h.get("name", "")).strip().lower()
            raw = activity_by_agent.get(hired_id, [])
            agent_activity = raw[-activity_limit:] if activity_limit else []
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
                "recent_activity": agent_activity,
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
def recent_activity(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0, le=100000),
) -> list[dict]:
    """Return recent activity events as JSON (non-streaming, newest-window pagination)."""
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
    if not events:
        return []
    end = max(0, len(events) - offset)
    start = max(0, end - limit)
    return events[start:end]


@app.get("/api/workforce/live", summary="Get canonical live workforce presence state")
def workforce_live(
    project_id: str = Query(default="", description="Optional project scope"),
    include_assigned: bool = Query(default=True, description="Include assigned (not yet working) entries"),
    include_reporting: bool = Query(default=True, description="Include reporting entries"),
) -> dict[str, Any]:
    scoped_project_id = _normalize_project_id(project_id)
    return workforce_presence_service.snapshot(
        project_id=scoped_project_id or None,
        include_assigned=include_assigned,
        include_reporting=include_reporting,
    )


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

    # Unblock chat execution after approval: prior planning-gate runs may still
    # be left in "planning" state, which would otherwise trip concurrency guard.
    released_runs: list[str] = []
    for run in run_service.list_runs(project_id=project_id, limit=200):
        run_id = str(run.get("id", "") or "")
        if not run_id:
            continue
        if str(run.get("status", "") or "") != "planning":
            continue
        transitioned = _transition_run_state(
            run_id,
            state="done",
            label="Planning approved; waiting for execution follow-up.",
            metadata={"reason": "planning_approved"},
        )
        if transitioned:
            released_runs.append(run_id)
    return {"status": "approved", "plan_packet": plan_packet, "released_runs": released_runs}


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
        new_project, _ = project_service.create_project(
            name=project_name,
            description=project_desc,
            project_type="app",
            delivery_mode=delivery_mode,
            github_repo=github_repo if delivery_mode == "github" else "",
            github_branch=str(integrations.get("github_default_branch", "master") or "master").strip() or "master",
        )
        new_pid = str(new_project.get("id", ""))
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
    feature_flags_cfg = cfg.get("feature_flags", {}) if isinstance(cfg.get("feature_flags"), dict) else {}

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

    if bool(feature_flags_cfg.get("context_packs", True)):
        try:
            context_payload = context_pack_service.build_prompt_context(
                project_id=project_id,
                max_packs=8,
                max_chars=3500,
            )
        except Exception:
            context_payload = {"text": "", "packs": []}
        context_text = str(context_payload.get("text", "") or "").strip()
        if context_text:
            parts.append(context_text)
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
        "This dashboard flow is non-interactive: do not block waiting for clarifications. "
        "If requirements are ambiguous, state concise assumptions and proceed with execution immediately. "
        "Do not use interactive question tools. "
        "For build requests, delegate to your specialist team via the Task tool and report their progress. "
        "If you announce that agents are working in parallel, continue orchestration in the same turn and do not end with passive waiting language. "
        "Never end an execution turn with standby-only phrasing such as 'I'll wait', 'standing by', or 'once they finish'. "
        "For product and UI work, involve the designer by default and ensure design choices match user purpose, audience, and workflow (avoid generic boilerplate output). "
        "When implementation work is completed, structure the final update using short sections in this order: "
        "'Outcome', 'Deliverables', 'Validation', 'Run Commands', 'Open Links', and 'Next Steps'. "
        "Include concrete commands and openable targets whenever available."
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


def _guidance_action(
    *,
    action_id: str,
    label: str,
    kind: str,
    target: str = "",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_kind = str(kind or "").strip().lower() or "retry"
    row: dict[str, Any] = {
        "id": str(action_id or "action").strip() or "action",
        "label": str(label or "Retry").strip() or "Retry",
        "kind": normalized_kind,
    }
    if target:
        row["target"] = str(target).strip()
    if isinstance(payload, dict) and payload:
        row["payload"] = payload
    return row


def _runtime_guidance_payload(
    *,
    message: str,
    code: str = "",
    correlation_id: str = "",
    actions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    normalized_actions = [row for row in (actions or []) if isinstance(row, dict)]
    payload: dict[str, Any] = {
        "message": str(message or "").strip() or "Action required.",
        "action_required": bool(normalized_actions),
        "actions": normalized_actions,
    }
    normalized_code = str(code or "").strip()
    normalized_correlation = str(correlation_id or "").strip()
    if normalized_code:
        payload["code"] = normalized_code
    if normalized_correlation:
        payload["correlation_id"] = normalized_correlation
    return payload


def _build_terminal_guidance(
    *,
    terminal_state: str,
    error_reason: str,
    project_id: str,
    run_id: str,
    correlation_id: str,
) -> dict[str, Any]:
    normalized_state = str(terminal_state or "").strip().lower()
    normalized_reason = str(error_reason or "").strip()
    normalized_project = str(project_id or "").strip()
    normalized_run = str(run_id or "").strip()
    normalized_correlation = str(correlation_id or "").strip()
    reason_lower = normalized_reason.lower()
    actions: list[dict[str, Any]] = []

    if normalized_state in {"failed", "cancelled"}:
        actions.append(_guidance_action(action_id="retry", label="Retry now", kind="retry"))
        if normalized_run:
            actions.append(
                _guidance_action(
                    action_id="status",
                    label="Show run status",
                    kind="run_control",
                    payload={"action": "status", "run_id": normalized_run},
                )
            )
        if normalized_project:
            actions.append(
                _guidance_action(
                    action_id="open_project",
                    label="Open project",
                    kind="open_project",
                    target=normalized_project,
                    payload={"project_id": normalized_project},
                )
            )
        if (
            "auth" in reason_lower
            or "api key" in reason_lower
            or "token" in reason_lower
            or "claude cli not found" in reason_lower
            or "codex" in reason_lower
        ):
            connector = "github"
            if "vercel" in reason_lower:
                connector = "vercel"
            elif "stripe" in reason_lower:
                connector = "stripe"
            actions.append(
                _guidance_action(
                    action_id="open_settings",
                    label="Open settings",
                    kind="open_settings",
                    payload={"connector": connector},
                )
            )
        diagnostic = f"{normalized_state}:{normalized_reason or 'unknown'}:{normalized_correlation}"
        actions.append(
            _guidance_action(
                action_id="copy_diag",
                label="Copy diagnostics",
                kind="copy",
                payload={"text": diagnostic},
            )
        )
        actions.append(_guidance_action(action_id="view_events", label="View Event Log", kind="view_events"))

    code = "run_failed" if normalized_state == "failed" else "run_cancelled" if normalized_state == "cancelled" else "run_done"
    return _runtime_guidance_payload(
        message=normalized_reason or ("Run failed." if normalized_state == "failed" else "Run cancelled."),
        code=code,
        correlation_id=normalized_correlation,
        actions=actions,
    )


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
        if provider == "anthropic" and mode == "cli":
            return (
                "Anthropic authentication failed. "
                "Run `claude auth login` to refresh your CLI credentials, then retry."
            )
        if provider == "anthropic" and mode == "apikey":
            return (
                "Anthropic API authentication failed. "
                "Add a valid key in Settings -> AI -> Anthropic, then retry."
            )
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
        or "failedtoopensocket" in lower
        or "unable to connect to api" in lower
        or "timed out" in lower
        or "name or service not known" in lower
        or "temporary failure in name resolution" in lower
    )
    if connection_error:
        if provider == "anthropic":
            return (
                "Could not connect to the Anthropic API. "
                "If using CLI auth, run `claude auth login` first. "
                "If using API-key mode, add a valid key in Settings -> AI -> Anthropic. "
                "Also check your network connection and any proxy configuration."
            )
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


# ---- Subprocess environment sanitization ----

# Claude Code env vars that must NOT be inherited by child CLI processes.
# CLAUDECODE blocks nesting; FD-based vars reference file descriptors that
# are not inheritable; session/container IDs belong to the parent session.
_CLAUDE_ENV_VARS_TO_STRIP = (
    "CLAUDECODE",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CONTAINER_ID",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    "CLAUDE_CODE_DEBUG",
    "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
    "CLAUDE_AUTO_BACKGROUND_TASKS",
    "CLAUDE_AFTER_LAST_COMPACT",
)


def _sanitize_subprocess_env(env: dict[str, str]) -> dict[str, str]:
    """Remove Claude Code env vars that break child CLI subprocesses.

    The web dashboard spawns Claude CLI as a subprocess.  When the dashboard
    itself runs inside a Claude Code session, these vars leak into the child
    and cause either nesting blocks (``CLAUDECODE=1``) or invalid FD
    references (``CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR``).
    """
    for var in _CLAUDE_ENV_VARS_TO_STRIP:
        env.pop(var, None)
    return env


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

    execution_terms = (
        "build",
        "implement",
        "create",
        "write",
        "generate",
        "develop",
        "code",
        "scaffold",
        "set up",
        "setup",
        "integrate",
        "refactor",
        "optimize",
        "deploy",
        "launch",
        "deliver",
        "fix",
        "ship",
    )
    planning_terms = (
        "plan",
        "architecture",
        "roadmap",
        "strategy",
        "research",
        "tradeoff",
        "scope",
        "discovery",
        "requirements",
        "estimate",
        "effort",
        "feasibility",
        "timeline",
        "milestone",
        "spec",
        "prd",
    )
    complex_terms = (
        "production",
        "security",
        "scalable",
        "migration",
        "ci/cd",
        "end-to-end",
        "compliance",
        "multi-tenant",
        "sso",
        "audit",
    )
    review_terms = (
        "review",
        "qa",
        "test",
        "regression",
        "validate",
        "verify",
        "acceptance",
        "uat",
        "signoff",
        "smoke test",
    )
    discovery_terms = _DISCOVERY_SCOPING_HINTS

    execution_hits = sum(1 for t in execution_terms if _contains_keyword(text, (t,)))
    planning_hits = sum(1 for t in planning_terms if _contains_keyword(text, (t,)))
    complex_hits = sum(1 for t in complex_terms if _contains_keyword(text, (t,)))
    review_hits = sum(1 for t in review_terms if _contains_keyword(text, (t,)))
    discovery_hits = sum(1 for t in discovery_terms if _contains_keyword(text, (t,)))
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
    if planning_hits > execution_hits or discovery_hits > 0:
        confidence = min(0.98, 0.62 + (planning_hits + discovery_hits) * 0.08)
        return {
            "intent": "planning",
            "class": "planning",
            "confidence": round(confidence, 2),
            "needs_planning": True,
            "actionable": True,
            "delegate_allowed": True,
        }
    if execution_hits > 0:
        needs_planning = complex_hits > 0 or planning_hits > 0 or discovery_hits > 0 or (len(text.split()) > 45)
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
        return {
            "summary": "",
            "delegations": [],
            "risks": [],
            "next_actions": [],
            "deliverables": [],
            "validation": [],
            "run_commands": [],
            "open_links": [],
            "completion_kind": "general",
        }

    def _clean_bullet_prefix(line: str) -> str:
        return re.sub(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", "", line).strip()

    def _section_name(raw_name: str) -> str:
        name = raw_name.strip().lower()
        if name in {"outcome", "summary"}:
            return "summary"
        if name in {"deliverable", "deliverables", "artifact", "artifacts"}:
            return "deliverables"
        if name in {"validation"}:
            return "validation"
        if name in {"run command", "run commands", "command", "commands"}:
            return "run_commands"
        if name in {"open link", "open links", "links"}:
            return "open_links"
        if name in {"next step", "next steps", "next action", "next actions"}:
            return "next_actions"
        if name in {"risk", "risks"}:
            return "risks"
        return "body"

    def _extract_markdown_links(line: str) -> list[tuple[str, str]]:
        links: list[tuple[str, str]] = []
        for match in re.finditer(r"\[([^\]]+)\]\(([^)]+)\)", line):
            label = match.group(1).strip()
            target_raw = match.group(2).strip()
            # Markdown links can include a title after whitespace.
            target = re.split(r'\s+"[^"]*"$', target_raw, maxsplit=1)[0].strip()
            if label and target:
                links.append((label, target))
        return links

    def _deliverable_kind(target: str) -> str:
        return "url" if re.match(r"^https?://", target, flags=re.IGNORECASE) else "path"

    def _extract_link_items(lines: list[str]) -> list[dict[str, str]]:
        items: list[dict[str, str]] = []
        seen_targets: set[str] = set()
        path_pattern = re.compile(r"(?<![\w.-])((?:/[A-Za-z0-9._-]+){2,}|(?:[A-Za-z0-9._-]+/){1,}[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?)")
        url_pattern = re.compile(r"https?://[^\s)>\]]+")

        def _push(label: str, target: str) -> None:
            clean_target = target.strip()
            if not clean_target:
                return
            normalized = clean_target.rstrip(".,);!?")
            if not normalized or normalized in seen_targets:
                return
            seen_targets.add(normalized)
            clean_label = label.strip() or normalized
            items.append({
                "label": clean_label,
                "target": normalized,
                "kind": _deliverable_kind(normalized),
            })

        for raw_line in lines:
            line = _clean_bullet_prefix(raw_line)
            if not line:
                continue

            markdown_links = _extract_markdown_links(line)
            for label, target in markdown_links:
                _push(label, target)

            for url in url_pattern.findall(line):
                _push(url, url)

            for path_match in path_pattern.findall(line):
                if re.match(r"^https?://", path_match, flags=re.IGNORECASE):
                    continue
                _push(path_match, path_match)

        return items[:20]

    def _looks_like_command(line: str) -> bool:
        if not line:
            return False
        candidate = line.strip()
        if not candidate or candidate.endswith(":"):
            return False
        if re.match(r"^https?://", candidate, flags=re.IGNORECASE):
            return False
        command_prefix = re.compile(
            r"^(?:\./|cd\s+|npm|pnpm|yarn|bun|npx|pnpx|node|python|uv|pip|poetry|cargo|go|make|docker|git|bash|sh|deno|php|composer|ruby|rails|dotnet|java|export\s+)",
            flags=re.IGNORECASE,
        )
        if command_prefix.match(candidate):
            return True
        return " && " in candidate or " || " in candidate

    def _extract_run_commands(lines: list[str]) -> list[str]:
        commands: list[str] = []
        seen: set[str] = set()
        in_code_block = False

        for raw_line in lines:
            stripped = raw_line.strip()
            if stripped.startswith("```"):
                in_code_block = not in_code_block
                continue
            cleaned = _clean_bullet_prefix(stripped)
            cleaned = re.sub(r"^\$\s*", "", cleaned).strip()
            if not cleaned:
                continue
            if in_code_block or _looks_like_command(cleaned):
                norm = re.sub(r"\s+", " ", cleaned).strip()
                key = norm.lower()
                if key in seen:
                    continue
                seen.add(key)
                commands.append(norm)
                if len(commands) >= 20:
                    break
        return commands

    section_heading = re.compile(
        r"^\s*(?:#{1,6}\s*)?(outcome|summary|deliverables?|artifacts?|validation|run commands?|commands?|open links?|links?|next steps?|next actions?|risks?)\s*:?\s*(.*)$",
        flags=re.IGNORECASE,
    )
    sections: dict[str, list[str]] = {
        "summary": [],
        "deliverables": [],
        "validation": [],
        "run_commands": [],
        "open_links": [],
        "next_actions": [],
        "risks": [],
        "body": [],
    }
    all_lines_raw = [line for line in raw.splitlines() if line.strip()]
    all_lines = [_clean_bullet_prefix(line) for line in all_lines_raw if _clean_bullet_prefix(line)]
    current_section = "body"
    for raw_line in all_lines_raw:
        stripped = raw_line.strip()
        heading = section_heading.match(stripped)
        if heading:
            current_section = _section_name(heading.group(1))
            remainder = _clean_bullet_prefix(heading.group(2))
            if remainder:
                sections[current_section].append(remainder)
            continue
        sections[current_section].append(stripped)

    summary_source = sections["summary"] or all_lines
    summary = summary_source[0] if summary_source else raw[:240]
    delegations: list[dict[str, str]] = []
    risks: list[str] = []
    next_actions: list[str] = []
    validation: list[str] = []
    for line in all_lines:
        lower = line.lower()
        if "delegat" in lower:
            delegations.append({"agent": "team", "why": line, "action": line})
        if "risk" in lower or "concern" in lower or "blocker" in lower:
            risks.append(line)
        if lower.startswith(("next", "do ", "run ", "create ", "update ", "verify ")):
            next_actions.append(line)
        if any(token in lower for token in ("passed", "pass", "validated", "verified", "success", "checks", "check ", "tests", "lint", "build")):
            validation.append(line)

    section_risks = [_clean_bullet_prefix(line) for line in sections["risks"] if _clean_bullet_prefix(line)]
    section_next = [_clean_bullet_prefix(line) for line in sections["next_actions"] if _clean_bullet_prefix(line)]
    section_validation = [_clean_bullet_prefix(line) for line in sections["validation"] if _clean_bullet_prefix(line)]
    deliverable_source = sections["deliverables"] if sections["deliverables"] else all_lines_raw
    deliverables = _extract_link_items(deliverable_source)
    run_source = sections["run_commands"] if sections["run_commands"] else all_lines_raw
    run_commands = _extract_run_commands(run_source)
    open_link_source = sections["open_links"] if sections["open_links"] else (sections["deliverables"] or all_lines_raw)
    open_links = _extract_link_items(open_link_source)

    def _unique(items: list[str], limit: int = 10) -> list[str]:
        seen: set[str] = set()
        result: list[str] = []
        for item in items:
            normalized = re.sub(r"\s+", " ", item.strip()).lower()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            result.append(item.strip())
            if len(result) >= limit:
                break
        return result

    def _unique_link_items(items: list[dict[str, str]], limit: int = 12) -> list[dict[str, str]]:
        seen: set[str] = set()
        result: list[dict[str, str]] = []
        for item in items:
            target = str(item.get("target", "") or "").strip()
            if not target:
                continue
            key = target.lower()
            if key in seen:
                continue
            seen.add(key)
            result.append(item)
            if len(result) >= limit:
                break
        return result

    completion_kind = "general"
    lower_raw = raw.lower()
    has_completion_sections = bool(sections["run_commands"]) and bool(
        sections["summary"]
        or sections["deliverables"]
        or sections["validation"]
        or sections["open_links"]
        or sections["next_actions"]
    )
    completion_markers = (
        "build complete",
        "build completed",
        "implementation complete",
        "implementation completed",
        "execution complete",
        "execution completed",
        "delivery complete",
        "delivery completed",
        "release handoff",
        "project handoff",
        "ready to run",
        "shipped",
        "delivered",
        "final handoff",
    )
    has_completion_phrase = any(marker in lower_raw for marker in completion_markers)
    has_delivery_evidence = bool(run_commands) and bool(
        deliverables or open_links or section_validation or validation or section_next
    )
    if has_delivery_evidence and (has_completion_sections or has_completion_phrase):
        completion_kind = "build_complete"

    return {
        "summary": summary,
        "delegations": delegations[:10],
        "risks": _unique(section_risks + risks, limit=10),
        "next_actions": _unique(section_next + next_actions, limit=10),
        "deliverables": _unique_link_items(deliverables, limit=20),
        "validation": _unique(section_validation + validation, limit=10),
        "run_commands": _unique(run_commands, limit=12),
        "open_links": _unique_link_items(open_links + deliverables, limit=12),
        "completion_kind": completion_kind,
    }


def _merge_structured_completion_with_project(
    structured: dict[str, Any],
    project: dict[str, Any] | None,
) -> dict[str, Any]:
    """Merge structured chat payload with project run/open hints."""
    payload = copy.deepcopy(structured or {})
    project_info = project if isinstance(project, dict) else {}

    def _normalize_string_list(value: Any, *, limit: int = 12) -> list[str]:
        seen: set[str] = set()
        result: list[str] = []
        if not isinstance(value, list):
            return result
        for raw_item in value:
            item = str(raw_item or "").strip()
            key = re.sub(r"\s+", " ", item).lower()
            if not item or key in seen:
                continue
            seen.add(key)
            result.append(item)
            if len(result) >= limit:
                break
        return result

    def _normalize_links(value: Any, *, limit: int = 12) -> list[dict[str, str]]:
        seen: set[str] = set()
        result: list[dict[str, str]] = []
        if not isinstance(value, list):
            return result
        for raw_item in value:
            if not isinstance(raw_item, dict):
                continue
            target = str(raw_item.get("target", "") or "").strip()
            if not target:
                continue
            key = target.lower()
            if key in seen:
                continue
            seen.add(key)
            label = str(raw_item.get("label", "") or "").strip() or target
            kind = "url" if re.match(r"^https?://", target, flags=re.IGNORECASE) else "path"
            result.append({"label": label, "target": target, "kind": kind})
            if len(result) >= limit:
                break
        return result

    completion_kind = str(payload.get("completion_kind", "") or "").strip().lower()
    if completion_kind not in {"build_complete", "general"}:
        completion_kind = "general"

    base_commands = _normalize_string_list(payload.get("run_commands"))
    if completion_kind == "build_complete" and not base_commands:
        completion_kind = "general"
    is_build_complete = completion_kind == "build_complete"
    payload["run_commands"] = base_commands
    base_links = _normalize_links(payload.get("open_links"))
    deliverable_links = _normalize_links(payload.get("deliverables"), limit=20)
    payload["open_links"] = _normalize_links(base_links + deliverable_links, limit=20)

    if is_build_complete:
        run_instructions = str(project_info.get("run_instructions", "") or "").strip()
        parsed_run = _structured_response_payload(run_instructions) if run_instructions else {}
        project_commands = _normalize_string_list(parsed_run.get("run_commands"))
        payload["run_commands"] = _normalize_string_list(base_commands + project_commands)

        project_links = _normalize_links(parsed_run.get("open_links"))
        merged_links = _normalize_links(base_links + project_links + deliverable_links, limit=20)
        workspace_path = str(project_info.get("workspace_path", "") or "").strip()
        if workspace_path:
            merged_links = _normalize_links(
                merged_links + [{"label": "Workspace Path", "target": workspace_path, "kind": "path"}],
                limit=20,
            )
        github_repo = str(project_info.get("github_repo", "") or "").strip()
        if github_repo:
            merged_links = _normalize_links(
                merged_links + [{"label": "GitHub Repository", "target": f"https://github.com/{github_repo}", "kind": "url"}],
                limit=20,
            )
        payload["open_links"] = merged_links

    payload["completion_kind"] = completion_kind
    return payload


def _normalize_unique_strings(values: Any, *, limit: int = 12) -> list[str]:
    if not isinstance(values, list):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for raw_item in values:
        item = str(raw_item or "").strip()
        key = re.sub(r"\s+", " ", item).lower()
        if not item or key in seen:
            continue
        seen.add(key)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def _is_ui_execution_turn(message: str) -> bool:
    text = (message or "").lower()
    ui_markers = (
        "app",
        "ui",
        "ux",
        "frontend",
        "dashboard",
        "landing page",
        "website",
        "mobile",
        "screen",
    )
    return any(marker in text for marker in ui_markers)


def _is_backend_or_infra_only_turn(message: str) -> bool:
    text = (message or "").lower()
    if not text:
        return False
    ui_markers = (
        "ui",
        "ux",
        "frontend",
        "design",
        "dashboard",
        "page",
        "layout",
        "theme",
    )
    backend_markers = (
        "backend",
        "api",
        "database",
        "schema",
        "migration",
        "infra",
        "devops",
        "kubernetes",
        "terraform",
        "pipeline",
        "ci/cd",
        "server",
        "service",
    )
    has_ui = any(marker in text for marker in ui_markers)
    has_backend = any(marker in text for marker in backend_markers)
    return has_backend and not has_ui


def _build_project_team_snapshot(
    project_id: str,
    *,
    project: dict[str, Any] | None,
    support_agents: list[str],
    structured: dict[str, Any],
    config: dict[str, Any],
) -> list[str]:
    existing_team = [
        str(member).strip()
        for member in list((project or {}).get("team") or [])
        if str(member).strip()
    ]
    inferred_team = list(existing_team)
    inferred_team.append(_configured_agent_name("ceo", config))

    for agent_id in support_agents:
        if agent_id in AGENT_REGISTRY:
            inferred_team.append(_configured_agent_name(agent_id, config))

    delegations = structured.get("delegations")
    if isinstance(delegations, list):
        for row in delegations:
            if not isinstance(row, dict):
                continue
            agent_name = str(row.get("agent", "") or "").strip()
            if not agent_name or agent_name.lower() == "team":
                continue
            inferred_team.append(agent_name)

    for task in task_board.get_board(project_id):
        assignee = str(task.get("assigned_to", "") or "").strip()
        if assignee:
            inferred_team.append(assignee)

    return _ordered_unique(inferred_team)


def _sync_project_completion_snapshot(
    project_id: str,
    *,
    project: dict[str, Any] | None,
    structured: dict[str, Any],
    support_agents: list[str],
    config: dict[str, Any],
) -> dict[str, Any] | None:
    if not project_id:
        return project
    current = project or state_manager.get_project(project_id)
    if not isinstance(current, dict):
        return project

    updates: dict[str, Any] = {}

    summary = str(structured.get("summary", "") or "").strip()
    if summary and summary != str(current.get("description", "") or "").strip():
        updates["description"] = summary

    completion_kind = str(structured.get("completion_kind", "") or "").strip().lower()
    run_commands = _normalize_unique_strings(structured.get("run_commands"), limit=16)
    if completion_kind == "build_complete" and run_commands:
        run_instructions = "\n".join(run_commands)
        if run_instructions != str(current.get("run_instructions", "") or "").strip():
            updates["run_instructions"] = run_instructions

    team_snapshot = _build_project_team_snapshot(
        project_id,
        project=current,
        support_agents=support_agents,
        structured=structured,
        config=config,
    )
    if team_snapshot and team_snapshot != [str(member).strip() for member in list(current.get("team") or []) if str(member).strip()]:
        updates["team"] = team_snapshot

    if not updates:
        return current

    updated = state_manager.update_project(project_id, updates)
    if updated:
        _emit_chat_activity(
            "ceo",
            "UPDATED",
            "Project summary synchronized from completion output.",
            project_id=project_id,
            metadata={"fields": sorted(updates.keys())},
        )
        return state_manager.get_project(project_id) or current
    return current


def _looks_like_launch_command(command: str) -> bool:
    lower = command.strip().lower()
    if not lower:
        return False
    hints = (
        "npm run dev",
        "npm start",
        "npm run start",
        "npm run preview",
        "pnpm dev",
        "pnpm start",
        "yarn dev",
        "yarn start",
        "bun run dev",
        "bun start",
        "uvicorn ",
        "flask run",
        "streamlit run",
        "next dev",
        "vite",
        "serve",
        "make run",
        "make dev",
        "docker compose up",
    )
    return any(hint in lower for hint in hints)


def _is_safe_auto_launch_command(command: str) -> bool:
    value = str(command or "").strip()
    if not value:
        return False
    blocked_tokens = ("&&", "||", ";", "|", "`", "$(", "\n", "\r", ">", "<")
    if any(token in value for token in blocked_tokens):
        return False
    try:
        parts = shlex.split(value)
    except ValueError:
        return False
    if not parts:
        return False
    binary = parts[0].lower()

    if binary in {"npm", "pnpm", "yarn", "bun"}:
        return any(token in {"dev", "start", "preview"} for token in [part.lower() for part in parts[1:]])
    if binary in {"uvicorn"}:
        return True
    if binary == "flask":
        return len(parts) > 1 and parts[1].lower() == "run"
    if binary == "streamlit":
        return len(parts) > 1 and parts[1].lower() == "run"
    if binary == "make":
        return len(parts) > 1 and parts[1].lower() in {"run", "dev", "start", "serve"}
    if binary in {"python", "python3"}:
        blocked_args = {"-c", "-m"}
        return len(parts) > 1 and parts[1] not in blocked_args
    return False


def _extract_preferred_open_url(structured: dict[str, Any], project: dict[str, Any] | None = None) -> str:
    def _sanitize_url_candidate(raw_target: str) -> str:
        value = str(raw_target or "").strip()
        if not value:
            return ""
        # Accept noisy labels like "Open app: http://localhost:5173**"
        # and normalize trailing markdown punctuation.
        match = re.search(r"https?://[^\s)\]>]+", value, flags=re.IGNORECASE)
        candidate = match.group(0) if match else value
        candidate = candidate.strip().strip("'\"`")
        candidate = re.sub(r"[*_~`]+$", "", candidate)
        candidate = candidate.rstrip(".,);!?]>")
        if not re.match(r"^https?://", candidate, flags=re.IGNORECASE):
            return ""
        return candidate

    links: list[str] = []
    for key in ("open_links", "deliverables"):
        value = structured.get(key)
        if not isinstance(value, list):
            continue
        for row in value:
            if not isinstance(row, dict):
                continue
            target = _sanitize_url_candidate(str(row.get("target", "") or ""))
            if target:
                links.append(target)
    for target in links:
        parsed = urllib.parse.urlparse(target)
        host = (parsed.hostname or "").lower()
        if host in {"localhost", "127.0.0.1", "::1"}:
            return target
    if links:
        return links[0]

    run_notes = str((project or {}).get("run_instructions", "") or "")
    match = re.search(r"https?://[^\s)\]>]+", run_notes)
    return _sanitize_url_candidate(match.group(0)) if match else ""


def _resolve_autostart_command(
    structured: dict[str, Any],
    project: dict[str, Any] | None = None,
) -> tuple[str, str]:
    workspace_path = str((project or {}).get("workspace_path", "") or "").strip()
    workspace_realpath = os.path.realpath(workspace_path) if workspace_path else ""
    active_cwd = workspace_realpath if workspace_realpath and os.path.isdir(workspace_realpath) else workspace_path

    def _resolve_cd_target(raw_command: str, current_cwd: str) -> str:
        try:
            parts = shlex.split(raw_command)
        except ValueError:
            return current_cwd
        if len(parts) < 2 or parts[0].lower() != "cd":
            return current_cwd
        target = str(parts[1] or "").strip()
        if not target:
            return current_cwd
        if os.path.isabs(target):
            candidate = os.path.realpath(target)
        else:
            base = current_cwd or workspace_realpath or workspace_path
            candidate = os.path.realpath(os.path.join(base, target))
        if not os.path.isdir(candidate):
            return current_cwd
        if workspace_realpath:
            prefix = f"{workspace_realpath}{os.sep}"
            if candidate != workspace_realpath and not candidate.startswith(prefix):
                return current_cwd
        return candidate

    primary_commands = _normalize_unique_strings(structured.get("run_commands"), limit=16)
    if not primary_commands:
        parsed = _structured_response_payload(str((project or {}).get("run_instructions", "") or ""))
        primary_commands = _normalize_unique_strings(parsed.get("run_commands"), limit=16)

    for command in primary_commands:
        if command.strip().lower().startswith("cd "):
            active_cwd = _resolve_cd_target(command.strip(), active_cwd)
            continue
        if _looks_like_launch_command(command):
            return command, active_cwd
    return "", active_cwd


def _attempt_local_project_autostart(
    *,
    project: dict[str, Any] | None,
    structured: dict[str, Any],
    run_id: str,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "attempted": False,
        "started": False,
        "command": "",
        "message": "",
    }
    if not isinstance(project, dict):
        return result
    if str(project.get("delivery_mode", "local") or "local").strip().lower() != "local":
        return result
    if str(structured.get("completion_kind", "general") or "general").strip().lower() != "build_complete":
        return result

    command, command_cwd = _resolve_autostart_command(structured, project)
    if not command:
        return result

    result["attempted"] = True
    result["command"] = command

    if not _is_safe_auto_launch_command(command):
        result["message"] = "Auto-start command was blocked by safety rules."
        return result

    workspace_path = str(project.get("workspace_path", "") or "").strip()
    if not workspace_path or not os.path.isdir(workspace_path):
        result["message"] = "Auto-start skipped because workspace path is unavailable."
        return result

    runtime_cwd = command_cwd if command_cwd and os.path.isdir(command_cwd) else workspace_path

    try:
        argv = shlex.split(command)
        if not argv:
            result["message"] = "Auto-start skipped because no command arguments were parsed."
            return result
        subprocess.Popen(  # noqa: S603
            argv,
            cwd=runtime_cwd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        result["started"] = True
        open_url = _extract_preferred_open_url(structured, project)
        if open_url:
            result["open_url"] = open_url
        result["message"] = "App start command executed."
        _emit_chat_activity(
            "ceo",
            "STARTED",
            f"Auto-start command executed: {command[:160]} (cwd: {runtime_cwd[:160]})",
            project_id=str(project.get("id", "") or ""),
            metadata={"run_id": run_id, "workspace_path": workspace_path, "runtime_cwd": runtime_cwd, "auto_launch": True},
        )
    except Exception as exc:
        result["message"] = f"Auto-start failed: {str(exc)[:180]}"
    return result


def _build_run_replay_summary(run_id: str, project_id: str) -> str:
    """Build a concise replay summary from run timeline + workforce context."""
    run = run_service.get_run(run_id) if run_id else None
    if not isinstance(run, dict):
        return ""
    timeline = run.get("timeline", [])
    labels: list[str] = []
    if isinstance(timeline, list):
        for row in timeline[-5:]:
            if not isinstance(row, dict):
                continue
            label = str(row.get("label", "") or row.get("state", "") or "").strip()
            if label:
                labels.append(label)
    workforce = workforce_presence_service.snapshot(
        project_id=project_id or None,
        include_assigned=True,
        include_reporting=True,
    )
    workers = workforce.get("workers", []) if isinstance(workforce, dict) else []
    active: list[str] = []
    if isinstance(workers, list):
        for row in workers[:3]:
            if not isinstance(row, dict):
                continue
            name = str(row.get("agent_name", "") or row.get("agent_id", "") or "").strip()
            state = str(row.get("state", "") or "").strip().lower()
            if name:
                active.append(f"{name} ({state or 'working'})")
    sections: list[str] = []
    if labels:
        sections.append(f"Recent milestones: {'; '.join(labels)}.")
    if active:
        sections.append(f"Latest active agents: {', '.join(active)}.")
    return " ".join(sections).strip()


def _completion_celebration_payload(
    *,
    run_id: str,
    project_id: str,
    structured: dict[str, Any] | None,
    config: dict[str, Any],
    terminal_state: str,
) -> dict[str, Any] | None:
    ui_cfg = config.get("ui", {}) if isinstance(config.get("ui"), dict) else {}
    enabled = bool(ui_cfg.get("completion_celebration_enabled", True))
    mode = str(ui_cfg.get("completion_celebration_mode", "subtle_burst") or "subtle_burst").strip().lower()
    completion_kind = str((structured or {}).get("completion_kind", "") or "").strip().lower()
    eligible = (
        enabled
        and terminal_state == "done"
        and completion_kind == "build_complete"
        and bool(run_id and project_id)
    )
    if not eligible:
        return None
    if mode != "subtle_burst":
        mode = "subtle_burst"
    return {
        "eligible": True,
        "kind": mode,
        "run_id": run_id,
        "project_id": project_id,
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
    task_text = str(normalized.get("task", "") or "").strip()

    run_id = str(normalized.get("run_id", "") or "").strip()
    if run_id:
        normalized["run_id"] = run_id

    if project_id and not normalized.get("project_id"):
        normalized["project_id"] = project_id
    scoped_project_id = str(normalized.get("project_id", "") or "").strip()

    source = str(normalized.get("source", "") or "").strip().lower()
    if source not in {"real", "synthetic"}:
        source = "synthetic" if str(normalized.get("tool", "") or "").strip().lower() == "synthetic_delegation" else "real"
    normalized["source"] = source

    work_state = str(normalized.get("work_state", "") or "").strip().lower()
    if work_state not in {"assigned", "working", "reporting", "blocked", "completed", "failed"}:
        if action_upper in {"BLOCKED", "ERROR", "FAILED"} or state == "failed":
            work_state = "blocked"
        elif action_upper in {"COMPLETED", "DONE"} or state == "completed":
            work_state = "completed"
        elif action_upper == "UPDATED" and flow == "up" and source_agent and source_agent != "ceo":
            work_state = "reporting"
        elif action_upper in {"DELEGATED", "ASSIGNED"}:
            work_state = "assigned"
        elif state == "started":
            if source_agent and source_agent not in {"ceo", "system", "workspace"}:
                work_state = "working"
            else:
                work_state = "assigned" if flow == "down" else "working"
        elif flow == "up" and source_agent and source_agent != "ceo":
            work_state = "reporting"
        else:
            work_state = "working"
    normalized["work_state"] = work_state

    work_item_id = str(normalized.get("work_item_id", "") or "").strip()
    if not work_item_id:
        preferred_agent = ""
        if work_state == "assigned":
            preferred_agent = target_agent
        elif work_state in {"working", "reporting", "blocked", "completed", "failed"}:
            preferred_agent = source_agent
        if not preferred_agent:
            preferred_agent = source_agent or target_agent or str(agent or "").strip().lower()
        preferred_agent = preferred_agent.replace(" ", "-")
        if run_id and preferred_agent:
            work_item_id = f"{run_id}:{preferred_agent}"
        elif scoped_project_id and preferred_agent:
            task_hash = hashlib.sha1(task_text.encode("utf-8")).hexdigest()[:12] if task_text else "notask"
            work_item_id = f"{scoped_project_id}:{preferred_agent}:{task_hash}"
    if work_item_id:
        normalized["work_item_id"] = work_item_id

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
    event_payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agent": str(agent or ""),
        "action": str(action or ""),
        "detail": str(detail or ""),
        "project_id": normalized_project_id,
        "metadata": normalized_metadata,
    }
    emit_activity(
        DATA_DIR,
        event_payload["agent"],
        event_payload["action"],
        event_payload["detail"],
        project_id=normalized_project_id,
        metadata=normalized_metadata,
    )
    workforce_presence_service.ingest_event(event_payload)


def _transition_run_state(
    run_id: str,
    *,
    state: str,
    label: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Transition run state and keep workforce presence in sync."""
    transitioned = run_service.transition_run(
        run_id,
        state=state,
        label=label,
        metadata=metadata,
    )
    normalized_state = str(state or "").strip().lower()
    if transitioned and normalized_state in {"done", "failed", "cancelled"}:
        workforce_presence_service.mark_run_terminal(
            str(transitioned.get("id", "") or run_id),
            project_id=str(transitioned.get("project_id", "") or ""),
            terminal_state=normalized_state,
        )
    return transitioned


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
    (("research", "investigate", "analyze", "analysis", "compare", "strategy", "discovery"), "chief-researcher"),
    (("product", "requirements", "prioritization", "backlog", "roadmap", "user story", "prd"), "vp-product"),
    (("frontend", "ui", "ux", "web", "page", "canvas", "css", "react", "component", "responsive"), "lead-frontend"),
    (("backend", "api", "server", "database", "endpoint", "auth", "service", "graphql", "webhook"), "lead-backend"),
    (("design", "layout", "theme", "branding", "copy", "wireframe", "prototype"), "lead-designer"),
    (("test", "qa", "bug", "regression", "edge case", "smoke test", "e2e", "acceptance"), "qa-lead"),
    (("deploy", "release", "vercel", "docker", "infra", "ci", "cd", "pipeline", "kubernetes", "terraform"), "devops"),
    (("security", "token", "oauth", "permission", "rbac", "sso", "vulnerability", "threat model"), "security-engineer"),
    (("data", "analytics", "metric", "dashboard", "etl", "warehouse", "instrumentation", "schema"), "data-engineer"),
    (("readme", "guide", "documentation", "docs", "handoff", "runbook", "playbook", "changelog"), "tech-writer"),
)

_SUPPORT_AGENT_TASKS: dict[str, str] = {
    "chief-researcher": "Validate scope assumptions and identify implementation constraints.",
    "cto": "Confirm architecture and quality gates for the implementation.",
    "vp-product": "Define product requirements, milestones, and success criteria.",
    "vp-engineering": "Break implementation into concrete engineering workstreams.",
    "lead-frontend": "Implement user-facing UI flow and interaction logic.",
    "lead-backend": "Implement server/data logic and integration endpoints.",
    "lead-designer": "Shape purpose-driven UX direction, visual hierarchy, and interaction patterns tied to user workflow.",
    "qa-lead": "Define validation checks and run functional regression pass.",
    "devops": "Prepare local run instructions and deployment path.",
    "security-engineer": "Review security-sensitive surfaces and constraints.",
    "data-engineer": "Implement telemetry, analytics, or data wiring.",
    "tech-writer": "Document setup, activation, and project handoff.",
}

_DELEGATION_ROLE_REASONS: dict[str, str] = {
    "chief-researcher": "Assess feasibility, unknowns, and tradeoffs before committing execution scope.",
    "vp-product": "Define requirements, milestones, and success criteria for delivery.",
    "cto": "Validate architecture direction and quality constraints up front.",
    "vp-engineering": "Break work into implementation streams and assign execution ownership.",
    "lead-frontend": "Own user-facing flow and frontend implementation details.",
    "lead-backend": "Own backend APIs, service logic, and integration contracts.",
    "lead-designer": "Ensure the UI direction is purpose-driven for target users, with clear interaction patterns and strong visual hierarchy.",
    "qa-lead": "Drive validation strategy, regression coverage, and acceptance confidence.",
    "devops": "Prepare release path, environments, and operational reliability checks.",
    "security-engineer": "Review security-sensitive surfaces and permission boundaries.",
    "data-engineer": "Shape analytics, instrumentation, and data-layer implementation.",
    "tech-writer": "Prepare activation guidance and handoff documentation.",
}

_EXECUTIVE_ALIGNMENT_AGENTS: tuple[str, ...] = (
    "chief-researcher",
    "vp-product",
    "cto",
    "vp-engineering",
)

_EARLY_PROJECT_STATUSES: set[str] = {
    "",
    "planning",
    "draft",
    "discovery",
    "scoping",
}

_VALIDATION_PROJECT_STATUSES: set[str] = {
    "review",
    "qa",
    "validation",
    "release",
    "handoff",
    "ready-for-release",
    "stabilization",
    "done",
}

_VALIDATION_STAGE_HINTS: tuple[str, ...] = (
    "qa",
    "test",
    "verify",
    "validation",
    "regression",
    "bugfix",
    "release",
    "ship",
    "handoff",
    "document",
    "docs",
    "checklist",
    "uat",
    "user acceptance",
    "release notes",
    "go/no-go",
    "signoff",
    "staging",
    "rc",
    "bug bash",
    "hardening",
)

_DISCOVERY_SCOPING_HINTS: tuple[str, ...] = (
    "understand",
    "difficulty",
    "difficult",
    "effort",
    "estimate",
    "feasibility",
    "feasible",
    "complexity",
    "how long",
    "how hard",
    "rough order of magnitude",
    "rom",
    "ballpark",
    "scope",
    "timeline",
    "milestone",
    "requirements",
    "tradeoff",
    "what would it take",
)


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


def _is_validation_stage(
    user_message: str,
    *,
    intent_class: str,
    project: dict | None = None,
) -> bool:
    if intent_class == "review":
        return True
    status = str((project or {}).get("status", "") or "").strip().lower()
    if status in _VALIDATION_PROJECT_STATUSES:
        return True
    text = (user_message or "").lower()
    return _contains_keyword(text, _VALIDATION_STAGE_HINTS)


def _infer_support_agents(
    user_message: str,
    *,
    intent: dict[str, Any] | None = None,
    project: dict | None = None,
    config: dict | None = None,
) -> list[str]:
    """Infer specialist involvement using stage-aware delegation defaults."""
    text = (user_message or "").lower()
    profile = intent or _classify_execution_intent(user_message)
    intent_class = str(profile.get("class", "") or "")
    actionable = bool(profile.get("actionable"))
    delegate_allowed = bool(profile.get("delegate_allowed"))
    if intent_class in {"greeting", "clarification", "status"} or not actionable or not delegate_allowed:
        return []

    chat_policy = config.get("chat_policy", {}) if isinstance(config, dict) and isinstance(config.get("chat_policy"), dict) else {}
    strategy = str(chat_policy.get("delegation_strategy", "executive_first") or "executive_first").strip().lower()
    if strategy not in {"executive_first", "balanced", "direct"}:
        strategy = "executive_first"
    include_qa_docs_early = bool(chat_policy.get("delegation_include_qa_docs_early", False))
    try:
        max_agents = int(chat_policy.get("delegation_max_agents", 4) or 4)
    except (TypeError, ValueError):
        max_agents = 4
    max_agents = max(1, min(6, max_agents))

    keyword_inferred: list[str] = []
    for keywords, agent_id in _SUPPORT_AGENT_HINTS:
        if _contains_keyword(text, keywords):
            keyword_inferred.append(agent_id)

    inferred: list[str] = []

    if intent_class == "planning":
        inferred.extend(_EXECUTIVE_ALIGNMENT_AGENTS)
        inferred.extend(keyword_inferred)

    if str(profile.get("intent", "")) == "execution":
        status = str((project or {}).get("status", "") or "").strip().lower()
        early_stage = status in _EARLY_PROJECT_STATUSES
        validation_stage = _is_validation_stage(
            user_message,
            intent_class=intent_class,
            project=project,
        )
        plan_approved = bool((project or {}).get("plan_approved"))
        alignment_stage = strategy == "executive_first" and not validation_stage and (not plan_approved or early_stage)

        if strategy == "direct":
            inferred.extend(keyword_inferred)
        elif alignment_stage:
            # First pass on new/scoping projects: executive alignment before
            # pushing implementation/QA/doc handoffs to execution leads.
            inferred.extend(_EXECUTIVE_ALIGNMENT_AGENTS)
            inferred.extend(keyword_inferred)
            if include_qa_docs_early:
                inferred.extend(["qa-lead", "tech-writer"])
        elif validation_stage:
            inferred.extend(keyword_inferred)
            inferred.extend(["qa-lead", "tech-writer"])
            if strategy == "balanced":
                inferred.append("vp-engineering")
        else:
            inferred.extend(keyword_inferred)
            # Delivery stage defaults: route through implementation leadership.
            if not any(agent in inferred for agent in ("lead-frontend", "lead-backend", "devops")):
                inferred.append("vp-engineering")
            if strategy == "balanced":
                inferred.append("qa-lead")
                inferred.append("tech-writer")
        # Purpose-driven product builds should include design leadership by default,
        # except when request scope is explicitly backend/infra-only.
        if _is_ui_execution_turn(user_message) and not _is_backend_or_infra_only_turn(user_message):
            inferred.append("lead-designer")
    elif intent_class != "planning":
        inferred.extend(keyword_inferred)

    ordered = [
        agent_id
        for agent_id in _ordered_unique(inferred)
        if agent_id in AGENT_REGISTRY and agent_id != "ceo"
    ]
    # Cap concurrent delegation to reduce noise and over-orchestration.
    return ordered[:max_agents]


def _build_delegation_reasoning(
    user_message: str,
    *,
    intent: dict[str, Any] | None,
    project: dict | None,
    config: dict,
    support_agents: list[str],
) -> dict[str, Any]:
    """Summarize why the CEO selected specific delegates for this turn."""
    if not support_agents:
        return {"stage": "none", "summary": "", "reasons": []}

    profile = intent or _classify_execution_intent(user_message)
    intent_class = str(profile.get("class", "") or "")
    chat_policy = config.get("chat_policy", {}) if isinstance(config.get("chat_policy"), dict) else {}
    strategy = str(chat_policy.get("delegation_strategy", "executive_first") or "executive_first").strip().lower()
    if strategy not in {"executive_first", "balanced", "direct"}:
        strategy = "executive_first"

    status = str((project or {}).get("status", "") or "").strip().lower()
    early_stage = status in _EARLY_PROJECT_STATUSES
    plan_approved = bool((project or {}).get("plan_approved"))
    validation_stage = _is_validation_stage(
        user_message,
        intent_class=intent_class,
        project=project,
    )
    alignment_stage = strategy == "executive_first" and not validation_stage and (not plan_approved or early_stage)

    if intent_class == "planning" or alignment_stage:
        stage = "executive_alignment"
        summary = "Executive alignment first: scope, requirements, and architecture are clarified before delivery handoffs."
    elif validation_stage:
        stage = "validation_handoff"
        summary = "Validation and handoff stage: QA confidence and documentation completeness are prioritized."
    else:
        stage = "delivery_execution"
        summary = "Delivery execution stage: implementation owners are engaged to ship scoped work."

    reasons = []
    for agent_id in support_agents:
        reasons.append({
            "agent_id": agent_id,
            "agent_name": _configured_agent_name(agent_id, config),
            "reason": _DELEGATION_ROLE_REASONS.get(
                agent_id,
                "Specialist execution support selected for this stage.",
            ),
        })
    return {"stage": stage, "summary": summary, "reasons": reasons}


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
                    f"{_configured_agent_name(agent_id, config)} - {_headline_from_description(_agent_task_summary(agent_id, user_message)) or 'Implementation milestone'}",
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


def _emit_planning_stage_assignments(
    *,
    project_id: str,
    run_id: str,
    user_message: str,
    support_agents: list[str],
    config: dict,
    delegation_stage: str = "",
) -> None:
    """Emit synthetic assignment evidence for planning-gated turns.

    Planning-gated runs stop before provider runtime handlers execute, so
    support-agent selection would otherwise be invisible in live workforce UI.
    These entries are "assigned" only and clear when the run reaches a
    terminal state.
    """
    normalized_project_id = _normalize_project_id(project_id)
    if not normalized_project_id:
        return

    for agent_id in _ordered_unique(list(support_agents or [])):
        if agent_id not in AGENT_REGISTRY or agent_id == "ceo":
            continue
        task = _agent_task_summary(agent_id, user_message)[:280]
        agent_name = _configured_agent_name(agent_id, config)
        work_item_id = f"{run_id}:{agent_id}" if run_id else ""
        detail = f"Delegating to {agent_name}: {task[:140]}"
        _emit_chat_activity(
            "ceo",
            "DELEGATED",
            detail,
            project_id=normalized_project_id,
            metadata={
                "run_id": run_id,
                "source_agent": "ceo",
                "target_agent": agent_id,
                "flow": "down",
                "task": task,
                "source": "synthetic",
                "tool": "synthetic_delegation",
                "work_state": "assigned",
                "work_item_id": work_item_id,
                "delegation_stage": delegation_stage,
            },
        )


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
        work_item_id = f"{run_id}:{agent_id}" if run_id and agent_id else ""
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
                "source": "synthetic",
                "work_state": "assigned",
                "work_item_id": work_item_id,
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
                "source": "synthetic",
                "work_state": "assigned",
                "work_item_id": work_item_id,
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


def _is_incomplete_clarification_stub(text: str) -> bool:
    """Detect partial clarification stubs that block non-interactive chat flows."""
    raw = (text or "").strip()
    if not raw:
        return False
    normalized = re.sub(r"\s+", " ", raw).strip().lower()
    markers = (
        "before i mobilize the team",
        "i need to understand a few things",
        "i need to understand a few details",
        "i have a few questions",
    )
    if not any(marker in normalized for marker in markers):
        return False
    has_follow_up_list = bool(re.search(r"\n\s*(?:[-*]|\d+[.)])\s+\S+", raw))
    question_count = raw.count("?")
    if raw.endswith(":") and not has_follow_up_list:
        return True
    if normalized.endswith("a few things") and question_count == 0 and not has_follow_up_list:
        return True
    return False


def _is_passive_waiting_response(text: str) -> bool:
    """Detect passive handoff replies that end without concrete execution follow-through."""
    raw = (text or "").strip()
    if not raw:
        return False
    normalized = re.sub(r"\s+", " ", raw).strip().lower().replace("’", "'")
    passive_markers = (
        "standing by",
        "i'll wait",
        "i will wait",
        "once they finish",
        "once they deliver",
        "wait for both",
        "wait for them",
        "before briefing",
        "before i brief",
        "report back when",
        "working in parallel",
        "they're all running in parallel",
        "all three teams are actively working",
    )
    if not any(marker in normalized for marker in passive_markers):
        return False
    actionable_markers = (
        "outcome",
        "deliverables",
        "validation",
        "run commands",
        "open links",
        "next steps",
        "build complete",
        "completed",
        "implemented",
        "created",
        "activation guide",
        "handoff",
        "npm run",
        "open app",
        "http://",
        "https://",
    )
    has_actionable = any(marker in normalized for marker in actionable_markers)
    has_action_list = bool(re.search(r"\n\s*(?:[-*]|\d+[.)])\s+\S+", raw))
    has_code_block = "```" in raw
    if has_actionable or has_action_list or has_code_block:
        return False
    if normalized.endswith(":"):
        return False
    return True


def _build_active_management_retry_prompt(
    original_prompt: str,
    prior_response: str,
    *,
    attempt: int,
    max_attempts: int,
) -> str:
    """Build a strict retry prompt when Claude returns passive waiting language."""
    safe_attempt = max(1, int(attempt))
    safe_max = max(safe_attempt, int(max_attempts))
    prior_excerpt = (prior_response or "").strip()[:1200]
    prefix = (
        f"[ACTIVE MANAGEMENT RETRY {safe_attempt}/{safe_max}: NON-INTERACTIVE DASHBOARD MODE. "
        "Do not end with waiting language. Do not say standing by. "
        "If teams are parallel, continue immediately by collecting outputs, integrating decisions, "
        "and driving execution to the next concrete milestone in this same turn.]"
    )
    return (
        f"{prefix}\n\n"
        "Prior passive reply to replace:\n"
        f"{prior_excerpt}\n\n"
        "Now continue actively and produce a concrete execution update.\n\n"
        f"{original_prompt}"
    )


def _build_passive_retry_exhausted_notice(
    *,
    ceo_name: str,
    run_id: str,
    project_id: str,
    max_attempts: int,
) -> str:
    """Build deterministic failure guidance when passive retries are exhausted."""
    run = run_service.get_run(run_id) if run_id else None
    timeline_labels: list[str] = []
    phase_label = ""
    if isinstance(run, dict):
        phase_label = str(run.get("status", "") or "").strip().lower()
        timeline = run.get("timeline", [])
        if isinstance(timeline, list):
            for row in timeline[-4:]:
                if not isinstance(row, dict):
                    continue
                label = str(row.get("label", "") or row.get("state", "") or "").strip()
                if label:
                    timeline_labels.append(label)
            if timeline:
                latest = timeline[-1] if isinstance(timeline[-1], dict) else {}
                if isinstance(latest, dict):
                    latest_label = str(latest.get("label", "") or "").strip()
                    if latest_label:
                        phase_label = latest_label
    workforce = workforce_presence_service.snapshot(
        project_id=project_id or None,
        include_assigned=True,
        include_reporting=True,
    )
    workers = workforce.get("workers", []) if isinstance(workforce, dict) else []
    active_rows: list[str] = []
    if isinstance(workers, list):
        for row in workers[:4]:
            if not isinstance(row, dict):
                continue
            agent_name = str(row.get("agent_name", "") or row.get("agent_id", "") or "").strip()
            state = str(row.get("state", "") or "").strip()
            if not agent_name:
                continue
            active_rows.append(f"{agent_name} ({state or 'working'})")
    active_text = ", ".join(active_rows) if active_rows else "No active agents were reported."
    timeline_text = "; ".join(timeline_labels[-3:]) if timeline_labels else "No recent timeline entries."
    phase_text = phase_label or "Execution in progress"
    return (
        f"{ceo_name} returned passive waiting updates {max_attempts} times in a row, so this run was stopped to prevent a silent stall.\n"
        f"Last known phase: {phase_text}.\n"
        f"Active agents: {active_text}\n"
        f"Recent timeline: {timeline_text}\n"
        "Send a new message like 'continue build now with assumptions and finish delivery' to resume immediately."
    )


def _build_assumption_first_retry_prompt(prompt: str) -> str:
    """Force a non-interactive retry path when Claude returns a clarification stub."""
    prefix = (
        "[NON-INTERACTIVE DASHBOARD MODE: Do not ask follow-up questions and do not use AskUserQuestion. "
        "If details are ambiguous, state concise assumptions and proceed immediately with execution.]"
    )
    return f"{prefix}\n\n{prompt}"


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
    user_message: str = "",
    support_agents: list[str] | None = None,
    config: dict[str, Any] | None = None,
    intent: dict[str, Any] | None = None,
    synthetic_delegation_fallback: bool = False,
    allow_clarification_retry: bool = True,
    passive_retry_attempt: int = 1,
    passive_retry_max: int | None = None,
) -> str | None:
    """Handle a CEO chat turn using the Claude Code CLI subprocess.

    Uses --output-format stream-json so tool-use actions are streamed as they
    happen.  Text blocks are forwarded as 'chunk' messages; tool_use blocks are
    forwarded as 'action' messages; tool results are forwarded as
    'action_result' messages.  Falls back to raw-text mode if the JSON parse
    fails on a line.

    Returns the full response string, or None if an error was sent.
    """
    env = _sanitize_subprocess_env(os.environ.copy())
    anthropic_mode = str(llm_cfg.get("anthropic_mode", "cli") or "cli").lower()
    inferred_intent = intent if isinstance(intent, dict) else _classify_execution_intent(user_message or "")
    is_execution_turn = (
        str(inferred_intent.get("intent", "") or "").strip().lower() == "execution"
        and bool(inferred_intent.get("actionable"))
    )
    passive_retry_max_cfg = passive_retry_max
    if passive_retry_max_cfg is None:
        try:
            passive_retry_max_cfg = int(llm_cfg.get("claude_passive_retry_max", 3) or 3)
        except (TypeError, ValueError):
            passive_retry_max_cfg = 3
    passive_retry_max_cfg = max(1, min(5, int(passive_retry_max_cfg)))
    passive_retry_attempt = max(1, int(passive_retry_attempt or 1))
    interactive_tools_blocked = ["AskUserQuestion"]
    runtime_metadata = {
        "provider": "anthropic",
        "mode": anthropic_mode if anthropic_mode in ("cli", "apikey") else "cli",
        "runtime": "claude_cli",
        "model": str(llm_cfg.get("model", "claude") or "claude"),
        "interactive_tools_blocked": interactive_tools_blocked,
        "execution_turn": is_execution_turn,
        "passive_retry_attempt": passive_retry_attempt,
        "passive_retry_max": passive_retry_max_cfg,
    }
    if run_id:
        runtime_metadata["run_id"] = run_id
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
                _transition_run_state(
                    run_id,
                    state="failed",
                    label="Anthropic API-key mode selected without configured key",
                )
            return None
    elif anthropic_mode == "cli":
        # In CLI mode, inject the config API key into the env if available
        # so the subprocess has credentials even without OAuth login.
        if anthropic_api_key and not env.get("ANTHROPIC_API_KEY"):
            env["ANTHROPIC_API_KEY"] = anthropic_api_key

    # Pre-flight: warn (but don't block) if no auth mechanism is detectable.
    if not env.get("ANTHROPIC_API_KEY") and not os.path.exists(
        os.path.expanduser("~/.claude/.credentials.json")
    ):
        logger.warning(
            "No ANTHROPIC_API_KEY and no CLI credentials found. "
            "The CEO subprocess will likely fail to authenticate."
        )

    process = None
    saw_tool_use = False
    saw_interactive_question_tool_use = False
    saw_real_delegation = False
    # Map tool_use_id → delegated agent name for accurate result matching.
    # Previous FIFO list could mis-attribute results when parallel delegations
    # returned out of order.
    pending_delegate_agents: dict[str, str] = {}
    delegation_plan: list[dict[str, str]] = []
    try:
        cmd = [claude_path, "--agent", "ceo", "-p", prompt]
        # Web dashboard runs are non-interactive, so permission prompts cannot
        # be answered. Force bypass mode to avoid silent no-op file writes.
        cmd.extend(["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"])
        cmd.extend(["--disallowed-tools", ",".join(interactive_tools_blocked)])
        cmd.extend(["--output-format", "stream-json", "--verbose"])
        _emit_chat_activity(
            "ceo",
            "STARTED",
            "Launching Claude CEO runtime (permission mode: bypassPermissions)",
            project_id=project_id,
            metadata=runtime_metadata,
        )
        if run_id:
            _transition_run_state(
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

        if (
            synthetic_delegation_fallback
            and not micro_project_mode
            and support_agents
        ):
            effective_config = config if isinstance(config, dict) else _load_config()
            delegation_plan = _build_synthetic_delegation_plan(
                user_message or prompt,
                support_agents,
                config=effective_config,
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
        full_response: str | None = None
        assert process.stdout is not None
        idle_ticks = 0  # how many 30-s timeouts in a row
        max_idle_seconds = int(llm_cfg.get("claude_idle_timeout_seconds", 240) or 240)
        max_idle_seconds = max(90, min(1800, max_idle_seconds))

        while True:
            if run_id:
                run_state = run_service.get_run(run_id)
                if run_state and bool(run_state.get("cancel_requested")):
                    await websocket.send_json({"type": "error", "content": "Run cancelled by user."})
                    _transition_run_state(run_id, state="cancelled", label="Run cancelled by user")
                    return None
                guardrails = run_service.guardrail_status(run_id)
                if guardrails and guardrails.get("over_budget"):
                    violation_message = _guardrail_violation_message(guardrails)
                    await websocket.send_json({"type": "error", "content": violation_message})
                    _transition_run_state(run_id, state="failed", label=violation_message)
                    return None
            try:
                raw = await asyncio.wait_for(process.stdout.readline(), timeout=30.0)
            except asyncio.TimeoutError:
                idle_ticks += 1
                idle_seconds = idle_ticks * 30
                await websocket.send_json({
                    "type": "thinking",
                    "content": f"{ceo_name} is working… ({idle_seconds}s)",
                })
                _emit_chat_activity(
                    "ceo",
                    "UPDATED",
                    f"Claude runtime still processing ({idle_seconds}s)",
                    project_id=project_id,
                    metadata=runtime_metadata,
                )
                if process.returncode is None and idle_seconds >= max_idle_seconds:
                    notice = (
                        f"{ceo_name} is still running after {idle_seconds}s with no new output. "
                        "Finalizing this turn to avoid a stuck chat. You can ask for a status check next."
                    )
                    await websocket.send_json({
                        "type": "warning",
                        "content": notice,
                    })
                    _emit_chat_activity(
                        "ceo",
                        "WARNING",
                        f"Claude idle timeout guardrail triggered at {idle_seconds}s.",
                        project_id=project_id,
                        metadata={"idle_seconds": idle_seconds, **runtime_metadata},
                    )
                    partial = "".join(response_parts).strip()
                    if partial:
                        full_response = f"{partial}\n\n[Notice] {notice}"
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                        break
                    await websocket.send_json({"type": "error", "content": notice})
                    if run_id:
                        _transition_run_state(
                            run_id,
                            state="failed",
                            label=f"Claude idle timeout after {idle_seconds}s",
                        )
                    return None
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
                        if tool_name.strip().lower() in {"askuserquestion", "ask_user_question"}:
                            saw_interactive_question_tool_use = True
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
                            tool_use_id = str(block.get("id", "") or "").strip()
                            if delegated_agent:
                                saw_real_delegation = True
                                is_delegation = True
                                delegation_work_item = f"{run_id}:{delegated_agent}" if run_id else f"{project_id}:{delegated_agent}"
                                if tool_use_id:
                                    pending_delegate_agents[tool_use_id] = delegated_agent
                                else:
                                    # Fallback: use a synthetic key if id is missing
                                    pending_delegate_agents[f"_fallback_{len(pending_delegate_agents)}"] = delegated_agent
                                delegation_metadata = {
                                    "source_agent": "ceo",
                                    "target_agent": delegated_agent,
                                    "flow": "down",
                                    "task": delegated_task[:280],
                                    "tool": tool_name,
                                    "source": "real",
                                    "work_state": "assigned",
                                    "work_item_id": delegation_work_item,
                                    **runtime_metadata,
                                }
                                # Send delegation-specific action_detail so ChatPanel
                                # can forward to onAgentActivity → liveAgents → org chart
                                await websocket.send_json({
                                    "type": "action_detail",
                                    "content": {
                                        "label": f"Delegating to {delegated_agent}",
                                        "tool": tool_name,
                                        "state": "started",
                                        "run_id": run_id,
                                        "actor": "ceo",
                                        "source_agent": "ceo",
                                        "target": delegated_agent,
                                        "target_agent": delegated_agent,
                                        "flow": "down",
                                        "task": delegated_task[:280],
                                        "source": "real",
                                        "work_state": "assigned",
                                        "work_item_id": delegation_work_item,
                                        **runtime_metadata,
                                    },
                                })
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
                                    metadata={
                                        "source_agent": delegated_agent,
                                        "target_agent": delegated_agent,
                                        "flow": "internal",
                                        "task": delegated_task[:280],
                                        "tool": tool_name,
                                        "source": "real",
                                        "work_state": "working",
                                        "work_item_id": delegation_work_item,
                                        **runtime_metadata,
                                    },
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
                            # Match result to delegation via tool_use_id for
                            # accurate attribution even with parallel delegations.
                            result_tool_use_id = str(block.get("tool_use_id", "") or "").strip()
                            delegated_agent = ""
                            if result_tool_use_id and result_tool_use_id in pending_delegate_agents:
                                delegated_agent = pending_delegate_agents.pop(result_tool_use_id)
                            elif pending_delegate_agents:
                                # Fallback: pop first entry (preserves old FIFO behavior
                                # when tool_use_id is missing)
                                first_key = next(iter(pending_delegate_agents))
                                delegated_agent = pending_delegate_agents.pop(first_key)
                            result_metadata: dict[str, Any] = {}
                            if delegated_agent:
                                result_work_item = f"{run_id}:{delegated_agent}" if run_id else f"{project_id}:{delegated_agent}"
                                result_metadata = {
                                    "source_agent": delegated_agent,
                                    "target_agent": "ceo",
                                    "flow": "up",
                                    "source": "real",
                                    "work_state": "completed",
                                    "work_item_id": result_work_item,
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
                                    metadata={**result_metadata, "work_state": "reporting"},
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
                # Emit FAILED for any agents whose results never arrived
                for _tid, agent_name in list(pending_delegate_agents.items()):
                    fail_work_item = f"{run_id}:{agent_name}" if run_id else f"{project_id}:{agent_name}"
                    fail_meta = {
                        "source_agent": agent_name,
                        "target_agent": "ceo",
                        "flow": "failed",
                        "source": "real",
                        "work_state": "blocked",
                        "work_item_id": fail_work_item,
                        **runtime_metadata,
                    }
                    await websocket.send_json({
                        "type": "action_detail",
                        "content": {
                            "label": f"{agent_name} failed — CEO error",
                            "state": "failed",
                            "run_id": run_id,
                            "actor": agent_name,
                            "target": "ceo",
                            "flow": "failed",
                            **fail_meta,
                        },
                    })
                    _emit_chat_activity(
                        agent_name,
                        "FAILED",
                        f"Agent terminated — CEO error: {str(err)[:120]}",
                        project_id=project_id,
                        metadata=fail_meta,
                    )
                pending_delegate_agents.clear()
                if run_id:
                    _transition_run_state(run_id, state="failed", label=str(err))
                return None

        if full_response is None:
            full_response = "".join(response_parts).strip() or None

        # Emit FAILED for any delegated agents whose results never came back.
        # This can happen when the CEO process exits mid-delegation.
        for _tid, agent_name in list(pending_delegate_agents.items()):
            fail_meta = {
                "source_agent": agent_name,
                "target_agent": "ceo",
                "flow": "failed",
                **runtime_metadata,
            }
            await websocket.send_json({
                "type": "action_detail",
                "content": {
                    "label": f"{agent_name} — no result received",
                    "state": "failed",
                    "run_id": run_id,
                    "actor": agent_name,
                    "target": "ceo",
                    "flow": "failed",
                    **fail_meta,
                },
            })
            _emit_chat_activity(
                agent_name,
                "FAILED",
                "Agent result never received — process ended",
                project_id=project_id,
                metadata=fail_meta,
            )
        pending_delegate_agents.clear()

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
                _transition_run_state(run_id, state="failed", label=error_msg)
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

        if full_response and _is_incomplete_clarification_stub(full_response):
            if allow_clarification_retry:
                await websocket.send_json({
                    "type": "warning",
                    "content": (
                        "Clarification prompt was incomplete in non-interactive mode. "
                        "Continuing with assumption-first execution."
                    ),
                })
                _emit_chat_activity(
                    "ceo",
                    "WARNING",
                    "Incomplete clarification prompt detected; auto-retrying with assumption-first policy.",
                    project_id=project_id,
                    metadata={
                        "clarification_retry": True,
                        "interactive_question_tool_attempted": saw_interactive_question_tool_use,
                        **runtime_metadata,
                    },
                )
                return await _handle_ceo_claude(
                    websocket=websocket,
                    prompt=_build_assumption_first_retry_prompt(prompt),
                    claude_path=claude_path,
                    llm_cfg=llm_cfg,
                    ceo_name=ceo_name,
                    micro_project_mode=micro_project_mode,
                    project_id=project_id,
                    run_id=run_id,
                    user_message=user_message,
                    support_agents=support_agents,
                    config=config,
                    intent=intent,
                    synthetic_delegation_fallback=False,
                    allow_clarification_retry=False,
                    passive_retry_attempt=passive_retry_attempt,
                    passive_retry_max=passive_retry_max_cfg,
                )
            _emit_chat_activity(
                "ceo",
                "WARNING",
                "Clarification response remained incomplete after non-interactive retry.",
                project_id=project_id,
                metadata={
                    "clarification_retry": False,
                    "interactive_question_tool_attempted": saw_interactive_question_tool_use,
                    **runtime_metadata,
                },
            )

        if full_response and is_execution_turn and _is_passive_waiting_response(full_response):
            _emit_chat_activity(
                "ceo",
                "WARNING",
                "Passive waiting response detected during execution turn.",
                project_id=project_id,
                metadata={
                    "passive_wait_detected": True,
                    "passive_retry_attempt": passive_retry_attempt,
                    "passive_retry_max": passive_retry_max_cfg,
                    **runtime_metadata,
                },
            )
            if passive_retry_attempt < passive_retry_max_cfg:
                next_attempt = passive_retry_attempt + 1
                await websocket.send_json({
                    "type": "warning",
                    "content": (
                        f"Passive waiting response detected. Continuing automatically "
                        f"({next_attempt}/{passive_retry_max_cfg}) with active orchestration."
                    ),
                })
                return await _handle_ceo_claude(
                    websocket=websocket,
                    prompt=_build_active_management_retry_prompt(
                        prompt,
                        full_response,
                        attempt=next_attempt,
                        max_attempts=passive_retry_max_cfg,
                    ),
                    claude_path=claude_path,
                    llm_cfg=llm_cfg,
                    ceo_name=ceo_name,
                    micro_project_mode=micro_project_mode,
                    project_id=project_id,
                    run_id=run_id,
                    user_message=user_message,
                    support_agents=support_agents,
                    config=config,
                    intent=intent,
                    synthetic_delegation_fallback=False,
                    allow_clarification_retry=False,
                    passive_retry_attempt=next_attempt,
                    passive_retry_max=passive_retry_max_cfg,
                )

            exhausted_notice = _build_passive_retry_exhausted_notice(
                ceo_name=ceo_name,
                run_id=run_id,
                project_id=project_id,
                max_attempts=passive_retry_max_cfg,
            )
            await websocket.send_json({"type": "error", "content": exhausted_notice})
            _emit_chat_activity(
                "ceo",
                "ERROR",
                "Passive waiting retries exhausted; run failed to prevent silent stall.",
                project_id=project_id,
                metadata={
                    "passive_wait_detected": True,
                    "passive_retry_exhausted": True,
                    "passive_retry_attempt": passive_retry_attempt,
                    "passive_retry_max": passive_retry_max_cfg,
                    **runtime_metadata,
                },
            )
            if run_id:
                _transition_run_state(
                    run_id,
                    state="failed",
                    label=f"Passive waiting retries exhausted ({passive_retry_max_cfg})",
                    metadata={
                        "passive_wait_detected": True,
                        "passive_retry_exhausted": True,
                        "passive_retry_attempt": passive_retry_attempt,
                        "passive_retry_max": passive_retry_max_cfg,
                    },
                )
            return None

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

        # Claude can return direct text without explicit Task tool delegation in
        # non-interactive runs. Emit a synthetic completion pulse so the org tree
        # still reflects active workforce transitions for this turn.
        if delegation_plan and not saw_real_delegation:
            await _emit_synthetic_delegation_completion(
                websocket,
                delegation_plan=delegation_plan,
                project_id=project_id,
                runtime_metadata=runtime_metadata,
                run_id=run_id,
            )

        _emit_chat_activity(
            "ceo",
            "COMPLETED",
            "CEO response generated",
            project_id=project_id,
            metadata={
                "micro_project_mode": micro_project_mode,
                "tool_use_detected": saw_tool_use,
                "interactive_question_tool_attempted": saw_interactive_question_tool_use,
                "clarification_retry_enabled": allow_clarification_retry,
                **runtime_metadata,
            },
        )
        if run_id:
            _transition_run_state(
                run_id,
                state="done",
                label="CEO response generated",
                metadata={
                    "micro_project_mode": micro_project_mode,
                    "tool_use_detected": saw_tool_use,
                    "interactive_question_tool_attempted": saw_interactive_question_tool_use,
                    "clarification_retry_enabled": allow_clarification_retry,
                    **runtime_metadata,
                },
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
            _transition_run_state(run_id, state="failed", label=f"Failed to start CEO agent: {exc}")
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
            _transition_run_state(run_id, state="failed", label=f"Chat error: {str(exc)[:200]}")
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
            _transition_run_state(run_id, state="failed", label=message)
        return None

    env = _sanitize_subprocess_env(os.environ.copy())
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
    if run_id:
        runtime_metadata["run_id"] = run_id
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
        _transition_run_state(
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
                    _transition_run_state(run_id, state="cancelled", label="Run cancelled by user")
                    return None
                guardrails = run_service.guardrail_status(run_id)
                if guardrails and guardrails.get("over_budget"):
                    violation_message = _guardrail_violation_message(guardrails)
                    await websocket.send_json({"type": "error", "content": violation_message})
                    _transition_run_state(run_id, state="failed", label=violation_message)
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
                _transition_run_state(
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
                _transition_run_state(
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
            _transition_run_state(run_id, state="failed", label=message)
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
            _transition_run_state(run_id, state="failed", label=message)
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
    if run_id:
        runtime_metadata["run_id"] = run_id

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
        _transition_run_state(
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
                    _transition_run_state(run_id, state="cancelled", label="Run cancelled by user")
                    return None
                guardrails = run_service.guardrail_status(run_id)
                if guardrails and guardrails.get("over_budget"):
                    violation_message = _guardrail_violation_message(guardrails)
                    await websocket.send_json({"type": "error", "content": violation_message})
                    _transition_run_state(run_id, state="failed", label=violation_message)
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
                    _transition_run_state(run_id, state="failed", label=f"LLM timeout: {stream_warning}")
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
                _transition_run_state(run_id, state="failed", label=str(exc))
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
                _transition_run_state(run_id, state="failed", label=friendly_error)
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
        _transition_run_state(
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
    heartbeat_task: asyncio.Task[None] | None = None
    heartbeat_seq = 0
    last_phase_state = ""
    last_incident_signature = ""
    last_progress_checkpoint_signature = ""
    stall_recovery_attempts: dict[str, int] = {}

    config = _load_config()
    ui_cfg = config.get("ui", {}) if isinstance(config.get("ui"), dict) else {}
    feature_flags_cfg = config.get("feature_flags", {}) if isinstance(config.get("feature_flags"), dict) else {}
    run_heartbeat_seconds = max(1, int(ui_cfg.get("run_heartbeat_seconds", 5) or 5))
    run_stall_warning_seconds = max(30, int(ui_cfg.get("run_stall_warning_seconds", 90) or 90))
    run_stall_critical_seconds = max(run_stall_warning_seconds, int(ui_cfg.get("run_stall_critical_seconds", 180) or 180))
    run_watchdog_enabled = bool(feature_flags_cfg.get("run_watchdog", True))

    def _run_checkpoint_message(run_status: dict[str, Any]) -> tuple[str, str]:
        phase_label = str(run_status.get("phase_label", "") or "Executing").strip() or "Executing"
        elapsed_seconds = max(0, int(run_status.get("elapsed_seconds", 0) or 0))
        elapsed_minutes = elapsed_seconds // 60
        elapsed_remainder = elapsed_seconds % 60
        elapsed_text = f"{elapsed_minutes}m {elapsed_remainder:02d}s" if elapsed_minutes else f"{elapsed_remainder}s"
        active_agents = run_status.get("active_agents", [])
        agent_chunks: list[str] = []
        signature_chunks: list[str] = []
        if isinstance(active_agents, list):
            for row in active_agents[:3]:
                if not isinstance(row, dict):
                    continue
                agent_id = str(row.get("agent_id", "") or "").strip().lower()
                agent_name = str(row.get("agent_name", "") or agent_id or "agent").strip()
                agent_state = str(row.get("state", "") or "working").strip().lower()
                if not agent_name:
                    continue
                agent_chunks.append(f"{agent_name} ({agent_state})")
                if agent_id:
                    signature_chunks.append(f"{agent_id}:{agent_state}")
        if not agent_chunks:
            agent_summary = "No active specialist updates yet"
        elif len(agent_chunks) == 1:
            agent_summary = agent_chunks[0]
        else:
            agent_summary = ", ".join(agent_chunks[:-1]) + f", and {agent_chunks[-1]}"
        message = f"Progress checkpoint: {phase_label} • elapsed {elapsed_text} • active: {agent_summary}."
        state = str(run_status.get("state", "") or "").strip().lower()
        signature = "|".join(
            [
                state,
                phase_label.lower(),
                str(elapsed_seconds // 30),
                ",".join(signature_chunks),
            ]
        )
        return message, signature

    def _run_incident_notice(run_status: dict[str, Any], incident: dict[str, Any]) -> str:
        phase_label = str(run_status.get("phase_label", "") or "Execution").strip() or "Execution"
        reason = str(incident.get("reason", "silent_run") or "silent_run").replace("_", " ")
        inactive_seconds = max(0, int(incident.get("inactive_seconds", 0) or 0))
        return (
            f"Run watchdog notice: {phase_label} appears stalled ({inactive_seconds}s inactive, {reason}). "
            "Use inline run controls to get status, retry, continue, or cancel."
        )

    async def _emit_run_progress(
        run_id: str,
        project_id: str,
        *,
        force_phase: bool = False,
    ) -> None:
        nonlocal heartbeat_seq, last_phase_state, last_incident_signature, last_progress_checkpoint_signature, stall_recovery_attempts
        run = run_service.get_run(run_id)
        if not isinstance(run, dict):
            return
        guardrails = run_service.guardrail_status(run_id) or {}
        workforce = workforce_presence_service.snapshot(
            project_id=project_id or None,
            include_assigned=True,
            include_reporting=True,
        )
        heartbeat_seq += 1
        run_status = build_run_status_payload(
            run,
            guardrails=guardrails,
            workforce_snapshot=workforce,
            heartbeat_seq=heartbeat_seq,
        )
        await websocket.send_json({"type": "run_status", "content": run_status})
        state = str(run_status.get("state", "") or "")
        if state.lower() in ACTIVE_RUN_STATES:
            checkpoint_message, checkpoint_signature = _run_checkpoint_message(run_status)
            if checkpoint_signature and checkpoint_signature != last_progress_checkpoint_signature:
                last_progress_checkpoint_signature = checkpoint_signature
                await websocket.send_json({"type": "thinking", "content": checkpoint_message})
        else:
            last_progress_checkpoint_signature = ""
        if force_phase or state != last_phase_state:
            last_phase_state = state
            await websocket.send_json(
                {
                    "type": "run_phase",
                    "content": {
                        "run_id": str(run_status.get("run_id", "") or ""),
                        "project_id": str(run_status.get("project_id", "") or ""),
                        "state": state,
                        "phase_label": str(run_status.get("phase_label", "") or ""),
                        "elapsed_seconds": int(run_status.get("elapsed_seconds", 0) or 0),
                        "last_activity_at": str(run_status.get("last_activity_at", "") or ""),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    },
                }
            )
        if run_watchdog_enabled:
            incident = detect_run_incident(
                run_status,
                warning_seconds=run_stall_warning_seconds,
                critical_seconds=run_stall_critical_seconds,
            )
            if incident:
                signature = "|".join(
                    [
                        str(incident.get("run_id", "") or ""),
                        str(incident.get("severity", "") or ""),
                        str(incident.get("reason", "") or ""),
                    ]
                )
                if signature != last_incident_signature:
                    last_incident_signature = signature
                    incident_guidance = _runtime_guidance_payload(
                        message=_run_incident_notice(run_status, incident),
                        code=f"run_{str(incident.get('reason', 'incident') or 'incident')}",
                        actions=[
                            _guidance_action(
                                action_id="status",
                                label="Show run status",
                                kind="run_control",
                                payload={"action": "status", "run_id": str(incident.get("run_id", "") or run_id)},
                            ),
                            _guidance_action(
                                action_id="retry_step",
                                label="Retry step",
                                kind="run_control",
                                payload={"action": "retry_step", "run_id": str(incident.get("run_id", "") or run_id)},
                            ),
                            _guidance_action(
                                action_id="continue",
                                label="Continue",
                                kind="run_control",
                                payload={"action": "continue", "run_id": str(incident.get("run_id", "") or run_id)},
                            ),
                            _guidance_action(
                                action_id="cancel",
                                label="Cancel run",
                                kind="run_control",
                                payload={"action": "cancel", "run_id": str(incident.get("run_id", "") or run_id)},
                            ),
                        ],
                    )
                    await websocket.send_json({"type": "run_incident", "content": incident, "guidance": incident_guidance})
                    await websocket.send_json(
                        {
                            "type": "warning",
                            "content": _run_incident_notice(run_status, incident),
                            "guidance": incident_guidance,
                        }
                    )
                    severity = str(incident.get("severity", "") or "").strip().lower()
                    reason = str(incident.get("reason", "") or "").strip().lower()
                    if severity == "critical" and reason in {"silent_run", "provider_stall"}:
                        attempts = int(stall_recovery_attempts.get(run_id, 0) or 0)
                        max_attempts = 2
                        if attempts < max_attempts:
                            attempt_no = attempts + 1
                            stall_recovery_attempts[run_id] = attempt_no
                            _transition_run_state(
                                run_id,
                                state="executing",
                                label=f"Auto-recovery heartbeat {attempt_no}/{max_attempts}",
                                metadata={
                                    "auto_recovery": True,
                                    "reason": reason,
                                    "attempt": attempt_no,
                                    "max_attempts": max_attempts,
                                },
                            )
                            _emit_chat_activity(
                                "ceo",
                                "WARNING",
                                "Automatic stall recovery checkpoint executed.",
                                project_id=project_id,
                                metadata={
                                    "run_id": run_id,
                                    "reason": reason,
                                    "attempt": attempt_no,
                                    "max_attempts": max_attempts,
                                },
                            )
                            await websocket.send_json(
                                {
                                    "type": "run_control_ack",
                                    "content": {
                                        "run_id": run_id,
                                        "action": "status",
                                        "acknowledged": True,
                                        "message": f"Automatic recovery check {attempt_no}/{max_attempts} executed.",
                                    },
                                }
                            )
            elif state not in ACTIVE_RUN_STATES:
                last_incident_signature = ""
                stall_recovery_attempts.pop(run_id, None)

    async def _stop_heartbeat() -> None:
        nonlocal heartbeat_task
        if heartbeat_task and not heartbeat_task.done():
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        heartbeat_task = None

    async def _start_heartbeat(run_id: str, project_id: str) -> None:
        nonlocal heartbeat_task
        await _stop_heartbeat()

        async def _heartbeat_loop() -> None:
            while True:
                await asyncio.sleep(run_heartbeat_seconds)
                if not inflight_run_id or inflight_run_id != run_id:
                    break
                run = run_service.get_run(run_id)
                if not isinstance(run, dict):
                    break
                try:
                    await _emit_run_progress(run_id, project_id)
                except Exception:
                    break
                status = str(run.get("status", "") or "").strip().lower()
                if status not in ACTIVE_RUN_STATES:
                    break

        heartbeat_task = asyncio.create_task(_heartbeat_loop())

    async def _clear_inflight_tracking() -> None:
        nonlocal inflight_run_id, inflight_project_id, heartbeat_seq, last_phase_state, last_incident_signature, last_progress_checkpoint_signature, stall_recovery_attempts
        if inflight_run_id:
            stall_recovery_attempts.pop(inflight_run_id, None)
        await _stop_heartbeat()
        inflight_run_id = ""
        inflight_project_id = ""
        heartbeat_seq = 0
        last_phase_state = ""
        last_incident_signature = ""
        last_progress_checkpoint_signature = ""

    async def _close_inflight_run(
        reason: str,
        *,
        metadata: dict[str, Any] | None = None,
        mark_failed: bool = True,
    ) -> None:
        nonlocal inflight_run_id, inflight_project_id
        if not inflight_run_id:
            return
        run_state = run_service.get_run(inflight_run_id)
        status = str((run_state or {}).get("status", "") or "")
        if mark_failed and status in {"queued", "planning", "executing", "verifying"}:
            _transition_run_state(
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
        await _clear_inflight_tracking()

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
            turn_correlation_id = str(uuid.uuid4())[:12]
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
            ui_cfg = config.get("ui", {}) if isinstance(config.get("ui"), dict) else {}
            feature_flags_cfg = config.get("feature_flags", {}) if isinstance(config.get("feature_flags"), dict) else {}
            run_heartbeat_seconds = max(1, int(ui_cfg.get("run_heartbeat_seconds", 5) or 5))
            run_stall_warning_seconds = max(30, int(ui_cfg.get("run_stall_warning_seconds", 90) or 90))
            run_stall_critical_seconds = max(
                run_stall_warning_seconds,
                int(ui_cfg.get("run_stall_critical_seconds", 180) or 180),
            )
            run_watchdog_enabled = bool(feature_flags_cfg.get("run_watchdog", True))
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
            support_agents = [] if micro_project_mode else _infer_support_agents(
                user_message,
                intent=intent,
                project=active_project,
                config=config,
            )
            delegation_reasoning = _build_delegation_reasoning(
                user_message,
                intent=intent,
                project=active_project,
                config=config,
                support_agents=support_agents,
            )
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
                    metadata={
                        "intent": intent,
                        "intent_class": intent_class,
                        "support_agents": support_agents,
                        "delegation_stage": delegation_reasoning.get("stage", ""),
                    },
                )
            except RuntimeError as exc:
                run_start_guidance = _runtime_guidance_payload(
                    message=str(exc),
                    code="run_concurrency_limit",
                    correlation_id=turn_correlation_id,
                    actions=[
                        _guidance_action(action_id="open_project", label="Open project", kind="open_project", target=active_project_id or ""),
                        _guidance_action(action_id="view_events", label="View Event Log", kind="view_events"),
                    ],
                )
                await websocket.send_json({
                    "type": "error",
                    "content": str(exc),
                    "correlation_id": turn_correlation_id,
                    "guidance": run_start_guidance,
                })
                await websocket.send_json(
                    {
                        "type": "done",
                        "content": "",
                        "project_id": active_project_id,
                        "terminal_state": "failed",
                        "error_reason": str(exc),
                        "correlation_id": turn_correlation_id,
                        "guidance": run_start_guidance,
                    }
                )
                continue
            run_id = str(run_record.get("id", "") or "")
            inflight_run_id = run_id
            inflight_project_id = active_project_id
            _transition_run_state(
                run_id,
                state="planning",
                label="Turn accepted and queued for planning",
                metadata={"intent": intent, "intent_class": intent_class, "sandbox_profile": sandbox_profile},
            )
            await websocket.send_json({
                "type": "run",
                "content": {
                    "id": run_id,
                    "correlation_id": turn_correlation_id,
                    "status": run_record.get("status", "queued"),
                    "mode": run_mode,
                    "intent": intent,
                    "intent_class": intent_class,
                    "sandbox_profile": sandbox_profile,
                    "support_agents": support_agents,
                    "delegation_stage": delegation_reasoning.get("stage", ""),
                    "delegation_summary": delegation_reasoning.get("summary", ""),
                    "delegation_reasons": delegation_reasoning.get("reasons", []),
                },
            })
            await _emit_run_progress(run_id, active_project_id, force_phase=True)
            await _start_heartbeat(run_id, active_project_id)

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
                if support_agents and not no_delegation_mode and not micro_project_mode:
                    _emit_planning_stage_assignments(
                        project_id=active_project_id,
                        run_id=run_id,
                        user_message=user_message,
                        support_agents=support_agents,
                        config=config,
                        delegation_stage=str(delegation_reasoning.get("stage", "") or ""),
                    )
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
                _transition_run_state(
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
                    "terminal_state": "done",
                    "intent_class": intent_class,
                    "planning_packet_status": plan_packet_status,
                    "correlation_id": turn_correlation_id,
                })
                await _emit_run_progress(run_id, active_project_id, force_phase=True)
                await _clear_inflight_tracking()
                continue
            if micro_project_mode:
                complexity_reason = _micro_project_complexity_reason(user_message)
                if complexity_reason and not micro_project_override:
                    complexity_guidance = _runtime_guidance_payload(
                        message=complexity_reason,
                        code="micro_complexity_blocked",
                        correlation_id=turn_correlation_id,
                        actions=[
                            _guidance_action(action_id="continue", label="Continue with full crew", kind="run_control", payload={"action": "continue"}),
                            _guidance_action(action_id="retry", label="Retry in micro mode", kind="retry"),
                        ],
                    )
                    _transition_run_state(
                        run_id,
                        state="cancelled",
                        label="Micro project complexity warning blocked execution",
                        metadata={"reason": complexity_reason},
                    )
                    await websocket.send_json({"type": "micro_project_warning", "content": complexity_reason})
                    await websocket.send_json(
                        {
                            "type": "done",
                            "content": "",
                            "project_id": active_project_id,
                            "run_id": run_id,
                            "terminal_state": "cancelled",
                            "error_reason": complexity_reason,
                            "correlation_id": turn_correlation_id,
                            "guidance": complexity_guidance,
                        }
                    )
                    await _emit_run_progress(run_id, active_project_id, force_phase=True)
                    await _clear_inflight_tracking()
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
                _transition_run_state(
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
                    claude_missing_guidance = _runtime_guidance_payload(
                        message="Claude CLI not found. Install and authenticate, then retry.",
                        code="claude_cli_missing",
                        correlation_id=turn_correlation_id,
                        actions=[
                            _guidance_action(action_id="open_settings", label="Open settings", kind="open_settings"),
                            _guidance_action(action_id="retry", label="Retry now", kind="retry"),
                        ],
                    )
                    _transition_run_state(
                        run_id,
                        state="failed",
                        label="Claude CLI not found",
                    )
                    await websocket.send_json({
                        "type": "error",
                        "content": "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code",
                        "correlation_id": turn_correlation_id,
                        "guidance": claude_missing_guidance,
                    })
                    await websocket.send_json({
                        "type": "done",
                        "content": "",
                        "project_id": active_project_id,
                        "run_id": run_id,
                        "terminal_state": "failed",
                        "error_reason": "Claude CLI not found.",
                        "correlation_id": turn_correlation_id,
                        "guidance": claude_missing_guidance,
                    })
                    await _emit_run_progress(run_id, active_project_id, force_phase=True)
                    await _clear_inflight_tracking()
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
                    user_message=user_message,
                    support_agents=support_agents,
                    config=config,
                    intent=intent,
                    synthetic_delegation_fallback=(
                        bool(support_agents)
                        and not no_delegation_mode
                        and not micro_project_mode
                        and str(intent.get("intent", "") or "").strip().lower() == "execution"
                    ),
                )

            full_response = _apply_agent_name_overrides(full_response or "", config) or None
            full_response = _sanitize_ceo_response(
                full_response or "",
                ceo_name=ceo_name,
                user_name=user_name,
            ) or None

            terminal_state = "done"
            error_reason = ""

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
                    _transition_run_state(run_id, state="done", label="Chat response completed")
            else:
                terminal_state = "failed"
                error_reason = "Provider returned no response."
                run_state = run_service.get_run(run_id)
                if run_state and str(run_state.get("status", "")) in {"queued", "planning", "executing", "verifying"}:
                    _transition_run_state(run_id, state="failed", label="Provider returned no response")
                await websocket.send_json(
                    {
                        "type": "warning",
                        "content": "Run completed without assistant output. Marking turn as failed with actionable context.",
                        "correlation_id": turn_correlation_id,
                    }
                )

            final_run_state = run_service.get_run(run_id)
            final_status = str((final_run_state or {}).get("status", "") or "").strip().lower()
            if final_status in {"done", "failed", "cancelled"}:
                terminal_state = final_status
            if terminal_state == "cancelled" and not error_reason:
                error_reason = str((final_run_state or {}).get("cancel_reason", "") or "Run cancelled.").strip()
            if terminal_state == "failed" and not error_reason:
                timeline = (final_run_state or {}).get("timeline", [])
                if isinstance(timeline, list) and timeline:
                    latest = timeline[-1] if isinstance(timeline[-1], dict) else {}
                    if isinstance(latest, dict):
                        error_reason = str(latest.get("label", "") or latest.get("state", "") or "").strip()
                if not error_reason:
                    error_reason = "Run failed before producing assistant output."
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
                "terminal_state": terminal_state,
                "correlation_id": turn_correlation_id,
                "intent_class": intent_class,
                "planning_packet_status": plan_packet_status,
            }
            if terminal_state != "done" and error_reason:
                done_payload["error_reason"] = error_reason
                done_payload["guidance"] = _build_terminal_guidance(
                    terminal_state=terminal_state,
                    error_reason=error_reason,
                    project_id=active_project_id,
                    run_id=run_id,
                    correlation_id=turn_correlation_id,
                )
            structured_payload: dict[str, Any] | None = None
            if structured_enabled:
                base_structured = _structured_response_payload(full_response or "")
                structured_payload = _merge_structured_completion_with_project(base_structured, active_project)
                if active_project_id and full_response:
                    synced_project = _sync_project_completion_snapshot(
                        active_project_id,
                        project=active_project,
                        structured=structured_payload,
                        support_agents=support_agents,
                        config=config,
                    )
                    if isinstance(synced_project, dict):
                        active_project = synced_project
                        structured_payload = _merge_structured_completion_with_project(structured_payload, active_project)
                done_payload["structured"] = structured_payload
                celebration = _completion_celebration_payload(
                    run_id=run_id,
                    project_id=active_project_id,
                    structured=structured_payload,
                    config=config,
                    terminal_state=terminal_state,
                )
                if celebration:
                    done_payload["completion_celebration"] = celebration
                    _emit_chat_activity(
                        "ceo",
                        "COMPLETED",
                        "Completion celebration triggered.",
                        project_id=active_project_id,
                        metadata={"run_id": run_id, "celebration_kind": celebration.get("kind", "")},
                    )
                if active_project_id and structured_payload:
                    auto_launch = _attempt_local_project_autostart(
                        project=active_project,
                        structured=structured_payload,
                        run_id=run_id,
                    )
                    if bool(auto_launch.get("attempted")):
                        done_payload["auto_launch"] = auto_launch
            if deploy_offer:
                done_payload["deploy_offer"] = deploy_offer
            replay_summary = _build_run_replay_summary(run_id, active_project_id)
            if replay_summary:
                done_payload["run_replay"] = replay_summary
            await websocket.send_json(done_payload)
            await _emit_run_progress(run_id, active_project_id, force_phase=True)
            await _clear_inflight_tracking()

    except WebSocketDisconnect:
        await _close_inflight_run(
            "Client disconnected before run completion",
            metadata={"reason": "websocket_disconnected"},
        )
    except Exception as exc:
        await _close_inflight_run(
            f"Chat websocket error: {str(exc)[:180]}",
            metadata={"reason": "websocket_exception"},
        )
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        await _stop_heartbeat()


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
    previous_stripe_secret = str(integrations.get("stripe_secret_key", "") or "").strip()
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
        "stripe_secret_key",
        "stripe_publishable_key",
        "stripe_webhook_secret",
        "stripe_price_basic",
        "stripe_price_pro",
        "stripe_verified",
        "stripe_verified_at",
        "stripe_last_error",
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

    stripe_secret_changed = str(integrations.get("stripe_secret_key", "") or "").strip() != previous_stripe_secret
    if stripe_secret_changed:
        integrations["stripe_verified"] = False
        integrations["stripe_last_error"] = "Stripe configuration changed. Re-verify connector."

    config["integrations"] = integrations
    _save_config(config)
    return {"status": "ok"}


@app.get("/api/integrations/capabilities", summary="Summarise available GitHub/Vercel/Stripe capabilities")
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
    stripe_secret_set = bool(str(integrations.get("stripe_secret_key", "") or "").strip())
    stripe_publishable_set = bool(str(integrations.get("stripe_publishable_key", "") or "").strip())
    stripe_verified = bool(integrations.get("stripe_verified"))
    stripe_verified_at = str(integrations.get("stripe_verified_at", "") or "").strip()
    stripe_last_error = str(integrations.get("stripe_last_error", "") or "").strip()

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
    stripe_capabilities = [
        "checkout_sessions",
        "customer_portal",
        "webhook_validation",
    ] if stripe_secret_set else []

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
        "stripe": {
            "configured": stripe_secret_set or stripe_publishable_set,
            "verified": stripe_verified and stripe_secret_set,
            "secret_configured": stripe_secret_set,
            "publishable_configured": stripe_publishable_set,
            "verified_at": stripe_verified_at,
            "last_error": stripe_last_error,
            "capabilities": stripe_capabilities,
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
