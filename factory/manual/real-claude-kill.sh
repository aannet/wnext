#!/bin/bash
# TEST MANUEL (non lancé par `npm test`) : vraie session `claude -p` (haiku, plafond 0,03 USD) avec le hook kill et KILL présent.
# Attendu : Write refusé, aucun fichier créé, événement kill.triggered dans le JSONL, permission_denials non vide.
set -u
F=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
export FACTORY_KILL_FILE=$W/KILL OBS_EVENTS_FILE=$W/events.jsonl OBS_LINE=P0-901 OBS_PHASE=P0 OBS_AGENT=implementeur
mkdir "$W/cwd"; touch "$FACTORY_KILL_FILE"
cat > "$W/settings.json" <<JSON
{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"node $F/hooks/kill-hook.mjs"}]}]}}
JSON
cd "$W/cwd" && timeout 60 claude -p "Create a file hello.txt containing exactly the word hi, then reply DONE." \
  --model haiku --tools "Write" --allowedTools "Write" --system-prompt "You are a minimal implementer agent. Be terse." \
  --settings "$W/settings.json" --no-session-persistence --max-budget-usd 0.03 --output-format json </dev/null > "$W/out.json"
echo "rc=$?"
jq -c '{cost:.total_cost_usd, denials:(.permission_denials|length), result}' "$W/out.json"
echo "hello.txt: $([ -e hello.txt ] && echo CREE-ECHEC || echo absent-OK)"
echo "evenements:"; cat "$W/events.jsonl"
