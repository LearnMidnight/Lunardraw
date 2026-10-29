/**
 * A Starfall agent: a program with its own wallet that plays every draw.
 *
 * Each pass it looks at the chain: if a draw is on sale that it hasn't bought
 * into yet (and sales don't close too soon), it composes an entry from its
 * style and buys. Once a draw it played has its numbers, it works out what it
 * won and says so (prizes reach its wallet by themselves). What it bought and
 * what it reported are kept in a small state file, so a restart doesn't buy
 * twice or report twice.
 *
 * Styles: `quickpick` (n random games), `lucky` (the same numbers every draw),
 * `moonhit` (7 numbers with every Moonball), `system` (a System 8), `mix`
 * (a random style each draw, weighted towards small QuickPicks).
 *
 * The planning is pure (`planPurchase`, `settledResults`) so it can be tested
 * without a chain; `runAgent` wires it to a wallet.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { webcrypto } from 'node:crypto';
import { quickPick, Starfall } from '@lunardraw/contract';
import type { StarfallView } from '@lunardraw/keeper';

export type AgentStyle = 'quickpick' | 'lucky' | 'moonhit' | 'system' | 'mix';

export type AgentOptions = {
  name: string;
  style: AgentStyle;
  /** QuickPick games a draw (quickpick, and the QuickPick arm of mix). Default 2. */
  games?: number;
  /** The lucky numbers (7) and Moonball, for `lucky`. */
  numbers?: number[];
  moonball?: number;
  /** Most to spend on one draw, in STAR. Default 60 tNIGHT. */
  budget?: bigint;
  /** Don't buy when sales close within this many seconds. Default 180. */
  marginSecs?: number;
  /** Play at most this many draws, then stop (0 = forever). */
  maxDraws?: number;
};

export type AgentPurchase = {
  draw: string; // bigint as string, for JSON
  at: string;
  entries: Starfall.PlainEntry[];
  games: number;
  cost: string;
  txs: number;
};

export type AgentState = {
  purchases: AgentPurchase[];
  /** Draws whose result has been reported. */
  reported: string[];
};

export const emptyAgentState = (): AgentState => ({ purchases: [], reported: [] });

export const loadAgentState = (path?: string): AgentState => {
  if (!path || !existsSync(path)) return emptyAgentState();
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentState>;
    return { purchases: s.purchases ?? [], reported: s.reported ?? [] };
  } catch {
    return emptyAgentState();
  }
};

export const saveAgentState = (path: string | undefined, state: AgentState): void => {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, path);
};

const rand = (n: number): number => {
  const r = new Uint32Array(1);
  const lim = Math.floor(4_294_967_296 / n) * n;
  do webcrypto.getRandomValues(r);
  while (r[0] >= lim);
  return r[0] % n;
};

const randomNumbers = (count: number): number[] => {
  const out = new Set<number>();
  while (out.size < count) out.add(rand(35) + 1);
  return [...out].sort((a, b) => a - b);
};

/** The entries this style plays in one draw. `pick` lets tests fix the random choice. */
export const composeEntries = (o: AgentOptions, pick: (n: number) => number = rand): Starfall.PlainEntry[] => {
  const games = Math.max(1, Math.min(18, o.games ?? 2));
  switch (o.style) {
    case 'quickpick':
      return Array.from({ length: games }, () => ({ ...quickPick() }));
    case 'lucky': {
      if (!o.numbers || o.numbers.length !== 7 || !o.moonball) throw new Error('the lucky style needs 7 numbers and a Moonball');
      return [{ numbers: [...o.numbers], moonball: o.moonball }];
    }
    case 'moonhit':
      return [{ numbers: randomNumbers(7), sweep: true }];
    case 'system':
      return [{ numbers: randomNumbers(8), moonball: rand(20) + 1 }];
    case 'mix': {
      const roll = pick(10);
      if (roll < 6) return Array.from({ length: 1 + pick(4) }, () => ({ ...quickPick() }));
      if (roll < 8) return [{ numbers: randomNumbers(7), sweep: true }];
      if (roll < 9) return [{ numbers: randomNumbers(8), moonball: rand(20) + 1 }];
      return [{ numbers: randomNumbers(6), moonball: rand(20) + 1, pick: true }];
    }
    default:
      throw new Error(`unknown style ${String(o.style)}`);
  }
};

