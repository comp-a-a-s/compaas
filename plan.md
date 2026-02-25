# Plan: Live "Team Pulse" — Who's Working, Always Visible

## Problem
Users can only see which agents are active by navigating to the Overview tab and looking at the org chart. On every other tab (Projects, Chat, Activity, Settings), there's zero visibility into who's working. The current `isAgentRecentlyActive()` uses a 90-second window on SSE events — laggy and imprecise.

## Solution: Persistent "Team Pulse" Strip

A thin, elegant strip integrated into the **Layout header** that shows live agent avatars with activity indicators on **every tab, every screen size**.

```
┌─────────────────────────────────────────────────────────────┐
│  Overview  │  COMPaaS — Company as a Service                │
│            │  [●CEO] [●CTO] [●Lead-BE] [·CISO] [·...]  ... │
│            │                        ↑ Team Pulse strip       │
└────────────┴────────────────────────────────────────────────┘
```

## Architecture (3 layers)

### Layer 1: Global Active-Agents State (App.tsx)

**New state in App.tsx:**
```typescript
interface ActiveAgentInfo {
  agentId: string;
  task: string;        // "Working on: API endpoints"
  since: string;       // ISO timestamp
  flow: 'down' | 'up' | 'working';  // delegation direction
}

const [liveAgents, setLiveAgents] = useState<Map<string, ActiveAgentInfo>>(new Map());
```

**Data sources (already exist, just need to flow up):**

1. **WebSocket events from ChatPanel** — The `action_detail` messages already contain `{ source_agent, target_agent, flow, task }`. Currently these only update ChatPanel's local `actionLog`. Add a callback prop `onAgentActivity(agentId, task, flow)` that bubbles delegation events up to App.

2. **SSE activity stream** — Already parsed in App.tsx. When events have `metadata.source_agent` / `metadata.target_agent` / `metadata.flow`, update `liveAgents`.

3. **Auto-expiry** — A `useEffect` timer that clears agents from `liveAgents` after 30 seconds of no updates (much tighter than the current 90s window).

### Layer 2: TeamPulse Component (new: TeamPulse.tsx)

A small, self-contained component rendered in the Layout header.

**Desktop (>900px):**
- Horizontal row of small agent avatars (20-22px circles)
- Active agents: colored circle + green ring pulse + subtle glow
- Idle agents: not shown (only active ones appear)
- Hover tooltip: agent name + what they're working on
- Smooth enter/exit animations (fade-in/scale-up when agent starts, fade-out when done)
- Max 6 visible, "+N more" overflow pill if more

**Mobile (<=900px):**
- Single green dot badge on the header with count: "3 active"
- Tap to expand a mini-sheet showing who's working

**Visual design:**
- Agent circle: 22px, model-colored background (Opus=accent, Sonnet=blue, etc.), white initial
- Active ring: 2px `var(--tf-success)` border with `pulse-ring` animation
- Task label: shown on hover (desktop) or tap (mobile) via existing Tooltip component
- Flow indicator: tiny arrow icon (down-arrow delegated, up-arrow reporting) shown on hover
- Uses existing CSS variables (`--tf-success`, `--tf-accent`, etc.) so it works across all 4 themes

### Layer 3: Integration Points

**a. ChatPanel to App callback:**
- ChatPanel gets a new prop: `onAgentActivity: (agentId: string, task: string, flow: string) => void`
- In the WebSocket `action_detail` handler (line ~1237), when delegation metadata is detected, call `onAgentActivity`
- In `action_result` handler, call with `flow: 'up'` to show agent completing

**b. SSE handler in App.tsx:**
- Already parses activity events. Add ~5 lines to extract agent activity from events with `metadata.flow` === 'down' or 'up'

**c. Layout.tsx:**
- Pass `liveAgents` and `agents` to the header area
- Render `<TeamPulse agents={agents} liveAgents={liveAgents} />` in the header between the page title and the header controls

**d. Overview.tsx org chart:**
- Continue using existing `isAgentRecentlyActive()` + `activeIds` for the detailed org tree (no changes needed — it already works well for that view)

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `web-dashboard/src/components/TeamPulse.tsx` | **NEW** — the strip component | ~120 lines |
| `web-dashboard/src/components/Layout.tsx` | Import and render TeamPulse in header | ~15 lines |
| `web-dashboard/src/App.tsx` | Add `liveAgents` state, SSE extraction, pass as prop | ~30 lines |
| `web-dashboard/src/components/ChatPanel.tsx` | Add `onAgentActivity` callback prop, call from WS handlers | ~15 lines |
| `web-dashboard/src/index.css` | Add 1-2 animations (fade-scale-in, fade-scale-out) if needed | ~10 lines |

**Total: ~190 lines of new/changed code across 5 files. No backend changes needed.**

## What this does NOT change
- No backend API changes (all data already flows via WebSocket + SSE)
- No changes to the Overview org chart (it keeps working as-is)
- No new dependencies
- No changes to the agent registry or status system

## Cross-Platform Behavior

| Platform | Rendering |
|----------|-----------|
| Desktop wide (>1200px) | Full avatar row with names on hover |
| Desktop narrow (900-1200px) | Avatar row, compressed spacing |
| Tablet (600-900px) | Compact avatar dots in header |
| Mobile (<600px) | Green count badge: "3 working" — tap to see list |

## Implementation Order
1. Create `TeamPulse.tsx` component with props interface
2. Add `liveAgents` state to `App.tsx` + SSE extraction logic
3. Wire `onAgentActivity` callback from `ChatPanel.tsx` to `App.tsx`
4. Render `TeamPulse` in `Layout.tsx` header
5. Add CSS animations if needed
6. Test across themes (midnight, twilight, dawn, sahara)
