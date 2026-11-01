# Running Lunardraw as services (systemd)

On a Linux server, run the proof server, the keeper and the oracle as systemd
services instead of in terminal windows: they start when the server boots,
restart if they stop (including when the keeper's or the oracle's watchdog asks
for a restart, exit code 75: after 3 minutes of failing transactions, 15
minutes with the wallet's sync not moving, or, for the Starfall keeper and
oracle, 20 minutes of waiting for DUST at start-up, `--dust-wait`, or 10 minutes
without finishing a pass, `--silent-after`: a process hung inside a chain read,
which the other watchdogs can't see; it exits hard 30 s later if the stuck pass
blocks a graceful stop), and their logs are kept by the journal. Every 30 minutes each logs a `wallet sync:` line with its positions.

The unit files assume the repository in `/root/Lunardraw`, secrets in
`/root/lunardraw-secrets` and `/root/nightcast-secrets`, Preprod, and hourly draws.
Edit them first if yours differ.

## Install

Stop anything already running them by hand (Ctrl+C, or `tmux kill-server`), then:

```bash
cd ~/Lunardraw
cp deploy/systemd/lunardraw-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lunardraw-proof
sleep 20
systemctl enable --now lunardraw-keeper lunardraw-oracle
systemctl status lunardraw-proof lunardraw-keeper lunardraw-oracle --no-pager | grep -E '●|Active'
```

## Everyday commands

> **Running Starfall?** Use the `lunardraw-starfall-*` names in the
> [Starfall](#starfall) table below. The commands in this table are for the
> retired v0 services, and starting a v0 service stops its Starfall twin.

| What | Command |
|---|---|
| Watch the keeper's log live (Ctrl+C stops watching, not the keeper) | `journalctl -u lunardraw-keeper -f` |
| The last hour of the oracle's log | `journalctl -u lunardraw-oracle --since "1 hour ago" --no-pager` |
| Is everything running? | `systemctl status lunardraw-proof lunardraw-keeper lunardraw-oracle --no-pager` |
| Restart one | `systemctl restart lunardraw-keeper` |
| Stop all | `systemctl stop lunardraw-keeper lunardraw-oracle lunardraw-proof` |
| After `git pull && npm run build` | `systemctl restart lunardraw-keeper lunardraw-oracle` |
| After editing a unit file | `systemctl daemon-reload` and restart it |

## Starfall

`lunardraw-starfall-keeper` and `lunardraw-starfall-oracle` run the Starfall
contract instead of v0 (see [docs/starfall-preprod-guide.md](../../docs/starfall-preprod-guide.md)).
They use the v0 services' wallets, so each is marked as conflicting with its v0
twin: starting one stops the other. The proof server is shared.

```bash
systemctl disable --now lunardraw-keeper lunardraw-oracle
cp deploy/systemd/lunardraw-starfall-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lunardraw-starfall-keeper lunardraw-starfall-oracle
```

| What | Command |
|---|---|
| Watch the keeper's log live | `journalctl -u lunardraw-starfall-keeper -f` |
| Is everything running? | `systemctl is-active lunardraw-proof lunardraw-starfall-keeper lunardraw-starfall-oracle` |
| After `git pull && npm run build` (between :30 and :55 past the hour) | `systemctl restart lunardraw-starfall-keeper lunardraw-starfall-oracle` |
| Stop both | `systemctl stop lunardraw-starfall-keeper lunardraw-starfall-oracle` |

Don't restart `lunardraw-keeper` or `lunardraw-oracle` while Starfall is
running: `restart` starts a disabled unit, and its conflict rule then stops
the Starfall twin.

## Agents

`lunardraw-agent@<name>` runs a Starfall agent (`./lunardraw starfall agent`): a
player with its own wallet, `/root/lunardraw-agents/<name>.secret`, and style,
`AGENT_ARGS` in `/root/lunardraw-agents/<name>.env`. See Part 8 of the Preprod
guide. Logs: `journalctl -u 'lunardraw-agent@*' -f`.

## Email alerts (the monitor)

`lunardraw-monitor.timer` runs `./lunardraw monitor` every 5 minutes. It emails
`ops@lunardraw.io` (forwarded to the operator) through [Resend](https://resend.com)
when Starfall needs a person:

| Alert | When |
|---|---|
| A service is not running | any watched unit not active (keeper, oracle, proof server, agents) |
| Restarting over and over | 3 or more restarts within an hour |
| The keeper or oracle isn't reporting | its status file is over 10 minutes old (stopped or frozen) |
| Hasn't checked the chain | no finished pass for 15 minutes (stuck) |
| Transactions failing | 3 or more in a row for 10 minutes |
| Wallet not synced, low on DUST, no tNIGHT | not synced 20 minutes after starting; under `--min-dust` (5,000 DUST in the unit; the default is 1); 0 tNIGHT |
| A draw near its reveal, oracle or settlement deadline | 5 minutes before the reveal or oracle deadline, or the oracle 10 minutes late; an hour before the settlement deadline |
| A draw voided | each one, once, with the reason |
| The site feed is stale, the disk nearly full | no new feed for 10 minutes; under 10% or 5 GB free |

A problem is emailed once it has been seen on two runs in a row (so a service
that restarts itself doesn't page anyone), reminded every 6 hours while it
lasts, and followed by a "resolved" email. A daily summary comes at 08:00
Brisbane (`--digest-hour`): **if it stops arriving, the monitor or the VM is down.**

The keeper and the oracle write the health files it reads with
`--status /root/lunardraw-status/keeper.json` and `oracle.json` (in their unit
files). Nothing in them is secret.

### Install

1. Resend: verify the sending domain (its DNS records) and create an API key
   with sending access only. Put the key on the VM, never in the repository:
   `nano /root/.lunardraw-mail` (paste, save), then `chmod 600 /root/.lunardraw-mail`.
2. Between :30 and :55 past the hour (the keeper and oracle restart):
   ```bash
   cd ~/Lunardraw && git pull && npm run build
   cp deploy/systemd/lunardraw-starfall-*.service deploy/systemd/lunardraw-monitor.* /etc/systemd/system/
   systemctl daemon-reload
   systemctl restart lunardraw-starfall-keeper lunardraw-starfall-oracle
   ./lunardraw monitor --test --from "Lunardraw alerts <alerts@lunardraw.io>" --to ops@lunardraw.io --mail-key /root/.lunardraw-mail
   systemctl enable --now lunardraw-monitor.timer
   ```
3. Check: `./lunardraw monitor --dry-run --feed /root/lunardraw-feed/feed.json --status-dir /root/lunardraw-status`
   prints what it would send now (and changes nothing).

| What | Command |
|---|---|
| When it last ran, and when it runs next | `systemctl list-timers lunardraw-monitor.timer` |
| What it found on its last runs | `journalctl -u lunardraw-monitor --since "1 hour ago" --no-pager` |
| Run it now | `systemctl start lunardraw-monitor` |
| The keeper's or the oracle's health | `cat /root/lunardraw-status/oracle.json` |
| Pause the emails | `systemctl stop lunardraw-monitor.timer` (`start` to resume) |
