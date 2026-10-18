#!/bin/bash
cd /home/alec/projects/002-wnext/spikes/orchestrateur/tmp-wt
claude -p "Create a file hello.txt containing exactly the word hi, then reply DONE." \
 --model haiku --tools "Write,Read" --allowedTools "Write,Read" \
 --system-prompt "You are a minimal implementer agent. Only use Write. Be terse." \
 --settings /home/alec/projects/002-wnext/spikes/orchestrateur/settings.json \
 --no-session-persistence --max-budget-usd 0.20 --output-format json "$@"
