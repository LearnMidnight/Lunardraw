# Starfall on Preprod: a step-by-step guide

This replaces the v0 soak with **Starfall**, the real game (docs/SETTLEMENT.md): games cost 1.2 tNIGHT, nobody claims prizes, and the keeper settles every draw privately and pays the winners itself. It runs on the same server as the v0 soak, with the same wallets and keys, plus one new key.

It assumes the setup from [preview-guide.md](preview-guide.md) and [deploy/systemd/README.md](../deploy/systemd/README.md): the repo in `/root/Lunardraw`, secrets in `/root/lunardraw-secrets` and `/root/nightcast-secrets`, the three v0 services running.

**Memory:** the numbers proof needs about 7 GB on the proof server; everything else (settlement batches, purchases) about 1 GB. The server needs about 8 GB free; check with `free -h` (the `available` column). The keeper proves one at a time and the proof server restarts itself between them to free memory.

**Run every command in `~/Lunardraw` unless it says otherwise.**

---

## Part 1: Stop the v0 soak

The Starfall keeper and oracle use the v0 ones' wallets, so the v0 ones must stop first (the proof server stays):

```bash
systemctl disable --now lunardraw-keeper lunardraw-oracle
```

The v0 contract stays on chain; nothing more happens to it.

## Part 2: Update and build

```bash
cd ~/Lunardraw
git pull
git submodule update --init
npm install
npm run compact:starfall
npm run build
```

`npm run compact:starfall` builds Starfall's proving keys: about **25 minutes**. The biggest key (buying games) is about 320 MB, and all twelve together about 700 MB.

## Part 3: The settlement key

```bash
./lunardraw starfall keygen settlement --out ~/lunardraw-secrets/settlement.secret
```

This is the key every ticket is encrypted to. The keeper uses it to decrypt the tickets once the numbers are drawn, so it can work out the winners. **Keep it as private as the organiser secret**: whoever has it can read every ticket. Back it up the same way. Never paste it anywhere.

## Part 4: A player wallet

To test, someone has to buy games. The keeper's wallet is busy, so make a separate wallet for buying, and start syncing it now (a new Preprod wallet takes about an hour):

```bash
nightcast/nightcast wallet new --out ~/lunardraw-secrets/player-wallet.secret
nightcast/nightcast wallet show --network preprod --wallet ~/lunardraw-secrets/player-wallet.secret
```

It prints an address starting `mn_addr_preprod1...`. Paste it into the Preprod faucet, <https://midnight-tmnight-preprod.nethermind.dev/>, and request tNIGHT. 100 games cost 120 tNIGHT plus fees; if the faucet gives less, buy fewer.

## Part 5: Deploy

The backup organiser is the same one as v0's. Its secret stays on your PC and USB stick; the deploy only needs its **Starfall** commitment, a public code worked out from the secret. (Starfall's codes differ from v0's on purpose, so the `backupCommitment` in v0's record won't do.) On the PC, in Ubuntu:

```bash
cd ~/Lunardraw
git pull
git submodule update --init
npm install
npm run compact
npm run build
./lunardraw starfall commitment --organiser ~/lunardraw-secrets/backup.secret
```

It prints `Starfall organiser commitment (public): ...` and 64 characters. Copy them (they're public) and use them as `--backup` below, on the server:

```bash
./lunardraw starfall deploy --network preprod \
  --organiser ~/lunardraw-secrets/organiser.secret \
  --backup <the 64 characters from the PC> \
  --oracle ~/lunardraw-secrets/oracle.secret \
  --settlement ~/lunardraw-secrets/settlement.secret \
  --wallet ~/nightcast-secrets/requester-wallet.secret \
  --accept \
  --min-sales 600 --max-sales 7200 --reveal 600 --draw 900 --settle 3600
```

The test timings, in seconds:
- a draw sells for 10 minutes to 2 hours;
- the keeper has 10 minutes to reveal the seed;
- the oracle has 15 minutes to answer;
- settlement must finish within an hour of the numbers.

The price (1.2 tNIGHT) and fee (0.2 tNIGHT) are the defaults. The fee goes to the deploying wallet unless you add `--operator <address>`.

It ends with a checklist that should be all **PASS**, including `the organiser secret can open draws`, and writes `deployments/starfall-preprod.json`. Send me the output (it's all public).

## Part 6: Run it

```bash
cp deploy/systemd/lunardraw-starfall-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lunardraw-starfall-keeper lunardraw-starfall-oracle
journalctl -u lunardraw-starfall-keeper -f
```

Within a minute: `opened draw 1, selling until ...` (the next hour). The site feed carries on at the same address, now in Starfall's format.

## Part 7: Buy games

Once the player wallet has synced and has tNIGHT, buy a package for the draw on sale (Ctrl+C on the `wallet show` first):

```bash
./lunardraw starfall buy --network preprod --wallet ~/lunardraw-secrets/player-wallet.secret \
  --package starter --proof-server-port 6300
```

| Package | Games | Transactions |
|---|---|---|
| single | 1 | 1 |
| starter | 4 | 2 |
| mini | 8 | 4 |
| regular | 12 | 6 |
| mega | 25 | 13 |
| maxi | 50 | 25 |

Or `--games <n>` for any number. Each transaction is a proof of up to 2 games (about a minute and 1 GB of memory). The numbers are printed when it's done: winnings go to the player wallet by themselves.

Start with **starter** to see one purchase work and how long it takes. Then aim for about **100 games in one draw**: four batches of settlement, which is what this test is for. Buy them before the draw's sales close (the keeper log says when).

## What happens each hour

| Who | Log line | About |
|---|---|---|
| keeper | `done: reveal draw N's seed and open the next draw` | right after the hour |
| oracle | `answered draw N` | within a minute |
| keeper | `done: compute draw N's numbers` | a few minutes later |
| keeper | `decrypted draw N's 100 ticket(s)`, then `done: settle draw N's tickets 1-25 of 100` ... `76-100 of 100` | one batch every couple of minutes |
| keeper | `done: finalise draw N` | the fee goes to the operator wallet |
| keeper | `done: pay a winning ticket of draw N` | one per winning game |

A draw that misses a deadline is voided, then `refund ticket i of void draw N` for each game.

**Checking** (any time):

```bash
./lunardraw starfall status --network preprod
./lunardraw starfall verify --network preprod
```

`status` shows each draw's stage, games, settlement progress, winners, and anything still unpaid or unrefunded.

## Troubleshooting

| Problem | Fix |
|---|---|
| `No compiled Starfall contract with proving keys found` | `npm run compact:starfall && npm run build` |
| `no Starfall deployment on preprod yet` | Do Part 5 first. |
| `... is not this deployment's settlement key` | The keeper was given a different settlement file from the deploy's. |
| `no draw is on sale right now` (buy) | Sales close on the hour; wait for the next draw to open. |
| `N game(s) cost ... but the wallet holds ...` | Faucet more tNIGHT, or buy fewer. |
| `this wallet is already open in another program` | Another `buy` (or keeper) is using that wallet: two at once fight over the same coins and one gets stuck. Let the other finish, or stop it. Buy from one window at a time. |
| `Stopped after N of M game(s)` | `buy` checks the chain before saying this, so N is what really went in. Run buy again with `--games` for the rest. |
| `The node refused purchase N (Custom error 170 ...)` during buy | The wallet's coins were out of date. buy waits for it to catch up and tries once more by itself. If it stops, run it again: a fresh start resyncs the wallet. |
| Anything else with `Custom error: 170` | Stale wallet sync: the watchdog restarts the service after 3 minutes. |
