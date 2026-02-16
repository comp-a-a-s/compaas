"""Tests for MCP tool registration and server creation."""

import os
import tempfile
import pytest
from fastmcp import FastMCP

from src.mcp_server.project_tools import register_project_tools
from src.mcp_server.task_board_tools import register_task_tools
from src.mcp_server.memory_tools import register_memory_tools
from src.mcp_server.company_tools import register_company_tools
from src.mcp_server.metrics_tools import register_metrics_tools
from src.mcp_server.micro_agent_tools import register_micro_agent_tools


@pytest.fixture
def data_dir():
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "projects"))
        yield d


def _get_tool_names(mcp: FastMCP) -> list[str]:
    """Extract registered tool names from a FastMCP server."""
    # Access the internal tool registry
    return list(mcp._tool_manager._tools.keys())


class TestProjectTools:
    def test_register_tools(self, data_dir):
        mcp = FastMCP("test")
        register_project_tools(mcp, data_dir)
        names = _get_tool_names(mcp)
        assert "create_project" in names
        assert "get_project_status" in names
        assert "update_project" in names
        assert "list_projects" in names


class TestTaskTools:
    def test_register_tools(self, data_dir):
        mcp = FastMCP("test")
        register_task_tools(mcp, data_dir)
        names = _get_tool_names(mcp)
        assert "create_task" in names
        assert "update_task_status" in names
        assert "get_task_board" in names
        assert "assign_task" in names


class TestMemoryTools:
    def test_register_tools(self, data_dir):
        mcp = FastMCP("test")
        register_memory_tools(mcp, data_dir)
        names = _get_tool_names(mcp)
        assert "read_memory" in names
        assert "write_memory" in names
        assert "log_decision" in names
        assert "get_decisions" in names


class TestCompanyTools:
    def test_register_tools(self, data_dir):
        mcp = FastMCP("test")
        register_company_tools(mcp, data_dir)
        names = _get_tool_names(mcp)
        assert "get_org_chart" in names
        assert "get_roster" in names
        assert "hire_agent" in names
        assert "fire_agent" in names


class TestMetricsTools:
    def test_register_tools(self, data_dir):
        mcp = FastMCP("test")
        register_metrics_tools(mcp, data_dir)
        names = _get_tool_names(mcp)
        assert "log_token_usage" in names
        assert "get_token_report" in names
        assert "get_session_durations" in names
        assert "estimate_task_cost" in names


class TestMicroAgentTools:
    def test_register_tools(self, data_dir):
        mcp = FastMCP("test")
        register_micro_agent_tools(mcp, data_dir)
        names = _get_tool_names(mcp)
        assert "spawn_micro_agent" in names
        assert "list_micro_agents" in names
        assert "retire_micro_agent" in names


class TestServerCreation:
    def test_create_all_scopes(self):
        from src.mcp_server.server import create_server
        server = create_server("all")
        assert server is not None
        names = _get_tool_names(server)
        # Should have all tools from all scopes (4+4+4+4+4+3 = 23)
        assert len(names) >= 20

    def test_create_individual_scopes(self):
        from src.mcp_server.server import create_server
        for scope in ["project", "tasks", "memory", "company", "metrics", "micro_agents"]:
            server = create_server(scope)
            assert server is not None
            names = _get_tool_names(server)
            assert len(names) >= 3  # Each scope has at least 3-4 tools
