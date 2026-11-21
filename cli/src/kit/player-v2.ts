/**
 * The agent kit on Starfall v2 (Lunardraw's main game since 19 Nov 2026), the parts that need no
 * chain: where the packed game is, what's on sale, turning a request into games in the draw's
 * format, the owner's limits, and what the agent bought and won. The chain side is v2-chain.ts.
 *
 * The kit packs the deployed game (cli/game-v2/<network>/: the generated code, the verifier keys
 * and record.json with its address), so it can read the ledger and build tickets itself. Proofs
 * come from Lunardraw's player prover, which holds the proving keys of the circuits a player uses
 * (buyTickets, joinSyndicate, createSyndicate, buySyndicateTickets).
 *
 * Every draw has its own format: 7 numbers from 1-20 up to 1-45, with a Moonball from 1-2 up to
 * 1-20 on the bigger rungs (none below). The jackpot is fixed before a draw sells: Division 1 pays
 * what was carried in, and this draw's own sales build the next jackpot.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import type { StarfallView } from '@lunardraw/keeper';
import { describeSavedTicket, loadV2AgentState, type SavedV2Ticket, savedTicketWins, type V2AgentState, type V2Format, type V2Game } from '../starfall-v2-agent.js';
import { tNight } from './home.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- the generated v2 module and its ledger are loaded at run time */
type Module = any;

// ------------------------------------------------------------------ the packed game

/** The packed deployment: the game's and its Treasury's addresses. */
export type KitV2Record = { network: string; game?: string; contractAddress: string; treasuryAddress: string };

/** The packed game's folder (record.json, settlement/, treasury/): LUNARDRAW_KIT_V2_DIR, or cli/game-v2/<network>. */
export const kitV2Dir = (network: string, env: NodeJS.ProcessEnv = process.env): string =>
  env.LUNARDRAW_KIT_V2_DIR || fileURLToPath(new URL(`../../game-v2/${network}`, import.meta.url));

export const kitV2RecordPath = (network: string, env: NodeJS.ProcessEnv = process.env): string => join(kitV2Dir(network, env), 'record.json');

/** Whether this kit carries Starfall v2 for `network`. */
export const hasKitV2 = (network: string, env: NodeJS.ProcessEnv = process.env): boolean => existsSync(kitV2RecordPath(network, env));

export const readKitV2Record = (network: string, env: NodeJS.ProcessEnv = process.env): KitV2Record => {
  const path = kitV2RecordPath(network, env);
  if (!existsSync(path)) throw new Error(`this kit carries no Starfall v2 game for ${network} (${path})`);
  const r = JSON.parse(readFileSync(path, 'utf8')) as KitV2Record;
  if (!/^[0-9a-f]{64}$/i.test(r.contractAddress ?? '') || !/^[0-9a-f]{64}$/i.test(r.treasuryAddress ?? '')) throw new Error(`${path} has no game and Treasury address`);
  return r;
};

// ------------------------------------------------------------------ state

/** A syndicate share this agent bought. */
export type KitSyndicateShare = { syndicate: string; draw: string; at: string; shares: number; cost: string; member?: number };

/** What the agent did in v2 (state-v2.json): purchases as the house agents keep them, and its syndicate shares. */
export type KitV2State = V2AgentState & { syndicates: KitSyndicateShare[] };

export const kitV2StatePath = (home: string): string => join(home, 'state-v2.json');

export const loadKitV2State = (path: string, contract: string): KitV2State => {
  const s = loadV2AgentState(path, contract) as Partial<KitV2State> & V2AgentState;
  return { ...s, syndicates: Array.isArray(s.syndicates) ? s.syndicates : [] };
};

/** What the agent spent on v2 draw `draw` (tickets and syndicate shares). */
export const v2SpentOnDraw = (s: KitV2State, draw: bigint): bigint =>
  [...s.purchases, ...s.syndicates].filter((p) => p.draw === draw.toString()).reduce((a, p) => a + BigInt(p.cost), 0n);

/** What the agent spent on v2 since `sinceMs`. */
export const v2SpentSince = (s: KitV2State, sinceMs: number): bigint =>
  [...s.purchases, ...s.syndicates].filter((p) => Date.parse(p.at) >= sinceMs).reduce((a, p) => a + BigInt(p.cost), 0n);

