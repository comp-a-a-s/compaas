"""Security-focused tests — path traversal prevention, input sanitisation, CORS."""

import os
import pytest
from fastmcp import FastMCP

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard
from src.mcp_server.company_tools import (
    register_company_tools,
    CORE_TEAM,
    ON_DEMAND_TEAM,
)
from src.mcp_server.micro_agent_tools import register_micro_agent_tools


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_tool(mcp: FastMCP, name: str):
    """Return the raw callable registered under *name* in *mcp*."""
    return mcp._tool_manager._tools[name].fn


# ---------------------------------------------------------------------------
# ProjectStateManager — path traversal prevention
# ---------------------------------------------------------------------------

class TestProjectStateManagerSecurity:
    def test_get_project_rejects_double_dot_id(self, temp_data_dir):
        mgr = ProjectStateManager(temp_data_dir)
        result = mgr.get_project("../../etc/passwd")
        assert result is None

    def test_get_project_rejects_slash_in_id(self, temp_data_dir):
        mgr = ProjectStateManager(temp_data_dir)
        result = mgr.get_project("foo/bar")
        assert result is None

    def test_get_project_rejects_backslash_in_id(self, temp_data_dir):
        mgr = ProjectStateManager(temp_data_dir)
        result = mgr.get_project("foo\\bar")
        assert result is None

    def test_get_project_rejects_empty_id(self, temp_data_dir):
        mgr = ProjectStateManager(temp_data_dir)
        result = mgr.get_project("")
        assert result is None

    def test_update_project_rejects_path_traversal_id(self, temp_data_dir):
        mgr = ProjectStateManager(temp_data_dir)
        ok = mgr.update_project("../../etc/passwd", {"status": "pwned"})
        assert ok is False

    def test_update_project_rejects_slash_in_id(self, temp_data_dir):
        mgr = ProjectStateManager(temp_data_dir)
        ok = mgr.update_project("projects/../../hack", {"status": "pwned"})
        assert ok is False

    def test_list_projects_skips_unsafe_directory_names(self, temp_data_dir):
        # Manually plant a directory with a traversal-like name
        bad_dir = os.path.join(temp_data_dir, "projects", "..", "escaped")
        try:
            os.makedirs(bad_dir, exist_ok=True)
        except OSError:
            pytest.skip("Cannot create traversal-named directory on this OS")

        mgr = ProjectStateManager(temp_data_dir)
        projects = mgr.list_projects()
        ids = {p["id"] for p in projects}
        assert ".." not in ids

    def test_create_and_retrieve_project_with_valid_id(self, temp_data_dir):
        """Sanity check: normal IDs should still work after security validation."""
        mgr = ProjectStateManager(temp_data_dir)
        pid = mgr.create_project("Safe Project", "Should work", "web")
        assert mgr.get_project(pid) is not None


# ---------------------------------------------------------------------------
# TaskBoard — path traversal prevention
# ---------------------------------------------------------------------------

class TestTaskBoardSecurity:
    def test_tasks_path_raises_on_traversal_id(self, temp_data_dir):
        board = TaskBoard(temp_data_dir)
        from src.validators import validate_safe_id
        with pytest.raises(ValueError, match="path traversal"):
            validate_safe_id("../../etc/passwd", "project_id")

    def test_get_board_for_traversal_project_id_raises(self, temp_data_dir):
        board = TaskBoard(temp_data_dir)
        with pytest.raises(ValueError):
            board._tasks_path("../../etc/passwd")

    def test_get_board_for_slash_project_id_raises(self, temp_data_dir):
        board = TaskBoard(temp_data_dir)
        with pytest.raises(ValueError):
            board._tasks_path("foo/bar")

    def test_create_task_for_traversal_project_id_raises(self, temp_data_dir):
        board = TaskBoard(temp_data_dir)
        with pytest.raises(ValueError):
            board.create_task("../../hack", "Title", "Desc", "agent")

    def test_update_status_for_traversal_project_id_raises(self, temp_data_dir):
        board = TaskBoard(temp_data_dir)
        with pytest.raises(ValueError):
            board.update_status("../../hack", "TASK-001", "done")

    def test_valid_project_id_is_not_blocked(self, state_manager, task_board):
        pid = state_manager.create_project("Sec Test", "desc", "api")
        tid = task_board.create_task(pid, "Work", "Do work", "lead-backend")
        assert tid.startswith("TASK-")


