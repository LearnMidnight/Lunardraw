/**
 * What the agent kit does on the chain: read the draws (no wallet needed),
 * open the agent's wallet, and buy within the owner's limits.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Starfall } from '@lunardraw/contract';
import { isStaleDustProof, type StarfallView } from '@lunardraw/keeper';
import { type Session, walletAddress, walletBalances } from '@nightcast/deploy';
import { buyerProviders, buyWithRetry, proverArg } from '../buyer.js';
import { publicDataFor, withSession } from '../common.js';
import { BuyStopped, joinStarfall, pendingReverter, readStarfallRecord, readStarfallView, type RevertableWallet, starfallZkConfigPath } from '../starfall.js';
import { type AgentState, describeResult, loadAgentState, type Result, saveAgentState, spentOnDraw, spentSince } from '../starfall-agent.js';
import { describeEntry, entriesBought, parseUserAddress } from '../starfall-commands.js';
import { openWallet } from '../wallet-lock.js';
import { declareFeesAtDustTime, type DustTimeWallet } from '../dust-time.js';
import { withFreshFees } from '../fresh-fees.js';
import { waitForTip } from '../sync-watch.js';
import { type KitConfig, kitPaths, limitsWhere, loadConfig, star, tNight } from './home.js';

const { DrawStatus } = Starfall;
const iso = (secs: bigint) => new Date(Number(secs) * 1000).toISOString();

export type DrawOnSale = { draw: number; salesClose: string; minutesLeft: number; tickets: number; games: number; jackpotEstimate: string };
export type DrawResult = { draw: number; status: 'drawn' | 'settled' | 'void'; numbers?: number[]; moonball?: number; games: number; winningGames?: number };

export type Overview = {
  network: string;
  contract: string;
  gamePrice: string;
  onSale: DrawOnSale | null;
  /** The carried-over jackpot (Division 1 rollover) going into the next draw. */
  rollover: string;
  recent: DrawResult[];
};

/** What's on sale and the latest results, from a view of the contract. */
export const overviewOf = (view: StarfallView, network: string, contract: string, nowSecs: number): Overview => {
  const selling = view.draws.find((d) => d.status === DrawStatus.open && d.salesClose > BigInt(Math.floor(nowSecs)));
  const pool = (games: bigint) => games * (view.ticketPrice - view.feePerGame);
  const onSale: DrawOnSale | null = selling
    ? {
        draw: Number(selling.id),
        salesClose: iso(selling.salesClose),
        minutesLeft: Math.floor((Number(selling.salesClose) - nowSecs) / 60),
        tickets: Number(selling.tickets),
        games: Number(selling.games),
        // Division 1's share of this draw's pool plus the rollover, if nobody else buys
        jackpotEstimate: tNight(view.carry + (pool(selling.games) * BigInt(Starfall.POWERBALL_SHARES_BP[0])) / 10_000n),
      }
    : null;
  const recent: DrawResult[] = [...view.draws]
    .filter((d) => d.status === DrawStatus.drawn || d.status === DrawStatus.settled || d.status === DrawStatus.voided)
    .sort((a, b) => Number(b.id - a.id))
    .slice(0, 5)
    .map((d) =>
      d.status === DrawStatus.voided
        ? { draw: Number(d.id), status: 'void' as const, games: Number(d.games) }
        : {
            draw: Number(d.id),
            status: d.status === DrawStatus.settled ? ('settled' as const) : ('drawn' as const),
            numbers: d.numbers,
            moonball: d.moonball,
            games: Number(d.games),
            winningGames: d.winners.reduce((a, w) => a + Number(w), 0),
          },
    );
  return { network, contract, gamePrice: tNight(view.ticketPrice), onSale, rollover: tNight(view.carry), recent };
};

