"""MCP tools for connector awareness and connector-backed operations."""

from __future__ import annotations

import os
from typing import Any

import yaml
from fastmcp import FastMCP

from src.utils import FileLock, atomic_yaml_write, emit_activity
from src.web.connector_state import (
    connector_health_row as _shared_connector_health_row,
    set_connector_health as _shared_set_connector_health,
)
from src.web.services.integration_service import IntegrationService

CONNECTOR_FEATURE_FLAGS: dict[str, str] = {
    "linear": "linear_connector",
    "notion": "notion_connector",
    "jira": "jira_connector",
    "gitlab": "gitlab_connector",
}


def _config_path(data_dir: str) -> str:
    return os.path.join(data_dir, "config.yaml")


def _load_config(data_dir: str) -> dict[str, Any]:
    path = _config_path(data_dir)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = yaml.safe_load(handle) or {}
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _save_config(data_dir: str, config: dict[str, Any]) -> None:
    atomic_yaml_write(_config_path(data_dir), config)


def _get_integrations(config: dict[str, Any]) -> dict[str, Any]:
    integrations = config.get("integrations", {})
    if isinstance(integrations, dict):
        return dict(integrations)
    return {}


def _set_connector_health(
    integrations: dict[str, Any],
    connector: str,
    *,
    configured: bool,
    verified: bool,
    error_message: str = "",
    allow_verify_promotion: bool = True,
    record_success_without_verify: bool = False,
) -> None:
    _shared_set_connector_health(
        integrations,
        connector,
        configured=configured,
        verified=verified,
        error_message=error_message,
        allow_verify_promotion=allow_verify_promotion,
        record_success_without_verify=record_success_without_verify,
    )


def _feature_enabled(config: dict[str, Any], connector: str) -> bool:
    flag_name = CONNECTOR_FEATURE_FLAGS.get(connector)
    if not flag_name:
        return True
    cfg_flags = config.get("feature_flags", {}) if isinstance(config.get("feature_flags"), dict) else {}
    return bool(cfg_flags.get(flag_name, True))


def _yaml(payload: dict[str, Any]) -> str:
    return yaml.safe_dump(payload, default_flow_style=False, sort_keys=False)


def _connector_health_row(integrations: dict[str, Any], connector: str) -> dict[str, Any]:
    return _shared_connector_health_row(integrations, connector)


