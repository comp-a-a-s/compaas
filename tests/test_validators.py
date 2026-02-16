"""Tests for src/validators.py — ID safety, path joining, and enum validation."""

import os
import pytest

from src.validators import (
    validate_safe_id,
    validate_agent_name,
    safe_path_join,
    validate_status,
    validate_priority,
    validate_model,
    validate_complexity,
    validate_status_transition,
    validate_non_negative_int,
    VALID_STATUSES,
    VALID_PRIORITIES,
    VALID_MODELS,
    VALID_COMPLEXITIES,
    VALID_TRANSITIONS,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

class TestConstants:
    def test_valid_statuses_contains_expected_values(self):
        assert VALID_STATUSES == {"todo", "in_progress", "review", "done", "blocked"}

    def test_valid_priorities_contains_expected_values(self):
        assert "low" in VALID_PRIORITIES
        assert "medium" in VALID_PRIORITIES
        assert "high" in VALID_PRIORITIES
        assert "critical" in VALID_PRIORITIES
        assert "p0" in VALID_PRIORITIES
        assert "p1" in VALID_PRIORITIES
        assert "p2" in VALID_PRIORITIES
        assert "p3" in VALID_PRIORITIES

    def test_valid_models_contains_expected_values(self):
        assert VALID_MODELS == {"opus", "sonnet", "haiku"}

    def test_valid_complexities_contains_expected_values(self):
        assert VALID_COMPLEXITIES == {"low", "medium", "high", "very_high"}

    def test_valid_transitions_has_all_status_keys(self):
        for status in VALID_STATUSES:
            assert status in VALID_TRANSITIONS, f"Status '{status}' missing from VALID_TRANSITIONS"

    def test_done_status_has_no_outgoing_transitions(self):
        assert VALID_TRANSITIONS["done"] == set()

    def test_valid_transitions_targets_are_valid_statuses(self):
        for src, targets in VALID_TRANSITIONS.items():
            for tgt in targets:
                assert tgt in VALID_STATUSES, (
                    f"Transition target '{tgt}' from '{src}' is not a valid status"
                )


# ---------------------------------------------------------------------------
# validate_safe_id
# ---------------------------------------------------------------------------

class TestValidateSafeId:
    def test_accepts_simple_alphanumeric(self):
        assert validate_safe_id("abc123") == "abc123"

    def test_accepts_hyphens_and_underscores(self):
        assert validate_safe_id("my-project_id") == "my-project_id"

    def test_accepts_uuid_prefix(self):
        assert validate_safe_id("a1b2c3d4") == "a1b2c3d4"

    def test_accepts_uppercase(self):
        assert validate_safe_id("TASK-001") == "TASK-001"

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError, match="must not be empty"):
            validate_safe_id("", "project_id")

    def test_rejects_double_dot(self):
        with pytest.raises(ValueError, match="path traversal not allowed"):
            validate_safe_id("../secret", "project_id")

    def test_rejects_forward_slash(self):
        with pytest.raises(ValueError, match="path traversal not allowed"):
            validate_safe_id("foo/bar", "project_id")

    def test_rejects_backslash(self):
        with pytest.raises(ValueError, match="path traversal not allowed"):
            validate_safe_id("foo\\bar", "project_id")

    def test_rejects_leading_hyphen(self):
        with pytest.raises(ValueError):
            validate_safe_id("-bad", "id")

    def test_rejects_space(self):
        with pytest.raises(ValueError):
            validate_safe_id("bad id", "id")

    def test_rejects_special_characters(self):
        for bad in ("foo@bar", "foo!bar", "foo#bar", "foo$bar"):
            with pytest.raises(ValueError):
                validate_safe_id(bad, "id")

    def test_field_name_appears_in_error_message(self):
        with pytest.raises(ValueError, match="project_id"):
            validate_safe_id("", "project_id")

    def test_returns_the_original_value_on_success(self):
        result = validate_safe_id("valid-ID_123")
        assert result == "valid-ID_123"


# ---------------------------------------------------------------------------
# validate_agent_name
# ---------------------------------------------------------------------------

