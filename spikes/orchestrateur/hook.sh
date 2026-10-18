#!/bin/bash
# PreToolUse: journalise en JSONL et bloque si KILL existe
DIR=/home/alec/projects/002-wnext/spikes/orchestrateur
IN=$(cat)
TS=$(date +%s.%N)
TOOL=$(echo "$IN" | jq -r .tool_name)
if [ -e "$DIR/KILL" ]; then
  echo "{\"ts\":$TS,\"event\":\"tool_denied\",\"tool\":\"$TOOL\"}" >> "$DIR/events.jsonl"
  echo "KILL switch actif" >&2
  exit 2
fi
echo "{\"ts\":$TS,\"event\":\"tool_call\",\"tool\":\"$TOOL\"}" >> "$DIR/events.jsonl"
exit 0
