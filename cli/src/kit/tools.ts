/**
 * The MCP server's tools. The wallet is opened once, when the server starts,
 * and kept open while it runs (opening takes a few minutes; a purchase 2-3).
 */
import { Starfall } from '@lunardraw/contract';
import { loadAgentState } from '../starfall-agent.js';
import { buyEntries } from '../starfall-commands.js';
import { ensureWallet, hasBlockfrost, kitHome, kitPaths, limitsWhere, loadConfig, tNight, useHome } from './home.js';
import { readStarfallRecord } from '../starfall.js';
import { deploymentWatch, outdatedText } from './freshness.js';
import { buyArgs, type Tool } from './mcp.js';
import { toolDef } from './tool-defs.js';
import { refreshListing } from './directory.js';
import { walletAddressOf } from '@nightcast/deploy';
import { type OpenHooks, type Player, readOverview, ticketsReport, withPlayer } from './player.js';
import { FAUCET, syncFraction } from './setup.js';

const DIVISIONS = ['7 + Moonball', '7', '6 + Moonball', '6', '5 + Moonball', '4 + Moonball', '5', '3 + Moonball', '2 + Moonball'];

/**
 * `answerMs`: how long a slow tool (buying, opening the wallet) waits before
 * answering "on its way" (AI apps give up on a tool call after about a minute);
 * Infinity waits until it's done (the library).
 */
