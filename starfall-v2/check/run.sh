#!/usr/bin/env bash
# Compile Starfall v2 and its Treasury with Compact 0.36 and run them together in memory.
#   bash starfall-v2/check/run.sh
# The compiler: COMPACTC (a compactc 0.36 binary, or "compact compile" for the Compact tool with
# 0.36 selected); compactc on PATH otherwise.
# The Treasury is compiled with its keys: the game's cross-contract call checks the Treasury's
# verifier keys, as the chain does. Starfall itself only needs --skip-zk here.
set -euo pipefail
cd "$(dirname "$0")"
read -r -a C <<< "${COMPACTC:-compactc}"
"${C[@]}" --version | grep -q '0\.36\.' || { echo "needs Compact 0.36.x (got $("${C[@]}" --version))" >&2; exit 1; }
rm -rf out out-treasury
"${C[@]}" --skip-zk ../src/settlement.compact out
"${C[@]}" ../src/treasury.compact out-treasury
[ -d node_modules ] || npm install --no-audit --no-fund
node pure.mjs
node game.mjs
node syndicate.mjs
node daily.mjs
# The keeper and the oracle on v2 (needs the keeper and the CLI built: npm run build at the top).
if [ -f ../../cli/dist/starfall-v2.js ] && [ -f ../../keeper/dist/index.js ]; then node keeper.mjs && node player.mjs
else echo "keeper.mjs and player.mjs skipped: build the keeper and the CLI first (npm ci && npm run compact && npm run build)"; fi