/**
 * Whether spending `cost` more fits the owner's limits (STAR): `inDraw` already spent on this draw,
 * `today` in the last 24 hours across both games. The reason if not.
 */
export const overLimits = (o: { draw: bigint; inDraw: bigint; today: bigint; cost: bigint; perDraw: bigint; perDay: bigint }): string | undefined => {
  if (o.inDraw + o.cost > o.perDraw) {
    return `that would make ${tNight(o.inDraw + o.cost)} in draw ${o.draw}, over the owner's limit of ${tNight(o.perDraw)} a draw${o.inDraw ? ` (${tNight(o.inDraw)} already spent on it)` : ''}`;
  }
  if (o.today + o.cost > o.perDay) return `that would make ${tNight(o.today + o.cost)} in 24 hours, over the owner's limit of ${tNight(o.perDay)} a day (${tNight(o.today)} spent so far)`;
  return undefined;
};

// ------------------------------------------------------------------ formats and choices

/** A draw's format in words: "7 numbers from 1-20, no Moonball". */
export const formatText = (f: { range: number; moonballs: number }): string =>
  `7 numbers from 1-${f.range}${f.moonballs > 1 ? ` and a Moonball from 1-${f.moonballs}` : ', no Moonball'}`;

/** A draw's format from the ledger (with pick5, which the prize circuits need), or undefined. */
export const ledgerFormat = (l: any, drawId: bigint): V2Format | undefined => {
  if (!l?.draws?.member(drawId)) return undefined;
  const r = l.draws.lookup(drawId);
  return { range: Number(r.format.range), moonballs: Number(r.format.moonballs), pick5: BigInt(r.format.pick5) };
};

/** Which game a buy is for: Starfall (v2) unless `classic` is asked for, or the kit carries no v2. */
export const gameOf = (a: Record<string, unknown>, hasV2: boolean): 'starfall' | 'classic' => {
  const g = a.game === undefined || a.game === null || a.game === '' ? 'starfall' : String(a.game).toLowerCase();
  if (g !== 'starfall' && g !== 'classic' && g !== 'v2' && g !== 'starfall-v2') throw new Error(`game must be 'starfall' or 'classic', not ${String(a.game)}`);
  if (g === 'classic') return 'classic';
  if (!hasV2) throw new Error("this kit carries only Starfall Classic: update it (npm install -g @lunardraw/agent) to play Starfall");
  return 'starfall';
};

/** What to buy in v2, as the buy tool takes it. */
export type V2Choice = { games?: number; numbers?: number[]; moonball?: number; pick?: boolean; sweep?: boolean };

