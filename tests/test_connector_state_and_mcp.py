"""Connector state contract and MCP lock-write regression tests."""

from __future__ import annotations

import os
import threading

import yaml
from fastmcp import FastMCP

import src.mcp_server.integrations_tools as integrations_tools
from src.mcp_server.integrations_tools import register_integrations_tools


def _tool_fn(mcp: FastMCP, name: str):
    return mcp._tool_manager._tools[name].fn


def test_mcp_verify_failure_clears_stale_verified(temp_data_dir, monkeypatch):
    config_path = os.path.join(temp_data_dir, "config.yaml")
    with open(config_path, "w", encoding="utf-8") as handle:
        yaml.safe_dump(
            {
                "integrations": {
                    "vercel_token": "vercel_secret",
                    "vercel_project_name": "compaas-dashboard",
                    "vercel_verified": True,
                    "vercel_status": "verified",
                }
            },
            handle,
            sort_keys=False,
        )

    monkeypatch.setattr(
        integrations_tools.IntegrationService,
        "vercel_verify_connection",
        lambda self, token, project_name="", team_id="": {  # noqa: ARG005
            "status": "error",
            "ok": False,
            "project_ok": False,
            "message": "Invalid Vercel token.",
        },
    )

    mcp = FastMCP("connector-test")
    register_integrations_tools(mcp, temp_data_dir)
    verify = _tool_fn(mcp, "verify_connector")
    payload = yaml.safe_load(verify("vercel"))

    assert payload["status"] == "error"
    with open(config_path, "r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle) or {}
    integrations = cfg.get("integrations", {})
    assert integrations.get("vercel_verified") is False
    assert integrations.get("vercel_status") == "degraded"


def test_mcp_discovery_does_not_promote_verification(temp_data_dir, monkeypatch):
    config_path = os.path.join(temp_data_dir, "config.yaml")
    with open(config_path, "w", encoding="utf-8") as handle:
        yaml.safe_dump(
            {
                "integrations": {
                    "vercel_token": "vercel_secret",
                    "vercel_project_name": "compaas-dashboard",
                    "vercel_verified": False,
                    "vercel_status": "configured",
                }
            },
            handle,
            sort_keys=False,
        )

    monkeypatch.setattr(
        integrations_tools.IntegrationService,
        "vercel_list_projects",
        lambda self, token, team_id="": {  # noqa: ARG005
            "status": "ok",
            "projects": [{"name": "compaas-dashboard"}],
        },
    )

    mcp = FastMCP("connector-test")
    register_integrations_tools(mcp, temp_data_dir)
    list_projects = _tool_fn(mcp, "list_vercel_projects")
    payload = yaml.safe_load(list_projects())

    assert payload["status"] == "ok"
    with open(config_path, "r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle) or {}
    integrations = cfg.get("integrations", {})
    assert integrations.get("vercel_verified") is False
    assert integrations.get("vercel_status") == "configured"
    assert integrations.get("vercel_last_success_at")


def test_mcp_save_integrations_merges_parallel_updates(temp_data_dir):
    config_path = os.path.join(temp_data_dir, "config.yaml")
    with open(config_path, "w", encoding="utf-8") as handle:
        yaml.safe_dump(
            {
                "integrations": {
                    "github_repo": "owner/original",
                    "vercel_project_name": "old-project",
                }
            },
            handle,
            sort_keys=False,
        )

    cfg_one = integrations_tools._load_config(temp_data_dir)
    cfg_two = integrations_tools._load_config(temp_data_dir)
    integrations_one = integrations_tools._get_integrations(cfg_one)
    integrations_two = integrations_tools._get_integrations(cfg_two)

    integrations_one["github_repo"] = "owner/updated"
    integrations_two["vercel_project_name"] = "new-project"

    t1 = threading.Thread(
        target=integrations_tools._save_integrations,
        args=(temp_data_dir, cfg_one, integrations_one),
    )
    t2 = threading.Thread(
        target=integrations_tools._save_integrations,
        args=(temp_data_dir, cfg_two, integrations_two),
    )
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    with open(config_path, "r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle) or {}
    integrations = cfg.get("integrations", {})
    assert integrations.get("github_repo") == "owner/updated"
    assert integrations.get("vercel_project_name") == "new-project"
