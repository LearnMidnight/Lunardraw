# Ledger 9 probes for Starfall v2

Two tests on Preprod that decide the rest of v2 (PR #115):

- **treasury**: does a cross-contract call with tNIGHT moving both ways in one transaction
  work on the real chain? It deploys Starfall v2's real `treasury.compact` and a stand-in game,
  binds them, funds them, and has the game settle with the Treasury twice. The second time it
  asks for more than the Treasury holds, so the Treasury must pay whole tNIGHT. Balances are
  checked against what they should be.
- **circuits**: how many circuits can one ledger 9 deploy carry? Contracts with 12, 15, 18, 21
  and 24 circuits are deployed until one is refused. Each circuit has a 2,121-byte verifier key,
  more than Starfall v2's average of 1,877. Starfall v2 has 12 circuits; syndicates would make
  it about 18.

Only throwaway contracts are deployed. The live game, keeper, oracle and website are untouched.
The probe borrows an idle house agent's wallet (one whose daily window is at least 3 hours away)
and uses the player proof server. The treasury test leaves 70 test tNIGHT in its throwaway
contracts.

## Run it (from WSL on the PC)

```bash
scp "/mnt/c/Users/jackr/Local Sites/midnight-lotto/ledger9-probe/ledger9-probe.tar.gz" root@207.180.249.120:/root/
ssh root@207.180.249.120
mkdir -p /root/ledger9-probe && tar -xzf /root/ledger9-probe.tar.gz -C /root/ledger9-probe
nohup bash /root/ledger9-probe/probe.sh > /root/ledger9-probe/probe.log 2>&1 &
tail -f /root/ledger9-probe/probe.log
```

It takes about 30–60 minutes: opening the wallet, then a proof for each call. At the end it
prints two verdict lines. Send those (or the `results-*.json` files) to Claude.

## What's in here

- `probe.sh`: the VM runner. It checks the checkout, picks the wallet, and runs both probes.
- `probe.mjs`: the probes. `node probe.mjs offline` checks everything that doesn't need the
  network. It passed where it was built: both deploys, the bind, and the cross-contract settle
  through midnight-js's real call builder, with the right token movements.
- `contracts/`: the sources. `treasury.compact` is v2's, unchanged; `probe-game.compact` is the
  stand-in game; `gen-wide.py` writes the N-circuit contracts.
- `out/`: the same contracts compiled with Compact 0.36.0, with their keys. The N-circuit
  contracts have no prover keys, because a deploy doesn't need them.

## In the repository

This folder holds the sources only. The archive Jack runs (`ledger9-probe.tar.gz`) also carries
`out/`: `treasury.compact` (the same file as `../src/treasury.compact`), `probe-game.compact` and
the N-circuit contracts (`python3 contracts/gen-wide.py 12 15 18 21 24`, written to
`contracts/wide/`) compiled with `compactc` 0.36.0; `probe.mjs` reads them from `out/<name>/`.
