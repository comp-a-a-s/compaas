# COMPaaS

**COMPaaS** is a Company as a Service platform powered by autonomous AI agents. A virtual software company of 15 specialized agents — CEO, CTO, engineers, designers, researchers, and more — collaborate through an MCP server to manage projects, track tasks, and build software on your behalf.

## Architecture

```
Board Head (You)
       |
   CEO (Marcus) ──── MCP Server (20+ tools)
       |                    |
   ┌───┼───────────┐      State Layer (YAML)
   │   │           │           |
Leadership  Engineering  On-Demand     Dashboards
 6 agents    5 agents   3 agents    (Web + TUI)
```

**Four layers:**

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Agent Definitions | 15 Markdown files in `.claude/agents/` | Role descriptions, tools, model assignments |
| MCP Server | FastMCP with 20+ tools | Project/task CRUD, memory, metrics, hiring, micro-agents |
| State Management | YAML files in `company_data/` | Projects, tasks, decisions, token usage, activity log |
| Dashboards | FastAPI + React (web) / Textual (TUI) | Real-time org chart, task boards, activity feed, token metrics |

## Prerequisites

- **Python 3.10+** (required)
- **Node.js 18+** (optional, for web dashboard)
- **Claude Code CLI** (`npm install -g @anthropic-ai/claude-code`) for Anthropic CLI runtime mode
- **Codex CLI** (`npm install -g @openai/codex`) for OpenAI Codex runtime mode
- **Ollama** (optional, for local `openai_compat` mode)
- **Cloud API key(s)** (optional, only if using Anthropic/OpenAI API-key modes)

## Quick Start

```bash
# One command: download + install + prompt to start
bash <(curl -fsSL https://raw.githubusercontent.com/comp-a-a-s/compaas/master/bootstrap.sh)
```

The installer clones/updates COMPaaS, installs dependencies, verifies the setup,
and asks whether you want to start immediately.

For private repository access, use an authenticated bootstrap request:

```bash
bash <(curl -fsSL -H "Authorization: Bearer $(gh auth token)" "https://raw.githubusercontent.com/comp-a-a-s/compaas/master/bootstrap.sh")
```

## Installation (Detailed)

### Automated Installation

```bash
# Option A (recommended): one command bootstrap
bash <(curl -fsSL https://raw.githubusercontent.com/comp-a-a-s/compaas/master/bootstrap.sh)

# Option B: from an existing local checkout
./install.sh
```

The installer handles Python checks, web dependencies, environment setup, test verification, and an end-of-install startup prompt.

### Manual Installation

