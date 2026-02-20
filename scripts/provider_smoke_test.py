#!/usr/bin/env python3
"""Run live provider smoke checks against COMPaaS chat websocket."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx
import websockets


@dataclass
class Scenario:
    name: str
    llm_patch: dict[str, Any]
    token: str
    requires_openai_key: bool = False
    requires_anthropic_key: bool = False
    expect_cli_actions: bool = False
    micro_project_mode: bool = False


def _mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}…{value[-4:]}"


def _ws_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{scheme}://{parsed.netloc}/api/chat/ws"


async def _chat_once(
    base_url: str,
    message: str,
    *,
    micro_project_mode: bool = False,
    micro_project_override: bool = False,
    timeout_s: float = 120.0,
) -> dict[str, Any]:
    ws_url = _ws_url(base_url)
    events: list[dict[str, Any]] = []
    chunks: list[str] = []
    actions: list[str] = []
    errors: list[str] = []
    warnings: list[str] = []
    done_content = ""

    async with websockets.connect(ws_url, max_size=4 * 1024 * 1024) as ws:
        await ws.send(json.dumps({
            "message": message,
            "micro_project_mode": micro_project_mode,
            "micro_project_override": micro_project_override,
        }))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout_s)
            event = json.loads(raw)
            events.append(event)
            event_type = event.get("type")
            if event_type == "chunk":
                chunks.append(event.get("content", ""))
            elif event_type == "action":
                actions.append(event.get("content", ""))
            elif event_type == "error":
                errors.append(event.get("content", ""))
            elif event_type == "micro_project_warning":
                warnings.append(event.get("content", ""))
            elif event_type == "done":
                done_content = event.get("content", "") or ""
                break

    response_text = done_content or "".join(chunks)
    return {
        "response": response_text.strip(),
        "actions": actions,
        "errors": errors,
        "micro_warnings": warnings,
        "events_count": len(events),
    }


async def _run_scenario(
    client: httpx.AsyncClient,
    base_url: str,
    scenario: Scenario,
    openai_key: str,
    anthropic_key: str,
) -> dict[str, Any]:
    if scenario.requires_openai_key and not openai_key:
        return {"name": scenario.name, "status": "skipped", "reason": "OPENAI_API_KEY missing"}
    if scenario.requires_anthropic_key and not anthropic_key:
        return {"name": scenario.name, "status": "skipped", "reason": "ANTHROPIC_API_KEY missing"}

    llm_patch = dict(scenario.llm_patch)
    if scenario.requires_openai_key:
        llm_patch["api_key"] = openai_key
    if scenario.requires_anthropic_key:
        llm_patch["api_key"] = anthropic_key

    patch_res = await client.patch("/api/config", json={"llm": llm_patch})
    if patch_res.status_code >= 400:
        return {
            "name": scenario.name,
            "status": "failed",
            "reason": f"/api/config patch failed with HTTP {patch_res.status_code}",
        }

    if scenario.micro_project_mode:
        prompt = (
            f"Micro run `{scenario.token}`. "
            f"Reply in <=60 words and include exactly `{scenario.token}`. "
            "Mention the CEO and one limitation."
        )
    else:
        prompt = (
            f"Provider validation run `{scenario.token}`. "
            f"Reply in <=80 words and include the exact token `{scenario.token}`. "
            "Mention the CEO name and one specialist role. "
            "If tooling is available, delegate one tiny internal check and report it."
        )
    chat_result = await _chat_once(
        base_url,
        prompt,
        micro_project_mode=scenario.micro_project_mode,
    )

    agents_res = await client.get("/api/agents")
    agents_count = len(agents_res.json()) if agents_res.status_code == 200 and isinstance(agents_res.json(), list) else 0

    response = chat_result["response"]
    errors = chat_result["errors"]
    micro_warnings = chat_result.get("micro_warnings", [])
    quota_block = any("exceeded your current quota" in str(err).lower() for err in errors)
    if quota_block:
        return {
            "name": scenario.name,
            "status": "skipped",
            "reason": "OpenAI quota exceeded for the provided API key",
            "events_count": chat_result["events_count"],
            "actions_count": len(chat_result["actions"]),
            "agents_count": agents_count,
        }

    has_token = scenario.token in response
    has_response = bool(response)
    has_actions = len(chat_result["actions"]) > 0

    failures: list[str] = []
    warnings: list[str] = []
    if errors:
        failures.append(f"chat_error={errors[-1][:160]}")
    if not has_response:
        failures.append("empty_response")
    if not has_token:
        warnings.append("missing_token")
    if agents_count < 10:
        failures.append(f"agents_endpoint_unhealthy(count={agents_count})")
    if scenario.expect_cli_actions and not has_actions:
        warnings.append("expected_cli_actions_but_none_seen")
    if scenario.micro_project_mode and micro_warnings:
        warnings.append("micro_warning_emitted")

    status = "passed" if not failures else "failed"
    return {
        "name": scenario.name,
        "status": status,
        "response_preview": response[:220],
        "events_count": chat_result["events_count"],
        "actions_count": len(chat_result["actions"]),
        "agents_count": agents_count,
        "failures": failures,
        "warnings": warnings,
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description="COMPaaS provider smoke checks")
    parser.add_argument("--base-url", default="http://127.0.0.1:8421", help="COMPaaS API base URL")
    parser.add_argument(
        "--scenarios",
        default="anthropic_cli,openai_api,openai_codex,ollama_local,anthropic_apikey",
        help="Comma-separated scenario IDs to run",
    )
    parser.add_argument(
        "--micro-project",
        action="store_true",
        help="Run scenarios in Micro Project mode (fast solo CEO mode)",
    )
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    scenario_filter = [s.strip() for s in args.scenarios.split(",") if s.strip()]

    scenarios = {
        "anthropic_cli": Scenario(
            name="anthropic_cli",
            llm_patch={
                "provider": "anthropic",
                "anthropic_mode": "cli",
                "openai_mode": "apikey",
                "model": "claude-opus-4-6",
            },
            token="PROVIDER_ANTHROPIC_CLI_OK",
            expect_cli_actions=True,
        ),
        "anthropic_apikey": Scenario(
            name="anthropic_apikey",
            llm_patch={
                "provider": "anthropic",
                "anthropic_mode": "apikey",
                "openai_mode": "apikey",
                "model": "claude-opus-4-6",
            },
            token="PROVIDER_ANTHROPIC_APIKEY_OK",
            requires_anthropic_key=True,
            expect_cli_actions=True,
        ),
        "openai_api": Scenario(
            name="openai_api",
            llm_patch={
                "provider": "openai",
                "openai_mode": "apikey",
                "anthropic_mode": "cli",
                "base_url": "https://api.openai.com/v1",
                "model": "gpt-4o-mini",
            },
            token="PROVIDER_OPENAI_API_OK",
            requires_openai_key=True,
        ),
        "openai_codex": Scenario(
            name="openai_codex",
            llm_patch={
                "provider": "openai",
                "openai_mode": "codex",
                "anthropic_mode": "cli",
                "base_url": "https://api.openai.com/v1",
                "model": "gpt-4o-mini",
            },
            token="PROVIDER_OPENAI_CODEX_OK",
            expect_cli_actions=True,
        ),
        "ollama_local": Scenario(
            name="ollama_local",
            llm_patch={
                "provider": "openai_compat",
                "openai_mode": "apikey",
                "anthropic_mode": "cli",
                "base_url": "http://localhost:11434/v1",
                "model": "llama3.2",
                "api_key": "ollama",
            },
            token="PROVIDER_OLLAMA_LOCAL_OK",
        ),
    }

    if args.micro_project:
        for scenario in scenarios.values():
            scenario.micro_project_mode = True

    selected = [scenarios[s] for s in scenario_filter if s in scenarios]
    if not selected:
        print("No valid scenarios selected.", file=sys.stderr)
        return 2

    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
        try:
            config_res = await client.get("/api/config")
            config_res.raise_for_status()
        except Exception as exc:  # pragma: no cover - runtime guard
            print(f"Cannot reach {base_url}/api/config: {exc}", file=sys.stderr)
            return 2

        original_config = config_res.json()
        original_llm = original_config.get("llm", {})
        print(f"Base URL: {base_url}")
        print(f"OpenAI key: {_mask_secret(openai_key)}")
        print(f"Anthropic key: {_mask_secret(anthropic_key)}")
        print("")

        results: list[dict[str, Any]] = []
        try:
            for scenario in selected:
                print(f"Running scenario: {scenario.name} ...")
                result = await _run_scenario(client, base_url, scenario, openai_key, anthropic_key)
                results.append(result)
                print(f"  -> {result['status']}")
                if result.get("reason"):
                    print(f"     reason: {result['reason']}")
                if result.get("failures"):
                    print(f"     failures: {', '.join(result['failures'])}")
                if result.get("warnings"):
                    print(f"     warnings: {', '.join(result['warnings'])}")
                if result.get("response_preview"):
                    print(f"     response: {result['response_preview']}")
                print("")
        finally:
            await client.patch("/api/config", json={"llm": original_llm})

    failed = [r for r in results if r["status"] == "failed"]
    skipped = [r for r in results if r["status"] == "skipped"]

    print("Summary")
    print("-------")
    print(json.dumps(results, indent=2))
    print(f"\npassed={len(results) - len(failed) - len(skipped)} failed={len(failed)} skipped={len(skipped)}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
