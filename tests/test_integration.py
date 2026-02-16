"""End-to-end integration tests for the CrackPie MCP server flow.

These tests exercise the full workflow: spawn agent → create project →
assign tasks → progress through states → complete workflow, using the
actual MCP tool functions wired to a temporary data directory.
"""

import os
import yaml
import pytest

from fastmcp import FastMCP

from src.mcp_server.server import create_server
from src.mcp_server.project_tools import register_project_tools
from src.mcp_server.task_board_tools import register_task_tools
from src.mcp_server.memory_tools import register_memory_tools
from src.mcp_server.company_tools import register_company_tools
from src.mcp_server.metrics_tools import register_metrics_tools
from src.mcp_server.micro_agent_tools import register_micro_agent_tools


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def data_dir(tmp_path):
    """Isolated data directory for each test."""
    d = str(tmp_path / "company_data")
    os.makedirs(os.path.join(d, "projects"), exist_ok=True)
    return d


@pytest.fixture
def tools(data_dir):
    """Register all tool scopes and return a dict of callable tool functions.

    FastMCP registers tools as decorated closures.  We extract them from
    the internal registry so we can invoke them directly in tests.
    """
    mcp = FastMCP("integration-test")
    register_project_tools(mcp, data_dir)
    register_task_tools(mcp, data_dir)
    register_memory_tools(mcp, data_dir)
    register_company_tools(mcp, data_dir)
    register_metrics_tools(mcp, data_dir)
    register_micro_agent_tools(mcp, data_dir)

    # Extract the raw callables from the tool manager
    return {
        name: tool.fn
        for name, tool in mcp._tool_manager._tools.items()
    }


def _extract_project_id(result: str) -> str:
    """Parse 'Project ... created with ID: XXXXXXXX' and return the ID."""
    for part in result.split():
        if len(part) == 8 and part.replace("-", "").isalnum():
            return part
    raise ValueError(f"Could not extract project ID from: {result}")


def _extract_task_id(result: str) -> str:
    """Parse 'Task TASK-XXXXXX created: ...' and return the task ID."""
    for part in result.split():
        if part.startswith("TASK-"):
            return part
    raise ValueError(f"Could not extract task ID from: {result}")


# ---------------------------------------------------------------------------
# Full Workflow Tests
# ---------------------------------------------------------------------------

