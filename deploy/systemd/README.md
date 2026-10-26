# Running Lunardraw as services (systemd)

On a Linux server, run the proof server, the keeper and the oracle as systemd
services instead of in terminal windows: they start when the server boots,
restart if they stop (including when the keeper's or the oracle's watchdog asks
for a restart, exit code 75: after 3 minutes of failing transactions, or 15
minutes with the wallet's sync not moving), and their logs are kept by the
journal. Every 30 minutes each logs a `wallet sync:` line with its positions.

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

The everyday commands are the same with `lunardraw-starfall-keeper` and
`lunardraw-starfall-oracle` in place of `lunardraw-keeper` and `lunardraw-oracle`.
