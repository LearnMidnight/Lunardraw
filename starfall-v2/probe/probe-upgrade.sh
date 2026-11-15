#!/usr/bin/env bash
# Ledger 9 probe for Starfall v2, route B for syndicates: deploy an 18-circuit contract with only
# 12 circuits, add the other 6 afterwards with maintenance transactions, call one of them, then lock
# it. Run on the Lunardraw VM as root:
#
#   nohup bash /root/ledger9-probe/probe-upgrade.sh > /root/ledger9-probe/upgrade.log 2>&1 < /dev/null &
#   tail -f /root/ledger9-probe/upgrade.log
#
# It borrows an idle house agent's wallet exactly as probe.sh does, deploys one throwaway contract
# (the live game, keeper, oracle and website are not touched) and spends only DUST.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO=/root/Lunardraw
DEST="$REPO/probes-ledger9-upgrade"
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root on the VM"
[ -f "$HERE/probe-upgrade.mjs" ] && [ -d "$HERE/out-upgrade/wide-18" ] || die "probe-upgrade.mjs and out-upgrade/ must be next to this script (unpack ledger9-probe-upgrade.tar.gz first)"

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
[ -n "$pick" ] || die "no house agent is stopped with its window at least 3 hours away; try again in an hour or two"
WALLET="/root/lunardraw-agents/$pick.secret"
echo "Using $pick's wallet ($WALLET); its saved sync makes the wallet open in minutes."

say "3. Copying the probe into the checkout"
rm -rf "$DEST" && mkdir -p "$DEST/out"
cp "$HERE/probe-upgrade.mjs" "$DEST/"
cp -r "$HERE/out-upgrade/wide-18" "$DEST/out/"
grep -qx 'probes-ledger9-upgrade/' "$REPO/.git/info/exclude" 2>/dev/null || echo 'probes-ledger9-upgrade/' >> "$REPO/.git/info/exclude"
mkdir -p "$HERE/logs"
export NIGHTCAST_BLOCKFROST_USAGE=/root/lunardraw-status/usage/ledger9-probe.json
cd "$DEST"
node probe-upgrade.mjs offline > "$HERE/logs/upgrade-offline.log" 2>&1 || { tail -20 "$HERE/logs/upgrade-offline.log"; die "the offline check failed here; see logs/upgrade-offline.log"; }
echo "offline check: $(tail -1 "$HERE/logs/upgrade-offline.log")"

say "4. Probe: deploy with 12 circuits, add 6, call one, lock (with $pick's wallet; about 20-40 minutes)"
node probe-upgrade.mjs run --wallet "$WALLET" --proof-server-port 6301 2>&1 | tee "$HERE/logs/upgrade.log" || echo "(the probe ended with an error; its results file says how far it got)"
cp -f "$DEST/results-upgrade.json" "$HERE/" 2>/dev/null || true

say "Done"
[ -f "$HERE/results-upgrade.json" ] && echo "results-upgrade.json: $(node -e "console.log(require('$HERE/results-upgrade.json').verdict)")"
echo
echo "Send Claude the line above (or results-upgrade.json). $pick can start at its window as usual."