class TestFullProjectLifecycle:
    """Tests that exercise the complete project lifecycle end-to-end."""

    def test_create_project_and_list(self, tools):
        result = tools["create_project"](name="CrackPie v2", description="Next version", project_type="api")
        assert "created with ID" in result
        pid = _extract_project_id(result)

        listing = tools["list_projects"]()
        assert "CrackPie v2" in listing

        status = tools["get_project_status"](project_id=pid)
        assert "planning" in status
        assert "CrackPie v2" in status

    def test_full_task_workflow(self, tools):
        """Create project → add tasks → progress through states → complete."""
        # 1. Create project
        result = tools["create_project"](name="Auth Service", description="JWT auth", project_type="api")
        pid = _extract_project_id(result)

        # 2. Create tasks
        t1_result = tools["create_task"](
            project_id=pid, title="Design API schema",
            description="Design the REST endpoints", assigned_to="lead-backend", priority="p0",
        )
        t1 = _extract_task_id(t1_result)

        t2_result = tools["create_task"](
            project_id=pid, title="Implement endpoints",
            description="Build the API", assigned_to="lead-backend",
            priority="p1", depends_on=t1,
        )
        t2 = _extract_task_id(t2_result)

        t3_result = tools["create_task"](
            project_id=pid, title="Write tests",
            description="Unit + integration tests", assigned_to="qa-lead", priority="p1",
        )
        t3 = _extract_task_id(t3_result)

        # 3. Verify task board shows all tasks
        board = tools["get_task_board"](project_id=pid)
        assert t1 in board
        assert t2 in board
        assert t3 in board

        # 4. Progress T1: todo → in_progress → done
        r = tools["update_task_status"](project_id=pid, task_id=t1, status="in_progress",
                                        notes="Starting API design")
        assert t1 in r and "in_progress" in r

        r = tools["update_task_status"](project_id=pid, task_id=t1, status="done",
                                        notes="Schema finalized")
        assert t1 in r and "done" in r

        # 5. T2 depends on T1 — now that T1 is done, T2 can proceed
        r = tools["update_task_status"](project_id=pid, task_id=t2, status="in_progress")
        assert t2 in r and "in_progress" in r

        r = tools["update_task_status"](project_id=pid, task_id=t2, status="review")
        assert t2 in r and "review" in r

        r = tools["update_task_status"](project_id=pid, task_id=t2, status="done")
        assert t2 in r and "done" in r

        # 6. T3 (no deps) can also be completed
        tools["update_task_status"](project_id=pid, task_id=t3, status="in_progress")
        tools["update_task_status"](project_id=pid, task_id=t3, status="done")

        # 7. Update project status
        r = tools["update_project"](project_id=pid, status="completed")
        assert "updated" in r.lower()

        # 8. Verify final state
        status = tools["get_project_status"](project_id=pid)
        assert "completed" in status

        done_tasks = tools["get_task_board"](project_id=pid, filter_status="done")
        parsed = yaml.safe_load(done_tasks)
        assert len(parsed) == 3

    def test_dependency_blocking(self, tools):
        """Tasks with unresolved dependencies cannot be marked done or review."""
        result = tools["create_project"](name="Dep Test", description="dep testing", project_type="general")
        pid = _extract_project_id(result)

        t1_result = tools["create_task"](project_id=pid, title="Prerequisite",
                                         description="Must finish first", assigned_to="lead-backend")
        t1 = _extract_task_id(t1_result)

        t2_result = tools["create_task"](project_id=pid, title="Dependent",
                                         description="Depends on prerequisite",
                                         assigned_to="lead-backend", depends_on=t1)
        t2 = _extract_task_id(t2_result)

        # Move T2 to in_progress
        tools["update_task_status"](project_id=pid, task_id=t2, status="in_progress")

        # T2 cannot be marked done/review while T1 is still todo
        r = tools["update_task_status"](project_id=pid, task_id=t2, status="done")
        assert "Error" in r

        r = tools["update_task_status"](project_id=pid, task_id=t2, status="review")
        assert "Error" in r

        # Complete T1, then T2 can be completed
        tools["update_task_status"](project_id=pid, task_id=t1, status="in_progress")
        tools["update_task_status"](project_id=pid, task_id=t1, status="done")

        r = tools["update_task_status"](project_id=pid, task_id=t2, status="done")
        assert t2 in r and "done" in r

    def test_task_reassignment(self, tools):
        """Tasks can be reassigned to different agents."""
        result = tools["create_project"](name="Reassign Test", description="test", project_type="general")
        pid = _extract_project_id(result)

        t_result = tools["create_task"](project_id=pid, title="Flexible task",
                                        description="Can be reassigned", assigned_to="lead-backend")
        tid = _extract_task_id(t_result)

        r = tools["assign_task"](project_id=pid, task_id=tid, assigned_to="lead-frontend")
        assert "reassigned" in r.lower()
        assert "lead-frontend" in r

        # Verify via filter
        board = tools["get_task_board"](project_id=pid, filter_assignee="lead-frontend")
        assert tid in board

    def test_task_status_filter(self, tools):
        """Filtering tasks by status works correctly."""
        result = tools["create_project"](name="Filter Test", description="test", project_type="general")
        pid = _extract_project_id(result)

        t1_result = tools["create_task"](project_id=pid, title="Todo Task",
                                         description="stays todo", assigned_to="qa-lead")
        t1 = _extract_task_id(t1_result)

        t2_result = tools["create_task"](project_id=pid, title="Active Task",
                                         description="will be in_progress", assigned_to="lead-backend")
        t2 = _extract_task_id(t2_result)

        tools["update_task_status"](project_id=pid, task_id=t2, status="in_progress")

        todo_board = tools["get_task_board"](project_id=pid, filter_status="todo")
        assert t1 in todo_board
        assert t2 not in todo_board

        active_board = tools["get_task_board"](project_id=pid, filter_status="in_progress")
        assert t2 in active_board
        assert t1 not in active_board


# ---------------------------------------------------------------------------
# Memory & Decision Flow Tests
# ---------------------------------------------------------------------------