def _capability_snapshot(integrations: dict[str, Any]) -> dict[str, Any]:
    return {
        "workspace_mode": str(integrations.get("workspace_mode", "local") or "local").strip().lower() or "local",
        "connectors": {
            "github": {
                "configured": bool(str(integrations.get("github_token", "") or "").strip() and str(integrations.get("github_repo", "") or "").strip()),
                "repo": str(integrations.get("github_repo", "") or "").strip(),
                "capabilities": ["create_branch", "push_branch", "open_pull_request", "manage_issues"],
                "health": _connector_health_row(integrations, "github"),
            },
            "gitlab": {
                "configured": bool(str(integrations.get("gitlab_token", "") or "").strip() and str(integrations.get("gitlab_project_id", "") or "").strip()),
                "project_id": str(integrations.get("gitlab_project_id", "") or "").strip(),
                "base_url": str(integrations.get("gitlab_base_url", "https://gitlab.com") or "https://gitlab.com").strip(),
                "capabilities": ["verify", "create_branch", "create_merge_request"],
                "health": _connector_health_row(integrations, "gitlab"),
            },
            "vercel": {
                "configured": bool(str(integrations.get("vercel_token", "") or "").strip() and str(integrations.get("vercel_project_name", "") or "").strip()),
                "project_name": str(integrations.get("vercel_project_name", "") or "").strip(),
                "capabilities": ["verify", "list_projects", "deploy_preview", "deploy_production"],
                "health": _connector_health_row(integrations, "vercel"),
            },
            "netlify": {
                "configured": bool(str(integrations.get("netlify_token", "") or "").strip() and str(integrations.get("netlify_site_id", "") or "").strip()),
                "site_id": str(integrations.get("netlify_site_id", "") or "").strip(),
                "capabilities": ["verify", "list_sites", "deploy_preview", "deploy_production"],
                "health": _connector_health_row(integrations, "netlify"),
            },
            "stripe": {
                "configured": bool(str(integrations.get("stripe_secret_key", "") or "").strip()),
                "capabilities": ["verify", "billing_pack_support"],
                "health": _connector_health_row(integrations, "stripe"),
            },
            "slack": {
                "configured": bool(str(integrations.get("slack_token", "") or "").strip()),
                "default_channel": str(integrations.get("slack_default_channel", "") or "").strip(),
                "capabilities": ["send_message"],
                "health": _connector_health_row(integrations, "slack"),
            },
            "telegram": {
                "configured": bool(str(integrations.get("telegram_bot_token", "") or "").strip() and str(integrations.get("telegram_chat_id", "") or "").strip()),
                "capabilities": ["send_message", "poll_updates"],
                "health": _connector_health_row(integrations, "telegram"),
            },
            "linear": {
                "configured": bool(str(integrations.get("linear_api_key", "") or "").strip()),
                "team_id": str(integrations.get("linear_team_id", "") or "").strip(),
                "capabilities": ["verify", "create_issue"],
                "health": _connector_health_row(integrations, "linear"),
            },
            "notion": {
                "configured": bool(str(integrations.get("notion_token", "") or "").strip()),
                "parent_page_id": str(integrations.get("notion_parent_page_id", "") or "").strip(),
                "capabilities": ["verify", "upsert_page"],
                "health": _connector_health_row(integrations, "notion"),
            },
            "jira": {
                "configured": bool(
                    str(integrations.get("jira_base_url", "") or "").strip()
                    and str(integrations.get("jira_email", "") or "").strip()
                    and str(integrations.get("jira_api_token", "") or "").strip()
                ),
                "base_url": str(integrations.get("jira_base_url", "") or "").strip(),
                "project_key": str(integrations.get("jira_project_key", "") or "").strip(),
                "capabilities": ["verify", "create_issue", "transition_issue"],
                "health": _connector_health_row(integrations, "jira"),
            },
        },
    }


_REMOVED = object()


