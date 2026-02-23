"""FastAPI endpoint tests for the COMPaaS web dashboard API."""

import hashlib
import hmac
import json
import os
import time
import yaml
import pytest
from fastapi.testclient import TestClient

from src.web.api import app
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
        assert data["integrations"]["github_token"] == api_module.REDACTED_SECRET
        assert data["integrations"]["vercel_token"] == api_module.REDACTED_SECRET
        assert data["integrations"]["slack_token"] == api_module.REDACTED_SECRET
        assert data["integrations"]["webhook_url"] == "https://example.com/hook"

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
                    "vercel_token": "vercel_secret",
                    "vercel_project_name": "compaas-dashboard",
                }
            }, f)

        response = client.get("/api/integrations/capabilities")
        assert response.status_code == 200
        data = response.json()

        assert data["workspace_mode"] == "github"
        assert data["github"]["configured"] is True
        assert data["github"]["repo"] == "comp-a-a-s/compaas"
        assert "push_branch" in data["github"]["capabilities"]
        assert data["vercel"]["configured"] is True
        assert "deploy_preview" in data["vercel"]["capabilities"]
