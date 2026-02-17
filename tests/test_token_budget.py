"""Tests for token budget enforcement.

Covers: set_token_budget, get_token_budget, budget warnings in
log_token_usage, and the /api/metrics/budgets endpoint.
"""

import os
import yaml
import pytest

from fastmcp import FastMCP
from src.mcp_server.metrics_tools import register_metrics_tools


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def data_dir(tmp_path):
    d = str(tmp_path / "company_data")
    os.makedirs(os.path.join(d, "projects"), exist_ok=True)
    return d


@pytest.fixture
def tools(data_dir):
    mcp = FastMCP("budget-test")
    register_metrics_tools(mcp, data_dir)
    return {
        name: tool.fn
        for name, tool in mcp._tool_manager._tools.items()
    }


# ---------------------------------------------------------------------------
# set_token_budget
# ---------------------------------------------------------------------------

class TestSetTokenBudget:
    def test_set_project_budget(self, tools):
        result = tools["set_token_budget"](token_limit=100000, project_id="proj1")
        assert "100,000" in result
        assert "project=proj1" in result

    def test_set_agent_budget(self, tools):
        result = tools["set_token_budget"](token_limit=50000, agent_name="lead-backend")
        assert "50,000" in result
        assert "agent=lead-backend" in result

    def test_set_combined_budget(self, tools):
        result = tools["set_token_budget"](
            token_limit=25000, project_id="proj1", agent_name="qa-lead")
        assert "25,000" in result
        assert "project=proj1" in result
        assert "agent=qa-lead" in result

    def test_requires_scope(self, tools):
        result = tools["set_token_budget"](token_limit=1000)
        assert "Error" in result

    def test_rejects_negative_limit(self, tools):
        result = tools["set_token_budget"](token_limit=-100, project_id="proj1")
        assert "Error" in result

    def test_update_existing_budget(self, tools):
        tools["set_token_budget"](token_limit=10000, project_id="proj1")
        tools["set_token_budget"](token_limit=20000, project_id="proj1")

        result = tools["get_token_budget"](project_id="proj1")
        parsed = yaml.safe_load(result)
        assert len(parsed) == 1
        assert parsed[0]["limit"] == 20000

    def test_remove_budget_with_zero(self, tools):
        tools["set_token_budget"](token_limit=10000, project_id="proj1")
        result = tools["set_token_budget"](token_limit=0, project_id="proj1")
        assert "removed" in result.lower()

        result = tools["get_token_budget"](project_id="proj1")
        assert "No matching" in result or "No token budgets" in result

    def test_remove_nonexistent_budget(self, tools):
        result = tools["set_token_budget"](token_limit=0, project_id="none1")
        assert "No matching" in result


# ---------------------------------------------------------------------------
# get_token_budget
# ---------------------------------------------------------------------------

class TestGetTokenBudget:
    def test_no_budgets(self, tools):
        result = tools["get_token_budget"]()
        assert "No token budgets" in result

    def test_shows_usage_and_remaining(self, tools):
        tools["set_token_budget"](token_limit=100000, project_id="proj1")
        tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="test", estimated_input_tokens=5000,
            estimated_output_tokens=2000, project_id="proj1",
        )

        result = tools["get_token_budget"](project_id="proj1")
        parsed = yaml.safe_load(result)
        assert len(parsed) == 1
        b = parsed[0]
        assert b["limit"] == 100000
        assert b["used"] == 7000
        assert b["remaining"] == 93000
        assert b["status"] == "OK"

    def test_over_budget_status(self, tools):
        tools["set_token_budget"](token_limit=5000, agent_name="lead-backend")
        tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="big task",
            estimated_input_tokens=4000, estimated_output_tokens=3000,
        )

        result = tools["get_token_budget"](agent_name="lead-backend")
        parsed = yaml.safe_load(result)
        assert parsed[0]["status"] == "OVER BUDGET"
        assert parsed[0]["usage_percent"] > 100

    def test_filter_by_project(self, tools):
        tools["set_token_budget"](token_limit=10000, project_id="p1")
        tools["set_token_budget"](token_limit=20000, project_id="p2")

        result = tools["get_token_budget"](project_id="p1")
        parsed = yaml.safe_load(result)
        assert len(parsed) == 1
        assert parsed[0]["scope"] == "project=p1"

    def test_filter_by_agent(self, tools):
        tools["set_token_budget"](token_limit=10000, agent_name="a")
        tools["set_token_budget"](token_limit=20000, agent_name="b")

        result = tools["get_token_budget"](agent_name="a")
        parsed = yaml.safe_load(result)
        assert len(parsed) == 1

    def test_all_budgets_returned(self, tools):
        tools["set_token_budget"](token_limit=10000, project_id="p1")
        tools["set_token_budget"](token_limit=20000, agent_name="a")
        tools["set_token_budget"](token_limit=30000, project_id="p2", agent_name="b")

        result = tools["get_token_budget"]()
        parsed = yaml.safe_load(result)
        assert len(parsed) == 3


