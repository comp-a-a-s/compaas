"""Best-effort helpers for rendering dynamic Claude agent templates."""

from __future__ import annotations

import os
from typing import Any

import yaml


def _default_project_root() -> str:
    """Resolve repository root from this module path."""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _load_config(project_root: str) -> dict[str, Any]:
    """Load runtime config used for dynamic agent names."""
    config_path = os.path.join(project_root, "company_data", "config.yaml")
    if not os.path.exists(config_path):
        return {}
    with open(config_path, "r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    return data if isinstance(data, dict) else {}


def _agent_defaults() -> dict[str, str]:
    """Read default agent names from the centralized registry."""
    try:
        from src.agents import AGENT_REGISTRY  # Imported lazily to avoid startup coupling.

        return {
            agent_id: str(info.get("name", agent_id))
            for agent_id, info in AGENT_REGISTRY.items()
            if isinstance(info, dict)
        }
    except Exception:
        return {}


def _variables(config: dict[str, Any]) -> dict[str, str]:
    defaults = _agent_defaults()
    user_agents = config.get("agents", {}) if isinstance(config.get("agents"), dict) else {}

    def agent_name(agent_id: str) -> str:
        candidate = str(user_agents.get(agent_id, "") or defaults.get(agent_id, "")).strip()
        return candidate or agent_id

    company = config.get("company", {}) if isinstance(config.get("company"), dict) else {}
    user = config.get("user", {}) if isinstance(config.get("user"), dict) else {}

    return {
        "COMPANY_NAME": str(company.get("name", "") or "").strip() or "COMPaaS",
        "BOARD_HEAD": str(user.get("name", "") or "").strip() or "User",
        "CEO_NAME": agent_name("ceo"),
        "CTO_NAME": agent_name("cto"),
        "RESEARCHER_NAME": agent_name("chief-researcher"),
        "CISO_NAME": agent_name("ciso"),
        "CFO_NAME": agent_name("cfo"),
        "VP_PRODUCT_NAME": agent_name("vp-product"),
        "VP_ENG_NAME": agent_name("vp-engineering"),
        "BACKEND_NAME": agent_name("lead-backend"),
        "FRONTEND_NAME": agent_name("lead-frontend"),
        "DESIGNER_NAME": agent_name("lead-designer"),
        "QA_NAME": agent_name("qa-lead"),
        "DEVOPS_NAME": agent_name("devops"),
        "SECURITY_NAME": agent_name("security-engineer"),
        "DATA_NAME": agent_name("data-engineer"),
        "WRITER_NAME": agent_name("tech-writer"),
    }


def render_agent_templates(project_root: str | None = None) -> int:
    """Render .claude/agent-templates into .claude/agents and return file count."""
    root = os.path.abspath(project_root or _default_project_root())
    template_dir = os.path.join(root, ".claude", "agent-templates")
    output_dir = os.path.join(root, ".claude", "agents")
    if not os.path.isdir(template_dir):
        return 0

    os.makedirs(output_dir, exist_ok=True)
    values = _variables(_load_config(root))
    rendered = 0

    for filename in sorted(os.listdir(template_dir)):
        if not filename.endswith(".md"):
            continue
        template_path = os.path.join(template_dir, filename)
        output_path = os.path.join(output_dir, filename)
        with open(template_path, "r", encoding="utf-8") as handle:
            content = handle.read()
        for key, value in values.items():
            content = content.replace("{{" + key + "}}", value)
        with open(output_path, "w", encoding="utf-8") as handle:
            handle.write(content)
        rendered += 1

    return rendered