/** The buy tool's arguments as a v2 choice (`package` is Classic's). */
export const v2ChoiceOf = (a: Record<string, unknown>): V2Choice => {
  if (a.package !== undefined) throw new Error('QuickPick packages are Starfall Classic\'s: for Starfall, give games (QuickPick games) or numbers');
  const int = (v: unknown, what: string): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${what} must be a whole number`);
    return n;
  };
  const numbers = Array.isArray(a.numbers)
    ? a.numbers.map(Number)
    : typeof a.numbers === 'string' && a.numbers.trim()
      ? a.numbers.split(/[\s,]+/).filter(Boolean).map(Number)
      : undefined;
  const games = int(a.games, 'games');
  const system = int(a.system, 'system');
  const pick = int(a.pick, 'pick');
  if (numbers && games !== undefined) throw new Error('give games (QuickPick) or numbers, not both');
  if (!numbers && games === undefined) throw new Error('give games (how many QuickPick games) or numbers (your own)');
  if (system !== undefined && numbers && numbers.length !== system) throw new Error(`a System ${system} takes ${system} numbers (you gave ${numbers.length})`);
  if (pick !== undefined && numbers && numbers.length !== pick) throw new Error(`a Pick ${pick} takes ${pick} numbers (you gave ${numbers.length})`);
  if ((system !== undefined || pick !== undefined) && !numbers) throw new Error('a System or a Pick needs its numbers');
  return {
    ...(games !== undefined ? { games } : {}),
    ...(numbers ? { numbers } : {}),
    ...(int(a.moonball, 'moonball') !== undefined ? { moonball: int(a.moonball, 'moonball') } : {}),
    ...(pick !== undefined ? { pick: true } : {}),
    ...(a.sweep === true || a.sweep === 'true' ? { sweep: true } : {}),
  };
};

const rand = (n: number): number => {
  const r = new Uint32Array(1);
  const lim = Math.floor(4_294_967_296 / n) * n;
  do webcrypto.getRandomValues(r);
  while (r[0]! >= lim);
  return r[0]! % n;
};

/** Most QuickPick games in one purchase (five tickets of 12, one transaction). */
export const MAX_V2_QUICKPICKS = 60;

/**
 * A choice as games in a draw's format: QuickPick games, or one entry of the agent's own numbers (7
 * a standard game, 8-12 a System, 5-6 a Pick) with its Moonball (random if not given) or Moonball
 * Sweep. Numbers outside the draw's range are refused, not moved.
 */
export const gamesForChoice = (c: V2Choice, f: { range: number; moonballs: number }, pick: (n: number) => number = rand): V2Game[] => {
  const mb = (): number => (f.moonballs > 1 ? pick(f.moonballs) + 1 : 1);
  const qp = (): V2Game => {
    const set = new Set<number>();
    while (set.size < 7) set.add(pick(f.range) + 1);
    return { numbers: [...set].sort((a, b) => a - b), moonball: mb() };
  };
  if (c.sweep && f.moonballs <= 1) throw new Error(`this draw has no Moonball (${formatText(f)}), so there's nothing to sweep`);
  if (c.moonball !== undefined && f.moonballs <= 1 && c.moonball !== 1) throw new Error(`this draw has no Moonball (${formatText(f)}): leave moonball out`);
  if (c.moonball !== undefined && f.moonballs > 1 && !(c.moonball >= 1 && c.moonball <= f.moonballs)) throw new Error(`this draw's Moonball is 1-${f.moonballs}`);
  if (!c.numbers) {
    const n = c.games ?? 1;
    if (!(n >= 1 && n <= MAX_V2_QUICKPICKS)) throw new Error(`1 to ${MAX_V2_QUICKPICKS} QuickPick games a purchase`);
    if (c.sweep) return Array.from({ length: n }, () => ({ numbers: qp().numbers, sweep: true }));
    return Array.from({ length: n }, qp);
  }
  const nums = c.numbers;
  if (nums.some((x) => !Number.isInteger(x) || x < 1 || x > f.range)) {
    throw new Error(`this draw's numbers are 1-${f.range} (${formatText(f)}): ${nums.filter((x) => !(Number.isInteger(x) && x >= 1 && x <= f.range)).join(', ')} isn't one`);
  }
  if (new Set(nums).size !== nums.length) throw new Error('each number once');
  if (c.pick ? !(nums.length === 5 || nums.length === 6) : !(nums.length >= 7 && nums.length <= 12)) {
    throw new Error(c.pick ? 'a Pick takes 5 or 6 numbers' : '7 numbers for a standard game, 8 to 12 for a System (or 5-6 with pick)');
  }
  const sorted = [...nums].sort((a, b) => a - b);
  return [{ numbers: sorted, ...(c.sweep ? { sweep: true } : { moonball: c.moonball ?? mb() }), ...(c.pick ? { pick: true } : {}) }];
};

// ------------------------------------------------------------------ what's on

export type V2DrawOnSale = {
  draw: number;
  salesClose: string;
  minutesLeft: number;
  /** This draw's format, in words, and as numbers. */
  format: string;
  range: number;
  moonballs: number;
  tickets: number;
  games: number;
  /** The jackpot (Division 1), fixed before the draw sells. */
  jackpot: string;
  /** Syndicates still taking members in this draw (lunardraw_syndicates lists them). */
  syndicatesOpen: number;
  final?: { note: string };
};

export type V2DrawResult = { draw: number; status: 'drawn' | 'settled' | 'void'; format?: string; numbers?: number[]; moonball?: number; games: number; winningGames?: number; jackpotWon?: boolean };

export type V2Overview = {
  game: 'Starfall';
  network: string;
  contract: string;
  gamePrice: string;
  onSale: V2DrawOnSale | null;
  /** The jackpot of the next draw so far (this draw's sales build it). */
  jackpot: string;
  ended?: true;
  recent: V2DrawResult[];
};

