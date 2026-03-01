# COMPaaS

**COMPaaS turns one person into a full AI software company.**

You give direction. Your virtual leadership team plans, delegates, builds, verifies, and reports back in one unified workspace.

If you want the speed of AI without losing control, COMPaaS is built for you.

## Why COMPaaS

Most AI tools give you isolated outputs.
COMPaaS gives you coordinated execution.

With COMPaaS, you get:

- A CEO-led execution flow instead of random one-off responses
- A 15-agent virtual org (leadership, engineering, design, security, QA, docs)
- Project-scoped chat, planning artifacts, and handoff docs
- Real-time visibility into what agents are doing
- Local or GitHub project delivery modes
- Optional Vercel deployment and Telegram chat mirroring

## What You Can Build

- Full-stack web apps
- Internal tools and dashboards
- APIs and backend services
- Landing pages and marketing sites
- Prototypes with structured handoff docs
- Multi-phase product execution plans

## 60-Second Quick Start

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/comp-a-a-s/compaas/master/bootstrap.sh)
```

That bootstrap flow will:

- Clone or update COMPaaS
- Install Python and web dependencies
- Verify setup
- Offer to start immediately

Private repo access:

```bash
bash <(curl -fsSL -H "Authorization: Bearer $(gh auth token)" "https://raw.githubusercontent.com/comp-a-a-s/compaas/master/bootstrap.sh")
```

## The Experience

1. Open `compaas-web`
2. Create/select a project (Local or GitHub)
3. Message the CEO in **CEO Chat**
4. Watch live delegation and execution
5. Review deliverables, validation, and next actions

You stay in control. COMPaaS does the coordination.

## Screenshot Slots (Recommended)

I cannot create images here, but these are the best places to add them in this README.

Add image files under `docs/images/` and keep these references:

```md
![Hero dashboard](docs/images/hero-dashboard.png)
![CEO chat structured response](docs/images/ceo-chat-structured.png)
![Live org chart and workforce](docs/images/live-workforce.png)
![Project plan and artifacts](docs/images/project-artifacts.png)
![Integrations setup](docs/images/integrations-setup.png)
```

Best placement:

- Right below this intro: `hero-dashboard.png`
- Right below "The Experience": `ceo-chat-structured.png`
- Right below "Live Operations Visibility": `live-workforce.png`
- Right below "Project Outputs": `project-artifacts.png`
- Right below "Integrations": `integrations-setup.png`

## Core Product Capabilities

### CEO-Orchestrated Execution

The CEO chat is your primary control surface.

- Structured final responses
- Clickable links and copyable path actions
- Project-aware context and memory
- Micro Project mode for quick solo execution

### Live Operations Visibility

- Real-time activity stream (SSE)
- Canonical workforce presence states
- Org chart with active collaboration highlights
- Action logs and technical execution details

### Project System That Ships

Every project can include:

- Stakeholder summary
- Full execution plan
- Activation guide
- Project handoff document

### Delivery Modes

- **Local workspace**: write directly under the generated project workspace
- **GitHub mode**: route project output to connected repository settings

### Deployment Lifecycle

When enabled, COMPaaS can offer Vercel deployment directly in CEO chat after build completion.

## Architecture at a Glance

```text
You (Board Head)
      |
      v
CEO (Marcus) ---> MCP Server (20+ tools)
      |                    |
      v                    v
Specialist Agents      Project/Task/Memory State
      |
      v
Web Dashboard + TUI + API
```

### 4-Layer Stack

- **Agent definitions**: role-specific behavior and model routing
- **MCP tool layer**: project, task, memory, metrics, integration operations
- **State layer**: YAML-backed project and run state
- **Interfaces**: React web dashboard, Textual TUI, and FastAPI APIs

## Agent Roster

| Team | Agents |
|---|---|
| Leadership | CEO, CTO, Chief Researcher, CISO, CFO, CPO, VP Engineering |
| Engineering | Lead Backend, Lead Frontend, QA Lead, DevOps |
| On-demand specialists | Security Engineer, Data Engineer, Tech Writer |

Total: **15 specialized agents**.

## Installation (Detailed)

### Option A: One-command installer (recommended)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/comp-a-a-s/compaas/master/bootstrap.sh)
```

