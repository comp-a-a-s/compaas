"""Guarded autopilot policy checks for run-control transitions."""

from __future__ import annotations

import re
from typing import Any


_RISKY_COMMAND_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\brm\s+-rf\b", re.IGNORECASE),
    re.compile(r"\b(drop|truncate)\s+table\b", re.IGNORECASE),
    re.compile(r"\b(drop)\s+database\b", re.IGNORECASE),
    re.compile(r"\bterraform\s+apply\b", re.IGNORECASE),
    re.compile(r"\bkubectl\s+delete\b", re.IGNORECASE),
    re.compile(r"\bvercel\s+deploy\s+--prod\b", re.IGNORECASE),
)


def _runtime_usage_percent(guardrails: dict[str, Any]) -> float:
    remaining = guardrails.get("runtime_budget_remaining", 0)
    elapsed = guardrails.get("elapsed_seconds", 0)
    try:
        remaining_val = float(remaining or 0)
        elapsed_val = float(elapsed or 0)
    except (TypeError, ValueError):
        return 0.0
    total = remaining_val + elapsed_val
    if total <= 0:
        return 0.0
    return max(0.0, min(100.0, (elapsed_val / total) * 100.0))


def _extract_transition_text(label: str, metadata: dict[str, Any] | None) -> str:
    parts = [str(label or "").strip()]
    if isinstance(metadata, dict):
        for key in ("command", "step", "task", "reason"):
            value = str(metadata.get(key, "") or "").strip()
            if value:
                parts.append(value)
    return " | ".join([part for part in parts if part])


def evaluate_guarded_autopilot(
    *,
    guardrails: dict[str, Any] | None = None,
    transition_label: str = "",
    transition_metadata: dict[str, Any] | None = None,
    runtime_risk_threshold_pct: int = 80,
) -> dict[str, Any]:
    """Return guarded-autopilot decision for a requested transition."""
    normalized_guardrails = guardrails if isinstance(guardrails, dict) else {}
    reasons: list[str] = []

    if bool(normalized_guardrails.get("over_budget", False)):
        reasons.append("Run guardrail budget is already over limit.")

    usage_pct = _runtime_usage_percent(normalized_guardrails)
    if usage_pct >= max(1, int(runtime_risk_threshold_pct)):
        reasons.append(f"Runtime budget usage is high ({usage_pct:.0f}%).")

    transition_text = _extract_transition_text(transition_label, transition_metadata)
    if transition_text:
        for pattern in _RISKY_COMMAND_PATTERNS:
            if pattern.search(transition_text):
                reasons.append("Transition appears to include a risky/destructive operation.")
                break

    return {
        "mode": "guarded_autopilot",
        "requires_confirmation": bool(reasons),
        "reasons": reasons,
        "runtime_usage_percent": round(usage_pct, 1),
    }

