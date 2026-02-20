"""Additional coverage for micro-agent lifecycle tooling."""

from __future__ import annotations

import os

import yaml
from fastmcp import FastMCP

import src.mcp_server.micro_agent_tools as micro_tools


def _tool_fn(mcp: FastMCP, name: str):
    return mcp._tool_manager._tools[name].fn


def test_escape_yaml_value_quotes_special_characters():
    escaped = micro_tools._escape_yaml_value('needs: "quotes" and spaces')
    assert escaped.startswith('"') and escaped.endswith('"')


def test_generate_agent_content_includes_parent_context():
    content = micro_tools._generate_agent_content(
        name="micro-backend-auth",
        parent_agent="lead-backend",
        specialization="auth flow",
        task_description="Implement authentication middleware",
        model="sonnet",
    )
    assert "micro-backend-auth" in content
    assert "auth flow" in content
    assert "lead-backend" in content
    assert "Implement authentication middleware" in content


def test_spawn_list_retire_micro_agent_cycle(temp_data_dir, tmp_path, monkeypatch):
    agents_dir = tmp_path / ".claude" / "agents"
    agents_dir.mkdir(parents=True)
    monkeypatch.setattr(micro_tools, "_find_agents_dir", lambda: str(agents_dir))

    mcp = FastMCP("micro-agent-test")
    micro_tools.register_micro_agent_tools(mcp, temp_data_dir)

    spawn = _tool_fn(mcp, "spawn_micro_agent")
    list_agents = _tool_fn(mcp, "list_micro_agents")
    retire = _tool_fn(mcp, "retire_micro_agent")

    result = spawn(
        parent_agent="lead-backend",
        specialization="auth flow",
        task_description="Implement authentication middleware",
    )
    assert "spawned successfully" in result
    assert os.path.exists(agents_dir / "micro-backend-auth-flow.md")

    listed = list_agents()
    payload = yaml.safe_load(listed)
    names = [a["name"] for a in payload["active_micro_agents"]]
    assert "micro-backend-auth-flow" in names

    retired = retire("micro-backend-auth-flow")
    assert "retired" in retired
    assert "No micro-agents currently active" in list_agents()

    log_path = os.path.join(temp_data_dir, "micro_agents.yaml")
    with open(log_path) as f:
        log = yaml.safe_load(f) or {}
    matching = [a for a in log.get("agents", []) if a.get("name") == "micro-backend-auth-flow"]
    assert matching
    assert matching[0]["status"] == "retired"


def test_spawn_rejects_invalid_model(temp_data_dir, tmp_path, monkeypatch):
    agents_dir = tmp_path / ".claude" / "agents"
    agents_dir.mkdir(parents=True)
    monkeypatch.setattr(micro_tools, "_find_agents_dir", lambda: str(agents_dir))

    mcp = FastMCP("micro-agent-test")
    micro_tools.register_micro_agent_tools(mcp, temp_data_dir)
    spawn = _tool_fn(mcp, "spawn_micro_agent")

    result = spawn(
        parent_agent="lead-backend",
        specialization="db migration",
        task_description="create migrations",
        model="invalid-model",
    )
    assert result.startswith("Error:")


def test_spawn_detects_existing_agent_file(temp_data_dir, tmp_path, monkeypatch):
    agents_dir = tmp_path / ".claude" / "agents"
    agents_dir.mkdir(parents=True)
    existing = agents_dir / "micro-backend-db-migration.md"
    existing.write_text("---\nname: micro-backend-db-migration\n---\n")
    monkeypatch.setattr(micro_tools, "_find_agents_dir", lambda: str(agents_dir))

    mcp = FastMCP("micro-agent-test")
    micro_tools.register_micro_agent_tools(mcp, temp_data_dir)
    spawn = _tool_fn(mcp, "spawn_micro_agent")

    result = spawn(
        parent_agent="lead-backend",
        specialization="db migration",
        task_description="create migrations",
        model="sonnet",
    )
    assert "already exists" in result
