#!/bin/bash
# Variante observable de run.sh : l'« orchestrateur » (ce script) émet ses propres agent.start/stop,
# les hooks (factory/observability/hooks/obs-hook.mjs) émettent ceux de la session et de ses sous-agents.
# Usage : OBS_URL=http://localhost:3100 ./run-obs.sh [LIGNE] ["prompt"]
DIR=/home/alec/projects/002-wnext/spikes/orchestrateur
OBS=/home/alec/projects/002-wnext/factory/observability
export OBS_URL=${OBS_URL:-http://localhost:3100}
export OBS_LINE=${1:-P0-900} OBS_PHASE=P0 OBS_AGENT=implementeur
export OBS_RUN_ID=$(node -e 'const A="0123456789ABCDEFGHJKMNPQRSTVWXYZ";let t=Date.now(),s="";for(let i=0;i<10;i++){s=A[t%32]+s;t=Math.floor(t/32)}for(let i=0;i<16;i++)s+=A[Math.random()*32|0];console.log(s)')
export OBS_PARENT_INSTANCE=orch-$OBS_RUN_ID
PROMPT=${2:-"Use the Agent tool exactly once (subagent_type general-purpose) to read /etc/hostname, then create hello.txt containing exactly the word hi. Reply DONE."}

emit() { # $1 = action
  curl -s -m 2 -X POST "$OBS_URL/api/events" -H 'Content-Type: application/json' -d "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",\"run_id\":\"$OBS_RUN_ID\",\"line\":\"$OBS_LINE\",\"phase\":\"$OBS_PHASE\",\"agent\":\"orchestrateur\",\"model\":\"none\",\"action\":\"$1\",\"tokens_in\":0,\"tokens_out\":0,\"cost\":0,\"duration_ms\":0,\"status\":\"ok\",\"instance_id\":\"$OBS_PARENT_INSTANCE\"}" >/dev/null
}

emit agent.start
cd "$DIR/tmp-wt" && claude -p "$PROMPT" \
 --model haiku --tools "Write,Read,Agent" --allowedTools "Write,Read,Agent" \
 --system-prompt "You are a minimal implementer agent. Be terse." \
 --settings "$DIR/settings-obs.json" --max-budget-usd 0.30 --output-format json </dev/null | jq -c '{result,total_cost_usd,session_id}'
emit agent.stop
