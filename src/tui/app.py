"""CrackPie TUI Dashboard — built with Textual."""

import os
import yaml
from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, Static, DataTable, RichLog

from src.utils import resolve_data_dir
from src.agents import AGENT_REGISTRY


DATA_DIR = resolve_data_dir()
ACTIVITY_LOG = os.path.join(DATA_DIR, "activity.log")


class OrgChartPanel(Static):
    """Shows the company org chart with agent statuses."""

    BORDER_TITLE = "Organization"

    def compose(self) -> ComposeResult:
        yield DataTable(id="org-table")

    def on_mount(self) -> None:
        table = self.query_one("#org-table", DataTable)
        table.add_columns("Agent", "Model", "Team", "Status")
        for slug, info in AGENT_REGISTRY.items():
            display = f"{info['name']} ({info['role']})"
            table.add_row(display, info["model"], info["team"], info["status"])
        self._load_hires(table)

    def _load_hires(self, table: DataTable) -> None:
        path = os.path.join(DATA_DIR, "hiring_log.yaml")
        if not os.path.exists(path):
            return
        try:
            with open(path) as f:
                log = yaml.safe_load(f) or {"hired": []}
            for h in log["hired"]:
                if h.get("status") == "active":
                    table.add_row(h["role"], h.get("model", "sonnet"), "hired", "idle")
        except Exception:
            pass


class TaskBoardPanel(Static):
    """Shows the kanban task board for the active project."""

    BORDER_TITLE = "Task Board"

    def compose(self) -> ComposeResult:
        yield DataTable(id="task-table")

    def on_mount(self) -> None:
        table = self.query_one("#task-table", DataTable)
        table.add_columns("ID", "Title", "Assigned", "Priority", "Status")

    def refresh_tasks(self) -> None:
        """Reload tasks from all projects."""
        table = self.query_one("#task-table", DataTable)
        table.clear()

        projects_dir = os.path.join(DATA_DIR, "projects")
        if not os.path.exists(projects_dir):
            return

        try:
            for pid in sorted(os.listdir(projects_dir)):
                # Skip hidden files like .DS_Store
                if pid.startswith("."):
                    continue
                tasks_path = os.path.join(projects_dir, pid, "tasks.yaml")
                if not os.path.exists(tasks_path):
                    continue
                with open(tasks_path) as f:
                    board = yaml.safe_load(f) or {"tasks": []}

                for task in board.get("tasks", []):
                    status_icon = {
                        "todo": "[ ]",
                        "in_progress": "[~]",
                        "review": "[?]",
                        "done": "[x]",
                        "blocked": "[!]",
                    }.get(task.get("status", "todo"), "[ ]")

                    table.add_row(
                        task.get("id", "?"),
                        str(task.get("title", ""))[:40],
                        task.get("assigned_to", ""),
                        task.get("priority", ""),
                        f"{status_icon} {task.get('status', 'todo')}",
                    )
        except Exception:
            pass


class ProjectSummaryPanel(Static):
    """Shows summary of active projects."""

    BORDER_TITLE = "Projects"

    def compose(self) -> ComposeResult:
        yield DataTable(id="project-table")

    def on_mount(self) -> None:
        table = self.query_one("#project-table", DataTable)
        table.add_columns("ID", "Name", "Status", "Progress")

    def refresh_projects(self) -> None:
        table = self.query_one("#project-table", DataTable)
        table.clear()

        projects_dir = os.path.join(DATA_DIR, "projects")
        if not os.path.exists(projects_dir):
            return

        try:
            for pid in sorted(os.listdir(projects_dir)):
                if pid.startswith("."):
                    continue
                project_path = os.path.join(projects_dir, pid, "project.yaml")
                tasks_path = os.path.join(projects_dir, pid, "tasks.yaml")
                if not os.path.exists(project_path):
                    continue

                with open(project_path) as f:
                    project = yaml.safe_load(f)
                if not project:
                    continue

                task_summary = "—"
                if os.path.exists(tasks_path):
                    with open(tasks_path) as f:
                        board = yaml.safe_load(f) or {"tasks": []}
                    total = len(board.get("tasks", []))
                    done = sum(1 for t in board.get("tasks", []) if t.get("status") == "done")
                    if total:
                        pct = int((done / total) * 100)
                        task_summary = f"{done}/{total} ({pct}%)"

                table.add_row(
                    project.get("id", pid),
                    str(project.get("name", ""))[:30],
                    project.get("status", "?"),
                    task_summary,
                )
        except Exception:
            pass


class ActivityFeedPanel(Static):
    """Shows live agent activity from the activity log."""

    BORDER_TITLE = "Activity Feed"

    def compose(self) -> ComposeResult:
        yield RichLog(id="activity-log", highlight=True, markup=True, max_lines=200)

    def on_mount(self) -> None:
        self._last_pos = 0
        log = self.query_one("#activity-log", RichLog)
        log.write("[dim]Waiting for agent activity...[/dim]")

    def refresh_activity(self) -> None:
        if not os.path.exists(ACTIVITY_LOG):
            return

        try:
            log_widget = self.query_one("#activity-log", RichLog)

            with open(ACTIVITY_LOG) as f:
                f.seek(self._last_pos)
                new_lines = f.readlines()
                self._last_pos = f.tell()

            for line in new_lines:
                line = line.strip()
                if line:
                    log_widget.write(line)
        except Exception:
            pass


class VirtualCompanyDashboard(App):
    """The main TUI dashboard application."""

    CSS = """
    Screen {
        layout: grid;
        grid-size: 2 3;
        grid-gutter: 1;
        grid-rows: 1fr 1fr 2fr;
    }

    OrgChartPanel {
        border: solid $success;
        height: 100%;
    }

    ProjectSummaryPanel {
        border: solid $primary;
        height: 100%;
    }

    ActivityFeedPanel {
        border: solid $warning;
        height: 100%;
        column-span: 2;
    }

    TaskBoardPanel {
        border: solid $accent;
        height: 100%;
        column-span: 2;
    }

    #org-table, #task-table, #project-table {
        height: 100%;
    }

    #activity-log {
        height: 100%;
    }
    """

    TITLE = "CrackPie — Company Dashboard"
    SUB_TITLE = "Board Head: Idan"
    BINDINGS = [
        ("r", "force_refresh", "Refresh"),
        ("q", "quit", "Quit"),
    ]

    def compose(self) -> ComposeResult:
        yield Header()
        yield OrgChartPanel()
        yield ProjectSummaryPanel()
        yield ActivityFeedPanel()
        yield TaskBoardPanel()
        yield Footer()

    def on_mount(self) -> None:
        os.makedirs(os.path.join(DATA_DIR, "projects"), exist_ok=True)
        self._do_refresh()
        self.set_interval(3.0, self._do_refresh)

    def _do_refresh(self) -> None:
        """Refresh all panels safely."""
        try:
            self.query_one(TaskBoardPanel).refresh_tasks()
        except Exception:
            pass
        try:
            self.query_one(ProjectSummaryPanel).refresh_projects()
        except Exception:
            pass
        try:
            self.query_one(ActivityFeedPanel).refresh_activity()
        except Exception:
            pass

    def action_force_refresh(self) -> None:
        """Manual refresh triggered by 'r' key."""
        self._do_refresh()
        self.notify("Dashboard refreshed", severity="information", timeout=2)
