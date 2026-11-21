/**
 * The agent kit on Starfall v2, the chain side: reading the game (no wallet needed), and buying
 * tickets and syndicate shares from the agent's open wallet, proved by Lunardraw's player prover.
 * The pure parts (formats, choices, limits, reports) are player-v2.ts.
 */
import { isStaleDustProof } from '@lunardraw/keeper';
import type { Session } from '@nightcast/deploy';
import { publicDataFor } from '../common.js';
import { DEFAULT_PROVER } from '../hosted-prover.js';
import { withFreshFees } from '../fresh-fees.js';
import { waitForTip } from '../sync-watch.js';
import { joinStarfallV2, loadStarfallV2, readV2Ledger, type StarfallV2, starfallV2HostedProviders, starfallV2ViewOf } from '../starfall-v2.js';
import { describeSavedTicket, packV2, savedTicketOf, saveV2AgentState, ticketGames } from '../starfall-v2-agent.js';
import { type KitConfig, limitsWhere, loadConfig, star, tNight } from './home.js';
import {
  formatText,
  gamesForChoice,
  kitV2Dir,
  type KitV2Record,
  kitV2StatePath,
  ledgerFormat,
  loadKitV2State,
  openSyndicatesOf,
  overLimits,
  overviewV2Of,
  readKitV2Record,
  type V2Choice,
  type V2Overview,
  v2SpentOnDraw,
  v2SpentSince,
} from './player-v2.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- the generated v2 module and its ledger are loaded at run time */

export type KitV2 = { record: KitV2Record; v2: StarfallV2 };

const loaded = new Map<string, Promise<KitV2>>();

/** The packed game, loaded once. */
export const loadKitV2 = (network: string): Promise<KitV2> => {
  let p = loaded.get(network);
  if (!p) {
    p = (async () => ({ record: readKitV2Record(network), v2: await loadStarfallV2(kitV2Dir(network)) }))();
    p.catch(() => loaded.delete(network));
    loaded.set(network, p);
  }
  return p;
};

/** The v2 ledger and the keeper's view of it (public data: no wallet, about a second). */
export const readV2 = async (network: string, publicData: unknown = publicDataFor(network as never)): Promise<{ k: KitV2; l: any; view: ReturnType<typeof starfallV2ViewOf> }> => {
  const k = await loadKitV2(network);
  const l = await readV2Ledger(k.v2.G, publicData as never, k.record.contractAddress);
  return { k, l, view: starfallV2ViewOf(k.v2.G, l) };
};

/** What's on in v2 right now. */
export const readOverviewV2 = async (config: Pick<KitConfig, 'network'>): Promise<{ overview: V2Overview } & Awaited<ReturnType<typeof readV2>>> => {
  const r = await readV2(config.network);
  const now = Date.now() / 1000;
  const selling = r.view.draws.find((d) => d.status === 0 && d.salesClose > BigInt(Math.floor(now)));
  const open = openSyndicatesOf(r.l, selling?.id, now).length;
  return { ...r, overview: overviewV2Of(r.view, config.network, r.k.record.contractAddress, now, open) };
};

/** The prover for v2 purchases: the kit has no v2 proving keys, so a local proof server can't prove them. */
export const v2Prover = (prover: string): string => {
  if (prover === 'hosted') return DEFAULT_PROVER;
  if (/^local:\d+$/.test(prover)) {
    throw new Error(
      'prover "local:<port>" can\'t prove Starfall purchases: the kit doesn\'t carry the Starfall proving keys (Lunardraw\'s prover holds them). ' +
        'Set "prover": "hosted" in config.json (Starfall Classic can still use your proof server).',
    );
  }
  return prover;
};

export type V2BuyOutcome = { game: 'Starfall'; draw: number; format: string; bought: number; of: number; games: number; cost: string; tickets: string[]; payTo: string; message?: string };
export type V2JoinOutcome = { game: 'Starfall'; syndicate: number; draw: number; shares: number; cost: string; member?: number; funded: boolean; payTo: string };

export type V2Player = {
  buy(choice: V2Choice, log?: (msg: string) => void): Promise<V2BuyOutcome>;
  join(syndicate: number, shares: number, log?: (msg: string) => void): Promise<V2JoinOutcome>;
};

