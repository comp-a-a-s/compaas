"""RFC 9457 Problem Details helpers."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse


PROBLEM_JSON = "application/problem+json"
PROBLEM_ACTION_KINDS = {"retry", "open_settings", "open_project", "copy", "link", "view_events", "run_control"}


def problem_action(
    *,
    action_id: str,
    label: str,
    kind: str,
    target: str = "",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a normalized user-guidance action payload."""
    normalized_kind = str(kind or "").strip().lower()
    if normalized_kind not in PROBLEM_ACTION_KINDS:
        normalized_kind = "retry"
    action: dict[str, Any] = {
        "id": str(action_id or "action").strip() or "action",
        "label": str(label or "Retry").strip() or "Retry",
        "kind": normalized_kind,
    }
    if target:
        action["target"] = str(target).strip()
    if isinstance(payload, dict) and payload:
        action["payload"] = payload
    return action


def problem_response(
    *,
    status: int,
    title: str,
    detail: str,
    type_: str = "about:blank",
    instance: str | None = None,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    """Create an RFC 9457 compatible problem response payload."""
    payload: dict[str, Any] = {
        "type": type_,
        "title": title,
        "status": status,
        "detail": detail,
    }
    if instance:
        payload["instance"] = instance
    if extra:
        payload.update(extra)
    return JSONResponse(status_code=status, content=payload, media_type=PROBLEM_JSON)


def problem_http_exception(
    *,
    status: int,
    title: str,
    detail: str,
    type_: str = "about:blank",
    instance: str | None = None,
    extra: dict[str, Any] | None = None,
) -> HTTPException:
    """Raise an HTTPException whose detail already follows problem format."""
    payload: dict[str, Any] = {
        "type": type_,
        "title": title,
        "status": status,
        "detail": detail,
    }
    if instance:
        payload["instance"] = instance
    if extra:
        payload.update(extra)
    return HTTPException(status_code=status, detail=payload)


def problem_with_actions(
    *,
    status: int,
    title: str,
    detail: str,
    type_: str = "about:blank",
    instance: str | None = None,
    code: str = "",
    correlation_id: str = "",
    actions: list[dict[str, Any]] | None = None,
    action_required: bool | None = None,
    extra: dict[str, Any] | None = None,
) -> HTTPException:
    """Build problem-style HTTPException with optional remediation actions."""
    merged_extra: dict[str, Any] = dict(extra or {})
    normalized_code = str(code or "").strip()
    normalized_correlation_id = str(correlation_id or "").strip()
    normalized_actions = [row for row in (actions or []) if isinstance(row, dict)]
    if normalized_code:
        merged_extra["code"] = normalized_code
    if normalized_correlation_id:
        merged_extra["correlation_id"] = normalized_correlation_id
    if normalized_actions:
        merged_extra["actions"] = normalized_actions
    if action_required is None:
        merged_extra["action_required"] = bool(normalized_actions)
    else:
        merged_extra["action_required"] = bool(action_required)
    return problem_http_exception(
        status=status,
        title=title,
        detail=detail,
        type_=type_,
        instance=instance,
        extra=merged_extra,
    )
