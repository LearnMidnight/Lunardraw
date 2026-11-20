#!/usr/bin/env bash
# Move the house agents (pixel, orbit, nova) from Starfall Classic onto Starfall v2, as root on the VM.
#
#   bash agents-v2.sh install    a checkout of main at /root/Lunardraw-agents (built), each agent's
#                                v2 style from its Classic one, the v2 agent unit, and the daily window
#                                timers pointed at the v2 agents (and switched on)
#   bash agents-v2.sh status     the agents, their timers and their last lines
#   bash agents-v2.sh update     pull main into the agents' checkout and rebuild it
#   bash agents-v2.sh undo       the timers back to the Classic agents (left switched off)
#
# The live keeper's and oracle's checkouts (/root/Lunardraw, /root/Lunardraw-v2) are not touched:
# the agents read the compiled v2 game and its deployment record from /root/Lunardraw-v2.
# Prints no secrets and touches no wallet (the agents use their own, as on Classic).
set -euo pipefail
REPO=/root/Lunardraw-agents
V2=/root/Lunardraw-v2
ENVS=/root/lunardraw-agents
D=/etc/systemd/system
AGENTS="nova orbit pixel"
export PATH="/root/.local/bin:$PATH"
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run this as root on the VM"

build() {
  if [ ! -d "$REPO/.git" ]; then git clone -q "$(git -C /root/Lunardraw remote get-url origin)" "$REPO"; fi
  cd "$REPO"
  git fetch -q origin && git checkout -q main && git pull -q --ff-only origin main
  git submodule update --init --recursive -q
  echo "at $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"
  npm ci --no-audit --no-fund --loglevel=error
  npm run -s compact >/dev/null
  npm run -s build >/dev/null
  grep -q "case 'agent'" cli/dist/starfall-v2-commands.js || die "this checkout's CLI has no 'starfall-v2 agent' (is the PR merged into main?)"
  echo "built"
}

# A Classic agent's arguments as v2 takes them: --style, --games, --rounds, --budget, --max-draws and
# --lines carry over; --numbers/--moonball become one --lines set; hourly and daily-limit flags go.
convert() {
  python3 - "$1" <<'PY'
import shlex, sys
args = shlex.split(sys.argv[1])
keep = {'--style', '--games', '--rounds', '--budget', '--max-draws', '--lines'}
out, nums, mb, i = [], None, None, 0
while i < len(args):
    a = args[i]; v = args[i + 1] if i + 1 < len(args) else ''
    if a in keep: out += [a, v]; i += 2
    elif a == '--numbers': nums = v; i += 2
    elif a == '--moonball': mb = v; i += 2
    elif a.startswith('--') and i + 1 < len(args) and not args[i + 1].startswith('--'): i += 2
    else: i += 1
if nums and '--lines' not in out: out += ['--lines', f"{nums}+{mb or 1}"]
print(' '.join(out))
PY
}

case "${1:-}" in
  install)
    [ -f "$V2/deployments/starfall-v2-preprod.json" ] || die "no Starfall v2 deployment record at $V2/deployments"
    [ -f "$V2/starfall-v2/deploy/out/settlement/contract/index.js" ] || die "no compiled v2 game in $V2/starfall-v2/deploy/out"
    say "1. The agents' own checkout of main at $REPO (a few minutes)"
    build
    say "2. Each agent's v2 style (from its Classic one)"
    for n in $AGENTS; do
      [ -f "$ENVS/$n.secret" ] || die "no wallet for $n at $ENVS/$n.secret"
      classic="$(sed -n 's/^AGENT_ARGS=//p' "$ENVS/$n.env" 2>/dev/null | tail -1)"
      v2args="$(convert "$classic")"
      [ -f "$ENVS/$n.v2.env" ] && cp -p "$ENVS/$n.v2.env" "$ENVS/$n.v2.env.before"
      printf 'AGENT_ARGS=%s\n' "$v2args" > "$ENVS/$n.v2.env"
      echo "$n: $v2args"
    done
    say "3. Can the agents' checkout read the v2 game?"
    (cd "$REPO" && LUNARDRAW_STARFALL_V2_OUT="$V2/starfall-v2/deploy/out" ./lunardraw starfall-v2 status --network preprod --record "$V2/deployments/starfall-v2-preprod.json" 2>&1 | head -4)
    say "4. The v2 agent unit, and the window timers pointed at it"
    cp "$REPO/deploy/systemd/lunardraw-agent-v2@.service" "$D/"
    systemctl stop lunardraw-agent@nova lunardraw-agent@orbit lunardraw-agent@pixel 2>/dev/null || true
    systemctl disable lunardraw-agent@nova lunardraw-agent@orbit lunardraw-agent@pixel >/dev/null 2>&1 || true
    found=0
    for f in "$D"/lunardraw-agent-window-*.service; do
      [ -f "$f" ] || continue
      found=1
      [ -f "$f.before-v2" ] || cp -p "$f" "$f.before-v2"
      sed -i 's#systemctl \(start\|stop\) lunardraw-agent@#systemctl \1 lunardraw-agent-v2@#' "$f"
    done
    [ "$found" = 1 ] || die "no agent window timers in $D (agents-window.sh install sets them up)"
    systemctl daemon-reload
    systemctl enable --now $(ls "$D" | grep -E '^lunardraw-agent-window-.*\.timer$') >/dev/null
    grep -h 'ExecStart' "$D"/lunardraw-agent-window-start-*.service | sed 's/^/  /'
    systemctl list-timers 'lunardraw-agent-window-*' --no-pager | head -8
    say "Done"
    echo "Each agent now starts on Starfall v2 in its daily window (pixel 6 am, orbit 12 pm, nova 6 pm Brisbane)."
    echo "To start one now: systemctl start lunardraw-agent-v2@pixel   (it buys once a draw)"
    ;;
  update)
    build
    for n in $AGENTS; do systemctl is-active -q "lunardraw-agent-v2@$n" && systemctl restart "lunardraw-agent-v2@$n" && echo "restarted $n"; done
    ;;
  status)
    for n in $AGENTS; do
      echo "$n: $(systemctl is-active lunardraw-agent-v2@$n) ($(sed -n 's/^AGENT_ARGS=//p' "$ENVS/$n.v2.env" 2>/dev/null))"
      journalctl -u "lunardraw-agent-v2@$n" --since '26 hours ago' -o short --no-pager 2>/dev/null | grep -E "\[$n\] (in draw|draw |sitting out|playing)" | tail -2 | cut -c1-220 | sed 's/^/  /'
    done
    systemctl list-timers 'lunardraw-agent-window-*' --no-pager | head -8
    ;;
  undo)
    for n in $AGENTS; do systemctl stop "lunardraw-agent-v2@$n" 2>/dev/null || true; done
    systemctl disable --now $(ls "$D" | grep -E '^lunardraw-agent-window-.*\.timer$') >/dev/null 2>&1 || true
    for f in "$D"/lunardraw-agent-window-*.service.before-v2; do [ -f "$f" ] && mv "$f" "${f%.before-v2}"; done
    systemctl daemon-reload
    echo "The window timers point at the Classic agents again, switched off. To switch them on:"
    echo "  systemctl enable --now \$(ls $D | grep -E '^lunardraw-agent-window-.*\\.timer\$')"
    ;;
  *)
    sed -n 2,13p "$0"
    exit 1
    ;;
esac
