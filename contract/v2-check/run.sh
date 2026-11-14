#!/usr/bin/env bash
# Compile Starfall v2 and its Treasury with compactc 0.36.0 and run them together in memory.
#   bash contract/v2-check/run.sh            (COMPACTC=/path/to/compactc if it isn't on PATH)
# The Treasury is compiled with its keys: the game's cross-contract call checks the Treasury's
# verifier keys, as the chain does. Starfall itself only needs --skip-zk here.
set -euo pipefail
cd "$(dirname "$0")"
C="${COMPACTC:-compactc}"
"$C" --version | grep -q '^0\.36\.' || { echo "needs compactc 0.36.x (got $("$C" --version))" >&2; exit 1; }
rm -rf out out-treasury
"$C" --skip-zk ../src/settlement.compact out
"$C" ../src/treasury.compact out-treasury
[ -d node_modules ] || npm install --no-audit --no-fund
node pure.mjs
node game.mjs
