"""Tests for project state and task board management."""

import os
import tempfile
import yaml
import pytest

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard


@pytest.fixture
def data_dir():
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "projects"))
        yield d


class TestProjectState:
    def test_create_project(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test App", "A test application", "web")

        assert len(pid) == 8
        project = mgr.get_project(pid)
        assert project["name"] == "Test App"
        assert project["description"] == "A test application"
        assert project["type"] == "web"
        assert project["status"] == "planning"

    def test_create_project_creates_subdirs(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        project_path = os.path.join(data_dir, "projects", pid)
        for subdir in ["ideas", "specs", "designs", "artifacts"]:
            assert os.path.isdir(os.path.join(project_path, subdir))

    def test_create_project_creates_task_and_decision_files(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        project_path = os.path.join(data_dir, "projects", pid)
        assert os.path.exists(os.path.join(project_path, "tasks.yaml"))
        assert os.path.exists(os.path.join(project_path, "decisions.yaml"))

    def test_get_nonexistent_project(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        assert mgr.get_project("nonexistent") is None

    def test_update_project(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        ok = mgr.update_project(pid, {"status": "development", "team": ["lead-backend"]})
        assert ok

        project = mgr.get_project(pid)
        assert project["status"] == "development"
        assert project["team"] == ["lead-backend"]

    def test_update_nonexistent_project(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        assert not mgr.update_project("nonexistent", {"status": "done"})

    def test_list_projects(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        mgr.create_project("App A", "First app", "web")
        mgr.create_project("App B", "Second app", "api")

        projects = mgr.list_projects()
        assert len(projects) == 2
        names = {p["name"] for p in projects}
        assert names == {"App A", "App B"}

    def test_list_empty_projects(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        assert mgr.list_projects() == []


class TestTaskBoard:
    def test_create_task(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        board = TaskBoard(data_dir)
        tid = board.create_task(pid, "Build API", "Create REST endpoints", "lead-backend", "p1")

        assert tid.startswith("TASK-")
        task = board.get_task(pid, tid)
        assert task["title"] == "Build API"
        assert task["assigned_to"] == "lead-backend"
        assert task["status"] == "todo"
        assert task["priority"] == "p1"

    def test_create_task_with_dependencies(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        board = TaskBoard(data_dir)
        t1 = board.create_task(pid, "Schema", "DB schema", "lead-backend")
        t2 = board.create_task(pid, "API", "API endpoints", "lead-backend", depends_on=t1)

        task = board.get_task(pid, t2)
        assert t1 in task["depends_on"]

    def test_update_status(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        board = TaskBoard(data_dir)
        tid = board.create_task(pid, "Task", "Do thing", "qa-lead")

        ok = board.update_status(pid, tid, "in_progress", "Started working")
        assert ok

        task = board.get_task(pid, tid)
        assert task["status"] == "in_progress"
        assert len(task["notes"]) == 1
        assert task["notes"][0]["text"] == "Started working"

    def test_update_nonexistent_task(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        board = TaskBoard(data_dir)
        assert not board.update_status(pid, "TASK-NOPE", "done")

    def test_assign_task(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        board = TaskBoard(data_dir)
        tid = board.create_task(pid, "Task", "Do thing", "lead-backend")
        ok = board.assign_task(pid, tid, "lead-frontend")
        assert ok

        task = board.get_task(pid, tid)
        assert task["assigned_to"] == "lead-frontend"

    def test_get_board_with_filters(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        board = TaskBoard(data_dir)
        t1 = board.create_task(pid, "Backend", "Backend work", "lead-backend")
        t2 = board.create_task(pid, "Frontend", "Frontend work", "lead-frontend")
        board.update_status(pid, t1, "done")

        # Filter by status
        done = board.get_board(pid, filter_status="done")
        assert len(done) == 1
        assert done[0]["id"] == t1

        # Filter by assignee
        fe = board.get_board(pid, filter_assignee="lead-frontend")
        assert len(fe) == 1
        assert fe[0]["id"] == t2

    def test_get_nonexistent_task(self, data_dir):
        mgr = ProjectStateManager(data_dir)
        pid = mgr.create_project("Test", "Test", "general")

        board = TaskBoard(data_dir)
        assert board.get_task(pid, "TASK-NOPE") is None
