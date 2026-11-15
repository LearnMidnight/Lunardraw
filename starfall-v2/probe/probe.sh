#!/usr/bin/env bash
# Ledger 9 probes for Starfall v2, run on the Lunardraw VM as root:
#
#   bash /root/ledger9-probe/probe.sh            both probes (about 30-60 minutes)
#   bash /root/ledger9-probe/probe.sh treasury   only the Treasury payment test
#   bash /root/ledger9-probe/probe.sh circuits   only the circuit-count test
#
# Best run so it survives a dropped SSH connection:
#   nohup bash /root/ledger9-probe/probe.sh > /root/ledger9-probe/probe.log 2>&1 &
#   tail -f /root/ledger9-probe/probe.log
#
# What it does:
#   1. checks /root/Lunardraw is built with the ledger 9 stack (compact-runtime 0.21, compact-js 3);
#   2. picks a house agent that is stopped and not due to start for a while (its daily window
#      is far off) and borrows its wallet; it refuses if that agent is running;
#   3. copies the probe into /root/Lunardraw/probes-ledger9 (kept out of git) and runs it there
#      with the player proof server (6301);
#   4. prints the verdicts and writes results-treasury.json / results-circuits.json.
#
# It deploys only throwaway contracts. The live game, keeper, oracle, their wallets and the
# website are not touched. The Treasury test leaves 70 test tNIGHT in the throwaway contracts.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO=/root/Lunardraw
DEST="$REPO/probes-ledger9"
WHICH="${1:-both}"
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root on the VM"
[ -f "$HERE/probe.mjs" ] && [ -d "$HERE/out/treasury" ] || die "probe.mjs and out/ must be next to this script (unpack ledger9-probe.tar.gz first)"
case "$WHICH" in both|treasury|circuits) ;; *) die "usage: probe.sh [both|treasury|circuits]";; esac

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
rm -rf "$DEST" && mkdir -p "$DEST"
cp -r "$HERE/probe.mjs" "$HERE/out" "$DEST/"
grep -qx 'probes-ledger9/' "$REPO/.git/info/exclude" 2>/dev/null || echo 'probes-ledger9/' >> "$REPO/.git/info/exclude"
mkdir -p "$HERE/logs"
export NIGHTCAST_BLOCKFROST_USAGE=/root/lunardraw-status/usage/ledger9-probe.json
cd "$DEST"
node probe.mjs offline > "$HERE/logs/offline.log" 2>&1 || { tail -20 "$HERE/logs/offline.log"; die "the offline check failed here (it passed where it was built); see logs/offline.log"; }
echo "offline check: $(tail -1 "$HERE/logs/offline.log")"

run() {
  say "4. Probe: $1 (with $pick's wallet; the log is in $HERE/logs/$1.log)"
  if ! node probe.mjs "$1" --wallet "$WALLET" --proof-server-port 6301 2>&1 | tee "$HERE/logs/$1.log"; then echo "($1 ended with an error; its results file still says how far it got)"; fi
  cp -f "$DEST/results-$1.json" "$HERE/" 2>/dev/null || true
}
[ "$WHICH" = circuits ] || run treasury
[ "$WHICH" = treasury ] || run circuits

say "Done"
for f in "$HERE"/results-*.json; do [ -f "$f" ] && echo "$(basename "$f"): $(node -e "console.log(require('$f').verdict)")"; done
echo
echo "Send Claude the two lines above (or the results-*.json files). $pick can start at its window as usual."
