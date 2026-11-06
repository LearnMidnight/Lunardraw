#!/usr/bin/env bash
# Installs a packed @lunardraw/agent the way a player would (npm install -g),
# with no C compiler, into a scratch folder, and runs it: help, init, limits,
# address, an MCP handshake (stdout must be JSON-RPC only), and `serve` with an MCP
# server passing its requests to it. Used by CI and the publish workflow.
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
  if (byId[1].result.serverInfo.name !== "lunardraw" || want.some((w) => !tools.includes(w)) || !/[0-9.]+ tNIGHT a game/.test(byId[3].result.content[0].text)) {
    console.log("::error title=mcp::" + JSON.stringify(msgs).slice(0, 1500)); process.exit(1);
  }
  console.log(`::notice title=mcp::${lines.length} JSON-RPC lines on stdout, tools: ${tools.join(", ")}`);
'

# One agent per computer: `serve` holds the agent (and would hold its wallet), and an
# AI app's MCP server passes its requests on to it. Its local address needs the key.
LUNARDRAW_AGENT_LAZY=1 lunardraw-agent serve > serve.log 2>&1 &
serve=$!
trap 'kill $serve 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:6338/health > /dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:6338/health
token="$(cat "$LUNARDRAW_AGENT_HOME/agent-token.secret")"
curl -fsS -H "Authorization: Bearer $token" http://127.0.0.1:6338/api/rules > rules.json
grep -Eq '[0-9.]+ tNIGHT a game' rules.json
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6338/api/rules)" = 401
curl -fsS http://127.0.0.1:6338/openapi.json > openapi.json
grep -q '/api/buy' openapi.json
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lunardraw_how_to_play","arguments":{}}}' \
  | lunardraw-agent mcp > mcp2.out 2> mcp2.err
grep -q 'passing requests to the agent already running' mcp2.err || { cat mcp2.err; exit 1; }
grep -Eq '[0-9.]+ tNIGHT a game' mcp2.out
echo "::notice title=one agent::serve answered on 127.0.0.1:6338 and a second MCP server passed its requests to it"
kill $serve
lunardraw-agent skill > skill.md
grep -q '^name: lunardraw-starfall' skill.md
