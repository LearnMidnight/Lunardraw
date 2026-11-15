#!/usr/bin/env bash
# The Starfall v2 rehearsal on Preprod, as root on the VM, after setup-vm.sh:
#
#   bash rehearsal.sh wallets      makes the v2 keeper's and oracle's wallets (once) and prints
#                                  their addresses, to fund from the Preprod faucet
#   bash rehearsal.sh proof        installs and starts v2's own proof server (127.0.0.1:6302)
#   bash rehearsal.sh balances     both wallets' tNIGHT and DUST (each syncs first: the first time
#                                  takes up to an hour)
#   nohup bash rehearsal.sh deploy > /root/starfall-v2-rehearsal.log 2>&1 < /dev/null &
#                                  deploys the real v2 contracts with test keys (saved in
#                                  /root/lunardraw-secrets/v2-rehearsal), 100 tNIGHT into the
#                                  Treasury from the keeper wallet, the oracle key accepted
#   bash rehearsal.sh start        installs and starts the v2 keeper and oracle (draws every 3 hours)
#   bash rehearsal.sh status       the deployment's draws
#
# The live game and its services are not touched. Prints no secrets.
set -euo pipefail
V2=/root/Lunardraw-v2
KEYS=/root/lunardraw-secrets/v2-rehearsal
KW=/root/nightcast-secrets/v2-keeper-wallet.secret
OW=/root/nightcast-secrets/v2-oracle-wallet.secret
export PATH="/root/.local/bin:$PATH"
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run this as root on the VM"
[ -f "$V2/cli/dist/starfall-v2.js" ] || die "run setup-vm.sh first"
cd "$V2"

case "${1:-}" in
  wallets)
    for w in "$KW" "$OW"; do
      [ -f "$w" ] || ./nightcast/nightcast wallet new --out "$w" > /dev/null
    done
    say "The v2 keeper's wallet"
    ./lunardraw wallet address --network preprod --wallet "$KW"
    say "The v2 oracle's wallet"
    ./lunardraw wallet address --network preprod --wallet "$OW"
    echo
    echo "Fund both NIGHT addresses (mn_addr_preprod1...) from the Preprod faucet."
    ;;
  balances)
    for w in "$KW" "$OW"; do
      say "$(basename "$w")"
      timeout 5400 ./nightcast/nightcast wallet show --network preprod --wallet "$w" --proof-server-port 6302 2>&1 | grep -E "^(NIGHT|DUST|Coins)" || echo "(not synced yet, or no funds: try again later)"
    done
    ;;
  proof)
    cp "$V2/deploy/systemd/lunardraw-proof-v2.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now lunardraw-proof-v2
    for i in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:6302/version 2>/dev/null && break; sleep 5; done
    curl -fsS http://127.0.0.1:6302/version > /dev/null && echo "the v2 proof server is up on 127.0.0.1:6302" || die "the v2 proof server didn't come up: journalctl -u lunardraw-proof-v2"
    ;;
  deploy)
    [ -f "$KW" ] || die "no keeper wallet: run rehearsal.sh wallets first"
    curl -fsS -o /dev/null http://127.0.0.1:6302/version || die "the v2 proof server isn't up: run rehearsal.sh proof first"
    export NIGHTCAST_BLOCKFROST_USAGE=/root/lunardraw-status/usage/starfall-v2-deploy.json
    node starfall-v2/deploy/deploy.mjs rehearsal --wallet "$KW" --keys "$KEYS" --proof-server-port 6302 \
      --record /root/starfall-v2-rehearsal.json
    ;;
  start)
    [ -f "$V2/deployments/starfall-v2-preprod.json" ] || die "no v2 deployment yet: run rehearsal.sh deploy first"
    for s in keeper oracle; do
      cp "$V2/deploy/systemd/lunardraw-starfall-v2-$s.service" /etc/systemd/system/
    done
    systemctl daemon-reload
    systemctl enable --now lunardraw-starfall-v2-oracle lunardraw-starfall-v2-keeper
    sleep 5
    systemctl --no-pager --lines=0 status lunardraw-starfall-v2-keeper lunardraw-starfall-v2-oracle | grep -E "●|Active"
    echo "Logs: journalctl -u lunardraw-starfall-v2-keeper -f   (and -oracle)"
    ;;
  status)
    ./lunardraw starfall-v2 status --network preprod
    ;;
  *)
    die "usage: rehearsal.sh wallets | proof | balances | deploy | start | status"
    ;;
esac
