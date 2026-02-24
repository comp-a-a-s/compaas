"""Render agent templates with dynamic names from user config.

Reads user-selected names from company_data/config.yaml (set by SetupWizard
and Settings panel). Falls back to defaults from src/agents.py AGENT_REGISTRY.

Template files in .claude/agent-templates/*.md use {{PLACEHOLDER}} syntax.
Rendered output goes to .claude/agents/*.md (consumed by Claude Code CLI).
"""

import os
import sys
import yaml


def _find_project_root() -> str:
    """Find project root by walking up from this script's location."""
    current = os.path.dirname(os.path.abspath(__file__))
    while current != os.path.dirname(current):
        if os.path.isdir(os.path.join(current, ".claude")):
            return current
        current = os.path.dirname(current)
    return os.path.dirname(os.path.abspath(__file__))


def _load_config(project_root: str) -> dict:
    """Load user config from company_data/config.yaml."""
    config_path = os.path.join(project_root, "company_data", "config.yaml")
    if not os.path.exists(config_path):
        return {}
    with open(config_path) as f:
        return yaml.safe_load(f) or {}


def _get_agent_defaults() -> dict[str, str]:
    """Get default agent names from the centralized registry."""
    # Import here to avoid issues when called from different contexts
    sys.path.insert(0, _find_project_root())
    from src.agents import AGENT_REGISTRY
    return {agent_id: info["name"] for agent_id, info in AGENT_REGISTRY.items()}


def _build_variables(config: dict) -> dict[str, str]:
    """Build template variable dict from user config with registry fallbacks."""
    agent_defaults = _get_agent_defaults()
    user_agents = config.get("agents", {}) if isinstance(config.get("agents"), dict) else {}

    def agent_name(agent_id: str) -> str:
        return str(user_agents.get(agent_id, "") or agent_defaults.get(agent_id, "")).strip() or agent_id

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


def render_templates(project_root: str | None = None) -> int:
    """Render all agent templates to .claude/agents/.

    Returns the number of files rendered.
    """
    if project_root is None:
        project_root = _find_project_root()

    template_dir = os.path.join(project_root, ".claude", "agent-templates")
    output_dir = os.path.join(project_root, ".claude", "agents")

    if not os.path.isdir(template_dir):
        return 0

    config = _load_config(project_root)
    variables = _build_variables(config)

    os.makedirs(output_dir, exist_ok=True)
    count = 0

    for filename in sorted(os.listdir(template_dir)):
        if not filename.endswith(".md"):
            continue
        template_path = os.path.join(template_dir, filename)
        output_path = os.path.join(output_dir, filename)

        with open(template_path) as f:
            content = f.read()

        for key, value in variables.items():
            content = content.replace("{{" + key + "}}", value)

        with open(output_path, "w") as f:
            f.write(content)
        count += 1

    return count


if __name__ == "__main__":
    root = _find_project_root()
    rendered = render_templates(root)
    print(f"Rendered {rendered} agent template(s) from .claude/agent-templates/ → .claude/agents/")
