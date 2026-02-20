"""Additional coverage for utility helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
import yaml

import src.utils as utils


def test_atomic_yaml_write_writes_file(tmp_path):
    path = tmp_path / "state.yaml"
    utils.atomic_yaml_write(str(path), {"ok": True, "count": 2})

    with open(path) as f:
        data = yaml.safe_load(f)
    assert data == {"ok": True, "count": 2}


def test_atomic_yaml_write_cleans_temp_file_when_replace_fails(tmp_path, monkeypatch):
    path = tmp_path / "state.yaml"

    def _boom(_src, _dst):
        raise OSError("replace failed")

    monkeypatch.setattr(utils.os, "replace", _boom)

    with pytest.raises(OSError):
        utils.atomic_yaml_write(str(path), {"ok": False})

    leftovers = list(tmp_path.glob("*.yaml.tmp"))
    assert leftovers == []


def test_file_lock_acquires_and_releases(tmp_path):
    lock_target = tmp_path / "resource"

    with utils.FileLock(str(lock_target)) as lock:
        assert lock._fd is not None
        assert os.path.exists(str(lock_target) + ".lock")

    assert lock._fd is None


def test_rotate_log_if_needed_rotates_archives(tmp_path, monkeypatch):
    log_path = tmp_path / "activity.log"
    log_path.write_text("x" * 20)
    (tmp_path / "activity.log.1").write_text("older")

    monkeypatch.setattr(utils, "MAX_LOG_SIZE", 10)
    monkeypatch.setattr(utils, "MAX_LOG_FILES", 3)

    utils.rotate_log_if_needed(str(log_path))

    assert (tmp_path / "activity.log.1").exists()
    assert (tmp_path / "activity.log.2").exists()
    assert (tmp_path / "activity.log").exists() is False


def test_emit_activity_handles_oserror_without_crashing(tmp_path, monkeypatch):
    data_dir = str(tmp_path / "company_data")

    def _raise_oserror(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("builtins.open", _raise_oserror)

    # Should not raise despite open() failing.
    utils.emit_activity(data_dir, "agent", "ACTION", "detail")


def test_emit_activity_writes_valid_json_line(tmp_path):
    data_dir = str(tmp_path / "company_data")
    utils.emit_activity(data_dir, "qa", "COMPLETED", "all tests green")

    log_path = Path(data_dir) / "activity.log"
    with open(log_path) as f:
        line = f.readline().strip()
    event = json.loads(line)
    assert event["agent"] == "qa"
    assert event["action"] == "COMPLETED"
