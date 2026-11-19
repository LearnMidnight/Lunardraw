#!/usr/bin/env bash
# Deploy Starfall v2 and its Treasury from the Lunardraw VM, as root (docs/ADAPTIVE.md; deploy.mjs
# says what each step does and checks).
#
#   bash /root/starfall-v2-deploy/deploy.sh offline      builds and checks everything, sends nothing
#   nohup bash /root/starfall-v2-deploy/deploy.sh throwaway > /root/starfall-v2-deploy/throwaway.log 2>&1 < /dev/null &
#       a throwaway deployment with made-up keys and a 2 tNIGHT deposit, borrowing an idle house
#       agent's wallet as the probes do, then its oracle key accepted and draw 1 opened
#
# The real deployment is run by hand with deploy.mjs and the real key files (see its usage).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO=/root/Lunardraw
DEST="$REPO/starfall-v2-deploy"
MODE="${1:-offline}"
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root on the VM"
case "$MODE" in offline|throwaway) ;; *) die "usage: deploy.sh offline|throwaway";; esac
[ -f "$HERE/deploy.mjs" ] && [ -d "$HERE/out/settlement/keys" ] && [ -d "$HERE/out/treasury/keys" ] || die "deploy.mjs and out/ (settlement, treasury) must be next to this script"

say "1. Checking the Lunardraw checkout"
[ -f "$REPO/cli/dist/common.js" ] && [ -f "$REPO/cli/dist/wallet-lock.js" ] || die "$REPO isn't built (cli/dist missing): cd $REPO && npm run build"
(cd "$REPO" && node -e '
const fs = require("fs");
const v = (p) => { try { return JSON.parse(fs.readFileSync("node_modules/" + p + "/package.json", "utf8")).version } catch { return "missing" } };
const want = { "@midnight-ntwrk/compact-runtime": "0.21.0", "@midnight-ntwrk/compact-js": "3.0.0", "@midnight-ntwrk/midnight-js-contracts": "5.0.0" };
let bad = 0;
for (const [p, w] of Object.entries(want)) { const g = v(p); console.log((g === w ? "  ok   " : "  BAD  ") + p + " " + g); if (g !== w) bad++; }
process.exit(bad ? 1 : 0);') || die "the installed packages aren't the ledger 9 stack this probe was built for; tell Claude the versions above"
echo "Lunardraw at $(git -C "$REPO" rev-parse --short HEAD) ($(git -C "$REPO" rev-parse --abbrev-ref HEAD))"

say "2. Borrowing an idle house agent's wallet"
# Daily windows (Brisbane): pixel 06:00-07:00, orbit 12:00-13:00, nova 18:00-19:00.
hour=$((10#$(TZ=Australia/Brisbane date +%H)))
pick=""
for a in pixel orbit nova; do
  case $a in pixel) start=6;; orbit) start=12;; nova) start=18;; esac
  # hours until this agent's window starts, and whether it is in it now
  until=$(( (start - hour + 24) % 24 )); inwin=$(( hour == start ))
  active=$(systemctl is-active "lunardraw-agent@$a" 2>/dev/null || true)
  echo "  $a: $active, window starts in about ${until} h"
  if [ "$active" != "active" ] && [ "$inwin" = 0 ] && [ "$until" -ge 3 ] && [ -f "/root/lunardraw-agents/$a.secret" ] && [ -z "$pick" ]; then pick=$a; fi
done
[ -n "$pick" ] || [ "$MODE" = offline ] || die "no house agent is stopped with its window at least 3 hours away; try again in an hour or two"
WALLET="/root/lunardraw-agents/$pick.secret"
echo "Using $pick's wallet ($WALLET); its saved sync makes the wallet open in minutes."

say "3. Copying the deploy into the checkout"
rm -rf "$DEST" && mkdir -p "$DEST"
cp "$HERE/deploy.mjs" "$DEST/" && cp -r "$HERE/out" "$DEST/"
grep -qx 'starfall-v2-deploy/' "$REPO/.git/info/exclude" 2>/dev/null || echo 'starfall-v2-deploy/' >> "$REPO/.git/info/exclude"
mkdir -p "$HERE/logs"
export NIGHTCAST_BLOCKFROST_USAGE=/root/lunardraw-status/usage/starfall-v2-deploy.json
cd "$DEST"
node deploy.mjs offline 2>&1 | tee "$HERE/logs/offline.log"
[ "${PIPESTATUS[0]}" = 0 ] || die "the offline check failed; see logs/offline.log"
[ "$MODE" = offline ] && exit 0

say "4. Throwaway deployment (with $pick's wallet; about 30-60 minutes)"
node deploy.mjs throwaway --wallet "$WALLET" --proof-server-port 6301 --record "$HERE/deployment-throwaway.json" 2>&1 | tee "$HERE/logs/throwaway.log" || true
say "Done"
node -e "console.log(require('$HERE/deployment-throwaway.json').verdict)" 2>/dev/null || true
echo
echo "Send Claude the line above (or deployment-throwaway.json). $pick can start at its window as usual."
