# Running Lunardraw on Preview: a step-by-step guide

This runs the Starfall lottery by itself on a Midnight test network, with a draw every 30 minutes instead of every week, so you can watch many draws happen in a day. Nothing here uses real money: test tokens are free from a faucet.

It assumes you've been through Nightcast's [Preprod guide](https://github.com/LearnMidnight/Nightcast/blob/main/docs/preprod-guide.md) Part 1 (Ubuntu in Windows, Docker Desktop, Node 22, the Compact compiler).

> **Preview or Preprod?** The guide is written for **Preview** (no Blockfrost ID needed). As of 24 Oct 2026, though, Preview's public node drops contract deploys ([#24](https://github.com/LearnMidnight/Lunardraw/issues/24)), so the first soak ran on **Preprod** instead: the same commands with `--network preprod`, Nightcast's Blockfrost ID saved as in its guide, and wallets funded from the Preprod faucet (a fresh Preprod wallet takes about an hour to sync; wallets you already use with Nightcast work as they are). Try Preview first; if the deploy ends in `Transaction submission error` twice, switch.

Two programs run on your PC: the **keeper** (opens draws, reveals seeds, computes numbers, settles) and the **oracle** (answers each draw with the VRF). In real use they'd be on separate machines under separate people; on one PC for a test is fine. Each starts its own proof server in Docker, so expect about 2 GB of memory in use while a draw is being proved.

---

## Part 1: Get Lunardraw and build it

```bash
cd ~
git clone --recurse-submodules https://github.com/LearnMidnight/Lunardraw
cd ~/Lunardraw
npm install
npm run compact:keys
npm run build
```

`npm run compact:keys` compiles both contracts and builds Lunardraw's proving keys: **about 10 minutes**, and the `computeNumbers` key is about 145 MB. You only do this once per code version.

If you already have the repo, update it instead:

```bash
cd ~/Lunardraw
git pull
git submodule update --init
npm install
npm run compact:keys
npm run build
```

**Always run the commands below from `~/Lunardraw`.**

---

## Part 2: Secrets and wallets

Keep secrets in a folder outside the code, so they can't be committed by accident:

```bash
mkdir -p ~/lunardraw-secrets
```

### 1. Create the secrets

```bash
./lunardraw keygen organiser --out ~/lunardraw-secrets/organiser.secret
./lunardraw keygen organiser --out ~/lunardraw-secrets/backup.secret
nightcast/nightcast keygen oracle --out ~/lunardraw-secrets/oracle.secret
```

| File | What it is |
|---|---|
| `organiser.secret` | The keeper's secret: it opens draws and reveals the sealed seeds. |
| `backup.secret` | A second organiser secret. If `organiser.secret` is ever lost or leaked, whoever holds this can install a replacement organiser. **Copy it somewhere safe and offline** (a USB stick); it's never needed while things run normally. |
| `oracle.secret` | The oracle's key for Preview. Use a different one from Preprod's. |

### 2. Create two wallets and fund them

One wallet pays the keeper's fees, one the oracle's.

```bash
nightcast/nightcast wallet new --out ~/lunardraw-secrets/keeper-wallet.secret
nightcast/nightcast wallet new --out ~/lunardraw-secrets/oracle-wallet.secret
```

Then, for each wallet, show its address and let it sync:

```bash
nightcast/nightcast wallet show --network preview --wallet ~/lunardraw-secrets/keeper-wallet.secret
```

It prints the address (starting `mn_addr_preview1...`) and starts syncing. While it syncs:

1. Open the Preview faucet: <https://midnight-tmnight-preview.nethermind.dev/>
2. Paste the address, complete the captcha, click **Request tokens**.

A new wallet's first sync on Preview takes **about 10 minutes**. When it finishes it shows the NIGHT arriving, registers it for DUST (what pays fees) and prints both balances. Do the same for the oracle wallet; you can run both in two Ubuntu windows at once. If the faucet says you're rate-limited, wait a few hours.

**Back up `~/lunardraw-secrets`.** Losing the organiser secret means a redeploy (unless you have the backup); losing a wallet means losing its tokens.

---

## Part 3: Deploy

```bash
./lunardraw deploy --network preview \
  --organiser ~/lunardraw-secrets/organiser.secret \
  --backup ~/lunardraw-secrets/backup.secret \
  --oracle ~/lunardraw-secrets/oracle.secret \
  --wallet ~/lunardraw-secrets/keeper-wallet.secret \
  --accept \
  --min-sales 600 --max-sales 7200 --reveal 600 --draw 900 --claim 3600
```

The last line sets the test timings, in seconds: a draw sells for at least 10 minutes and at most 2 hours; after sales close the keeper has 10 minutes to reveal the seed, the oracle 15 minutes to answer, and winners an hour to claim. (The weekly defaults are days.)

It takes a few minutes: it deploys the contract **locked** (nobody can ever change its code), activates the oracle key and writes `deployments/preview.json`. It ends with a checklist that should be all **PASS**:

```
PASS  contract exists: ...
PASS  maintenance authority locked: committee of 0, threshold 1, 0 update(s) since deploy
PASS  verifier keys match the published fingerprints: 12 circuits
PASS  this checkout compiles to the deployed code: identical
PASS  oracle key accepted: active and matches the record
PASS  no oracle key change pending: a change would wait 7800 s
PASS  organiser matches the record: ...
PASS  backup organiser matches the record: ...
PASS  price and windows match: 1 tNIGHT a line; sales 600-7200 s; reveal 600 s, draw 900 s, claim 3600 s
```

If the wallet sits at "Waiting for the first DUST" for more than 15 minutes, its saved state is stale: stop it (Ctrl+C) and rerun the command with `NIGHTCAST_NO_WALLET_STATE=1` in front.

---

## Part 4: Run it

Open **three Ubuntu windows**, all in `~/Lunardraw`.

**Window 1, one proof server for both programs:**

```bash
./lunardraw proof-server
```

The keeper and the oracle each need a proof server, and each would start its own in Docker. On one PC that's two of them fighting for memory (each peaks at about 1 GB), so run one and point both at it. Leave this window alone. It listens on this machine only, keeps the 100 MB of zk parameters it downloads in a Docker volume (so restarts don't fetch them again), and restarts itself when it's idle and using more than 3 GB (`--memory-limit <MiB>` to change).

