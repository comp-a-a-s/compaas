"""MCP tools for project CRUD operations."""

from fastmcp import FastMCP
from src.state.project_state import ProjectStateManager
from src.utils import emit_activity


def register_project_tools(mcp: FastMCP, data_dir: str) -> None:
    state = ProjectStateManager(data_dir)

    @mcp.tool
    def create_project(name: str, description: str, project_type: str = "general") -> str:
        """Create a new project. Returns the project ID."""
        project_id = state.create_project(name, description, project_type)
        project = state.get_project(project_id) or {}
        workspace_path = project.get("workspace_path", "")
        emit_activity(
            data_dir,
            "system",
            "CREATED",
            f"Project '{name}' ({project_id}) created",
            project_id=project_id,
            metadata={"workspace_path": workspace_path},
        )
        return (
            f"Project '{name}' created with ID: {project_id}\n"
            f"Company data path: {data_dir}/projects/{project_id}/\n"
            f"Workspace path: {workspace_path}\n"
            "Required docs initialized:\n"
            "- specs/00_stakeholder_meeting_summary.md\n"
            "- specs/01_full_execution_plan.md\n"
            "- artifacts/02_activation_guide.md\n"
            "- artifacts/03_project_handoff.md"
        )

    @mcp.tool
    def get_project_status(project_id: str) -> str:
        """Get the current status and details of a project by its ID."""
        project = state.get_project(project_id)
        if not project:
            return f"Error: Project '{project_id}' not found."
        import yaml
        return yaml.dump(project, default_flow_style=False)

    @mcp.tool
    def update_project(project_id: str, status: str = "", team: str = "", phase: str = "", description: str = "", run_instructions: str = "") -> str:
        """Update project fields. Provide status, team (comma-separated agent names), phase to add, description (executive summary), or run_instructions (how to run the final product)."""
        updates = {}
        if status:
            updates["status"] = status
        if team:
            updates["team"] = [t.strip() for t in team.split(",")]
        if phase:
            project = state.get_project(project_id)
            if project:
                phases = project.get("phases", [])
                phases.append(phase)
                updates["phases"] = phases
        if description:
            updates["description"] = description
        if run_instructions:
            updates["run_instructions"] = run_instructions
        if not updates:
            return "Error: No updates provided. Specify status, team, phase, description, or run_instructions."
        ok = state.update_project(project_id, updates)
        if ok:
            changed = ", ".join(updates.keys())
            emit_activity(data_dir, "system", "UPDATED", f"Project {project_id} ({changed})", project_id=project_id)
        return f"Project {project_id} updated." if ok else f"Error: Project '{project_id}' not found."

    @mcp.tool
    def list_projects() -> str:
        """List all projects with their current status."""
        projects = state.list_projects()
        if not projects:
            return "No projects found."
        import yaml
        return yaml.dump(projects, default_flow_style=False)
