"""Additional coverage for web service layer and runtime settings."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import pytest
import yaml

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard
from src.web.problem import PROBLEM_JSON, problem_http_exception, problem_response
from src.web.services.integration_service import IntegrationService
from src.web.services.project_service import ProjectService
from src.web.services.run_service import RunService
from src.web.settings import RuntimeSettings, SandboxProfile, merge_feature_flags, resolve_sandbox_profile


def _make_data_dir(tmp_path) -> str:
    data_dir = str(tmp_path / "company_data")
    os.makedirs(os.path.join(data_dir, "projects"), exist_ok=True)
    return data_dir


def _make_project_service(tmp_path) -> tuple[str, ProjectStateManager, TaskBoard, ProjectService]:
    data_dir = _make_data_dir(tmp_path)
    workspace_root = str(tmp_path / "workspace")
    manager = ProjectStateManager(data_dir, workspace_root=workspace_root)
    board = TaskBoard(data_dir)
    service = ProjectService(data_dir, manager, board)
    return data_dir, manager, board, service


def test_problem_helpers_build_expected_payloads():
    response = problem_response(
        status=422,
        title="Validation Failed",
        detail="Input payload is invalid",
        type_="https://example.dev/problem/validation",
        instance="/api/v1/test",
        extra={"field": "name"},
    )
    payload = json.loads(response.body.decode("utf-8"))

    assert response.status_code == 422
    assert response.media_type == PROBLEM_JSON
    assert payload["title"] == "Validation Failed"
    assert payload["instance"] == "/api/v1/test"
    assert payload["field"] == "name"

    exc = problem_http_exception(status=409, title="Conflict", detail="Duplicate run")
    assert exc.status_code == 409
    assert exc.detail["title"] == "Conflict"
    assert exc.detail["detail"] == "Duplicate run"


def test_settings_helpers_merge_flags_and_resolve_profiles(monkeypatch, tmp_path):
    settings = RuntimeSettings(
        data_dir=str(tmp_path / "data"),
        project_root=str(tmp_path),
        workspace_root=str(tmp_path / "workspace"),
        safe_profile=SandboxProfile(max_commands=5, max_runtime_seconds=120, max_files_touched=8),
        standard_profile=SandboxProfile(max_commands=25, max_runtime_seconds=600, max_files_touched=40),
        full_profile=SandboxProfile(max_commands=90, max_runtime_seconds=1600, max_files_touched=200),
    )
    monkeypatch.setattr("src.web.settings.get_runtime_settings", lambda: settings)

    merged = merge_feature_flags({"feature_flags": {"run_replay": False, "nonexistent": True}})
    assert merged.run_replay is False
    assert merged.structured_ceo_response is True

    assert resolve_sandbox_profile("safe").max_commands == 5
    assert resolve_sandbox_profile("full").max_files_touched == 200
    assert resolve_sandbox_profile("unknown").max_runtime_seconds == 600
    assert settings.resolved_workspace_root().endswith("workspace")


def test_run_service_lifecycle_and_recovery(monkeypatch, tmp_path):
    data_dir = _make_data_dir(tmp_path)
    settings = RuntimeSettings(
        data_dir=data_dir,
        project_root=str(tmp_path),
        workspace_root=str(tmp_path / "workspace"),
        max_project_concurrency=1,
        duplicate_turn_window_seconds=600,
    )

    monkeypatch.setattr(
        "src.web.services.run_service.resolve_sandbox_profile",
        lambda _name: SandboxProfile(max_commands=2, max_runtime_seconds=120, max_files_touched=1),
    )

    service = RunService(data_dir, settings)
    run, created = service.create_run(
        project_id="p1",
        message="Build landing page",
        provider="openai",
        idempotency_key="run-key-1",
        metadata={"source": "test"},
    )
    assert created is True
    assert run["status"] == "queued"

    same_run, created_again = service.create_run(
        project_id="p1",
        message="Build landing page",
        provider="openai",
        idempotency_key="run-key-1",
    )
    assert created_again is False
    assert same_run["id"] == run["id"]

    service.transition_run(run["id"], state="planning", label="Planning started")
    service.transition_run(run["id"], state="executing", label="Execution started")
    service.record_command(run["id"], command="npm test", cwd="/tmp/project", duration_ms=12, exit_code=0, output_preview="ok")
    service.record_command(run["id"], command="npm run build", cwd="/tmp/project", duration_ms=45, exit_code=0)
    service.record_command(run["id"], command="npm run lint", cwd="/tmp/project", duration_ms=20, exit_code=0)
    service.record_file_touch(run["id"], "src/App.tsx")

    guardrails = service.guardrail_status(run["id"])
    assert guardrails is not None
    assert guardrails["over_budget"] is True

    replay = service.replay(run["id"])
    assert replay is not None
    assert replay["run_id"] == run["id"]
    assert replay["guardrails"]["command_count"] == 3

    cancelled = service.cancel_run(run["id"], reason="Stopped by QA")
    assert cancelled is not None
    assert cancelled["status"] == "cancelled"
    assert service.cancel_run("missing") is None

    # Concurrency: only one active run per project with this test configuration.
    active, _ = service.create_run(project_id="p2", message="task A", provider="anthropic")
    assert active["project_id"] == "p2"
    with pytest.raises(RuntimeError):
        service.create_run(project_id="p2", message="task B", provider="anthropic")

    service.transition_run(active["id"], state="done", label="Completed")
    new_run, created_new = service.create_run(project_id="p2", message="task B", provider="anthropic")
    assert created_new is True
    assert new_run["id"] != active["id"]

    assert service.get_run("does-not-exist") is None
    assert service.list_runs(project_id="p2", limit=1)

    # Recovery flow: seed an interrupted run and ensure startup marks it failed.
    interrupted_path = os.path.join(data_dir, "run_registry.yaml")
    with open(interrupted_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(
            {
                "runs": [
                    {
                        "id": "recover-me",
                        "project_id": "p3",
                        "status": "executing",
                        "timeline": [],
                        "created_at": "2026-02-01T00:00:00+00:00",
                    }
                ]
            },
            f,
        )

    recovered = RunService(data_dir, settings)
    recovered_run = recovered.get_run("recover-me")
    assert recovered_run is not None
    assert recovered_run["status"] == "failed"
    assert any(item.get("metadata", {}).get("reason") == "recovered_interrupted_run" for item in recovered_run["timeline"])


def test_run_service_runtime_guardrail_and_auto_expiry(monkeypatch, tmp_path):
    data_dir = _make_data_dir(tmp_path)
    settings = RuntimeSettings(
        data_dir=data_dir,
        project_root=str(tmp_path),
        workspace_root=str(tmp_path / "workspace"),
        max_project_concurrency=1,
        duplicate_turn_window_seconds=600,
    )

    monkeypatch.setattr(
        "src.web.services.run_service.resolve_sandbox_profile",
        lambda _name: SandboxProfile(max_commands=50, max_runtime_seconds=60, max_files_touched=50),
    )
    service = RunService(data_dir, settings)
    run, _ = service.create_run(
        project_id="runtime-p1",
        message="Build app shell",
        provider="openai",
    )
    service.transition_run(run["id"], state="executing", label="Running")

    # Backdate run to trigger runtime budget expiry logic.
    registry_path = os.path.join(data_dir, "run_registry.yaml")
    with open(registry_path, encoding="utf-8") as f:
        registry = yaml.safe_load(f) or {"runs": []}
    old_started = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    for row in registry.get("runs", []):
        if row.get("id") == run["id"]:
            row["started_at"] = old_started
            row["status"] = "executing"
            break
    with open(registry_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(registry, f)

    guardrails = service.guardrail_status(run["id"])
    assert guardrails is not None
    assert guardrails["runtime_exceeded"] is True
    assert guardrails["over_budget"] is True
    assert guardrails["max_runtime_seconds"] == 60

    # New run for same project should auto-expire the stale one instead of 409.
    next_run, created = service.create_run(
        project_id="runtime-p1",
        message="Build app shell v2",
        provider="openai",
    )
    assert created is True
    assert next_run["id"] != run["id"]

    expired = service.get_run(run["id"])
    assert expired is not None
    assert expired["status"] == "failed"
    assert any(
        item.get("metadata", {}).get("reason") == "runtime_budget_exceeded"
        for item in expired.get("timeline", [])
    )


def test_project_service_end_to_end(tmp_path):
    data_dir, manager, board, service = _make_project_service(tmp_path)

    project, created = service.create_project(
        name="Commerce UI",
        description="Build a storefront",
        project_type="web",
        idempotency_key="proj-key",
    )
    assert created is True

    same_project, created_again = service.create_project(
        name="Commerce UI",
        description="Build a storefront",
        project_type="web",
        idempotency_key="proj-key",
    )
    assert created_again is False
    assert same_project["id"] == project["id"]

    project_id = project["id"]
    metadata = service.get_metadata(project_id)
    assert metadata["branch_policy"]["enforced"] is True

    updated = service.update_metadata(project_id, {"charter": {"scope": "MVP checkout"}})
    assert updated["charter"]["scope"] == "MVP checkout"

    workspace = manager.get_project(project_id)["workspace_path"]
    file_path = os.path.join(workspace, "src", "main.ts")
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write("console.log('hi')\n")

    artifact_meta = service.register_artifact(project_id, file_path=file_path, action="created", run_id="r1", agent="ceo")
    assert artifact_meta["artifacts"][-1]["file_path"] == os.path.join("src", "main.ts")

    # Seed activity log and verify delta extraction.
    activity_path = os.path.join(data_dir, "activity.log")
    with open(activity_path, "w", encoding="utf-8") as f:
        f.write(
            json.dumps(
                {
                    "timestamp": "2026-02-20T10:00:00+00:00",
                    "project_id": project_id,
                    "action": "UPDATED",
                    "detail": "Touched main.ts",
                }
            )
            + "\n"
        )

    delta = service.delta_since(project_id)
    assert delta["events"]
    assert delta["artifacts"]

    # README quality and analytics.
    with open(os.path.join(workspace, "README.md"), "w", encoding="utf-8") as f:
        f.write(
            "# Commerce UI\n\n"
            "## Setup\nInstall deps\n\n"
            "## Run\nStart server\n\n"
            "## Environment\nSet .env\n\n"
            "## Deploy\nUse Vercel\n"
        )

    readme = service.readme_quality(project_id)
    assert readme["score"] >= 80

    t1 = board.create_task(project_id, "Build cart", "", "lead-frontend")
    t2 = board.create_task(project_id, "Write docs", "", "tech-writer")
    assert board.update_status(project_id, t1, "in_progress")
    assert board.update_status(project_id, t1, "review")
    assert board.update_status(project_id, t1, "done")

    analytics = service.analytics(project_id)
    assert analytics["tasks_total"] == 2
    assert analytics["tasks_done"] == 1

    cloned = service.clone_project(project_id, new_name="Commerce UI Clone")
    assert cloned["id"] != project_id

    archived_meta = service.set_archived(project_id, True)
    assert archived_meta["archived"] is True
    archived = service.list_archived()
    assert any(p["id"] == project_id for p in archived)

    restored = service.restore_project(project_id)
    assert restored["id"] == project_id
    assert all(p["id"] != "missing" for p in archived)

    with pytest.raises(ValueError):
        service.get_metadata("missing")
    with pytest.raises(ValueError):
        service.readme_quality("missing")
    with pytest.raises(ValueError):
        service.analytics("missing")


def test_integration_service_helpers(monkeypatch, tmp_path):
    service = IntegrationService(str(tmp_path))

    assert service.infer_change_type_label("Fix flaky CI bug") == "fix"
    assert service.infer_change_type_label("Update README docs") == "docs"
    assert service.infer_change_type_label("Refactor lint rules") == "chore"
    assert service.infer_change_type_label("Add dashboard") == "feat"

    template = service.build_pr_template(
        title="Add onboarding",
        summary="Implements setup wizard",
        run_id="abc123",
        provider="openai",
    )
    assert "Run ID: `abc123`" in template
    assert "Provider: `openai`" in template

    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()
    sentinel_secret = "-----BEGIN " + "PRIVATE KEY-----"
    (repo_dir / "main.py").write_text(f"key = '{sentinel_secret}'\n", encoding="utf-8")
    scan = service.pre_push_secret_scan(str(repo_dir))
    assert scan["status"] == "ok"
    assert scan["clean"] is False
    assert scan["findings"]

    # Git command wrappers
    responses = {
        ("fetch", "--all", "--prune"): (True, "fetched"),
        ("status", "--short", "--branch"): (True, "## master"),
        ("pull", "--rebase", "origin", "master"): (False, "diverged"),
        ("fetch", "origin", "master"): (True, "ok"),
        ("rev-list", "--left-right", "--count", "HEAD...origin/master"): (True, "2 1"),
        ("revert", "--no-edit", "abc123"): (True, "reverted"),
        ("checkout", "-B", "feature/test", "origin/master"): (True, "switched"),
    }

    def fake_run_git(_repo_path, args):
        return responses.get(tuple(args), (False, "unknown"))

    monkeypatch.setattr(service, "_run_git", fake_run_git)

    branch = service.create_branch(str(repo_dir), base_branch="master", new_branch="feature/test")
    assert branch["status"] == "ok"

    sync = service.sync_remote(str(repo_dir), default_branch="master")
    assert sync["status"] == "warning"

    drift = service.detect_drift(str(repo_dir), default_branch="master")
    assert drift["status"] == "ok"
    assert drift["ahead"] == 2
    assert drift["behind"] == 1

    rollback = service.rollback_commit(str(repo_dir), "abc123")
    assert rollback["status"] == "ok"

    # GitHub API wrappers
    monkeypatch.setattr(
        IntegrationService,
        "_github_request",
        staticmethod(lambda *_args, **_kwargs: (200, [{"full_name": "owner/repo", "private": False, "default_branch": "main"}])),
    )
    repos = service.list_github_repos("token")
    assert repos["status"] == "ok"
    assert repos["repos"][0]["full_name"] == "owner/repo"

    monkeypatch.setattr(
        IntegrationService,
        "_github_request",
        staticmethod(lambda *_args, **_kwargs: (201, {"full_name": "owner/new", "default_branch": "main", "html_url": "x", "clone_url": "y"})),
    )
    created_repo = service.create_github_repo("token", name="new")
    assert created_repo["status"] == "ok"

    monkeypatch.setattr(
        IntegrationService,
        "_github_request",
        staticmethod(lambda *_args, **_kwargs: (401, {"message": "Unauthorized"})),
    )
    repo_err = service.list_github_repos("bad-token")
    assert repo_err["status"] == "error"

    # GitHub verify wrappers
    def fake_github_verify(_token, _method, path, _payload=None):
        if path == "/user":
            return (200, {"login": "test-user", "name": "Test User", "html_url": "https://github.com/test-user"})
        if path == "/repos/comp-a-a-s/compaas":
            return (200, {"full_name": "comp-a-a-s/compaas"})
        return (404, {"message": "Not Found"})

    monkeypatch.setattr(
        IntegrationService,
        "_github_request",
        staticmethod(fake_github_verify),
    )
    github_verified = service.github_verify_connection("token", repo="comp-a-a-s/compaas")
    assert github_verified["status"] == "ok"
    assert github_verified["ok"] is True
    assert github_verified["repo_ok"] is True
    assert github_verified["account"]["login"] == "test-user"

    github_missing_token = service.github_verify_connection("", repo="comp-a-a-s/compaas")
    assert github_missing_token["status"] == "error"
    assert github_missing_token["ok"] is False

    monkeypatch.setattr(
        IntegrationService,
        "_github_request",
        staticmethod(lambda *_args, **_kwargs: (0, {"message": "<urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed>"})),
    )
    github_ssl = service.github_verify_connection("token", repo="comp-a-a-s/compaas")
    assert github_ssl["status"] == "error"
    assert "secure connection" in github_ssl["message"].lower()

    # Vercel API wrappers
    monkeypatch.setattr(
        IntegrationService,
        "_vercel_request",
        staticmethod(lambda *_args, **_kwargs: (200, {"id": "prj_1"})),
    )
    assert service.vercel_link_project("token", name="my-app")["status"] == "ok"
    assert service.vercel_deploy("token", project_name="my-app", target="preview")["status"] == "ok"
    assert service.vercel_assign_domain("token", project_name="my-app", domain="example.com")["status"] == "ok"
    assert service.vercel_set_env("token", project_name="my-app", key="API_KEY", value="123")["status"] == "ok"

    monkeypatch.setattr(
        IntegrationService,
        "_vercel_request",
        staticmethod(lambda *_args, **_kwargs: (400, {"message": "Bad request"})),
    )
    assert service.vercel_link_project("token", name="my-app")["status"] == "error"

    # Vercel verify + deploy-from-saved wrappers
    def fake_vercel_verify(_token, _method, path, _payload=None):
        if path == "/v2/user":
            return (200, {"user": {"id": "usr_1", "username": "test-user", "email": ""}})
        if path == "/v9/projects/compaas?teamId=team_1":
            return (200, {"id": "prj_1", "name": "compaas"})
        if path.startswith("/v13/deployments"):
            return (200, {"url": "compaas-preview.vercel.app", "id": "dep_1"})
        return (404, {"error": {"message": "Not Found"}})

    monkeypatch.setattr(
        IntegrationService,
        "_vercel_request",
        staticmethod(fake_vercel_verify),
    )
    vercel_verified = service.vercel_verify_connection("token", project_name="compaas", team_id="team_1")
    assert vercel_verified["status"] == "ok"
    assert vercel_verified["ok"] is True
    assert vercel_verified["project_ok"] is True
    assert vercel_verified["account"]["username"] == "test-user"

    monkeypatch.setattr(
        IntegrationService,
        "_vercel_request",
        staticmethod(lambda *_args, **_kwargs: (0, {"message": "<urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed>"})),
    )
    vercel_ssl = service.vercel_verify_connection("token", project_name="compaas", team_id="team_1")
    assert vercel_ssl["status"] == "error"
    assert "secure connection" in vercel_ssl["message"].lower()

    monkeypatch.setattr(
        IntegrationService,
        "_vercel_request",
        staticmethod(fake_vercel_verify),
    )
    deploy_saved = service.vercel_deploy_saved(
        {
            "vercel_token": "token",
            "vercel_project_name": "compaas",
            "vercel_team_id": "team_1",
        },
        target="preview",
    )
    assert deploy_saved["status"] == "ok"
    assert deploy_saved["deployment_url"] == "https://compaas-preview.vercel.app"


def test_integration_service_repo_path_guard_allows_valid_repo(monkeypatch, tmp_path):
    workspace_root = tmp_path / "workspace"
    repo_dir = workspace_root / "demo-repo"
    repo_dir.mkdir(parents=True)
    (repo_dir / ".git").mkdir()

    service = IntegrationService(str(tmp_path), workspace_root=str(workspace_root))
    monkeypatch.setattr(
        IntegrationService,
        "_run_git",
        staticmethod(lambda _repo_path, _args: (True, "ok")),
    )

    result = service.sync_remote(str(repo_dir), default_branch="main")
    assert result["status"] == "ok"
    assert "fetch" in result


def test_integration_service_repo_path_guard_rejects_invalid_paths(tmp_path):
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir(parents=True)
    service = IntegrationService(str(tmp_path), workspace_root=str(workspace_root))

    outside = tmp_path / "outside-repo"
    outside.mkdir(parents=True)
    (outside / ".git").mkdir()
    blocked_outside = service.sync_remote(str(outside), default_branch="main")
    assert blocked_outside["status"] == "error"
    assert blocked_outside["code"] == "invalid_repo_path"

    non_repo = workspace_root / "plain-folder"
    non_repo.mkdir(parents=True)
    blocked_non_repo = service.sync_remote(str(non_repo), default_branch="main")
    assert blocked_non_repo["status"] == "error"
    assert blocked_non_repo["code"] == "invalid_repo_path"