**Step 1: Python dependencies**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev,local-models]"
```

**Step 2: Web dashboard (optional)**
```bash
cd web-dashboard
npm install
npm run build
cd ..
```

**Step 3: Environment configuration**
```bash
cp .env.example .env
# Edit .env and set keys only for cloud API modes
```

**Step 4: Initialize directories**
```bash
mkdir -p company_data/projects ~/projects
```

**Step 5: Make hooks executable**
```bash
chmod +x scripts/hooks/*.sh
```

**Step 6: Verify installation**
```bash
pytest tests/ -v
```

## Usage

### Working with the CEO

Use the Web Dashboard chat as the primary interface:

```bash
compaas-web
```

Then open **CEO Chat** and give instructions like:
- "Build me a task management API with a React frontend"
- "Create a simple landing page with one signup form"
- "Set up a project plan for an e-commerce platform"

The CEO can delegate to specialized agents (CTO, engineers, designers, etc.) for full-crew execution.
For very small tasks, enable **Micro Project mode** in chat to run a fast solo response path.
By default, project implementation output is written under `./projects/<project-name>-<id>/` (inside the COMPaaS workspace).

### Web Dashboard

```bash
compaas-web
# Opens at http://localhost:8420
```

Features:
- Org chart with team hierarchy
- Project list with progress tracking
- Task boards per project
- Real-time activity feed (SSE)
- Token usage metrics and budget tracking
- CEO Chat — talk directly to Marcus from the dashboard (WebSocket-based, with streaming responses)
- Project-scoped CEO sessions — each project keeps its own chat history/context and can be switched from the chat toolbar
- Micro Project mode — optional fast solo CEO mode for very small tasks, with complexity guardrails and explicit quality warning
- New project workflow — create projects directly from the Projects tab with immediate chat/project context sync
- Execution bridge for OpenAI/Ollama — implementation requests are executed in a local workspace via Codex runtime so tasks produce real files
- Structured project outputs — every project includes stakeholder summary, full plan, activation guide, and handoff templates
- Setup wizard — guided first-run configuration for team names, theme, and preferences
- Telegram mirror mode — toggle in CEO Chat to mirror user/CEO messages to your Telegram bot chat
- Keyboard shortcuts — press `?` to see all shortcuts
- Four themes — Midnight, Twilight, Dawn, and Sahara
- Default theme — Midnight
- Mobile-first navigation — drawer sidebar and stacked detail panels on narrow screens
- Improved readability — rebalanced contrast and unique palettes across Midnight, Twilight, Dawn, and Sahara
- Perceived-speed tuning — tab-aware polling and reduced forced smooth scrolling during live updates
- Provider runtimes — Anthropic (`Claude CLI` / `API key`), OpenAI (`API` / `Codex CLI`), and local OpenAI-compatible (`Ollama`, `LM Studio`, `llama.cpp`)

### API v1 (Advanced Controls)

The web backend now includes a versioned orchestration API at `/api/v1` with:

- Feature flags and health/version introspection
- Run lifecycle APIs (create/list/get/cancel/replay/guardrails/retry-step)
- Project metadata lifecycle (clone/archive/restore/delta/readme-quality/analytics/artifacts)
- Chat policy APIs (memory scope + retention)
- Sandbox profile discovery (`safe`, `standard`, `full`)
- GitHub controls (repo/branch/template/scan/sync/drift/rollback/issue projection)
- Vercel controls (link/deploy/domain/env)
- Deployment live feed stream source (from activity log)

### TUI Dashboard

```bash
compaas-tui
```

A terminal-based dashboard with org chart, project summary, task board, and activity feed. Refreshes every 3 seconds. Press `r` to force refresh, `q` to quit.

## Agent Roster

| Agent | Name | Role | Model | Team |
|-------|------|------|-------|------|
| ceo | Marcus | Central Orchestrator | opus | leadership |
| cto | Elena | Chief Technology Officer | opus | leadership |
| chief-researcher | Victor | Chief Researcher | opus | leadership |
| ciso | Rachel | Chief Information Security Officer | opus | leadership |
| cfo | Jonathan | Chief Financial Officer | sonnet | leadership |
| vp-product | Sarah | VP of Product | sonnet | leadership |
| vp-engineering | David | VP of Engineering | sonnet | leadership |
| lead-backend | James | Lead Backend Engineer | sonnet | engineering |
| lead-frontend | Priya | Lead Frontend Engineer | sonnet | engineering |
| lead-designer | Lena | Lead UI/UX Designer | sonnet | design |
| qa-lead | Carlos | QA Lead | sonnet | engineering |
| devops | Nina | DevOps Engineer | sonnet | engineering |
| security-engineer | Alex | Security Engineer | opus | on-demand |
| data-engineer | Maya | Data Engineer | sonnet | on-demand |
| tech-writer | Tom | Technical Writer | sonnet | on-demand |

## MCP Tools Reference

### Project Tools
- `create_project(name, description, type)` — Create a new project
- `get_project_status(project_id)` — Get project details
- `update_project(project_id, status, team, phase)` — Update project
- `list_projects()` — List all projects

### Task Board Tools
- `create_task(project_id, title, description, assigned_to, priority, depends_on)` — Create task
- `update_task_status(project_id, task_id, status, notes)` — Update task status (enforces state machine: todo -> in_progress -> review -> done)
- `get_task_board(project_id, filter_status, filter_assignee)` — Get task board
- `assign_task(project_id, task_id, assigned_to)` — Reassign task

### Memory Tools
- `read_memory(key)` — Read shared memory
- `write_memory(key, value)` — Write to shared memory
- `log_decision(project_id, title, decision, rationale, decided_by, alternatives)` — Log decision
- `get_decisions(project_id)` — Get decision log

### Company Tools
- `get_org_chart()` — Get organization chart
- `get_roster()` — Get all agents
- `hire_agent(name, role, expertise, tools, model)` — Hire new agent
- `fire_agent(name)` — Deactivate hired agent

### Metrics Tools
- `log_token_usage(agent_name, model, task_description, ...)` — Log token usage
- `get_token_report(project_id, agent_name)` — Get usage report
- `get_session_durations(agent_name)` — Get session durations
- `estimate_task_cost(task_description, model, complexity)` — Estimate cost

### Micro-Agent Tools
- `spawn_micro_agent(parent_agent, specialization, task_description, model)` — Spawn specialist
- `list_micro_agents()` — List active micro-agents
- `retire_micro_agent(name)` — Retire a micro-agent

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (optional) | Used for Anthropic API-key mode (or CLI auth fallback) |
| `OPENAI_API_KEY` | (optional) | Used for OpenAI API-key mode and optional Codex CLI auth |
| `COMPAAS_DATA_DIR` | `./company_data` | Company state directory |
| `PROJECTS_OUTPUT_DIR` | `~/projects` | Where generated project code is written |
| `COMPAAS_API_HOST` | `127.0.0.1` | Web dashboard host |
| `COMPAAS_API_PORT` | `8420` | Web dashboard port |
| `COMPAAS_CORS_ORIGINS` | `localhost:3000,5173,8420` | Allowed CORS origins |
| `COMPAAS_CORS_METHODS` | `GET` | Allowed CORS methods (set to `GET,POST,PATCH,DELETE` for cross-origin dev writes) |
| `COMPAAS_DEBUG` | `false` | Enable debug mode (hot-reload) |
| `COMPAAS_ADMIN_TOKEN` | (unset) | Optional admin token for remote-sensitive writes (e.g. `/api/integrations`) |
| `COMPAAS_GITHUB_WEBHOOK_SECRET` | (unset) | HMAC secret required to validate `X-Hub-Signature-256` on GitHub webhooks |
| `COMPAAS_SLACK_SIGNING_SECRET` | (unset) | Slack signing secret required to validate `X-Slack-Signature` and timestamp |

> **Note:** Use `COMPAAS_*` environment variables.

### Agent Customization

Agent definitions live in `.claude/agents/*.md`. Each file uses YAML frontmatter for model/tool configuration and Markdown for the role description.

```markdown
---
name: my-agent
description: What the agent does
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
---

Your role description here...
```

### Telegram Integration

COMPaaS supports Telegram chat mirroring: when enabled in CEO Chat, new user/CEO messages are mirrored to your bot conversation.

1. Create a bot in Telegram with [@BotFather](https://t.me/BotFather):
   - Run `/newbot`
   - Choose bot name and username
   - Copy the generated token (`123456789:ABC...`)
2. Start a conversation with your bot:
   - Open your bot in Telegram
   - Press **Start** or send any message (required before Telegram can return updates)
3. Get your chat ID:
   - Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in browser
   - Find `message.chat.id` in the latest update
   - Personal chats usually look like `123456789`
   - Group/supergroup chats are usually negative IDs like `-1001234567890`
4. (Optional) Use a group chat:
   - Add the bot to the group
   - Give it permission to send messages
   - In [@BotFather](https://t.me/BotFather), run `/setprivacy` and disable privacy mode if you need broader group message visibility
5. Save credentials in COMPaaS:
   - Open **Settings → Integrations → Telegram Integration**
   - Paste **Bot Token** and **Chat ID**
   - Click **Save Credentials**
6. Enable mirroring from CEO Chat:
   - Open **CEO Chat**
   - Click the **Telegram On/Off** toggle in the chat toolbar
   - When enabled, a “Telegram mirror is ON” banner appears in chat

Troubleshooting:
- `chat not found` means chat ID is wrong or the bot was never started in that chat.
- `bot was blocked by the user` means you need to unblock/start the bot again.
- Empty `getUpdates` response usually means no recent message was sent to the bot yet.
- If mirroring fails, re-save token/chat ID in Settings and toggle Telegram off/on in CEO Chat.

### GitHub Integration (Full Guide)

GitHub integration allows COMPaaS to create and update projects directly in repositories when project location is set to `GitHub`.

1. Prepare repository access:
   - Decide the target repo in `owner/repo` format (example: `comp-a-a-s/compaas`).
   - Confirm the default branch (`master` or `main`).
2. Create a GitHub token:
   - Open [GitHub token settings](https://github.com/settings/tokens).
   - Preferred: create a **fine-grained token** scoped to the target repo.
   - Alternative: classic token with `repo` scope.
3. Configure in COMPaaS:
   - Open **Settings → Integrations → Quick Connect → GitHub Connector**.
   - Fill:
     - `owner/repo`
     - default branch
     - token
   - Click **Connect & Verify**.
4. Confirm verification:
   - Status should change to **Verified**.
   - If not verified, read the connector status/error and fix token/repo permissions.
5. Use GitHub mode in projects:
   - In new project creation, choose location `GitHub`.
   - If GitHub is not verified, COMPaaS will block creation and route you back to setup.
6. Optional advanced behavior:
   - In **Settings → Integrations → Advanced Controls**, enable auto-push/auto-PR when desired.

Troubleshooting:
- `Not authorized` or verification failure usually means token lacks access to the selected repo.
- Verify repo spelling and case (`owner/repo` must match exactly).
- If token was rotated, paste the new token and verify again.

### Vercel Integration (Full Guide)

Vercel integration enables post-project deploy from CEO chat and deployment tooling in Integrations.

1. Create/import your Vercel project first:
   - Open [Vercel Dashboard](https://vercel.com/dashboard).
   - Create or import the app.
   - Copy the exact project name.
2. Create a Vercel token:
   - Open [Vercel token settings](https://vercel.com/account/tokens).
   - Create and copy a token.
3. Configure in COMPaaS:
   - Open **Settings → Integrations → Quick Connect → Vercel Connector**.
   - Fill:
     - project name
     - team ID (only for team-owned projects; leave empty for personal)
     - token
     - default target (`Preview` recommended)
   - Click **Connect & Verify**.
4. Confirm verification:
   - Status should change to **Verified**.
5. Deploy from CEO flow:
   - After project completion, CEO can offer deployment to Vercel.
   - Confirm deploy and receive deployment URL in chat.

Troubleshooting:
- `Not authorized` usually means invalid token or wrong scope/team context.
- `Project not found` means project name or team scope does not match.
- Re-verify after changing token, project name, or team ID.

### Themes

Choose from 4 built-in themes in Settings or during the Setup Wizard:
- **Midnight** — Dark ocean with teal/blue accents (default)
- **Twilight** — Deep indigo with cool highlights
- **Dawn** — Clean light mode with improved contrast
- **Sahara** — Warm earthy palette

## LLM Provider Modes

COMPaaS supports three providers and explicit runtime modes:

| Provider | Runtime mode | Backend behavior |
|----------|--------------|------------------|
| `anthropic` | `cli` | Runs Claude Code CLI with local auth (`--agent ceo` in full-crew mode) |
| `anthropic` | `apikey` | Runs Claude CLI with `ANTHROPIC_API_KEY` injected from config |
| `openai` | `apikey` | Uses OpenAI-compatible chat completions API |
| `openai` | `codex` | Runs local `codex exec --json` and streams response |
| `openai_compat` | `apikey` | Uses OpenAI-compatible local endpoint (e.g. Ollama) |

These values are stored in config as:
- `llm.provider`
- `llm.anthropic_mode`
- `llm.openai_mode`

## Micro Project Mode

`Micro Project` is a chat toggle for fast solo execution on very small tasks.

- CEO runs in a solo path with no planned delegation
- chat shows explicit quality-tradeoff warning and requires user approval on enable
- non-CEO agents are visually dimmed in the Agents panel while mode is active
- complex requests trigger a guardrail prompt: switch to full crew or continue anyway
- toggle is reversible in one click

## Provider Smoke Test

Use the built-in smoke harness to validate live CEO responses across providers:

```bash
# Start the API (example port used by smoke script)
COMPAAS_API_PORT=8421 COMPAAS_NO_BROWSER=true compaas-web
```

In another terminal:

```bash
export OPENAI_API_KEY="sk-..."
# Optional for anthropic_apikey scenario:
# export ANTHROPIC_API_KEY="sk-ant-..."

python3 scripts/provider_smoke_test.py --base-url http://127.0.0.1:8421
```

Run selected scenarios only:

```bash
python3 scripts/provider_smoke_test.py \
  --base-url http://127.0.0.1:8421 \
  --scenarios anthropic_cli,openai_api,openai_codex,ollama_local
```

Run the same checks in Micro Project mode:

```bash
python3 scripts/provider_smoke_test.py \
  --base-url http://127.0.0.1:8421 \
  --scenarios anthropic_cli,openai_codex,ollama_local \
  --micro-project
```

## Development

### Running Tests

```bash
# All tests
pytest tests/ -v

# With coverage
pytest tests/ --cov=src --cov-report=html

# Specific test file
pytest tests/test_validators.py -v
```

### Web Dashboard Development

```bash
cd web-dashboard
npm install
npm run dev    # Start Vite dev server (hot-reload)
npm run build  # Production build
npm run lint   # Run ESLint
```

### Project Structure

```
<repo-root>/
├── .claude/agents/          # 15 agent definitions (Markdown)
├── src/
│   ├── agents.py            # Centralized agent registry
│   ├── validators.py        # Input validation & state machine
│   ├── utils.py             # Atomic writes, file locking, log rotation
│   ├── state/               # YAML-based project & task state
│   │   ├── project_state.py # Project CRUD
│   │   └── task_board.py    # Task CRUD with dependency tracking
│   ├── mcp_server/          # MCP tools (6 scopes, 20+ tools)
│   ├── web/                 # FastAPI dashboard API + CEO chat WebSocket
│   └── tui/                 # Textual TUI dashboard
├── web-dashboard/           # React + TypeScript + Tailwind v4 frontend
│   └── src/
│       ├── api/client.ts    # API client (REST + WebSocket + SSE)
│       ├── components/      # UI components (Overview, Agents, Projects, Chat, etc.)
│       ├── hooks/           # Theme management, keyboard shortcuts
│       └── types/           # TypeScript interfaces
├── tests/                   # pytest test suite
├── scripts/hooks/           # Agent activity logging hooks
├── company_data/            # Runtime state (gitignored)
├── pyproject.toml           # Python project config
└── install.sh               # One-command installer
```

## Troubleshooting

**"Claude Code CLI not found"** — Install with: `npm install -g @anthropic-ai/claude-code`

**"ANTHROPIC_API_KEY not set"** — Needed only for Anthropic API-key mode. Add to `.env`: `ANTHROPIC_API_KEY=sk-ant-...`

**"OPENAI_API_KEY not set"** — Needed for OpenAI API-key mode (and optional for Codex auth): `OPENAI_API_KEY=sk-...`

**Web dashboard not loading** — Ensure Node.js 18+ is installed and run `cd web-dashboard && npm install && npm run build`

**CEO Chat not connecting** — Ensure the backend is running (`compaas-web`) and the configured runtime is installed (`claude`, `codex`, or local OpenAI-compatible endpoint). Chat uses WebSocket at `/api/chat/ws`.

**Tests failing** — Run `pip install -e ".[dev]"` to ensure all dev dependencies are installed

**Port 8420 in use** — Set a different port: `COMPAAS_API_PORT=9000 compaas-web`

**Cross-origin POST/PATCH blocked** — Set `COMPAAS_CORS_METHODS=GET,POST,PATCH,DELETE` when running frontend on a different origin.

**Integration tokens not visible in Settings/API config** — `/api/config` redacts saved GitHub/Slack tokens by design. Enter a new token only when you want to rotate/replace it.

**GitHub/Slack webhooks return 401/503** — Set `COMPAAS_GITHUB_WEBHOOK_SECRET` and `COMPAAS_SLACK_SIGNING_SECRET` to enable signed webhook verification.

## Quality Snapshot (February 19, 2026)

- Backend regression fixes:
  - Restored strict built-in model validation (`opus`, `sonnet`, `haiku`) used by hiring/micro-agent tools.
  - Fixed org chart defaults to `Idan` (board head) and `Marcus` (CEO) when config is empty.
  - Hardened default CORS method policy to `GET` (configurable via `COMPAAS_CORS_METHODS`).
- UI modernization:
  - Rebranded app surfaces to **COMPaaS** with a compass-rose logo (sidebar, setup wizard, favicon).
  - Refreshed theme tokens and typography (`Space Grotesk` + improved contrast, gradients, motion polish).
  - Reduced dashboard polling cost by separating lightweight project refreshes from heavier task detail refreshes.
  - Consolidated chat secondary controls into a single `More` menu (export, memory, summarize, clear) to reduce header clutter.
  - Split Settings into focused tabs (`General`, `AI`, `Agents`, `Integrations`, `Appearance`) to improve scan speed and reduce cognitive load.
- Compatibility:
  - Added `compaas-web` / `compaas-tui` entry points.

## License

MIT
