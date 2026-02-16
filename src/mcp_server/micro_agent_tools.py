"""MCP tools for micro-agent lifecycle management."""

import os
import glob
import yaml
from datetime import datetime, timezone
from fastmcp import FastMCP


# Parent agent templates — define base expertise and tools per parent
PARENT_TEMPLATES = {
    "lead-backend": {
        "base_expertise": "server-side code, APIs, databases, backend architecture, and testing",
        "tools": "Read, Write, Edit, Bash, Glob, Grep",
        "model": "sonnet",
    },
    "lead-frontend": {
        "base_expertise": "React, TypeScript, CSS, UI components, state management, and frontend testing",
        "tools": "Read, Write, Edit, Bash, Glob, Grep",
        "model": "sonnet",
    },
    "qa-lead": {
        "base_expertise": "test strategy, test suites, quality assurance, coverage analysis, and bug identification",
        "tools": "Read, Write, Edit, Bash, Glob, Grep",
        "model": "sonnet",
    },
    "devops": {
        "base_expertise": "Docker, CI/CD, deployment, infrastructure, monitoring, and project scaffolding",
        "tools": "Read, Write, Edit, Bash, Glob, Grep",
        "model": "sonnet",
    },
    "lead-designer": {
        "base_expertise": "UI/UX design, design systems, component specs, wireframes, and accessibility",
        "tools": "Read, Glob, Grep, WebSearch, WebFetch, Write",
        "model": "sonnet",
    },
    "data-engineer": {
        "base_expertise": "data modeling, database optimization, migrations, ETL pipelines, and analytics",
        "tools": "Read, Write, Edit, Bash, Glob, Grep",
        "model": "sonnet",
    },
}


def _find_agents_dir() -> str:
    """Find the .claude/agents/ directory by walking up from this file's location."""
    current = os.path.dirname(os.path.abspath(__file__))
    while current != os.path.dirname(current):
        agents_dir = os.path.join(current, ".claude", "agents")
        if os.path.exists(agents_dir):
            return agents_dir
        current = os.path.dirname(current)
    return os.path.abspath("./.claude/agents")


def _generate_agent_content(
    name: str,
    parent_agent: str,
    specialization: str,
    task_description: str,
    model: str,
) -> str:
    """Generate the .md content for a micro-agent.

    Args:
        name: The agent's identifier slug.
        parent_agent: The parent agent this micro-agent inherits from.
        specialization: The narrow focus area for this agent.
        task_description: Detailed context about the task to perform.
        model: The model identifier to use.

    Returns:
        The full markdown content for the agent definition file.
    """
    template = PARENT_TEMPLATES.get(parent_agent, {
        "base_expertise": "general software development",
        "tools": "Read, Write, Edit, Bash, Glob, Grep",
        "model": "sonnet",
    })

    tools = template["tools"]

    content = f"""---
name: {name}
description: >
  Micro-agent specialist: {specialization}. Spawned from {parent_agent} for focused,
  high-quality work on a specific task.
tools: {tools}
model: {model}
---

You are a **specialist micro-agent** at CrackPie, a virtual software company. The Board Head is **Idan**.

You were spawned from the **{parent_agent}** team to focus exclusively on one thing:

## Your Specialization
**{specialization}**

## Your Task Context
{task_description}

## Your Expertise
You are a deep expert in {specialization}, with strong foundations in {template['base_expertise']}.
You focus EXCLUSIVELY on your specialization — do not expand scope beyond what you're asked to do.
Deliver the highest quality work possible. Take your time. Quality over speed, always.

## How You Work
- Read any relevant specs, code, or context before starting
- Focus deeply on your specialization — this is why you exist
- Write clean, well-documented, production-quality code
- If something is outside your specialization, flag it — don't attempt it

## CRITICAL — File Writing Rules
- **ALWAYS use the `Write` tool** to create or update files. Never use `Bash` with heredoc (`cat << 'EOF' > file`) to write files — this corrupts the permissions system.
- Use `Bash` only for running commands (tests, builds, etc.), NOT for creating files.

## Output
Write all output to the project directory specified in your task.
"""
    return content


