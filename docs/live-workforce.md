# Live Workforce Presence

COMPaaS now exposes a single canonical backend state for "who is working right now" and uses it across Web, TUI, and API.

## State model

Each worker item tracks:

- `agent_id`, `agent_name`
- `state`: `assigned | working | reporting | blocked`
- `project_id`, `run_id`
- `task`
- `source`: `real | synthetic`
- `started_at`, `updated_at`, `elapsed_seconds`

`active` means **`working` only**.

## Evidence semantics

- Real evidence can move through: `assigned -> working -> reporting -> completed`
- Synthetic delegation evidence is planning-only:
  - visible as `assigned`
  - never promoted to `working`
- Completed workers clear immediately.
- Terminal run states (`done`, `failed`, `cancelled`) clear non-blocked presence for that run immediately.

## Canonical endpoints

- `GET /api/workforce/live`
- `GET /api/v1/workforce/live`

Query params:

- `project_id` (optional)
- `include_assigned` (default `true`)
- `include_reporting` (default `true`)

Example:

```json
{
  "status": "ok",
  "as_of": "2026-02-28T10:20:30.000000+00:00",
  "project_id": "abcd1234",
  "counts": {
    "assigned": 1,
    "working": 2,
    "reporting": 1,
    "blocked": 0
  },
  "workers": [
    {
      "agent_id": "lead-frontend",
      "agent_name": "Priya",
      "state": "working",
      "project_id": "abcd1234",
      "run_id": "run123",
      "task": "Implement form validation",
      "source": "real",
      "started_at": "2026-02-28T10:19:50.000000+00:00",
      "updated_at": "2026-02-28T10:20:30.000000+00:00",
      "elapsed_seconds": 40
    }
  ]
}
```

## UI mapping

- `working`: green pulse/glow
- `assigned`: amber ring
- `reporting`: blue indicator
- `blocked`: red indicator

Overview badge uses `counts.working` only.

## Troubleshooting mismatches

1. Check API snapshot first:
   - `GET /api/workforce/live?project_id=<id>`
2. Confirm workers include expected `run_id` and `state`.
3. If a run ended, verify the worker entries were cleared immediately.
4. If activity looks synthetic, expect `assigned` visibility only (not `working`).