const iso = (secs: bigint) => new Date(Number(secs) * 1000).toISOString();
const OPEN = 0;
const DRAWN = 3;
const SETTLED = 4;
const VOIDED = 5;

/** What's on sale in v2 and the latest results, from the keeper's view of the ledger (starfallV2ViewOf). */
export const overviewV2Of = (view: StarfallView, network: string, contract: string, nowSecs: number, syndicatesOpen = 0): V2Overview => {
  const now = BigInt(Math.floor(nowSecs));
  const selling = view.draws.find((d) => d.status === OPEN && d.salesClose > now);
  const f = selling?.format ?? { range: 35, moonballs: 20 };
  const onSale: V2DrawOnSale | null = selling
    ? {
        draw: Number(selling.id),
        salesClose: iso(selling.salesClose),
        minutesLeft: Math.floor((Number(selling.salesClose) - nowSecs) / 60),
        format: formatText(f),
        range: f.range,
        moonballs: f.moonballs,
        tickets: Number(selling.tickets),
        games: Number(selling.games),
        jackpot: tNight(view.carry),
        syndicatesOpen,
        ...(selling.final
          ? { final: { note: 'This is the final draw of this game: its jackpot must be won (if nobody wins it, it falls to the next prize division with a winner). No draw opens after it.' } }
          : {}),
      }
    : null;
  const recent: V2DrawResult[] = [...view.draws]
    .filter((d) => d.status === DRAWN || d.status === SETTLED || d.status === VOIDED)
    .sort((a, b) => Number(b.id - a.id))
    .slice(0, 5)
    .map((d) =>
      d.status === VOIDED
        ? { draw: Number(d.id), status: 'void' as const, games: Number(d.games) }
        : {
            draw: Number(d.id),
            status: d.status === SETTLED ? ('settled' as const) : ('drawn' as const),
            ...(d.format ? { format: formatText(d.format) } : {}),
            numbers: d.numbers,
            ...(d.format && d.format.moonballs > 1 ? { moonball: d.moonball } : {}),
            games: Number(d.games),
            winningGames: d.winners.reduce((a, w) => a + Number(w), 0),
            jackpotWon: (d.winners[0] ?? 0n) > 0n,
          },
    );
  return { game: 'Starfall', network, contract, gamePrice: tNight(view.ticketPrice), onSale, jackpot: tNight(view.carry), ...(view.ended ? { ended: true as const } : {}), recent };
};

// ------------------------------------------------------------------ syndicates

export type OpenSyndicate = {
  syndicate: number;
  draw: number;
  /** One share's price, and how many are left of how many. */
  sharePrice: string;
  sharesLeft: number;
  totalShares: number;
  /** The games the syndicate buys once every share is sold. */
  games: number;
  members: number;
  joinDeadline: string;
  minutesLeft: number;
};

/** Syndicates in `drawId` still taking members (filling, before their join deadline), from the ledger. */
export const openSyndicatesOf = (l: { syndicates: Iterable<[bigint, any]> }, drawId: bigint | undefined, nowSecs: number): OpenSyndicate[] => {
  if (drawId === undefined) return [];
  const now = BigInt(Math.floor(nowSecs));
  const out: OpenSyndicate[] = [];
  for (const [id, sy] of l.syndicates) {
    if (BigInt(sy.drawId) !== drawId || Number(sy.status) !== 0 || BigInt(sy.joinDeadline) <= now) continue;
    out.push({
      syndicate: Number(id),
      draw: Number(sy.drawId),
      sharePrice: tNight(BigInt(sy.sharePrice)),
      sharesLeft: Number(sy.totalShares) - Number(sy.sold),
      totalShares: Number(sy.totalShares),
      games: Number(sy.games),
      members: Number(sy.members),
      joinDeadline: iso(BigInt(sy.joinDeadline)),
      minutesLeft: Math.floor((Number(sy.joinDeadline) - nowSecs) / 60),
    });
  }
  return out.sort((a, b) => a.syndicate - b.syndicate);
};

// ------------------------------------------------------------------ what the agent bought

const DIVISIONS = ['7 + Moonball', '7', '6 + Moonball', '6', '5 + Moonball', '4 + Moonball', '5', '3 + Moonball', '2 + Moonball'];
/** Division `i` (0 first) in words, for a draw with or without a Moonball. */
export const divisionName = (i: number, moonballs: number): string =>
  moonballs > 1 ? `Division ${i + 1} (${DIVISIONS[i]})` : `Division ${i + 1} (${['7', '', '6', '', '5', '4'][i] || DIVISIONS[i]} right)`;

