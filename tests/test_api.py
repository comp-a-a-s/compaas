"""FastAPI endpoint tests for the COMPaaS web dashboard API."""

import hashlib
import hmac
import json
import os
import time
import yaml
import pytest
from datetime import datetime, timezone
from fastapi.testclient import TestClient

from src.web.api import app
from src.web.problem import problem_http_exception
from src.agents import AGENT_REGISTRY


# ---------------------------------------------------------------------------
# Client fixture — wired to the same temp_data_dir as the state fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def client(temp_data_dir, monkeypatch):
    """Return a TestClient whose underlying state objects use temp_data_dir.

    We monkeypatch the module-level state_manager and task_board inside
    src.web.api so that every request goes through the temporary directory.
    """
    from src.state.project_state import ProjectStateManager
    from src.state.task_board import TaskBoard
    import src.web.api as api_module

    monkeypatch.setattr(api_module, "DATA_DIR", temp_data_dir)
    monkeypatch.setattr(api_module, "state_manager", ProjectStateManager(temp_data_dir))
    monkeypatch.setattr(api_module, "task_board", TaskBoard(temp_data_dir))
    monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
    monkeypatch.setattr(api_module, "MEMORY_PATH", os.path.join(temp_data_dir, "ceo_memory.md"))

    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _create_project(client, name="Test Project", description="A test project", project_type="api"):
    """Create a project via the state manager wired to the test client and
    return its ID.  We cannot POST via the API (read-only API), so we reach
    directly into the state manager through the fixture chain.
    """
    import src.web.api as api_module
    return api_module.state_manager.create_project(name, description, project_type)


# ---------------------------------------------------------------------------
# GET /api/health
# ---------------------------------------------------------------------------

class TestHealthEndpoint:
    def test_returns_200(self, client):
        response = client.get("/api/health")
        assert response.status_code == 200

    def test_response_has_status_healthy(self, client):
        data = client.get("/api/health").json()
        assert data["status"] == "healthy"

    def test_response_has_version(self, client):
        data = client.get("/api/health").json()
        assert "version" in data
        assert data["version"]

    def test_response_has_data_dir_exists_key(self, client):
        data = client.get("/api/health").json()
        assert "data_dir_exists" in data


# ---------------------------------------------------------------------------
# GET /api/org-chart
# ---------------------------------------------------------------------------

class TestOrgChartEndpoint:
    def test_returns_200(self, client):
        response = client.get("/api/org-chart")
        assert response.status_code == 200

    def test_response_has_board_head(self, client):
        data = client.get("/api/org-chart").json()
        assert "board_head" in data
        assert data["board_head"]["name"] == "Idan"

    def test_response_has_ceo(self, client):
        data = client.get("/api/org-chart").json()
        assert "ceo" in data
        assert data["ceo"]["name"] == "Marcus"

    def test_response_has_leadership_section(self, client):
        data = client.get("/api/org-chart").json()
        assert "leadership" in data
        assert isinstance(data["leadership"], dict)

    def test_response_has_engineering_section(self, client):
        data = client.get("/api/org-chart").json()
        assert "engineering" in data
        assert isinstance(data["engineering"], dict)

    def test_response_has_on_demand_section(self, client):
        data = client.get("/api/org-chart").json()
        assert "on_demand" in data
        assert isinstance(data["on_demand"], dict)

    def test_leadership_contains_expected_roles(self, client):
        data = client.get("/api/org-chart").json()
        leadership = data["leadership"]
        assert "cto" in leadership
        assert "vp-product" in leadership
        assert "vp-engineering" in leadership


# ---------------------------------------------------------------------------
# GET /api/projects
# ---------------------------------------------------------------------------

class TestListProjectsEndpoint:
    def test_returns_200(self, client):
        response = client.get("/api/projects")
        assert response.status_code == 200

    def test_returns_list_when_empty(self, client):
        data = client.get("/api/projects").json()
        assert isinstance(data, list)
        assert data == []

    def test_returns_created_project(self, client):
        _create_project(client)
        data = client.get("/api/projects").json()
        assert len(data) == 1
        assert data[0]["name"] == "Test Project"

    def test_each_project_has_required_fields(self, client):
        _create_project(client)
        data = client.get("/api/projects").json()
        project = data[0]
        for field in ("id", "name", "status", "type", "task_counts", "total_tasks"):
            assert field in project, f"Missing field: {field}"

    def test_task_counts_is_dict(self, client):
        _create_project(client)
        data = client.get("/api/projects").json()
        assert isinstance(data[0]["task_counts"], dict)

    def test_total_tasks_is_zero_for_new_project(self, client):
        _create_project(client)
        data = client.get("/api/projects").json()
        assert data[0]["total_tasks"] == 0

    def test_multiple_projects_are_all_returned(self, client):
        _create_project(client, name="Project Alpha")
        _create_project(client, name="Project Beta")
        data = client.get("/api/projects").json()
        names = {p["name"] for p in data}
        assert names == {"Project Alpha", "Project Beta"}

    def test_list_includes_run_instructions(self, client):
        import src.web.api as api_module

        pid = _create_project(client)
        api_module.state_manager.update_project(pid, {"run_instructions": "npm run dev"})

        data = client.get("/api/projects").json()
        project = next((p for p in data if p.get("id") == pid), None)
        assert project is not None
        assert project.get("run_instructions") == "npm run dev"

    def test_backfills_run_instructions_from_activation_guide(self, client, temp_data_dir):
        import src.web.api as api_module

        pid = _create_project(client)
        activation_guide_path = os.path.join(
            temp_data_dir,
            "projects",
            pid,
            "artifacts",
            "02_activation_guide.md",
        )
        with open(activation_guide_path, "w") as f:
            f.write(
                "## Run Commands\n"
                "- npm ci\n"
                "- npm run dev\n"
            )
        api_module.state_manager.update_project(pid, {"run_instructions": ""})

        data = client.get("/api/projects").json()
        project = next((p for p in data if p.get("id") == pid), None)
        assert project is not None
        assert project.get("run_instructions") == "npm ci\nnpm run dev"

        persisted = api_module.state_manager.get_project(pid)
        assert persisted is not None
        assert persisted.get("run_instructions") == "npm ci\nnpm run dev"

    def test_list_includes_high_level_tasks(self, client):
        import src.web.api as api_module

        pid = _create_project(client, name="Lane Project")
        task_id = api_module.task_board.create_task(
            pid,
            "Vinod execution stream",
            "Contribute specialist implementation output. Request focus: Build a modern dashboard shell and auth flow.",
            "vinod",
            "p1",
        )
        api_module.task_board.update_status(pid, task_id, "in_progress")

        data = client.get("/api/projects").json()
        project = next((p for p in data if p.get("id") == pid), None)
        assert project is not None
        lanes = project.get("high_level_tasks")
        assert isinstance(lanes, list)
        assert len(lanes) == 1
        lane = lanes[0]
        assert lane["owner"] == "vinod"
        assert lane["status"] == "in_progress"
        assert "dashboard shell and auth flow" in lane["headline"].lower()


