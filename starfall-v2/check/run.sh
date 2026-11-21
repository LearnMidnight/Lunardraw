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
# The deployed game the agent kit carries (cli/game-v2/preprod) must be this source's build: the same
# generated code (the kit reads the ledger and builds tickets with it). The source positions in its
# error messages may differ (the deployed build is from 19 Nov, before comment changes here), nothing else.
K=../../cli/game-v2/preprod
# (and a build with keys lists their hashes in expectedVk, which --skip-zk leaves empty: the kit's are
# checked against record.json and the chain in cli/src/test/kit-v2.test.ts)
code() { sed -E -e 's/\.compact line [0-9]+ char [0-9]+/.compact line ? char ?/g' -e '/^export const expectedVk = \{\};$/d' -e '/^export const expectedVk = \{$/,/^\};$/d' "$1"; }
for part in "out settlement" "out-treasury treasury"; do
  set -- $part
  if ! cmp -s <(code "$1/contract/index.js") <(code "$K/$2/contract/index.js"); then
    diff <(code "$1/contract/index.js") <(code "$K/$2/contract/index.js") | head -40 >&2 || true
    echo "cli/game-v2/preprod/$2 is not this source's build: put the deployed build there (or this source has changed since it was deployed)" >&2
    exit 1
  fi
  cmp -s "$1/contract/index.js" "$K/$2/contract/index.js" || echo "::notice title=game-v2::cli/game-v2/preprod/$2 is this source's build (only its keys' hashes and the source positions in its error messages differ)"
done
for v in out-treasury/keys/*.verifier; do
  cmp -s "$v" "$K/treasury/keys/$(basename "$v")" || echo "::warning title=game-v2::$(basename "$v") differs from the Treasury verifier key the kit carries (the chain's own is what counts)"
done
echo "cli/game-v2/preprod is this source's build"
[ -d node_modules ] || npm install --no-audit --no-fund
node pure.mjs
node game.mjs
node syndicate.mjs
node daily.mjs
# The keeper and the oracle on v2 (needs the keeper and the CLI built: npm run build at the top).
if [ -f ../../cli/dist/starfall-v2.js ] && [ -f ../../keeper/dist/index.js ]; then node keeper.mjs && node player.mjs && node agent.mjs
else echo "keeper.mjs, player.mjs and agent.mjs skipped: build the keeper and the CLI first (npm ci && npm run compact && npm run build)"; fi