class TestValidateAgentName:
    def test_accepts_lowercase_alphanumeric(self):
        assert validate_agent_name("backend") == "backend"

    def test_accepts_lowercase_with_hyphens(self):
        assert validate_agent_name("ml-engineer") == "ml-engineer"

    def test_accepts_name_starting_with_digit(self):
        # Pattern allows [a-z0-9][a-z0-9-]* so digit-first is valid
        assert validate_agent_name("2fa-agent") == "2fa-agent"

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError, match="must not be empty"):
            validate_agent_name("")

    def test_rejects_uppercase(self):
        with pytest.raises(ValueError, match="lowercase"):
            validate_agent_name("Lead-Backend")

    def test_rejects_underscore(self):
        with pytest.raises(ValueError, match="lowercase"):
            validate_agent_name("lead_backend")

    def test_rejects_double_dot(self):
        with pytest.raises(ValueError, match="path traversal not allowed"):
            validate_agent_name("../hack")

    def test_rejects_forward_slash(self):
        with pytest.raises(ValueError, match="path traversal not allowed"):
            validate_agent_name("etc/passwd")

    def test_rejects_backslash(self):
        with pytest.raises(ValueError, match="path traversal not allowed"):
            validate_agent_name("etc\\passwd")

    def test_rejects_space(self):
        with pytest.raises(ValueError):
            validate_agent_name("ml engineer")

    def test_returns_the_original_value_on_success(self):
        result = validate_agent_name("my-agent-01")
        assert result == "my-agent-01"


# ---------------------------------------------------------------------------
# safe_path_join
# ---------------------------------------------------------------------------

class TestSafePathJoin:
    def test_simple_join_stays_within_base(self, tmp_path):
        base = str(tmp_path)
        result = safe_path_join(base, "projects", "abc123")
        assert result.startswith(base)

    def test_returns_joined_path(self, tmp_path):
        base = str(tmp_path)
        result = safe_path_join(base, "sub", "file.yaml")
        assert result == os.path.join(base, "sub", "file.yaml")

    def test_single_part(self, tmp_path):
        base = str(tmp_path)
        result = safe_path_join(base, "myfile")
        assert result == os.path.join(base, "myfile")

    def test_rejects_double_dot_escape(self, tmp_path):
        base = str(tmp_path)
        with pytest.raises(ValueError, match="Path traversal detected"):
            safe_path_join(base, "..", "etc", "passwd")

    def test_rejects_deep_traversal(self, tmp_path):
        base = str(tmp_path)
        with pytest.raises(ValueError, match="Path traversal detected"):
            safe_path_join(base, "projects", "..", "..", "etc")

    def test_base_dir_itself_is_allowed(self, tmp_path):
        base = str(tmp_path)
        # Joining with an empty suffix produces the base dir itself
        result = safe_path_join(base)
        assert result == base


# ---------------------------------------------------------------------------
# validate_status
# ---------------------------------------------------------------------------

class TestValidateStatus:
    @pytest.mark.parametrize("status", ["todo", "in_progress", "review", "done", "blocked"])
    def test_accepts_all_valid_statuses(self, status):
        assert validate_status(status) == status

    def test_normalises_uppercase_to_lowercase(self):
        assert validate_status("TODO") == "todo"
        assert validate_status("In_Progress") == "in_progress"

    def test_rejects_unknown_status(self):
        with pytest.raises(ValueError, match="Invalid status"):
            validate_status("pending")

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError):
            validate_status("")

    def test_error_message_includes_valid_options(self):
        with pytest.raises(ValueError, match="todo"):
            validate_status("invalid")


# ---------------------------------------------------------------------------
# validate_priority
# ---------------------------------------------------------------------------

class TestValidatePriority:
    @pytest.mark.parametrize("priority", ["low", "medium", "high", "critical", "p0", "p1", "p2", "p3"])
    def test_accepts_all_valid_priorities(self, priority):
        assert validate_priority(priority) == priority

    def test_normalises_uppercase_to_lowercase(self):
        assert validate_priority("HIGH") == "high"
        assert validate_priority("P0") == "p0"

    def test_rejects_unknown_priority(self):
        with pytest.raises(ValueError, match="Invalid priority"):
            validate_priority("urgent")

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError):
            validate_priority("")


# ---------------------------------------------------------------------------
# validate_model
# ---------------------------------------------------------------------------

