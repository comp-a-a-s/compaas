"""Focused tests for provider-specific chat handlers in web.api."""

from __future__ import annotations

import asyncio
import json
import os

import pytest
from fastapi import WebSocketDisconnect

import src.web.api as api
import src.llm_provider as llm_provider
from src.state.project_state import ProjectStateManager
from src.state.task_board import TaskBoard
from src.web.services.project_service import ProjectService
from src.web.services.run_service import RunService
from src.web.settings import RuntimeSettings


class _FakeWebSocket:
    def __init__(self) -> None:
        self.events: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.events.append(payload)


class _FakeChatWebSocket:
    def __init__(self, inbound_messages: list[dict]) -> None:
        self._inbound = [json.dumps(msg) for msg in inbound_messages]
        self.events: list[dict] = []
        self.accepted = False
        self.closed = False

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        if self._inbound:
            return self._inbound.pop(0)
        raise WebSocketDisconnect()

    async def send_json(self, payload: dict) -> None:
        self.events.append(payload)

    async def close(self) -> None:
        self.closed = True


class _FakeStdout:
    def __init__(self, lines: list[str]) -> None:
        self._lines = [line.encode("utf-8") + b"\n" for line in lines]
        self._index = 0

    async def readline(self) -> bytes:
        if self._index >= len(self._lines):
            return b""
        line = self._lines[self._index]
        self._index += 1
        return line


class _FakeStderr:
    def __init__(self, text: str = "") -> None:
        self._text = text.encode("utf-8")

    async def read(self) -> bytes:
        return self._text


class _FakeProcess:
    def __init__(self, lines: list[str], returncode: int = 0, stderr: str = "") -> None:
        self.stdout = _FakeStdout(lines)
        self.stderr = _FakeStderr(stderr)
        self.returncode = returncode

    async def wait(self) -> int:
        return self.returncode

    def kill(self) -> None:
        if self.returncode is None:
            self.returncode = -9


def test_classify_execution_intent_treats_difficulty_question_as_planning():
    intent = api._classify_execution_intent(
        "id like to understand how difficult will be to build a career growth tracker"
    )
    assert intent["intent"] == "planning"
    assert intent["class"] == "planning"
    assert intent["needs_planning"] is True


@pytest.mark.parametrize(
    "message",
    [
        "Can you estimate the effort and timeline for building a B2B onboarding portal?",
        "Give me a rough order of magnitude for a healthcare scheduling app.",
        "What would it take to build a data governance dashboard?",
        "I need discovery and requirements for a mobile expense tracker.",
        "Please provide feasibility and tradeoff analysis for launching this feature.",
    ],
)
def test_classify_execution_intent_discovery_keywords_route_to_planning(message: str):
    intent = api._classify_execution_intent(message)
    assert intent["intent"] == "planning"
    assert intent["class"] == "planning"
    assert intent["needs_planning"] is True


def test_infer_support_agents_avoids_substring_false_positive_from_build():
    message = "id like to understand how difficult will be to build a career growth tracker"
    intent = api._classify_execution_intent(message)
    agents = api._infer_support_agents(
        message,
        intent=intent,
        project={"status": "active", "plan_approved": True},
        config={"chat_policy": {"delegation_strategy": "executive_first"}},
    )
    assert "chief-researcher" in agents
    assert "cto" in agents
    assert "vp-engineering" in agents
    assert "lead-frontend" not in agents
    assert "qa-lead" not in agents


def test_infer_support_agents_planning_includes_vp_product():
    message = "Can you estimate scope and milestones for a career growth tracker?"
    intent = api._classify_execution_intent(message)
    agents = api._infer_support_agents(
        message,
        intent=intent,
        project={"status": "planning", "plan_approved": False},
        config={"chat_policy": {"delegation_strategy": "executive_first"}},
    )
    assert "chief-researcher" in agents
    assert "vp-product" in agents
    assert "cto" in agents
    assert "qa-lead" not in agents


def test_build_delegation_reasoning_returns_executive_alignment_summary():
    message = "Can you estimate scope and timeline for a career growth tracker?"
    intent = api._classify_execution_intent(message)
    support_agents = ["chief-researcher", "vp-product", "cto"]
    reasoning = api._build_delegation_reasoning(
        message,
        intent=intent,
        project={"status": "planning", "plan_approved": False},
        config={},
        support_agents=support_agents,
    )
    assert reasoning["stage"] == "executive_alignment"
    assert "Executive alignment first" in reasoning["summary"]
    assert len(reasoning["reasons"]) == len(support_agents)
    assert any(item.get("agent_id") == "vp-product" for item in reasoning["reasons"])


def test_build_delegation_reasoning_returns_validation_summary():
    message = "Run QA regression and prepare release notes."
    intent = api._classify_execution_intent(message)
    support_agents = ["qa-lead", "tech-writer"]
    reasoning = api._build_delegation_reasoning(
        message,
        intent=intent,
        project={"status": "active", "plan_approved": True},
        config={},
        support_agents=support_agents,
    )
    assert reasoning["stage"] == "validation_handoff"
    assert "Validation and handoff stage" in reasoning["summary"]


def test_infer_support_agents_execution_uses_executive_first_on_early_stage():
    intent = {
        "intent": "execution",
        "class": "execution",
        "actionable": True,
        "delegate_allowed": True,
    }
    agents = api._infer_support_agents(
        "Build a tiny notes app with auth.",
        intent=intent,
        project={"status": "planning"},
        config={"chat_policy": {"delegation_strategy": "executive_first"}},
    )
    assert "chief-researcher" in agents
    assert "cto" in agents
    assert "vp-engineering" in agents
    assert "qa-lead" not in agents
    assert "tech-writer" not in agents