export const mcpTools = (o: { answerMs?: number } = {}): Tool[] => {
  const config = loadConfig();
  useHome(config);
  /** The config as it is now: the owner may change the limits while the agent runs. */
  const current = () => {
    try {
      return loadConfig();
    } catch {
      return config;
    }
  };
  // whether the contract packed in this kit is still Starfall's (freshness.ts)
  const fresh = deploymentWatch(() => readStarfallRecord(config.network).contractAddress, config.network);
  /** The price of a game and its split, from the packed deployment record. */
  const priceText = (): string => {
    try {
      const p = (readStarfallRecord(config.network) as unknown as { parameters?: { ticketPrice?: string; feePerGame?: string } }).parameters ?? {};
      const price = BigInt(p.ticketPrice ?? '0');
      const fee = BigInt(p.feePerGame ?? '0');
      if (price > 0n) return `${tNight(price)} a game (${tNight(price - fee)} to the prize pool, ${tNight(fee)} operator fee)`;
    } catch {
      /* no record: say it without the number */
    }
    return 'about 1 tNIGHT a game (lunardraw_draw_on_sale gives the exact price)';
  };
  const ready = () => {
    if (!hasBlockfrost(kitHome(), config.network)) {
      throw new Error(
        'The agent has no Blockfrost project id yet (a free key that lets it read Midnight Preprod). The owner gets one at https://blockfrost.io ' +
          '(Add project, network "Midnight Preprod", copy the Project ID) and puts it in the Lunardraw extension\'s settings in Claude ' +
          '(Settings, Extensions, Lunardraw, Configure), or runs `lunardraw-agent setup` in a terminal.',
      );
    }
  };

  // How far the wallet is from ready, for answers while it opens (a new wallet's first sync takes hours)
  type Stage = { phase: 'opening' | 'syncing' | 'waiting for tNIGHT' | 'waiting for DUST' | 'ready'; synced?: number };
  let stage: Stage = { phase: 'opening' };
  const hooks: OpenHooks = {
    onWallet: (w) => {
      stage = { phase: 'syncing', synced: 0 };
      const sub = w.wallet.state().subscribe((s: unknown) => {
        if (stage.phase === 'syncing') stage = { phase: 'syncing', synced: syncFraction(s) };
      });
      void player?.finally(() => sub.unsubscribe()).catch(() => undefined);
    },
    onNoFunds: () => (stage = { phase: 'waiting for tNIGHT', synced: 1 }),
    onWaitingForDust: () => (stage = { phase: 'waiting for DUST', synced: 1 }),
  };
  /** What to tell the owner while the wallet isn't ready. */
  const notReady = (): Record<string, unknown> => {
    const address = walletAddressOf(config.network, ensureWallet().seed);
    const faucet = FAUCET[config.network];
    switch (stage.phase) {
      case 'syncing': {
        const pct = Math.floor((stage.synced ?? 0) * 100);
        return {
          address,
          status: `syncing with Midnight Preprod: ${pct}%`,
          note:
            pct < 95
              ? `A new wallet's first sync reads the whole Preprod chain and takes a few hours (it saves its progress; later starts take minutes). Nothing to do but wait and keep this app open. Meanwhile the owner can fund it: paste the address into ${faucet} and ask for tNIGHT (free test tokens).`
              : 'Catching up with the chain: a minute or two.',
        };
      }
      case 'waiting for tNIGHT':
        return { address, status: 'synced, waiting for tNIGHT', note: `The wallet holds no tNIGHT yet. The owner pastes the address into the faucet, ${faucet}, ticks the captcha and asks for tNIGHT (free, no value). The agent notices it arriving by itself.` };
      case 'waiting for DUST':
        return { address, status: 'got tNIGHT, waiting for DUST', note: 'It registered its tNIGHT for DUST, the token that pays the fees; the first DUST usually comes within a few minutes. Then it can buy.' };
      default:
        return { address, status: 'opening', note: 'The wallet is opening (a few minutes the first time in a session). Ask again in a minute.' };
    }
  };
  /** Not worth starting a purchase: the wallet is hours away, or has nothing to pay with. */
  const farFromReady = () => stage.phase === 'waiting for tNIGHT' || stage.phase === 'waiting for DUST' || (stage.phase === 'syncing' && (stage.synced ?? 0) < 0.95);

  // one wallet for the server's life, opened when first needed
  let player: Promise<Player> | undefined;
  let release: () => void = () => undefined;
  const openPlayer = (progress: (m: string) => void): Promise<Player> => {
    ready();
    if (!player) {
      progress('opening the wallet (a few minutes)');
      player = new Promise<Player>((resolve, reject) => {
        withPlayer(
          config,
          ensureWallet().seed,
          (p) => {
            stage = { phase: 'ready', synced: 1 };
            resolve(p);
            return new Promise<void>((done) => (release = done));
          },
          undefined,
          hooks,
        ).catch((err) => {
          stage = { phase: 'opening' };
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

  // A purchase takes 2-3 minutes, but many AI apps give up on a tool call after
  // about a minute (Claude reaching a computer's tools: 60 s, seen 5 Nov 2026).
  // So the buy tool answers within ANSWER_MS and, if the purchase isn't done
  // by then, carries on in the background; my_tickets says how it's going.
  const answerMs = o.answerMs ?? Number(process.env.LUNARDRAW_AGENT_ANSWER_MS ?? 45_000);
  // (setTimeout can't wait forever: a longer wait than about 24 days fires at once)
  const lateAfter = <T>(late: T) => new Promise<T>((r) => (Number.isFinite(answerMs) && answerMs < 2 ** 31 ? setTimeout(() => r(late), answerMs).unref?.() : undefined));
  type Purchase = { started: string; games: number; state: 'buying' | 'done' | 'failed'; outcome?: unknown; error?: string };
  let purchase: Purchase | undefined;

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
      ...toolDef('lunardraw_how_to_play'),
      run: async () => ({
        text: [
          'Starfall: a lottery on the Midnight Preprod test network (tNIGHT test tokens, no real value).',
          `A game: 7 numbers from 1-35 and a Moonball from 1-20. ${priceText()}.`,
          'lunardraw_draw_on_sale says when the draw on sale closes. Numbers come from Nightcast verifiable randomness; anyone can check every draw.',
          `Prize divisions: ${DIVISIONS.map((d, i) => `${i + 1}: ${d}`).join('; ')}. Division 1 odds are about 1 in 134 million.`,
          'Entries: QuickPick games or packages (' + Object.entries(Starfall.QUICK_PICK_PACKAGES).map(([k, v]) => `${k} ${v}`).join(', ') + '), your own numbers, a System (8-12 numbers, every 7 of them), a Pick (5 or 6 numbers completed every way), and Moonball Sweep (every Moonball, 20 times the games).',
          'Prizes and refunds (if a draw is cancelled) are paid to the wallet automatically. Nothing to claim.',
          `Spending limits set by the owner: ${current().limits.perDraw} tNIGHT a draw, ${current().limits.perDay} tNIGHT in any 24 hours. They can't be changed from here; the owner sets them ${limitsWhere(current())}.`,
        ].join('\n'),
      }),
    },
    {
      ...toolDef('lunardraw_draw_on_sale'),
      run: async () => {
        ready();
        const [{ overview }, f] = await Promise.all([readOverview(config), fresh()]);
        const notice = f.state === 'outdated' ? { notice: outdatedText(f) } : {};
        return { text: JSON.stringify({ game: "Starfall, Lunardraw's lottery on the Midnight Preprod test network", ...notice, ...overview }, null, 2) };
      },
    },
    {
      ...toolDef('lunardraw_wallet'),
      run: async (_a, progress) => {
        // answer within ANSWER_MS too: opening the wallet can take minutes, and AI apps give up long before
        const opening = openPlayer(progress);
        const late = Symbol('late');
        const first = await ticking(progress, 'opening the wallet', Promise.race([opening, lateAfter(late)]));
        if (first === late) return { text: JSON.stringify({ ...notReady(), limits: current().limits }, null, 2) };
        const p = first;
        const { night, dust } = await p.balances();
        return { text: JSON.stringify({ address: p.address, tNight: Number(night) / 1e6, dust: (Number(dust) / 1e15).toFixed(2), limits: current().limits }, null, 2) };
      },
    },
    {
      ...toolDef('lunardraw_buy_tickets'),
      run: async (args, progress) => {
        const entries = buyEntries(buyArgs(args));
        ready();
        const f = await fresh();
        if (f.state === 'outdated') {
          return { text: JSON.stringify({ status: 'not bought: this agent plays an old Starfall contract', note: outdatedText(f) }, null, 2), isError: true };
        }
        if (farFromReady()) {
          return { text: JSON.stringify({ status: 'not ready to buy yet: nothing was bought', ...notReady() }, null, 2), isError: true };
        }
        if (purchase?.state === 'buying') {
          return {
            text: JSON.stringify({ status: 'a purchase is already on its way', started: purchase.started, games: purchase.games, next: "Don't buy again yet: call lunardraw_my_tickets in a minute or two to see it land." }, null, 2),
          };
        }
        const games = entries.reduce((n, e) => n + Starfall.gamesOf(e), 0);
        const mine: Purchase = { started: new Date().toISOString(), games, state: 'buying' };
        purchase = mine;
        let answered = false;
        const tell = (m: string) => {
          if (!answered) progress(m);
        };
        const work = (async () => {
          const p = await ticking(tell, 'opening the wallet', openPlayer(tell));
          return ticking(tell, 'buying', p.buy(entries, tell));
        })();
        work.then(
          (outcome) => {
            Object.assign(mine, { state: outcome.bought ? 'done' : 'failed', outcome });
            if (outcome.bought) void listingTick();
          },
          (err: unknown) => Object.assign(mine, { state: 'failed', error: err instanceof Error ? err.message : String(err) }),
        );
        const late = Symbol('late');
        const first = await Promise.race([work, lateAfter(late)]);
        answered = true;
        if (first === late) {
          return {
            text: JSON.stringify(
              {
                status: 'buying',
                games,
                note: "The purchase is on its way and finishes by itself (2-3 minutes in all). Don't buy again: call lunardraw_my_tickets in about 3 minutes to see the numbers.",
              },
              null,
              2,
            ),
          };
        }
        return { text: JSON.stringify(first, null, 2), isError: first.bought < first.of };
      },
    },
    {
      ...toolDef('lunardraw_my_tickets'),
      run: async () => {
        ready();
        const state = loadAgentState(kitPaths(kitHome(), config.network).state);
        const view = state.purchases.length ? (await readOverview(config)).view : undefined;
        const report = ticketsReport(state, view, Date.now());
        // a purchase still on its way (or how the last one ended), so nobody buys twice
        const latest = purchase && {
          purchase: {
            state: purchase.state,
            started: purchase.started,
            games: purchase.games,
            ...(purchase.error ? { error: purchase.error } : {}),
            ...(purchase.outcome ? { outcome: purchase.outcome } : {}),
            ...(purchase.state === 'buying' ? { note: 'still on its way: check again in a minute' } : {}),
          },
        };
        return { text: JSON.stringify({ ...latest, ...report }, null, 2) };
      },
    },
  ];
};
