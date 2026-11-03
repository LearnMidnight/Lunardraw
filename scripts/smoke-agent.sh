#!/usr/bin/env bash
# Installs a packed @lunardraw/agent the way a player would (npm install -g),
# with no C compiler, into a scratch folder, and runs it: help, init, limits,
# address, and an MCP handshake (stdout must be JSON-RPC only). Used by CI and
# the publish workflow.
#
#   bash scripts/smoke-agent.sh <lunardraw-agent-x.y.z.tgz>
set -euo pipefail
tgz="$(realpath "$1")"
work="${RUNNER_TEMP:-$(mktemp -d)}"
export LUNARDRAW_AGENT_HOME="$work/agent-home" CC=/bin/false CXX=/bin/false
app="$work/someone-else"
mkdir -p "$app" && cd "$app"
npm install -g --prefix "$work/global" --no-audit --no-fund "$tgz"
export PATH="$work/global/bin:$PATH"
lunardraw-agent help > help.txt && head -3 help.txt
lunardraw-agent init --blockfrost ciPlaceholderId123 | tee init.txt
grep -q 'mn_addr_preprod1' init.txt
test "$(stat -c %a "$LUNARDRAW_AGENT_HOME/wallet.secret")" = 600
lunardraw-agent limits
test "$(lunardraw-agent address)" = "$(grep -o 'mn_addr_preprod1[0-9a-z]*' init.txt)"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lunardraw_how_to_play","arguments":{}}}' \
  | lunardraw-agent mcp > mcp.out 2> mcp.err
node -e '
  const lines = require("fs").readFileSync("mcp.out", "utf8").trim().split("\n");
  const msgs = lines.map((l) => JSON.parse(l));
  const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
  const tools = byId[2].result.tools.map((t) => t.name);
  const want = ["lunardraw_how_to_play", "lunardraw_draw_on_sale", "lunardraw_wallet", "lunardraw_buy_tickets", "lunardraw_my_tickets"];
  if (byId[1].result.serverInfo.name !== "lunardraw" || want.some((w) => !tools.includes(w)) || !/1.2 tNIGHT a game/.test(byId[3].result.content[0].text)) {
    console.log("::error title=mcp::" + JSON.stringify(msgs).slice(0, 1500)); process.exit(1);
  }
  console.log(`::notice title=mcp::${lines.length} JSON-RPC lines on stdout, tools: ${tools.join(", ")}`);
'