/** Read the draws from the chain (public data: no wallet, about a second). */
export const readOverview = async (config: KitConfig): Promise<{ overview: Overview; view: StarfallView }> => {
  const record = readStarfallRecord(config.network);
  const view = await readStarfallView(publicDataFor(config.network), record.contractAddress);
  return { overview: overviewOf(view, config.network, record.contractAddress, Date.now() / 1000), view };
};

/** Whether a purchase of `cost` for `draw` fits the owner's limits; the reason if not. */
export const checkLimits = (state: AgentState, config: KitConfig, draw: bigint, cost: bigint, nowMs: number): string | undefined => {
  const perDraw = star(config.limits.perDraw);
  const perDay = star(config.limits.perDay);
  const inDraw = spentOnDraw(state, draw);
  if (inDraw + cost > perDraw) {
    return `that would make ${tNight(inDraw + cost)} in draw ${draw}, over the owner's limit of ${tNight(perDraw)} a draw${inDraw ? ` (${tNight(inDraw)} already spent on it)` : ''}`;
  }
  const today = spentSince(state, nowMs - 24 * 3600_000);
  if (today + cost > perDay) return `that would make ${tNight(today + cost)} in 24 hours, over the owner's limit of ${tNight(perDay)} a day (${tNight(today)} spent so far)`;
  return undefined;
};

export type TicketsReport = {
  purchases: { draw: number; at: string; games: number; cost: string; tickets: string[]; result?: string }[];
  spentLast24h: string;
};

/** What this agent bought, with each draw's result where it's out. */
export const ticketsReport = (state: AgentState, view: StarfallView | undefined, nowMs: number): TicketsReport => {
  const resultOf = (draw: string): string | undefined => {
    const d = view?.draws.find((x) => x.id.toString() === draw);
    if (!d) return undefined;
    if (d.status === DrawStatus.voided) return 'cancelled: the games are refunded to this wallet';
    if (d.status !== DrawStatus.drawn && d.status !== DrawStatus.settled) return 'waiting for the draw';
    const won = Array.from({ length: 9 }, () => 0n);
    for (const p of state.purchases.filter((x) => x.draw === draw)) {
      for (const e of p.entries) Starfall.gamesByDivisionFor(e, d.numbers, d.moonball).forEach((n, i) => (won[i] += n));
    }
    const r: Result = {
      draw: d.id,
      numbers: d.numbers,
      moonball: d.moonball,
      games: state.purchases.filter((x) => x.draw === draw).reduce((a, p) => a + p.games, 0),
      won: won.map((n, i) => ({ division: i + 1, games: Number(n) })).filter((w) => w.games > 0),
    };
    return `${d.numbers.join(' ')} + ${d.moonball}: ${describeResult(r)}${r.won.length ? '; the prize is paid to the payout address automatically' : ''}`;
  };
  return {
    purchases: [...state.purchases]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((p) => ({ draw: Number(p.draw), at: p.at, games: p.games, cost: tNight(BigInt(p.cost)), tickets: p.entries.map(describeEntry), result: resultOf(p.draw) })),
    spentLast24h: tNight(spentSince(state, nowMs - 24 * 3600_000)),
  };
};

/** A wallet opened for buying, with what's needed to buy. */
export type Player = {
  session: Session;
  address: string;
  balances(): Promise<{ night: bigint; dust: bigint }>;
  buy(entries: Starfall.PlainEntry[], log?: (msg: string) => void): Promise<BuyOutcome>;
};

export type BuyOutcome = { draw: number; bought: number; of: number; games: number; cost: string; tickets: string[]; payTo: string; message?: string };

const localPort = (prover: string): number | undefined => (/^local:(\d+)$/.exec(prover) ? Number(/^local:(\d+)$/.exec(prover)![1]) : undefined);

/**
 * Proving on your own proof server needs buyTickets' proving key, which the
 * npm package leaves out to stay small (the hosted prover holds it).
 */
