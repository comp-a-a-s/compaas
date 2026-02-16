"""Tests for metrics, micro-agents, and utility modules."""

import os
import tempfile
import yaml
import pytest

from src.utils import resolve_data_dir, resolve_project_root
from src.state.task_board import TaskBoard, VALID_STATUSES


class TestUtils:
    def test_resolve_data_dir_returns_string(self):
        result = resolve_data_dir()
        assert isinstance(result, str)
        assert os.path.isabs(result)

    def test_resolve_project_root_returns_string(self):
        result = resolve_project_root()
        assert isinstance(result, str)
        assert os.path.isabs(result)

    def test_resolve_data_dir_env_override(self):
        os.environ["CRACKPIE_DATA_DIR"] = "/tmp/test_crackpie_data"
        try:
            result = resolve_data_dir()
            assert result == "/tmp/test_crackpie_data"
        finally:
            del os.environ["CRACKPIE_DATA_DIR"]


class TestTaskBoardValidation:
    @pytest.fixture
    def setup(self):
        with tempfile.TemporaryDirectory() as d:
            from src.state.project_state import ProjectStateManager
            mgr = ProjectStateManager(d)
            pid = mgr.create_project("Test", "Test", "general")
            board = TaskBoard(d)
            yield board, pid

    def test_valid_statuses_constant(self):
        assert "todo" in VALID_STATUSES
        assert "in_progress" in VALID_STATUSES
        assert "done" in VALID_STATUSES
        assert "blocked" in VALID_STATUSES
        assert "review" in VALID_STATUSES

    def test_reject_invalid_status(self, setup):
        board, pid = setup
        tid = board.create_task(pid, "Task", "Desc", "lead-backend")
        # Invalid status should be rejected
        ok = board.update_status(pid, tid, "INVALID_STATUS")
        assert not ok

    def test_accept_valid_status(self, setup):
        board, pid = setup
        tid = board.create_task(pid, "Task", "Desc", "lead-backend")
        ok = board.update_status(pid, tid, "in_progress")
        assert ok

    def test_corrupted_yaml_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            projects_dir = os.path.join(d, "projects", "test-id")
            os.makedirs(projects_dir)
            tasks_path = os.path.join(projects_dir, "tasks.yaml")
            # Write corrupted YAML
            with open(tasks_path, "w") as f:
                f.write("{{{{invalid yaml content")

            board = TaskBoard(d)
            tasks = board.get_board("test-id")
            assert tasks == []


class TestCompanyToolsOrgChart:
    def test_new_agents_in_leadership(self):
        """Verify that chief-researcher, ciso, and cfo appear in org chart leadership."""
        from src.mcp_server.company_tools import CORE_TEAM
        # These should all be in CORE_TEAM
        assert "chief-researcher" in CORE_TEAM
        assert "ciso" in CORE_TEAM
        assert "cfo" in CORE_TEAM
        # Verify their roles
        assert CORE_TEAM["chief-researcher"]["role"] == "Chief Researcher"
        assert CORE_TEAM["ciso"]["role"] == "Chief Information Security Officer"
        assert CORE_TEAM["cfo"]["role"] == "Chief Financial Officer"

    def test_org_chart_includes_new_agents(self):
        """Verify get_org_chart includes new agents in leadership section."""
        from fastmcp import FastMCP
        from src.mcp_server.company_tools import register_company_tools

        with tempfile.TemporaryDirectory() as d:
            mcp = FastMCP("test")
            register_company_tools(mcp, d)

            # Call the tool function directly
            get_org_chart = mcp._tool_manager._tools["get_org_chart"].fn
            result = get_org_chart()
            data = yaml.safe_load(result)

            # New agents should be in leadership, not missing
            leadership = data.get("leadership", {})
            assert "chief-researcher" in leadership
            assert "ciso" in leadership
            assert "cfo" in leadership


class TestWebApiAgentNames:
    def test_agent_names_complete(self):
        """Verify all agents have human names defined."""
        from src.web.api import AGENT_NAMES
        from src.mcp_server.company_tools import CORE_TEAM, ON_DEMAND_TEAM

        for agent_id in CORE_TEAM:
            assert agent_id in AGENT_NAMES, f"Missing name for core agent: {agent_id}"
        for agent_id in ON_DEMAND_TEAM:
            assert agent_id in AGENT_NAMES, f"Missing name for on-demand agent: {agent_id}"
