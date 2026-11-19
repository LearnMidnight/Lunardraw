#!/usr/bin/env bash
# Set up Starfall v2 on the Lunardraw VM, as root, beside the live game: a second checkout of the
# starfall-v2 branch at /root/Lunardraw-v2 (the live checkout at /root/Lunardraw, and the services
# that run from it, are left alone), built, with Compact 0.36 and both v2 contracts compiled with
# their keys (about 10-20 minutes), then every v2 check run.
#
#   bash setup-vm.sh            (again later to update: it pulls, rebuilds, and recompiles the
#                                contracts only if their source changed)
#
# Prints no secrets and touches no wallet.
set -euo pipefail
V2=/root/Lunardraw-v2
BRANCH="${BRANCH:-starfall-v2}"
CCDIR=/root/compactc-0.36
CC="$CCDIR/compactc"
export PATH="/root/.local/bin:$PATH"
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run this as root on the VM"

say "1. Compact 0.36 (for Starfall v2; the live game keeps 0.31)"
if ! "$CC" --version 2>/dev/null | grep -q '^0\.36\.'; then
  mkdir -p "$CCDIR" && cd "$CCDIR"
  curl --proto '=https' --tlsv1.2 -LsSf -o c.zip https://github.com/midnightntwrk/compact/releases/download/compactc-v0.36.0/compactc_v0.36.0_x86_64-unknown-linux-musl.zip
  unzip -qo c.zip && rm c.zip
fi
echo "compactc $("$CC" --version) at $CC"
compact compile --version >/dev/null 2>&1 || die "the Compact tool (0.31, for the live game's package) isn't on PATH"

say "2. The starfall-v2 checkout at $V2"
if [ ! -d "$V2/.git" ]; then
  git clone --branch "$BRANCH" "$(git -C /root/Lunardraw remote get-url origin)" "$V2"
fi
cd "$V2"
git fetch -q origin
git checkout -q "$BRANCH"
git pull -q --ff-only origin "$BRANCH"
git submodule update --init --recursive -q
echo "at $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"

say "3. Install and build (a few minutes)"
npm ci --no-audit --no-fund --loglevel=error
npm run -s compact >/dev/null
npm run -s build >/dev/null
echo "built"

say "4. The v2 contracts with their keys"
OUT="$V2/starfall-v2/deploy/out"
SRC_HASH="$(cat starfall-v2/src/*.compact | sha256sum | cut -c1-16)-$("$CC" --version)"
if [ "$(cat "$OUT/.source" 2>/dev/null)" != "$SRC_HASH" ] || [ ! -f "$OUT/settlement/keys/settleBatch.prover" ] || [ ! -f "$OUT/treasury/keys/release.prover" ]; then
  if [ -f "$V2/deployments/starfall-v2-preprod.json" ] && [ -f "$OUT/.source" ]; then
    die "the contracts' source changed, but a v2 deployment exists that was deployed from the keys in $OUT; tell Claude (the keys must match the deployment)"
  fi
  rm -rf "$OUT" && mkdir -p "$OUT"
  echo "compiling the Treasury..."
  "$CC" starfall-v2/src/treasury.compact "$OUT/treasury" > "$OUT/treasury.log" 2>&1 || { tail -5 "$OUT/treasury.log"; die "the Treasury didn't compile"; }
  echo "compiling the game with its keys (10-20 minutes)..."
  start=$(date +%s)
  "$CC" starfall-v2/src/settlement.compact "$OUT/settlement" > "$OUT/settlement.log" 2>&1 || { tail -5 "$OUT/settlement.log"; die "the game didn't compile"; }
  echo "$SRC_HASH" > "$OUT/.source"
  echo "compiled in $(( $(date +%s) - start )) s"
else
  echo "already compiled from this source"
fi
echo "$(ls "$OUT/settlement/keys" | grep -c verifier) game circuits, $(ls "$OUT/treasury/keys" | grep -c verifier) Treasury circuits; $(du -sh "$OUT" | cut -f1)"

say "5. Checks: the deploy builds and checks offline, and all of Starfall v2's checks"
node starfall-v2/deploy/deploy.mjs offline | tail -2
COMPACTC="$CC" bash starfall-v2/check/run.sh > /root/starfall-v2-checks.log 2>&1 || { grep -E "FAIL|rror" /root/starfall-v2-checks.log | head; die "a check failed (see /root/starfall-v2-checks.log)"; }
echo "$(grep -c '^ok' /root/starfall-v2-checks.log) checks passed"

say "Done"
echo "Starfall v2 is ready at $V2. Send Claude the lines above."
