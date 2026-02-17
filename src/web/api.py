"""CrackPie Web Dashboard API.

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
    title="CrackPie Dashboard API",
    description="Live data API for the CrackPie virtual company web dashboard.",
    version="0.1.0",
)

# CORS — restrict to known origins
_cors_origins_env = os.environ.get("CRACKPIE_CORS_ORIGINS", "")
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

    org: dict = {
        "board_head": {"name": "Idan", "role": "Board Head"},
        "ceo": {"name": "Marcus", "role": "CEO — Central Orchestrator"},
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
        _active_sse_connections -= 1


@app.get("/api/activity/stream", summary="SSE stream of activity.log changes")
def activity_stream() -> StreamingResponse:
    """Server-Sent Events endpoint."""
    global _active_sse_connections
    if _active_sse_connections >= MAX_SSE_CONNECTIONS:
        raise HTTPException(status_code=429, detail="Too many SSE connections.")
    _active_sse_connections += 1

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


def _build_context_prompt(user_message: str, history_limit: int = 8, user_name: str = "User") -> str:
    """Build a prompt that includes recent conversation context."""
    messages = _load_chat_messages()
    recent = messages[-history_limit:] if len(messages) > history_limit else messages

    if not recent:
        return user_message

    parts: list[str] = []
    parts.append("Recent conversation context:")
    for msg in recent:
        speaker = user_name if msg["role"] == "user" else "You (Marcus, CEO)"
        parts.append(f"{speaker}: {msg['content']}")
    parts.append("")
    parts.append(f"{user_name} says now: {user_message}")
    parts.append("")
    parts.append(f"Respond to {user_name}'s latest message. You have full access to your MCP tools for company operations.")
    return "\n".join(parts)


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


@app.websocket("/api/chat/ws")
async def chat_websocket(websocket: WebSocket) -> None:
    """WebSocket endpoint for real-time CEO chat."""
    await websocket.accept()

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

            # Build prompt with conversation context
            config = _load_config()
            user_name = config.get("user", {}).get("name", "User")
            prompt = _build_context_prompt(user_message, user_name=user_name)

            process = None
            try:
                process = await asyncio.create_subprocess_exec(
                    claude_path, "--agent", "ceo", "-p", prompt,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=PROJECT_ROOT,
                )

                response_parts: list[str] = []
                assert process.stdout is not None

                # Read with timeout - send thinking indicator periodically
                while True:
                    try:
                        chunk = await asyncio.wait_for(process.stdout.read(512), timeout=5.0)
                        if not chunk:
                            break
                        text = chunk.decode("utf-8", errors="replace")
                        response_parts.append(text)
                        await websocket.send_json({"type": "chunk", "content": text})
                    except asyncio.TimeoutError:
                        # No output yet — send thinking indicator to keep connection alive
                        await websocket.send_json({"type": "thinking"})
                        # Check if process is still running
                        if process.returncode is not None:
                            break

                # Wait for process to finish (max 10s after stdout closes)
                try:
                    await asyncio.wait_for(process.wait(), timeout=10.0)
                except asyncio.TimeoutError:
                    process.kill()

                full_response = "".join(response_parts).strip()

                if not full_response and process.returncode != 0:
                    assert process.stderr is not None
                    stderr_text = (await process.stderr.read()).decode("utf-8", errors="replace").strip()
                    error_msg = stderr_text[:500] or f"CEO agent exited with code {process.returncode}"
                    await websocket.send_json({"type": "error", "content": error_msg})
                    continue

                if full_response:
                    async with _chat_lock:
                        _append_chat_message("ceo", full_response)

                await websocket.send_json({"type": "done", "content": full_response})

            except OSError as exc:
                await websocket.send_json({"type": "error", "content": f"Failed to start CEO agent: {exc}"})
            except Exception as exc:
                await websocket.send_json({"type": "error", "content": f"Chat error: {str(exc)[:200]}"})
            finally:
                if process and process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass

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
