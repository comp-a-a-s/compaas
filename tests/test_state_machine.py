"""Tests for the task status state machine enforced by TaskBoard."""

import pytest

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_project_and_task(state_manager, task_board, title="Task", priority="medium"):
    """Create a project and a single task; return (project_id, task_id)."""
    pid = state_manager.create_project("SM Test", "State machine test project", "api")
    tid = task_board.create_task(pid, title, "Description", "lead-backend", priority)
    return pid, tid


def _status(task_board, pid, tid):
    """Shorthand to fetch the current status of a task."""
    task = task_board.get_task(pid, tid)
    assert task is not None, f"Task {tid} not found in project {pid}"
    return task["status"]


# ---------------------------------------------------------------------------
# Valid transitions
# ---------------------------------------------------------------------------

class TestValidTransitions:
    def test_todo_to_in_progress(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        assert _status(task_board, pid, tid) == "todo"
        assert task_board.update_status(pid, tid, "in_progress")
        assert _status(task_board, pid, tid) == "in_progress"

    def test_todo_to_blocked(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        assert task_board.update_status(pid, tid, "blocked")
        assert _status(task_board, pid, tid) == "blocked"

    def test_in_progress_to_review(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        assert task_board.update_status(pid, tid, "review")
        assert _status(task_board, pid, tid) == "review"

    def test_in_progress_to_done(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        assert task_board.update_status(pid, tid, "done")
        assert _status(task_board, pid, tid) == "done"

    def test_in_progress_to_blocked(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        assert task_board.update_status(pid, tid, "blocked")
        assert _status(task_board, pid, tid) == "blocked"

    def test_review_to_done(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        task_board.update_status(pid, tid, "review")
        assert task_board.update_status(pid, tid, "done")
        assert _status(task_board, pid, tid) == "done"

    def test_review_to_in_progress(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        task_board.update_status(pid, tid, "review")
        assert task_board.update_status(pid, tid, "in_progress")
        assert _status(task_board, pid, tid) == "in_progress"

    def test_review_to_blocked(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        task_board.update_status(pid, tid, "review")
        assert task_board.update_status(pid, tid, "blocked")
        assert _status(task_board, pid, tid) == "blocked"

    def test_blocked_to_todo(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "blocked")
        assert task_board.update_status(pid, tid, "todo")
        assert _status(task_board, pid, tid) == "todo"

    def test_blocked_to_in_progress(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "blocked")
        assert task_board.update_status(pid, tid, "in_progress")
        assert _status(task_board, pid, tid) == "in_progress"


# ---------------------------------------------------------------------------
# Invalid transitions — must all return False without mutating state
# ---------------------------------------------------------------------------

class TestInvalidTransitions:
    def test_todo_to_done_is_rejected(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        result = task_board.update_status(pid, tid, "done")
        assert result is False
        assert _status(task_board, pid, tid) == "todo"

    def test_todo_to_review_is_rejected(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        result = task_board.update_status(pid, tid, "review")
        assert result is False
        assert _status(task_board, pid, tid) == "todo"

    def test_done_to_todo_is_rejected(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        task_board.update_status(pid, tid, "done")
        result = task_board.update_status(pid, tid, "todo")
        assert result is False
        assert _status(task_board, pid, tid) == "done"

    def test_done_to_in_progress_is_rejected(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        task_board.update_status(pid, tid, "done")
        result = task_board.update_status(pid, tid, "in_progress")
        assert result is False
        assert _status(task_board, pid, tid) == "done"

    def test_done_to_review_is_rejected(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        task_board.update_status(pid, tid, "done")
        result = task_board.update_status(pid, tid, "review")
        assert result is False
        assert _status(task_board, pid, tid) == "done"

    def test_done_to_blocked_is_rejected(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        task_board.update_status(pid, tid, "done")
        result = task_board.update_status(pid, tid, "blocked")
        assert result is False
        assert _status(task_board, pid, tid) == "done"

    def test_invalid_status_string_is_rejected(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        result = task_board.update_status(pid, tid, "pending")
        assert result is False
        assert _status(task_board, pid, tid) == "todo"

    def test_uppercase_invalid_status_is_rejected(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        result = task_board.update_status(pid, tid, "DONE")
        # "done" would also be an invalid transition from "todo",
        # but let's confirm the result is False either way
        # (invalid status string or invalid transition)
        assert result is False

    def test_nonexistent_task_returns_false(self, state_manager, task_board):
        pid = state_manager.create_project("P", "desc", "api")
        result = task_board.update_status(pid, "TASK-NOPE", "in_progress")
        assert result is False


# ---------------------------------------------------------------------------
# Dependency enforcement
# ---------------------------------------------------------------------------

class TestDependencyEnforcement:
    def test_cannot_mark_done_while_dependency_is_in_progress(self, state_manager, task_board):
        pid = state_manager.create_project("Dep Test", "desc", "api")
        t_dep = task_board.create_task(pid, "Dependency", "Must finish first", "lead-backend")
        t_main = task_board.create_task(
            pid, "Main Task", "Needs dep", "lead-backend", depends_on=t_dep
        )

        # Advance dependency to in_progress but not done
        task_board.update_status(pid, t_dep, "in_progress")

        # Advance main task to in_progress
        task_board.update_status(pid, t_main, "in_progress")

        # Trying to mark done should fail because dependency is not done
        result = task_board.update_status(pid, t_main, "done")
        assert result is False
        assert _status(task_board, pid, t_main) == "in_progress"

    def test_cannot_move_to_review_while_dependency_is_todo(self, state_manager, task_board):
        pid = state_manager.create_project("Dep Test", "desc", "api")
        t_dep = task_board.create_task(pid, "Dependency", "Must finish first", "lead-backend")
        t_main = task_board.create_task(
            pid, "Main Task", "Needs dep", "lead-backend", depends_on=t_dep
        )

        task_board.update_status(pid, t_main, "in_progress")

        # Dependency is still "todo" — moving main to review should be blocked
        result = task_board.update_status(pid, t_main, "review")
        assert result is False

    def test_can_mark_done_when_all_dependencies_are_done(self, state_manager, task_board):
        pid = state_manager.create_project("Dep Test", "desc", "api")
        t_dep = task_board.create_task(pid, "Dependency", "Must finish first", "lead-backend")
        t_main = task_board.create_task(
            pid, "Main Task", "Needs dep", "lead-backend", depends_on=t_dep
        )

        # Finish the dependency first
        task_board.update_status(pid, t_dep, "in_progress")
        task_board.update_status(pid, t_dep, "done")

        # Now advance the main task
        task_board.update_status(pid, t_main, "in_progress")
        result = task_board.update_status(pid, t_main, "done")
        assert result is True
        assert _status(task_board, pid, t_main) == "done"

    def test_can_mark_review_when_all_dependencies_are_done(self, state_manager, task_board):
        pid = state_manager.create_project("Dep Test", "desc", "api")
        t_dep = task_board.create_task(pid, "Dependency", "Must finish first", "lead-backend")
        t_main = task_board.create_task(
            pid, "Main Task", "Needs dep", "lead-backend", depends_on=t_dep
        )

        task_board.update_status(pid, t_dep, "in_progress")
        task_board.update_status(pid, t_dep, "done")

        task_board.update_status(pid, t_main, "in_progress")
        result = task_board.update_status(pid, t_main, "review")
        assert result is True
        assert _status(task_board, pid, t_main) == "review"

    def test_task_without_dependencies_can_be_done_freely(self, state_manager, task_board):
        pid = state_manager.create_project("NoDep Test", "desc", "api")
        t = task_board.create_task(pid, "No Dep Task", "No deps", "lead-backend")
        task_board.update_status(pid, t, "in_progress")
        result = task_board.update_status(pid, t, "done")
        assert result is True

    def test_multiple_dependencies_all_must_be_done(self, state_manager, task_board):
        pid = state_manager.create_project("Multi-Dep", "desc", "api")
        t1 = task_board.create_task(pid, "Dep 1", "First dep", "lead-backend")
        t2 = task_board.create_task(pid, "Dep 2", "Second dep", "lead-backend")
        t_main = task_board.create_task(
            pid, "Main", "Needs both", "lead-backend", depends_on=f"{t1},{t2}"
        )

        # Finish only one dependency
        task_board.update_status(pid, t1, "in_progress")
        task_board.update_status(pid, t1, "done")

        task_board.update_status(pid, t_main, "in_progress")
        result = task_board.update_status(pid, t_main, "done")
        assert result is False

        # Now finish the second dependency
        task_board.update_status(pid, t2, "in_progress")
        task_board.update_status(pid, t2, "done")
        result = task_board.update_status(pid, t_main, "done")
        assert result is True

    def test_can_move_to_blocked_regardless_of_dependencies(self, state_manager, task_board):
        pid = state_manager.create_project("Dep Test", "desc", "api")
        t_dep = task_board.create_task(pid, "Dependency", "Must finish first", "lead-backend")
        t_main = task_board.create_task(
            pid, "Main Task", "Needs dep", "lead-backend", depends_on=t_dep
        )

        # "blocked" is not gated by dependency check (status not in ("done", "review"))
        result = task_board.update_status(pid, t_main, "blocked")
        assert result is True
        assert _status(task_board, pid, t_main) == "blocked"


# ---------------------------------------------------------------------------
# Notes are appended on status change
# ---------------------------------------------------------------------------

class TestStatusChangeNotes:
    def test_note_is_added_when_provided(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress", notes="Starting work now")
        task = task_board.get_task(pid, tid)
        assert len(task["notes"]) == 1
        assert task["notes"][0]["text"] == "Starting work now"

    def test_note_has_timestamp(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress", notes="Timestamped note")
        task = task_board.get_task(pid, tid)
        assert "at" in task["notes"][0]
        assert task["notes"][0]["at"]  # non-empty timestamp

    def test_no_note_when_notes_param_is_empty(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress")
        task = task_board.get_task(pid, tid)
        assert task["notes"] == []

    def test_multiple_notes_accumulate(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        task_board.update_status(pid, tid, "in_progress", notes="First note")
        task_board.update_status(pid, tid, "review", notes="Second note")
        task = task_board.get_task(pid, tid)
        assert len(task["notes"]) == 2
        assert task["notes"][0]["text"] == "First note"
        assert task["notes"][1]["text"] == "Second note"

    def test_notes_are_not_added_on_failed_transition(self, state_manager, task_board):
        pid, tid = _make_project_and_task(state_manager, task_board)
        # todo -> done is an invalid transition
        task_board.update_status(pid, tid, "done", notes="Should not be saved")
        task = task_board.get_task(pid, tid)
        assert task["notes"] == []
        assert task["status"] == "todo"