class TestMemoryAndDecisions:
    """Test the shared memory and decision logging subsystem."""

    def test_write_and_read_memory(self, tools):
        tools["write_memory"](key="preferred_stack", value="FastAPI + React")
        result = tools["read_memory"](key="preferred_stack")
        assert "FastAPI + React" in result

    def test_read_all_memory(self, tools):
        tools["write_memory"](key="stack", value="Python")
        tools["write_memory"](key="db", value="PostgreSQL")
        result = tools["read_memory"]()
        assert "stack" in result
        assert "db" in result

    def test_read_missing_key(self, tools):
        result = tools["read_memory"](key="nonexistent")
        assert "not found" in result.lower()

    def test_log_and_retrieve_decisions(self, tools):
        result = tools["create_project"](name="Decision Test", description="test", project_type="general")
        pid = _extract_project_id(result)

        tools["log_decision"](
            project_id=pid,
            title="Use PostgreSQL",
            decision="PostgreSQL for primary DB",
            rationale="Strong JSON support, mature ecosystem",
            decided_by="cto",
            alternatives="MySQL, MongoDB",
        )

        decisions = tools["get_decisions"](project_id=pid)
        assert "PostgreSQL" in decisions
        assert "cto" in decisions
        assert "MySQL" in decisions

    def test_multiple_decisions(self, tools):
        result = tools["create_project"](name="Multi Decision", description="test", project_type="general")
        pid = _extract_project_id(result)

        tools["log_decision"](project_id=pid, title="Framework",
                              decision="FastAPI", rationale="async", decided_by="cto")
        tools["log_decision"](project_id=pid, title="ORM",
                              decision="SQLAlchemy", rationale="mature", decided_by="lead-backend")

        decisions = tools["get_decisions"](project_id=pid)
        parsed = yaml.safe_load(decisions)
        assert len(parsed["decisions"]) == 2

    def test_decision_for_invalid_project(self, tools):
        result = tools["log_decision"](
            project_id="nonexistent1",
            title="test", decision="test", rationale="test", decided_by="cto",
        )
        assert "Error" in result or "not found" in result.lower()


# ---------------------------------------------------------------------------
# Company Operations Tests
# ---------------------------------------------------------------------------

class TestCompanyOperations:
    """Test the org chart, hiring, and roster subsystem."""

    def test_org_chart_structure(self, tools):
        chart = tools["get_org_chart"]()
        assert "board_head" in chart.lower() or "Board Head" in chart
        assert "ceo" in chart.lower()
        assert "leadership" in chart.lower()

    def test_roster_has_core_and_on_demand(self, tools):
        roster = tools["get_roster"]()
        assert "core_team" in roster
        assert "on_demand" in roster

    def test_hire_and_fire_agent(self, tools):
        result = tools["hire_agent"](
            name="ml-engineer",
            role="Machine Learning Engineer",
            expertise="Model training and deployment",
            tools="Read,Write,Bash",
            model="sonnet",
        )
        assert "hired" in result.lower()

        # Should appear in roster
        roster = tools["get_roster"]()
        assert "ml-engineer" in roster

        # Should appear in org chart
        chart = tools["get_org_chart"]()
        assert "ml-engineer" in chart

        # Fire the agent
        result = tools["fire_agent"](name="ml-engineer")
        assert "deactivated" in result.lower()

    def test_cannot_fire_core_agent(self, tools):
        result = tools["fire_agent"](name="cto")
        assert "Error" in result or "cannot" in result.lower()

    def test_cannot_hire_duplicate_name(self, tools):
        tools["hire_agent"](name="test-agent", role="Test", expertise="testing")
        result = tools["hire_agent"](name="test-agent", role="Test", expertise="testing")
        assert "already hired" in result.lower()

    def test_cannot_hire_core_name(self, tools):
        result = tools["hire_agent"](name="cto", role="Fake CTO", expertise="nothing")
        assert "Error" in result or "conflicts" in result.lower()

    def test_hire_agent_invalid_name(self, tools):
        result = tools["hire_agent"](name="Invalid Name!", role="Test", expertise="test")
        assert "Error" in result

    def test_hire_agent_invalid_tools(self, tools):
        result = tools["hire_agent"](name="bad-tools", role="Test",
                                     expertise="test", tools="Read,FakeTool")
        assert "Error" in result or "invalid" in result.lower()


# ---------------------------------------------------------------------------
# Metrics & Token Tracking Tests
# ---------------------------------------------------------------------------