# ---------------------------------------------------------------------------
# hire_agent — input validation
# ---------------------------------------------------------------------------

class TestHireAgentSecurity:
    @pytest.fixture
    def hire(self, temp_data_dir):
        mcp = FastMCP("test")
        register_company_tools(mcp, temp_data_dir)
        return _get_tool(mcp, "hire_agent")

    def test_hire_rejects_uppercase_name(self, hire):
        result = hire(name="ML-Engineer", role="ML Eng", expertise="ML")
        assert result.startswith("Error")

    def test_hire_rejects_underscore_in_name(self, hire):
        result = hire(name="ml_engineer", role="ML Eng", expertise="ML")
        assert result.startswith("Error")

    def test_hire_rejects_name_with_spaces(self, hire):
        result = hire(name="ml engineer", role="ML Eng", expertise="ML")
        assert result.startswith("Error")

    def test_hire_rejects_path_traversal_name(self, hire):
        result = hire(name="../etc/passwd", role="Hacker", expertise="Pwning")
        assert result.startswith("Error")

    def test_hire_rejects_slash_in_name(self, hire):
        result = hire(name="foo/bar", role="Role", expertise="Skills")
        assert result.startswith("Error")

    def test_hire_rejects_invalid_model(self, hire):
        result = hire(name="ml-engineer", role="ML Eng", expertise="ML", model="gpt4")
        assert result.startswith("Error")

    def test_hire_rejects_invalid_model_empty(self, hire):
        result = hire(name="ml-engineer", role="ML Eng", expertise="ML", model="")
        assert result.startswith("Error")

    def test_hire_rejects_core_team_name_cto(self, hire):
        result = hire(name="cto", role="CTO", expertise="Tech")
        assert result.startswith("Error")
        assert "cto" in result

    def test_hire_rejects_core_team_name_qa_lead(self, hire):
        result = hire(name="qa-lead", role="QA", expertise="Testing")
        assert result.startswith("Error")

    def test_hire_rejects_ceo_name(self, hire):
        result = hire(name="ceo", role="CEO", expertise="Leadership")
        assert result.startswith("Error")

    def test_hire_rejects_on_demand_team_name(self, hire):
        # Pick the first on-demand agent
        on_demand_name = next(iter(ON_DEMAND_TEAM))
        result = hire(name=on_demand_name, role="Role", expertise="Skills")
        assert result.startswith("Error")

    def test_hire_rejects_invalid_tool_name(self, hire):
        result = hire(
            name="ml-engineer",
            role="ML Eng",
            expertise="ML",
            tools="Read,INVALID_TOOL",
        )
        assert result.startswith("Error")
        assert "Invalid tools" in result

    def test_hire_succeeds_with_valid_inputs(self, hire):
        result = hire(
            name="ml-engineer",
            role="Machine Learning Engineer",
            expertise="Building ML models",
            tools="Read,Write,Bash",
            model="sonnet",
        )
        assert "ml-engineer" in result
        assert not result.startswith("Error")

    def test_all_core_team_names_are_blocked(self, hire):
        for name in CORE_TEAM:
            result = hire(name=name, role="Role", expertise="Skills")
            assert result.startswith("Error"), f"Core agent '{name}' should be blocked"

    def test_all_on_demand_names_are_blocked(self, hire):
        for name in ON_DEMAND_TEAM:
            result = hire(name=name, role="Role", expertise="Skills")
            assert result.startswith("Error"), f"On-demand agent '{name}' should be blocked"


