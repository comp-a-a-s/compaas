"""RFC 9457 Problem Details helpers."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse


PROBLEM_JSON = "application/problem+json"


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
