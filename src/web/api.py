"""CrackPie Web Dashboard API.

FastAPI application exposing live company state — org chart, projects,
tasks, activity stream, token metrics, agents, and model settings.
"""

import os
import asyncio
import yaml
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard
from src.mcp_server.company_tools import CORE_TEAM, ON_DEMAND_TEAM
from src.utils import resolve_data_dir, resolve_project_root


# Human names for agents — matches .claude/agents/*.md definitions
AGENT_NAMES: dict[str, str] = {
    "ceo": "Marcus",
    "cto": "Elena",
    "chief-researcher": "Victor",
    "ciso": "Rachel",
    "cfo": "Jonathan",
    "vp-product": "Sarah",
    "vp-engineering": "David",
    "lead-backend": "James",
    "lead-frontend": "Priya",
    "lead-designer": "Lena",
    "qa-lead": "Carlos",
    "devops": "Nina",
    "security-engineer": "Alex",
    "data-engineer": "Maya",
    "tech-writer": "Tom",
}


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    project = state_manager.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    tasks = task_board.get_board(project_id)
    # Return both flat (for backwards compat) and nested (for typed clients)
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
    project = state_manager.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    return task_board.get_board(project_id, filter_status=status, filter_assignee=assignee)


# ---------------------------------------------------------------------------
# Activity stream (SSE)
# ---------------------------------------------------------------------------

async def _tail_activity_log(activity_log_path: str) -> AsyncGenerator[str, None]:
    """Async generator that watches activity.log for new lines via polling.

    Yields SSE-formatted strings. Polls every second by watching the file size.
    New content is sent as individual ``data:`` events.
    """
    last_size: int = 0
    last_pos: int = 0

    # If the file already exists, start from the end so we only stream new events.
    if os.path.exists(activity_log_path):
        last_size = os.path.getsize(activity_log_path)
        last_pos = last_size

    while True:
        await asyncio.sleep(1)
        if not os.path.exists(activity_log_path):
            # Send a keep-alive comment while the file doesn't exist yet.
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
                    # Escape any embedded newlines in the data value.
                    escaped = line.replace("\n", "\\n")
                    yield f"data: {escaped}\n\n"
        elif current_size < last_size:
            # File was truncated/rotated — reset position.
            last_size = current_size
            last_pos = 0
        else:
            # No change; send keep-alive comment so the connection stays open.
            yield ": keep-alive\n\n"


@app.get("/api/activity/stream", summary="SSE stream of activity.log changes")
def activity_stream() -> StreamingResponse:
    """Server-Sent Events endpoint.  Streams new lines from activity.log in
    real-time.  Connect with ``EventSource('/api/activity/stream')`` in the
    browser.
    """
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
    """Return an aggregated token usage report, optionally filtered by project
    or agent.
    """
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


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------

@app.get("/api/agents", summary="List all agents with their models and roles")
def list_agents() -> list[dict]:
    """Return every known agent (core team, on-demand, and dynamically hired)
    with their display name, role, model, and status.
    """
    agents: list[dict] = []

    # CEO is not in CORE_TEAM — add it explicitly.
    agents.append({
        "id": "ceo",
        "name": "Marcus",
        "role": "CEO — Central Orchestrator",
        "model": "opus",
        "status": "permanent",
        "team": "leadership",
    })

    LEADERSHIP_IDS = {"cto", "vp-product", "vp-engineering", "chief-researcher", "ciso", "cfo"}
    ENGINEERING_IDS = {"lead-backend", "lead-frontend", "qa-lead", "devops"}

    for agent_id, info in CORE_TEAM.items():
        if agent_id in LEADERSHIP_IDS:
            team = "leadership"
        elif "designer" in info.get("role", "").lower():
            team = "design"
        elif agent_id in ENGINEERING_IDS:
            team = "engineering"
        else:
            team = "engineering"
        agents.append({
            "id": agent_id,
            "name": AGENT_NAMES.get(agent_id, agent_id),
            "role": info["role"],
            "model": info.get("model", "sonnet"),
            "status": info.get("status", "permanent"),
            "team": team,
        })

    for agent_id, info in ON_DEMAND_TEAM.items():
        agents.append({
            "id": agent_id,
            "name": AGENT_NAMES.get(agent_id, agent_id),
            "role": info["role"],
            "model": info.get("model", "sonnet"),
            "status": info.get("status", "available"),
            "team": "on_demand",
        })

    # Dynamically hired agents from hiring log.
    hiring_log_path = os.path.join(DATA_DIR, "hiring_log.yaml")
    if os.path.exists(hiring_log_path):
        with open(hiring_log_path) as f:
            log = yaml.safe_load(f) or {"hired": []}
        for h in log.get("hired", []):
            agents.append({
                "id": h["name"],
                "role": h["role"],
                "model": h.get("model", "sonnet"),
                "status": h.get("status", "active"),
                "team": "hired",
                "expertise": h.get("expertise", ""),
                "hired_at": h.get("hired_at", ""),
            })

    return agents


# ---------------------------------------------------------------------------
# Model settings
# ---------------------------------------------------------------------------

def _parse_frontmatter(path: str) -> dict:
    """Parse YAML frontmatter from a Markdown file.

    Returns the parsed YAML dict, or an empty dict if no frontmatter is found.
    """
    with open(path) as f:
        content = f.read()

    if not content.startswith("---"):
        return {}

    # Find the closing '---' delimiter.
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
    """Read all .claude/agents/*.md files, parse YAML frontmatter, and return
    the name and model assignment for each agent definition file.
    """
    agents_dir = os.path.join(PROJECT_ROOT, ".claude", "agents")
    result: list[dict] = []

    if not os.path.exists(agents_dir):
        return result

    for filename in sorted(os.listdir(agents_dir)):
        if not filename.endswith(".md"):
            continue
        filepath = os.path.join(agents_dir, filename)
        try:
            frontmatter = _parse_frontmatter(filepath)
        except OSError:
            continue

        agent_id = filename[:-3]  # strip .md
        result.append({
            "id": agent_id,
            "name": frontmatter.get("name", agent_id),
            "model": frontmatter.get("model", "unknown"),
            "description": frontmatter.get("description", ""),
            "tools": frontmatter.get("tools", ""),
        })

    return result


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