def test_infer_support_agents_execution_uses_delivery_defaults_on_active_stage():
    intent = {
        "intent": "execution",
        "class": "execution",
        "actionable": True,
        "delegate_allowed": True,
    }
    agents = api._infer_support_agents(
        "Build frontend UI and backend API endpoints.",
        intent=intent,
        project={"status": "active", "plan_approved": True},
        config={"chat_policy": {"delegation_strategy": "executive_first"}},
    )
    assert "lead-frontend" in agents
    assert "lead-backend" in agents
    assert "qa-lead" not in agents
    assert "tech-writer" not in agents


def test_infer_support_agents_execution_adds_qa_docs_for_validation_stage():
    intent = {
        "intent": "execution",
        "class": "execution",
        "actionable": True,
        "delegate_allowed": True,
    }
    agents = api._infer_support_agents(
        "Run QA regression, verify auth flow, and prepare handoff docs.",
        intent=intent,
        project={"status": "active"},
        config={"chat_policy": {"delegation_strategy": "executive_first"}},
    )
    assert "qa-lead" in agents
    assert "tech-writer" in agents


def test_infer_support_agents_execution_defaults_to_designer_for_app_ui_work():
    intent = {
        "intent": "execution",
        "class": "execution",
        "actionable": True,
        "delegate_allowed": True,
    }
    agents = api._infer_support_agents(
        "Build a budgeting app dashboard with polished onboarding flow.",
        intent=intent,
        project={"status": "active", "plan_approved": True},
        config={"chat_policy": {"delegation_strategy": "executive_first"}},
    )
    assert "lead-designer" in agents


def test_infer_support_agents_execution_skips_designer_for_backend_only_turn():
    intent = {
        "intent": "execution",
        "class": "execution",
        "actionable": True,
        "delegate_allowed": True,
    }
    agents = api._infer_support_agents(
        "Implement backend API auth and database migration scripts.",
        intent=intent,
        project={"status": "active", "plan_approved": True},
        config={"chat_policy": {"delegation_strategy": "executive_first"}},
    )
    assert "lead-designer" not in agents


def test_infer_support_agents_direct_strategy_skips_default_qa_docs():
    intent = {
        "intent": "execution",
        "class": "execution",
        "actionable": True,
        "delegate_allowed": True,
    }
    agents = api._infer_support_agents(
        "Implement backend auth endpoint.",
        intent=intent,
        project={"status": "active"},
        config={"chat_policy": {"delegation_strategy": "direct"}},
    )
    assert "lead-backend" in agents
    assert "qa-lead" not in agents
    assert "tech-writer" not in agents


def test_infer_support_agents_respects_configured_max_agents():
    intent = {
        "intent": "execution",
        "class": "execution",
        "actionable": True,
        "delegate_allowed": True,
    }
    agents = api._infer_support_agents(
        "Build frontend and backend, run QA tests, and write docs.",
        intent=intent,
        project={"status": "active"},
        config={"chat_policy": {"delegation_strategy": "balanced", "delegation_max_agents": 2}},
    )
    assert len(agents) == 2


@pytest.mark.asyncio
async def test_handle_ceo_claude_apikey_mode_requires_key():
    ws = _FakeWebSocket()

    result = await api._handle_ceo_claude(
        websocket=ws,
        prompt="hello",
        claude_path="/usr/bin/claude",
        llm_cfg={"anthropic_mode": "apikey", "api_key": ""},
        ceo_name="Marcus",
    )

    assert result is None
    assert ws.events
    assert ws.events[-1]["type"] == "error"
    assert "no API key is configured" in ws.events[-1]["content"]


@pytest.mark.asyncio
async def test_handle_ceo_claude_streams_chunks_actions_and_results(monkeypatch):
    captured_env: dict = {}
    captured_cmd: list[str] = []
    lines = [
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "Hello from CEO. "},
                        {"type": "tool_use", "name": "Read", "input": {"file_path": "README.md"}},
                    ]
                },
            }
        ),
        json.dumps(
            {
                "type": "user",
                "message": {"content": [{"type": "tool_result", "content": [{"type": "text", "text": "All good"}]}]},
            }
        ),
        json.dumps({"type": "result", "result": "Final CEO answer"}),
    ]

    async def _fake_create_subprocess_exec(*_args, **kwargs):
        captured_cmd.extend(list(_args))
        captured_env.update(kwargs.get("env") or {})
        return _FakeProcess(lines=lines, returncode=0)

    monkeypatch.setattr(api.asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_claude(
        websocket=ws,
        prompt="run",
        claude_path="/usr/bin/claude",
        llm_cfg={"anthropic_mode": "apikey", "api_key": "anthropic-test-key"},
        ceo_name="Marcus",
    )

    assert result == "Final CEO answer"
    assert captured_env.get("ANTHROPIC_API_KEY") == "anthropic-test-key"
    assert "--agent" in captured_cmd
    assert "ceo" in captured_cmd
    assert "--permission-mode" in captured_cmd
    assert "bypassPermissions" in captured_cmd
    assert "--dangerously-skip-permissions" in captured_cmd
    assert "--disallowed-tools" in captured_cmd
    assert "AskUserQuestion" in captured_cmd
    event_types = [event["type"] for event in ws.events]
    assert "chunk" in event_types
    assert "action" in event_types
    assert "action_result" in event_types


@pytest.mark.asyncio
async def test_handle_ceo_claude_retries_incomplete_clarification_stub(monkeypatch):
    calls = {"count": 0}
    captured_cmds: list[list[str]] = []
    first_attempt_lines = [
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "Before I mobilize the team, I need to understand a few things:"},
                        {"type": "tool_use", "name": "AskUserQuestion", "input": {"question": "Who is the audience?"}},
                    ]
                },
            }
        ),
        json.dumps(
            {
                "type": "result",
                "result": (
                    "Idan, that's a great ambition — let me narrow it down so we build the right thing fast.\n\n"
                    "Before I mobilize the team, I need to understand a few things:"
                ),
            }
        ),
    ]
    second_attempt_lines = [
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "Assumptions: SMB audience, low-ticket offer, and subscription path. "},
                    ]
                },
            }
        ),
        json.dumps(
            {
                "type": "result",
                "result": (
                    "Assumptions: SMB audience, low-ticket offer, and subscription path.\n\n"
                    "I will proceed to build an MVP landing + checkout flow now."
                ),
            }
        ),
    ]

    async def _fake_create_subprocess_exec(*_args, **_kwargs):
        calls["count"] += 1
        captured_cmds.append(list(_args))
        if calls["count"] == 1:
            return _FakeProcess(lines=first_attempt_lines, returncode=0)
        return _FakeProcess(lines=second_attempt_lines, returncode=0)

    monkeypatch.setattr(api.asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)
    monkeypatch.setattr(api, "_emit_chat_activity", lambda *args, **kwargs: None)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_claude(
        websocket=ws,
        prompt="build me an app that makes money",
        claude_path="/usr/bin/claude",
        llm_cfg={"anthropic_mode": "cli"},
        ceo_name="Marcus",
    )

    assert calls["count"] == 2
    assert result is not None
    assert "proceed to build" in result.lower()
    assert not result.strip().endswith(":")
    assert all("--disallowed-tools" in cmd and "AskUserQuestion" in cmd for cmd in captured_cmds)
    assert any(
        event.get("type") == "warning"
        and "assumption-first execution" in str(event.get("content", "")).lower()
        for event in ws.events
    )


