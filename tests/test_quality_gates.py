"""Quality gate and scoring tests for AAA outcome mode."""

from __future__ import annotations

import src.web.api as api


def test_quality_profile_defaults():
    profile = api._quality_profile({})
    assert profile["mode"] == "aaa_quality_visual"
    assert profile["auto_refinement_enabled"] is True
    assert profile["auto_refinement_max_passes"] == 1
    assert profile["validation_required_for_done"] is True
    assert profile["code_quality_min"] >= 40
    assert profile["ux_quality_min"] >= 40
    assert profile["visual_distinctiveness_min"] >= 40


def test_quality_report_passes_when_all_delivery_signals_present():
    profile = api._quality_profile(
        {
            "quality": {
                "code_quality_min": 60,
                "ux_quality_min": 60,
                "visual_distinctiveness_min": 55,
                "validation_required_for_done": True,
            }
        }
    )
    report, gates = api._quality_report_payload(
        {
            "summary": "Build complete for a finance audience with a clear dashboard workflow.",
            "run_commands": ["npm ci", "npm run dev", "npm run test"],
            "open_links": [{"label": "Local app", "target": "http://localhost:5173", "kind": "url"}],
            "deliverables": [{"label": "Workspace", "target": "/Users/idan/compaas/projects/demo", "kind": "path"}],
            "validation": ["npm run test passed", "lint passed"],
            "next_actions": ["Launch app and verify onboarding"],
        },
        response_text=(
            "Purpose-driven UI for small business audience with typography, color palette, "
            "motion, and strong visual hierarchy."
        ),
        profile=profile,
    )
    assert gates["blocked"] == []
    assert report["validation_passed"] is True
    assert report["failed_gates"] == []


def test_quality_report_fails_thresholds_when_visual_and_ux_are_generic():
    profile = api._quality_profile(
        {
            "quality": {
                "code_quality_min": 80,
                "ux_quality_min": 80,
                "visual_distinctiveness_min": 80,
                "validation_required_for_done": True,
            }
        }
    )
    report, gates = api._quality_report_payload(
        {
            "summary": "Done.",
            "run_commands": ["npm run dev"],
            "open_links": [{"label": "Local app", "target": "http://localhost:5173", "kind": "url"}],
            "deliverables": [{"label": "Workspace", "target": "/Users/idan/compaas/projects/demo", "kind": "path"}],
            "validation": ["smoke pass"],
            "next_actions": [],
        },
        response_text="Simple template output.",
        profile=profile,
    )
    assert gates["blocked"] == []
    assert "ux_quality_below_threshold" in report["failed_gates"]
    assert "visual_distinctiveness_below_threshold" in report["failed_gates"]
