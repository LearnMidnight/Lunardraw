/**
 * `lunardraw-agent skill`: how an AI agent plays Starfall, as a skill file
 * (SKILL.md, the format Claude, Codex, OpenClaw and Hermes read) for agents
 * that use the command line or the local address rather than the MCP tools.
 */
export const SKILL = `---
name: lunardraw-starfall
description: Play Starfall, Lunardraw's lottery on the Midnight Preprod test network (tNIGHT test tokens with no value), from this computer's agent wallet. Use when the user mentions Starfall or Lunardraw, asks what draw is on or what the jackpot is, asks to buy or play tickets, or asks whether their tickets won.
---

# Starfall (Lunardraw)

Starfall is a lottery on the Midnight Preprod **test** network. It uses tNIGHT, a test token with no value.
A game is 7 numbers from 1-35 plus a Moonball from 1-20 and costs 1.2 tNIGHT. Draws close on the hour.
Prizes and refunds are paid to the wallet automatically: there is nothing to claim.

The owner's spending limits (per draw and per day) are in their config.json. You can read them but can't change them,
and a purchase over them is refused. Don't web-search Starfall: read the live game with the commands below.

## If you have the Lunardraw MCP tools

Use them: \`lunardraw_draw_on_sale\`, \`lunardraw_buy_tickets\`, \`lunardraw_my_tickets\`, \`lunardraw_wallet\`, \`lunardraw_how_to_play\`.

## With the command line

Every command takes \`--json\`: standard output is then only the JSON answer.

- What's on: \`lunardraw-agent status --json\` (the draw on sale, the jackpot estimate, recent results)
- Buy QuickPick games: \`lunardraw-agent buy --games 2 --json\`
- A package: \`lunardraw-agent buy --package starter --json\` (single, starter, mini, regular, super, mega, jumbo, maxi)
- Chosen numbers: \`lunardraw-agent buy --numbers "3 9 14 21 27 33 35" --moonball 8 --json\`
- A System entry (every 7 of 8-12 numbers): \`lunardraw-agent buy --system 9 --json\`
- Every Moonball: add \`--sweep\` (20 times the games)
- Tickets and results ("did I win?"): \`lunardraw-agent tickets --json\`
- Wallet (tNIGHT, DUST): \`lunardraw-agent wallet --json\`
- The limits: \`lunardraw-agent limits\`

A purchase takes 2-3 minutes. Don't start a second one while one is on its way; check \`tickets\` instead.

## With the local address (any language)

When the agent is running (\`lunardraw-agent serve\`, or an AI app connected to it), it answers on
http://127.0.0.1:6338. Send the key in ~/.lunardraw-agent/agent-token.secret as \`Authorization: Bearer <key>\`.

- \`GET /api/draw\`, \`GET /api/tickets\`, \`GET /api/wallet\`, \`GET /api/rules\`
- \`POST /api/buy\` with JSON like \`{"games": 2}\` or \`{"numbers": [3, 9, 14, 21, 27, 33, 35], "moonball": 8}\`.
  It answers within 45 seconds; \`{"status": "buying"}\` means it finishes by itself: check \`/api/tickets\`.
- \`POST /mcp\`: the same tools over MCP (Streamable HTTP).
- \`GET /openapi.json\` describes it all.
`;
