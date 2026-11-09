#!/bin/sh
# Container start (Dockerfile): example AI drafts unless a model key is set, the demo farm when asked for, then the server.
set -e

# No Meta, Baseten, Fireworks or NVIDIA key: every AI step returns a labelled example draft (SYNTEEL_AI_MOCK=1).
# SYNTEEL_AI_MOCK=0 in .env turns that off; the app then says the AI is not on and manual entry still works.
if [ -z "${META_API_KEY}${BASETEN_API_KEY}${FIREWORKS_API_KEY}${NVIDIA_API_KEY}" ] && [ -z "${SYNTEEL_AI_MOCK}" ]; then
  export SYNTEEL_AI_MOCK=1
  echo "No model API key set: mock AI (example drafts)."
fi

# "Coba demo" copies the demo template farm: build it once, on the first start with SYNTEEL_DEMO_PHONE.
if [ -n "${SYNTEEL_DEMO_PHONE}" ]; then
  node scripts/seed-demo.ts --template --if-missing
fi

exec node server/src/index.ts