type Deps = {
  session: Session;
  wallet: any;
  config: KitConfig;
  home?: string;
  /** The wallet's own address (refunds), and where prizes go (32 bytes each). */
  mine: Uint8Array;
  payTo: Uint8Array;
  payToText: string;
  /** tNIGHT and DUST now. */
  balances(): Promise<{ night: bigint; dust: bigint }>;
  /** What Classic spent in the last 24 hours (STAR), for the daily limit across both games. */
  classicToday(sinceMs: number): bigint;
  /** The kit's home (state-v2.json lives there). */
  homeDir: string;
};

/** A v2 player on an open wallet: its providers prove with the player prover; fees as the kit's Classic purchases pay them. */
export const v2Player = async (d: Deps): Promise<V2Player> => {
  const k = await loadKitV2(d.config.network);
  const { record, v2 } = k;
  const log0 = (m: string) => d.session.logger.info(m);
  const raw = starfallV2HostedProviders(d.session, d.wallet, v2, record.treasuryAddress, v2Prover(d.config.prover), {
    onWait: (status, secs) => log0(`the prover is ${status === 429 ? 'limiting this address' : 'busy'}; trying again in ${secs} s`),
  });
  const providers = withFreshFees(raw as any, {
    beforeBalance: () => waitForTip(d.wallet, { logger: d.session.logger, timeoutMs: 120_000 }),
    isStale: isStaleDustProof,
    logger: d.session.logger,
  }) as typeof raw;
  let joining: ReturnType<typeof joinStarfallV2> | undefined;
  const contract = () =>
    (joining ??= joinStarfallV2(providers, v2, record.contractAddress, {}).catch((err: unknown) => {
      joining = undefined;
      throw err;
    }));
  const store = () => (providers.privateStateProvider as unknown as { forContract(a: string): { set(id: string, s: unknown): Promise<void> } }).forContract(record.contractAddress);
  const statePath = kitV2StatePath(d.homeDir);
  const game = { bytes: Uint8Array.from(Buffer.from(record.contractAddress, 'hex')) };
  const ledger = () => readV2Ledger(v2.G, providers.publicDataProvider as never, record.contractAddress);
  const limits = () => {
    try {
      return loadConfig(d.home).limits;
    } catch {
      return d.config.limits;
    }
  };
  const where = () => limitsWhere(d.config, d.home);
  /** Refuse what's over the limits, or more than the wallet holds. */
  const afford = async (draw: bigint, cost: bigint) => {
    const s = loadKitV2State(statePath, record.contractAddress);
    const since = Date.now() - 24 * 3600_000;
    const l = limits();
    const over = overLimits({ draw, inDraw: v2SpentOnDraw(s, draw), today: v2SpentSince(s, since) + d.classicToday(since), cost, perDraw: star(l.perDraw), perDay: star(l.perDay) });
    if (over) throw new Error(`not buying: ${over}. The owner can change the limits ${where()}.`);
    const { night, dust } = await d.balances();
    if (night < cost) throw new Error(`that costs ${tNight(cost)} but the wallet holds ${tNight(night)}: get more from the faucet`);
    if (dust <= 0n) throw new Error('the wallet has no DUST yet to pay the fee (it builds up a few minutes after tNIGHT arrives)');
  };

  return {
    async buy(choice, log) {
      const l = await ledger();
      const view = starfallV2ViewOf(v2.G, l);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const selling = view.draws.find((x) => x.status === 0 && x.salesClose > now + 180n);
      if (!selling) throw new Error('no Starfall draw is on sale right now (or sales close within 3 minutes): try again when the next one opens');
      const f = ledgerFormat(l, selling.id)!;
      const games = gamesForChoice(choice, f);
      const txs = packV2(v2.G, selling.id, games, d.payTo, f);
      const count = txs.flat().reduce((a: number, t) => a + ticketGames(v2.G, t, f), 0);
      const cost = view.ticketPrice * BigInt(count);
      await afford(selling.id, cost);
      const tickets = txs.flat().length;
      const room = view.maxTicketsPerDraw > selling.tickets ? view.maxTicketsPerDraw - selling.tickets : 0n;
      if (BigInt(tickets) > room) throw new Error(`draw ${selling.id} is full: room for ${room} more ticket(s), this needs ${tickets}`);
      log?.(`buying ${count} game(s) in ${tickets} ticket(s) for draw ${selling.id} (${f.range} numbers${f.moonballs > 1 ? `, Moonball 1-${f.moonballs}` : ''}; sales close ${new Date(Number(selling.salesClose) * 1000).toISOString()}) for ${tNight(cost)}`);
      const c = await contract();
      const landed = async (t: unknown) => (await ledger()).ticketCommitments.member(v2.G.pureCircuits.ticketCommitment(game, t)) as boolean;
      let done = 0;
      let message: string | undefined;
      const bought: unknown[] = [];
      for (const batch of txs) {
        if (Date.now() / 1000 > Number(selling.salesClose) - 120) {
          message = 'sales close too soon for the rest';
          break;
        }
        await store().set('starfall-v2', { pendingTickets: batch });
        try {
          await c.callTx.buyTickets(BigInt(batch.length), { bytes: d.mine });
        } catch (err) {
          // a purchase that timed out may still have landed: never buy the same games twice
          if (!(await landed(batch[0]).catch(() => false))) {
            if (done === 0) throw err;
            message = err instanceof Error ? err.message.slice(0, 300) : String(err);
            break;
          }
        }
        done += 1;
        bought.push(...batch);
        if (txs.length > 1) log?.(`transaction ${done} of ${txs.length} landed`);
      }
      const boughtGames = bought.reduce((a: number, t) => a + ticketGames(v2.G, t, f), 0);
      const saved = bought.map(savedTicketOf);
      if (done > 0) {
        const fresh = loadKitV2State(statePath, record.contractAddress); // re-read: another command may have written it meanwhile
        fresh.purchases.push({
          draw: selling.id.toString(),
          at: new Date().toISOString(),
          games: boughtGames,
          cost: (view.ticketPrice * BigInt(boughtGames)).toString(),
          txs: done,
          numbers: saved.map((t) => t.numbers),
          tickets: saved,
        });
        saveV2AgentState(statePath, fresh);
      }
      return {
        game: 'Starfall',
        draw: Number(selling.id),
        format: formatText(f),
        bought: bought.length,
        of: tickets,
        games: boughtGames,
        cost: tNight(view.ticketPrice * BigInt(boughtGames)),
        tickets: saved.map((t) => describeSavedTicket(t, f)),
        payTo: d.payToText,
        ...(message ? { message } : {}),
      };
    },

    async join(syndicate, shares, log) {
      if (!(Number.isInteger(syndicate) && syndicate >= 0)) throw new Error('syndicate: its number, from lunardraw_syndicates');
      if (!(Number.isInteger(shares) && shares >= 1)) throw new Error('shares: 1 or more');
      const l = await ledger();
      const id = BigInt(syndicate);
      if (!l.syndicates.member(id)) throw new Error(`there's no syndicate ${syndicate}: lunardraw_syndicates lists the open ones`);
      const sy = l.syndicates.lookup(id);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (Number(sy.status) !== 0) throw new Error(`syndicate ${syndicate} is already funded (every share is sold)`);
      if (BigInt(sy.joinDeadline) <= now + 180n) throw new Error(`syndicate ${syndicate}'s join deadline has passed (or is within 3 minutes)`);
      const left = Number(sy.totalShares) - Number(sy.sold);
      if (shares > left) throw new Error(`syndicate ${syndicate} has ${left} share(s) left`);
      const cost = BigInt(sy.sharePrice) * BigInt(shares);
      await afford(BigInt(sy.drawId), cost);
      log?.(`joining syndicate ${syndicate} (draw ${sy.drawId}): ${shares} share(s) for ${tNight(cost)}`);
      const c = await contract();
      const r = await c.callTx.joinSyndicate(id, BigInt(shares), { bytes: d.payTo });
      const member = r?.private?.result === undefined ? undefined : Number(r.private.result as bigint);
      const fresh = loadKitV2State(statePath, record.contractAddress);
      fresh.syndicates.push({ syndicate: String(syndicate), draw: String(sy.drawId), at: new Date().toISOString(), shares, cost: cost.toString(), ...(member !== undefined ? { member } : {}) });
      saveV2AgentState(statePath, fresh);
      const after = (await ledger().catch(() => undefined))?.syndicates.lookup(id);
      return {
        game: 'Starfall',
        syndicate,
        draw: Number(sy.drawId),
        shares,
        cost: tNight(cost),
        ...(member !== undefined ? { member } : {}),
        funded: after ? Number(after.status) === 1 : false,
        payTo: d.payToText,
      };
    },
  };
};
