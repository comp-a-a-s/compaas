"""MCP tools for token usage tracking and metrics."""

import os
import yaml
from datetime import datetime, timezone
from fastmcp import FastMCP

from src.validators import validate_model, validate_complexity, validate_non_negative_int
from src.utils import atomic_yaml_write, FileLock, emit_activity


def register_metrics_tools(mcp: FastMCP, data_dir: str) -> None:
    token_usage_path = os.path.join(data_dir, "token_usage.yaml")
    activity_log_path = os.path.join(data_dir, "activity.log")

    def _load_token_usage() -> dict:
        if not os.path.exists(token_usage_path):
            return {"records": []}
        with open(token_usage_path) as f:
            return yaml.safe_load(f) or {"records": []}

    def _save_token_usage(data: dict) -> None:
        atomic_yaml_write(token_usage_path, data)

    @mcp.tool
    def log_token_usage(
        agent_name: str,
        model: str,
        task_description: str,
        estimated_input_tokens: int = 0,
        estimated_output_tokens: int = 0,
        project_id: str = "",
        task_id: str = "",
        notes: str = "",
    ) -> str:
        """Log estimated token usage for a task.

        Args:
            agent_name: Which agent performed the task.
            model: Model used (opus, sonnet, haiku).
            task_description: Brief description of the task.
            estimated_input_tokens: Estimated input tokens consumed.
            estimated_output_tokens: Estimated output tokens consumed.
            project_id: Associated project ID (optional).
            task_id: Associated task ID (optional).
            notes: Additional notes (optional).
        """
        try:
            model = validate_model(model)
        except ValueError:
            pass  # Allow logging with unknown models for flexibility

        try:
            validate_non_negative_int(estimated_input_tokens, "estimated_input_tokens")
            validate_non_negative_int(estimated_output_tokens, "estimated_output_tokens")
        except ValueError as e:
            return f"Error: {e}"

        with FileLock(token_usage_path):
            data = _load_token_usage()
            record = {
                "agent_name": agent_name,
                "model": model,
                "task_description": task_description,
                "estimated_input_tokens": estimated_input_tokens,
                "estimated_output_tokens": estimated_output_tokens,
                "estimated_total_tokens": estimated_input_tokens + estimated_output_tokens,
                "project_id": project_id,
                "task_id": task_id,
                "notes": notes,
                "logged_at": datetime.now(timezone.utc).isoformat(),
            }
            data["records"].append(record)
            _save_token_usage(data)
        total = estimated_input_tokens + estimated_output_tokens
        emit_activity(data_dir, agent_name, "UPDATED", f"Logged ~{total} tokens ({model})")
        return f"Token usage logged: {agent_name} ({model}) ~{total} total tokens"

    @mcp.tool
    def get_token_report(
        project_id: str = "",
        agent_name: str = "",
    ) -> str:
        """Get aggregated token usage report.

        Args:
            project_id: Filter by project (optional).
            agent_name: Filter by agent (optional).
        """
        data = _load_token_usage()
        records = data.get("records", [])

        # Apply filters
        if project_id:
            records = [r for r in records if r.get("project_id") == project_id]
        if agent_name:
            records = [r for r in records if r.get("agent_name") == agent_name]

        if not records:
            return "No token usage records found for the given filters."

        # Aggregate by agent
        by_agent = {}
        for r in records:
            agent = r.get("agent_name", "unknown")
            if agent not in by_agent:
                by_agent[agent] = {"model": r.get("model", "?"), "total_tokens": 0, "task_count": 0}
            by_agent[agent]["total_tokens"] += r.get("estimated_total_tokens", 0)
            by_agent[agent]["task_count"] += 1

        # Aggregate by model
        by_model = {}
        for r in records:
            model = r.get("model", "unknown")
            if model not in by_model:
                by_model[model] = {"total_tokens": 0, "task_count": 0}
            by_model[model]["total_tokens"] += r.get("estimated_total_tokens", 0)
            by_model[model]["task_count"] += 1

        grand_total = sum(r.get("estimated_total_tokens", 0) for r in records)

        report = {
            "total_records": len(records),
            "grand_total_tokens": grand_total,
            "by_agent": by_agent,
            "by_model": by_model,
        }
        return yaml.dump(report, default_flow_style=False)

    @mcp.tool
    def get_session_durations(agent_name: str = "") -> str:
        """Parse activity.log to compute session durations per agent.

        Args:
            agent_name: Filter by agent name (optional).
        """
        if not os.path.exists(activity_log_path):
            return "No activity log found."

        with open(activity_log_path) as f:
            lines = f.readlines()

        # Parse start/stop events
        sessions = {}  # agent -> list of {start, end, duration}
        starts = {}  # agent -> start_time

        for line in lines:
            line = line.strip()
            if not line:
                continue
            # Format: [TIMESTAMP] STARTED/COMPLETED: Agent 'name' ...
            try:
                ts_end = line.index("]")
                timestamp_str = line[1:ts_end]
                rest = line[ts_end + 2:]

                timestamp = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))

                if "STARTED:" in rest:
                    agent = rest.split("'")[1] if "'" in rest else "unknown"
                    starts[agent] = timestamp
                elif "COMPLETED:" in rest:
                    agent = rest.split("'")[1] if "'" in rest else "unknown"
                    if agent in starts:
                        duration = (timestamp - starts[agent]).total_seconds()
                        if agent not in sessions:
                            sessions[agent] = []
                        sessions[agent].append({
                            "start": starts[agent].isoformat(),
                            "end": timestamp.isoformat(),
                            "duration_seconds": round(duration, 1),
                        })
                        del starts[agent]
            except (ValueError, IndexError):
                continue

        # Filter if needed
        if agent_name and agent_name in sessions:
            sessions = {agent_name: sessions[agent_name]}
        elif agent_name:
            return f"No sessions found for agent '{agent_name}'."

        if not sessions:
            return "No completed sessions found in activity log."

        # Add summary per agent
        summary = {}
        for agent, agent_sessions in sessions.items():
            total_duration = sum(s["duration_seconds"] for s in agent_sessions)
            summary[agent] = {
                "session_count": len(agent_sessions),
                "total_duration_seconds": round(total_duration, 1),
                "avg_duration_seconds": round(total_duration / len(agent_sessions), 1) if agent_sessions else 0,
                "sessions": agent_sessions,
            }

        return yaml.dump(summary, default_flow_style=False)

    @mcp.tool
    def estimate_task_cost(
        task_description: str,
        model: str = "sonnet",
        complexity: str = "medium",
    ) -> str:
        """Estimate token cost for a task before execution.

        Args:
            task_description: What the task involves.
            model: Which model will be used (opus, sonnet, haiku).
            complexity: Task complexity — low, medium, high, very_high.
        """
        # Validate inputs (fall back to defaults for invalid values)
        try:
            model = validate_model(model)
        except ValueError:
            model = "sonnet"

        try:
            complexity = validate_complexity(complexity)
        except ValueError:
            complexity = "medium"

        # Token estimates based on complexity and model
        COMPLEXITY_MULTIPLIERS = {
            "low": {"input": 2000, "output": 1000},
            "medium": {"input": 8000, "output": 4000},
            "high": {"input": 20000, "output": 10000},
            "very_high": {"input": 50000, "output": 25000},
        }

        # Cost per million tokens (approximate, USD)
        MODEL_COSTS = {
            "opus": {"input": 15.0, "output": 75.0},
            "sonnet": {"input": 3.0, "output": 15.0},
            "haiku": {"input": 0.25, "output": 1.25},
        }

        tokens = COMPLEXITY_MULTIPLIERS[complexity]
        costs = MODEL_COSTS[model]

        est_input = tokens["input"]
        est_output = tokens["output"]
        est_cost = (est_input / 1_000_000 * costs["input"]) + (est_output / 1_000_000 * costs["output"])

        estimate = {
            "task": task_description,
            "model": model,
            "complexity": complexity,
            "estimated_input_tokens": est_input,
            "estimated_output_tokens": est_output,
            "estimated_total_tokens": est_input + est_output,
            "estimated_cost_usd": round(est_cost, 4),
            "note": "These are rough estimates. Actual usage may vary.",
        }
        return yaml.dump(estimate, default_flow_style=False)
