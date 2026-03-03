"""Focused tests for reliability-first error contracts."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from src.web.api import app


@pytest.fixture
def client(temp_data_dir, monkeypatch):
    """Return a TestClient wired to the temporary data directory."""
    from src.state.project_state import ProjectStateManager
    from src.state.task_board import TaskBoard
    import src.web.api as api_module

    monkeypatch.setattr(api_module, "DATA_DIR", temp_data_dir)
    monkeypatch.setattr(api_module, "state_manager", ProjectStateManager(temp_data_dir))
    monkeypatch.setattr(api_module, "task_board", TaskBoard(temp_data_dir))
    monkeypatch.setattr(api_module, "CONFIG_PATH", os.path.join(temp_data_dir, "config.yaml"))
    monkeypatch.setattr(api_module, "MEMORY_PATH", os.path.join(temp_data_dir, "ceo_memory.md"))

    with TestClient(app) as test_client:
        yield test_client


def test_http_middleware_sets_correlation_header(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.headers.get("x-correlation-id")


def test_validation_problem_payload_includes_guidance_actions(client):
    response = client.post("/api/v1/runs", json={})
    assert response.status_code == 422
    payload = response.json()
    assert payload["detail"] == "Request validation failed."
    assert payload["code"] == "request_validation_failed"
    assert payload["action_required"] is True
    assert isinstance(payload.get("actions"), list)
    assert payload["actions"][0]["kind"] == "retry"
    assert payload.get("correlation_id")


def test_system_readiness_endpoint_returns_diagnostics_shape(client):
    response = client.get("/api/v1/system/readiness")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"ok", "degraded"}
    assert "timestamp" in payload
    assert isinstance(payload.get("provider"), dict)
    assert isinstance(payload.get("tools"), dict)
    assert isinstance(payload.get("workspace"), dict)
    assert isinstance(payload.get("integrations"), dict)
