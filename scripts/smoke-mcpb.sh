#!/usr/bin/env bash
# Opens a built Claude extension (lunardraw-x.y.z.mcpb) the way Claude would:
# unzipped, then its manifest's command run with a fresh home and the
# Blockfrost key from the extension's settings. Checks the manifest, that the
# first start sets the agent up by itself (config, wallet, the key kept), and
# an MCP handshake (stdout must be JSON-RPC only). Used by CI and the publish
# workflow.
#
#   bash scripts/smoke-mcpb.sh <lunardraw-x.y.z.mcpb>
set -euo pipefail
mcpb="$(realpath "$1")"
work="$(mktemp -d)"
ext="$work/extension"
mkdir -p "$ext" && cd "$work"
unzip -q "$mcpb" -d "$ext"
node -e '
  const m = require(process.argv[1]);
  const want = ["lunardraw_how_to_play", "lunardraw_draw_on_sale", "lunardraw_wallet", "lunardraw_buy_tickets", "lunardraw_my_tickets"];
  const tools = m.tools.map((t) => t.name);
  if (m.name !== "lunardraw" || m.server.type !== "node" || want.some((w) => !tools.includes(w)) || !m.user_config.blockfrost.sensitive) {
    console.log("::error title=extension manifest::" + JSON.stringify(m).slice(0, 800)); process.exit(1);
  }
' "$ext/manifest.json"
test -f "$ext/icon.png"
# as Claude starts it: the manifest's command and arguments, ${__dirname} filled in, no PATH help
args=$(node -e 'const m = require(process.argv[1]); console.log(m.server.mcp_config.args.map((a) => a.replace("${__dirname}", process.argv[2])).join("\n"))' "$ext/manifest.json" "$ext")
mapfile -t argv <<< "$args"
export LUNARDRAW_AGENT_HOME="$work/home" LUNARDRAW_BLOCKFROST=ciPlaceholderId123 LUNARDRAW_AGENT_LAZY=1 LUNARDRAW_AGENT_PORT=6398
cd /  # Claude may start it anywhere
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lunardraw_how_to_play","arguments":{}}}' \
  | node "${argv[@]}" > "$work/mcp.out" 2> "$work/mcp.err" || { cat "$work/mcp.err"; exit 1; }
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  if (byId[1].result.serverInfo.name !== "lunardraw" || byId[2].result.tools.length < 5 || !/1.2 tNIGHT a game/.test(byId[3].result.content[0].text)) {
    console.log("::error title=extension mcp::" + lines.join(" ").slice(0, 1500)); process.exit(1);
  }
' "$work/mcp.out"
# the first start set the agent up: a config, a wallet (mode 600) and the key from the settings
test -f "$LUNARDRAW_AGENT_HOME/config.json"
test "$(stat -c %a "$LUNARDRAW_AGENT_HOME/wallet.secret")" = 600
test "$(cat "$LUNARDRAW_AGENT_HOME/blockfrost-preprod.secret")" = ciPlaceholderId123
echo "::notice title=claude extension::opened like Claude would: set itself up and answered MCP ($(du -h "$mcpb" | cut -f1))"
