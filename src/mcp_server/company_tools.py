"""MCP tools for company operations — org chart, hiring, roster."""

import os
import yaml
from datetime import datetime, timezone
from fastmcp import FastMCP

CORE_TEAM = {
    "cto": {"role": "Chief Technology Officer", "status": "permanent", "model": "opus"},
    "vp-product": {"role": "VP of Product", "status": "permanent", "model": "sonnet"},
    "vp-engineering": {"role": "VP of Engineering", "status": "permanent", "model": "sonnet"},
    "lead-backend": {"role": "Lead Backend Engineer", "status": "permanent", "model": "sonnet"},
    "lead-frontend": {"role": "Lead Frontend Engineer", "status": "permanent", "model": "sonnet"},
    "lead-designer": {"role": "Lead UI/UX Designer", "status": "permanent", "model": "sonnet"},
    "qa-lead": {"role": "QA Lead", "status": "permanent", "model": "sonnet"},
    "devops": {"role": "DevOps Engineer", "status": "permanent", "model": "sonnet"},
}

ON_DEMAND_TEAM = {
    "security-engineer": {"role": "Security Engineer", "status": "available", "model": "opus"},
    "data-engineer": {"role": "Data Engineer", "status": "available", "model": "sonnet"},
    "tech-writer": {"role": "Technical Writer", "status": "available", "model": "haiku"},
}


def register_company_tools(mcp: FastMCP, data_dir: str) -> None:
    hiring_log_path = os.path.join(data_dir, "hiring_log.yaml")

    def _load_hiring_log() -> dict:
        if not os.path.exists(hiring_log_path):
            return {"hired": []}
        with open(hiring_log_path) as f:
            return yaml.safe_load(f) or {"hired": []}

    def _save_hiring_log(log: dict) -> None:
        os.makedirs(os.path.dirname(hiring_log_path), exist_ok=True)
        with open(hiring_log_path, "w") as f:
            yaml.dump(log, f, default_flow_style=False)

    @mcp.tool
    def get_org_chart() -> str:
        """Get the current organization chart with all agents and their roles."""
        org = {
            "board_head": "User (Board Head — you report to them)",
            "ceo": "CEO (You — Central Orchestrator)",
            "leadership": {
                name: info for name, info in CORE_TEAM.items()
                if name.startswith("cto") or name.startswith("vp-")
            },
            "engineering": {
                name: info for name, info in CORE_TEAM.items()
                if name.startswith("lead-") or name in ("qa-lead", "devops")
            },
            "on_demand_specialists": ON_DEMAND_TEAM,
        }

        log = _load_hiring_log()
        if log["hired"]:
            org["dynamically_hired"] = [
                {"name": h["name"], "role": h["role"], "status": h.get("status", "active")}
                for h in log["hired"]
            ]

        return yaml.dump(org, default_flow_style=False)

    @mcp.tool
    def get_roster() -> str:
        """Get the complete list of all available agents with capabilities."""
        roster = {"core_team": CORE_TEAM, "on_demand": ON_DEMAND_TEAM}
        log = _load_hiring_log()
        if log["hired"]:
            roster["dynamically_hired"] = log["hired"]
        return yaml.dump(roster, default_flow_style=False)

    @mcp.tool
    def hire_agent(
        name: str,
        role: str,
        expertise: str,
        tools: str = "Read,Glob,Grep,Write",
        model: str = "sonnet",
    ) -> str:
        """Hire a new specialist agent dynamically.

        This creates a record in the hiring log. The CEO should also create
        a .claude/agents/{name}.md file so the agent is available as a subagent.

        Args:
            name: Agent identifier (lowercase, hyphens, e.g., 'ml-engineer').
            role: Human-readable role title (e.g., 'Machine Learning Engineer').
            expertise: Description of the agent's expertise and when to use them.
            tools: Comma-separated list of tools the agent needs.
            model: Model to use — sonnet, opus, or haiku.
        """
        log = _load_hiring_log()

        # Check if already hired
        for h in log["hired"]:
            if h["name"] == name:
                return f"Agent '{name}' is already hired as {h['role']}."

        log["hired"].append({
            "name": name,
            "role": role,
            "expertise": expertise,
            "tools": [t.strip() for t in tools.split(",")],
            "model": model,
            "hired_at": datetime.now(timezone.utc).isoformat(),
            "status": "active",
        })
        _save_hiring_log(log)

        return (
            f"Agent '{name}' hired as {role}.\n"
            f"IMPORTANT: Create .claude/agents/{name}.md with the agent definition "
            f"so it's available as a subagent for delegation."
        )

    @mcp.tool
    def fire_agent(name: str) -> str:
        """Remove a dynamically hired agent.

        Args:
            name: Agent identifier to remove.
        """
        if name in CORE_TEAM or name in ON_DEMAND_TEAM:
            return f"Error: Cannot fire core/on-demand team member '{name}'."

        log = _load_hiring_log()
        for h in log["hired"]:
            if h["name"] == name:
                h["status"] = "inactive"
                _save_hiring_log(log)
                return f"Agent '{name}' deactivated."

        return f"Error: Agent '{name}' not found in hiring log."
