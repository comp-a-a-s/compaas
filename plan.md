# Plan: CEO Complexity-Based Delegation Framework + Runtime Budget Fix

## Problem 1: Runtime Budget Exceeded (900s)

### Root Cause
The CEO runs under the "standard" sandbox profile which allows only 900 seconds (15 minutes). For anything beyond a simple single-agent delegation, this is insufficient. The profile is selected via `data.get("sandbox_profile", "standard")` in the WebSocket handler — it's always "standard" unless the frontend explicitly sends a different value.

### Solution: Auto-Select Profile Based on Intent Complexity
Instead of hardcoding "standard", derive the sandbox profile from the intent classification that already runs:

| Intent Class | Sandbox Profile | Timeout |
|---|---|---|
| greeting, status, clarification | safe | 300s (5 min) |
| question, review | standard | 900s (15 min) |
| planning, execution (simple) | standard | 900s (15 min) |
| execution (complex — `needs_planning=True`) | full | 1800s (30 min) |

**Implementation**: In `src/web/api.py`, after `_classify_execution_intent()`, if the intent says `needs_planning=True` AND `delegate_allowed=True`, default to "full" profile instead of "standard". The frontend can still override via `sandbox_profile` in the payload.

### Files Changed
- `src/web/api.py` — default profile selection logic after intent classification

---

## Problem 2: CEO Delegation Framework

### Current State
The CEO template has a single workflow: new idea → parallel research → sequential waves. Every task gets the same heavy process regardless of complexity. Simple tasks (write docs, research a competitor) trigger the same wave-based machinery as full product launches.

### Solution: Complexity-Based Delegation Tiers in CEO Prompt
Rewrite the CEO template to include a **decision tree** that runs before any delegation. The CEO:
1. Assesses 4 dimensions (Scope, Risk, Effort, Visibility)
2. Determines the Complexity Tier (1-4)
3. Follows the tier-specific delegation pattern

This is primarily a **prompt engineering** change — the CEO is an LLM agent that follows its system prompt. The intelligence lives in the prompt, not in code.

### The Four Tiers (CEO Template)

**Tier 1 — Simple / Single-Domain** (~5 min)
- 1 role, no cross-team dependency
- CEO delegates directly, steps away
- Examples: write docs, research competitor, fix minor bug, financial summary

**Tier 2 — Moderate / Two-Domain** (~15 min)
- 2-3 roles, defined hand-off point
- CEO delegates to both owners, monitors output
- Examples: small feature (dev + design), security patch (backend + infra)

**Tier 3 — Complex / Multi-Domain** (~30 min)
- 4-7 roles, one coordinator (VP Product or VP Engineering) owns execution
- CEO activates coordinator, stays at decision points only
- Examples: new product module, backend migration, new auth layer

**Tier 4 — Full-Scale / Strategic** (30+ min)
- All/most roles, CEO orchestrates directly
- Wave-based execution with quality gates
- Examples: full product launch, platform rebuild, compliance overhaul

### Task Board Enhancement
Add optional `complexity` field to the task model so the CEO can tag tasks with their assessed tier. This supports tracking and analytics.

---

## Implementation Steps

### Step 1: Auto-select sandbox profile based on intent
**File**: `src/web/api.py` (line ~4147)

### Step 2: Add complexity field to task board
**File**: `src/state/task_board.py`
**File**: `src/mcp_server/task_board_tools.py`

### Step 3: Rewrite CEO template with delegation tiers
**File**: `.claude/agent-templates/ceo.md`

### Step 4: Render templates and test

---

## Summary of Changes

| File | Change |
|---|---|
| `src/web/api.py` | Auto-select sandbox profile from intent complexity |
| `src/state/task_board.py` | Add `complexity` field to task model |
| `src/mcp_server/task_board_tools.py` | Expose `complexity` in MCP create_task tool |
| `.claude/agent-templates/ceo.md` | Full rewrite with complexity tiers + delegation patterns |
