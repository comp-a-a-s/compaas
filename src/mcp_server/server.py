"""
COMPaaS MCP Server.

Provides tools for project management, task tracking, memory, company operations,
token metrics, and micro-agent lifecycle management.
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
from src.utils import resolve_data_dir


DATA_DIR = resolve_data_dir()

VALID_SCOPES = ("all", "project", "tasks", "memory", "company", "metrics", "micro_agents")


def create_server(scope: str = "all", data_dir: str | None = None) -> FastMCP:
    effective_dir = data_dir or DATA_DIR
    os.makedirs(effective_dir, exist_ok=True)

    mcp = FastMCP(f"compaas-{scope}")

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
        print(f"Unknown scope: {scope}. Use: {', '.join(VALID_SCOPES)}", file=sys.stderr)
        sys.exit(1)

    return mcp


def main():
    parser = argparse.ArgumentParser(description="COMPaaS MCP Server")
    parser.add_argument("--scope", default="all", choices=VALID_SCOPES, help="Tool scope to expose")
    args = parser.parse_args()

    server = create_server(args.scope)
    server.run()


if __name__ == "__main__":
    main()
