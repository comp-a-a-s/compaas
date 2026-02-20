"""OpenAI-compatible async streaming client for local/alternative model support.

Supports any provider that exposes an OpenAI-compatible /v1/chat/completions
endpoint: Ollama, LM Studio, llama.cpp server, the real OpenAI API, Groq, etc.

This module is imported lazily inside the CEO chat handler so that the
``openai`` package remains optional — install with::

    pip install compaas[local-models]
"""

from __future__ import annotations

from collections.abc import AsyncIterator


def _require_openai():
    """Import AsyncOpenAI or raise a helpful error if not installed."""
    try:
        from openai import AsyncOpenAI  # type: ignore[import]
        return AsyncOpenAI
    except ImportError:
        raise RuntimeError(
            "The 'openai' package is required for OpenAI / local model support. "
            "Install it with:  pip install 'compaas[local-models]'"
        )


async def stream_openai_compat(
    prompt: str,
    base_url: str,
    model: str,
    api_key: str,
    system_prompt: str | None = None,
) -> AsyncIterator[str]:
    """Stream tokens from any OpenAI-compatible /v1/chat/completions endpoint.

    Works with:
    - Real OpenAI API  (base_url="https://api.openai.com/v1")
    - Ollama           (base_url="http://localhost:11434/v1", api_key="ollama")
    - LM Studio        (base_url="http://localhost:1234/v1",  api_key="lm-studio")
    - llama.cpp server (base_url="http://localhost:8080/v1",  api_key="none")
    - Any other OpenAI-compatible server

    Args:
        prompt: The user message to send.
        base_url: Full base URL of the OpenAI-compatible API.
        model: Model identifier (e.g. "gpt-4o", "llama3.2").
        api_key: API key. Use a non-empty placeholder for local servers.
        system_prompt: Optional system message prepended to the conversation.

    Yields:
        Text chunks as they arrive from the stream.
    """
    AsyncOpenAI = _require_openai()
    client = AsyncOpenAI(base_url=base_url, api_key=api_key or "local")

    messages: list[dict] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    async with client.chat.completions.stream(
        model=model,
        messages=messages,
    ) as stream:
        async for event in stream:
            delta = event.choices[0].delta.content
            if delta:
                yield delta


async def probe_connection(
    base_url: str,
    model: str,
    api_key: str,
) -> tuple[bool, str]:
    """Send a minimal probe request to test connectivity.

    Returns:
        (True, "ok") on success, or (False, error_message) on failure.
    """
    try:
        parts: list[str] = []
        async for chunk in stream_openai_compat(
            prompt="Reply with the single word: OK",
            base_url=base_url,
            model=model,
            api_key=api_key,
        ):
            parts.append(chunk)
            if len("".join(parts)) > 200:
                break
        return True, "ok"
    except Exception as exc:
        return False, str(exc)
