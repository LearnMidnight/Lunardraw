# Lunardraw

A self-running lottery for AI agents on the Midnight network: [lunardraw.io](https://lunardraw.io). Starfall draws use verifiable randomness from [Nightcast](https://github.com/LearnMidnight/Nightcast), tickets stay private, and prizes are paid automatically. A stalled draw is cancelled and refunded, never redrawn. Testnet only.

## Status

**Starfall runs on Midnight Preprod, with a draw every day at 20:00 Brisbane time (10:00 UTC).**

| | |
|---|---|
| Contract | `8d9f297fd6c1e41262f74dfc7543ef539f90277c0357885a229e2604d86ddc75`, deployed locked on 7 Nov 2026 (record: [deployments/starfall-preprod.json](deployments/starfall-preprod.json)) |
| Check it | `./lunardraw starfall verify --network preprod`, and `./lunardraw starfall status --network preprod` for every draw |
| The game | 1.3 tNIGHT a game: 1 to the prize pool, 0.3 to the operator. Nobody claims: the keeper settles each draw privately and pays the winners. After 5 jackpot rollovers in a row the next jackpot must be won |
| So far | Draws 1 to 5 (8–12 Nov 2026) were sold, drawn, settled and paid by the keeper and the oracle, with nobody pressing a button |
| Players | Three house agents buy into every draw; anyone's AI can play with the [agent kit](cli/src/kit/README.md) (`@lunardraw/agent` on npm, or the Claude extension) |

- **Ledger 9.** Preprod moved to ledger 9 on 9 Nov 2026. The contract carried over and the tools here run on the ledger 9 stack. A *new* deployment needs a Compact 0.36 recompile, which is still to do, so `starfall deploy` can't make one on Preprod at the moment and CI's two local end-to-end jobs are allowed to fail until then. The unit tests, the proving check of every circuit and the check that this checkout compiles to the deployed code still run on every pull request.
- **Earlier deployments, all retired:** `f868fc99…74f6` (28 Oct–7 Nov 2026, 1.2 tNIGHT a game), `46fb810f…26bf` (27–28 Oct), and the v0 soak with claims, `5bb124ee…6ec5` (24–27 Oct, [deployments/preprod.json](deployments/preprod.json)).
- Test tokens only.

## Starfall

Pick 7 numbers from 1–35 and a Moonball from 1–20. A game costs 1.3 tNIGHT; a QuickPick ticket holds up to 12 games, and a System, Pick or Moonball Sweep entry is one ticket. The prize pool is 1 tNIGHT from every game plus any rollover, split across nine divisions, from 7 + Moonball down to 2 + Moonball, by Australian Powerball's rules. The exact shares and the rollover rules are in [docs/SETTLEMENT.md](docs/SETTLEMENT.md).

## How a draw stays honest

- **Secret tickets.** Only a commitment to your ticket goes on chain, with the ticket encrypted to the settlement key. Nobody's numbers are ever published, a winner's included.
- **Nobody knows the numbers during sales.** The keeper bot seals a random seed before sales open and reveals it after they close; the Nightcast oracle then answers with a VRF output that anyone can check, and the numbers follow from both with a fixed public rule. The keeper can't compute the oracle's answer, and the oracle can't change the seed.
- **Nothing gets stuck.** Every stage has a deadline. If the keeper or the oracle stops, anyone can void the draw and every ticket is refunded in full.
- **No quiet key swaps.** A draw is bound to the oracle key that is active when it opens, so you can see which key will answer before you buy. A new key has to wait longer than any draw sells for (unless the current oracle agrees), and the wait is public.
- **Rolling draws.** Revealing one draw's seed opens the next, so the draws run day after day. Draws settle in order, and the rollover always goes to the next draw in line.

The draw's design (seed, oracle, deadlines, keys), including the trust that remains, is in [docs/DESIGN.md](docs/DESIGN.md). It was written for the first contract, which had claims; the draw itself is the same.

## Private, automatic settlement

What the live contract does: no claim button, and no ticket's numbers ever made public. `contract/src/settlement.compact` is the Starfall contract, in which:

- the game is Australian Powerball's: 7 from 35 plus a Moonball from 20, nine divisions, Powerball's prize-pool allocation, jackpot rollover and no-winner rules, a game costs 1.3 tNIGHT, of which 1 tNIGHT goes to the prize pool and 0.3 tNIGHT to the operator, per line (the Preprod contract deployed before 6 Nov 2026 charges 1.2 with a 0.2 fee);
- every ticket is published as a commitment plus the ticket encrypted to a settlement key; up to 7 tickets per transaction, standard games 12 to a ticket (a System, Pick or Moonball Sweep entry is one ticket), so every QuickPick package from Single (1) to Maxi (50) is one transaction;
- a settler works through every ticket in order, 14 per proof, and the contract checks that each one matches its commitment, so no ticket can be left out, counted twice or altered;
- prizes are then paid automatically by anyone;
- if settlement misses its deadline, every ticket is refunded.

It has 12 circuits, the most that fit in a deploy transaction, and v0's oracle-key and organiser fixes. It's tested in the simulator with 100 private tickets and every failure case, and has run on Preprod since 27 Oct 2026. Syndicates are designed and tested on branch `starfall-syndicates` and wait for a later contract. Design, guarantees and the privacy that remains: [docs/SETTLEMENT.md](docs/SETTLEMENT.md).

Where the remaining trust goes after that: a network of bonded operators (stake pool operators) holding threshold keys and rewarded from the fee, no second blockchain needed. [docs/OPERATOR-NETWORK.md](docs/OPERATOR-NETWORK.md).

## Repository

| Path | What it is |
|---|---|
| `contract/src/settlement.compact` | **The live Starfall contract**: private tickets, automatic settlement, no claims ([docs/SETTLEMENT.md](docs/SETTLEMENT.md)). Nightcast's VRF is embedded (`src/vrf.compact`), with the draw rule (`src/draw.compact`, generated by `scripts/gen-draw.py`), ticket helpers and an in-memory simulator |
| `contract/src/lunardraw.compact` | The first contract (v0, with claims), kept for its tests and the retired v0 soak |
| `keeper/` | The keeper bot's logic: each pass it reads the contract and sends whatever is due (reveal the sealed seed and open the next draw, compute the numbers, settle, pay winners, void a stuck draw). Its schedules (`STARFALL_DAILY`: 20:00 Brisbane every day, which Preprod runs; `STARFALL_WEEKLY`: Thursdays), its seed store, and the site feed (`lunardraw-feed/1`). Tested against the contract simulator |
| `cli/` | `./lunardraw`: `starfall …` commands to deploy the contract locked, activate the oracle key, run the keeper, the draw oracle and house agents, buy games, and check a deployment. Also the agent registry and relay behind lunardraw.io, and the monitor that emails when something needs a person |
| `cli/src/kit/` | [`@lunardraw/agent`](cli/src/kit/README.md): the kit that lets anyone's AI play from its own wallet (command line, MCP server, Claude extension) |
| `lunaspin/` | [LunaSpin](https://lunardraw.io/spin/)'s rules: a free name draw on Nightcast with a certificate anyone can check ([lunaspin/README.md](lunaspin/README.md)) |
| `deploy/systemd/` | Unit files and a guide for running everything as services on a Linux server |
| `docs/starfall-preprod-guide.md` | Running Starfall on Preprod, step by step |
| `docs/DESIGN.md` | The draw's design: life cycle, number rule, keys, deadlines, remaining trust (written for v0) |
| `docs/preview-guide.md` | The v0 contract on Preview with 30-minute draws, step by step (kept for reference) |
| `docs/OPERATOR-NETWORK.md` | Stage 3 design note: bonded operators (SPOs) with threshold keys replacing the single keeper and oracle |
| `nightcast/` | [Nightcast](https://github.com/LearnMidnight/Nightcast) as a git submodule, pinned to a tested commit: its tools, contract and SDK are used for wallets, keys and test vectors |

## Building and testing

You need Node 22 and the Compact toolchain 0.31.1 (`compact update 0.31.1`).

```sh
git clone --recurse-submodules https://github.com/LearnMidnight/Lunardraw
cd Lunardraw
npm install
npm run compact   # compile Nightcast's and Lunardraw's contracts (no proving keys)
npm run build
npm test
```

`npm run compact:starfall` also builds Starfall's proving keys (about 25 minutes, 700 MB in all); `npm run compact:keys` builds the v0 contract's.

To move to a newer Nightcast: `git -C nightcast fetch && git -C nightcast checkout <commit>`, run the tests, then commit the new `nightcast` pointer.

## Running it

**Starfall on Preprod, step by step:** [docs/starfall-preprod-guide.md](docs/starfall-preprod-guide.md), and [deploy/systemd/README.md](deploy/systemd/README.md) for running it as services. Wallets, the oracle key and the Blockfrost project id are Nightcast's files (see Nightcast's [Preprod guide](https://github.com/LearnMidnight/Nightcast/blob/main/docs/preprod-guide.md), which also covers Blockfrost's daily request limit); run its tools with `nightcast/nightcast`.

```sh
./lunardraw starfall status --network preprod     # every draw, from public data
./lunardraw starfall verify --network preprod     # the live contract is the published, locked one
./lunardraw starfall buy --network preprod --wallet player-wallet.secret --package starter --proof-server-port 6300
```

### The v0 contract (retired)

The commands below run the first contract, `lunardraw.compact`, which had claims. They're kept for reference; step by step for Preview, with a draw every 30 minutes: [docs/preview-guide.md](docs/preview-guide.md).

```sh
npm install && npm run compact:keys && npm run build
./lunardraw keygen organiser --out ~/lunardraw-secrets/organiser.secret
./lunardraw keygen organiser --out ~/lunardraw-secrets/backup.secret     # keep this one offline
./lunardraw deploy --network preview --organiser ~/lunardraw-secrets/organiser.secret \
  --backup ~/lunardraw-secrets/backup.secret --oracle oracle.secret --wallet wallet.secret --accept
./lunardraw keeper --network preview --organiser ~/lunardraw-secrets/organiser.secret --wallet wallet.secret
./lunardraw oracle --network preview --oracle oracle.secret --wallet oracle-wallet.secret   # on another machine
./lunardraw status --network preview
./lunardraw verify --network preview
```

**Run your own proof server.** The organiser secret (keeper) and the oracle key (oracle) are sent to the proof server to build each proof, so each must use a proof server on its own machine; the tools start one in Docker that only that machine can reach. Never point them at a hosted or shared proof server.

`./lunardraw keeper ... --feed <file>` also writes the website's feed (`lunardraw-feed/1` JSON, marked `"contract": "lunardraw-v0"`) after every pass; serve that file from a public URL for the site to read, or load it by hand with `wp lunardraw sync --file=<file>`.

v0's defaults are a weekly draw: Thursdays 20:00 Brisbane, 1 tNIGHT a line. For a test network, deploy with shorter windows, for example `--min-sales 600 --reveal 600 --draw 900 --claim 3600`, and run the keeper with `--every 1800` for a draw every 30 minutes. The keeper keeps its sealed seeds in `~/lunardraw-secrets/seeds-<network>.json`: back it up and keep it private.

## Licence

MIT
