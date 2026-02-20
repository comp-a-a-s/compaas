"""Shared pytest fixtures for COMPaaS test suite."""

import os
import pytest

from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard


@pytest.fixture
def temp_data_dir(tmp_path):
    """Create a temporary data directory and point COMPAAS_DATA_DIR at it.

    Yields the absolute path to the temporary directory and restores the
    original environment variable on teardown.
    """
    data_dir = str(tmp_path / "company_data")
    os.makedirs(os.path.join(data_dir, "projects"), exist_ok=True)

    original = os.environ.get("COMPAAS_DATA_DIR")
    os.environ["COMPAAS_DATA_DIR"] = data_dir
    try:
        yield data_dir
    finally:
        if original is None:
            os.environ.pop("COMPAAS_DATA_DIR", None)
        else:
            os.environ["COMPAAS_DATA_DIR"] = original


@pytest.fixture
def state_manager(temp_data_dir):
    """Return a ProjectStateManager backed by the temporary data directory."""
    return ProjectStateManager(temp_data_dir)


@pytest.fixture
def task_board(temp_data_dir):
    """Return a TaskBoard backed by the temporary data directory."""
    return TaskBoard(temp_data_dir)
