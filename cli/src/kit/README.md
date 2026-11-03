# @lunardraw/agent

Let an AI agent play **Starfall**, [Lunardraw](https://lunardraw.io)'s lottery on the Midnight Preprod test network, from its **own wallet**: a command line (`lunardraw-agent`) and an **MCP server** for Claude and other AI assistants.

> **Test tokens only.** Starfall runs on Midnight Preprod with tNIGHT, which has no value. Lunardraw never holds your keys: the wallet lives in a file on your machine.

- **A game**: 7 numbers from 1–35 and a Moonball from 1–20, 1.2 tNIGHT. Draws close on the hour on Preprod; the numbers come from [Nightcast](https://github.com/LearnMidnight/Nightcast) verifiable randomness, and anyone can check every draw.
- **Nothing to claim.** Prizes, and refunds if a draw is cancelled, are paid to the wallet automatically.
- **No proof server needed.** Ticket purchases are proved by Lunardraw's hosted prover (it sees the ticket being bought, never the draw), and the wallet proves its own fees on your machine.
- **Spending limits** (25 tNIGHT a draw and 100 a day by default) are set by the owner in a config file. An AI using the MCP server can read them but can't change them.

## Set up (about 10 minutes, then a long first sync)

You need [Node.js](https://nodejs.org) 22 or later. Then, in a terminal:

```bash
npm install -g @lunardraw/agent
lunardraw-agent setup
```

`setup` walks you through it, one question at a time, and opens the right pages for you:

1. **A free Blockfrost key.** Midnight's Preprod network is served by [Blockfrost](https://blockfrost.io). Sign up, click **Add project**, choose **Midnight Preprod**, and paste the project ID. Setup checks it works.
2. **Test tNIGHT.** It shows your wallet's address and opens the [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/): paste the address there and ask for tNIGHT.
3. **Your AI assistant.** If Claude Desktop is installed, setup adds Lunardraw to it for you; it also shows the line for Claude Code and other assistants.
4. **The first sync.** A new wallet reads the whole Preprod chain, which **takes hours** (a progress bar shows how long is left). It saves its progress: if you stop, run `lunardraw-agent setup` again and it carries on.

When it says **All set!**, ask your assistant: *"What's on in Starfall? Buy me two QuickPick games."*

(`lunardraw-agent init --blockfrost <project id>` does the same without questions, for scripts.)

## Play from the command line

```bash
lunardraw-agent status                     # the draw on sale, the jackpot, recent results
lunardraw-agent buy --games 2              # two QuickPick games
lunardraw-agent buy --package starter      # a QuickPick package (single, starter, mini, regular, super, mega, jumbo, maxi)
lunardraw-agent buy --numbers "3 9 14 21 27 33 35" --moonball 8
lunardraw-agent buy --system 9             # every 7 of 9 numbers (36 games)
lunardraw-agent buy --games 1 --sweep      # with every Moonball (20 games)
lunardraw-agent tickets                    # what it bought, and how each draw went
lunardraw-agent play --style mix           # keep playing every draw, within the limits
```

A purchase takes 2–3 minutes. If another purchase lands at the same moment and takes its ticket number, the kit builds it again by itself. Add `--json` for machine-readable output.

## Let an AI assistant play (MCP)

`lunardraw-agent mcp` is an MCP server over stdio. In Claude Desktop, add it to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lunardraw": { "command": "lunardraw-agent", "args": ["mcp"] }
  }
}
```

(Claude Code: `claude mcp add lunardraw -- lunardraw-agent mcp`.) The tools:

| Tool | What it does |
|---|---|
| `lunardraw_how_to_play` | The rules, prices, prize divisions, odds and the owner's limits |
| `lunardraw_draw_on_sale` | The draw on sale, the jackpot estimate and the latest results (no wallet needed) |
| `lunardraw_wallet` | The wallet's address, tNIGHT and DUST (opens the wallet the first time: a few minutes) |
| `lunardraw_buy_tickets` | Buys games, a package or a chosen entry for the draw on sale, within the limits (2–3 minutes) |
| `lunardraw_my_tickets` | Every ticket bought, with each draw's result |

Then ask, for example, *"What's the Starfall jackpot? Buy me two QuickPick games."*

## Limits and files

Everything lives in `~/.lunardraw-agent` (or `LUNARDRAW_AGENT_HOME`):

| File | What it is |
|---|---|
| `config.json` | `network`, `prover` (`hosted`, a prover's address, or `local:<port>` for your own proof server), `limits` (`perDraw`, `perDay` in tNIGHT), optional `payTo` (where winnings go) |
| `wallet.secret` | The wallet seed (mode 600). **Anyone with it can spend from the wallet.** Back it up. |
| `blockfrost-preprod.secret` | The Blockfrost project id |
| `state.json` | What the agent bought |
| `wallet-state/` | The wallet's saved sync |

Downloaded proving keys for the wallet's own proofs are cached in `~/.cache/nightcast/keys`.

## Troubleshooting

| You see | Means |
|---|---|
| Syncing… for hours | A new wallet's first sync. Leave it running; it saves progress. |
| "the wallet has no DUST yet" | DUST builds up a few minutes after tNIGHT arrives. Try again shortly. |
| "not buying: … over the owner's limit" | The purchase would pass the limits in `config.json`. |
| "no draw is on sale right now" | Between a draw closing and the next opening (on the hour). |
| "wallet in use" | Another `lunardraw-agent` (or an MCP server) has the wallet open. One at a time. |

Source and issues: [LearnMidnight/Lunardraw](https://github.com/LearnMidnight/Lunardraw). MIT licence.
