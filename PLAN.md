# CrackPie - Comprehensive Improvement Plan

## Table of Contents

1. [Security Fixes (P0 - Critical)](#1-security-fixes-p0---critical)
2. [Input Validation & Data Integrity (P1)](#2-input-validation--data-integrity-p1)
3. [File Operations Hardening (P1)](#3-file-operations-hardening-p1)
4. [Comprehensive Test Plan (P2)](#4-comprehensive-test-plan-p2)
5. [Agent Role Improvements (P2)](#5-agent-role-improvements-p2)
6. [README & Documentation (P2)](#6-readme--documentation-p2)
7. [Requirements & Dependencies Update (P3)](#7-requirements--dependencies-update-p3)
8. [Additional Platform Improvements (P3)](#8-additional-platform-improvements-p3)

---

## 1. Security Fixes (P0 - Critical)

### 1.1 CORS Restriction
**File:** `src/web/api.py:62-67`

Replace wildcard CORS with explicit allowed origins:
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:8420",
    ],
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)
```
Also add support for `CRACKPIE_CORS_ORIGINS` env var to configure additional origins.

### 1.2 Path Traversal Protection
**Files affected:** `src/state/project_state.py:15`, `src/state/task_board.py:18`, `src/mcp_server/memory_tools.py:72,100`, `src/web/api.py:150,163`, `src/mcp_server/micro_agent_tools.py:242`

Create a shared validation utility in `src/utils.py`:
```python
import re

SAFE_ID_PATTERN = re.compile(r'^[a-zA-Z0-9_-]+$')

def validate_safe_id(value: str, field_name: str = "id") -> str:
    """Validate that an ID is safe for use in file paths."""
    if not value or not SAFE_ID_PATTERN.match(value):
        raise ValueError(f"Invalid {field_name}: must be alphanumeric with hyphens/underscores only")
    if '..' in value or value.startswith('/'):
        raise ValueError(f"Invalid {field_name}: path traversal not allowed")
    return value

def safe_path_join(base_dir: str, *parts: str) -> str:
    """Join paths and verify result is within base_dir."""
    joined = os.path.join(base_dir, *parts)
    real = os.path.realpath(joined)
    if not real.startswith(os.path.realpath(base_dir)):
        raise ValueError("Path traversal detected")
    return joined
```

Apply `validate_safe_id()` to every function that receives `project_id`, agent `name`, or `task_id` from external input.

### 1.3 Environment Variable Validation
**File:** `src/utils.py:14-16`

Validate that `CRACKPIE_DATA_DIR` points to a safe, writable location:
```python
if env_dir:
    abs_dir = os.path.abspath(env_dir)
    if not os.path.isdir(abs_dir):
        raise ValueError(f"CRACKPIE_DATA_DIR '{abs_dir}' does not exist or is not a directory")
    return abs_dir
```

### 1.4 Uvicorn Production Config
**File:** `src/web/main.py:6`

Remove `reload=True` and bind to `127.0.0.1` by default:
```python
def main():
    host = os.environ.get("CRACKPIE_API_HOST", "127.0.0.1")
    port = int(os.environ.get("CRACKPIE_API_PORT", "8420"))
    debug = os.environ.get("CRACKPIE_DEBUG", "").lower() == "true"
    uvicorn.run("src.web.api:app", host=host, port=port, reload=debug)
```

---

## 2. Input Validation & Data Integrity (P1)

### 2.1 Enum Validation for Constrained Fields

Create `src/validators.py`:
```python
from enum import Enum

class TaskStatus(str, Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    DONE = "done"
    BLOCKED = "blocked"

class TaskPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"

class AgentModel(str, Enum):
    OPUS = "opus"
    SONNET = "sonnet"
    HAIKU = "haiku"

class Complexity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    VERY_HIGH = "very_high"

# Valid status transitions (state machine)
VALID_TRANSITIONS = {
    "todo": {"in_progress", "blocked"},
    "in_progress": {"review", "done", "blocked"},
    "review": {"in_progress", "done", "blocked"},
    "done": set(),          # terminal state
    "blocked": {"todo", "in_progress"},
}

def validate_status_transition(current: str, new: str) -> bool:
    return new in VALID_TRANSITIONS.get(current, set())
```

### 2.2 Apply Validation to MCP Tools

**company_tools.py - hire_agent():** Validate `name` matches `^[a-z0-9-]+$`, `model` is valid AgentModel, each tool in `tools` is a known tool name. Check name doesn't collide with CORE_TEAM or ON_DEMAND_TEAM.

**task_board_tools.py - create_task():** Validate `priority` is valid TaskPriority. Validate `depends_on` task IDs actually exist in the project.

**task_board.py - update_status():** Enforce state machine transitions via `validate_status_transition()`.

**metrics_tools.py - log_token_usage():** Validate token counts are non-negative integers. Validate `model` is valid AgentModel.

**metrics_tools.py - estimate_task_cost():** Validate `complexity` is valid Complexity enum.

**micro_agent_tools.py - spawn_micro_agent():** Validate `parent_agent` exists. Escape YAML values in generated content to prevent YAML injection.

### 2.3 Task Dependency Enforcement

**File:** `src/state/task_board.py`

Add dependency validation before status transitions:
```python
def _check_dependencies_resolved(self, project_id: str, task: dict) -> list[str]:
    """Return list of blocking task IDs that are not 'done'."""
    if not task.get("depends_on"):
        return []
    board = self._load_board(project_id)
    all_tasks = {t["id"]: t for t in board["tasks"]}
    blockers = []
    for dep_id in task["depends_on"]:
        dep = all_tasks.get(dep_id)
        if dep and dep["status"] != "done":
            blockers.append(dep_id)
    return blockers
```

Block transitions to `done` or `review` if dependencies are unresolved.

---

## 3. File Operations Hardening (P1)

### 3.1 Atomic File Writes

Create a helper in `src/utils.py`:
```python
import tempfile

def atomic_yaml_write(path: str, data: dict) -> None:
    """Write YAML atomically using temp file + rename."""
    dir_name = os.path.dirname(path)
    os.makedirs(dir_name, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".yaml.tmp")
    try:
        with os.fdopen(fd, "w") as f:
            yaml.dump(data, f, default_flow_style=False)
        os.replace(tmp_path, path)  # atomic on POSIX
    except:
        os.unlink(tmp_path)
        raise
```

Replace all `open(path, "w") + yaml.dump()` patterns in:
- `src/state/project_state.py:37-38, 63-64`
- `src/state/task_board.py:34-35`
- `src/mcp_server/company_tools.py:39-41`
- `src/mcp_server/memory_tools.py:18-21, 88-89`
- `src/mcp_server/metrics_tools.py:10-22`
- `src/mcp_server/micro_agent_tools.py:138-141`

### 3.2 File Locking

Add advisory file locking for write operations using `fcntl`:
```python
import fcntl

class FileLock:
    def __init__(self, path):
        self.lock_path = path + ".lock"

    def __enter__(self):
        self.fd = open(self.lock_path, "w")
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *args):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        self.fd.close()
```

Apply to all read-modify-write operations.

### 3.3 Activity Log Rotation

Add log rotation to the activity logging mechanism:
```python
MAX_LOG_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_LOG_FILES = 5

def rotate_activity_log(log_path: str) -> None:
    if os.path.exists(log_path) and os.path.getsize(log_path) > MAX_LOG_SIZE:
        for i in range(MAX_LOG_FILES - 1, 0, -1):
            src = f"{log_path}.{i}"
            dst = f"{log_path}.{i + 1}"
            if os.path.exists(src):
                os.replace(src, dst)
        os.replace(log_path, f"{log_path}.1")
```

---

## 4. Comprehensive Test Plan (P2)

Current coverage: ~25% of source modules, ~20% of functions. Target: 80%+ coverage.

### 4.1 New Test: `tests/test_validators.py` (~25 tests)

```
TestSafeId:
  - test_valid_uuid_id
  - test_valid_slug_id
  - test_reject_path_traversal_dots
  - test_reject_absolute_path
  - test_reject_special_characters
  - test_reject_empty_string

TestSafePathJoin:
  - test_normal_join
  - test_reject_traversal_attempt
  - test_reject_symlink_escape

TestStatusTransition:
  - test_valid_transitions_from_todo
  - test_valid_transitions_from_in_progress
  - test_valid_transitions_from_review
  - test_reject_done_to_todo (terminal state)
  - test_reject_todo_to_done (skip states)
  - test_blocked_can_return_to_todo

TestEnumValidation:
  - test_valid_task_status_values
  - test_invalid_task_status_rejected
  - test_valid_priority_values
  - test_valid_model_values
  - test_valid_complexity_values
```

### 4.2 New Test: `tests/test_project_tools.py` (~20 tests)

```
TestCreateProject:
  - test_create_returns_project_id
  - test_create_with_all_params
  - test_create_with_special_chars_in_name
  - test_create_with_empty_name
  - test_create_with_very_long_name

TestGetProjectStatus:
  - test_get_existing_project
  - test_get_nonexistent_project
  - test_get_with_path_traversal_id

TestUpdateProject:
  - test_update_status
  - test_update_team
  - test_update_phase
  - test_update_nonexistent_project
  - test_update_with_invalid_status

TestListProjects:
  - test_list_empty
  - test_list_multiple
  - test_list_after_create_and_update
```

### 4.3 New Test: `tests/test_task_tools.py` (~25 tests)

```
TestCreateTask:
  - test_create_basic_task
  - test_create_with_dependencies
  - test_create_with_invalid_priority
  - test_create_with_nonexistent_project
  - test_create_with_path_traversal_project_id

TestUpdateTaskStatus:
  - test_valid_status_transition
  - test_invalid_status_transition
  - test_update_with_notes
  - test_update_nonexistent_task
  - test_block_done_with_unresolved_deps

TestGetTaskBoard:
  - test_get_all_tasks
  - test_filter_by_status
  - test_filter_by_assignee
  - test_filter_by_both
  - test_empty_board

TestAssignTask:
  - test_assign_to_valid_agent
  - test_assign_nonexistent_task
  - test_reassign_task
```

### 4.4 New Test: `tests/test_memory_tools.py` (~20 tests)

```
TestWriteMemory:
  - test_write_new_key
  - test_overwrite_existing_key
  - test_write_with_special_chars_in_value
  - test_persistence_across_calls

TestReadMemory:
  - test_read_existing_key
  - test_read_nonexistent_key
  - test_read_all_keys
  - test_read_empty_memory

TestLogDecision:
  - test_log_basic_decision
  - test_log_with_alternatives
  - test_log_to_nonexistent_project
  - test_multiple_decisions_same_project
  - test_decision_timestamp_format

TestGetDecisions:
  - test_get_existing_decisions
  - test_get_no_decisions
  - test_get_nonexistent_project
```

### 4.5 New Test: `tests/test_company_tools.py` (~20 tests)

```
TestHireAgent:
  - test_hire_new_agent
  - test_hire_duplicate_name
  - test_hire_with_invalid_name_chars
  - test_hire_with_invalid_model
  - test_hire_core_team_name_collision
  - test_hire_persists_to_file

TestFireAgent:
  - test_fire_hired_agent
  - test_fire_core_team_blocked
  - test_fire_on_demand_team_blocked
  - test_fire_nonexistent_agent

TestGetOrgChart:
  - test_org_chart_structure
  - test_org_chart_includes_hired_agents
  - test_org_chart_after_fire

TestGetRoster:
  - test_roster_completeness
  - test_roster_agent_fields
```

### 4.6 New Test: `tests/test_metrics_tools.py` (~20 tests)

```
TestLogTokenUsage:
  - test_log_basic_usage
  - test_log_with_all_fields
  - test_log_negative_tokens_rejected
  - test_log_invalid_model_rejected
  - test_log_persistence

TestGetTokenReport:
  - test_report_empty
  - test_report_aggregation_by_agent
  - test_report_aggregation_by_model
  - test_report_filter_by_project
  - test_report_filter_by_agent

TestGetSessionDurations:
  - test_parse_start_stop_pair
  - test_parse_malformed_lines
  - test_empty_activity_log
  - test_filter_by_agent

TestEstimateTaskCost:
  - test_estimate_low_complexity
  - test_estimate_high_complexity
  - test_estimate_different_models
  - test_estimate_invalid_complexity_defaults
```

### 4.7 New Test: `tests/test_micro_agent_tools.py` (~15 tests)

```
TestSpawnMicroAgent:
  - test_spawn_creates_file
  - test_spawn_generates_correct_name
  - test_spawn_duplicate_prevented
  - test_spawn_with_custom_model
  - test_spawn_sanitizes_specialization
  - test_spawn_logs_to_yaml

TestListMicroAgents:
  - test_list_empty
  - test_list_after_spawn
  - test_list_multiple_agents

TestRetireMicroAgent:
  - test_retire_existing_agent
  - test_retire_nonexistent_agent
  - test_retire_removes_file
  - test_retire_with_path_traversal_blocked
```

### 4.8 New Test: `tests/test_api.py` (~30 tests)

Uses `pytest` + `httpx.AsyncClient` with FastAPI's `TestClient`:

```
TestOrgChartEndpoint:
  - test_get_org_chart_200
  - test_org_chart_structure

TestProjectsEndpoint:
  - test_list_projects_empty
  - test_list_projects_with_data
  - test_get_project_detail_200
  - test_get_project_detail_404
  - test_get_project_path_traversal_400

TestTasksEndpoint:
  - test_get_tasks_200
  - test_get_tasks_filter_status
  - test_get_tasks_filter_assignee
  - test_get_tasks_nonexistent_project

TestActivityStream:
  - test_stream_returns_sse
  - test_stream_content_type

TestMetricsEndpoint:
  - test_get_token_report_200
  - test_get_token_report_with_filters

TestAgentsEndpoint:
  - test_list_agents_200
  - test_agents_have_required_fields
  - test_agents_include_all_teams

TestSettingsEndpoint:
  - test_get_model_settings_200
  - test_model_settings_structure
```

### 4.9 New Test: `tests/test_integration.py` (~15 tests)

```
TestProjectLifecycle:
  - test_create_project_then_add_tasks
  - test_update_task_status_through_workflow
  - test_log_decisions_for_project
  - test_full_project_lifecycle

TestAgentLifecycle:
  - test_hire_agent_shows_in_org_chart
  - test_spawn_micro_agent_shows_in_list
  - test_retire_micro_agent_removes_from_list

TestMetricsIntegration:
  - test_token_logging_shows_in_report
  - test_cost_estimation_matches_actual_logging

TestConcurrency:
  - test_concurrent_task_creation
  - test_concurrent_project_updates
```

### 4.10 Test Infrastructure

**conftest.py:**
```python
import pytest
import tempfile
import os

@pytest.fixture
def temp_data_dir(tmp_path):
    """Provide isolated temp data directory for each test."""
    os.environ["CRACKPIE_DATA_DIR"] = str(tmp_path / "company_data")
    yield tmp_path / "company_data"
    os.environ.pop("CRACKPIE_DATA_DIR", None)

@pytest.fixture
def state_manager(temp_data_dir):
    from src.state.project_state import ProjectStateManager
    return ProjectStateManager(str(temp_data_dir))

@pytest.fixture
def task_board(temp_data_dir):
    from src.state.task_board import TaskBoard
    return TaskBoard(str(temp_data_dir))
```

**Total new tests: ~190 tests** (current: 33, target: ~223)

---

## 5. Agent Role Improvements (P2)

### 5.1 Critical Fixes

**CTO (Elena) - Expand from 42 to 120+ lines:**
- Add technology evaluation framework (weighted scoring matrix)
- Add architecture decision record (ADR) template with sections: Context, Decision, Consequences, Alternatives
- Add scalability assessment criteria (horizontal/vertical, CAP theorem considerations)
- Add technical debt management framework (debt quadrant: reckless/prudent x deliberate/inadvertent)
- Add cross-agent coordination: CTO ↔ CISO security architecture review protocol, CTO ↔ CFO cost impact assessment
- Add performance benchmarking guidance (define SLOs, measure P50/P95/P99 latencies)
- Add technology radar: Adopt / Trial / Assess / Hold categories
- Add backward compatibility and API versioning strategy

**Data Engineer (Maya) - Expand from 36 to 80+ lines:**
- Add modern data stack guidance: ELT patterns, dbt for transformations
- Add data modeling patterns: star schema, snowflake, data vault
- Add data quality framework: completeness, accuracy, consistency, timeliness checks
- Add data governance: PII handling, data classification, retention policies (coordinate with CISO)
- Add pipeline monitoring: SLA tracking, data freshness alerts, schema drift detection
- Add backup and disaster recovery: point-in-time recovery, cross-region replication
- Add performance guidelines: partitioning strategies, indexing best practices, query plan analysis

**Tech Writer (Tom) - Expand from 35 to 60+ lines AND upgrade model to Sonnet:**
- Add API documentation framework: OpenAPI/Swagger spec generation, endpoint examples
- Add documentation versioning strategy: docs-as-code, version branches
- Add docs quality checklist: accuracy, completeness, code examples tested, screenshots current
- Add information architecture: navigation hierarchy, search optimization
- Add changelog management: semantic versioning, migration guides for breaking changes
- Upgrade from Haiku to Sonnet for better technical comprehension

**Security Engineer (Alex) - Add Write tool:**
- Current tools: `Read, Glob, Grep, WebSearch, WebFetch, Bash`
- Change to: `Read, Write, Glob, Grep, WebSearch, WebFetch, Bash`
- Rationale: Cannot create security audit reports or remediation guides without Write

### 5.2 High-Value Enhancements

**CEO (Marcus) - Add escalation and crisis management:**
- Add escalation protocol: when agent reports blocker → CEO investigates → reassigns or spawns micro-agent
- Add cross-project resource scheduling: priority matrix when multiple projects compete for same agent
- Add rollback procedure: if a wave fails, how to revert and reassign
- Add quality gates between waves: checklist before advancing to next wave

**DevOps (Nina) - Add modern DevOps practices:**
- Add observability stack: logging (structured JSON), metrics (Prometheus/Grafana), tracing (OpenTelemetry)
- Add disaster recovery procedures: RTO/RPO targets, backup verification, failover testing
- Add multi-environment strategy: dev → staging → prod promotion pipeline
- Add security scanning in CI/CD: SAST (Semgrep), DAST, dependency audit (npm audit, pip-audit)
- Add rollback procedures: blue-green, canary, feature flags

**QA Lead (Carlos) - Add modern testing practices:**
- Add accessibility testing: axe-core, Lighthouse audits, screen reader testing
- Add performance testing: load testing (k6, Locust), Core Web Vitals targets
- Add security testing: OWASP ZAP scans, dependency vulnerability checks
- Add visual regression testing: screenshot comparison, Chromatic/Percy
- Add test environment management: fixtures, factories, test data generation

**Lead Backend (James) - Add distributed systems guidance:**
- Add API versioning strategy: URL versioning, header versioning, deprecation timeline
- Add rate limiting implementation: token bucket, sliding window
- Add authentication/authorization integration: reference CISO decisions, implement JWT/OAuth
- Add monitoring: structured logging, health check endpoints, circuit breakers

**Lead Frontend (Priya) - Add modern frontend practices:**
- Add state management recommendations: Zustand for simple, Redux Toolkit for complex
- Add performance targets: LCP < 2.5s, FID < 100ms, CLS < 0.1
- Add form handling: React Hook Form + Zod validation
- Add error boundary strategy: global + per-feature boundaries
- Add component documentation: Storybook for component library

**VP Engineering (David) - Add process improvements:**
- Add code review standards: PR size limits, review SLA, required reviewers
- Add Definition of Done checklist: tests pass, docs updated, security reviewed, accessibility checked
- Add velocity tracking: story points, burndown, cycle time
- Add retrospective framework: Start/Stop/Continue format
- Add technical debt budgeting: 20% sprint capacity for tech debt

### 5.3 Cross-Agent Coordination Protocols

Add to CEO definition:

**Handoff Protocol (all agents):**
```
When completing a task and handing off to another agent:
1. Update task status to "review"
2. Add notes summarizing what was done and any open items
3. Create follow-up task assigned to receiving agent
4. Reference the original task in depends_on
```

**Escalation Protocol:**
```
If blocked for any reason:
1. Update task status to "blocked"
2. Add notes explaining the blocker
3. CEO will triage within next delegation cycle
4. If urgent, spawn micro-agent to unblock
```

**Architecture Review Protocol (CTO + CISO):**
```
For any new service or major feature:
1. CTO produces architecture proposal
2. CISO reviews for security concerns
3. Both sign off via decision log before implementation begins
```

---

## 6. README & Documentation (P2)

### 6.1 Create comprehensive `README.md`

Structure:
```
# CrackPie - Multi-Agent AI Orchestration System

## Overview
Brief description of what CrackPie is and what it does.

## Architecture
- Diagram of agent hierarchy
- MCP server layer description
- State management explanation
- Dashboard overview

## Prerequisites
- Python 3.10+
- Node.js 18+ (optional, for web dashboard)
- Claude Code CLI
- Anthropic API key

## Quick Start
1. Clone the repository
2. Run install.sh
3. Configure .env
4. Start using with Claude Code

## Installation (Detailed)
### Automated Installation
  $ ./install.sh

### Manual Installation
  Step-by-step for each component:
  1. Python dependencies
  2. Web dashboard build
  3. Environment configuration
  4. Hook setup
  5. Verification

## Usage
### Starting the Web Dashboard
### Starting the TUI Dashboard
### Working with the CEO Agent
### Creating a Project
### Managing Tasks

## Agent Roster
Table of all 15 agents with roles, models, and capabilities.

## MCP Tools Reference
Grouped by scope: project, tasks, memory, company, metrics, micro_agents.

## Configuration
### Environment Variables
### Hook Configuration
### Agent Customization

## Development
### Running Tests
### Adding New Agents
### Extending MCP Tools

## Project Structure
Directory tree with descriptions.

## Troubleshooting
Common issues and solutions.

## Contributing
Guidelines for contributing.

## License
```

---

## 7. Requirements & Dependencies Update (P3)

### 7.1 Update `pyproject.toml`

Add missing dependencies:
```toml
dependencies = [
    "fastmcp>=2.0,<3.0",
    "pyyaml>=6.0,<7.0",
    "textual>=0.50,<1.0",
    "watchfiles>=0.20",
    "fastapi>=0.100,<1.0",
    "uvicorn[standard]>=0.25",
    "sse-starlette>=1.6",
    "python-dotenv>=1.0",       # NEW: .env file support
    "pydantic>=2.0,<3.0",       # NEW: data validation
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.23",
    "pytest-cov>=4.0",          # NEW: coverage reports
    "httpx>=0.25",              # NEW: async test client for FastAPI
    "ruff>=0.4",                # NEW: fast Python linter
    "mypy>=1.8",                # NEW: type checking
]
```

### 7.2 Update `.gitignore`

Add missing patterns:
```
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
coverage/
htmlcov/
dist/
build/
*.log
*.swp
*.swo
*~
.env.local
```

### 7.3 Update `.env.example`

Add all configuration options:
```
# Required
ANTHROPIC_API_KEY=

# Data & Output
CRACKPIE_DATA_DIR=./company_data
PROJECTS_OUTPUT_DIR=~/projects

# Web Dashboard
CRACKPIE_API_HOST=127.0.0.1
CRACKPIE_API_PORT=8420
CRACKPIE_CORS_ORIGINS=http://localhost:3000,http://localhost:5173

# Debugging
CRACKPIE_DEBUG=false
CRACKPIE_LOG_LEVEL=INFO
```

---

## 8. Additional Platform Improvements (P3)

### 8.1 Centralize Agent Name Mappings

Currently duplicated in 3 files (`api.py`, `app.py`, `company_tools.py`). Create `src/agents.py`:
```python
AGENT_REGISTRY = {
    "ceo": {"name": "Marcus", "team": "leadership", "model": "opus"},
    "cto": {"name": "Elena", "team": "leadership", "model": "opus"},
    # ... all agents
}

def get_agent_display_name(slug: str) -> str:
    return AGENT_REGISTRY.get(slug, {}).get("name", slug.replace("-", " ").title())
```

Import from this single source in all files.

### 8.2 Externalize Model Costs

**File:** `src/mcp_server/metrics_tools.py:207-211`

Move hardcoded costs to `config/model_costs.yaml`:
```yaml
# Last updated: 2025-XX-XX
# Source: https://docs.anthropic.com/en/docs/about-claude/models
models:
  opus:
    input_per_million: 15.0
    output_per_million: 75.0
  sonnet:
    input_per_million: 3.0
    output_per_million: 15.0
  haiku:
    input_per_million: 0.25
    output_per_million: 1.25
```

### 8.3 Structured Logging

Replace print statements and raw file writes with structured logging:
```python
import logging
import json

logger = logging.getLogger("crackpie")

class JSONFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "module": record.module,
            "message": record.getMessage(),
        })
```

### 8.4 Health Check Endpoint

Add to `src/web/api.py`:
```python
@app.get("/api/health")
def health_check():
    return {
        "status": "healthy",
        "version": "0.1.0",
        "data_dir_exists": os.path.isdir(data_dir),
        "agents_dir_exists": os.path.isdir(agents_dir),
    }
```

### 8.5 API Rate Limiting

Add simple rate limiting middleware for the web API to prevent abuse (use `slowapi` or custom middleware with in-memory counter).

### 8.6 Duplicate Agent Name Mapping Fix

The TUI hardcodes agent data at `src/tui/app.py:20-33`. Refactor to load from the centralized `src/agents.py` registry (see 8.1).

### 8.7 SSE Connection Management

**File:** `src/web/api.py:179-220`

Add max concurrent connection limit and proper cleanup:
```python
MAX_SSE_CONNECTIONS = 10
active_connections = 0

@app.get("/api/activity/stream")
async def activity_stream():
    global active_connections
    if active_connections >= MAX_SSE_CONNECTIONS:
        raise HTTPException(status_code=429, detail="Too many SSE connections")
    active_connections += 1
    try:
        # ... existing SSE logic
    finally:
        active_connections -= 1
```

### 8.8 Future Considerations

- **Database migration**: When file-based YAML hits scaling limits (~1000+ projects), migrate to SQLite → PostgreSQL
- **Authentication layer**: Add API key auth as first step, OAuth2/JWT for multi-user
- **Webhook support**: Allow external systems to subscribe to project/task events
- **Plugin system**: Allow custom agent types without modifying core code
- **Metrics dashboard**: Grafana integration for real-time token cost monitoring
- **Backup system**: Automated daily backup of company_data/ with retention policy
- **Multi-tenant support**: Isolate company_data per team/organization

---

## Implementation Order

| Phase | Items | Estimated Tests |
|-------|-------|-----------------|
| 1 | Security fixes (1.1-1.4) + Validators (2.1) | +25 tests |
| 2 | Input validation (2.2-2.3) + File hardening (3.1-3.3) | +30 tests |
| 3 | Core tool tests (4.2-4.7) | +120 tests |
| 4 | Agent improvements (5.1-5.3) | N/A |
| 5 | README + dependency updates (6-7) | N/A |
| 6 | API tests + integration tests (4.8-4.9) | +45 tests |
| 7 | Platform improvements (8.1-8.7) | +10 tests |

**Total new tests: ~230 | Grand total: ~263**