def test_is_passive_waiting_response_detects_standby_only_updates():
    assert api._is_passive_waiting_response(
        "Good — both Jessica and Marissa are working in parallel. I'll wait for both to deliver. Standing by."
    )
    assert not api._is_passive_waiting_response(
        "Outcome: Build complete.\nRun Commands:\n- npm run dev\nOpen Links:\n- http://localhost:5173"
    )


@pytest.mark.asyncio
async def test_handle_ceo_claude_retries_passive_waiting_response(monkeypatch):
    calls = {"count": 0}
    passive_lines = [
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "Good — both Jessica (design) and Marissa (product) are working in parallel. "
                                "I'll wait for both to deliver before briefing Sheryl on the build. Standing by."
                            ),
                        }
                    ]
                },
            }
        ),
        json.dumps(
            {
                "type": "result",
                "result": (
                    "Good — both Jessica (design) and Marissa (product) are working in parallel. "
                    "I'll wait for both to deliver before briefing Sheryl on the build. Standing by."
                ),
            }
        ),
    ]
    active_lines = [
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "Proceeding now with implementation using default assumptions. "},
                    ]
                },
            }
        ),
        json.dumps(
            {
                "type": "result",
                "result": (
                    "Proceeding now with implementation using default assumptions.\n\n"
                    "Outcome: MVP implementation in progress with active delivery checkpoints."
                ),
            }
        ),
    ]

    async def _fake_create_subprocess_exec(*_args, **_kwargs):
        calls["count"] += 1
        return _FakeProcess(lines=passive_lines if calls["count"] == 1 else active_lines, returncode=0)

    monkeypatch.setattr(api.asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)
    monkeypatch.setattr(api, "_emit_chat_activity", lambda *args, **kwargs: None)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_claude(
        websocket=ws,
        prompt="build a web app",
        claude_path="/usr/bin/claude",
        llm_cfg={"anthropic_mode": "cli", "claude_passive_retry_max": 3},
        ceo_name="Marcus",
        user_message="build a web app",
        intent={"intent": "execution", "actionable": True},
    )

    assert calls["count"] == 2
    assert result is not None
    assert "proceeding now with implementation" in result.lower()
    assert any(
        event.get("type") == "warning"
        and "passive waiting response detected" in str(event.get("content", "")).lower()
        for event in ws.events
    )


@pytest.mark.asyncio
async def test_handle_ceo_claude_fails_after_passive_retry_exhausted(monkeypatch):
    calls = {"count": 0}
    passive_text = (
        "All teams are working in parallel. I'll wait for both to deliver and report back. Standing by."
    )
    passive_lines = [
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": passive_text}]}}),
        json.dumps({"type": "result", "result": passive_text}),
    ]

    async def _fake_create_subprocess_exec(*_args, **_kwargs):
        calls["count"] += 1
        return _FakeProcess(lines=passive_lines, returncode=0)

    monkeypatch.setattr(api.asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)
    monkeypatch.setattr(api, "_emit_chat_activity", lambda *args, **kwargs: None)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_claude(
        websocket=ws,
        prompt="build a web app",
        claude_path="/usr/bin/claude",
        llm_cfg={"anthropic_mode": "cli", "claude_passive_retry_max": 3},
        ceo_name="Marcus",
        run_id="run-passive",
        project_id="project123",
        user_message="build a web app",
        intent={"intent": "execution", "actionable": True},
    )

    assert calls["count"] == 3
    assert result is None
    assert any(
        event.get("type") == "error"
        and "stopped to prevent a silent stall" in str(event.get("content", "")).lower()
        for event in ws.events
    )


