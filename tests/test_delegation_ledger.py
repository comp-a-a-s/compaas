"""Unit tests for delegation evidence ledger service."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.web.services.delegation_ledger import DelegationLedgerService


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


def test_project_lanes_mark_synthetic_evidence_as_planned(tmp_path: Path) -> None:
    data_dir = str(tmp_path / "company_data")
    service = DelegationLedgerService(data_dir)
    now = datetime.now(timezone.utc)

    service.ingest_event(
        _event(
            at=now,
            agent="ceo",
            action="DELEGATED",
            project_id="proj-a",
            run_id="run-a",
            work_item_id="run-a:qa-lead",
            work_state="assigned",
            source="synthetic",
            source_agent="ceo",
            target_agent="qa-lead",
            flow="down",
            detail="Run QA pass",
        )
    )

    lanes = service.project_lanes("proj-a")
    assert len(lanes) == 1
    assert lanes[0]["status"] == "todo"
    assert lanes[0]["source"] == "synthetic"
    assert lanes[0]["evidence_level"] == "planned"


def test_real_evidence_overrides_synthetic_lane_for_same_owner(tmp_path: Path) -> None:
    data_dir = str(tmp_path / "company_data")
    service = DelegationLedgerService(data_dir)
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
            source="synthetic",
            source_agent="ceo",
            target_agent="lead-frontend",
            flow="down",
            detail="Implement shell",
        )
    )
    service.ingest_event(
        _event(
            at=now + timedelta(seconds=2),
            agent="lead-frontend",
            action="STARTED",
            project_id="proj-a",
            run_id="run-a",
            work_item_id="run-a:lead-frontend",
            work_state="working",
            source="real",
            source_agent="lead-frontend",
            target_agent="lead-frontend",
            flow="internal",
            detail="Build dashboard shell",
        )
    )

    lanes = service.project_lanes("proj-a")
    assert len(lanes) == 1
    assert lanes[0]["status"] == "in_progress"
    assert lanes[0]["source"] == "real"
    assert lanes[0]["evidence_level"] == "observed"
    assert "dashboard shell" in lanes[0]["headline"].lower()
