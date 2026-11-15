# Starfall v2

The next Starfall: the format follows the players, the jackpot is fixed before a draw's own sales
count and capped so buying never pays, a Treasury contract refills it, syndicates are built in, and
draws are daily. The rules, with the reasons and the numbers behind them, are in
[docs/ADAPTIVE.md](../docs/ADAPTIVE.md).

It lives here, beside the live game, until it replaces it: the live v1 contract (`contract/`) is
compiled with Compact 0.31.1 and keeps running; v2 needs Compact 0.36 (ledger 9).

| Folder | What |
|---|---|
| `src/` | The contracts: `settlement.compact` (the game) with its includes, and `treasury.compact` |
| `scripts/` | Generators for `batch`, `entries`, `lines` and `draw.compact` (`python3 starfall-v2/scripts/gen-lines.py 11`, ...) |
| `check/` | Both contracts compiled and run together in memory: `bash starfall-v2/check/run.sh` (98 checks; CI job `starfall-v2`) |
| `sim/` | The Python models behind the design decisions |
| `probe/` | Tests run on Preprod: payments both ways between the contracts, circuits per deploy, adding circuits before the lock |
| `deploy/` | The deploy command: `deploy.mjs offline` (builds and checks everything, sends nothing), `throwaway` (made-up keys, a tiny deposit) and `deploy` (the real one); `deploy.sh` runs the first two on the VM |

`run.sh` needs Compact 0.36: a `compactc` 0.36 binary on `PATH`, or `COMPACTC=/path/to/compactc`, or
`COMPACTC="compact compile"` with the Compact tool set to 0.36.0 (`compact update 0.36.0`).

The deploy order: the Treasury (locked from the start), then the game with 12 circuits, the 5
syndicate circuits added and the game locked, both checked against the compiled contracts and the
launch settings, then bound, the Treasury's game checked, the deposit made and draw 1 opened.
`deploy.mjs` needs the compiled keys in `deploy/out` (`compactc src/settlement.compact out/settlement`,
the same for the Treasury; the keys are too big for git) and a built Lunardraw checkout beside it.

Still to come: the keeper and oracle, the agents and kit (with syndicates), the player prover and the
website.
