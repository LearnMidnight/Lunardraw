#!/usr/bin/env bash
# The Starfall v2 rehearsal on Preprod, as root on the VM, after setup-vm.sh:
#
#   bash rehearsal.sh wallets      makes the v2 keeper's and oracle's wallets (once) and prints
#                                  their addresses, to fund from the Preprod faucet
#   bash rehearsal.sh proof        installs and starts v2's own proof server (127.0.0.1:6302)
#   bash rehearsal.sh sync [--fresh]  syncs both wallets in the background, logging to
#                                  /root/v2-keeper-wallet.log and /root/v2-oracle-wallet.log (--fresh:
#                                  forget a saved sync first)
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
  sync)
    # Sync both wallets in the background (each prints its balances when synced), forgetting
    # first a saved sync that began before fresh wallets skipped the ledger 8 DUST history.
    # Stop any sync of these two wallets and wait until it has exited: it takes up to 20 s and
    # saves its position on the way out, which must not land after --fresh forgets it.
    for w in "$KW" "$OW"; do pkill -f -- "--wallet $w" 2>/dev/null || true; done
    for i in $(seq 1 40); do
      pgrep -f -- "--wallet ($KW|$OW)" > /dev/null || break
      [ "$i" = 30 ] && { pkill -9 -f -- "--wallet ($KW|$OW)" 2>/dev/null || true; }
      sleep 1
    done
    pgrep -f -- "--wallet ($KW|$OW)" > /dev/null && die "an old sync of these wallets is still running: pgrep -af 'wallet show'"
    if [ "${2:-}" = "--fresh" ]; then
      node --input-type=module -e "
        import { forgetWalletState } from '@nightcast/deploy';
        import { walletSeed } from './cli/dist/common.js';
        for (const w of process.argv.slice(1)) console.log(forgetWalletState('preprod', walletSeed(w)) ? 'forgot the saved sync of ' + w : 'no saved sync for ' + w);
      " "$KW" "$OW"
    fi
    for w in "$KW" "$OW"; do
      log="/root/$(basename "$w" .secret).log"
      nohup ./nightcast/nightcast wallet show --network preprod --wallet "$w" --proof-server-port 6302 > "$log" 2>&1 < /dev/null &
      echo "syncing $(basename "$w"): $log"
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
    die "usage: rehearsal.sh wallets | sync [--fresh] | proof | balances | deploy | start | status"
    ;;
esac