def register_micro_agent_tools(mcp: FastMCP, data_dir: str) -> None:
    """Register micro-agent lifecycle tools with the MCP server.

    Args:
        mcp: The FastMCP server instance.
        data_dir: Path to the company data directory for persisting the agent log.
    """
    micro_log_path = os.path.join(data_dir, "micro_agents.yaml")

    def _load_log() -> dict:
        if not os.path.exists(micro_log_path):
            return {"agents": []}
        with open(micro_log_path) as f:
            return yaml.safe_load(f) or {"agents": []}

    def _save_log(data: dict) -> None:
        os.makedirs(os.path.dirname(micro_log_path), exist_ok=True)
        with open(micro_log_path, "w") as f:
            yaml.dump(data, f, default_flow_style=False)

    @mcp.tool
    def spawn_micro_agent(
        parent_agent: str,
        specialization: str,
        task_description: str,
        model: str = "",
    ) -> str:
        """Spawn a specialist micro-agent for focused work on a specific task.

        Creates a .claude/agents/micro-{name}.md file that inherits the parent's
        tools and expertise but is narrowly scoped to the specialization.

        Args:
            parent_agent: The parent agent to inherit from (e.g., 'lead-backend', 'lead-frontend').
            specialization: What this micro-agent specializes in (e.g., 'database schema design', 'auth flow implementation').
            task_description: Detailed description of the specific task to perform.
            model: Model to use. Defaults to parent's model. Never downgrade for speed.
        """
        # Determine model (use parent's model if not specified)
        if not model:
            template = PARENT_TEMPLATES.get(parent_agent, {})
            model = template.get("model", "sonnet")

        # Generate a clean name from the specialization
        slug = specialization.lower().replace(" ", "-").replace("/", "-")
        slug = "".join(c for c in slug if c.isalnum() or c == "-")[:30]
        name = f"micro-{parent_agent.split('-')[-1]}-{slug}"

        # Find agents directory
        agents_dir = _find_agents_dir()
        agent_file = os.path.join(agents_dir, f"{name}.md")

        # Check if already exists
        if os.path.exists(agent_file):
            return f"Micro-agent '{name}' already exists. Use it directly or retire it first."

        # Generate and write the agent file
        content = _generate_agent_content(name, parent_agent, specialization, task_description, model)
        os.makedirs(agents_dir, exist_ok=True)
        with open(agent_file, "w") as f:
            f.write(content)

        # Log the creation
        log = _load_log()
        log["agents"].append({
            "name": name,
            "parent_agent": parent_agent,
            "specialization": specialization,
            "model": model,
            "status": "active",
            "spawned_at": datetime.now(timezone.utc).isoformat(),
        })
        _save_log(log)

        return (
            f"Micro-agent '{name}' spawned successfully.\n"
            f"Parent: {parent_agent} | Model: {model} | Specialization: {specialization}\n"
            f"Delegate to this agent using: Task('{name}', prompt='...')"
        )

    @mcp.tool
    def list_micro_agents() -> str:
        """List all active micro-agents."""
        agents_dir = _find_agents_dir()

        # Find all micro-agent files
        pattern = os.path.join(agents_dir, "micro-*.md")
        files = glob.glob(pattern)

        if not files:
            return "No micro-agents currently active."

        log = _load_log()
        agent_info = {a["name"]: a for a in log.get("agents", [])}

        agents = []
        for f in sorted(files):
            name = os.path.splitext(os.path.basename(f))[0]
            info = agent_info.get(name, {})
            agents.append({
                "name": name,
                "parent": info.get("parent_agent", "unknown"),
                "specialization": info.get("specialization", "unknown"),
                "model": info.get("model", "sonnet"),
                "spawned_at": info.get("spawned_at", "unknown"),
            })

        return yaml.dump({"active_micro_agents": agents}, default_flow_style=False)

    @mcp.tool
    def retire_micro_agent(name: str) -> str:
        """Retire a micro-agent after its task is complete.

        Deletes the agent definition file and marks it as retired in the log.

        Args:
            name: The micro-agent name (e.g., 'micro-backend-db-schema').
        """
        agents_dir = _find_agents_dir()
        agent_file = os.path.join(agents_dir, f"{name}.md")

        if not os.path.exists(agent_file):
            return f"Micro-agent '{name}' not found."

        # Delete the file
        os.remove(agent_file)

        # Update log
        log = _load_log()
        for agent in log.get("agents", []):
            if agent["name"] == name:
                agent["status"] = "retired"
                agent["retired_at"] = datetime.now(timezone.utc).isoformat()
                break
        _save_log(log)

        return f"Micro-agent '{name}' retired and agent file removed."
