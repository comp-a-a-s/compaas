"""ThunderFlow Web Dashboard API.

FastAPI application exposing live company state — org chart, projects,
tasks, activity stream, token metrics, agents, and model settings.
"""

import os
import json
import shutil
import asyncio
import yaml
from typing import AsyncGenerator
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard
from src.mcp_server.company_tools import CORE_TEAM, ON_DEMAND_TEAM
from src.agents import AGENT_REGISTRY, get_agent_display_name
from src.validators import validate_safe_id
from src.utils import resolve_data_dir, resolve_project_root


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

DATA_DIR = resolve_data_dir()
PROJECT_ROOT = resolve_project_root()

state_manager = ProjectStateManager(DATA_DIR)
task_board = TaskBoard(DATA_DIR)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="ThunderFlow Dashboard API",
    description="Live data API for the ThunderFlow virtual company web dashboard.",
    version="0.1.0",
)

# CORS — restrict to known origins
_cors_origins_env = os.environ.get("THUNDERFLOW_CORS_ORIGINS", os.environ.get("CRACKPIE_CORS_ORIGINS", ""))
_allowed_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()] if _cors_origins_env else [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8420",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)


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
    chairman_name = cfg.get("user", {}).get("name", "") or "Chairman"
    ceo_name = cfg.get("agents", {}).get("ceo", "CEO") or "CEO"

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
        result.append({
            **proj,
            "task_counts": status_counts,
            "total_tasks": len(tasks),
        })
    return result


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
    return {**project, "tasks": tasks, "project": project}


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
        "theme": "dark",
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
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o",
        "api_key": "",
        "system_prompt": "",
        # Phase 2: route ALL agent subprocesses through a LiteLLM proxy
        "proxy_enabled": False,
        "proxy_url": "http://localhost:4000",
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
    """Persist config to disk."""
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)


def _get_agent_name(agent_id: str, default: str) -> str:
    """Get custom agent name from config, falling back to default."""
    config = _load_config()
    return config.get("agents", {}).get(agent_id, default)


@app.get("/api/config", summary="Get current configuration")
def get_config() -> dict:
    return _load_config()


@app.post("/api/config/setup", summary="Save initial setup configuration")
def setup_config(config: dict) -> dict:
    config["setup_complete"] = True
    merged = _deep_merge(DEFAULT_CONFIG, config)
    merged["setup_complete"] = True
    _save_config(merged)
    return {"status": "ok"}


@app.patch("/api/config", summary="Update configuration settings")
def update_config(updates: dict) -> dict:
    config = _load_config()
    merged = _deep_merge(config, updates)
    _save_config(merged)
    return {"status": "ok"}


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

@app.get("/api/agents", summary="List all agents with their models and roles")
def list_agents() -> list[dict]:
    """Return every known agent (core team, on-demand, and dynamically hired)."""
    agents: list[dict] = []

    for agent_id, info in AGENT_REGISTRY.items():
        entry = {
            "id": agent_id,
            "name": _get_agent_name(agent_id, info["name"]),
            "role": info["role"],
            "model": info["model"],
            "status": info["status"],
            "team": info["team"],
        }
        agents.append(entry)

    # Dynamically hired agents from hiring log.
    hiring_log_path = os.path.join(DATA_DIR, "hiring_log.yaml")
    if os.path.exists(hiring_log_path):
        with open(hiring_log_path) as f:
            log = yaml.safe_load(f) or {"hired": []}
        for h in log.get("hired", []):
            entry = {
                "id": h["name"],
                "name": h["name"],
                "role": h["role"],
                "model": h.get("model", "sonnet"),
                "status": h.get("status", "active"),
                "team": "hired",
                "expertise": h.get("expertise", ""),
                "hired_at": h.get("hired_at", ""),
            }
            agents.append(entry)

    return agents


@app.get("/api/agents/{agent_id}", summary="Get detailed info for a single agent")
def get_agent_detail(agent_id: str) -> dict:
    """Return detailed agent info including assigned tasks and recent activity."""
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
    """Set plan_approved=true on the project, marking the Chairman has approved it."""
    try:
        validate_safe_id(project_id, "project_id")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project ID format.")
    ok = state_manager.update_project(project_id, {"plan_approved": True, "status": "active"})
    if not ok:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    return {"status": "approved"}


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


