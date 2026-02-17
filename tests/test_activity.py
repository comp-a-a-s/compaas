"""Tests for real-time activity tracking via emit_activity.

Verifies that MCP tool calls emit structured JSON events to activity.log,
which feeds the SSE /api/activity/stream endpoint and TUI ActivityPanel.
"""

import json
import os
import pytest

from src.utils import emit_activity


@pytest.fixture
def activity_log(temp_data_dir):
    """Return the path to the activity.log file for the temp data dir."""
    return os.path.join(temp_data_dir, "activity.log")


def _read_events(log_path: str) -> list[dict]:
    """Read all JSON events from the activity log."""
    if not os.path.exists(log_path):
        return []
    events = []
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


class TestEmitActivity:
    """Tests for the emit_activity utility function."""

    def test_creates_activity_log(self, temp_data_dir, activity_log):
        emit_activity(temp_data_dir, "lead-backend", "STARTED", "Working on API")
        assert os.path.exists(activity_log)

    def test_event_has_required_fields(self, temp_data_dir, activity_log):
        emit_activity(temp_data_dir, "qa-lead", "COMPLETED", "Tests pass")
        events = _read_events(activity_log)
        assert len(events) == 1
        event = events[0]
        assert event["agent"] == "qa-lead"
        assert event["action"] == "COMPLETED"
        assert event["detail"] == "Tests pass"
        assert "timestamp" in event

    def test_multiple_events_appended(self, temp_data_dir, activity_log):
        emit_activity(temp_data_dir, "a", "STARTED", "first")
        emit_activity(temp_data_dir, "b", "COMPLETED", "second")
        emit_activity(temp_data_dir, "c", "BLOCKED", "third")
        events = _read_events(activity_log)
        assert len(events) == 3
        assert [e["agent"] for e in events] == ["a", "b", "c"]

    def test_empty_detail_is_ok(self, temp_data_dir, activity_log):
        emit_activity(temp_data_dir, "system", "UPDATED")
        events = _read_events(activity_log)
        assert events[0]["detail"] == ""

    def test_events_are_valid_json(self, temp_data_dir, activity_log):
        emit_activity(temp_data_dir, "test", "EVENT", "detail with 'quotes' and \"doubles\"")
        with open(activity_log) as f:
            line = f.readline().strip()
        # Should not raise
        parsed = json.loads(line)
        assert parsed["agent"] == "test"


class TestToolActivityIntegration:
    """Verify that MCP tool calls actually emit activity events."""

    @pytest.fixture
    def tools(self, temp_data_dir):
        from fastmcp import FastMCP
        from src.mcp_server.project_tools import register_project_tools
        from src.mcp_server.task_board_tools import register_task_tools
        from src.mcp_server.memory_tools import register_memory_tools
        from src.mcp_server.company_tools import register_company_tools
        from src.mcp_server.metrics_tools import register_metrics_tools

        mcp = FastMCP("activity-test")
        register_project_tools(mcp, temp_data_dir)
        register_task_tools(mcp, temp_data_dir)
        register_memory_tools(mcp, temp_data_dir)
        register_company_tools(mcp, temp_data_dir)
        register_metrics_tools(mcp, temp_data_dir)

        return {
            name: tool.fn
            for name, tool in mcp._tool_manager._tools.items()
        }

    def test_create_project_emits_event(self, tools, activity_log):
        tools["create_project"](name="Test", description="test", project_type="api")
        events = _read_events(activity_log)
        assert any(e["action"] == "CREATED" and "Test" in e["detail"] for e in events)

    def test_update_project_emits_event(self, tools, activity_log):
        result = tools["create_project"](name="P", description="d", project_type="api")
        pid = result.split("ID: ")[1].split("\n")[0]
        tools["update_project"](project_id=pid, status="active")
        events = _read_events(activity_log)
        assert any(e["action"] == "UPDATED" and "status" in e["detail"] for e in events)

    def test_create_task_emits_assigned(self, tools, activity_log):
        result = tools["create_project"](name="P", description="d", project_type="api")
        pid = result.split("ID: ")[1].split("\n")[0]
        tools["create_task"](project_id=pid, title="Build it",
                             description="desc", assigned_to="lead-backend")
        events = _read_events(activity_log)
        assert any(e["action"] == "ASSIGNED" and e["agent"] == "lead-backend" for e in events)

    def test_task_status_change_emits_event(self, tools, activity_log):
        result = tools["create_project"](name="P", description="d", project_type="api")
        pid = result.split("ID: ")[1].split("\n")[0]
        t_result = tools["create_task"](project_id=pid, title="T",
                                        description="d", assigned_to="qa-lead")
        tid = [w for w in t_result.split() if w.startswith("TASK-")][0]

        tools["update_task_status"](project_id=pid, task_id=tid, status="in_progress")
        events = _read_events(activity_log)
        assert any(e["action"] == "STARTED" for e in events)

        tools["update_task_status"](project_id=pid, task_id=tid, status="done")
        events = _read_events(activity_log)
        assert any(e["action"] == "COMPLETED" for e in events)

    def test_write_memory_emits_event(self, tools, activity_log):
        tools["write_memory"](key="test_key", value="test_value")
        events = _read_events(activity_log)
        assert any(e["action"] == "UPDATED" and "Memory" in e["detail"] for e in events)

    def test_log_decision_emits_event(self, tools, activity_log):
        result = tools["create_project"](name="P", description="d", project_type="api")
        pid = result.split("ID: ")[1].split("\n")[0]
        tools["log_decision"](project_id=pid, title="Use REST",
                              decision="REST", rationale="simple", decided_by="cto")
        events = _read_events(activity_log)
        assert any(e["agent"] == "cto" and "REST" in e["detail"] for e in events)

    def test_hire_agent_emits_event(self, tools, activity_log):
        tools["hire_agent"](name="test-hire", role="Test Agent", expertise="testing")
        events = _read_events(activity_log)
        assert any(e["action"] == "UPDATED" and "Hired" in e["detail"] for e in events)

    def test_token_logging_emits_event(self, tools, activity_log):
        tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="test", estimated_input_tokens=1000,
            estimated_output_tokens=500,
        )
        events = _read_events(activity_log)
        assert any(e["agent"] == "lead-backend" and "tokens" in e["detail"] for e in events)
