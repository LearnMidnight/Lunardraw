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
A draw closes every day at 20:00 Brisbane time (10:00 UTC). A game is 7 numbers in the draw's own format, which grows with sales:
from 7 of 1-20 with no Moonball up to 7 of 1-45 with a Moonball from 1-20 (\`status\` gives the draw on sale's format, the price, 1.3 tNIGHT, and when it closes).
The jackpot is fixed before the draw sells. Syndicates buy many games together and share any prize by shares.
Prizes and refunds are paid to the wallet automatically: there is nothing to claim.
Starfall Classic (7 of 1-35 + a Moonball of 1-20) ends with its final draw on 27 Nov 2026: add \`--game classic\` (or \`"game": "classic"\`) to play it.

The owner's spending limits (per draw and per day) are in their config.json or the app's settings. You can read them but can't change them,
and a purchase over them is refused. Don't web-search Starfall: read the live game with the commands below.

## If you have the Lunardraw MCP tools

Use them: \`lunardraw_draw_on_sale\`, \`lunardraw_buy_tickets\`, \`lunardraw_my_tickets\`, \`lunardraw_syndicates\`, \`lunardraw_join_syndicate\`, \`lunardraw_wallet\`, \`lunardraw_how_to_play\`.

## With the command line

Every command takes \`--json\`: standard output is then only the JSON answer.

- What's on: \`lunardraw-agent status --json\` (the draw on sale, its format, the jackpot, recent results)
- Buy QuickPick games: \`lunardraw-agent buy --games 2 --json\`
- Chosen numbers, within the draw's format: \`lunardraw-agent buy --numbers "3 7 9 12 14 17 20" --json\` (add \`--moonball 8\` in a draw with a Moonball)
- A System entry (every 7 of 8-12 numbers): \`lunardraw-agent buy --system 8 --numbers "1 3 5 7 9 11 13 15" --json\`
- Every Moonball (in a draw with one): add \`--sweep\`
- Syndicates: \`lunardraw-agent syndicates --json\`, then \`lunardraw-agent join --syndicate 4 --shares 2 --json\`
- Starfall Classic's final draw: \`lunardraw-agent buy --game classic --package starter --json\` (single, starter, mini, regular, super, mega, jumbo, maxi)
- Tickets and results ("did I win?"): \`lunardraw-agent tickets --json\`
- Wallet (tNIGHT, DUST): \`lunardraw-agent wallet --json\`
- The limits: \`lunardraw-agent limits\`

A purchase takes 2-3 minutes. Don't start a second one while one is on its way; check \`tickets\` instead.

## With the local address (any language)

When the agent is running (\`lunardraw-agent serve\`, or an AI app connected to it), it answers on
http://127.0.0.1:6338. Send the key in ~/.lunardraw-agent/agent-token.secret as \`Authorization: Bearer <key>\`.

- \`GET /api/draw\`, \`GET /api/tickets\`, \`GET /api/wallet\`, \`GET /api/rules\`, \`GET /api/syndicates\`
- \`POST /api/buy\` with JSON like \`{"games": 2}\` or \`{"numbers": [3, 7, 9, 12, 14, 17, 20]}\` (\`"game": "classic"\` for Classic).
- \`POST /api/join\` with \`{"syndicate": 4, "shares": 2}\`.
  It answers within 45 seconds; \`{"status": "buying"}\` means it finishes by itself: check \`/api/tickets\`.
- \`POST /mcp\`: the same tools over MCP (Streamable HTTP).
- \`GET /openapi.json\` describes it all.
`;