def _load_chat_messages() -> list[dict]:
    """Load chat messages from disk."""
    if not os.path.exists(CHAT_LOG_PATH):
        return []
    try:
        with open(CHAT_LOG_PATH) as f:
            data = json.load(f)
        return data.get("messages", [])
    except (json.JSONDecodeError, OSError):
        return []


def _save_chat_messages(messages: list[dict]) -> None:
    """Persist chat messages to disk."""
    os.makedirs(os.path.dirname(CHAT_LOG_PATH), exist_ok=True)
    with open(CHAT_LOG_PATH, "w") as f:
        json.dump({"messages": messages}, f, indent=2)


def _append_chat_message(role: str, content: str) -> dict:
    """Append a message and return it."""
    msg = {
        "role": role,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    messages = _load_chat_messages()
    messages.append(msg)
    # Keep last 200 messages
    if len(messages) > 200:
        messages = messages[-200:]
    _save_chat_messages(messages)
    return msg


def _build_context_prompt(
    user_message: str,
    history_limit: int = 8,
    user_name: str = "User",
    ceo_name: str = "CEO",
    company_name: str = "",
) -> str:
    """Build a prompt that includes recent conversation context and persona context."""
    messages = _load_chat_messages()
    recent = messages[-history_limit:] if len(messages) > history_limit else messages

    parts: list[str] = []

    # Inject persona context so the CEO knows its own name and the user's role regardless
    # of what may be hardcoded in the agent definition file.
    company_label = f" of {company_name}" if company_name else ""
    parts.append(
        f"[CONTEXT: You are {ceo_name}, the CEO{company_label}. "
        f"The person you are speaking with is {user_name}, the Chairman of the company. "
        f"Always refer to yourself as {ceo_name} and address the user as {user_name} or 'Chairman'.]"
    )
    parts.append("")

    if recent:
        parts.append("Recent conversation context:")
        for msg in recent:
            speaker = user_name if msg["role"] == "user" else f"You ({ceo_name}, CEO)"
            parts.append(f"{speaker}: {msg['content']}")
        parts.append("")

    parts.append(f"{user_name} says now: {user_message}")
    parts.append("")
    parts.append(f"Respond to {user_name}'s latest message. You have full access to your MCP tools for company operations.")
    return "\n".join(parts)


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


@app.get("/api/chat/history", summary="Get CEO chat message history")
def chat_history(limit: int = Query(default=50, ge=1, le=200)) -> list[dict]:
    """Return recent chat messages."""
    messages = _load_chat_messages()
    return messages[-limit:]


@app.delete("/api/chat/history", summary="Clear chat history")
def clear_chat_history() -> dict:
    """Clear the chat log."""
    _save_chat_messages([])
    return {"status": "cleared"}


# ---------------------------------------------------------------------------
# CEO chat: per-provider handler functions
# ---------------------------------------------------------------------------

async def _handle_ceo_claude(
    websocket: WebSocket,
    prompt: str,
    claude_path: str,
    llm_cfg: dict,
    ceo_name: str = "CEO",
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
    if llm_cfg.get("proxy_enabled") and llm_cfg.get("proxy_url"):
        env["ANTHROPIC_BASE_URL"] = llm_cfg["proxy_url"]
        env["ANTHROPIC_API_KEY"] = env.get("ANTHROPIC_API_KEY") or "litellm"

    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            claude_path, "--agent", "ceo", "-p", prompt,
            "--output-format", "stream-json", "--verbose",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=PROJECT_ROOT,
        )

        response_parts: list[str] = []
        full_response: str | None = None
        assert process.stdout is not None
        idle_ticks = 0  # how many 30-s timeouts in a row

        while True:
            try:
                raw = await asyncio.wait_for(process.stdout.readline(), timeout=30.0)
            except asyncio.TimeoutError:
                idle_ticks += 1
                await websocket.send_json({
                    "type": "thinking",
                    "content": f"{ceo_name} is working… ({idle_ticks * 30}s)",
                })
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
                        action_label = _format_tool_action(
                            block.get("name", "tool"), block.get("input", {})
                        )
                        await websocket.send_json({"type": "action", "content": action_label})

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
                            await websocket.send_json({"type": "action_result", "content": preview})

            elif event_type == "result":
                # Final result — use this as the canonical response
                full_response = event.get("result") or "".join(response_parts)
                break

            elif event_type == "error":
                err = event.get("message", "Unknown error")
                await websocket.send_json({"type": "error", "content": err})
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
            return None

        return full_response

    except OSError as exc:
        await websocket.send_json({"type": "error", "content": f"Failed to start CEO agent: {exc}"})
        return None
    except Exception as exc:
        await websocket.send_json({"type": "error", "content": f"Chat error: {str(exc)[:200]}"})
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

    response_parts: list[str] = []
    first_token = True

    # Show an action entry immediately so the ActionLog appears while connecting
    await websocket.send_json({"type": "action", "content": f"Connecting to {model}…"})

    # Background task: send periodic "thinking" pings while we wait for tokens
    thinking_event = asyncio.Event()

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
            except Exception:
                break

    ping_task = asyncio.create_task(_thinking_pings())
    try:
        async for chunk in stream_openai_compat(
            prompt=prompt,
            base_url=base_url,
            model=model,
            api_key=api_key,
            system_prompt=system_prompt,
        ):
            if first_token:
                first_token = False
                thinking_event.set()  # stop pings
                await websocket.send_json({"type": "action_result", "content": ""})
                await websocket.send_json({"type": "action", "content": "Generating response…"})
            response_parts.append(chunk)
            await websocket.send_json({"type": "chunk", "content": chunk})
    except RuntimeError as exc:
        # openai package not installed
        await websocket.send_json({"type": "error", "content": str(exc)})
        return None
    except Exception as exc:
        await websocket.send_json({"type": "error", "content": f"LLM error: {str(exc)[:300]}"})
        return None
    finally:
        thinking_event.set()
        ping_task.cancel()
        try:
            await ping_task
        except asyncio.CancelledError:
            pass

    return "".join(response_parts).strip()


@app.websocket("/api/chat/ws")
async def chat_websocket(websocket: WebSocket) -> None:
    """WebSocket endpoint for real-time CEO chat."""
    await websocket.accept()

    config = _load_config()
    llm_cfg = config.get("llm", {})
    provider = llm_cfg.get("provider", "anthropic")

    # For Anthropic/proxy mode we still need the Claude CLI
    claude_path: str | None = None
    if provider == "anthropic":
        claude_path = shutil.which("claude")
        if not claude_path:
            await websocket.send_json({
                "type": "error",
                "content": "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code",
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

            # Store user message
            async with _chat_lock:
                user_msg = _append_chat_message("user", user_message)
            await websocket.send_json({"type": "user_ack", "message": user_msg})

            # Reload config each turn so Settings changes take effect live
            config = _load_config()
            llm_cfg = config.get("llm", {})
            provider = llm_cfg.get("provider", "anthropic")
            user_name = config.get("user", {}).get("name", "User") or "User"
            ceo_name = config.get("agents", {}).get("ceo", "CEO") or "CEO"
            company_name = config.get("company", {}).get("name", "") if isinstance(config.get("company"), dict) else ""
            prompt = _build_context_prompt(
                user_message,
                user_name=user_name,
                ceo_name=ceo_name,
                company_name=company_name,
            )

            if provider in ("openai", "openai_compat"):
                full_response = await _handle_ceo_openai(websocket, prompt, llm_cfg, ceo_name)
            else:
                full_response = await _handle_ceo_claude(
                    websocket, prompt, claude_path or "", llm_cfg, ceo_name=ceo_name
                )

            if full_response:
                async with _chat_lock:
                    _append_chat_message("ceo", full_response)
            await websocket.send_json({"type": "done", "content": full_response or ""})

    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass


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