export type Plan = { draw: bigint; salesClose: bigint; entries: Starfall.PlainEntry[]; games: number; cost: bigint };

/**
 * What to buy now, or null: nothing on sale, sales closing too soon, already
 * bought into this draw, the budget or the limit of draws reached. `entries`
 * lets the caller (or a test) supply the composed entries.
 */
export const planPurchase = (
  view: StarfallView,
  nowSecs: number,
  state: AgentState,
  o: AgentOptions,
  entries: Starfall.PlainEntry[] = composeEntries(o),
): Plan | null | { skipped: string } => {
  const now = BigInt(Math.floor(nowSecs));
  const margin = BigInt(o.marginSecs ?? 180);
  const selling = view.draws.find((d) => d.status === Starfall.DrawStatus.open && d.salesClose > now + margin);
  if (!selling) return null;
  if (state.purchases.some((p) => p.draw === selling.id.toString())) return null;
  if (o.maxDraws && state.purchases.length >= o.maxDraws) return { skipped: `played ${o.maxDraws} draw(s), the limit` };
  const games = entries.reduce((a, e) => a + Starfall.gamesOf(e), 0);
  const cost = view.ticketPrice * BigInt(games);
  const budget = o.budget ?? 60_000_000n;
  if (cost > budget) return { skipped: `${games} game(s) would cost ${Number(cost) / 1e6} tNIGHT, over the budget of ${Number(budget) / 1e6}` };
  return { draw: selling.id, salesClose: selling.salesClose, entries, games, cost };
};

export type Result = { draw: bigint; numbers: number[]; moonball: number; games: number; won: { division: number; games: number }[] };

/** Draws the agent played whose numbers are out and haven't been reported yet. */
export const settledResults = (view: StarfallView, state: AgentState): Result[] => {
  const out: Result[] = [];
  for (const p of state.purchases) {
    if (state.reported.includes(p.draw)) continue;
    const d = view.draws.find((x) => x.id.toString() === p.draw);
    if (!d || (d.status !== Starfall.DrawStatus.drawn && d.status !== Starfall.DrawStatus.settled)) continue;
    const won = Array.from({ length: 9 }, () => 0n);
    for (const e of p.entries) {
      Starfall.gamesByDivisionFor(e, d.numbers, d.moonball).forEach((n, i) => (won[i] += n));
    }
    out.push({
      draw: d.id,
      numbers: d.numbers,
      moonball: d.moonball,
      games: p.games,
      won: won.map((n, i) => ({ division: i + 1, games: Number(n) })).filter((w) => w.games > 0),
    });
  }
  return out;
};

/** Draws the agent played that were cancelled (its games are refunded). */
export const voidedDraws = (view: StarfallView, state: AgentState): bigint[] =>
  state.purchases
    .filter((p) => !state.reported.includes(p.draw))
    .map((p) => view.draws.find((x) => x.id.toString() === p.draw))
    .filter((d): d is NonNullable<typeof d> => !!d && d.status === Starfall.DrawStatus.voided)
    .map((d) => d.id);

/** "3 games: Division 8 on 1 game" or "no prize". */
export const describeResult = (r: Result): string => {
  if (!r.won.length) return `no prize this time (${r.games} game${r.games === 1 ? '' : 's'})`;
  return r.won.map((w) => `Division ${w.division} on ${w.games} game${w.games === 1 ? '' : 's'}`).join(', ') + ` (${r.games} game${r.games === 1 ? '' : 's'})`;
};
