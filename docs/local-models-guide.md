# Local Models Guide (All Methods)

This guide covers every local/self-hosted runtime COMPaaS supports:

- Ollama
- LM Studio
- llama.cpp
- Jan
- vLLM
- Custom OpenAI-compatible endpoints

Use this when you want to run models locally instead of cloud APIs.

## 1) Choose the Right Model First

Pick by hardware and goal:

| Target | Good Model Size | Typical Use | Hardware |
|---|---|---|---|
| Fast local dev | 7B-8B | Prototyping, short tasks | CPU or 8-12 GB VRAM |
| Better planning/code quality | 14B-32B | Most day-to-day COMPaaS work | 16-48 GB VRAM |
| Best local quality | 70B class | Complex architecture and long outputs | 48 GB+ VRAM or multi-GPU |

Recommended starting models:

- 8B: `llama3.1:8b-instruct` / `qwen2.5-coder:7b`
- Mid: `qwen2.5-coder:32b` / Llama 3.3 70B quantized where possible
- High-end: 70B instruct variants (if your GPU stack can sustain them)

Rule of thumb:

- If latency is your pain: go smaller.
- If quality/reasoning is your pain: go bigger.
- For multi-agent orchestration stability, prioritize instruct-tuned models over base models.

## 2) COMPaaS Local Runtime Settings

In Setup Wizard or Settings:

- Provider: `Local / Self-Hosted`
- Base URL and API key depend on runtime (below)
- Model name must match the model your server exposes

Default runtime endpoints:

- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`
- llama.cpp: `http://localhost:8080/v1`
- Jan: `http://localhost:1337/v1`
- vLLM: `http://localhost:8000/v1`

## 3) Ollama

Install:

```bash
brew install ollama
```

Start service:

```bash
ollama serve
```

Pull a model:

```bash
ollama pull llama3.1:8b-instruct
```

COMPaaS config:

- Base URL: `http://localhost:11434/v1`
- API key: `ollama`
- Model: exactly the pulled tag (for example `llama3.1:8b-instruct`)

## 4) LM Studio

Install LM Studio from [lmstudio.ai](https://lmstudio.ai).

Steps:

1. Download a chat/instruct model in Discover.
2. Load the model.
3. Enable local server mode (OpenAI-compatible API).
4. Confirm endpoint is `http://localhost:1234/v1`.

COMPaaS config:

- Base URL: `http://localhost:1234/v1`
- API key: `lm-studio`
- Model: the loaded model ID shown by LM Studio

## 5) llama.cpp

Build or install `llama-server`, then run OpenAI-compatible server:

```bash
./llama-server -m /path/to/model.gguf --host 0.0.0.0 --port 8080 --api-key none
```

COMPaaS config:

- Base URL: `http://localhost:8080/v1`
- API key: `none`
- Model: usually `default` unless your server exposes named models

## 6) Jan

Install Jan from [jan.ai](https://jan.ai).

Steps:

1. Open Jan Hub and download an instruct model.
2. Start Jan local API server.
3. Confirm endpoint is `http://localhost:1337/v1`.

COMPaaS config:

- Base URL: `http://localhost:1337/v1`
- API key: `jan`
- Model: model ID shown by Jan

## 7) vLLM (GPU Server)

Install:

```bash
pip install vllm
```

Serve a model:

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct --host 0.0.0.0 --port 8000
```

COMPaaS config:

- Base URL: `http://localhost:8000/v1`
- API key: `vllm` (or your configured key)
- Model: exact model name served by vLLM

## 8) Custom OpenAI-Compatible Server

Any backend implementing `/v1/chat/completions` can work.

Common choices:

- Text Generation WebUI
- Kobold.cpp (with OpenAI extension)
- Custom gateway/proxy

COMPaaS config:

- Base URL: your server URL ending with `/v1`
- API key: whatever your server expects (or placeholder)
- Model: exact served model ID

## 9) Validation Checklist

Before using CEO chat:

1. Test the provider connection in Setup/Settings.
2. Send one short CEO command (`create a hello-world app`) and verify response latency.
3. If delegation stalls, reduce model size or switch to a stronger instruct model.

## 10) Troubleshooting

- Empty responses or timeouts:
  - Model too large for available RAM/VRAM.
  - Server loaded but swapping heavily.
- Tool-heavy tasks fail:
  - Use a stronger instruct model or move to Codex CLI/Claude CLI mode.
- Wrong model name:
  - Use exact served identifier (case-sensitive in some runtimes).
- Local endpoint unreachable:
  - Verify host/port and that server is still running.

## 11) What to Use in Practice

If you want maximum reliability for multi-agent orchestration, cloud CLI modes are still the recommended default.

For local-first workflows:

- Start with Ollama or LM Studio.
- Move to vLLM when you need higher throughput/quality on dedicated GPU infra.