### Option B: Existing local checkout

```bash
./install.sh
```

### Option C: Manual setup

1. Python dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev,local-models]"
```

2. Web dashboard dependencies

```bash
cd web-dashboard
npm install
npm run build
cd ..
```

3. Environment

```bash
cp .env.example .env
```

4. Verify

```bash
pytest tests/ -v
```

## Run COMPaaS

### Web dashboard

```bash
compaas-web
```

Default URL: [http://localhost:8420](http://localhost:8420)

### TUI

```bash
compaas-tui
```

## Integrations

### GitHub

Use GitHub mode to deliver into repositories.

- Configure token/repo in Settings
- Verify connector
- Create projects in GitHub mode

### Vercel

Deploy built projects (not COMPaaS itself) from chat or API controls.

- Add Vercel token + project
- Verify connector
- Approve deployment when offered in CEO chat

### Telegram

Mirror user/CEO messages from active project chat.

- Configure bot token + chat ID in Settings
- Toggle Telegram mirror in CEO chat toolbar

## API Surface

### Core API

- WebSocket chat: `/api/chat/ws`
- Chat history: `/api/chat/history`
- Workforce live state: `/api/workforce/live`

### Versioned API (`/api/v1`)

Includes advanced controls for:

- Feature flags
- Runs lifecycle
- Project metadata and artifacts
- Chat policy and memory controls
- GitHub and Vercel operations
- Workforce snapshots

## Configuration Highlights

| Variable | Default | Description |
|---|---|---|
| `COMPAAS_DATA_DIR` | `./company_data` | Runtime state directory |
| `COMPAAS_API_HOST` | `127.0.0.1` | Web host |
| `COMPAAS_API_PORT` | `8420` | Web port |
| `COMPAAS_CORS_ORIGINS` | localhost defaults | Allowed origins |
| `COMPAAS_CORS_METHODS` | `GET` | Allowed CORS methods |
| `COMPAAS_ADMIN_TOKEN` | unset | Optional admin write guard |
| `ANTHROPIC_API_KEY` | optional | Anthropic API mode |
| `OPENAI_API_KEY` | optional | OpenAI API mode |

## Runtime Options

Supported model/runtime paths include:

- Anthropic via Claude CLI or API key mode
- OpenAI via API or Codex CLI mode
- OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp)

## First Prompt Ideas

Use these in CEO chat to quickly evaluate the product:

- "Build a lightweight expense tracker with local persistence and clean UI."
- "Create a customer feedback dashboard with filtering and export."
- "Plan and build a small CRM MVP in phases, then hand off run instructions."

## Troubleshooting

- **`compaas-web` not starting**: ensure Python deps are installed and venv is active
- **Dashboard build issues**: run `cd web-dashboard && npm install && npm run build`
- **CEO chat not connecting**: confirm server is running and runtime provider is configured
- **Port conflict**: run with `COMPAAS_API_PORT=9000 compaas-web`
- **CORS write requests blocked**: set `COMPAAS_CORS_METHODS=GET,POST,PATCH,DELETE`

## Documentation

- Live workforce semantics: [docs/live-workforce.md](docs/live-workforce.md)

## Contributing

PRs are welcome. Focus areas:

- Agent quality and orchestration
- New tool adapters and integrations
- UI/UX polish in CEO chat and operations visibility
- Reliability, security, and test coverage

## License

MIT. See [LICENSE](LICENSE).

---

## Final Pitch

If you are tired of juggling prompts, tabs, and disconnected AI outputs, COMPaaS gives you a real operating model:

- Strategic direction from you
- Coordinated execution from an AI company
- Transparent progress from plan to delivery

**Install it once. Run your company in one command.**