**Window 2, the keeper:**

```bash
./lunardraw keeper --network preview \
  --organiser ~/lunardraw-secrets/organiser.secret \
  --wallet ~/lunardraw-secrets/keeper-wallet.secret \
  --every 3600 --proof-server-port 6300 \
  --feed ~/lunardraw-feed/feed.json
```

`--every 3600` closes a draw every hour, on the hour. (`--every 1800`, every half hour, works on a fast machine; on an 8 GB PC the numbers proof can take 10 minutes or more and must not still be running when the next draw closes.) The keeper keeps each draw's sealed seed in `~/lunardraw-secrets/seeds-preview.json`, and writes the website's feed to the `--feed` file after every pass.

**Window 3, the oracle:**

```bash
./lunardraw oracle --network preview \
  --oracle ~/lunardraw-secrets/oracle.secret \
  --wallet ~/lunardraw-secrets/oracle-wallet.secret \
  --proof-server-port 6300
```

Within a minute or two the keeper opens draw 1: `opened draw 1, selling until ...`. Then, every hour, you should see this cycle:

| Who | Line in the log | About |
|---|---|---|
| keeper | `done: reveal draw N's seed and open the next draw (70 s)` | right after the hour |
| oracle | `answered draw N (33 s)` | within a minute of that |
| keeper | `started: compute draw N's numbers (in the background)`, then `done: ... (N s)` | minutes later: 2 on CI, 10 or more on an 8 GB PC |
| keeper | `done: settle draw N` | an hour and a bit after that (after the claim window) |

