"""Unit tests for canonical live workforce presence state."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.web.services.run_service import RunService
from src.web.services.workforce_presence import WorkforcePresenceService
from src.web.settings import RuntimeSettings


def _make_service(tmp_path: Path) -> tuple[WorkforcePresenceService, RunService, str]:
    data_dir = str(tmp_path / "company_data")
    (tmp_path / "company_data" / "projects").mkdir(parents=True, exist_ok=True)
    settings = RuntimeSettings(data_dir=data_dir, project_root=str(tmp_path), workspace_root=str(tmp_path / "workspace"))
    run_service = RunService(data_dir, settings)
    service = WorkforcePresenceService(data_dir, run_service=run_service)
    return service, run_service, data_dir


def _event(
    *,
    at: datetime,
    agent: str,
    action: str,
    project_id: str,
    run_id: str,
    work_item_id: str,
    work_state: str,
    source: str = "real",
    source_agent: str = "",
    target_agent: str = "",
    flow: str = "internal",
    detail: str = "",
    task: str = "",
) -> dict:
    metadata = {
        "run_id": run_id,
        "work_item_id": work_item_id,
        "work_state": work_state,
        "source": source,
        "source_agent": source_agent,
        "target_agent": target_agent,
        "flow": flow,
        "task": task or detail,
    }
    return {
        "timestamp": at.isoformat(),
        "agent": agent,
        "action": action,
        "detail": detail,
        "project_id": project_id,
        "metadata": metadata,
    }


def test_presence_state_machine_assigned_to_working_reporting_then_clears(tmp_path: Path) -> None:
    service, _run_service, _data_dir = _make_service(tmp_path)
    now = datetime.now(timezone.utc)
    work_item_id = "run-1:lead-frontend"

    service.ingest_event(
        _event(
            at=now,
            agent="ceo",
            action="DELEGATED",
            project_id="proj-a",
            run_id="run-1",
            work_item_id=work_item_id,
            work_state="assigned",
            source_agent="ceo",
            target_agent="lead-frontend",
            flow="down",
            detail="Implement form validation",
        )
    )
    assigned = service.snapshot(project_id="proj-a")
    assert assigned["counts"]["assigned"] == 1
    assert assigned["counts"]["working"] == 0

    service.ingest_event(
        _event(
            at=now + timedelta(seconds=2),
            agent="lead-frontend",
            action="STARTED",
            project_id="proj-a",
            run_id="run-1",
            work_item_id=work_item_id,
            work_state="working",
            source_agent="lead-frontend",
            target_agent="lead-frontend",
            flow="internal",
            detail="Implement form validation",
        )
    )
    working = service.snapshot(project_id="proj-a")
    assert working["counts"]["working"] == 1
    assert working["counts"]["assigned"] == 0

    service.ingest_event(
        _event(
            at=now + timedelta(seconds=4),
            agent="lead-frontend",
            action="UPDATED",
            project_id="proj-a",
            run_id="run-1",
            work_item_id=work_item_id,
            work_state="reporting",
            source_agent="lead-frontend",
            target_agent="ceo",
            flow="up",
            detail="PR ready for review",
        )
    )
    reporting = service.snapshot(project_id="proj-a")
    assert reporting["counts"]["reporting"] == 1
    assert reporting["counts"]["working"] == 0

    service.ingest_event(
        _event(
            at=now + timedelta(seconds=6),
            agent="lead-frontend",
            action="COMPLETED",
            project_id="proj-a",
            run_id="run-1",
            work_item_id=work_item_id,
            work_state="completed",
            source_agent="lead-frontend",
            target_agent="ceo",
            flow="up",
            detail="Done",
        )
    )
    done = service.snapshot(project_id="proj-a")
    assert done["counts"] == {"assigned": 0, "working": 0, "reporting": 0, "blocked": 0}
    assert done["workers"] == []


def test_presence_ingestion_is_idempotent_for_duplicate_events(tmp_path: Path) -> None:
    service, _run_service, _data_dir = _make_service(tmp_path)
    now = datetime.now(timezone.utc)
    event = _event(
        at=now,
        agent="ceo",
        action="DELEGATED",
        project_id="proj-a",
        run_id="run-2",
        work_item_id="run-2:lead-backend",
        work_state="assigned",
        source_agent="ceo",
        target_agent="lead-backend",
        flow="down",
        detail="Implement API endpoint",
    )

    service.ingest_event(event)
    service.ingest_event(event)
    snap = service.snapshot(project_id="proj-a")
    assert snap["counts"]["assigned"] == 1
    assert len(snap["workers"]) == 1


def test_synthetic_events_never_promote_worker_to_working(tmp_path: Path) -> None:
    service, _run_service, _data_dir = _make_service(tmp_path)
    now = datetime.now(timezone.utc)

    service.ingest_event(
        _event(
            at=now,
            agent="ceo",
            action="DELEGATED",
            project_id="proj-synth",
            run_id="run-synth",
            work_item_id="run-synth:qa-lead",
            work_state="assigned",
            source="synthetic",
            source_agent="ceo",
            target_agent="qa-lead",
            flow="down",
            detail="Run QA pass",
        )
    )
    # Even if legacy payload marks it as "working", synthetic evidence stays assigned.
    service.ingest_event(
        _event(
            at=now + timedelta(seconds=1),
            agent="qa-lead",
            action="STARTED",
            project_id="proj-synth",
            run_id="run-synth",
            work_item_id="run-synth:qa-lead",
            work_state="working",
            source="synthetic",
            source_agent="qa-lead",
            target_agent="qa-lead",
            flow="internal",
            detail="Run QA pass",
        )
    )

    snap = service.snapshot(project_id="proj-synth")
    assert snap["counts"]["working"] == 0
    assert snap["counts"]["assigned"] == 1
    assert snap["workers"][0]["state"] == "assigned"


def test_terminal_run_clears_non_blocked_items_immediately(tmp_path: Path) -> None:
    service, _run_service, _data_dir = _make_service(tmp_path)
    now = datetime.now(timezone.utc)

    service.ingest_event(
        _event(
            at=now,
            agent="lead-backend",
            action="STARTED",
            project_id="proj-a",
            run_id="run-3",
            work_item_id="run-3:lead-backend",
            work_state="working",
            source_agent="lead-backend",
            target_agent="lead-backend",
            flow="internal",
            detail="Implement API",
        )
    )
    service.ingest_event(
        _event(
            at=now + timedelta(seconds=1),
            agent="qa-lead",
            action="FAILED",
            project_id="proj-a",
            run_id="run-3",
            work_item_id="run-3:qa-lead",
            work_state="blocked",
            source_agent="qa-lead",
            target_agent="ceo",
            flow="failed",
            detail="Test env unavailable",
        )
    )

    service.mark_run_terminal("run-3", project_id="proj-a", terminal_state="done")
    snap = service.snapshot(project_id="proj-a")
    assert snap["counts"]["working"] == 0
    assert snap["counts"]["assigned"] == 0
    assert snap["counts"]["reporting"] == 0
    assert snap["counts"]["blocked"] == 1
    assert snap["workers"][0]["agent_id"] == "qa-lead"


def test_snapshot_filters_project_and_visibility_flags(tmp_path: Path) -> None:
    service, _run_service, _data_dir = _make_service(tmp_path)
    now = datetime.now(timezone.utc)

    service.ingest_event(
        _event(
            at=now,
            agent="ceo",
            action="DELEGATED",
            project_id="proj-a",
            run_id="run-a",
            work_item_id="run-a:lead-frontend",
            work_state="assigned",
            source_agent="ceo",
            target_agent="lead-frontend",
            flow="down",
            detail="Design UI",
        )
    )
    service.ingest_event(
        _event(
            at=now + timedelta(seconds=1),
            agent="lead-frontend",
            action="UPDATED",
            project_id="proj-b",
            run_id="run-b",
            work_item_id="run-b:lead-frontend",
            work_state="reporting",
            source_agent="lead-frontend",
            target_agent="ceo",
            flow="up",
            detail="Reporting progress",
        )
    )

    proj_a = service.snapshot(project_id="proj-a")
    assert len(proj_a["workers"]) == 1
    assert proj_a["workers"][0]["project_id"] == "proj-a"

    proj_b_hidden = service.snapshot(project_id="proj-b", include_reporting=False)
    assert proj_b_hidden["workers"] == []
    assert proj_b_hidden["counts"]["reporting"] == 0

    no_assigned = service.snapshot(include_assigned=False)
    assert all(worker["state"] != "assigned" for worker in no_assigned["workers"])


def test_rebuild_restores_state_from_activity_log_and_prunes_terminal_runs(tmp_path: Path) -> None:
    service, _run_service, data_dir = _make_service(tmp_path)
    now = datetime.now(timezone.utc)
    log_path = Path(data_dir) / "activity.log"

    events = [
        _event(
            at=now,
            agent="ceo",
            action="DELEGATED",
            project_id="proj-a",
            run_id="run-live",
            work_item_id="run-live:lead-backend",
            work_state="assigned",
            source_agent="ceo",
            target_agent="lead-backend",
            flow="down",
            detail="Build API",
        ),
        _event(
            at=now + timedelta(seconds=1),
            agent="lead-backend",
            action="STARTED",
            project_id="proj-a",
            run_id="run-live",
            work_item_id="run-live:lead-backend",
            work_state="working",
            source_agent="lead-backend",
            target_agent="lead-backend",
            flow="internal",
            detail="Build API",
        ),
        _event(
            at=now + timedelta(seconds=2),
            agent="ceo",
            action="DELEGATED",
            project_id="proj-a",
            run_id="run-done",
            work_item_id="run-done:qa-lead",
            work_state="assigned",
            source_agent="ceo",
            target_agent="qa-lead",
            flow="down",
            detail="Run tests",
        ),
    ]

    with open(log_path, "w", encoding="utf-8") as f:
        for row in events:
            f.write(json.dumps(row) + "\n")

    service.rebuild_from_activity_log_and_runs(
        activity_log_path=str(log_path),
        runs=[
            {"id": "run-done", "project_id": "proj-a", "status": "done"},
            {"id": "run-live", "project_id": "proj-a", "status": "executing"},
        ],
    )

    snap = service.snapshot(project_id="proj-a")
    worker_ids = {worker["work_item_id"] for worker in snap["workers"]}
    assert "run-live:lead-backend" in worker_ids
    assert "run-done:qa-lead" not in worker_ids
