import os
import uuid
import yaml
from datetime import datetime, timezone

from src.validators import validate_safe_id, safe_path_join
from src.utils import atomic_yaml_write, FileLock


class ProjectStateManager:
    """Manages project lifecycle and state as YAML files."""

    def __init__(self, data_dir: str = "./company_data"):
        self.data_dir = data_dir
        self.projects_dir = os.path.join(data_dir, "projects")

    def _ensure_dirs(self, project_id: str) -> str:
        validate_safe_id(project_id, "project_id")
        project_path = safe_path_join(self.projects_dir, project_id)
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

        atomic_yaml_write(os.path.join(project_path, "project.yaml"), project_data)

        # Initialize empty task board and decision log
        atomic_yaml_write(os.path.join(project_path, "tasks.yaml"), {"tasks": []})
        atomic_yaml_write(os.path.join(project_path, "decisions.yaml"), {"decisions": []})

        return project_id

    def get_project(self, project_id: str) -> dict | None:
        try:
            validate_safe_id(project_id, "project_id")
        except ValueError:
            return None
        path = safe_path_join(self.projects_dir, project_id, "project.yaml")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return yaml.safe_load(f)

    def update_project(self, project_id: str, updates: dict) -> bool:
        try:
            validate_safe_id(project_id, "project_id")
        except ValueError:
            return False
        path = safe_path_join(self.projects_dir, project_id, "project.yaml")
        if not os.path.exists(path):
            return False
        with FileLock(path):
            with open(path) as f:
                data = yaml.safe_load(f)
            data.update(updates)
            data["updated_at"] = datetime.now(timezone.utc).isoformat()
            atomic_yaml_write(path, data)
        return True

    def list_projects(self) -> list[dict]:
        if not os.path.exists(self.projects_dir):
            return []
        projects = []
        for pid in sorted(os.listdir(self.projects_dir)):
            if pid.startswith("."):
                continue
            try:
                validate_safe_id(pid, "project_id")
            except ValueError:
                continue
            pfile = safe_path_join(self.projects_dir, pid, "project.yaml")
            if not os.path.exists(pfile):
                continue
            try:
                with open(pfile) as f:
                    data = yaml.safe_load(f)
                if not data:
                    continue
                projects.append({
                    "id": data["id"],
                    "name": data["name"],
                    "description": data.get("description", ""),
                    "status": data["status"],
                    "type": data.get("type", "general"),
                    "created_at": data.get("created_at", ""),
                    "updated_at": data.get("updated_at", ""),
                })
            except (yaml.YAMLError, KeyError, OSError):
                continue
        return projects
