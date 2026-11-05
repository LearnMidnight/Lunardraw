# @lunardraw/agent

Let an AI agent play **Starfall**, [Lunardraw](https://lunardraw.io)'s lottery on the Midnight Preprod test network, from its **own wallet**: a command line (`lunardraw-agent`) and an **MCP server** for any AI that can use local tools (Claude, ChatGPT, Codex, Gemini CLI, Cursor, VS Code, OpenClaw, Hermes Agent and more), a private link for ChatGPT, Claude and Grok on the web or a phone, and a local REST API for your own agents.

> **Test tokens only.** Starfall runs on Midnight Preprod with tNIGHT, which has no value. Lunardraw never holds your keys: the wallet lives in a file on your machine.

- **A game**: 7 numbers from 1–35 and a Moonball from 1–20, 1.2 tNIGHT. Draws close on the hour on Preprod; the numbers come from [Nightcast](https://github.com/LearnMidnight/Nightcast) verifiable randomness, and anyone can check every draw.
- **Nothing to claim.** Prizes, and refunds if a draw is cancelled, are paid to the wallet automatically.
- **No proof server needed.** Ticket purchases are proved by Lunardraw's hosted prover (it sees the ticket being bought, never the draw), and the wallet proves its own fees on your machine.
- **Spending limits** (25 tNIGHT a draw and 100 a day by default) are set by the owner in a config file. An AI using the MCP server can read them but can't change them.

## The easiest way: the Claude extension

Using the Claude desktop app? Download **[lunardraw.mcpb](https://github.com/LearnMidnight/Lunardraw/releases/latest/download/lunardraw.mcpb)** and open it: Claude installs it, with no Node.js or terminal needed. Paste a free Blockfrost key (blockfrost.io, a **Midnight Preprod** project) into its settings, then ask Claude *"Set me up for Starfall"*: it shows your wallet's address, the faucet for free tNIGHT, and how far the first sync has got. It's the same kit as below and shares its folder (`~/.lunardraw-agent`), so use one or the other in Claude, not both.

## Set up (about 10 minutes, then a long first sync)

You need [Node.js](https://nodejs.org) 22 or later. Then, in a terminal:

```bash
npm install -g @lunardraw/agent
lunardraw-agent setup
```

`setup` walks you through it, one question at a time, and opens the right pages for you:

1. **A free Blockfrost key.** Midnight's Preprod network is served by [Blockfrost](https://blockfrost.io). Sign up, click **Add project**, choose **Midnight Preprod**, and paste the project ID. Setup checks it works.
2. **Test tNIGHT.** It shows your wallet's address and opens the [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/): paste the address there and ask for tNIGHT.
3. **Your AI.** Setup finds the AI apps on your computer and adds Lunardraw to them for you (see the table below). For anything else it prints the line to add. `lunardraw-agent connect` does this step again at any time.
4. **The first sync.** A new wallet reads the whole Preprod chain, which **takes hours** (a progress bar shows how long is left). It saves its progress: if you stop, run `lunardraw-agent setup` again and it carries on.

When it says **All set!**, ask your AI: *"What's on in Starfall? Buy me two QuickPick games."*

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

A purchase takes 2–3 minutes. If another purchase lands at the same moment and takes its ticket number, the kit builds it again by itself.

**From your own program:** add `--json` to `status`, `wallet`, `buy` and `tickets`. Standard output is then only the JSON answer (the log goes to standard error), and the exit code is 0 when everything asked for was bought. Any language can call it, for example Python: `json.loads(subprocess.run(["lunardraw-agent", "buy", "--games", "2", "--json"], capture_output=True, text=True).stdout)`.

## Let your AI play (MCP)

`lunardraw-agent mcp` is an MCP server over stdio: it runs on your computer, next to your wallet. **`lunardraw-agent connect` adds it to these apps for you** (each settings file is backed up first, as `<file>.before-lunardraw`):

| Your AI | Where `connect` adds Lunardraw |
|---|---|
| **Claude** (desktop app) | `claude_desktop_config.json` (the Microsoft Store install's own folder too) |
| **Claude Code** | `claude mcp add --scope user lunardraw …` |
| **ChatGPT** (desktop app) and **Codex** | `~/.codex/config.toml` (they share it) |
| **Gemini CLI** | `~/.gemini/settings.json` |
| **Cursor** | `~/.cursor/mcp.json` |
| **VS Code** (Copilot) | your user `mcp.json` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **LM Studio** | `~/.lmstudio/mcp.json` |
| **OpenClaw** | `openclaw mcp add lunardraw …` |
| **Hermes Agent** | `~/.hermes/config.yaml` |

**Anything else** (Cline, Zed, Goose, Continue, Msty, AnythingLLM, your own agent): add an MCP server named `lunardraw` with the command `lunardraw-agent` and the argument `mcp`. `connect` prints the full paths for your computer.

**Tool calls answer within a minute.** A purchase takes 2–3 minutes, so if it isn't done within 45 seconds the buy tool answers "buying" and the purchase finishes by itself; `lunardraw_my_tickets` shows it land. Opening the wallet works the same way. So the usual 60-second tool timeout is enough.

**One agent per computer.** Every connected app starts `lunardraw-agent mcp`, but they share one agent: the first to start opens the wallet and the others pass their requests to it (a wallet can only be open in one program at a time). If that app closes, the next one takes over.

## On the web or your phone (ChatGPT, Claude, Grok)

AIs on the web or a phone can only reach servers on the internet, and your wallet stays on your computer. So Lunardraw runs a relay that passes their messages to your agent, which links to it from your computer (nothing calls in, so it works behind any router):

```bash
lunardraw-agent remote
```

It keeps the agent running in the background from when you sign in, starts it now, and gives you a **private address**. Add it to your AI app:

| App | How |
|---|---|
| **ChatGPT** (web; Plus or Pro) | Turn on Developer mode (Settings, Security and login), then add an app or connector with the address as its MCP server URL and **No authentication** |
| **Claude** (claude.ai, then the phone app too) | Customize, Connectors, **Add custom connector**: paste the address, **No sign-in** |
| **Grok** | grok.com/connectors, **New Connector**, Custom: paste the address |
| **Anything else** | any app that adds an MCP server by its address (Streamable HTTP), no sign-in |

Keep the address private: anyone with it can ask your agent to buy, within your limits. `lunardraw-agent remote new-link` makes a new one (the old one stops working), `remote off` turns the link off, and `remote off --stop-at-login` also stops the background agent starting when you sign in. The relay holds no keys and keeps nothing: your wallet and limits stay on your computer, which needs to be on.

## Your own agent

- **Command line:** every command takes `--json` (below).
- **Local address:** while the agent runs (`lunardraw-agent serve`, or any connected app), it answers on `http://127.0.0.1:6338` with a REST API (`GET /api/draw`, `/api/tickets`, `/api/wallet`, `/api/rules`, `POST /api/buy` with `{"games": 2}`) and MCP over HTTP (`POST /mcp`). `GET /openapi.json` describes it. Send the key in `~/.lunardraw-agent/agent-token.secret` as `Authorization: Bearer <key>`. For an agent in a container, `serve --host 0.0.0.0`.
- **A skill file:** `lunardraw-agent skill > SKILL.md` gives an agent the rules and the commands, in the SKILL.md format Claude, Codex, OpenClaw and Hermes read.

The tools:

| Tool | What it does |
|---|---|
| `lunardraw_how_to_play` | The rules, prices, prize divisions, odds and the owner's limits |
| `lunardraw_draw_on_sale` | The draw on sale, the jackpot estimate and the latest results (no wallet needed) |
| `lunardraw_wallet` | The wallet's address, tNIGHT and DUST |
| `lunardraw_buy_tickets` | Buys games, a package or a chosen entry for the draw on sale, within the limits (answers within 45 seconds; the purchase takes 2–3 minutes) |
| `lunardraw_my_tickets` | Every ticket bought, with each draw's result |

Then ask, for example, *"What's the Starfall jackpot? Buy me two QuickPick games."*

## Limits and files

Everything lives in `~/.lunardraw-agent` (or `LUNARDRAW_AGENT_HOME`):

| File | What it is |
|---|---|
| `config.json` | `network`, `remote` (the web and phone link on or off), `port` (the local address, 6338), `prover` (`hosted`, a prover's address, or `local:<port>` for your own proof server: that needs the contract's proving key, so run the kit from a [Lunardraw checkout](https://github.com/LearnMidnight/Lunardraw)), `limits` (`perDraw`, `perDay` in tNIGHT), optional `payTo` (where winnings go) |
| `wallet.secret` | The wallet seed (mode 600). **Anyone with it can spend from the wallet.** Back it up. |
| `blockfrost-preprod.secret` | The Blockfrost project id |
| `state.json` | What the agent bought |
| `wallet-state/` | The wallet's saved sync |
| `agent-token.secret` | The key for the agent's local address (mode 600) |
| `relay-link.secret` | The private address's secret, for AIs on the web or a phone (mode 600) |
| `agent.log` | What the agent running in the background did |

Downloaded proving keys for the wallet's own proofs are cached in `~/.cache/nightcast/keys`.

## Troubleshooting

| You see | Means |
|---|---|
| Syncing… for hours | A new wallet's first sync. Leave it running; it saves progress. |
| "the wallet has no DUST yet" | DUST builds up a few minutes after tNIGHT arrives. Try again shortly. |
| "not buying: … over the owner's limit" | The purchase would pass the limits in `config.json`. |
| "no draw is on sale right now" | Between a draw closing and the next opening (on the hour). |
| "wallet in use" | Another program has the wallet open (`lunardraw-agent play`, say, or an older kit). Stop it first. Connected apps and `buy` share the agent that's running, so they don't clash. |
| ChatGPT or Claude on the web says the agent isn't connected | The computer is off or asleep, or the agent isn't running: `lunardraw-agent remote` starts it. |
| Something else | `lunardraw-agent doctor` checks everything and says what to fix. |
| "the connection to the Midnight node dropped for a moment" | Blockfrost's node connection blipped; it reconnects by itself. `LUNARDRAW_AGENT_DEBUG=1` shows the details. |

Source and issues: [LearnMidnight/Lunardraw](https://github.com/LearnMidnight/Lunardraw). MIT licence.
