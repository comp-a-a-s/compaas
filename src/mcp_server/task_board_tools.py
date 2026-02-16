"""MCP tools for task board operations."""

from fastmcp import FastMCP
from src.state.task_board import TaskBoard


def register_task_tools(mcp: FastMCP, data_dir: str) -> None:
    board = TaskBoard(data_dir)

    @mcp.tool
    def create_task(
        project_id: str,
        title: str,
        description: str,
        assigned_to: str,
        priority: str = "medium",
        depends_on: str = "",
    ) -> str:
        """Create a new task on the project task board.

        Args:
            project_id: The project ID to add the task to.
            title: Short task title.
            description: Detailed description of what needs to be done.
            assigned_to: Agent name to assign (e.g., 'lead-backend', 'qa-lead').
            priority: Task priority — p0 (critical), p1 (high), p2 (medium), p3 (low).
            depends_on: Comma-separated task IDs that must complete first.
        """
        task_id = board.create_task(project_id, title, description, assigned_to, priority, depends_on)
        return f"Task {task_id} created: '{title}' assigned to {assigned_to}"

    @mcp.tool
    def update_task_status(
        project_id: str,
        task_id: str,
        status: str,
        notes: str = "",
    ) -> str:
        """Update the status of a task.

        Args:
            project_id: The project ID.
            task_id: The task ID (e.g., TASK-A1B2C3).
            status: New status — todo, in_progress, review, done, blocked.
            notes: Optional notes about the status change.
        """
        ok = board.update_status(project_id, task_id, status, notes)
        return f"Task {task_id} → {status}" if ok else f"Error: Task '{task_id}' not found."

    @mcp.tool
    def get_task_board(
        project_id: str,
        filter_status: str = "",
        filter_assignee: str = "",
    ) -> str:
        """Get the task board for a project, optionally filtered.

        Args:
            project_id: The project ID.
            filter_status: Filter by status (todo, in_progress, review, done, blocked).
            filter_assignee: Filter by assigned agent name.
        """
        tasks = board.get_board(project_id, filter_status, filter_assignee)
        if not tasks:
            return "No tasks found matching the filter."
        import yaml
        return yaml.dump(tasks, default_flow_style=False)

    @mcp.tool
    def assign_task(project_id: str, task_id: str, assigned_to: str) -> str:
        """Reassign a task to a different agent.

        Args:
            project_id: The project ID.
            task_id: The task ID.
            assigned_to: New agent name to assign to.
        """
        ok = board.assign_task(project_id, task_id, assigned_to)
        return f"Task {task_id} reassigned to {assigned_to}" if ok else f"Error: Task '{task_id}' not found."