@pytest.mark.asyncio
async def test_handle_ceo_claude_empty_response_returns_fallback(monkeypatch):
    async def _fake_create_subprocess_exec(*_args, **_kwargs):
        return _FakeProcess(lines=[], returncode=0)

    monkeypatch.setattr(api.asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_claude(
        websocket=ws,
        prompt="run",
        claude_path="/usr/bin/claude",
        llm_cfg={"anthropic_mode": "cli"},
        ceo_name="Marcus",
    )

    assert result is not None
    assert "no assistant summary text" in result.lower()
    assert any(
        event["type"] == "action_result" and "empty response" in str(event.get("content", "")).lower()
        for event in ws.events
    )


@pytest.mark.asyncio
async def test_handle_ceo_claude_micro_mode_keeps_ceo_agent_and_warns_on_tool_use(monkeypatch):
    captured_cmd: list[str] = []
    lines = [
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "Fast solo answer. "},
                        {"type": "tool_use", "name": "Task", "input": {"subagent_type": "qa-lead"}},
                    ]
                },
            }
        ),
        json.dumps({"type": "result", "result": "Fast solo answer."}),
    ]

    async def _fake_create_subprocess_exec(*_args, **_kwargs):
        captured_cmd.extend(list(_args))
        return _FakeProcess(lines=lines, returncode=0)

    monkeypatch.setattr(api.asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_claude(
        websocket=ws,
        prompt="micro run",
        claude_path="/usr/bin/claude",
        llm_cfg={"anthropic_mode": "cli"},
        ceo_name="Marcus",
        micro_project_mode=True,
    )

    assert result == "Fast solo answer."
    assert "--agent" in captured_cmd
    assert "ceo" in captured_cmd
    event_types = [event["type"] for event in ws.events]
    assert "action" in event_types
    assert "chunk" in event_types
    assert "micro_project_warning" in event_types


@pytest.mark.asyncio
async def test_handle_ceo_claude_emits_synthetic_delegation_when_no_real_task_tool(monkeypatch):
    lines = [
        json.dumps(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "I will proceed with the build now."}]},
            }
        ),
        json.dumps({"type": "result", "result": "Build initiated."}),
    ]

    async def _fake_create_subprocess_exec(*_args, **_kwargs):
        return _FakeProcess(lines=lines, returncode=0)

    monkeypatch.setattr(api.asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)
    monkeypatch.setattr(api, "_emit_chat_activity", lambda *args, **kwargs: None)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_claude(
        websocket=ws,
        prompt="run",
        claude_path="/usr/bin/claude",
        llm_cfg={"anthropic_mode": "cli"},
        ceo_name="Marcus",
        project_id="abcd1234",
        run_id="run-1",
        user_message="Build a landing page app",
        support_agents=["lead-frontend", "lead-designer"],
        config={"agents": {"lead-frontend": "Priya", "lead-designer": "Lena"}},
        synthetic_delegation_fallback=True,
    )

    assert result == "Build initiated."
    action_details = [
        event["content"]
        for event in ws.events
        if event.get("type") == "action_detail" and isinstance(event.get("content"), dict)
    ]
    assert any(
        str(item.get("flow", "")).lower() == "down"
        and str(item.get("target_agent", "")).lower() in {"lead-frontend", "lead-designer"}
        for item in action_details
    )
    assert any(
        str(item.get("flow", "")).lower() == "up"
        and str(item.get("source_agent", "")).lower() in {"lead-frontend", "lead-designer"}
        for item in action_details
    )


@pytest.mark.asyncio
async def test_handle_ceo_codex_requires_cli_binary(monkeypatch):
    monkeypatch.setattr(api.shutil, "which", lambda _name: None)
    ws = _FakeWebSocket()

    result = await api._handle_ceo_codex(
        websocket=ws,
        prompt="test",
        llm_cfg={},
        ceo_name="Marcus",
    )

    assert result is None
    assert ws.events[-1]["type"] == "error"
    assert "Codex CLI not found" in ws.events[-1]["content"]


