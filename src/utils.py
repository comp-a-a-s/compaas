"""Shared utilities for the CrackPie system."""

import os


def resolve_data_dir() -> str:
    """Resolve the company_data directory to an absolute path.

    Priority:
    1. CRACKPIE_DATA_DIR environment variable
    2. ./company_data relative to the project root (where pyproject.toml lives)
    3. ./company_data relative to the current working directory
    """
    env_dir = os.environ.get("CRACKPIE_DATA_DIR")
    if env_dir:
        return os.path.abspath(env_dir)

    # Walk up from the caller's file location to find the project root
    current = os.path.dirname(os.path.abspath(__file__))
    while current != os.path.dirname(current):  # stop at filesystem root
        if os.path.exists(os.path.join(current, "pyproject.toml")):
            return os.path.join(current, "company_data")
        current = os.path.dirname(current)

    # Fallback: relative to CWD
    return os.path.abspath("./company_data")


def resolve_project_root() -> str:
    """Resolve the project root directory (where pyproject.toml lives)."""
    current = os.path.dirname(os.path.abspath(__file__))
    while current != os.path.dirname(current):
        if os.path.exists(os.path.join(current, "pyproject.toml")):
            return current
        current = os.path.dirname(current)
    return os.path.abspath(".")
