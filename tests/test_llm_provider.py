"""Tests for OpenAI-compatible provider helper module."""

from __future__ import annotations

import sys
import types

import pytest

import src.llm_provider as llm_provider


class _FakeStream:
    def __init__(self, events):
        self._events = iter(events)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._events)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _FakeCompletions:
    def __init__(self):
        self.calls: list[tuple[str, list[dict]]] = []

    def stream(self, model, messages):
        self.calls.append((model, messages))
        events = [
            types.SimpleNamespace(choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="He"))]),
            types.SimpleNamespace(choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="llo"))]),
            types.SimpleNamespace(choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content=None))]),
        ]
        return _FakeStream(events)


class _FakeAsyncOpenAI:
    last_instance = None

    def __init__(self, base_url, api_key):
        self.base_url = base_url
        self.api_key = api_key
        self.chat = types.SimpleNamespace(completions=_FakeCompletions())
        _FakeAsyncOpenAI.last_instance = self


def test_extract_stream_delta_from_legacy_choices():
    event = types.SimpleNamespace(
        choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="hello"))]
    )
    assert llm_provider._extract_stream_delta(event) == "hello"


def test_extract_stream_delta_from_chunk_event_shape():
    event = types.SimpleNamespace(
        chunk=types.SimpleNamespace(
            choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="world"))]
        )
    )
    assert llm_provider._extract_stream_delta(event) == "world"


def test_extract_stream_delta_ignores_typed_chunk_event_to_avoid_duplication():
    event = types.SimpleNamespace(
        type="chunk",
        chunk=types.SimpleNamespace(
            choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="world"))]
        ),
    )
    assert llm_provider._extract_stream_delta(event) == ""


def test_extract_stream_delta_from_content_delta_event_shape():
    event = types.SimpleNamespace(type="content.delta", delta="delta-text")
    assert llm_provider._extract_stream_delta(event) == "delta-text"


def test_extract_stream_delta_ignores_non_text_events():
    event = types.SimpleNamespace(type="content.done")
    assert llm_provider._extract_stream_delta(event) == ""


def test_require_openai_raises_helpful_error_when_missing_async_class(monkeypatch):
    fake_openai = types.ModuleType("openai")
    monkeypatch.setitem(sys.modules, "openai", fake_openai)

    with pytest.raises(RuntimeError) as exc:
        llm_provider._require_openai()

    assert "compaas[local-models]" in str(exc.value)


def test_require_openai_returns_async_class_when_present(monkeypatch):
    fake_openai = types.ModuleType("openai")
    fake_openai.AsyncOpenAI = _FakeAsyncOpenAI
    monkeypatch.setitem(sys.modules, "openai", fake_openai)

    result = llm_provider._require_openai()
    assert result is _FakeAsyncOpenAI


@pytest.mark.asyncio
async def test_stream_openai_compat_yields_non_empty_chunks(monkeypatch):
    monkeypatch.setattr(llm_provider, "_require_openai", lambda: _FakeAsyncOpenAI)

    chunks = []
    async for chunk in llm_provider.stream_openai_compat(
        prompt="hello",
        base_url="http://localhost:11434/v1",
        model="llama3.2",
        api_key="ollama",
        system_prompt="system",
    ):
        chunks.append(chunk)

    assert chunks == ["He", "llo"]
    inst = _FakeAsyncOpenAI.last_instance
    assert inst is not None
    assert inst.base_url == "http://localhost:11434/v1"
    assert inst.api_key == "ollama"
    assert inst.chat.completions.calls[0][0] == "llama3.2"
    assert inst.chat.completions.calls[0][1][0]["role"] == "system"


@pytest.mark.asyncio
async def test_probe_connection_success(monkeypatch):
    async def _fake_stream(*_args, **_kwargs):
        yield "O"
        yield "K"

    monkeypatch.setattr(llm_provider, "stream_openai_compat", _fake_stream)
    ok, message = await llm_provider.probe_connection("http://local", "model", "key")

    assert ok is True
    assert message == "ok"


@pytest.mark.asyncio
async def test_probe_connection_failure_returns_exception_message(monkeypatch):
    async def _boom(*_args, **_kwargs):
        raise RuntimeError("connection failed")
        yield "never"  # pragma: no cover

    monkeypatch.setattr(llm_provider, "stream_openai_compat", _boom)
    ok, message = await llm_provider.probe_connection("http://local", "model", "key")

    assert ok is False
    assert "connection failed" in message
