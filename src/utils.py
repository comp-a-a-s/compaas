"""Shared utilities for the CrackPie system."""

import os
import fcntl
import tempfile
import yaml


# ---------------------------------------------------------------------------
# Directory resolution
# ---------------------------------------------------------------------------

def resolve_data_dir() -> str:
    """Resolve the company_data directory to an absolute path.

    Priority:
    1. CRACKPIE_DATA_DIR environment variable
    2. ./company_data relative to the project root (where pyproject.toml lives)
    3. ./company_data relative to the current working directory
    """
    env_dir = os.environ.get("CRACKPIE_DATA_DIR")
    if env_dir:
        abs_dir = os.path.abspath(env_dir)
        return abs_dir

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


# ---------------------------------------------------------------------------
# Atomic YAML file operations
# ---------------------------------------------------------------------------

def atomic_yaml_write(path: str, data: dict) -> None:
    """Write YAML data atomically using tempfile + os.replace.

    This prevents partial writes from corrupting YAML files.
    """
    dir_name = os.path.dirname(path)
    os.makedirs(dir_name, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".yaml.tmp")
    try:
        with os.fdopen(fd, "w") as f:
            yaml.dump(data, f, default_flow_style=False)
        os.replace(tmp_path, path)  # atomic on POSIX
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# File locking
# ---------------------------------------------------------------------------

class FileLock:
    """Advisory file lock using fcntl for safe concurrent access."""

    def __init__(self, path: str):
        self.lock_path = path + ".lock"
        self._fd = None

    def __enter__(self):
        dir_name = os.path.dirname(self.lock_path)
        if dir_name:
            os.makedirs(dir_name, exist_ok=True)
        self._fd = open(self.lock_path, "w")
        fcntl.flock(self._fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *args):
        if self._fd:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            self._fd.close()
            self._fd = None


# ---------------------------------------------------------------------------
# Log rotation
# ---------------------------------------------------------------------------

MAX_LOG_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_LOG_FILES = 5


def rotate_log_if_needed(log_path: str) -> None:
    """Rotate the log file if it exceeds MAX_LOG_SIZE."""
    if not os.path.exists(log_path):
        return
    try:
        if os.path.getsize(log_path) <= MAX_LOG_SIZE:
            return
    except OSError:
        return

    # Rotate existing archives
    for i in range(MAX_LOG_FILES - 1, 0, -1):
        src = f"{log_path}.{i}"
        dst = f"{log_path}.{i + 1}"
        if os.path.exists(src):
            os.replace(src, dst)

    # Move current log to .1
    os.replace(log_path, f"{log_path}.1")


# ---------------------------------------------------------------------------
# Activity logging — emit events to activity.log for the SSE stream
# ---------------------------------------------------------------------------

def emit_activity(data_dir: str, agent: str, action: str, detail: str = "") -> None:
    """Append a structured JSON line to activity.log.

    Events are consumed by the SSE ``/api/activity/stream`` endpoint and
    the TUI ActivityPanel.  The format is JSON so both consumers can
    parse events reliably.
    """
    import json
    from datetime import datetime, timezone

    log_path = os.path.join(data_dir, "activity.log")
    os.makedirs(data_dir, exist_ok=True)
    rotate_log_if_needed(log_path)

    event = json.dumps({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agent": agent,
        "action": action,
        "detail": detail,
    })

    try:
        with open(log_path, "a") as f:
            f.write(event + "\n")
    except OSError:
        pass  # Best-effort — never crash the tool call
