"""Shared connector state transitions and health normalization."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

CONNECTOR_STATES = {"disconnected", "configured", "verified", "degraded"}
CONNECTORS_WITH_HEALTH = (
    "github",
    "vercel",
    "netlify",
    "stripe",
    "telegram",
    "slack",
    "linear",
    "notion",
    "jira",
    "gitlab",
)


def normalize_connector_state(value: Any) -> str:
    """Normalize persisted connector lifecycle values."""
    raw = str(value or "").strip().lower()
    if raw in CONNECTOR_STATES:
        return raw
    return "disconnected"


def connector_health_row(integrations: dict[str, Any], connector: str) -> dict[str, Any]:
    """Return normalized connector health metadata row."""
    status = normalize_connector_state(integrations.get(f"{connector}_status", "disconnected"))
    verified = bool(integrations.get(f"{connector}_verified"))
    if status == "verified":
        verified = True
    elif status in {"configured", "degraded", "disconnected"}:
        verified = False
    return {
        "status": status,
        "verified": verified,
        "verified_at": str(integrations.get(f"{connector}_verified_at", "") or "").strip(),
        "last_success_at": str(integrations.get(f"{connector}_last_success_at", "") or "").strip(),
        "last_error": str(integrations.get(f"{connector}_last_error", "") or "").strip(),
        "consecutive_failures": int(integrations.get(f"{connector}_consecutive_failures", 0) or 0),
    }


def set_connector_health(
    integrations: dict[str, Any],
    connector: str,
    *,
    configured: bool,
    verified: bool,
    error_message: str = "",
    verified_at: str = "",
    bump_failures: bool = True,
    allow_verify_promotion: bool = True,
    record_success_without_verify: bool = False,
) -> None:
    """Apply compat-sync connector state update atomically.

    Compat-sync means `*_status` and legacy `*_verified` stay aligned:
    - status `verified` <=> `*_verified == True`
    - status `configured/degraded/disconnected` => `*_verified == False`
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    error_text = str(error_message or "").strip()

    status_key = f"{connector}_status"
    verified_key = f"{connector}_verified"
    verified_at_key = f"{connector}_verified_at"
    last_success_key = f"{connector}_last_success_at"
    last_error_key = f"{connector}_last_error"
    failures_key = f"{connector}_consecutive_failures"

    if verified and configured and allow_verify_promotion:
        integrations[status_key] = "verified"
        integrations[verified_key] = True
        integrations[verified_at_key] = str(verified_at or integrations.get(verified_at_key, "") or now_iso).strip() or now_iso
        integrations[last_success_key] = now_iso
        integrations[last_error_key] = ""
        integrations[failures_key] = 0
        return

    if not configured:
        integrations[status_key] = "disconnected"
        integrations[verified_key] = False
        integrations[last_error_key] = ""
        integrations[failures_key] = 0
        return

    integrations[status_key] = "degraded" if error_text else "configured"
    integrations[verified_key] = False

    if record_success_without_verify and not error_text:
        integrations[last_success_key] = now_iso
        integrations[last_error_key] = ""
        integrations[failures_key] = 0
        return

    integrations[last_error_key] = error_text
    previous = int(integrations.get(failures_key, 0) or 0)
    if error_text and bump_failures:
        integrations[failures_key] = previous + 1
    elif not error_text:
        integrations[failures_key] = 0
    else:
        integrations[failures_key] = previous
