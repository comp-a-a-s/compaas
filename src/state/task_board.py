import os
import uuid
import yaml
from datetime import datetime, timezone


class TaskBoard:
    """Manages task CRUD for a project."""

    def __init__(self, data_dir: str = "./company_data"):
        self.data_dir = data_dir

    def _tasks_path(self, project_id: str) -> str:
        return os.path.join(self.data_dir, "projects", project_id, "tasks.yaml")

    def _load_board(self, project_id: str) -> dict:
        path = self._tasks_path(project_id)
        if not os.path.exists(path):
            return {"tasks": []}
        with open(path) as f:
            return yaml.safe_load(f) or {"tasks": []}

    def _save_board(self, project_id: str, board: dict) -> None:
        with open(self._tasks_path(project_id), "w") as f:
            yaml.dump(board, f, default_flow_style=False)

    def create_task(
        self,
        project_id: str,
        title: str,
        description: str,
        assigned_to: str,
        priority: str = "medium",
        depends_on: str = "",
    ) -> str:
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

        board = self._load_board(project_id)
        board["tasks"].append(task)
        self._save_board(project_id, board)
        return task_id

    def update_status(
        self,
        project_id: str,
        task_id: str,
        status: str,
        notes: str = "",
    ) -> bool:
        board = self._load_board(project_id)
        for task in board["tasks"]:
            if task["id"] == task_id:
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