export const requireLocalProvingKey = (dir = starfallZkConfigPath()): void => {
  if (!existsSync(join(dir, 'keys', 'buyTickets.prover'))) {
    throw new Error(
      'prover "local:<port>" needs the Starfall contract\'s buyTickets proving key, which the npm package leaves out to stay small. ' +
        'Set "prover": "hosted" in config.json, or run the kit from a Lunardraw checkout (npm run compact:starfall && npm run build), ' +
        'or point LUNARDRAW_STARFALL_ZK_CONFIG_PATH at a compiled contract with its keys.',
    );
  }
};

/**
 * Open the agent's wallet (a few minutes from its saved state; a new wallet's
 * first sync takes hours on Preprod) and run `fn` with it. Buying checks the
 * owner's limits first and records each purchase in state.json.
 */
/** What the opening wallet says on the way: its object (to watch the sync), waiting for tNIGHT, waiting for DUST. */
export type OpenHooks = Pick<NonNullable<Parameters<typeof openWallet>[1]>, 'onWallet' | 'onNoFunds' | 'onWaitingForDust'>;

export const withPlayer = async <T>(config: KitConfig, seed: string, fn: (p: Player) => Promise<T>, home?: string, hooks: OpenHooks = {}): Promise<T> => {
  const record = readStarfallRecord(config.network);
  const statePath = kitPaths(home, config.network).state;
  const port = localPort(config.prover);
  if (port !== undefined) requireLocalProvingKey();
  const prover = port === undefined ? proverArg(config.prover) : undefined;
  return withSession(
    config.network,
    async (session) => {
      const wallet = await openWallet(session, { seed, ...hooks });
      // The keeper's fee fixes, for the kit too: declare each fee at the time
      // of the wallet's DUST view (dust-time.ts), wait for the wallet to reach
      // the tip before paying it, and pay again from the same proof if the
      // node calls the fee proof stale (1010 custom error 170, fresh-fees.ts).
      declareFeesAtDustTime(wallet as unknown as DustTimeWallet, session.logger);
      try {
        const providers = withFreshFees(buyerProviders(session, wallet, prover), {
          beforeBalance: () => waitForTip(wallet, { logger: session.logger, timeoutMs: 120_000 }),
          isStale: isStaleDustProof,
          logger: session.logger,
        });
        const mine = Buffer.from((wallet as unknown as { unshieldedKeystore: { getAddress(): string } }).unshieldedKeystore.getAddress(), 'hex');
        const payTo = config.payTo ? parseUserAddress(config.payTo) : new Uint8Array(mine);
        let joined: Awaited<ReturnType<typeof joinStarfall>> | undefined;
        const player: Player = {
          session,
          address: walletAddress(wallet),
          balances: () => walletBalances(wallet),
          async buy(entries, log) {
            const view = await readStarfallView(providers.publicDataProvider, record.contractAddress);
            const now = BigInt(Math.floor(Date.now() / 1000));
            const selling = view.draws.find((d) => d.status === DrawStatus.open && d.salesClose > now + 180n);
            if (!selling) throw new Error('no draw is on sale right now (or sales close within 3 minutes): try again when the next one opens');
            const games = entries.reduce((a, e) => a + Starfall.gamesOf(e), 0);
            const cost = view.ticketPrice * BigInt(games);
            const state = loadAgentState(statePath);
            // the limits as they are now: the owner may have changed them since the wallet opened
            const current = (() => {
              try {
                return loadConfig(home);
              } catch {
                return config;
              }
            })();
            const over = checkLimits(state, current, selling.id, cost, Date.now());
            if (over) throw new Error(`not buying: ${over}. The owner can change the limits ${limitsWhere(current, home)}.`);
            const { night, dust } = await walletBalances(wallet);
            if (night < cost) throw new Error(`${games} game(s) cost ${tNight(cost)} but the wallet holds ${tNight(night)}: get more from the faucet`);
            if (dust <= 0n) throw new Error('the wallet has no DUST yet to pay the fee (it builds up a few minutes after tNIGHT arrives)');
            joined ??= await joinStarfall(providers, record.contractAddress, {});
            const tickets = Starfall.ticketsFor(selling.id, entries, payTo);
            const room = view.maxTicketsPerDraw > selling.tickets ? view.maxTicketsPerDraw - selling.tickets : 0n;
            if (BigInt(tickets.length) > room) throw new Error(`draw ${selling.id} is full: room for ${room} more ticket(s), this needs ${tickets.length}; try the next draw`);
            log?.(`buying ${tickets.length} ticket(s), ${games} game(s), for draw ${selling.id} (sales close ${iso(selling.salesClose)}) for ${tNight(cost)}`);
            let bought = tickets.length;
            let message: string | undefined;
            let txs = 0;
            try {
              ({ txs } = await buyWithRetry(joined, providers, record.contractAddress, tickets, new Uint8Array(mine), selling.salesClose, {
                log,
                timeoutMs: 8 * 60_000,
                onNotLanded: pendingReverter(wallet.wallet as unknown as RevertableWallet, log),
              }));
            } catch (err) {
              if (!(err instanceof BuyStopped)) throw err;
              bought = err.bought;
              message = err.message;
              txs = Math.ceil(err.bought / Number(Starfall.pureCircuits.maxTickets()));
            }
            const done = entriesBought(tickets, bought);
            const doneGames = done.reduce((a, e) => a + Starfall.gamesOf(e), 0);
            if (bought > 0) {
              const fresh = loadAgentState(statePath); // re-read: another command may have written it meanwhile
              fresh.purchases.push({ draw: selling.id.toString(), at: new Date().toISOString(), entries: done, games: doneGames, cost: (view.ticketPrice * BigInt(doneGames)).toString(), txs });
              saveAgentState(statePath, fresh);
            }
            return {
              draw: Number(selling.id),
              bought,
              of: tickets.length,
              games: doneGames,
              cost: tNight(view.ticketPrice * BigInt(doneGames)),
              tickets: done.map(describeEntry),
              payTo: config.payTo ?? walletAddress(wallet),
              message,
            };
          },
        };
        return await fn(player);
      } finally {
        await wallet.stop().catch(() => undefined);
      }
    },
    port,
    prover,
  );
};

