"""API contract tests for live workforce presence endpoints."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard
from src.web.routers.v1 import V1Context, create_v1_router
from src.web.services.integration_service import IntegrationService
from src.web.services.project_service import ProjectService
from src.web.services.run_service import RunService
from src.web.services.workforce_presence import WorkforcePresenceService
from src.web.settings import RuntimeSettings


@pytest.fixture
def api_client_with_presence(temp_data_dir, monkeypatch):
    import src.web.api as api_module

    state_manager = ProjectStateManager(temp_data_dir)
    task_board = TaskBoard(temp_data_dir)
    runtime_settings = RuntimeSettings(data_dir=temp_data_dir, project_root=temp_data_dir, workspace_root=temp_data_dir)
    run_service = RunService(temp_data_dir, runtime_settings)
    project_service = ProjectService(temp_data_dir, state_manager, task_board)
    integration_service = IntegrationService(temp_data_dir, workspace_root=temp_data_dir)
    workforce_service = WorkforcePresenceService(temp_data_dir, run_service=run_service)

    monkeypatch.setattr(api_module, "DATA_DIR", temp_data_dir)
    monkeypatch.setattr(api_module, "state_manager", state_manager)
    monkeypatch.setattr(api_module, "task_board", task_board)
    monkeypatch.setattr(api_module, "run_service", run_service)
    monkeypatch.setattr(api_module, "project_service", project_service)
    monkeypatch.setattr(api_module, "integration_service", integration_service)
    monkeypatch.setattr(api_module, "workforce_presence_service", workforce_service)
    config_path = Path(temp_data_dir) / "config.yaml"
    memory_path = Path(temp_data_dir) / "ceo_memory.md"
    monkeypatch.setattr(api_module, "CONFIG_PATH", str(config_path))
    monkeypatch.setattr(api_module, "MEMORY_PATH", str(memory_path))
    config_path.write_text(
        """
setup_complete: true
user:
  name: QA User
agents:
  ceo: Marcus
llm:
  provider: openai
  openai_mode: apikey
  anthropic_mode: cli
  model: gpt-4o-mini
feature_flags:
  planning_approval_gate: true
