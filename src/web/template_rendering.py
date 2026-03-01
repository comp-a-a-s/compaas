"""Best-effort helpers for rendering dynamic Claude agent templates."""

from __future__ import annotations

import importlib.util
import os
from typing import Any, Callable


def _default_project_root() -> str:
    """Resolve repository root from this module path."""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _load_renderer_from_path(script_path: str) -> Callable[[str | None], Any]:
    """Load scripts/render_agents.py without requiring `scripts` on sys.path."""
    spec = importlib.util.spec_from_file_location("compaas_render_agents", script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not create import spec for {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    render_templates = getattr(module, "render_templates", None)
    if not callable(render_templates):
        raise AttributeError("render_templates function not found in scripts/render_agents.py")
    return render_templates


def _resolve_renderer(project_root: str) -> Callable[[str | None], Any]:
    """Resolve render_templates() either via import or direct file load."""
    try:
        from scripts.render_agents import render_templates  # type: ignore

        return render_templates
    except Exception:
        script_path = os.path.join(project_root, "scripts", "render_agents.py")
        if not os.path.isfile(script_path):
            raise ModuleNotFoundError("scripts/render_agents.py was not found")
        return _load_renderer_from_path(script_path)


def render_agent_templates(project_root: str | None = None) -> int:
    """Render .claude/agent-templates into .claude/agents and return file count."""
    root = os.path.abspath(project_root or _default_project_root())
    renderer = _resolve_renderer(root)
    count = renderer(root)
    try:
        return int(count or 0)
    except Exception:
        return 0

