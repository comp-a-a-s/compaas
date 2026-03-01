"""Tests for manual release-tag updater helpers in web.api."""

from __future__ import annotations

import src.web.api as api


def test_update_status_reports_available_release(tmp_path, monkeypatch):
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(api, "PROJECT_ROOT", str(repo_root))
    monkeypatch.setattr(api, "_resolve_app_version", lambda: "v1.0.0")
    monkeypatch.setattr(api, "_head_release_tag", lambda: "v1.0.0")
    monkeypatch.setattr(api, "_release_tags_local", lambda: ["v1.0.0", "v1.1.0"])
    monkeypatch.setattr(api, "_is_git_dirty", lambda: False)

    payload = api._update_status_snapshot(refresh_remote=False)

    assert payload["status"] == "ok"
    assert payload["current_version"] == "v1.0.0"
    assert payload["latest_version"] == "v1.1.0"
    assert payload["update_available"] is True
    assert payload["can_update"] is True
    assert payload["dirty_repo"] is False


def test_update_status_blocks_when_repo_is_dirty(tmp_path, monkeypatch):
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(api, "PROJECT_ROOT", str(repo_root))
    monkeypatch.setattr(api, "_resolve_app_version", lambda: "v1.1.0")
    monkeypatch.setattr(api, "_head_release_tag", lambda: "v1.1.0")
    monkeypatch.setattr(api, "_release_tags_local", lambda: ["v1.1.0", "v1.2.0"])
    monkeypatch.setattr(api, "_is_git_dirty", lambda: True)

    payload = api._update_status_snapshot(refresh_remote=False)

    assert payload["status"] == "ok"
    assert payload["dirty_repo"] is True
    assert payload["can_update"] is False
    assert "uncommitted changes" in payload["block_reason"].lower()


def test_apply_release_tag_update_returns_restart_required(monkeypatch):
    monkeypatch.setattr(
        api,
        "_update_status_snapshot",
        lambda refresh_remote=True: {
            "status": "ok",
            "channel": "release_tags",
            "current_version": "v1.0.0",
            "latest_version": "v1.1.0",
            "update_available": True,
            "dirty_repo": False,
            "can_update": True,
            "block_reason": "",
            "_available_tags": ["v1.0.0", "v1.1.0"],
        },
    )
    monkeypatch.setattr(api, "_is_git_dirty", lambda: False)
    monkeypatch.setattr(api, "_head_release_tag", lambda: "v1.1.0")
    monkeypatch.setattr(api, "_record_update_event", lambda _event: None)

    def _fake_run_git(*args: str, timeout_seconds: float = 30.0):
        if args and args[0] in {"fetch", "reset"}:
            return True, ""
        return True, ""

    monkeypatch.setattr(api, "_run_git_command", _fake_run_git)

    payload = api._apply_release_tag_update()

    assert payload["status"] == "ok"
    assert payload["update_applied"] is True
    assert payload["restart_required"] is True
    assert payload["from_version"] == "v1.0.0"
    assert payload["to_version"] == "v1.1.0"
