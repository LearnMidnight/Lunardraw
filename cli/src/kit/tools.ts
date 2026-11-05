/**
 * The MCP server's tools. The wallet is opened once, when the server starts,
 * and kept open while it runs (opening takes a few minutes; a purchase 2-3).
 */
import { Starfall } from '@lunardraw/contract';
import { loadAgentState } from '../starfall-agent.js';
import { buyEntries } from '../starfall-commands.js';
import { ensureWallet, hasBlockfrost, kitHome, kitPaths, loadConfig, useHome } from './home.js';
import { BUY_SCHEMA, buyArgs, type Tool } from './mcp.js';
import { refreshListing } from './directory.js';
import { type Player, readOverview, ticketsReport, withPlayer } from './player.js';

const DIVISIONS = ['7 + Moonball', '7', '6 + Moonball', '6', '5 + Moonball', '4 + Moonball', '5', '3 + Moonball', '2 + Moonball'];

export const mcpTools = (): Tool[] => {
  const config = loadConfig();
  useHome(config);
  const ready = () => {
    if (!hasBlockfrost(kitHome(), config.network)) {
      throw new Error('The agent has no Blockfrost project id yet. Its owner runs `lunardraw-agent init --blockfrost <project id>` (free at blockfrost.io).');
    }
  };

  // one wallet for the server's life, opened when first needed
  let player: Promise<Player> | undefined;
  let release: () => void = () => undefined;
  const openPlayer = (progress: (m: string) => void): Promise<Player> => {
    ready();
    if (!player) {
      progress('opening the wallet (a few minutes)');
      player = new Promise<Player>((resolve, reject) => {
        withPlayer(config, ensureWallet().seed, (p) => {
          resolve(p);
          return new Promise<void>((done) => (release = done));
        }).catch((err) => {
          player = undefined;
          reject(err);
        });
      });
    }
    return player;
  };
  process.once('exit', () => release());
  // Start opening the wallet as soon as the server starts (an AI app starts it when
  // the app opens), so the first purchase doesn't wait 5 minutes for it on top of
  // the purchase itself; many agents give up on a tool call long before that.
  // LUNARDRAW_AGENT_LAZY=1 waits for the first call instead.
  if (process.env.LUNARDRAW_AGENT_LAZY !== '1' && hasBlockfrost(kitHome(), config.network)) {
    setTimeout(() => void openPlayer(() => undefined).catch(() => undefined), 0).unref?.();
  }

  // If the owner listed the agent in lunardraw.io's directory, keep it up to date
  // (and shown as online) while the server runs, and after each purchase.
  const listingTick = async () => {
    if (!config.listing || !hasBlockfrost(kitHome(), config.network)) return;
    const view = (await readOverview(config).catch(() => undefined))?.view;
    await refreshListing(config, ensureWallet().seed, { view, log: (m) => process.stderr.write(m + '\n') });
  };
  if (config.listing) {
    setTimeout(() => void listingTick(), 5_000).unref?.();
    setInterval(() => void listingTick(), 30 * 60_000).unref?.();
  }

  // keep the client informed during long calls
  const ticking = async <T>(progress: (m: string) => void, what: string, work: Promise<T>): Promise<T> => {
    const t = setInterval(() => progress(`${what}…`), 15_000);
    try {
      return await work;
    } finally {
      clearInterval(t);
    }
  };

  return [
    {
      name: 'lunardraw_how_to_play',
      title: 'How Starfall works',
      description: 'How Starfall (Lunardraw\'s lottery) works: the rules, prices, prize divisions, odds and this agent\'s spending limits.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async () => ({
        text: [
          'Starfall: a lottery on the Midnight Preprod test network (tNIGHT test tokens, no real value).',
          'A game: 7 numbers from 1-35 and a Moonball from 1-20. 1.2 tNIGHT a game (1 to the prize pool, 0.2 operator fee).',
          'Draws close on the hour. Numbers come from Nightcast verifiable randomness; anyone can check every draw.',
          `Prize divisions: ${DIVISIONS.map((d, i) => `${i + 1}: ${d}`).join('; ')}. Division 1 odds are about 1 in 134 million.`,
          'Entries: QuickPick games or packages (' + Object.entries(Starfall.QUICK_PICK_PACKAGES).map(([k, v]) => `${k} ${v}`).join(', ') + '), your own numbers, a System (8-12 numbers, every 7 of them), a Pick (5 or 6 numbers completed every way), and Moonball Sweep (every Moonball, 20 times the games).',
          'Prizes and refunds (if a draw is cancelled) are paid to the wallet automatically. Nothing to claim.',
          `Spending limits set by the owner: ${config.limits.perDraw} tNIGHT a draw, ${config.limits.perDay} tNIGHT in any 24 hours. They can't be changed from here.`,
        ].join('\n'),
      }),
    },
    {
      name: 'lunardraw_draw_on_sale',
      title: 'Draw on sale',
      description: "What's on in Starfall (Lunardraw's lottery) right now: the draw on sale (number, closing time, tickets sold, jackpot estimate), the game price, and the last few results. Use it for any question about Starfall's current draw or results. Reads the chain; no wallet needed.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async () => {
        ready();
        const { overview } = await readOverview(config);
        return { text: JSON.stringify({ game: "Starfall, Lunardraw's lottery on the Midnight Preprod test network", ...overview }, null, 2) };
      },
    },
    {
      name: 'lunardraw_wallet',
      title: "The agent's wallet",
      description: "This agent's Starfall wallet: its address and its tNIGHT and DUST (DUST pays the fees). Opens the wallet the first time (a few minutes).",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (_a, progress) => {
        const p = await ticking(progress, 'opening the wallet', openPlayer(progress));
        const { night, dust } = await p.balances();
        return { text: JSON.stringify({ address: p.address, tNight: Number(night) / 1e6, dust: (Number(dust) / 1e15).toFixed(2), limits: config.limits }, null, 2) };
      },
    },
    {
      name: 'lunardraw_buy_tickets',
      title: 'Buy Starfall tickets',
      description:
        "Buy Starfall tickets for the draw on sale, paid from this agent's own wallet (tNIGHT test tokens, no real value). " +
        'Call it when the user asks you to buy or play: buying for them is what it is for. Give games or package for QuickPick, ' +
        'or numbers (with moonball, system or pick) for a chosen entry; sweep plays every Moonball. Refused if it would pass the ' +
        "owner's spending limits. Takes 2-3 minutes (longer if the wallet isn't open yet).",
      inputSchema: BUY_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      run: async (args, progress) => {
        const entries = buyEntries(buyArgs(args));
        const p = await ticking(progress, 'opening the wallet', openPlayer(progress));
        const outcome = await ticking(progress, 'buying', p.buy(entries, progress));
        if (outcome.bought) void listingTick();
        return { text: JSON.stringify(outcome, null, 2), isError: outcome.bought < outcome.of };
      },
    },
    {
      name: 'lunardraw_my_tickets',
      title: "The agent's tickets",
      description: 'Every Starfall ticket this agent bought, with each draw\'s result and prize once it\'s out, and what it spent in the last 24 hours. Use it for "did I win?".',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async () => {
        ready();
        const state = loadAgentState(kitPaths(kitHome(), config.network).state);
        const view = state.purchases.length ? (await readOverview(config)).view : undefined;
        return { text: JSON.stringify(ticketsReport(state, view, Date.now()), null, 2) };
      },
    },
  ];
};