class TestMetricsFlow:
    """Test token usage logging, reporting, and cost estimation."""

    def test_log_and_report_tokens(self, tools):
        tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="Implement API endpoints",
            estimated_input_tokens=5000, estimated_output_tokens=2000,
            project_id="proj1",
        )
        tools["log_token_usage"](
            agent_name="qa-lead", model="sonnet",
            task_description="Write tests",
            estimated_input_tokens=3000, estimated_output_tokens=1000,
            project_id="proj1",
        )

        report = tools["get_token_report"]()
        parsed = yaml.safe_load(report)
        assert parsed["total_records"] == 2
        assert parsed["grand_total_tokens"] == 11000
        assert "lead-backend" in parsed["by_agent"]
        assert "qa-lead" in parsed["by_agent"]

    def test_token_report_filters(self, tools):
        tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="Task A", estimated_input_tokens=1000,
            estimated_output_tokens=500, project_id="p1",
        )
        tools["log_token_usage"](
            agent_name="ceo", model="opus",
            task_description="Task B", estimated_input_tokens=2000,
            estimated_output_tokens=1000, project_id="p2",
        )

        # Filter by project
        report = tools["get_token_report"](project_id="p1")
        parsed = yaml.safe_load(report)
        assert parsed["total_records"] == 1
        assert parsed["grand_total_tokens"] == 1500

        # Filter by agent
        report = tools["get_token_report"](agent_name="ceo")
        parsed = yaml.safe_load(report)
        assert parsed["total_records"] == 1
        assert parsed["grand_total_tokens"] == 3000

    def test_negative_tokens_rejected(self, tools):
        result = tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="bad", estimated_input_tokens=-100,
            estimated_output_tokens=0,
        )
        assert "Error" in result

    def test_estimate_task_cost(self, tools):
        result = tools["estimate_task_cost"](
            task_description="Build REST API",
            model="sonnet", complexity="medium",
        )
        parsed = yaml.safe_load(result)
        assert parsed["model"] == "sonnet"
        assert parsed["complexity"] == "medium"
        assert parsed["estimated_input_tokens"] == 8000
        assert parsed["estimated_output_tokens"] == 4000
        assert parsed["estimated_cost_usd"] > 0

    def test_estimate_cost_different_models(self, tools):
        opus = yaml.safe_load(tools["estimate_task_cost"](
            task_description="Task", model="opus", complexity="medium"))
        haiku = yaml.safe_load(tools["estimate_task_cost"](
            task_description="Task", model="haiku", complexity="medium"))
        assert opus["estimated_cost_usd"] > haiku["estimated_cost_usd"]

    def test_estimate_cost_different_complexities(self, tools):
        low = yaml.safe_load(tools["estimate_task_cost"](
            task_description="Task", model="sonnet", complexity="low"))
        high = yaml.safe_load(tools["estimate_task_cost"](
            task_description="Task", model="sonnet", complexity="high"))
        assert high["estimated_total_tokens"] > low["estimated_total_tokens"]

    def test_empty_token_report(self, tools):
        result = tools["get_token_report"]()
        assert "No token usage records" in result


# ---------------------------------------------------------------------------
# Cross-Scope Integration Tests
# ---------------------------------------------------------------------------

class TestCrossScopeIntegration:
    """Tests that exercise multiple tool scopes working together."""

    def test_complete_project_with_metrics(self, tools):
        """Full flow: create project → tasks → log tokens → report."""
        # Create project
        result = tools["create_project"](name="Metrics Integration",
                                         description="test", project_type="api")
        pid = _extract_project_id(result)

        # Create and complete a task
        t_result = tools["create_task"](project_id=pid, title="Build feature",
                                        description="Build it", assigned_to="lead-backend")
        tid = _extract_task_id(t_result)

        tools["update_task_status"](project_id=pid, task_id=tid, status="in_progress")

        # Log tokens for this task
        tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="Build feature",
            estimated_input_tokens=10000, estimated_output_tokens=5000,
            project_id=pid, task_id=tid,
        )

        tools["update_task_status"](project_id=pid, task_id=tid, status="done")

        # Log a decision
        tools["log_decision"](
            project_id=pid, title="API design",
            decision="REST over GraphQL", rationale="Simpler for v1",
            decided_by="cto",
        )

        # Verify everything
        status = tools["get_project_status"](project_id=pid)
        assert "Metrics Integration" in status

        report = tools["get_token_report"](project_id=pid)
        parsed = yaml.safe_load(report)
        assert parsed["grand_total_tokens"] == 15000

        decisions = tools["get_decisions"](project_id=pid)
        assert "REST over GraphQL" in decisions

    def test_memory_persists_across_tool_calls(self, tools):
        """Memory written by one tool call is readable by another."""
        tools["write_memory"](key="deploy_target", value="aws-ecs")
        tools["write_memory"](key="ci_provider", value="github-actions")

        # Overwrite a key
        tools["write_memory"](key="deploy_target", value="aws-lambda")

        result = tools["read_memory"](key="deploy_target")
        assert "aws-lambda" in result

        result = tools["read_memory"](key="ci_provider")
        assert "github-actions" in result

    def test_multiple_projects_isolated(self, tools):
        """Tasks and decisions in different projects don't leak."""
        r1 = tools["create_project"](name="Project A", description="a", project_type="general")
        p1 = _extract_project_id(r1)

        r2 = tools["create_project"](name="Project B", description="b", project_type="general")
        p2 = _extract_project_id(r2)

        tools["create_task"](project_id=p1, title="Task for A",
                             description="only A", assigned_to="lead-backend")
        tools["create_task"](project_id=p2, title="Task for B",
                             description="only B", assigned_to="lead-frontend")

        board_a = tools["get_task_board"](project_id=p1)
        board_b = tools["get_task_board"](project_id=p2)

        assert "Task for A" in board_a
        assert "Task for B" not in board_a
        assert "Task for B" in board_b
        assert "Task for A" not in board_b

    def test_project_team_and_phases(self, tools):
        """Update project team and phases through the lifecycle."""
        result = tools["create_project"](name="Team Test", description="test", project_type="general")
        pid = _extract_project_id(result)

        # Add team members
        tools["update_project"](project_id=pid, team="lead-backend, qa-lead, devops")

        # Add phases
        tools["update_project"](project_id=pid, phase="planning")
        tools["update_project"](project_id=pid, phase="development")

        status = tools["get_project_status"](project_id=pid)
        assert "lead-backend" in status
        assert "qa-lead" in status
        assert "planning" in status
        assert "development" in status


