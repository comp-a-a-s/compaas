"""MCP tools for token usage tracking and metrics."""

import os
import yaml
from datetime import datetime, timezone
from fastmcp import FastMCP

from src.validators import validate_model, validate_complexity, validate_non_negative_int
from src.utils import atomic_yaml_write, FileLock, emit_activity


def register_metrics_tools(mcp: FastMCP, data_dir: str) -> None:
    token_usage_path = os.path.join(data_dir, "token_usage.yaml")
    token_budgets_path = os.path.join(data_dir, "token_budgets.yaml")
    activity_log_path = os.path.join(data_dir, "activity.log")

    def _load_token_usage() -> dict:
        if not os.path.exists(token_usage_path):
            return {"records": []}
        with open(token_usage_path) as f:
            return yaml.safe_load(f) or {"records": []}

    def _save_token_usage(data: dict) -> None:
        atomic_yaml_write(token_usage_path, data)

    def _load_budgets() -> dict:
        if not os.path.exists(token_budgets_path):
            return {"budgets": []}
        with open(token_budgets_path) as f:
            return yaml.safe_load(f) or {"budgets": []}

    def _save_budgets(data: dict) -> None:
        atomic_yaml_write(token_budgets_path, data)

    def _get_usage_for(records: list, project_id: str = "", agent_name: str = "") -> int:
        """Sum total tokens for matching records."""
        filtered = records
        if project_id:
            filtered = [r for r in filtered if r.get("project_id") == project_id]
        if agent_name:
            filtered = [r for r in filtered if r.get("agent_name") == agent_name]
        return sum(r.get("estimated_total_tokens", 0) for r in filtered)

    def _check_budget(project_id: str = "", agent_name: str = "", new_tokens: int = 0) -> str | None:
        """Check if adding new_tokens would exceed any applicable budget.

        Returns a warning string if over budget, None otherwise.
        """
        budgets_data = _load_budgets()
        budgets = budgets_data.get("budgets", [])
        if not budgets:
            return None

        usage_data = _load_token_usage()
        records = usage_data.get("records", [])
        warnings = []

        for budget in budgets:
            b_project = budget.get("project_id", "")
            b_agent = budget.get("agent_name", "")
            b_limit = budget.get("token_limit", 0)

            if b_limit <= 0:
                continue

            # Check if this budget applies
            matches = False
            if b_project and b_agent:
                matches = (project_id == b_project and agent_name == b_agent)
            elif b_project:
                matches = (project_id == b_project)
            elif b_agent:
                matches = (agent_name == b_agent)

            if not matches:
                continue

            current_usage = _get_usage_for(records, b_project, b_agent)
            projected = current_usage + new_tokens
            if projected > b_limit:
                scope = []
                if b_project:
                    scope.append(f"project={b_project}")
                if b_agent:
                    scope.append(f"agent={b_agent}")
                scope_str = ", ".join(scope)
                warnings.append(
                    f"BUDGET WARNING ({scope_str}): "
                    f"{projected:,} tokens would exceed limit of {b_limit:,} "
                    f"(current: {current_usage:,}, new: {new_tokens:,})"
                )

        return "\n".join(warnings) if warnings else None

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

        # Check budget limits
        budget_warning = _check_budget(project_id, agent_name, 0)  # tokens already logged
        msg = f"Token usage logged: {agent_name} ({model}) ~{total} total tokens"
        if budget_warning:
            emit_activity(data_dir, "cfo", "BLOCKED", budget_warning.split("\n")[0])
            msg += f"\n\n{budget_warning}"
        return msg

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
    def set_token_budget(
        token_limit: int,
        project_id: str = "",
        agent_name: str = "",
    ) -> str:
        """Set a token budget limit for a project, agent, or both.

        When token usage is logged, it will be checked against the budget and
        a warning is emitted if the limit is exceeded.

        Args:
            token_limit: Maximum total tokens allowed. Use 0 to remove a budget.
            project_id: Apply budget to this project (optional).
            agent_name: Apply budget to this agent (optional).
        """
        if not project_id and not agent_name:
            return "Error: Must specify at least one of project_id or agent_name."

        try:
            validate_non_negative_int(token_limit, "token_limit")
        except ValueError as e:
            return f"Error: {e}"

        with FileLock(token_budgets_path):
            data = _load_budgets()
            budgets = data.get("budgets", [])

            # Find existing budget for this scope
            existing = None
            for b in budgets:
                if b.get("project_id", "") == project_id and b.get("agent_name", "") == agent_name:
                    existing = b
                    break

            if token_limit == 0:
                # Remove budget
                if existing:
                    budgets.remove(existing)
                    data["budgets"] = budgets
                    _save_budgets(data)
                    scope = []
                    if project_id:
                        scope.append(f"project={project_id}")
                    if agent_name:
                        scope.append(f"agent={agent_name}")
                    return f"Budget removed for {', '.join(scope)}."
                return "No matching budget found to remove."

            if existing:
                existing["token_limit"] = token_limit
                existing["updated_at"] = datetime.now(timezone.utc).isoformat()
            else:
                budgets.append({
                    "project_id": project_id,
                    "agent_name": agent_name,
                    "token_limit": token_limit,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })

            data["budgets"] = budgets
            _save_budgets(data)

        scope = []
        if project_id:
            scope.append(f"project={project_id}")
        if agent_name:
            scope.append(f"agent={agent_name}")
        emit_activity(data_dir, "cfo", "UPDATED",
                      f"Budget set: {token_limit:,} tokens for {', '.join(scope)}")
        return f"Budget set: {token_limit:,} tokens for {', '.join(scope)}."

    @mcp.tool
    def get_token_budget(
        project_id: str = "",
        agent_name: str = "",
    ) -> str:
        """Check token budget status — current usage vs limit.

        Args:
            project_id: Check budget for this project (optional).
            agent_name: Check budget for this agent (optional).
        """
        budgets_data = _load_budgets()
        budgets = budgets_data.get("budgets", [])

        if not budgets:
            return "No token budgets configured."

        usage_data = _load_token_usage()
        records = usage_data.get("records", [])

        # Filter budgets if scope specified
        if project_id or agent_name:
            budgets = [
                b for b in budgets
                if (not project_id or b.get("project_id", "") == project_id)
                and (not agent_name or b.get("agent_name", "") == agent_name)
            ]

        if not budgets:
            return "No matching budgets found."

        result = []
        for b in budgets:
            b_project = b.get("project_id", "")
            b_agent = b.get("agent_name", "")
            b_limit = b.get("token_limit", 0)

            current = _get_usage_for(records, b_project, b_agent)
            remaining = max(0, b_limit - current)
            pct = round((current / b_limit) * 100, 1) if b_limit > 0 else 0

            scope = []
            if b_project:
                scope.append(f"project={b_project}")
            if b_agent:
                scope.append(f"agent={b_agent}")

            status = "OK" if current <= b_limit else "OVER BUDGET"
            result.append({
                "scope": ", ".join(scope),
                "limit": b_limit,
                "used": current,
                "remaining": remaining,
                "usage_percent": pct,
                "status": status,
            })

        return yaml.dump(result, default_flow_style=False)

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
