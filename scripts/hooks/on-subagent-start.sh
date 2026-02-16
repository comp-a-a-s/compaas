#!/bin/bash
# Hook: SubagentStart — logs agent activity for the TUI dashboard.
# Receives JSON input via stdin with session_id, cwd, etc.

INPUT=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Try agent_name first, fall back to agent_type
AGENT_NAME=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('agent_name') or data.get('agent_type') or 'unknown')
" 2>/dev/null || echo "unknown")

SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")

LOG_DIR="./company_data"
mkdir -p "$LOG_DIR"

echo "[$TIMESTAMP] STARTED: Agent '$AGENT_NAME' began working" >> "$LOG_DIR/activity.log"

# Append raw event to hook_events.jsonl for structured querying
echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
import datetime
event = {
    'event': 'subagent_start',
    'timestamp': '$TIMESTAMP',
    'agent_name': data.get('agent_name') or data.get('agent_type') or 'unknown',
    'session_id': data.get('session_id', ''),
    'raw': data,
}
print(json.dumps(event))
" 2>/dev/null >> "$LOG_DIR/hook_events.jsonl"

exit 0
