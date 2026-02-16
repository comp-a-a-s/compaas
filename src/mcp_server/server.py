"""
Virtual Company MCP Server.

Provides tools for project management, task tracking, memory, and company operations.
Launched by the CEO agent via mcpServers config in .claude/agents/ceo.md.

Usage:
    python -m src.mcp_server.server --scope all
    python -m src.mcp_server.server --scope project
    python -m src.mcp_server.server --scope tasks
    python -m src.mcp_server.server --scope memory
    python -m src.mcp_server.server --scope company
    python -m src.mcp_server.server --scope metrics
    python -m src.mcp_server.server --scope micro_agents
"""

import sys
import os
import argparse
from fastmcp import FastMCP

from src.mcp_server.project_tools import register_project_tools
from src.mcp_server.task_board_tools import register_task_tools
from src.mcp_server.memory_tools import register_memory_tools
from src.mcp_server.company_tools import register_company_tools
from src.mcp_server.metrics_tools import register_metrics_tools
from src.mcp_server.micro_agent_tools import register_micro_agent_tools


def _resolve_data_dir() -> str:
    """Resolve the company_data directory to an absolute path.

    Checks VIRTUALTREE_DATA_DIR env var first, then falls back to
    ./company_data relative to the project root (where pyproject.toml lives).
    """
    env_dir = os.environ.get("CRACKPIE_DATA_DIR")
    if env_dir:
        return os.path.abspath(env_dir)

    # Walk up from this file to find the project root (where pyproject.toml is)
    current = os.path.dirname(os.path.abspath(__file__))
    while current != os.path.dirname(current):  # stop at filesystem root
        if os.path.exists(os.path.join(current, "pyproject.toml")):
            return os.path.join(current, "company_data")
        current = os.path.dirname(current)

    # Fallback: relative to CWD
    return os.path.abspath("./company_data")


DATA_DIR = _resolve_data_dir()


def create_server(scope: str = "all", data_dir: str | None = None) -> FastMCP:
    effective_dir = data_dir or DATA_DIR
    os.makedirs(effective_dir, exist_ok=True)

    mcp = FastMCP(f"crackpie-{scope}")

    registrars = {
        "project": register_project_tools,
        "tasks": register_task_tools,
        "memory": register_memory_tools,
        "company": register_company_tools,
        "metrics": register_metrics_tools,
        "micro_agents": register_micro_agent_tools,
    }

    if scope == "all":
        for register_fn in registrars.values():
            register_fn(mcp, effective_dir)
    elif scope in registrars:
        registrars[scope](mcp, effective_dir)
    else:
        print(f"Unknown scope: {scope}. Use: all, project, tasks, memory, company, metrics, micro_agents", file=sys.stderr)
        sys.exit(1)

    return mcp


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scope", default="all", help="Tool scope to expose")
    args = parser.parse_args()

    server = create_server(args.scope)
    server.run()


if __name__ == "__main__":
    main()
