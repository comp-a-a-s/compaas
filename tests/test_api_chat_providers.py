"""Focused tests for provider-specific chat handlers in web.api."""

from __future__ import annotations

import asyncio
import json

import pytest

import src.web.api as api
import src.llm_provider as llm_provider
from src.state.project_state import ProjectStateManager


class _FakeWebSocket:
    def __init__(self) -> None:
        self.events: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.events.append(payload)


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
    event_types = [event["type"] for event in ws.events]
    assert "chunk" in event_types
    assert "action" in event_types
    assert "action_result" in event_types


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


def test_resolve_chat_project_creates_for_build_request(tmp_path, monkeypatch):
    data_dir = tmp_path / "company_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    manager = ProjectStateManager(str(data_dir))

    monkeypatch.setattr(api, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(api, "state_manager", manager)
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
