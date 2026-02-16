"""MCP tools for shared memory and decision logging."""

import os
import yaml
from datetime import datetime, timezone
from fastmcp import FastMCP

from src.validators import validate_safe_id, safe_path_join
from src.utils import atomic_yaml_write, FileLock, emit_activity


def register_memory_tools(mcp: FastMCP, data_dir: str) -> None:
    memory_path = os.path.join(data_dir, "company_memory.yaml")

    def _load_memory() -> dict:
        if not os.path.exists(memory_path):
            return {}
        with open(memory_path) as f:
            return yaml.safe_load(f) or {}

    def _save_memory(memory: dict) -> None:
        atomic_yaml_write(memory_path, memory)

    @mcp.tool
    def read_memory(key: str = "") -> str:
        """Read from the shared company memory.

        Args:
            key: Specific key to read. If empty, returns all memory.
        """
        memory = _load_memory()
        if key and key in memory:
            return yaml.dump({key: memory[key]}, default_flow_style=False)
        if key and key not in memory:
            return f"Key '{key}' not found in memory."
        return yaml.dump(memory, default_flow_style=False) if memory else "Company memory is empty."

    @mcp.tool
    def write_memory(key: str, value: str) -> str:
        """Write to the shared company memory.

        Args:
            key: Memory key (e.g., 'output_dir', 'preferred_stack').
            value: Value to store.
        """
        with FileLock(memory_path):
            memory = _load_memory()
            memory[key] = {
                "value": value,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            _save_memory(memory)
        emit_activity(data_dir, "system", "UPDATED", f"Memory key '{key}' written")
        return f"Memory updated: {key} = {value}"

    @mcp.tool
    def log_decision(
        project_id: str,
        title: str,
        decision: str,
        rationale: str,
        decided_by: str,
        alternatives: str = "",
    ) -> str:
        """Log a project decision with rationale for future reference.

        Args:
            project_id: The project ID.
            title: Short decision title.
            decision: What was decided.
            rationale: Why this was chosen.
            decided_by: Who made the decision (agent name or 'board-head').
            alternatives: Other options that were considered.
        """
        try:
            validate_safe_id(project_id, "project_id")
        except ValueError as e:
            return f"Error: {e}"

        decisions_path = safe_path_join(data_dir, "projects", project_id, "decisions.yaml")
        if not os.path.exists(decisions_path):
            return f"Error: Project '{project_id}' not found."

        with FileLock(decisions_path):
            with open(decisions_path) as f:
                data = yaml.safe_load(f) or {"decisions": []}

            data["decisions"].append({
                "title": title,
                "decision": decision,
                "rationale": rationale,
                "decided_by": decided_by,
                "alternatives": alternatives,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

            atomic_yaml_write(decisions_path, data)

        emit_activity(data_dir, decided_by, "UPDATED", f"Decision logged: {title}")
        return f"Decision logged: {title}"

    @mcp.tool
    def get_decisions(project_id: str) -> str:
        """Get the decision log for a project.

        Args:
            project_id: The project ID.
        """
        try:
            validate_safe_id(project_id, "project_id")
        except ValueError as e:
            return f"Error: {e}"

        decisions_path = safe_path_join(data_dir, "projects", project_id, "decisions.yaml")
        if not os.path.exists(decisions_path):
            return f"Error: Project '{project_id}' not found."

        with open(decisions_path) as f:
            data = yaml.safe_load(f) or {"decisions": []}

        if not data["decisions"]:
            return "No decisions logged yet."
        return yaml.dump(data, default_flow_style=False)