class TestValidateModel:
    @pytest.mark.parametrize("model", ["opus", "sonnet", "haiku"])
    def test_accepts_all_valid_models(self, model):
        assert validate_model(model) == model

    def test_normalises_uppercase_to_lowercase(self):
        assert validate_model("OPUS") == "opus"
        assert validate_model("Sonnet") == "sonnet"

    def test_rejects_unknown_model(self):
        with pytest.raises(ValueError, match="Invalid model"):
            validate_model("gpt4")

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError):
            validate_model("")

    def test_error_message_lists_valid_models(self):
        with pytest.raises(ValueError, match="opus"):
            validate_model("unknown")


# ---------------------------------------------------------------------------
# validate_complexity
# ---------------------------------------------------------------------------

class TestValidateComplexity:
    @pytest.mark.parametrize("complexity", ["low", "medium", "high", "very_high"])
    def test_accepts_all_valid_complexities(self, complexity):
        assert validate_complexity(complexity) == complexity

    def test_normalises_uppercase_to_lowercase(self):
        assert validate_complexity("HIGH") == "high"
        assert validate_complexity("VERY_HIGH") == "very_high"

    def test_rejects_unknown_complexity(self):
        with pytest.raises(ValueError, match="Invalid complexity"):
            validate_complexity("extreme")

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError):
            validate_complexity("")


# ---------------------------------------------------------------------------
# validate_status_transition
# ---------------------------------------------------------------------------

class TestValidateStatusTransition:
    # Valid forward transitions
    def test_todo_to_in_progress_is_valid(self):
        assert validate_status_transition("todo", "in_progress") is True

    def test_todo_to_blocked_is_valid(self):
        assert validate_status_transition("todo", "blocked") is True

    def test_in_progress_to_review_is_valid(self):
        assert validate_status_transition("in_progress", "review") is True

    def test_in_progress_to_done_is_valid(self):
        assert validate_status_transition("in_progress", "done") is True

    def test_in_progress_to_blocked_is_valid(self):
        assert validate_status_transition("in_progress", "blocked") is True

    def test_review_to_done_is_valid(self):
        assert validate_status_transition("review", "done") is True

    def test_review_to_in_progress_is_valid(self):
        assert validate_status_transition("review", "in_progress") is True

    def test_review_to_blocked_is_valid(self):
        assert validate_status_transition("review", "blocked") is True

    def test_blocked_to_todo_is_valid(self):
        assert validate_status_transition("blocked", "todo") is True

    def test_blocked_to_in_progress_is_valid(self):
        assert validate_status_transition("blocked", "in_progress") is True

    # Invalid transitions
    def test_todo_to_done_is_invalid(self):
        assert validate_status_transition("todo", "done") is False

    def test_todo_to_review_is_invalid(self):
        assert validate_status_transition("todo", "review") is False

    def test_done_to_todo_is_invalid(self):
        assert validate_status_transition("done", "todo") is False

    def test_done_to_in_progress_is_invalid(self):
        assert validate_status_transition("done", "in_progress") is False

    def test_done_to_review_is_invalid(self):
        assert validate_status_transition("done", "review") is False

    def test_done_to_blocked_is_invalid(self):
        assert validate_status_transition("done", "blocked") is False

    def test_unknown_source_status_returns_false(self):
        assert validate_status_transition("nonexistent", "done") is False

    def test_unknown_target_status_returns_false(self):
        assert validate_status_transition("todo", "nonexistent") is False

    def test_same_status_transition_is_invalid(self):
        # None of the transitions allow staying in the same state
        for status in VALID_STATUSES:
            assert validate_status_transition(status, status) is False, (
                f"Self-transition for '{status}' should be invalid"
            )


# ---------------------------------------------------------------------------
# validate_non_negative_int
# ---------------------------------------------------------------------------

class TestValidateNonNegativeInt:
    def test_accepts_zero(self):
        assert validate_non_negative_int(0) == 0

    def test_accepts_positive_int(self):
        assert validate_non_negative_int(42) == 42

    def test_accepts_large_int(self):
        assert validate_non_negative_int(1_000_000) == 1_000_000

    def test_rejects_negative_one(self):
        with pytest.raises(ValueError, match="non-negative"):
            validate_non_negative_int(-1)

    def test_rejects_large_negative(self):
        with pytest.raises(ValueError, match="non-negative"):
            validate_non_negative_int(-9999)

    def test_field_name_appears_in_error(self):
        with pytest.raises(ValueError, match="token_count"):
            validate_non_negative_int(-5, "token_count")

    def test_returns_original_value_on_success(self):
        assert validate_non_negative_int(7, "score") == 7
