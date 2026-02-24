#!/bin/bash
# Hook: SubagentStart — logs agent activity for dashboards.
# Receives JSON input via stdin with session_id, cwd, agent_type, etc.

INPUT=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Try agent_name first, fall back to agent_type
AGENT_NAME=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('agent_name') or data.get('agent_type') or 'unknown')
" 2>/dev/null || echo "unknown")

AGENT_TYPE=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('agent_type') or data.get('agent_name') or 'unknown')
" 2>/dev/null || echo "unknown")

SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")

# Resolve LOG_DIR: use COMPAAS_DATA_DIR env var, or find company_data relative to this script
if [ -n "${COMPAAS_DATA_DIR:-}" ]; then
    LOG_DIR="$COMPAAS_DATA_DIR"
else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    SEARCH_DIR="$SCRIPT_DIR"
    while [ "$SEARCH_DIR" != "/" ]; do
        if [ -d "$SEARCH_DIR/company_data" ]; then
            LOG_DIR="$SEARCH_DIR/company_data"
            break
        fi
        SEARCH_DIR="$(dirname "$SEARCH_DIR")"
    done
    LOG_DIR="${LOG_DIR:-./company_data}"
fi
mkdir -p "$LOG_DIR"

# Write structured JSON event to activity.log (compatible with /api/activity/recent)
echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
agent = data.get('agent_type') or data.get('agent_name') or 'unknown'
event = {
    'timestamp': '$TIMESTAMP',
    'agent': agent.lower().replace(' ', '-'),
    'action': 'STARTED',
    'detail': f'{agent} began working',
    'project_id': '',
    'metadata': {
        'source': 'hook',
        'agent_type': agent,
        'session_id': data.get('session_id', ''),
    },
}
print(json.dumps(event))
" 2>/dev/null >> "$LOG_DIR/activity.log"

# Append raw event to hook_events.jsonl for structured querying
echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
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