# ---------------------------------------------------------------------------
# Budget warning in log_token_usage
# ---------------------------------------------------------------------------

class TestBudgetWarnings:
    def test_warning_when_over_budget(self, tools):
        tools["set_token_budget"](token_limit=5000, project_id="proj1")
        result = tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="big task",
            estimated_input_tokens=4000, estimated_output_tokens=3000,
            project_id="proj1",
        )
        assert "BUDGET WARNING" in result

    def test_no_warning_within_budget(self, tools):
        tools["set_token_budget"](token_limit=100000, project_id="proj1")
        result = tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="small task",
            estimated_input_tokens=1000, estimated_output_tokens=500,
            project_id="proj1",
        )
        assert "BUDGET WARNING" not in result

    def test_agent_budget_warning(self, tools):
        tools["set_token_budget"](token_limit=1000, agent_name="qa-lead")
        result = tools["log_token_usage"](
            agent_name="qa-lead", model="sonnet",
            task_description="test",
            estimated_input_tokens=800, estimated_output_tokens=500,
        )
        assert "BUDGET WARNING" in result
        assert "agent=qa-lead" in result

    def test_no_warning_without_budget(self, tools):
        result = tools["log_token_usage"](
            agent_name="lead-backend", model="sonnet",
            task_description="no budget",
            estimated_input_tokens=1000000, estimated_output_tokens=500000,
        )
        assert "BUDGET WARNING" not in result


# ---------------------------------------------------------------------------
# API endpoint
# ---------------------------------------------------------------------------

class TestBudgetAPIEndpoint:
    @pytest.fixture
    def client(self, temp_data_dir, monkeypatch):
        from fastapi.testclient import TestClient
        from src.state.project_state import ProjectStateManager
        from src.state.task_board import TaskBoard
        import src.web.api as api_module

        monkeypatch.setattr(api_module, "DATA_DIR", temp_data_dir)
        monkeypatch.setattr(api_module, "state_manager", ProjectStateManager(temp_data_dir))
        monkeypatch.setattr(api_module, "task_board", TaskBoard(temp_data_dir))

        from src.web.api import app
        with TestClient(app) as c:
            yield c

    def test_returns_200(self, client):
        response = client.get("/api/metrics/budgets")
        assert response.status_code == 200

    def test_returns_empty_list_when_no_budgets(self, client):
        data = client.get("/api/metrics/budgets").json()
        assert data == []

    def test_returns_budget_data(self, client, temp_data_dir):
        budgets_file = os.path.join(temp_data_dir, "token_budgets.yaml")
        budgets_data = {
            "budgets": [{
                "project_id": "proj1",
                "agent_name": "",
                "token_limit": 50000,
            }]
        }
        with open(budgets_file, "w") as f:
            yaml.dump(budgets_data, f)

        data = client.get("/api/metrics/budgets").json()
        assert len(data) == 1
        assert data[0]["token_limit"] == 50000
        assert data[0]["status"] == "OK"

    def test_budget_with_usage(self, client, temp_data_dir):
        budgets_file = os.path.join(temp_data_dir, "token_budgets.yaml")
        token_file = os.path.join(temp_data_dir, "token_usage.yaml")

        with open(budgets_file, "w") as f:
            yaml.dump({"budgets": [{"project_id": "p1", "agent_name": "", "token_limit": 10000}]}, f)
        with open(token_file, "w") as f:
            yaml.dump({"records": [
                {"agent_name": "a", "model": "sonnet", "estimated_total_tokens": 8000, "project_id": "p1"},
            ]}, f)

        data = client.get("/api/metrics/budgets").json()
        assert data[0]["used"] == 8000
        assert data[0]["remaining"] == 2000
        assert data[0]["usage_percent"] == 80.0

    def test_over_budget_status(self, client, temp_data_dir):
        budgets_file = os.path.join(temp_data_dir, "token_budgets.yaml")
        token_file = os.path.join(temp_data_dir, "token_usage.yaml")

        with open(budgets_file, "w") as f:
            yaml.dump({"budgets": [{"project_id": "p1", "agent_name": "", "token_limit": 1000}]}, f)
        with open(token_file, "w") as f:
            yaml.dump({"records": [
                {"agent_name": "a", "model": "sonnet", "estimated_total_tokens": 5000, "project_id": "p1"},
            ]}, f)

        data = client.get("/api/metrics/budgets").json()
        assert data[0]["status"] == "OVER BUDGET"

    def test_filter_by_project(self, client, temp_data_dir):
        budgets_file = os.path.join(temp_data_dir, "token_budgets.yaml")
        with open(budgets_file, "w") as f:
            yaml.dump({"budgets": [
                {"project_id": "p1", "agent_name": "", "token_limit": 10000},
                {"project_id": "p2", "agent_name": "", "token_limit": 20000},
            ]}, f)

        data = client.get("/api/metrics/budgets?project_id=p1").json()
        assert len(data) == 1
        assert data[0]["project_id"] == "p1"