/**
 * Open the wallet and wait until it's ready to buy: synced, holding tNIGHT,
 * with DUST for fees. For `setup`: reports the sync as a fraction (0 to 1)
 * and when it starts waiting for funds or DUST. Then closes it.
 */
export const syncWallet = async (
  config: KitConfig,
  seed: string,
  on: { onProgress?: (fraction: number) => void; onPhase?: (phase: 'no-funds' | 'dust') => void } = {},
): Promise<{ address: string; night: bigint; dust: bigint }> => {
  const { syncFraction } = await import('./setup.js');
  const port = localPort(config.prover);
  const prover = port === undefined ? proverArg(config.prover) : undefined;
  return withSession(
    config.network,
    async (session) => {
      let sub: { unsubscribe(): void } | undefined;
      const wallet = await openWallet(session, {
        seed,
        onWallet: (w) => {
          sub = w.wallet.state().subscribe((s) => on.onProgress?.(syncFraction(s)));
        },
        onNoFunds: () => on.onPhase?.('no-funds'),
        onWaitingForDust: () => on.onPhase?.('dust'),
      });
      try {
        sub?.unsubscribe();
        on.onProgress?.(1);
        // Registering new tNIGHT for DUST spends and remakes its coin, so for a
        // minute or two the balance reads 0: wait for it to show again.
        let { night, dust } = await walletBalances(wallet);
        for (let i = 0; night === 0n && i < 24; i++) {
          await new Promise((r) => setTimeout(r, 5_000));
          ({ night, dust } = await walletBalances(wallet));
        }
        return { address: walletAddress(wallet), night, dust };
      } finally {
        sub?.unsubscribe();
        await wallet.stop().catch(() => undefined);
      }
    },
    port,
    prover,
  );
};
