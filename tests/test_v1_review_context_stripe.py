"""Contract tests for v1 context packs, review layer, and Stripe billing endpoints."""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

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


def _build_client(
    temp_data_dir: str,
    feature_flags: dict[str, Any] | None = None,
) -> tuple[TestClient, dict, ProjectStateManager, str, IntegrationService]:
    state_manager = ProjectStateManager(temp_data_dir, workspace_root=temp_data_dir)
    task_board = TaskBoard(temp_data_dir)
    runtime_settings = RuntimeSettings(data_dir=temp_data_dir, project_root=temp_data_dir, workspace_root=temp_data_dir)
    run_service = RunService(temp_data_dir, runtime_settings)
    project_service = ProjectService(temp_data_dir, state_manager, task_board)
    integration_service = IntegrationService(temp_data_dir, workspace_root=temp_data_dir)
    workforce_service = WorkforcePresenceService(temp_data_dir, run_service=run_service)

    config: dict = {
        "integrations": {
            "workspace_mode": "local",
            "stripe_secret_key": "",
            "stripe_publishable_key": "",
            "stripe_webhook_secret": "",
            "stripe_price_basic": "",
            "stripe_price_pro": "",
            "stripe_verified": False,
            "stripe_verified_at": "",
            "stripe_last_error": "",
        },
        "chat_policy": {},
        "feature_flags": dict(feature_flags or {}),
    }

    def load_config() -> dict:
        return config

    def save_config(next_cfg: dict) -> None:
        snapshot = copy.deepcopy(next_cfg)
        config.clear()
        config.update(snapshot)

    app = FastAPI()
    app.include_router(
        create_v1_router(
            V1Context(
                data_dir=temp_data_dir,
                load_config=load_config,
                save_config=save_config,
                run_service=run_service,
                project_service=project_service,
                integration_service=integration_service,
                workforce_presence_service=workforce_service,
                require_write_auth=lambda _request: None,
                app_version="v1-test",
            )
        )
    )

    project_id = state_manager.create_project("Pack Project", "Context pack + review test", "app")
    client = TestClient(app)
    return client, config, state_manager, project_id, integration_service


def test_context_pack_crud_flow(temp_data_dir: str) -> None:
    client, _config, _manager, project_id, _integration_service = _build_client(temp_data_dir)

    create = client.post(
        "/api/v1/context/packs",
        json={
            "scope": "project",
            "project_id": project_id,
            "kind": "ops",
            "title": "Runtime Defaults",
            "content": "Use pnpm and keep run commands deterministic.",
            "enabled": True,
            "pinned": True,
        },
    )
    assert create.status_code == 200
    pack_id = create.json()["pack"]["id"]

    listing = client.get("/api/v1/context/packs", params={"scope": "project", "project_id": project_id})
    assert listing.status_code == 200
    assert any(item["id"] == pack_id for item in listing.json()["packs"])

    patch = client.patch(f"/api/v1/context/packs/{pack_id}", json={"enabled": False})
    assert patch.status_code == 200
    assert patch.json()["pack"]["enabled"] is False

    delete = client.delete(f"/api/v1/context/packs/{pack_id}")
    assert delete.status_code == 200
    assert delete.json()["deleted"] is True


def test_review_session_comment_flow(temp_data_dir: str) -> None:
    client, _config, _manager, project_id, _integration_service = _build_client(temp_data_dir)

    create_session = client.post(
        f"/api/v1/projects/{project_id}/reviews/sessions",
        json={
            "deployment_url": "https://example-preview.vercel.app",
            "run_id": "run_123",
            "source": "vercel_preview",
            "created_by": "chairman",
        },
    )
    assert create_session.status_code == 200
    session_id = create_session.json()["session"]["id"]

    add_comment = client.post(
        f"/api/v1/reviews/sessions/{session_id}/comments",
        json={
            "route": "/checkout",
            "element_hint": "submit button",
            "note": "Primary button contrast is too low.",
            "severity": "high",
            "status": "open",
            "author": "chairman",
            "tags": ["ui", "accessibility"],
        },
    )
    assert add_comment.status_code == 200
    comment_id = add_comment.json()["comment"]["id"]

    patch_comment = client.patch(
        f"/api/v1/reviews/comments/{comment_id}",
        json={"status": "resolved"},
    )
    assert patch_comment.status_code == 200
    assert patch_comment.json()["comment"]["status"] == "resolved"

    session_detail = client.get(f"/api/v1/reviews/sessions/{session_id}")
    assert session_detail.status_code == 200
    payload = session_detail.json()
    assert payload["session"]["id"] == session_id
    assert payload["comments"][0]["status"] == "resolved"


def test_stripe_verify_and_billing_apply(temp_data_dir: str, monkeypatch) -> None:
    client, config, state_manager, project_id, integration_service = _build_client(temp_data_dir)

    monkeypatch.setattr(
        integration_service,
        "stripe_verify_connection",
        lambda _secret: {
            "status": "ok",
            "ok": True,
            "account": {"id": "acct_123", "email": "owner@example.com"},
            "message": "Stripe key is valid.",
        },
    )

    verify = client.post("/api/v1/stripe/verify", json={"secret_key": "sk_test_123"})
    assert verify.status_code == 200
    assert verify.json()["ok"] is True
    assert config["integrations"]["stripe_secret_key"] == "sk_test_123"
    assert config["integrations"]["stripe_verified"] is True

    workspace_path = str(state_manager.get_project(project_id).get("workspace_path", ""))
    Path(workspace_path).mkdir(parents=True, exist_ok=True)
    (Path(workspace_path) / "package.json").write_text('{"name":"demo"}\n', encoding="utf-8")

    config["integrations"]["stripe_publishable_key"] = "pk_test_123"
    config["integrations"]["stripe_price_basic"] = "price_basic"
    config["integrations"]["stripe_price_pro"] = "price_pro"

    apply_resp = client.post(
        f"/api/v1/projects/{project_id}/billing/stripe/apply",
        json={"scaffold_files": True, "sync_vercel_env": False},
    )
    assert apply_resp.status_code == 200
    artifact_path = apply_resp.json()["artifact_path"]
    assert os.path.exists(artifact_path)

    status_resp = client.get(f"/api/v1/projects/{project_id}/billing/stripe/status")
    assert status_resp.status_code == 200
    assert status_resp.json()["artifact_exists"] is True


def test_feature_flags_gate_new_endpoints(temp_data_dir: str) -> None:
    client, _config, _state_manager, project_id, _integration_service = _build_client(
        temp_data_dir,
        feature_flags={
            "context_packs": False,
            "preview_review_layer": False,
            "stripe_billing_pack": False,
        },
    )

    context_resp = client.get("/api/v1/context/packs")
    assert context_resp.status_code == 404

    review_resp = client.get(f"/api/v1/projects/{project_id}/reviews/sessions")
    assert review_resp.status_code == 404

    stripe_verify_resp = client.post("/api/v1/stripe/verify", json={"secret_key": "sk_test_123"})
    assert stripe_verify_resp.status_code == 404

    stripe_status_resp = client.get(f"/api/v1/projects/{project_id}/billing/stripe/status")
    assert stripe_status_resp.status_code == 404
