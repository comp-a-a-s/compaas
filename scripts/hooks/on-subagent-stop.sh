#!/bin/bash
# Hook: SubagentStop — logs agent completion for the TUI dashboard.
# Receives JSON input via stdin.

INPUT=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
AGENT_TYPE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('agent_type','unknown'))" 2>/dev/null || echo "unknown")

LOG_DIR="./company_data"
mkdir -p "$LOG_DIR"

echo "[$TIMESTAMP] COMPLETED: Agent '$AGENT_TYPE' finished work" >> "$LOG_DIR/activity.log"

exit 0