export type V2TicketsReport = {
  game: 'Starfall';
  purchases: { draw: number; at: string; games: number; cost: string; tickets: string[]; result?: string }[];
  syndicates: { syndicate: number; draw: number; at: string; shares: number; cost: string; status: string }[];
  spentLast24h: string;
};

/**
 * What this agent bought in v2, with each draw's result where it's out: its winning games by
 * division (worked out from the numbers it kept, with the contract's own prize circuit) and, once
 * the draw is finalised, what they won. `syndicateOf`: a syndicate's ledger entry.
 */
export const ticketsReportV2 = (
  G: Module,
  s: KitV2State,
  view: StarfallView | undefined,
  formatOf: (draw: bigint) => V2Format | undefined,
  syndicateOf: (id: bigint) => any,
  nowMs: number,
): V2TicketsReport => {
  const resultOf = (draw: string, tickets: SavedV2Ticket[] | undefined): string | undefined => {
    const d = view?.draws.find((x) => x.id.toString() === draw);
    if (!d) return undefined;
    if (d.status === VOIDED) return 'cancelled: the games are refunded to this wallet';
    if (d.status !== DRAWN && d.status !== SETTLED) return 'waiting for the draw';
    const f = formatOf(d.id);
    const drawn = `${d.numbers.join(' ')}${f && f.moonballs > 1 ? ` + ${d.moonball}` : ''}`;
    if (!f || !tickets) return `${drawn} (this purchase's numbers weren't kept: see lunardraw.io)`;
    const won = Array.from({ length: 9 }, () => 0);
    for (const t of tickets) savedTicketWins(G, d.id, t, d.numbers, d.moonball, f).forEach((n, i) => (won[i] += n));
    const games = won.reduce((a, n) => a + n, 0);
    if (!games) return `${drawn}: no winning games`;
    const parts = won.map((n, i) => (n ? `${n} in ${divisionName(i, f.moonballs)}` : '')).filter(Boolean).join(', ');
    const prize = d.status === SETTLED ? won.reduce((a, n, i) => a + BigInt(n) * (d.prizes[i] ?? 0n), 0n) : undefined;
    return `${drawn}: ${games} winning game(s): ${parts}${prize !== undefined ? `; ${tNight(prize)} in all` : '; the prizes are worked out when the draw is finalised'}, paid to the payout address automatically`;
  };
  const statusOf = (id: string, draw: string): string => {
    const sy = syndicateOf(BigInt(id));
    const d = view?.draws.find((x) => x.id.toString() === draw);
    if (!sy) return 'unknown';
    if (d?.status === VOIDED) return 'the draw was cancelled: shares are refunded to this wallet';
    if (Number(sy.status) === 0) {
      return d && d.status !== OPEN ? 'not funded in time: the shares are refunded to this wallet' : `filling: ${Number(sy.sold)} of ${Number(sy.totalShares)} shares sold`;
    }
    const played = `funded; ${Number(sy.bought)} of ${Number(sy.games)} game(s) bought`;
    if (d && (d.status === DRAWN || d.status === SETTLED)) return `${played}; drawn: ${d.numbers.join(' ')}. A share of any prize is paid to this wallet automatically`;
    return played;
  };
  return {
    game: 'Starfall',
    purchases: [...s.purchases]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((p) => {
        const f = formatOf(BigInt(p.draw));
        return {
          draw: Number(p.draw),
          at: p.at,
          games: p.games,
          cost: tNight(BigInt(p.cost)),
          tickets: p.tickets ? p.tickets.map((t) => describeSavedTicket(t, f)) : p.numbers.map((n) => n.join(' ')),
          result: resultOf(p.draw, p.tickets),
        };
      }),
    syndicates: [...s.syndicates]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((x) => ({ syndicate: Number(x.syndicate), draw: Number(x.draw), at: x.at, shares: x.shares, cost: tNight(BigInt(x.cost)), status: statusOf(x.syndicate, x.draw) })),
    spentLast24h: tNight(v2SpentSince(s, nowMs - 24 * 3600_000)),
  };
};