The seconds in brackets are what one 8 GB PC and CI's machine took; yours will differ. The numbers proof runs in the background, so the keeper keeps revealing and opening draws while it works. **The numbers proof must land within about 14 minutes of starting** (the contract checks the keeper's clock stamp against block time, 10 minutes either way, and the keeper stamps it 4 minutes ahead). If it takes longer, the transaction is refused with `1010: Invalid Transaction: Custom error: 104`, the draw eventually voids, and the PC needs more memory or fewer things running: check with `free -h` that swap isn't in heavy use.

**Checking** (any window, any time):

```bash
./lunardraw status --network preview    # every draw and its stage
./lunardraw verify --network preview    # the deployment checks again
```

### What "working" looks like

After a day you'd expect about 24 draws, each **settled** (nobody bought tickets, so there's nothing to pay and the prize pool stays at zero; that's fine for this test). What you're testing is that the machinery never stops: every draw reaches `settled`, and the next one opens on time.

A draw shown as **voided** means a deadline was missed: the keeper didn't reveal in time, the oracle didn't answer in time, or nobody computed the numbers. One or two voids after a PC sleep or a network drop are expected and harmless (a void draw is refunded, never redrawn). Voids while everything was running are worth reporting.

### On a server: run them as services

On a Linux server (rather than a PC you watch), install the three programs as systemd services instead of terminal windows: they start at boot, restart if they stop, and restart themselves if their transactions keep failing for 10 minutes (a stale wallet sync does that: node error `1010 ... Custom error: 170`). See [deploy/systemd/README.md](../deploy/systemd/README.md).

### Stopping and restarting

Ctrl+C once in each window stops it cleanly (a second Ctrl+C forces it). Start the same commands again to carry on (proof server first): the keeper reads everything it needs from the chain and its seeds file, so a stop in the middle of a draw costs at most that draw.

Your PC sleeping stops both programs. For a day-long run, set Windows to never sleep while plugged in (Settings → System → Power).

---

## Part 5: Chaos tests (once the quiet run looks good)

Each of these should end with the affected draw **voided** or finished normally, and the next draw opening on time:

1. Stop the oracle, wait for a draw to close, watch it void after the 15-minute draw window, start the oracle again.
2. Stop the keeper just after a draw closes (no reveal), watch it void after 10 minutes, start the keeper again: it opens a fresh draw.
3. Stop both, wait an hour, start both.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Lunardraw isn't built yet` | Run `npm install && npm run compact:keys && npm run build` in `~/Lunardraw`. |
| `no Lunardraw deployment on preview yet` | Run the deploy (Part 3) first; it writes `deployments/preview.json`. |
| `the oracle key is not active yet` | The deploy ran without `--accept`: run `./lunardraw accept-key --network preview --oracle ~/lunardraw-secrets/oracle.secret --wallet ~/lunardraw-secrets/oracle-wallet.secret`. |
| `the oracle has not accepted its key yet, so no draw can open` | Same as above. |
| `Waiting for the first DUST` for ages | Stale wallet state: rerun with `NIGHTCAST_NO_WALLET_STATE=1` in front, or `nightcast/nightcast wallet forget --network preview --wallet <file>`. |
| `Wallet sync problem: ...` lines now and then | The wallet reconnecting by itself; ignore unless it never recovers. |
| `no seed for draw N in the seed store` | The seeds file was lost or replaced. That draw will void and be refunded; the keeper opens a new one. Restore the file from backup if you have one. |
| `an oracle key change is pending` | Someone proposed a new oracle key. If it wasn't you, treat the organiser secret as leaked. |
| `1010: Invalid Transaction: Custom error: 104` after computing the numbers | The proof took longer than the contract's clock window allows (see Part 4). Free up memory, or use hourly draws and `--prove-lead`. |
| Docker errors about ports or containers | Make sure Docker Desktop is running; `docker ps` shows the proof servers; `docker rm -f $(docker ps -aq)` clears leftovers. |