def _save_integrations(data_dir: str, config: dict[str, Any], integrations: dict[str, Any]) -> None:
    """Persist integration changes with lock-protected merge to avoid clobbering."""
    original = _get_integrations(config)
    changed: dict[str, Any] = {}
    keys = set(original.keys()) | set(integrations.keys())
    for key in keys:
        before = original.get(key, _REMOVED)
        after = integrations.get(key, _REMOVED)
        if before != after:
            changed[key] = after

    if not changed:
        return

    path = _config_path(data_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with FileLock(path):
        latest = _load_config(data_dir)
        latest_integrations = _get_integrations(latest)
        for key, value in changed.items():
            if value is _REMOVED:
                latest_integrations.pop(key, None)
            else:
                latest_integrations[key] = value
        latest["integrations"] = latest_integrations
        _save_config(data_dir, latest)


def register_integrations_tools(mcp: FastMCP, data_dir: str) -> None:
    """Register integration awareness + operation tools for specialist agents."""
    service = IntegrationService(data_dir)

    @mcp.tool
    def get_connector_capabilities() -> str:
        """Return non-secret connector capability metadata and health status."""
        config = _load_config(data_dir)
        integrations = _get_integrations(config)
        return _yaml({"status": "ok", **_capability_snapshot(integrations)})

    @mcp.tool
    def verify_connector(connector: str) -> str:
        """Verify a configured connector using saved credentials."""
        key = str(connector or "").strip().lower()
        config = _load_config(data_dir)
        integrations = _get_integrations(config)
        if key not in {"github", "vercel", "netlify", "stripe", "linear", "notion", "jira", "gitlab"}:
            return _yaml({"status": "error", "message": f"Unsupported connector '{key}'."})
        if not _feature_enabled(config, key):
            return _yaml({"status": "error", "message": f"Connector '{key}' is disabled by feature flag."})

        result: dict[str, Any]
        configured = False
        verified = False
        message = ""

        if key == "github":
            token = str(integrations.get("github_token", "") or "").strip()
            repo = str(integrations.get("github_repo", "") or "").strip()
            configured = bool(token and repo)
            result = service.github_verify_connection(token, repo=repo)
            verified = bool(result.get("ok")) and bool(result.get("repo_ok"))
            if verified:
                integrations["github_verified"] = True
        elif key == "vercel":
            token = str(integrations.get("vercel_token", "") or "").strip()
            project = str(integrations.get("vercel_project_name", "") or "").strip()
            team_id = str(integrations.get("vercel_team_id", "") or "").strip()
            configured = bool(token and project)
            result = service.vercel_verify_connection(token, project_name=project, team_id=team_id)
            verified = bool(result.get("ok")) and bool(result.get("project_ok"))
            if verified:
                integrations["vercel_verified"] = True
        elif key == "netlify":
            token = str(integrations.get("netlify_token", "") or "").strip()
            site_id = str(integrations.get("netlify_site_id", "") or "").strip()
            team_id = str(integrations.get("netlify_team_id", "") or "").strip()
            configured = bool(token and site_id)
            result = service.netlify_verify_connection(token, site_id=site_id, team_id=team_id)
            verified = bool(result.get("ok")) and bool(result.get("site_ok"))
            if verified:
                integrations["netlify_verified"] = True
        elif key == "stripe":
            secret = str(integrations.get("stripe_secret_key", "") or "").strip()
            configured = bool(secret)
            result = service.stripe_verify_connection(secret)
            verified = bool(result.get("ok"))
            if verified:
                integrations["stripe_verified"] = True
        elif key == "linear":
            api_key = str(integrations.get("linear_api_key", "") or "").strip()
            configured = bool(api_key)
            result = service.linear_verify_connection(api_key)
            verified = bool(result.get("ok"))
            if verified:
                integrations["linear_verified"] = True
        elif key == "notion":
            token = str(integrations.get("notion_token", "") or "").strip()
            configured = bool(token)
            result = service.notion_verify_connection(token)
            verified = bool(result.get("ok"))
            if verified:
                integrations["notion_verified"] = True
        elif key == "jira":
            base_url = str(integrations.get("jira_base_url", "") or "").strip()
            email = str(integrations.get("jira_email", "") or "").strip()
            api_token = str(integrations.get("jira_api_token", "") or "").strip()
            configured = bool(base_url and email and api_token)
            result = service.jira_verify_connection(base_url=base_url, email=email, api_token=api_token)
            verified = bool(result.get("ok"))
            if verified:
                integrations["jira_verified"] = True
        else:
            base_url = str(integrations.get("gitlab_base_url", "https://gitlab.com") or "https://gitlab.com").strip()
            token = str(integrations.get("gitlab_token", "") or "").strip()
            project_id = str(integrations.get("gitlab_project_id", "") or "").strip()
            configured = bool(base_url and token)
            result = service.gitlab_verify_connection(base_url=base_url, token=token, project_id=project_id)
            verified = bool(result.get("ok")) and (bool(result.get("project_ok")) if project_id else True)
            if verified:
                integrations["gitlab_verified"] = True

        message = str(result.get("message", "") or "").strip()
        _set_connector_health(
            integrations,
            key,
            configured=configured,
            verified=verified,
            error_message="" if verified else message,
        )
        _save_integrations(data_dir, config, integrations)
        emit_activity(
            data_dir,
            "system",
            "UPDATED",
            f"Connector verify executed for {key}.",
            metadata={"connector": key, "verified": verified},
        )
        return _yaml(
            {
                "status": "ok" if verified else "error",
                "connector": key,
                "verified": verified,
                "message": message or ("Verification succeeded." if verified else "Verification failed."),
                "health": _connector_health_row(integrations, key),
            }
        )

    @mcp.tool
    def send_slack_message(channel: str, text: str, thread_ts: str = "") -> str:
        """Send a Slack message using saved connector credentials."""
        config = _load_config(data_dir)
        integrations = _get_integrations(config)
        token = str(integrations.get("slack_token", "") or "").strip()
        if not token:
            return _yaml({"status": "error", "message": "Slack connector is not configured."})
        result = service.slack_send_message(token, channel=channel, text=text, thread_ts=thread_ts)
        ok = result.get("status") == "ok"
        _set_connector_health(
            integrations,
            "slack",
            configured=True,
            verified=ok,
            error_message="" if ok else str(result.get("message", "") or "Slack send failed."),
        )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "Slack send failed."})

    @mcp.tool
    def create_linear_issue(title: str, description: str = "", team_id: str = "", priority: int = 0) -> str:
        """Create a Linear issue using saved connector credentials."""
        config = _load_config(data_dir)
        if not _feature_enabled(config, "linear"):
            return _yaml({"status": "error", "message": "Linear connector is disabled by feature flag."})
        integrations = _get_integrations(config)
        api_key = str(integrations.get("linear_api_key", "") or "").strip()
        resolved_team = str(team_id or integrations.get("linear_team_id", "") or "").strip()
        if not api_key or not resolved_team:
            return _yaml({"status": "error", "message": "Linear connector requires api key and team_id."})
        result = service.linear_create_issue(api_key, team_id=resolved_team, title=title, description=description, priority=priority)
        ok = result.get("status") == "ok"
        _set_connector_health(
            integrations,
            "linear",
            configured=bool(api_key and resolved_team),
            verified=ok,
            error_message="" if ok else str(result.get("message", "") or "Linear create issue failed."),
        )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "Linear create issue failed."})

    @mcp.tool
    def upsert_notion_page(title: str, markdown: str = "", page_id: str = "", parent_page_id: str = "") -> str:
        """Create or update a Notion page from project output."""
        config = _load_config(data_dir)
        if not _feature_enabled(config, "notion"):
            return _yaml({"status": "error", "message": "Notion connector is disabled by feature flag."})
        integrations = _get_integrations(config)
        token = str(integrations.get("notion_token", "") or "").strip()
        resolved_parent = str(parent_page_id or integrations.get("notion_parent_page_id", "") or "").strip()
        if not token:
            return _yaml({"status": "error", "message": "Notion connector is not configured."})
        result = service.notion_upsert_page(
            token,
            parent_page_id=resolved_parent,
            title=title,
            markdown=markdown,
            page_id=page_id,
        )
        ok = result.get("status") == "ok"
        _set_connector_health(
            integrations,
            "notion",
            configured=bool(token and (resolved_parent or page_id)),
            verified=ok,
            error_message="" if ok else str(result.get("message", "") or "Notion upsert failed."),
        )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "Notion upsert failed."})

    @mcp.tool
    def create_jira_issue(summary: str, description: str = "", issue_type: str = "Task", project_key: str = "") -> str:
        """Create a Jira issue with saved connector credentials."""
        config = _load_config(data_dir)
        if not _feature_enabled(config, "jira"):
            return _yaml({"status": "error", "message": "Jira connector is disabled by feature flag."})
        integrations = _get_integrations(config)
        base_url = str(integrations.get("jira_base_url", "") or "").strip()
        email = str(integrations.get("jira_email", "") or "").strip()
        api_token = str(integrations.get("jira_api_token", "") or "").strip()
        resolved_project = str(project_key or integrations.get("jira_project_key", "") or "").strip()
        if not base_url or not email or not api_token or not resolved_project:
            return _yaml({"status": "error", "message": "Jira connector is not fully configured."})
        result = service.jira_create_issue(
            base_url=base_url,
            email=email,
            api_token=api_token,
            project_key=resolved_project,
            summary=summary,
            description=description,
            issue_type=issue_type,
        )
        ok = result.get("status") == "ok"
        _set_connector_health(
            integrations,
            "jira",
            configured=True,
            verified=ok,
            error_message="" if ok else str(result.get("message", "") or "Jira create issue failed."),
        )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "Jira create issue failed."})

    @mcp.tool
    def transition_jira_issue(issue_key: str, transition_id: str) -> str:
        """Transition a Jira issue to a different workflow state."""
        config = _load_config(data_dir)
        if not _feature_enabled(config, "jira"):
            return _yaml({"status": "error", "message": "Jira connector is disabled by feature flag."})
        integrations = _get_integrations(config)
        base_url = str(integrations.get("jira_base_url", "") or "").strip()
        email = str(integrations.get("jira_email", "") or "").strip()
        api_token = str(integrations.get("jira_api_token", "") or "").strip()
        if not base_url or not email or not api_token:
            return _yaml({"status": "error", "message": "Jira connector is not fully configured."})
        result = service.jira_transition_issue(
            base_url=base_url,
            email=email,
            api_token=api_token,
            issue_key=issue_key,
            transition_id=transition_id,
        )
        ok = result.get("status") == "ok"
        _set_connector_health(
            integrations,
            "jira",
            configured=True,
            verified=ok,
            error_message="" if ok else str(result.get("message", "") or "Jira transition failed."),
        )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "Jira transition failed."})

    @mcp.tool
    def create_gitlab_branch(branch: str, ref: str = "main", project_id: str = "") -> str:
        """Create a GitLab branch with saved connector credentials."""
        config = _load_config(data_dir)
        if not _feature_enabled(config, "gitlab"):
            return _yaml({"status": "error", "message": "GitLab connector is disabled by feature flag."})
        integrations = _get_integrations(config)
        token = str(integrations.get("gitlab_token", "") or "").strip()
        base_url = str(integrations.get("gitlab_base_url", "https://gitlab.com") or "https://gitlab.com").strip()
        resolved_project = str(project_id or integrations.get("gitlab_project_id", "") or "").strip()
        if not token or not resolved_project:
            return _yaml({"status": "error", "message": "GitLab connector is not fully configured."})
        result = service.gitlab_create_branch(
            base_url=base_url,
            token=token,
            project_id=resolved_project,
            branch=branch,
            ref=ref,
        )
        ok = result.get("status") == "ok"
        _set_connector_health(
            integrations,
            "gitlab",
            configured=True,
            verified=ok,
            error_message="" if ok else str(result.get("message", "") or "GitLab create branch failed."),
        )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "GitLab create branch failed."})

    @mcp.tool
    def create_gitlab_merge_request(
        source_branch: str,
        target_branch: str,
        title: str,
        description: str = "",
        project_id: str = "",
    ) -> str:
        """Create a GitLab merge request with saved connector credentials."""
        config = _load_config(data_dir)
        if not _feature_enabled(config, "gitlab"):
            return _yaml({"status": "error", "message": "GitLab connector is disabled by feature flag."})
        integrations = _get_integrations(config)
        token = str(integrations.get("gitlab_token", "") or "").strip()
        base_url = str(integrations.get("gitlab_base_url", "https://gitlab.com") or "https://gitlab.com").strip()
        resolved_project = str(project_id or integrations.get("gitlab_project_id", "") or "").strip()
        if not token or not resolved_project:
            return _yaml({"status": "error", "message": "GitLab connector is not fully configured."})
        result = service.gitlab_create_merge_request(
            base_url=base_url,
            token=token,
            project_id=resolved_project,
            source_branch=source_branch,
            target_branch=target_branch,
            title=title,
            description=description,
        )
        ok = result.get("status") == "ok"
        _set_connector_health(
            integrations,
            "gitlab",
            configured=True,
            verified=ok,
            error_message="" if ok else str(result.get("message", "") or "GitLab create merge request failed."),
        )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "GitLab create merge request failed."})

    @mcp.tool
    def list_vercel_projects() -> str:
        """List Vercel projects for the saved connector token."""
        config = _load_config(data_dir)
        integrations = _get_integrations(config)
        token = str(integrations.get("vercel_token", "") or "").strip()
        team_id = str(integrations.get("vercel_team_id", "") or "").strip()
        if not token:
            return _yaml({"status": "error", "message": "Vercel connector is not configured."})
        result = service.vercel_list_projects(token, team_id=team_id)
        ok = result.get("status") == "ok"
        _set_connector_health(
            integrations,
            "vercel",
            configured=bool(token and str(integrations.get("vercel_project_name", "") or "").strip()),
            verified=str(integrations.get("vercel_status", "") or "").strip().lower() == "verified" and bool(integrations.get("vercel_verified")),
            error_message="" if ok else str(result.get("message", "") or "Vercel list projects failed."),
            record_success_without_verify=ok,
        )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "Vercel list projects failed."})

    @mcp.tool
    def list_netlify_sites() -> str:
        """List Netlify sites for the saved connector token."""
        config = _load_config(data_dir)
        integrations = _get_integrations(config)
        token = str(integrations.get("netlify_token", "") or "").strip()
        team_id = str(integrations.get("netlify_team_id", "") or "").strip()
        if not token:
            return _yaml({"status": "error", "message": "Netlify connector is not configured."})
        result = service.netlify_list_sites(token, team_id=team_id)
        ok = result.get("status") == "ok"
        _set_connector_health(
            integrations,
            "netlify",
            configured=bool(token and str(integrations.get("netlify_site_id", "") or "").strip()),
            verified=str(integrations.get("netlify_status", "") or "").strip().lower() == "verified" and bool(integrations.get("netlify_verified")),
            error_message="" if ok else str(result.get("message", "") or "Netlify list sites failed."),
            record_success_without_verify=ok,
        )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "Netlify list sites failed."})

    @mcp.tool
    def deploy_with_connector(provider: str = "vercel", target: str = "preview") -> str:
        """Deploy with saved deployment connector config (Vercel or Netlify)."""
        config = _load_config(data_dir)
        integrations = _get_integrations(config)
        normalized_provider = str(provider or "vercel").strip().lower()
        normalized_target = str(target or "preview").strip().lower()
        if normalized_provider not in {"vercel", "netlify"}:
            return _yaml({"status": "error", "message": "provider must be 'vercel' or 'netlify'."})
        if normalized_target not in {"preview", "production"}:
            normalized_target = "preview"

        if normalized_provider == "vercel":
            result = service.vercel_deploy_saved(integrations, target=normalized_target)
            ok = result.get("status") == "ok"
            _set_connector_health(
                integrations,
                "vercel",
                configured=bool(str(integrations.get("vercel_token", "") or "").strip() and str(integrations.get("vercel_project_name", "") or "").strip()),
                verified=ok,
                error_message="" if ok else str(result.get("message", "") or "Vercel deploy failed."),
            )
        else:
            result = service.netlify_deploy_saved(integrations, target=normalized_target)
            ok = result.get("status") == "ok"
            _set_connector_health(
                integrations,
                "netlify",
                configured=bool(str(integrations.get("netlify_token", "") or "").strip() and str(integrations.get("netlify_site_id", "") or "").strip()),
                verified=ok,
                error_message="" if ok else str(result.get("message", "") or "Netlify deploy failed."),
            )
        _save_integrations(data_dir, config, integrations)
        return _yaml(result if isinstance(result, dict) else {"status": "error", "message": "Deploy failed."})
