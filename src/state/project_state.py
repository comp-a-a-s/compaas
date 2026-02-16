import os
import uuid
import yaml
from datetime import datetime, timezone


class ProjectStateManager:
    """Manages project lifecycle and state as YAML files."""

    def __init__(self, data_dir: str = "./company_data"):
        self.data_dir = data_dir
        self.projects_dir = os.path.join(data_dir, "projects")

    def _ensure_dirs(self, project_id: str) -> str:
        project_path = os.path.join(self.projects_dir, project_id)
        for subdir in ["ideas", "specs", "designs", "artifacts"]:
            os.makedirs(os.path.join(project_path, subdir), exist_ok=True)
        return project_path

    def create_project(self, name: str, description: str, project_type: str = "general") -> str:
        project_id = str(uuid.uuid4())[:8]
        project_path = self._ensure_dirs(project_id)
        now = datetime.now(timezone.utc).isoformat()

        project_data = {
            "id": project_id,
            "name": name,
            "description": description,
            "type": project_type,
            "status": "planning",
            "created_at": now,
            "updated_at": now,
            "phases": [],
            "team": [],
        }

        with open(os.path.join(project_path, "project.yaml"), "w") as f:
            yaml.dump(project_data, f, default_flow_style=False)

        # Initialize empty task board and decision log
        with open(os.path.join(project_path, "tasks.yaml"), "w") as f:
            yaml.dump({"tasks": []}, f)
        with open(os.path.join(project_path, "decisions.yaml"), "w") as f:
            yaml.dump({"decisions": []}, f)

        return project_id

    def get_project(self, project_id: str) -> dict | None:
        path = os.path.join(self.projects_dir, project_id, "project.yaml")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return yaml.safe_load(f)

    def update_project(self, project_id: str, updates: dict) -> bool:
        path = os.path.join(self.projects_dir, project_id, "project.yaml")
        if not os.path.exists(path):
            return False
        with open(path) as f:
            data = yaml.safe_load(f)
        data.update(updates)
        data["updated_at"] = datetime.now(timezone.utc).isoformat()
        with open(path, "w") as f:
            yaml.dump(data, f, default_flow_style=False)
        return True

    def list_projects(self) -> list[dict]:
        if not os.path.exists(self.projects_dir):
            return []
        projects = []
        for pid in sorted(os.listdir(self.projects_dir)):
            pfile = os.path.join(self.projects_dir, pid, "project.yaml")
            if os.path.exists(pfile):
                with open(pfile) as f:
                    data = yaml.safe_load(f)
                projects.append({
                    "id": data["id"],
                    "name": data["name"],
                    "status": data["status"],
                    "type": data.get("type", "general"),
                    "created_at": data.get("created_at", ""),
                })
        return projects