# ---------------------------------------------------------------------------
# Error Handling Integration Tests
# ---------------------------------------------------------------------------

class TestErrorHandling:
    """Tests for error handling across the MCP tools."""

    def test_nonexistent_project_status(self, tools):
        result = tools["get_project_status"](project_id="nonexistent1")
        assert "Error" in result or "not found" in result.lower()

    def test_update_nonexistent_project(self, tools):
        result = tools["update_project"](project_id="nonexistent1", status="active")
        assert "Error" in result or "not found" in result.lower()

    def test_create_task_in_nonexistent_project(self, tools):
        # This should still create the task (task board creates the file structure)
        # or return an error depending on the implementation
        result = tools["create_task"](project_id="nonexist1",
                                      title="Orphan", description="test",
                                      assigned_to="lead-backend")
        # Either creates it or errors — just ensure no crash
        assert isinstance(result, str)

    def test_update_nonexistent_task(self, tools):
        result = tools["create_project"](name="Error Test", description="test", project_type="general")
        pid = _extract_project_id(result)
        r = tools["update_task_status"](project_id=pid, task_id="TASK-XXXXXX", status="done")
        assert "Error" in r or "not found" in r.lower()

    def test_invalid_status_transition(self, tools):
        """Cannot go from todo directly to done (must pass through in_progress)."""
        result = tools["create_project"](name="Invalid Trans", description="test", project_type="general")
        pid = _extract_project_id(result)

        t_result = tools["create_task"](project_id=pid, title="Test",
                                        description="test", assigned_to="lead-backend")
        tid = _extract_task_id(t_result)

        r = tools["update_task_status"](project_id=pid, task_id=tid, status="done")
        assert "Error" in r

    def test_no_updates_provided(self, tools):
        result = tools["create_project"](name="No Update", description="test", project_type="general")
        pid = _extract_project_id(result)
        r = tools["update_project"](project_id=pid)
        assert "Error" in r or "No updates" in r


# ---------------------------------------------------------------------------
# Server Creation Integration Test
# ---------------------------------------------------------------------------

class TestServerIntegration:
    """Test that server creation registers all tools correctly."""

    def test_all_scope_server_has_all_tools(self):
        server = create_server("all")
        names = list(server._tool_manager._tools.keys())
        expected = [
            "create_project", "get_project_status", "update_project", "list_projects",
            "create_task", "update_task_status", "get_task_board", "assign_task",
            "read_memory", "write_memory", "log_decision", "get_decisions",
            "get_org_chart", "get_roster", "hire_agent", "fire_agent",
            "log_token_usage", "get_token_report", "get_session_durations", "estimate_task_cost",
            "spawn_micro_agent", "list_micro_agents", "retire_micro_agent",
        ]
        for tool_name in expected:
            assert tool_name in names, f"Missing tool: {tool_name}"

    def test_individual_scopes_are_isolated(self):
        project_server = create_server("project")
        task_server = create_server("tasks")

        project_tools = list(project_server._tool_manager._tools.keys())
        task_tools = list(task_server._tool_manager._tools.keys())

        assert "create_project" in project_tools
        assert "create_project" not in task_tools
        assert "create_task" in task_tools
        assert "create_task" not in project_tools
