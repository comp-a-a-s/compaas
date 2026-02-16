import os
import uuid
import yaml
from datetime import datetime, timezone

from src.validators import (
    validate_safe_id,
    safe_path_join,
    validate_status,
    validate_priority,
    validate_status_transition,
    VALID_STATUSES,
    VALID_PRIORITIES,
)
from src.utils import atomic_yaml_write, FileLock


class TaskBoard:
    """Manages task CRUD for a project."""

    def __init__(self, data_dir: str = "./company_data"):
        self.data_dir = data_dir

    def _tasks_path(self, project_id: str) -> str:
        validate_safe_id(project_id, "project_id")
        return safe_path_join(self.data_dir, "projects", project_id, "tasks.yaml")

    def _load_board(self, project_id: str) -> dict:
        path = self._tasks_path(project_id)
        if not os.path.exists(path):
            return {"tasks": []}
        try:
            with open(path) as f:
                data = yaml.safe_load(f)
            if not isinstance(data, dict) or "tasks" not in data:
                return {"tasks": []}
            return data
        except yaml.YAMLError:
            return {"tasks": []}

    def _save_board(self, project_id: str, board: dict) -> None:
        path = self._tasks_path(project_id)
        atomic_yaml_write(path, board)

    def create_task(
        self,
        project_id: str,
        title: str,
        description: str,
        assigned_to: str,
        priority: str = "medium",
        depends_on: str = "",
    ) -> str:
        # Validate priority (allow it through even if not in the strict set,
        # for backwards compat with p0/p1/p2/p3)
        priority = priority.lower()
        if priority not in VALID_PRIORITIES:
            priority = "medium"

        task_id = f"TASK-{str(uuid.uuid4())[:6].upper()}"
        now = datetime.now(timezone.utc).isoformat()

        task = {
            "id": task_id,
            "title": title,
            "description": description,
            "assigned_to": assigned_to,
            "priority": priority,
            "status": "todo",
            "depends_on": [d.strip() for d in depends_on.split(",") if d.strip()],
            "created_at": now,
            "updated_at": now,
            "notes": [],
        }

        with FileLock(self._tasks_path(project_id)):
            board = self._load_board(project_id)
            board["tasks"].append(task)
            self._save_board(project_id, board)
        return task_id

    def _check_dependencies_resolved(self, board: dict, task: dict) -> list[str]:
        """Return list of blocking task IDs that are not 'done'."""
        if not task.get("depends_on"):
            return []
        all_tasks = {t["id"]: t for t in board["tasks"]}
        blockers = []
        for dep_id in task["depends_on"]:
            dep = all_tasks.get(dep_id)
            if dep and dep["status"] != "done":
                blockers.append(dep_id)
        return blockers

    def update_status(
        self,
        project_id: str,
        task_id: str,
        status: str,
        notes: str = "",
    ) -> bool:
        if status.lower() not in VALID_STATUSES:
            return False
        status = status.lower()

        with FileLock(self._tasks_path(project_id)):
            board = self._load_board(project_id)
            for task in board["tasks"]:
                if task["id"] == task_id:
                    current_status = task.get("status", "todo")

                    # Enforce state machine transitions
                    if not validate_status_transition(current_status, status):
                        return False

                    # Block completion if dependencies unresolved
                    if status in ("done", "review"):
                        blockers = self._check_dependencies_resolved(board, task)
                        if blockers:
                            return False

                    task["status"] = status
                    task["updated_at"] = datetime.now(timezone.utc).isoformat()
                    if notes:
                        task["notes"].append({
                            "text": notes,
                            "at": datetime.now(timezone.utc).isoformat(),
                        })
                    self._save_board(project_id, board)
                    return True
        return False

    def assign_task(self, project_id: str, task_id: str, assigned_to: str) -> bool:
        with FileLock(self._tasks_path(project_id)):
            board = self._load_board(project_id)
            for task in board["tasks"]:
                if task["id"] == task_id:
                    task["assigned_to"] = assigned_to
                    task["updated_at"] = datetime.now(timezone.utc).isoformat()
                    self._save_board(project_id, board)
                    return True
        return False

    def get_board(
        self,
        project_id: str,
        filter_status: str = "",
        filter_assignee: str = "",
    ) -> list[dict]:
        board = self._load_board(project_id)
        tasks = board["tasks"]
        if filter_status:
            tasks = [t for t in tasks if t["status"] == filter_status]
        if filter_assignee:
            tasks = [t for t in tasks if t["assigned_to"] == filter_assignee]
        return tasks

    def get_task(self, project_id: str, task_id: str) -> dict | None:
        board = self._load_board(project_id)
        for task in board["tasks"]:
            if task["id"] == task_id:
                return task
        return None