class TestCreateProjectEndpoint:
    def test_creates_project_and_returns_metadata(self, client):
        response = client.post("/api/projects", json={
            "name": "Chat Project",
            "description": "Created from UI",
            "type": "app",
        })
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["project"]["name"] == "Chat Project"
        assert payload["project"]["workspace_path"]

    def test_rejects_missing_name(self, client):
        response = client.post("/api/projects", json={"description": "No name"})
        assert response.status_code == 400

    def test_rejects_github_mode_when_connector_not_verified(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module

        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        with open(api_module.CONFIG_PATH, "w") as f:
            yaml.safe_dump({
                "integrations": {
                    "workspace_mode": "github",
                    "github_token": "ghp_secret",
                    "github_repo": "comp-a-a-s/compaas",
                    "github_verified": False,
                }
            }, f)

        response = client.post("/api/projects", json={
            "name": "GitHub Build",
            "description": "Test github guard",
            "delivery_mode": "github",
            "github_repo": "comp-a-a-s/compaas",
        })
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail["code"] == "github_not_configured"
        assert detail["settings_target"] == "github"


class TestDeleteProjectEndpoint:
    def test_delete_project_success(self, client):
        import src.web.api as api_module

        pid = _create_project(client, name="Delete API Project")
        project = api_module.state_manager.get_project(pid)
        assert project is not None
        workspace_path = project.get("workspace_path", "")
        assert workspace_path
        assert os.path.isdir(workspace_path)

        response = client.delete(f"/api/projects/{pid}")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["project_id"] == pid
        assert payload["project_deleted"] is True
        assert payload["workspace_deleted"] is True

        assert api_module.state_manager.get_project(pid) is None
        assert not os.path.exists(workspace_path)

    def test_delete_project_missing_returns_404(self, client):
        response = client.delete("/api/projects/nonexistent1")
        assert response.status_code == 404

    def test_delete_project_invalid_id_returns_400(self, client):
        response = client.delete("/api/projects/..secret")
        assert response.status_code == 400

    def test_delete_project_post_alias_success(self, client):
        import src.web.api as api_module

        pid = _create_project(client, name="Delete Alias Project")
        project = api_module.state_manager.get_project(pid)
        assert project is not None

        response = client.post(f"/api/projects/{pid}/delete")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["project_id"] == pid
        assert api_module.state_manager.get_project(pid) is None

    def test_delete_project_post_action_success(self, client):
        import src.web.api as api_module

        pid = _create_project(client, name="Delete Action Project")
        response = client.post(f"/api/projects/{pid}", json={"action": "delete"})
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["project_id"] == pid
        assert api_module.state_manager.get_project(pid) is None


class TestPatchProjectEndpoint:
    def test_patch_project_updates_tags(self, client):
        import src.web.api as api_module

        pid = _create_project(client, name="Taggable Project")
        response = client.patch(f"/api/projects/{pid}", json={"tags": ["frontend", "urgent", "frontend"]})
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["updated_fields"] == ["tags"]
        assert payload["project"]["tags"] == ["frontend", "urgent"]

        persisted = api_module.state_manager.get_project(pid)
        assert persisted is not None
        assert persisted.get("tags") == ["frontend", "urgent"]


class TestOpenWorkspaceEndpoint:
    def test_open_workspace_success(self, client, monkeypatch):
        import src.web.api as api_module

        pid = _create_project(client, name="Workspace Open Project")
        launched: list[list[str]] = []

        class _FakeProcess:
            def __init__(self, cmd: list[str]) -> None:
                launched.append(cmd)

        def _fake_popen(cmd, **_kwargs):
            return _FakeProcess(list(cmd))

        monkeypatch.setattr(api_module.subprocess, "Popen", _fake_popen)
        monkeypatch.setattr(api_module.shutil, "which", lambda _name: "/usr/bin/xdg-open")

        response = client.post(f"/api/projects/{pid}/workspace/open")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["opened"] is True
        assert payload["launcher"] in {"open", "explorer", "xdg-open"}
        assert payload["path"]
        assert payload["correlation_id"]
        assert len(launched) == 1

    def test_open_workspace_returns_guided_error_for_unsafe_path(self, client):
        import src.web.api as api_module

        pid = _create_project(client, name="Unsafe Workspace Open")
        outside_root = os.path.abspath(os.path.join(api_module.DATA_DIR, f"outside-open-{pid}"))
        os.makedirs(outside_root, exist_ok=True)
        api_module.state_manager.update_project(pid, {"workspace_path": outside_root})

        response = client.post(f"/api/projects/{pid}/workspace/open")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "error"
        assert payload["opened"] is False
        assert payload["launcher"] == "none"
        assert payload["actions"]
        assert payload["correlation_id"]

    def test_open_workspace_missing_project_returns_404(self, client):
        response = client.post("/api/projects/nonexistent1/workspace/open")
        assert response.status_code == 404


class TestApproveProjectPlanEndpoint:
    def test_approve_releases_active_planning_runs(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        from src.web.services.project_service import ProjectService
        from src.web.services.run_service import RunService
        from src.web.settings import RuntimeSettings

        runtime_settings = RuntimeSettings(data_dir=temp_data_dir, project_root=temp_data_dir)
        run_service = RunService(temp_data_dir, runtime_settings)
        monkeypatch.setattr(api_module, "run_service", run_service)
        monkeypatch.setattr(
            api_module,
            "project_service",
            ProjectService(temp_data_dir, api_module.state_manager, api_module.task_board),
        )

        pid = _create_project(client, name="Approval Gate Project")
        api_module._generate_planning_packet(
            pid,
            user_message="Prepare implementation plan for a task tracker app.",
            user_name="Idan",
            ceo_name="Marcus",
        )

        run, _ = run_service.create_run(
            project_id=pid,
            message="Planning packet requires approval",
            provider="openai",
            sandbox_profile="full",
        )
        run_service.transition_run(
            str(run.get("id", "")),
            state="planning",
            label="Planning approval required before execution",
        )

        response = client.post(f"/api/projects/{pid}/approve")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "approved"
        assert str(run.get("id", "")) in payload.get("released_runs", [])

        updated = run_service.get_run(str(run.get("id", "")))
        assert updated is not None
        assert updated["status"] == "done"


# ---------------------------------------------------------------------------
# GET /api/projects/{project_id}
# ---------------------------------------------------------------------------

class TestGetProjectEndpoint:
    def test_returns_200_for_existing_project(self, client):
        pid = _create_project(client)
        response = client.get(f"/api/projects/{pid}")
        assert response.status_code == 200

    def test_response_contains_project_data(self, client):
        pid = _create_project(client, name="Detailed Project")
        data = client.get(f"/api/projects/{pid}").json()
        assert data["project"]["name"] == "Detailed Project"
        assert data["project"]["id"] == pid

    def test_response_contains_tasks_list(self, client):
        pid = _create_project(client)
        data = client.get(f"/api/projects/{pid}").json()
        assert "tasks" in data
        assert isinstance(data["tasks"], list)

    def test_response_contains_high_level_tasks(self, client):
        import src.web.api as api_module

        pid = _create_project(client)
        api_module.task_board.create_task(
            pid,
            "Kickoff scope and acceptance criteria",
            "Capture goals and acceptance criteria for launch.",
            "ceo",
            "p1",
        )
        data = client.get(f"/api/projects/{pid}").json()
        lanes = data.get("high_level_tasks")
        assert isinstance(lanes, list)
        assert lanes[0]["owner"] == "ceo"
        assert "kickoff scope and acceptance criteria" in lanes[0]["headline"].lower()

    def test_returns_404_for_missing_project(self, client):
        response = client.get("/api/projects/nonexistent1")
        assert response.status_code == 404

    def test_404_error_detail_mentions_project_id(self, client):
        response = client.get("/api/projects/nonexistent1")
        detail = response.json()["detail"]
        assert "nonexistent1" in detail

    def test_returns_400_for_double_dot_id(self, client):
        # "..secret" contains ".." and reaches the handler (no slash involved)
        response = client.get("/api/projects/..secret")
        assert response.status_code == 400

    def test_returns_400_for_embedded_double_dot_id(self, client):
        # "foo..bar" also triggers the validator
        response = client.get("/api/projects/foo..bar")
        assert response.status_code == 400

    def test_returns_400_for_id_with_spaces(self, client):
        response = client.get("/api/projects/bad%20id")
        assert response.status_code == 400


# ---------------------------------------------------------------------------
# GET /api/tasks/{project_id}
# ---------------------------------------------------------------------------

class TestGetTasksEndpoint:
    def test_returns_200_for_existing_project(self, client):
        pid = _create_project(client)
        response = client.get(f"/api/tasks/{pid}")
        assert response.status_code == 200

    def test_returns_empty_list_for_new_project(self, client):
        pid = _create_project(client)
        data = client.get(f"/api/tasks/{pid}").json()
        assert data == []

    def test_returns_404_for_missing_project(self, client):
        response = client.get("/api/tasks/nonexistent1")
        assert response.status_code == 404

    def test_returns_400_for_path_traversal_id(self, client):
        # "..secret" contains ".." and reaches the handler (no slash decoding by router)
        response = client.get("/api/tasks/..secret")
        assert response.status_code == 400

    def test_returns_tasks_after_creation(self, client):
        import src.web.api as api_module
        pid = _create_project(client)
        api_module.task_board.create_task(pid, "My Task", "Do it", "lead-backend")
        data = client.get(f"/api/tasks/{pid}").json()
        assert len(data) == 1
        assert data[0]["title"] == "My Task"

    def test_status_filter_works(self, client):
        import src.web.api as api_module
        pid = _create_project(client)
        tid = api_module.task_board.create_task(pid, "T1", "desc", "lead-backend")
        api_module.task_board.create_task(pid, "T2", "desc", "lead-frontend")
        # Advance T1 to in_progress
        api_module.task_board.update_status(pid, tid, "in_progress")

        data = client.get(f"/api/tasks/{pid}?status=in_progress").json()
        assert len(data) == 1
        assert data[0]["id"] == tid

    def test_assignee_filter_works(self, client):
        import src.web.api as api_module
        pid = _create_project(client)
        api_module.task_board.create_task(pid, "BE Task", "desc", "lead-backend")
        api_module.task_board.create_task(pid, "FE Task", "desc", "lead-frontend")

        data = client.get(f"/api/tasks/{pid}?assignee=lead-backend").json()
        assert len(data) == 1
        assert data[0]["assigned_to"] == "lead-backend"


# ---------------------------------------------------------------------------
# GET /api/agents
# ---------------------------------------------------------------------------

class TestListAgentsEndpoint:
    def test_returns_200(self, client):
        response = client.get("/api/agents")
        assert response.status_code == 200

    def test_returns_list(self, client):
        data = client.get("/api/agents").json()
        assert isinstance(data, list)

    def test_list_is_not_empty(self, client):
        data = client.get("/api/agents").json()
        assert len(data) > 0

    def test_each_agent_has_required_fields(self, client):
        data = client.get("/api/agents").json()
        for agent in data:
            for field in ("id", "name", "role", "model", "status", "team"):
                assert field in agent, f"Agent '{agent.get('id')}' missing field: {field}"

    def test_all_registry_agents_are_present(self, client):
        data = client.get("/api/agents").json()
        returned_ids = {a["id"] for a in data}
        for agent_id in AGENT_REGISTRY:
            assert agent_id in returned_ids, f"Registry agent '{agent_id}' missing from /api/agents"

    def test_model_values_are_valid(self, client):
        from src.validators import VALID_MODELS
        data = client.get("/api/agents").json()
        for agent in data:
            assert agent["model"] in VALID_MODELS, (
                f"Agent '{agent['id']}' has invalid model: {agent['model']}"
            )

    def test_ceo_is_not_duplicated_in_response(self, client):
        data = client.get("/api/agents").json()
        ceo_entries = [a for a in data if a["id"] == "ceo"]
        assert len(ceo_entries) == 1, "CEO should appear exactly once"

    def test_each_agent_has_recent_activity_field(self, client):
        data = client.get("/api/agents").json()
        for agent in data:
            assert "recent_activity" in agent, (
                f"Agent '{agent.get('id')}' missing 'recent_activity' field"
            )
            assert isinstance(agent["recent_activity"], list), (
                f"Agent '{agent.get('id')}' 'recent_activity' must be a list"
            )

    def test_recent_activity_empty_when_no_log(self, client):
        # With no activity.log present, all agents should have an empty list.
        data = client.get("/api/agents").json()
        for agent in data:
            assert agent["recent_activity"] == [], (
                f"Agent '{agent.get('id')}' should have empty recent_activity with no log"
            )

    def test_activity_limit_default_is_five(self, client, temp_data_dir):
        # Write more than 5 activity entries for a known agent and verify default cap.
        import json as _json
        import src.web.api as api_module
        log_path = os.path.join(temp_data_dir, "activity.log")
        now_iso = datetime.now(timezone.utc).isoformat()
        with open(log_path, "w") as f:
            for i in range(10):
                f.write(_json.dumps({
                    "agent": "ceo",
                    "action": f"task_{i}",
                    "timestamp": now_iso,
                }) + "\n")

        data = client.get("/api/agents").json()
        ceo = next(a for a in data if a["id"] == "ceo")
        assert len(ceo["recent_activity"]) <= 5, (
            "Default activity_limit should cap recent_activity at 5 entries"
        )

    def test_activity_limit_parameter_is_respected(self, client, temp_data_dir):
        # Write 20 activity entries and request a custom limit.
        import json as _json
        log_path = os.path.join(temp_data_dir, "activity.log")
        now_iso = datetime.now(timezone.utc).isoformat()
        with open(log_path, "w") as f:
            for i in range(20):
                f.write(_json.dumps({
                    "agent": "ceo",
                    "action": f"task_{i}",
                    "timestamp": now_iso,
                }) + "\n")

        for limit in (0, 1, 3, 10):
            data = client.get(f"/api/agents?activity_limit={limit}").json()
            ceo = next(a for a in data if a["id"] == "ceo")
            assert len(ceo["recent_activity"]) <= limit, (
                f"activity_limit={limit} should cap recent_activity at {limit} entries, "
                f"got {len(ceo['recent_activity'])}"
            )

    def test_activity_limit_zero_returns_empty_lists(self, client, temp_data_dir):
        import json as _json
        log_path = os.path.join(temp_data_dir, "activity.log")
        now_iso = datetime.now(timezone.utc).isoformat()
        with open(log_path, "w") as f:
            f.write(_json.dumps({"agent": "ceo", "action": "work", "timestamp": now_iso}) + "\n")

        data = client.get("/api/agents?activity_limit=0").json()
        for agent in data:
            assert agent["recent_activity"] == [], (
                f"activity_limit=0 should yield empty recent_activity for '{agent.get('id')}'"
            )

    def test_activity_limit_rejects_value_above_50(self, client):
        response = client.get("/api/agents?activity_limit=51")
        assert response.status_code == 422, "activity_limit > 50 should be rejected with 422"

    def test_activity_limit_rejects_negative_value(self, client):
        response = client.get("/api/agents?activity_limit=-1")
        assert response.status_code == 422, "Negative activity_limit should be rejected with 422"


# ---------------------------------------------------------------------------
# GET /api/metrics/tokens
# ---------------------------------------------------------------------------

class TestTokenMetricsEndpoint:
    def test_returns_200(self, client):
        response = client.get("/api/metrics/tokens")
        assert response.status_code == 200

    def test_response_has_required_keys(self, client):
        data = client.get("/api/metrics/tokens").json()
        for key in ("records", "total_records", "grand_total_tokens", "by_agent", "by_model"):
            assert key in data, f"Missing key: {key}"

    def test_returns_zeros_when_no_token_file(self, client):
        data = client.get("/api/metrics/tokens").json()
        assert data["total_records"] == 0
        assert data["grand_total_tokens"] == 0

    def test_by_agent_is_dict(self, client):
        data = client.get("/api/metrics/tokens").json()
        assert isinstance(data["by_agent"], dict)

    def test_by_model_is_dict(self, client):
        data = client.get("/api/metrics/tokens").json()
        assert isinstance(data["by_model"], dict)

    def test_aggregates_token_usage_from_file(self, client, temp_data_dir):
        token_file = os.path.join(temp_data_dir, "token_usage.yaml")
        token_data = {
            "records": [
                {
                    "agent_name": "lead-backend",
                    "model": "sonnet",
                    "estimated_total_tokens": 1000,
                    "project_id": "proj1",
                },
                {
                    "agent_name": "lead-backend",
                    "model": "sonnet",
                    "estimated_total_tokens": 500,
                    "project_id": "proj1",
                },
                {
                    "agent_name": "ceo",
                    "model": "opus",
                    "estimated_total_tokens": 2000,
                    "project_id": "proj2",
                },
            ]
        }
        with open(token_file, "w") as f:
            yaml.dump(token_data, f)

        data = client.get("/api/metrics/tokens").json()
        assert data["total_records"] == 3
        assert data["grand_total_tokens"] == 3500
        assert data["by_agent"]["lead-backend"]["total_tokens"] == 1500
        assert data["by_agent"]["ceo"]["total_tokens"] == 2000
        assert data["by_model"]["sonnet"]["total_tokens"] == 1500
        assert data["by_model"]["opus"]["total_tokens"] == 2000

    def test_project_id_filter_works(self, client, temp_data_dir):
        token_file = os.path.join(temp_data_dir, "token_usage.yaml")
        token_data = {
            "records": [
                {"agent_name": "a", "model": "sonnet", "estimated_total_tokens": 100, "project_id": "p1"},
                {"agent_name": "b", "model": "sonnet", "estimated_total_tokens": 200, "project_id": "p2"},
            ]
        }
        with open(token_file, "w") as f:
            yaml.dump(token_data, f)

        data = client.get("/api/metrics/tokens?project_id=p1").json()
        assert data["total_records"] == 1
        assert data["grand_total_tokens"] == 100


# ---------------------------------------------------------------------------
# GET /api/settings/models
# ---------------------------------------------------------------------------

class TestSettingsModelsEndpoint:
    def test_returns_200(self, client):
        response = client.get("/api/settings/models")
        assert response.status_code == 200

    def test_returns_list(self, client):
        data = client.get("/api/settings/models").json()
        assert isinstance(data, list)

    def test_returns_empty_list_when_no_agents_dir(self, client, monkeypatch):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "PROJECT_ROOT", "/tmp/nonexistent_compaas_root")
        response = client.get("/api/settings/models")
        assert response.status_code == 200
        assert response.json() == []

    def test_each_entry_has_required_fields(self, client):
        data = client.get("/api/settings/models").json()
        for entry in data:
            for field in ("id", "name", "model", "description", "tools"):
                assert field in entry, f"Entry missing field: {field}"

    def test_returns_agents_from_claude_agents_dir(self, client, temp_data_dir, monkeypatch, tmp_path):
        import src.web.api as api_module

        agents_dir = tmp_path / ".claude" / "agents"
        agents_dir.mkdir(parents=True)
        agent_md = agents_dir / "test-agent.md"
        agent_md.write_text(
            "---\nname: Test Agent\nmodel: sonnet\ndescription: A test\ntools: Read,Write\n---\n\nBody text.\n"
        )
        monkeypatch.setattr(api_module, "PROJECT_ROOT", str(tmp_path))

        data = client.get("/api/settings/models").json()
        assert len(data) == 1
        assert data[0]["id"] == "test-agent"
        assert data[0]["name"] == "Test Agent"
        assert data[0]["model"] == "sonnet"


# ---------------------------------------------------------------------------
# Integration endpoint security
# ---------------------------------------------------------------------------

class TestIntegrationSecurity:
    def test_save_integrations_allows_local_client_without_admin_token(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.delenv("COMPAAS_ADMIN_TOKEN", raising=False)

        response = client.patch("/api/integrations", json={"github_token": "ghp_local"})
        assert response.status_code == 200

    def test_save_integrations_blocks_remote_client_without_admin_token(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.setattr(api_module, "_is_loopback_client", lambda _request: False)
        monkeypatch.delenv("COMPAAS_ADMIN_TOKEN", raising=False)

        response = client.patch("/api/integrations", json={"github_token": "ghp_remote"})
        assert response.status_code == 403

    def test_save_integrations_requires_valid_admin_token_when_configured(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.setattr(api_module, "_is_loopback_client", lambda _request: False)
        monkeypatch.setenv("COMPAAS_ADMIN_TOKEN", "test-admin-token")

        unauthorized = client.patch("/api/integrations", json={"github_token": "ghp_remote"})
        assert unauthorized.status_code == 401

        authorized = client.patch(
            "/api/integrations",
            json={"github_token": "ghp_remote"},
            headers={"X-COMPAAS-ADMIN-TOKEN": "test-admin-token"},
        )
        assert authorized.status_code == 200

    def test_update_config_cannot_bypass_integration_auth(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.setattr(api_module, "_is_loopback_client", lambda _request: False)
        monkeypatch.setenv("COMPAAS_ADMIN_TOKEN", "test-admin-token")

        blocked = client.patch("/api/config", json={"integrations": {"github_token": "ghp_bypass"}})
        assert blocked.status_code == 401

        allowed = client.patch(
            "/api/config",
            json={"integrations": {"github_token": "ghp_bypass"}},
            headers={"Authorization": "Bearer test-admin-token"},
        )
        assert allowed.status_code == 200

    def test_update_config_non_sensitive_fields_remain_writable(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.setattr(api_module, "_is_loopback_client", lambda _request: False)
        monkeypatch.setenv("COMPAAS_ADMIN_TOKEN", "test-admin-token")

        response = client.patch("/api/config", json={"ui": {"poll_interval_ms": 10000}})
        assert response.status_code == 200

    def test_github_webhook_rejects_missing_secret(self, client, monkeypatch):
        monkeypatch.delenv("COMPAAS_GITHUB_WEBHOOK_SECRET", raising=False)
        payload = {"repository": {"full_name": "compaas/repo"}, "commits": [{"message": "hello"}]}

        response = client.post("/api/integrations/github/webhook", json=payload)
        assert response.status_code == 503

    def test_github_webhook_requires_valid_signature(self, client, monkeypatch):
        monkeypatch.setenv("COMPAAS_GITHUB_WEBHOOK_SECRET", "github-secret")
        payload = {"repository": {"full_name": "compaas/repo"}, "commits": [{"message": "hello"}]}
        body = json.dumps(payload).encode("utf-8")
        signature = "sha256=" + hmac.new(b"github-secret", body, hashlib.sha256).hexdigest()

        ok = client.post(
            "/api/integrations/github/webhook",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-GitHub-Event": "push",
                "X-Hub-Signature-256": signature,
            },
        )
        assert ok.status_code == 200

        bad = client.post(
            "/api/integrations/github/webhook",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-GitHub-Event": "push",
                "X-Hub-Signature-256": "sha256=bad",
            },
        )
        assert bad.status_code == 401

    def test_slack_events_require_valid_signature_and_timestamp(self, client, monkeypatch):
        monkeypatch.setenv("COMPAAS_SLACK_SIGNING_SECRET", "slack-secret")
        payload = {"type": "url_verification", "challenge": "xyz"}
        body = json.dumps(payload).encode("utf-8")

        ts = str(int(time.time()))
        base = f"v0:{ts}:{body.decode('utf-8')}".encode("utf-8")
        signature = "v0=" + hmac.new(b"slack-secret", base, hashlib.sha256).hexdigest()

        ok = client.post(
            "/api/integrations/slack/events",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Slack-Request-Timestamp": ts,
                "X-Slack-Signature": signature,
            },
        )
        assert ok.status_code == 200
        assert ok.json() == {"challenge": "xyz"}

        old_ts = str(int(time.time()) - 1000)
        old_base = f"v0:{old_ts}:{body.decode('utf-8')}".encode("utf-8")
        old_sig = "v0=" + hmac.new(b"slack-secret", old_base, hashlib.sha256).hexdigest()
        stale = client.post(
            "/api/integrations/slack/events",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Slack-Request-Timestamp": old_ts,
                "X-Slack-Signature": old_sig,
            },
        )
        assert stale.status_code == 401

    def test_get_config_redacts_saved_integration_tokens(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))

        with open(api_module.CONFIG_PATH, "w") as f:
            yaml.safe_dump({
                "setup_complete": True,
                "llm": {
                    "provider": "openai",
                    "api_key": "sk-test-secret",
                },
                "integrations": {
                    "github_token": "ghp_secret",
                    "vercel_token": "vercel_secret",
                    "slack_token": "xoxb_secret",
                    "webhook_url": "https://example.com/hook",
                },
            }, f)

        response = client.get("/api/config")
        assert response.status_code == 200
        data = response.json()
        assert data["llm"]["api_key"] == api_module.REDACTED_SECRET
        assert data["integrations"]["github_token"] == api_module.REDACTED_SECRET
        assert data["integrations"]["vercel_token"] == api_module.REDACTED_SECRET
        assert data["integrations"]["slack_token"] == api_module.REDACTED_SECRET
        assert data["integrations"]["webhook_url"] == "https://example.com/hook"

    def test_v1_feature_flags_blocks_remote_mutation_without_admin_token(self, client, monkeypatch):
        import src.web.api as api_module

        monkeypatch.setattr(api_module, "_is_loopback_client", lambda _request: False)
        monkeypatch.delenv("COMPAAS_ADMIN_TOKEN", raising=False)

        response = client.patch("/api/v1/feature-flags", json={"diff_summary": False})
        assert response.status_code == 403

    def test_v1_feature_flags_allows_remote_mutation_with_admin_token(self, client, monkeypatch):
        import src.web.api as api_module

        monkeypatch.setattr(api_module, "_is_loopback_client", lambda _request: False)
        monkeypatch.setenv("COMPAAS_ADMIN_TOKEN", "test-admin-token")

        blocked = client.patch("/api/v1/feature-flags", json={"diff_summary": False})
        assert blocked.status_code == 401

        allowed = client.patch(
            "/api/v1/feature-flags",
            json={"diff_summary": False},
            headers={"Authorization": "Bearer test-admin-token"},
        )
        assert allowed.status_code == 200
        assert allowed.json()["feature_flags"]["diff_summary"] is False

    def test_v1_github_sync_rejects_repo_path_outside_workspace_root(self, client):
        response = client.post("/api/v1/github/sync", json={"repo_path": "/tmp", "default_branch": "main"})
        assert response.status_code == 400
        assert "workspace root" in str(response.json().get("detail", "")).lower()

    def test_v1_github_sync_rejects_non_repo_path(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module

        sandbox_root = os.path.join(temp_data_dir, "workspace")
        os.makedirs(sandbox_root, exist_ok=True)
        plain_dir = os.path.join(sandbox_root, "plain-folder")
        os.makedirs(plain_dir, exist_ok=True)
        monkeypatch.setattr(api_module.integration_service, "workspace_root", os.path.realpath(sandbox_root))

        response = client.post("/api/v1/github/sync", json={"repo_path": plain_dir, "default_branch": "main"})
        assert response.status_code == 400
        assert "git repository" in str(response.json().get("detail", "")).lower()

    def test_llm_test_blocks_private_non_loopback_hosts(self, client, monkeypatch):
        async def fake_probe_connection(**_kwargs):
            return True, "ok"

        monkeypatch.setattr("src.llm_provider.probe_connection", fake_probe_connection)
        response = client.post("/api/llm/test", json={
            "base_url": "http://10.1.2.3:11434/v1",
            "model": "llama3",
            "api_key": "local",
        })
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "error"
        assert "blocked" in payload["message"].lower()

    def test_llm_test_allows_loopback_hosts(self, client, monkeypatch):
        called = {"count": 0}

        async def fake_probe_connection(**_kwargs):
            called["count"] += 1
            return True, "ok"

        monkeypatch.setattr("src.llm_provider.probe_connection", fake_probe_connection)
        response = client.post("/api/llm/test", json={
            "base_url": "http://127.0.0.1:11434/v1",
            "model": "llama3",
            "api_key": "local",
        })
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert called["count"] == 1

    def test_llm_test_allowlist_overrides_private_host_block(self, client, monkeypatch):
        called = {"count": 0}

        async def fake_probe_connection(**_kwargs):
            called["count"] += 1
            return True, "ok"

        monkeypatch.setenv("COMPAAS_LLM_TEST_ALLOWLIST", "10.1.2.3")
        monkeypatch.setattr("src.llm_provider.probe_connection", fake_probe_connection)
        response = client.post("/api/llm/test", json={
            "base_url": "http://10.1.2.3:11434/v1",
            "model": "llama3",
            "api_key": "local",
        })
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert called["count"] == 1

    def test_setup_config_requires_auth_after_setup_complete(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module

        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        with open(api_module.CONFIG_PATH, "w") as f:
            yaml.safe_dump({"setup_complete": True, "user": {"name": "Existing"}}, f)

        monkeypatch.setattr(api_module, "_is_loopback_client", lambda _request: False)
        monkeypatch.setenv("COMPAAS_ADMIN_TOKEN", "test-admin-token")

        blocked = client.post("/api/config/setup", json={"user": {"name": "Blocked"}})
        assert blocked.status_code == 401

        allowed = client.post(
            "/api/config/setup",
            json={"user": {"name": "Allowed"}},
            headers={"X-COMPAAS-ADMIN-TOKEN": "test-admin-token"},
        )
        assert allowed.status_code == 200

    def test_save_integrations_ignores_redacted_placeholder(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.delenv("COMPAAS_ADMIN_TOKEN", raising=False)

        with open(api_module.CONFIG_PATH, "w") as f:
            yaml.safe_dump({"integrations": {"github_token": "ghp_secret"}}, f)

        response = client.patch("/api/integrations", json={
            "github_token": api_module.REDACTED_SECRET,
            "webhook_url": "https://example.com/updated",
        })
        assert response.status_code == 200

        with open(api_module.CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        assert cfg["integrations"]["github_token"] == "ghp_secret"
        assert cfg["integrations"]["webhook_url"] == "https://example.com/updated"

    def test_update_config_ignores_redacted_placeholder(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.delenv("COMPAAS_ADMIN_TOKEN", raising=False)

        with open(api_module.CONFIG_PATH, "w") as f:
            yaml.safe_dump({"integrations": {"slack_token": "xoxb_secret"}}, f)

        response = client.patch("/api/config", json={
            "integrations": {
                "slack_token": api_module.REDACTED_SECRET,
                "webhook_url": "https://example.com/config",
            },
        })
        assert response.status_code == 200

        with open(api_module.CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        assert cfg["integrations"]["slack_token"] == "xoxb_secret"
        assert cfg["integrations"]["webhook_url"] == "https://example.com/config"

    def test_save_integrations_persists_workspace_and_vercel_fields(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.delenv("COMPAAS_ADMIN_TOKEN", raising=False)

        response = client.patch("/api/integrations", json={
            "workspace_mode": "github",
            "github_repo": "comp-a-a-s/compaas",
            "github_default_branch": "master",
            "github_auto_push": True,
            "github_auto_pr": True,
            "vercel_team_id": "team_123",
            "vercel_project_name": "compaas-dashboard",
        })
        assert response.status_code == 200

        with open(api_module.CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        integrations = cfg.get("integrations", {})
        assert integrations["workspace_mode"] == "github"
        assert integrations["github_repo"] == "comp-a-a-s/compaas"
        assert integrations["github_auto_push"] is True
        assert integrations["github_auto_pr"] is True
        assert integrations["vercel_team_id"] == "team_123"
        assert integrations["vercel_project_name"] == "compaas-dashboard"

    def test_get_integration_capabilities_reflects_configuration(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        with open(api_module.CONFIG_PATH, "w") as f:
            yaml.safe_dump({
                "integrations": {
                    "workspace_mode": "github",
                    "github_token": "ghp_secret",
                    "github_repo": "comp-a-a-s/compaas",
                    "github_default_branch": "master",
                    "github_auto_push": True,
                    "github_auto_pr": False,
                    "github_verified": True,
                    "github_verified_at": "2026-02-23T10:00:00Z",
                    "vercel_token": "vercel_secret",
                    "vercel_project_name": "compaas-dashboard",
                    "vercel_verified": True,
                    "vercel_verified_at": "2026-02-23T10:01:00Z",
                    "vercel_default_target": "production",
                }
            }, f)

        response = client.get("/api/integrations/capabilities")
        assert response.status_code == 200
        data = response.json()

        assert data["workspace_mode"] == "github"
        assert data["github"]["configured"] is True
        assert data["github"]["verified"] is True
        assert data["github"]["verified_at"] == "2026-02-23T10:00:00Z"
        assert data["github"]["repo"] == "comp-a-a-s/compaas"
        assert "push_branch" in data["github"]["capabilities"]
        assert data["vercel"]["configured"] is True
        assert data["vercel"]["verified"] is True
        assert data["vercel"]["verified_at"] == "2026-02-23T10:01:00Z"
        assert data["vercel"]["default_target"] == "production"
        assert "deploy_preview" in data["vercel"]["capabilities"]

    def test_v1_github_verify_persists_verified_state(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module

        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.setattr(
            api_module.integration_service,
            "github_verify_connection",
            lambda token, repo="": {
                "status": "ok",
                "ok": True,
                "repo_ok": True,
                "account": {"login": "test-user"},
                "message": f"Verified {repo}",
            },
        )

        response = client.post("/api/v1/github/verify", json={
            "token": "ghp_abc",
            "repo": "comp-a-a-s/compaas",
        })
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is True
        assert payload["repo_ok"] is True
        assert payload["account"]["login"] == "test-user"

        with open(api_module.CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        integrations = cfg.get("integrations", {})
        assert integrations["github_token"] == "ghp_abc"
        assert integrations["github_repo"] == "comp-a-a-s/compaas"
        assert integrations["github_verified"] is True
        assert integrations.get("github_verified_at")
        assert integrations.get("github_last_error", "") == ""

    def test_v1_vercel_verify_persists_verified_state(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module

        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        monkeypatch.setattr(
            api_module.integration_service,
            "vercel_verify_connection",
            lambda token, project_name="", team_id="": {
                "status": "ok",
                "ok": True,
                "project_ok": True,
                "account": {"username": "test-user"},
                "message": f"Verified {project_name}",
            },
        )

        response = client.post("/api/v1/vercel/verify", json={
            "token": "vercel_abc",
            "project_name": "compaas-dashboard",
            "team_id": "team_123",
        })
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is True
        assert payload["project_ok"] is True
        assert payload["account"]["username"] == "test-user"

        with open(api_module.CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        integrations = cfg.get("integrations", {})
        assert integrations["vercel_token"] == "vercel_abc"
        assert integrations["vercel_project_name"] == "compaas-dashboard"
        assert integrations["vercel_team_id"] == "team_123"
        assert integrations["vercel_verified"] is True
        assert integrations.get("vercel_verified_at")
        assert integrations.get("vercel_last_error", "") == ""

    def test_v1_project_vercel_deploy_uses_saved_integration(self, client, monkeypatch, temp_data_dir):
        import src.web.api as api_module
        import src.web.routers.v1 as v1_module

        monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
        with open(api_module.CONFIG_PATH, "w") as f:
            yaml.safe_dump({
                "integrations": {
                    "vercel_token": "vercel_abc",
                    "vercel_project_name": "compaas-dashboard",
                    "vercel_verified": True,
                    "vercel_default_target": "preview",
                }
            }, f)

        project_id = "project_demo_123"
        monkeypatch.setattr(
            api_module.project_service.state_manager,
            "get_project",
            lambda pid: {"id": project_id, "name": "Demo App"} if pid == project_id else None,
        )
        monkeypatch.setattr(api_module.project_service, "get_metadata", lambda _pid: {"deployments": []})
        updated_metadata: dict[str, dict] = {}
        monkeypatch.setattr(
            api_module.project_service,
            "update_metadata",
            lambda pid, updates: updated_metadata.setdefault(pid, updates),
        )
        monkeypatch.setattr(v1_module, "emit_activity", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(
            api_module.integration_service,
            "vercel_deploy_saved",
            lambda _integrations, target="preview": {
                "status": "ok",
                "target": target,
                "deployment_url": "https://demo-app-preview.vercel.app",
                "deployment": {"id": "dep_1"},
            },
        )

        response = client.post(f"/api/v1/projects/{project_id}/deploy/vercel", json={"target": "preview"})
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is True
        assert payload["target"] == "preview"
        assert payload["deployment_url"] == "https://demo-app-preview.vercel.app"
        assert project_id in updated_metadata
        assert isinstance(updated_metadata[project_id].get("deployments"), list)


class TestV1RunProgressEndpoints:
    def test_v1_list_runs_supports_status_and_cursor(self, client, monkeypatch):
        import src.web.api as api_module

        monkeypatch.setattr(
            api_module.run_service,
            "list_runs_page",
            lambda project_id="", status="", offset=0, limit=100: (
                [
                    {"id": "run-a", "project_id": "p1", "status": "executing", "updated_at": "2026-03-01T10:00:00+00:00"},
                ],
                2,
            ),
        )

        response = client.get("/api/v1/runs?project_id=p1&status=executing&limit=1&cursor=0")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert len(payload["runs"]) == 1
        assert payload["runs"][0]["id"] == "run-a"
        assert payload.get("next_cursor") == "1"
        assert payload.get("total_estimate") == 2

    def test_v1_recent_activity_cursor(self, client, tmp_path, monkeypatch):
        import src.web.routers.v1 as v1_module

        activity_path = tmp_path / "activity.log"
        rows = [
            {"timestamp": "2026-03-01T10:00:00Z", "agent": "ceo", "action": "STARTED", "detail": "Run started"},
            {"timestamp": "2026-03-01T10:01:00Z", "agent": "ceo", "action": "UPDATED", "detail": "Working"},
            {"timestamp": "2026-03-01T10:02:00Z", "agent": "ceo", "action": "COMPLETED", "detail": "Done"},
        ]
        activity_path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
        real_join = v1_module.os.path.join
        monkeypatch.setattr(
            v1_module.os.path,
            "join",
            lambda *parts: str(activity_path) if parts and parts[-1] == "activity.log" else real_join(*parts),
        )

        response = client.get("/api/v1/activity/recent?limit=2")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["total_estimate"] == 3
        assert len(payload["events"]) == 2
        assert payload["next_cursor"] == "2"

    def test_v1_run_live_returns_status_guardrails_workforce_and_incident(self, client, monkeypatch):
        import src.web.api as api_module

        run_row = {
            "id": "run-live-1",
            "project_id": "project_live",
            "status": "executing",
            "created_at": "2026-03-01T10:00:00+00:00",
            "updated_at": "2026-03-01T10:00:01+00:00",
            "timeline": [{"label": "Executing implementation"}],
        }
        monkeypatch.setattr(api_module.run_service, "get_run", lambda run_id: run_row if run_id == "run-live-1" else None)
        monkeypatch.setattr(
            api_module.run_service,
            "guardrail_status",
            lambda run_id: {
                "command_budget_remaining": 8,
                "file_budget_remaining": 14,
                "runtime_budget_remaining": 420,
                "elapsed_seconds": 220,
                "over_budget": False,
            } if run_id == "run-live-1" else None,
        )
        monkeypatch.setattr(
            api_module.workforce_presence_service,
            "snapshot",
            lambda project_id=None, include_assigned=True, include_reporting=True: {
                "status": "ok",
                "as_of": datetime.now(timezone.utc).isoformat(),
                "project_id": project_id,
                "counts": {"assigned": 0, "working": 1, "reporting": 0, "blocked": 0},
                "workers": [
                    {
                        "run_id": "run-live-1",
                        "agent_id": "lead-frontend",
                        "agent_name": "Lead Frontend",
                        "state": "working",
                        "task": "Rendering dashboard cards",
                    }
                ],
            },
        )

        response = client.get("/api/v1/runs/run-live-1/live")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["run"]["id"] == "run-live-1"
        assert payload["run_status"]["run_id"] == "run-live-1"
        assert payload["run_status"]["guardrails"]["command_budget_remaining"] == 8
        assert isinstance(payload["workforce"]["workers"], list)
        assert payload["incident"] is None or payload["incident"]["reason"] in {
            "silent_run",
            "provider_stall",
            "guardrail_risk",
        }

    def test_v1_run_control_status_and_cancel(self, client, monkeypatch):
        import src.web.api as api_module

        run_row = {
            "id": "run-control-1",
            "project_id": "project_ctrl",
            "status": "executing",
            "created_at": "2026-03-01T10:00:00+00:00",
            "updated_at": "2026-03-01T10:00:03+00:00",
            "timeline": [{"label": "Executing tasks"}],
        }
        monkeypatch.setattr(api_module.run_service, "get_run", lambda _run_id: run_row)
        monkeypatch.setattr(
            api_module.run_service,
            "guardrail_status",
            lambda _run_id: {
                "command_budget_remaining": 8,
                "file_budget_remaining": 14,
                "runtime_budget_remaining": 420,
                "elapsed_seconds": 25,
                "over_budget": False,
            },
        )
        monkeypatch.setattr(
            api_module.workforce_presence_service,
            "snapshot",
            lambda project_id=None, include_assigned=True, include_reporting=True: {
                "status": "ok",
                "as_of": datetime.now(timezone.utc).isoformat(),
                "project_id": project_id,
                "counts": {"assigned": 0, "working": 0, "reporting": 0, "blocked": 0},
                "workers": [],
            },
        )
        monkeypatch.setattr(
            api_module.run_service,
            "cancel_run",
            lambda run_id, reason="Cancelled by user control": {
                **run_row,
                "id": run_id,
                "status": "cancelled",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        monkeypatch.setattr(
            api_module.workforce_presence_service,
            "mark_run_terminal",
            lambda run_id, project_id="", terminal_state="": None,
        )

        status_response = client.post("/api/v1/runs/run-control-1/control", json={"action": "status"})
        assert status_response.status_code == 200
        status_payload = status_response.json()
        assert status_payload["status"] == "ok"
        assert status_payload["run_control_ack"]["acknowledged"] is True
        assert status_payload["run_control_ack"]["action"] == "status"

        cancel_response = client.post("/api/v1/runs/run-control-1/control", json={"action": "cancel"})
        assert cancel_response.status_code == 200
        cancel_payload = cancel_response.json()
        assert cancel_payload["status"] == "ok"
        assert cancel_payload["run"]["status"] == "cancelled"
        assert cancel_payload["run_control_ack"]["action"] == "cancel"


class TestV1IntegrationAndReleaseNotes:
    def test_v1_pr_quality_profile_roundtrip(self, client):
        get_default = client.get("/api/v1/github/pr-quality-profile")
        assert get_default.status_code == 200
        assert get_default.json()["status"] == "ok"

        update_response = client.patch("/api/v1/github/pr-quality-profile", json={"profile": "strict"})
        assert update_response.status_code == 200
        assert update_response.json()["profile"] == "strict"

        get_updated = client.get("/api/v1/github/pr-quality-profile")
        assert get_updated.status_code == 200
        assert get_updated.json()["profile"] == "strict"

    def test_v1_quality_profile_roundtrip(self, client):
        get_default = client.get("/api/v1/quality/profile")
        assert get_default.status_code == 200
        payload = get_default.json()
        assert payload["status"] == "ok"
        assert payload["profile"]["mode"]
        assert isinstance(payload["profile"]["code_quality_min"], int)

        update_response = client.patch(
            "/api/v1/quality/profile",
            json={
                "mode": "aaa_quality_visual",
                "auto_refinement_enabled": True,
                "auto_refinement_max_passes": 1,
                "validation_required_for_done": True,
                "visual_distinctiveness_min": 72,
                "ux_quality_min": 76,
                "code_quality_min": 82,
            },
        )
        assert update_response.status_code == 200
        updated = update_response.json()["profile"]
        assert updated["visual_distinctiveness_min"] == 72
        assert updated["code_quality_min"] == 82

    def test_v1_project_quality_latest_returns_project_snapshot(self, client):
        import src.web.api as api_module

        project_id = _create_project(client, name="Quality Snapshot Project")
        now = datetime.now(timezone.utc).isoformat()
        api_module.state_manager.update_project(project_id, {
            "quality_latest": {
                "quality_report": {
                    "code_quality": 80,
                    "ux_quality": 79,
                    "visual_distinctiveness": 77,
                    "validation_passed": True,
                    "failed_gates": [],
                },
                "delivery_gates": {
                    "required": ["run_commands", "open_targets"],
                    "passed": ["run_commands", "open_targets"],
                    "blocked": [],
                },
                "refinement": {"attempted": False, "pass_index": 0, "max_passes": 1},
                "updated_at": now,
            },
            "quality_updated_at": now,
        })

        response = client.get(f"/api/v1/projects/{project_id}/quality/latest")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["project_id"] == project_id
        assert payload["quality_latest"]["quality_report"]["code_quality"] == 80
        assert payload["failed_gates"] == []

    def test_v1_project_release_notes(self, client, monkeypatch):
        import src.web.api as api_module

        monkeypatch.setattr(
            api_module.project_service.state_manager,
            "get_project",
            lambda project_id: {
                "id": project_id,
                "name": "CashTracker",
                "description": "Build complete and validated.",
                "run_instructions": "npm install\nnpm run dev",
            },
        )
        monkeypatch.setattr(
            api_module.run_service,
            "list_runs",
            lambda project_id="", limit=100: [{
                "id": "run-1",
                "project_id": project_id,
                "status": "done",
                "timeline": [
                    {"label": "Planning approved"},
                    {"label": "Implementation completed"},
                    {"label": "Validation passed"},
                ],
            }],
        )
        monkeypatch.setattr(
            api_module.project_service,
            "get_metadata",
            lambda _project_id: {
                "artifacts": [
                    {"file_path": "artifacts/01_plan.md"},
                    {"file_path": "artifacts/02_activation_guide.md"},
                ]
            },
        )

        response = client.get("/api/v1/projects/p-cash/release-notes")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["project_id"] == "p-cash"
        assert "Release Notes" in payload["notes"]
        assert "npm run dev" in payload["notes"]


class TestReliabilityErrorContracts:
    def test_http_error_includes_correlation_metadata(self, client):
        response = client.post("/api/projects", json={"name": "", "description": "invalid"})
        assert response.status_code == 400
        payload = response.json()
        assert isinstance(payload.get("detail"), str)
        assert payload.get("correlation_id")
        assert response.headers.get("x-correlation-id")

    def test_validation_error_includes_actions(self, client):
        # Missing required RunCreateRequest payload fields -> FastAPI validation handler.
        response = client.post("/api/v1/runs", json={})
        assert response.status_code == 422
        payload = response.json()
        assert payload["code"] == "request_validation_failed"
        assert payload["action_required"] is True
        assert isinstance(payload.get("actions"), list)
        assert payload["actions"][0]["kind"] == "retry"
        assert payload.get("correlation_id")

    def test_problem_payload_preserves_actions_and_code(self, client, monkeypatch):
        import src.web.api as api_module

        def _raise_problem(*_args, **_kwargs):
            raise problem_http_exception(
                status=409,
                title="Conflict",
                detail="GitHub integration not configured.",
                extra={
                    "code": "github_not_configured",
                    "action_required": True,
                    "actions": [
                        {"id": "open-settings", "label": "Open Settings", "kind": "open_settings"},
                    ],
                },
            )

        monkeypatch.setattr(api_module.integration_service, "create_github_repo", _raise_problem)

        response = client.post(
            "/api/v1/github/repo/create",
            json={"token": "ghp_test_token_123", "name": "demo-repo", "private": True},
        )
        assert response.status_code == 409
        payload = response.json()
        assert isinstance(payload.get("detail"), dict)
        assert payload["detail"]["code"] == "github_not_configured"
        assert payload["detail"]["actions"][0]["kind"] == "open_settings"
        assert payload.get("correlation_id")

    def test_v1_system_readiness_shape(self, client):
        response = client.get("/api/v1/system/readiness")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] in {"ok", "degraded"}
        assert "provider" in payload
        assert "tools" in payload
        assert "workspace" in payload
        assert "integrations" in payload