""".strip()
        + "\n",
        encoding="utf-8",
    )

    with TestClient(api_module.app) as client:
        yield client, workforce_service


def _ingest_working_event(workforce_service: WorkforcePresenceService, *, project_id: str, run_id: str, agent_id: str, state: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    workforce_service.ingest_event(
        {
            "timestamp": now,
            "agent": agent_id,
            "action": "STARTED" if state == "working" else "DELEGATED",
            "detail": "Implement feature",
            "project_id": project_id,
            "metadata": {
                "run_id": run_id,
                "work_item_id": f"{run_id}:{agent_id}",
                "work_state": state,
                "source": "real",
                "source_agent": agent_id if state != "assigned" else "ceo",
                "target_agent": agent_id,
                "flow": "internal" if state != "assigned" else "down",
                "task": "Implement feature",
            },
        }
    )


def test_workforce_live_endpoint_contract_and_counts(api_client_with_presence) -> None:
    client, workforce_service = api_client_with_presence
    _ingest_working_event(workforce_service, project_id="proj-a", run_id="run-1", agent_id="lead-frontend", state="working")
    _ingest_working_event(workforce_service, project_id="proj-a", run_id="run-1", agent_id="qa-lead", state="assigned")

    response = client.get("/api/workforce/live", params={"project_id": "proj-a"})
    assert response.status_code == 200

    payload = response.json()
    assert payload["status"] == "ok"
    assert "as_of" in payload
    assert payload["project_id"] == "proj-a"
    assert set(payload["counts"].keys()) == {"assigned", "working", "reporting", "blocked"}
    assert payload["counts"]["working"] == 1
    assert payload["counts"]["assigned"] == 1
    assert isinstance(payload["workers"], list)
    assert payload["workers"]

    worker = payload["workers"][0]
    for key in (
        "agent_id",
        "agent_name",
        "state",
        "project_id",
        "run_id",
        "task",
        "source",
        "started_at",
        "updated_at",
        "elapsed_seconds",
    ):
        assert key in worker


def test_workforce_live_filters_assigned_and_reporting(api_client_with_presence) -> None:
    client, workforce_service = api_client_with_presence
    _ingest_working_event(workforce_service, project_id="proj-a", run_id="run-2", agent_id="lead-backend", state="working")
    _ingest_working_event(workforce_service, project_id="proj-a", run_id="run-2", agent_id="qa-lead", state="assigned")
    _ingest_working_event(workforce_service, project_id="proj-a", run_id="run-2", agent_id="tech-writer", state="reporting")

    no_assigned = client.get(
        "/api/workforce/live",
        params={"project_id": "proj-a", "include_assigned": "false"},
    ).json()
    assert all(worker["state"] != "assigned" for worker in no_assigned["workers"])

    no_reporting = client.get(
        "/api/workforce/live",
        params={"project_id": "proj-a", "include_reporting": "false"},
    ).json()
    assert all(worker["state"] != "reporting" for worker in no_reporting["workers"])


def test_workforce_live_includes_real_ceo_execution_and_clears_on_terminal(api_client_with_presence) -> None:
    client, workforce_service = api_client_with_presence
    run_service = workforce_service.run_service
    assert run_service is not None

    run, _created = run_service.create_run(
        project_id="proj-ceo",
        message="Create tiny file",
        provider="openai",
    )
    run_id = str(run["id"])
    run_service.transition_run(run_id, state="executing", label="Execution started")

    now = datetime.now(timezone.utc).isoformat()
    workforce_service.ingest_event(
        {
            "timestamp": now,
            "agent": "ceo",
            "action": "STARTED",
            "detail": "Codex executor started",
            "project_id": "proj-ceo",
            "metadata": {
                "run_id": run_id,
                "work_item_id": f"{run_id}:ceo",
                "work_state": "working",
                "source": "real",
                "source_agent": "ceo",
                "target_agent": "workspace",
                "flow": "internal",
                "task": "Codex executor started",
            },
        }
    )

    live = client.get("/api/workforce/live", params={"project_id": "proj-ceo"}).json()
    assert live["counts"]["working"] == 1
    assert any(worker["agent_id"] == "ceo" and worker["state"] == "working" for worker in live["workers"])

    # Step-level completion should keep CEO visible while run still executes.
    workforce_service.ingest_event(
        {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "agent": "ceo",
            "action": "COMPLETED",
            "detail": "Command exit=0",
            "project_id": "proj-ceo",
            "metadata": {
                "run_id": run_id,
                "work_item_id": f"{run_id}:ceo",
                "work_state": "completed",
                "source": "real",
                "source_agent": "ceo",
                "target_agent": "workspace",
                "flow": "internal",
                "task": "Command exit=0",
            },
        }
    )
    mid = client.get("/api/workforce/live", params={"project_id": "proj-ceo"}).json()
    assert mid["counts"]["working"] == 1

    run_service.transition_run(run_id, state="done", label="Execution completed")
    workforce_service.mark_run_terminal(run_id, project_id="proj-ceo", terminal_state="done")
    done = client.get("/api/workforce/live", params={"project_id": "proj-ceo"}).json()
    assert done["counts"] == {"assigned": 0, "working": 0, "reporting": 0, "blocked": 0}


def test_v1_workforce_live_endpoint_contract(temp_data_dir) -> None:
    data_dir = Path(temp_data_dir)
    state_manager = ProjectStateManager(temp_data_dir)
    task_board = TaskBoard(temp_data_dir)
    runtime_settings = RuntimeSettings(data_dir=temp_data_dir, project_root=temp_data_dir, workspace_root=temp_data_dir)
    run_service = RunService(temp_data_dir, runtime_settings)
    project_service = ProjectService(temp_data_dir, state_manager, task_board)
    integration_service = IntegrationService(temp_data_dir, workspace_root=temp_data_dir)
    workforce_service = WorkforcePresenceService(temp_data_dir, run_service=run_service)

    _ingest_working_event(workforce_service, project_id="proj-v1", run_id="run-v1", agent_id="lead-frontend", state="working")

    cfg_store = {"feature_flags": {}}

    def _load_config() -> dict:
        return dict(cfg_store)

    def _save_config(cfg: dict) -> None:
        cfg_store.clear()
        cfg_store.update(cfg)

    app = FastAPI()
    app.include_router(
        create_v1_router(
            V1Context(
                data_dir=str(data_dir),
                load_config=_load_config,
                save_config=_save_config,
                run_service=run_service,
                project_service=project_service,
                integration_service=integration_service,
                workforce_presence_service=workforce_service,
                require_write_auth=None,
            )
        )
    )

    with TestClient(app) as client:
        response = client.get("/api/v1/workforce/live", params={"project_id": "proj-v1"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["project_id"] == "proj-v1"
    assert payload["counts"]["working"] == 1
    assert payload["workers"][0]["agent_id"] == "lead-frontend"


def test_planning_gate_emits_assigned_presence_for_support_agents(api_client_with_presence) -> None:
    client, _workforce_service = api_client_with_presence
    import src.web.api as api_module

    project_id = api_module.state_manager.create_project(
        "Career Tracker Planning",
        "Planning coverage test",
        "app",
    )

    with client.websocket_connect("/api/chat/ws") as websocket:
        websocket.send_text(
            json.dumps(
                {
                    "message": "id like to understand how difficult will be to build a career growth tracker",
                    "project_id": project_id,
                }
            )
        )
        run_payload: dict | None = None
        saw_planning_gate = False
        while True:
            event = websocket.receive_json()
            if event.get("type") == "run":
                run_payload = event.get("content") if isinstance(event.get("content"), dict) else {}
            if event.get("type") == "planning_approval_required":
                saw_planning_gate = True
            if event.get("type") == "done":
                break

    assert saw_planning_gate is True
    assert run_payload is not None
    assert run_payload.get("delegation_stage") == "executive_alignment"
    assert "chief-researcher" in list(run_payload.get("support_agents", []))
    assert "vp-product" in list(run_payload.get("support_agents", []))
    assert "cto" in list(run_payload.get("support_agents", []))

    live = client.get("/api/workforce/live", params={"project_id": project_id}).json()
    assigned_ids = {row.get("agent_id") for row in live.get("workers", []) if row.get("state") == "assigned"}
    assert live["counts"]["working"] == 0
    assert "chief-researcher" in assigned_ids
    assert "vp-product" in assigned_ids
    assert "cto" in assigned_ids

    approve = client.post(f"/api/projects/{project_id}/approve")
    assert approve.status_code == 200
    post_approve = client.get("/api/workforce/live", params={"project_id": project_id}).json()
    assert post_approve["counts"]["assigned"] == 0
