# CrackPie

A multi-agent AI orchestration system that simulates a virtual software company powered by Claude Code agents. 15 specialized agents (CEO, CTO, engineers, designers, QA, and more) collaborate through an MCP server to manage projects, track tasks, and build software.

## Architecture

```
Board Head (Idan)
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
- **Claude Code CLI** (`npm install -g @anthropic-ai/claude-code`)
- **Anthropic API key**

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/Idanhen26/crackpie.git
cd crackpie

# 2. Run the installer
./install.sh

# 3. Set your API key
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env

# 4. Activate the virtual environment
source .venv/bin/activate

# 5. Start the CEO agent
claude --agent ceo
```

## Installation (Detailed)

### Automated Installation

```bash
./install.sh
```

The installer handles all 8 steps: Python check, Node.js check, Claude Code check, virtual environment, Python dependencies, web dashboard build, environment setup, and test verification.

### Manual Installation

**Step 1: Python dependencies**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
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
# Edit .env and set ANTHROPIC_API_KEY
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

### Working with the CEO Agent

The CEO is the central orchestrator. Start it with Claude Code:

```bash
claude --agent ceo
```

Then give it instructions like:
- "Build me a task management API with a React frontend"
- "Research the best tech stack for a real-time chat application"
- "Create a project plan for an e-commerce platform"

The CEO will delegate to specialized agents (CTO, engineers, designers, etc.) and manage the full development lifecycle.

### Web Dashboard

```bash
crackpie-web
# Opens at http://localhost:8420
```

Features: org chart, project list with progress, task boards, real-time activity feed (SSE), token metrics.

### TUI Dashboard

```bash
crackpie-tui
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
- `create_project(name, description, type)` - Create a new project
- `get_project_status(project_id)` - Get project details
- `update_project(project_id, status, team, phase)` - Update project
- `list_projects()` - List all projects

### Task Board Tools
- `create_task(project_id, title, description, assigned_to, priority, depends_on)` - Create task
- `update_task_status(project_id, task_id, status, notes)` - Update task status
- `get_task_board(project_id, filter_status, filter_assignee)` - Get task board
- `assign_task(project_id, task_id, assigned_to)` - Reassign task

### Memory Tools
- `read_memory(key)` - Read shared memory
- `write_memory(key, value)` - Write to shared memory
- `log_decision(project_id, title, decision, rationale, decided_by, alternatives)` - Log decision
- `get_decisions(project_id)` - Get decision log

### Company Tools
- `get_org_chart()` - Get organization chart
- `get_roster()` - Get all agents
- `hire_agent(name, role, expertise, tools, model)` - Hire new agent
- `fire_agent(name)` - Deactivate hired agent

### Metrics Tools
- `log_token_usage(agent_name, model, task_description, ...)` - Log token usage
- `get_token_report(project_id, agent_name)` - Get usage report
- `get_session_durations(agent_name)` - Get session durations
- `estimate_task_cost(task_description, model, complexity)` - Estimate cost

### Micro-Agent Tools
- `spawn_micro_agent(parent_agent, specialization, task_description, model)` - Spawn specialist
- `list_micro_agents()` - List active micro-agents
- `retire_micro_agent(name)` - Retire a micro-agent

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `CRACKPIE_DATA_DIR` | `./company_data` | Company state directory |
| `PROJECTS_OUTPUT_DIR` | `~/projects` | Where generated project code is written |
| `CRACKPIE_API_HOST` | `127.0.0.1` | Web dashboard host |
| `CRACKPIE_API_PORT` | `8420` | Web dashboard port |
| `CRACKPIE_CORS_ORIGINS` | `localhost:3000,5173,8420` | Allowed CORS origins (comma-separated) |
| `CRACKPIE_DEBUG` | `false` | Enable debug mode (hot-reload) |

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

### Project Structure

```
crackpie/
├── .claude/agents/          # 15 agent definitions (Markdown)
├── src/
│   ├── agents.py            # Centralized agent registry
│   ├── validators.py        # Input validation & state machine
│   ├── utils.py             # Atomic writes, file locking, log rotation
│   ├── state/               # YAML-based project & task state
│   ├── mcp_server/          # MCP tools (6 scopes, 20+ tools)
│   ├── web/                 # FastAPI dashboard API
│   └── tui/                 # Textual TUI dashboard
├── web-dashboard/           # React + TypeScript frontend
├── tests/                   # pytest test suite
├── scripts/hooks/           # Agent activity logging hooks
├── company_data/            # Runtime state (gitignored)
├── pyproject.toml           # Python project config
└── install.sh               # One-command installer
```

## Troubleshooting

**"Claude Code CLI not found"** - Install with: `npm install -g @anthropic-ai/claude-code`

**"ANTHROPIC_API_KEY not set"** - Add your key to `.env`: `ANTHROPIC_API_KEY=sk-ant-...`

**Web dashboard not loading** - Ensure Node.js 18+ is installed and run `cd web-dashboard && npm install && npm run build`

**Tests failing** - Run `pip install -e ".[dev]"` to ensure all dev dependencies are installed

**Port 8420 in use** - Set a different port: `CRACKPIE_API_PORT=9000 crackpie-web`

## License

MIT