# ---------------------------------------------------------------------------
# retire_micro_agent — path traversal prevention
# ---------------------------------------------------------------------------

class TestRetireMicroAgentSecurity:
    @pytest.fixture
    def retire(self, temp_data_dir):
        mcp = FastMCP("test")
        register_micro_agent_tools(mcp, temp_data_dir)
        return _get_tool(mcp, "retire_micro_agent")

    def test_retire_rejects_double_dot_name(self, retire):
        result = retire(name="../../etc/passwd")
        assert result.startswith("Error")

    def test_retire_rejects_slash_in_name(self, retire):
        result = retire(name="../micro-agent")
        assert result.startswith("Error")

    def test_retire_rejects_uppercase_name(self, retire):
        result = retire(name="Micro-Agent")
        assert result.startswith("Error")

    def test_retire_rejects_non_micro_prefix(self, retire):
        result = retire(name="lead-backend")
        assert result.startswith("Error")
        assert "micro-" in result

    def test_retire_rejects_empty_name(self, retire):
        result = retire(name="")
        assert result.startswith("Error")


# ---------------------------------------------------------------------------
# CORS configuration — must NOT be wildcard
# ---------------------------------------------------------------------------

class TestCorsConfiguration:
    def test_cors_origins_are_not_wildcard(self):
        from src.web.api import app
        # Find the CORSMiddleware in the app's middleware stack
        cors_middleware = None
        for middleware in app.user_middleware:
            # Starlette stores middleware as (cls, options) pairs
            cls = middleware.cls if hasattr(middleware, "cls") else middleware[0]
            if "cors" in cls.__name__.lower():
                cors_middleware = middleware
                break

        assert cors_middleware is not None, "CORSMiddleware not found in app middleware"

        # Extract allow_origins from kwargs
        if hasattr(cors_middleware, "kwargs"):
            origins = cors_middleware.kwargs.get("allow_origins", [])
        else:
            origins = cors_middleware[1].get("allow_origins", [])

        assert "*" not in origins, "CORS allow_origins must not include wildcard '*'"
        assert origins, "CORS allow_origins should not be empty"

    def test_cors_allows_standard_methods(self):
        """Default CORS policy allows standard HTTP methods needed by the dashboard."""
        from src.web.api import app
        cors_middleware = None
        for middleware in app.user_middleware:
            cls = middleware.cls if hasattr(middleware, "cls") else middleware[0]
            if "cors" in cls.__name__.lower():
                cors_middleware = middleware
                break

        assert cors_middleware is not None

        if hasattr(cors_middleware, "kwargs"):
            methods = cors_middleware.kwargs.get("allow_methods", [])
        else:
            methods = cors_middleware[1].get("allow_methods", [])

        # Dashboard needs GET, POST, PATCH, PUT, DELETE, OPTIONS
        for required in ("GET", "POST", "PATCH", "DELETE"):
            assert required in methods, f"CORS must allow {required}, got: {methods}"
        assert "*" not in methods, "CORS should not use wildcard methods"

    def test_default_origins_are_localhost_only(self):
        """When COMPAAS_CORS_ORIGINS env var is not set, only localhost origins allowed."""
        original = os.environ.pop("COMPAAS_CORS_ORIGINS", None)
        try:
            # Re-evaluate the allowed origins list from the module
            from src.web import api as api_module
            # The _allowed_origins list is set at module load time; check it directly
            origins = api_module._allowed_origins
            for origin in origins:
                assert "localhost" in origin or "127.0.0.1" in origin, (
                    f"Non-localhost origin '{origin}' found in default CORS config"
                )
                assert origin != "*", "Wildcard origin must not be in default CORS config"
        finally:
            if original is not None:
                os.environ["COMPAAS_CORS_ORIGINS"] = original
