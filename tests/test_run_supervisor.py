"""Unit tests for run supervisor normalization and watchdog rules."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.web.services.run_supervisor import build_run_status_payload, detect_run_incident


def _iso_seconds_ago(seconds: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


def test_build_run_status_payload_collects_active_agents_for_run():
    run = {
        "id": "run-123",
        "project_id": "proj-1",
        "status": "executing",
        "updated_at": _iso_seconds_ago(4),
        "timeline": [{"label": "Executing build pipeline"}],
    }
    guardrails = {
        "elapsed_seconds": 34,
        "command_budget_remaining": 11,
        "file_budget_remaining": 19,
        "runtime_budget_remaining": 812,
        "over_budget": False,
    }
    workforce_snapshot = {
        "workers": [
            {
                "run_id": "run-123",
                "agent_id": "lead-frontend",
                "agent_name": "Lead Frontend",
                "state": "working",
                "task": "Building dashboard widgets",
            },
            {
                "run_id": "other",
                "agent_id": "lead-backend",
                "agent_name": "Lead Backend",
                "state": "working",
            },
        ]
    }

    payload = build_run_status_payload(
        run,
        guardrails=guardrails,
        workforce_snapshot=workforce_snapshot,
        heartbeat_seq=7,
    )

    assert payload["run_id"] == "run-123"
    assert payload["state"] == "executing"
    assert payload["phase_label"] == "Executing build pipeline"
    assert payload["elapsed_seconds"] == 34
    assert payload["heartbeat_seq"] == 7
    assert len(payload["active_agents"]) == 1
    assert payload["active_agents"][0]["agent_id"] == "lead-frontend"
    assert payload["guardrails"]["command_budget_remaining"] == 11


def test_detect_run_incident_warns_and_escalates():
    run_status = {
        "run_id": "run-stall",
        "state": "executing",
        "last_activity_at": _iso_seconds_ago(130),
        "guardrails": {"over_budget": False},
    }
    warning = detect_run_incident(run_status, warning_seconds=90, critical_seconds=180)
    assert warning is not None
    assert warning["severity"] == "warning"
    assert warning["reason"] == "silent_run"

    critical_status = dict(run_status)
    critical_status["last_activity_at"] = _iso_seconds_ago(210)
    critical = detect_run_incident(critical_status, warning_seconds=90, critical_seconds=180)
    assert critical is not None
    assert critical["severity"] == "critical"
    assert critical["reason"] in {"silent_run", "provider_stall"}


def test_detect_run_incident_prefers_guardrail_risk():
    run_status = {
        "run_id": "run-budget",
        "state": "executing",
        "last_activity_at": _iso_seconds_ago(120),
        "guardrails": {"over_budget": True},
    }
    incident = detect_run_incident(run_status, warning_seconds=90, critical_seconds=180)
    assert incident is not None
    assert incident["reason"] == "guardrail_risk"

