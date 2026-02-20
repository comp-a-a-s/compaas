"""Additional tests for the central agent registry helpers."""

from src.agents import AGENT_REGISTRY, get_agent_display_name, get_all_agent_ids, is_core_agent


def test_get_agent_display_name_returns_registry_name_for_known_slug():
    assert get_agent_display_name("ceo") == AGENT_REGISTRY["ceo"]["name"]


def test_get_agent_display_name_humanizes_unknown_slug():
    assert get_agent_display_name("new-custom-agent") == "New Custom Agent"


def test_get_all_agent_ids_contains_registry_keys():
    ids = get_all_agent_ids()
    assert set(AGENT_REGISTRY).issubset(set(ids))


def test_is_core_agent_true_for_known_and_false_for_unknown():
    assert is_core_agent("cto") is True
    assert is_core_agent("non-existent-agent") is False
