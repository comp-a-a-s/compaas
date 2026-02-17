"""Input validation, path safety, and state machine for ThunderFlow."""

import os
import re


# ---------------------------------------------------------------------------
# Safe ID / path validation
# ---------------------------------------------------------------------------

SAFE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")
SAFE_AGENT_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def validate_safe_id(value: str, field_name: str = "id") -> str:
    """Validate that a value is safe for use in file paths.

    Raises ValueError if the value contains path traversal characters or
    does not match the expected pattern.
    """
    if not value:
        raise ValueError(f"Invalid {field_name}: must not be empty")
    if ".." in value or "/" in value or "\\" in value:
        raise ValueError(f"Invalid {field_name}: path traversal not allowed")
    if not SAFE_ID_PATTERN.match(value):
        raise ValueError(
            f"Invalid {field_name}: must be alphanumeric with hyphens/underscores only, got '{value}'"
        )
    return value


def validate_agent_name(name: str) -> str:
    """Validate an agent name (lowercase, hyphens, alphanumeric)."""
    if not name:
        raise ValueError("Agent name must not be empty")
    if ".." in name or "/" in name or "\\" in name:
        raise ValueError("Invalid agent name: path traversal not allowed")
    if not SAFE_AGENT_NAME_PATTERN.match(name):
        raise ValueError(
            f"Invalid agent name: must be lowercase alphanumeric with hyphens, got '{name}'"
        )
    return name


def safe_path_join(base_dir: str, *parts: str) -> str:
    """Join paths and verify the result is within base_dir.

    Raises ValueError if the resolved path escapes the base directory.
    """
    joined = os.path.join(base_dir, *parts)
    real_base = os.path.realpath(base_dir)
    real_joined = os.path.realpath(joined)
    if not real_joined.startswith(real_base + os.sep) and real_joined != real_base:
        raise ValueError("Path traversal detected: resolved path escapes base directory")
    return joined


# ---------------------------------------------------------------------------
# Enum-style validation
# ---------------------------------------------------------------------------

VALID_STATUSES = {"todo", "in_progress", "review", "done", "blocked"}
VALID_PRIORITIES = {"p0", "p1", "p2", "p3", "low", "medium", "high", "critical"}
VALID_MODELS = {"opus", "sonnet", "haiku"}
VALID_COMPLEXITIES = {"low", "medium", "high", "very_high"}

# Valid status transitions (state machine)
VALID_TRANSITIONS = {
    "todo": {"in_progress", "blocked"},
    "in_progress": {"review", "done", "blocked"},
    "review": {"in_progress", "done", "blocked"},
    "done": set(),
    "blocked": {"todo", "in_progress"},
}


def validate_status(status: str) -> str:
    """Validate and normalise a task status string."""
    s = status.lower()
    if s not in VALID_STATUSES:
        raise ValueError(f"Invalid status '{status}': must be one of {sorted(VALID_STATUSES)}")
    return s


def validate_priority(priority: str) -> str:
    """Validate a task priority string."""
    p = priority.lower()
    if p not in VALID_PRIORITIES:
        raise ValueError(f"Invalid priority '{priority}': must be one of {sorted(VALID_PRIORITIES)}")
    return p


def validate_model(model: str) -> str:
    """Validate a model name string."""
    m = model.lower()
    if m not in VALID_MODELS:
        raise ValueError(f"Invalid model '{model}': must be one of {sorted(VALID_MODELS)}")
    return m


def validate_complexity(complexity: str) -> str:
    """Validate a complexity level string."""
    c = complexity.lower()
    if c not in VALID_COMPLEXITIES:
        raise ValueError(
            f"Invalid complexity '{complexity}': must be one of {sorted(VALID_COMPLEXITIES)}"
        )
    return c


def validate_status_transition(current: str, new: str) -> bool:
    """Check whether a status transition is allowed by the state machine."""
    return new in VALID_TRANSITIONS.get(current, set())


def validate_non_negative_int(value: int, field_name: str = "value") -> int:
    """Validate that an integer is non-negative."""
    if value < 0:
        raise ValueError(f"{field_name} must be non-negative, got {value}")
    return value
