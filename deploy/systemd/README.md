# Running Lunardraw as services (systemd)

On a Linux server, run the proof server, the keeper and the oracle as systemd
services instead of in terminal windows: they start when the server boots,
restart if they stop (including when the keeper's or the oracle's watchdog asks
for a restart after its transactions kept failing, exit code 75), and their
logs are kept by the journal.

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