@pytest.mark.asyncio
async def test_handle_ceo_codex_streams_reasoning_and_final_text(monkeypatch):
    monkeypatch.setattr(api.shutil, "which", lambda _name: "/usr/local/bin/codex")
    lines = [
        json.dumps({"type": "item.completed", "item": {"type": "reasoning", "text": "Thinking"}}),
        json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "CEO response"}}),
        json.dumps({"type": "item.completed", "item": {"type": "command", "title": "Ran internal check"}}),
        json.dumps({"type": "turn.completed"}),
    ]

    async def _fake_create_subprocess_exec(*_args, **_kwargs):
        return _FakeProcess(lines=lines, returncode=0)

    monkeypatch.setattr(api.asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_codex(
        websocket=ws,
        prompt="test",
        llm_cfg={},
        ceo_name="Marcus",
    )

    assert result == "CEO response"
    event_types = [event["type"] for event in ws.events]
    assert event_types.count("action") >= 2
    assert "thinking" in event_types
    assert "action_result" in event_types
    assert "chunk" in event_types


@pytest.mark.asyncio
async def test_handle_ceo_openai_streams_chunks_and_returns_text(monkeypatch):
    async def _fake_stream_openai_compat(*_args, **_kwargs):
        yield "CEO "
        yield "answer"

    monkeypatch.setattr(llm_provider, "stream_openai_compat", _fake_stream_openai_compat)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_openai(
        websocket=ws,
        prompt="test",
        llm_cfg={
            "base_url": "http://localhost:11434/v1",
            "model": "llama3.2",
            "api_key": "ollama",
        },
        ceo_name="Marcus",
    )

    assert result == "CEO answer"
    assert ws.events[0]["type"] == "action"
    assert ws.events[0]["content"] == "Connecting to llama3.2…"
    event_types = [event["type"] for event in ws.events]
    assert "action_result" in event_types
    assert event_types.count("chunk") == 2


@pytest.mark.asyncio
async def test_handle_ceo_openai_empty_response_returns_fallback(monkeypatch):
    async def _empty_stream(*_args, **_kwargs):
        if False:  # pragma: no cover
            yield ""

    monkeypatch.setattr(llm_provider, "stream_openai_compat", _empty_stream)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_openai(
        websocket=ws,
        prompt="test",
        llm_cfg={
            "base_url": "http://localhost:11434/v1",
            "model": "llama3.2",
            "api_key": "ollama",
        },
        ceo_name="Marcus",
    )

    assert result is not None
    assert "no assistant text" in result.lower()
    assert any(
        event["type"] == "action_result" and "fallback summary" in str(event.get("content", "")).lower()
        for event in ws.events
    )


@pytest.mark.asyncio
async def test_handle_ceo_openai_reports_provider_errors(monkeypatch):
    async def _broken_stream(*_args, **_kwargs):
        raise RuntimeError("upstream failed")
        yield ""  # pragma: no cover

    monkeypatch.setattr(llm_provider, "stream_openai_compat", _broken_stream)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_openai(
        websocket=ws,
        prompt="test",
        llm_cfg={
            "base_url": "https://api.openai.com/v1",
            "model": "gpt-4o-mini",
            "api_key": "sk-test",
        },
        ceo_name="Marcus",
    )

    assert result is None
    assert ws.events[-1]["type"] == "error"
    assert "upstream failed" in ws.events[-1]["content"]


@pytest.mark.asyncio
async def test_handle_ceo_openai_stream_failure_falls_back_to_execution_bridge(monkeypatch):
    async def _broken_stream(*_args, **_kwargs):
        raise RuntimeError("upstream failed")
        yield ""  # pragma: no cover

    captured_bridge: dict = {}

    async def _fake_bridge(*_args, **kwargs):
        captured_bridge.update(kwargs)
        return "Created index.html and styles.css"

    monkeypatch.setattr(llm_provider, "stream_openai_compat", _broken_stream)
    monkeypatch.setattr(api, "_handle_ceo_codex", _fake_bridge)

    ws = _FakeWebSocket()
    result = await api._handle_ceo_openai(
        websocket=ws,
        prompt="test",
        llm_cfg={
            "base_url": "http://localhost:11434/v1",
            "model": "llama3.2",
            "api_key": "ollama",
        },
        ceo_name="Marcus",
        user_message="Build a simple web page with HTML and CSS",
        project={"name": "Bridge Project", "workspace_path": "/tmp/bridge-project"},
        project_id="abcd1234",
    )

    assert result is not None
    assert "index.html" in result
    assert captured_bridge["workdir"] == "/tmp/bridge-project"
    assert all(event["type"] != "error" for event in ws.events)
    assert any(
        event["type"] == "action_result"
        and "continuing with direct workspace execution" in event.get("content", "").lower()
        for event in ws.events
    )


@pytest.mark.asyncio
async def test_handle_ceo_openai_timeout_falls_back_to_execution_bridge(monkeypatch):
    async def _slow_stream(*_args, **_kwargs):
        await asyncio.sleep(0.2)
        if False:  # pragma: no cover
            yield ""

    async def _fake_bridge(*_args, **_kwargs):
        return "Bridge completed after timeout"

    monkeypatch.setattr(llm_provider, "stream_openai_compat", _slow_stream)
    monkeypatch.setattr(api, "_handle_ceo_codex", _fake_bridge)
    monkeypatch.setenv("COMPAAS_STREAM_FIRST_TOKEN_TIMEOUT_S", "0.01")

    ws = _FakeWebSocket()
    result = await api._handle_ceo_openai(
        websocket=ws,
        prompt="test",
        llm_cfg={
            "base_url": "http://localhost:11434/v1",
            "model": "llama3.2",
            "api_key": "ollama",
        },
        ceo_name="Marcus",
        user_message="Create index.html for this project",
        project={"name": "Timeout Project", "workspace_path": "/tmp/timeout-project"},
        project_id="facecafe",
    )

    assert result is not None
    assert "Bridge completed after timeout" in result
    assert any(
        event["type"] == "action_result"
        and "timed out; continuing with direct workspace execution" in event.get("content", "").lower()
        for event in ws.events
    )


def test_micro_project_complexity_reason_flags_large_request():
    reason = api._micro_project_complexity_reason(
        "Plan architecture and deployment strategy for an end-to-end OAuth migration "
        "with CI/CD rollout and benchmark analysis across environments."
    )
    assert reason is not None
    assert "too large for Micro Project mode" in reason


def test_micro_project_complexity_reason_allows_simple_request():
    reason = api._micro_project_complexity_reason("Create a simple hello world endpoint.")
    assert reason is None


def test_build_micro_project_prompt_adds_constraints():
    prompt = api._build_micro_project_prompt("User asks now: add a button", user_name="Idan", ceo_name="Marcus")
    assert "MICRO PROJECT MODE" in prompt
    assert "Do not delegate" in prompt
    assert "Idan" in prompt
    assert "Marcus" in prompt


def test_build_context_prompt_prefers_user_name_over_chairman(monkeypatch):
    monkeypatch.setattr(api, "_load_chat_messages", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        api,
        "_load_config",
        lambda: {
            "agents": {},
            "integrations": {},
        },
    )

    prompt = api._build_context_prompt("hi", user_name="Idan", ceo_name="Ari")

    assert "address the user as Idan" in prompt
    assert "or 'Chairman'" not in prompt


def test_build_context_prompt_includes_completion_sections_guidance(monkeypatch):
    monkeypatch.setattr(api, "_load_chat_messages", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        api,
        "_load_config",
        lambda: {
            "user": {"name": "Idan"},
            "agents": {},
            "integrations": {},
        },
    )

    prompt = api._build_context_prompt("build a dashboard", user_name="Idan", ceo_name="Ari")

    assert "'Outcome', 'Deliverables', 'Validation', 'Run Commands', 'Open Links', and 'Next Steps'" in prompt
    assert "Never end an execution turn with standby-only phrasing" in prompt


def test_build_context_prompt_includes_context_pack_payload_when_enabled(monkeypatch):
    monkeypatch.setattr(api, "_load_chat_messages", lambda *args, **kwargs: [])

    class _DummyContextPackService:
        @staticmethod
        def build_prompt_context(**_kwargs):
            return {
                "text": "[CONTEXT PACKS: Apply these constraints and preferences before responding.]\\n- Tech Defaults (project/tech)\\nUse TypeScript strict mode.",
                "packs": [{"id": "pack-1"}],
            }

    monkeypatch.setattr(api, "context_pack_service", _DummyContextPackService())
    monkeypatch.setattr(
        api,
        "_load_config",
        lambda: {
            "user": {"name": "Idan"},
            "agents": {},
            "integrations": {},
            "feature_flags": {"context_packs": True},
        },
    )

    prompt = api._build_context_prompt("build a dashboard", user_name="Idan", ceo_name="Ari", project_id="proj12345")

    assert "CONTEXT PACKS" in prompt
    assert "Use TypeScript strict mode." in prompt


def test_build_context_prompt_skips_context_pack_payload_when_disabled(monkeypatch):
    monkeypatch.setattr(api, "_load_chat_messages", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        api,
        "_load_config",
        lambda: {
            "user": {"name": "Idan"},
            "agents": {},
            "integrations": {},
            "feature_flags": {"context_packs": False},
        },
    )

    prompt = api._build_context_prompt("build a dashboard", user_name="Idan", ceo_name="Ari", project_id="proj12345")

    assert "CONTEXT PACKS" not in prompt


def test_structured_response_payload_extracts_deliverables_validation_and_next_actions():
    payload = api._structured_response_payload(
        """
        ## Outcome
        Core feature is implemented.

        ## Deliverables
        - [Activation Guide](/Users/idan/compaas/projects/cashtracker/artifacts/02_activation_guide.md)
        - [Production URL](https://cashtracker.example.com)

        ## Validation
        - npm run build passed.
        - Smoke tests validated the chat flow.

        ## Run Commands
        - npm install
        - npm run dev

        ## Next Steps
        1. Open [Handoff](/Users/idan/compaas/projects/cashtracker/artifacts/03_project_handoff.md)
        2. Verify production telemetry.
        """
    )

    assert payload["summary"] == "Core feature is implemented."
    assert any(item["target"].endswith("02_activation_guide.md") and item["kind"] == "path" for item in payload["deliverables"])
    assert any(item["target"] == "https://cashtracker.example.com" and item["kind"] == "url" for item in payload["deliverables"])
    assert any("build passed" in item.lower() for item in payload["validation"])
    assert any("verify production telemetry" in item.lower() for item in payload["next_actions"])
    assert any(cmd == "npm install" for cmd in payload["run_commands"])
    assert any(cmd == "npm run dev" for cmd in payload["run_commands"])
    assert any(link["target"] == "https://cashtracker.example.com" for link in payload["open_links"])
    assert payload["completion_kind"] == "build_complete"


def test_structured_response_payload_keeps_clarification_turn_as_general():
    payload = api._structured_response_payload(
        "Idan, that's a great ambition — before I mobilize the team, I need to understand a few things:"
    )
    assert payload["completion_kind"] == "general"
    assert payload["run_commands"] == []
    assert payload["deliverables"] == []


def test_structured_response_payload_requires_run_commands_for_build_complete():
    payload = api._structured_response_payload(
        """
        ## Outcome
        Build complete.

        ## Deliverables
        - [Workspace](/Users/idan/compaas/projects/demo)

        ## Validation
        - Smoke checks passed.
        """
    )
    assert payload["completion_kind"] == "general"


def test_structured_response_payload_is_backward_compatible_for_empty_text():
    payload = api._structured_response_payload("")
    assert payload["summary"] == ""
    assert payload["delegations"] == []
    assert payload["risks"] == []
    assert payload["next_actions"] == []
    assert payload["deliverables"] == []
    assert payload["validation"] == []
    assert payload["run_commands"] == []
    assert payload["open_links"] == []
    assert payload["completion_kind"] == "general"


def test_merge_structured_completion_with_project_includes_run_hints():
    merged = api._merge_structured_completion_with_project(
        {
            "summary": "Build complete.",
            "deliverables": [],
            "validation": [],
            "next_actions": [],
            "run_commands": ["npm run build"],
            "open_links": [{"label": "Preview", "target": "https://app.example.com", "kind": "url"}],
            "completion_kind": "build_complete",
        },
        {
            "workspace_path": "/Users/idan/compaas/projects/cashtracker-b82e75d5",
            "run_instructions": "npm ci\nnpm run dev\nOpen http://localhost:5173",
            "github_repo": "comp-a-a-s/compaas",
        },
    )
    assert "npm run dev" in merged["run_commands"]
    assert any(item["target"] == "http://localhost:5173" for item in merged["open_links"])
    assert any(item["target"] == "/Users/idan/compaas/projects/cashtracker-b82e75d5" for item in merged["open_links"])
    assert any(item["target"] == "https://github.com/comp-a-a-s/compaas" for item in merged["open_links"])
    assert merged["completion_kind"] == "build_complete"


def test_merge_structured_completion_with_project_keeps_general_turn_unpromoted():
    merged = api._merge_structured_completion_with_project(
        {
            "summary": "Let me clarify scope first.",
            "deliverables": [],
            "validation": [],
            "next_actions": [],
            "run_commands": [],
            "open_links": [],
            "completion_kind": "general",
        },
        {
            "workspace_path": "/Users/idan/compaas/projects/cashtracker-b82e75d5",
            "run_instructions": "npm ci\nnpm run dev\nOpen http://localhost:5173",
            "github_repo": "comp-a-a-s/compaas",
        },
    )
    assert merged["completion_kind"] == "general"
    assert merged["run_commands"] == []
    assert merged["open_links"] == []


def test_merge_structured_completion_with_project_downgrades_build_complete_without_commands():
    merged = api._merge_structured_completion_with_project(
        {
            "summary": "Build completed.",
            "deliverables": [{"label": "Workspace", "target": "/Users/idan/compaas/projects/demo", "kind": "path"}],
            "validation": ["Checks passed."],
            "next_actions": ["Run it locally."],
            "run_commands": [],
            "open_links": [],
            "completion_kind": "build_complete",
        },
        {
            "workspace_path": "/Users/idan/compaas/projects/demo",
            "run_instructions": "npm run dev",
        },
    )
    assert merged["completion_kind"] == "general"
    assert merged["run_commands"] == []
    assert not any(item.get("label") == "Workspace Path" for item in merged["open_links"])


def test_sync_project_completion_snapshot_updates_description_team_and_run_commands(monkeypatch):
    project = {
        "id": "abcd1234",
        "description": "Old summary",
        "team": ["Marcus"],
        "run_instructions": "",
    }
    captured_updates: dict = {}

    def _fake_update_project(project_id: str, updates: dict) -> bool:
        assert project_id == "abcd1234"
        captured_updates.update(updates)
        project.update(updates)
        return True

    monkeypatch.setattr(api.state_manager, "update_project", _fake_update_project)
    monkeypatch.setattr(api.state_manager, "get_project", lambda _project_id: project)
    monkeypatch.setattr(
        api.task_board,
        "get_board",
        lambda _project_id: [
            {"assigned_to": "lead-backend", "title": "Implement API endpoint"},
            {"assigned_to": "qa-lead", "title": "Validate regression flow"},
        ],
    )
    monkeypatch.setattr(api, "_emit_chat_activity", lambda *args, **kwargs: None)

    synced = api._sync_project_completion_snapshot(
        "abcd1234",
        project=project,
        structured={
            "summary": "CashTracker release candidate is ready.",
            "run_commands": ["npm ci", "npm run dev"],
            "completion_kind": "build_complete",
            "delegations": [{"agent": "Priya", "why": "UI polish", "action": "Finalize dashboard layout"}],
        },
        support_agents=["lead-frontend"],
        config={"agents": {"ceo": "Marcus", "lead-frontend": "Priya"}},
    )

    assert synced is not None
    assert captured_updates["description"] == "CashTracker release candidate is ready."
    assert captured_updates["run_instructions"] == "npm ci\nnpm run dev"
    assert "Marcus" in captured_updates["team"]
    assert "Priya" in captured_updates["team"]
    assert "lead-backend" in captured_updates["team"]


def test_attempt_local_project_autostart_runs_safe_command(monkeypatch, tmp_path):
    workspace = tmp_path / "autostart-app"
    workspace.mkdir()
    captured: dict = {}

    class _Proc:
        pass

    def _fake_popen(argv, cwd=None, stdout=None, stderr=None, start_new_session=None):  # type: ignore[no-untyped-def]
        captured["argv"] = argv
        captured["cwd"] = cwd
        captured["start_new_session"] = start_new_session
        return _Proc()

    monkeypatch.setattr(api.subprocess, "Popen", _fake_popen)
    monkeypatch.setattr(api, "_emit_chat_activity", lambda *args, **kwargs: None)

    result = api._attempt_local_project_autostart(
        project={
            "id": "abcd1234",
            "delivery_mode": "local",
            "workspace_path": str(workspace),
        },
        structured={
            "completion_kind": "build_complete",
            "run_commands": ["npm run dev"],
            "open_links": [{"label": "Local App", "target": "http://localhost:5173", "kind": "url"}],
        },
        run_id="run-local-1",
    )

    assert result["attempted"] is True
    assert result["started"] is True
    assert result["command"] == "npm run dev"
    assert result["open_url"] == "http://localhost:5173"
    assert captured["argv"] == ["npm", "run", "dev"]
    assert captured["cwd"] == str(workspace)


def test_attempt_local_project_autostart_honors_cd_command_and_sanitizes_open_url(monkeypatch, tmp_path):
    workspace = tmp_path / "project-root"
    nested = workspace / "todo-app"
    nested.mkdir(parents=True)
    captured: dict = {}

    class _Proc:
        pass

    def _fake_popen(argv, cwd=None, stdout=None, stderr=None, start_new_session=None):  # type: ignore[no-untyped-def]
        captured["argv"] = argv
        captured["cwd"] = cwd
        captured["start_new_session"] = start_new_session
        return _Proc()

    monkeypatch.setattr(api.subprocess, "Popen", _fake_popen)
    monkeypatch.setattr(api, "_emit_chat_activity", lambda *args, **kwargs: None)

    result = api._attempt_local_project_autostart(
        project={
            "id": "abcd1234",
            "delivery_mode": "local",
            "workspace_path": str(workspace),
        },
        structured={
            "completion_kind": "build_complete",
            "run_commands": [f"cd {nested}", "npm run dev"],
            "open_links": [{"label": "Open app", "target": "Open app: http://localhost:5173**", "kind": "url"}],
        },
        run_id="run-local-2",
    )

    assert result["attempted"] is True
    assert result["started"] is True
    assert result["command"] == "npm run dev"
    assert result["open_url"] == "http://localhost:5173"
    assert captured["argv"] == ["npm", "run", "dev"]
    assert captured["cwd"] == str(nested)


def test_extract_preferred_open_url_sanitizes_markdown_noise():
    url = api._extract_preferred_open_url(
        {
            "open_links": [
                {"label": "Open app", "target": "Open app: http://localhost:5173**", "kind": "url"},
            ],
        },
        project={},
    )
    assert url == "http://localhost:5173"


def test_attempt_local_project_autostart_blocks_unsafe_command(monkeypatch, tmp_path):
    workspace = tmp_path / "autostart-app-unsafe"
    workspace.mkdir()
    popen_calls: list = []

    def _fake_popen(*args, **kwargs):  # type: ignore[no-untyped-def]
        popen_calls.append((args, kwargs))
        raise AssertionError("Popen should not be called for unsafe command")

    monkeypatch.setattr(api.subprocess, "Popen", _fake_popen)

    result = api._attempt_local_project_autostart(
        project={
            "id": "abcd1234",
            "delivery_mode": "local",
            "workspace_path": str(workspace),
        },
        structured={
            "completion_kind": "build_complete",
            "run_commands": ["npm run dev && rm -rf /"],
        },
        run_id="run-local-unsafe",
    )

    assert result["attempted"] is True
    assert result["started"] is False
    assert "blocked" in str(result.get("message", "")).lower()
    assert popen_calls == []


def test_apply_agent_name_overrides_replaces_agent_names():
    config = {
        "agents": {"ceo": "Ari", "cto": "Nova"},
        "user": {"name": "Idan"},
    }
    result = api._apply_agent_name_overrides("Marcus and Elena reviewed the project.", config)
    assert "Ari" in result
    assert "Nova" in result
    assert "Marcus" not in result
    assert "Elena" not in result


def test_apply_agent_name_overrides_replaces_chairman_with_user_name():
    config = {
        "agents": {"ceo": "Ari"},
        "user": {"name": "Idan"},
    }
    result = api._apply_agent_name_overrides("Chairman, Marcus is ready.", config)
    assert "Chairman" not in result
    assert "Idan" in result
    assert "Ari" in result


def test_sanitize_ceo_response_removes_repeated_intro_and_progress_lines():
    raw = (
        "Idan, Marcus here. Ready to help.\n"
        "Marcus is now creating the files.\n"
        "Idan, I'll run one tiny check now and then report back.\n"
        "Idan, CEO Marcus confirms the build is complete.\n"
    )
    cleaned = api._sanitize_ceo_response(raw, ceo_name="Marcus", user_name="Idan")
    assert "Marcus here" not in cleaned
    assert "is now creating" not in cleaned
    assert "tiny check now and then report back" not in cleaned
    assert "confirms the build is complete" in cleaned


def test_sanitize_ceo_response_keeps_non_empty_output():
    raw = "Idan, Marcus here.\n\nDelivered index.html and README."
    cleaned = api._sanitize_ceo_response(raw, ceo_name="Marcus", user_name="Idan")
    assert cleaned
    assert "Delivered index.html and README." in cleaned


def test_resolve_chat_project_creates_for_build_request(tmp_path, monkeypatch):
    data_dir = tmp_path / "company_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    manager = ProjectStateManager(str(data_dir))
    task_board = TaskBoard(str(data_dir))
    ps = ProjectService(str(data_dir), manager, task_board)

    monkeypatch.setattr(api, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(api, "state_manager", manager)
    monkeypatch.setattr(api, "project_service", ps)
    monkeypatch.setattr(api, "CHAT_LOG_PATH", str(data_dir / "chat_messages.json"))

    project_id, project, created = api._resolve_chat_project("", "build me a simple web page", "Idan")

    assert created is True
    assert project_id
    assert project is not None
    assert project["workspace_path"].startswith(str(tmp_path))


def test_chat_history_scopes_by_project_id(tmp_path, monkeypatch):
    data_dir = tmp_path / "company_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    manager = ProjectStateManager(str(data_dir))
    project_id = manager.create_project("Scoped", "Scoped chat", "app")

    monkeypatch.setattr(api, "state_manager", manager)
    monkeypatch.setattr(api, "CHAT_LOG_PATH", str(data_dir / "chat_messages.json"))

    api._save_chat_messages([])
    api._append_chat_message("user", "global message", project_id="")
    api._append_chat_message("user", "project message", project_id=project_id)

    scoped = api._load_chat_messages(project_id=project_id)
    assert len(scoped) == 1
    assert scoped[0]["content"] == "project message"


@pytest.mark.asyncio
async def test_chat_websocket_marks_inflight_run_failed_on_disconnect(monkeypatch, tmp_path):
    data_dir = tmp_path / "company_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir(parents=True, exist_ok=True)

    run_service = RunService(
        str(data_dir),
        RuntimeSettings(
            data_dir=str(data_dir),
            project_root=str(tmp_path),
            workspace_root=str(workspace_root),
            max_project_concurrency=1,
            duplicate_turn_window_seconds=600,
        ),
    )

    project_id = "abc12345"
    project = {
        "id": project_id,
        "name": "Disconnect Test",
        "workspace_path": str(workspace_root / "disconnect-test"),
    }
    os.makedirs(project["workspace_path"], exist_ok=True)

    monkeypatch.setattr(api, "run_service", run_service)
    monkeypatch.setattr(api, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(api, "CHAT_LOG_PATH", str(data_dir / "chat_messages.json"))
    monkeypatch.setattr(api.shutil, "which", lambda _name: "/usr/bin/codex")
    monkeypatch.setattr(
        api,
        "_load_config",
        lambda: {
            "llm": {
                "provider": "openai",
                "openai_mode": "codex",
                "model": "gpt-4o-mini",
            },
            "user": {"name": "Idan"},
            "agents": {"ceo": "Marcus"},
            "integrations": {},
            "feature_flags": {
                "planning_approval_gate": True,
                "structured_ceo_response": True,
                "execution_intent_classifier": False,
            },
        },
    )
    monkeypatch.setattr(api, "_resolve_chat_project", lambda *_args, **_kwargs: (project_id, project, False))
    monkeypatch.setattr(api, "_build_context_prompt", lambda *_args, **_kwargs: "prompt")

    async def _disconnecting_codex_handler(*_args, **_kwargs):
        raise WebSocketDisconnect()

    monkeypatch.setattr(api, "_handle_ceo_codex", _disconnecting_codex_handler)

    ws = _FakeChatWebSocket(
        [{
            "message": "build a simple app",
            "project_id": project_id,
            "planning_approved": True,
        }]
    )
    await api.chat_websocket(ws)

    runs = run_service.list_runs(project_id=project_id, limit=10)
    assert runs
    run = runs[0]
    assert run["status"] == "failed"
    assert any(
        "Client disconnected before run completion" in str(item.get("label", ""))
        for item in run.get("timeline", [])
    )
