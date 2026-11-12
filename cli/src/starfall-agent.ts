/**
 * A Starfall agent: a program with its own wallet that plays every draw.
 *
 * Each pass it looks at the chain: if a draw is on sale that it hasn't bought
 * into yet (and sales don't close too soon), it composes an entry from its
 * style and buys. With `buyEverySecs` it buys again in each later slot of that
 * length (an hour, say) while the draw sells, within its budget for the draw:
 * with daily draws, that keeps an agent playing through the day. Each agent's
 * slots start at its own minute past the hour (`buyOffsetSecs`, by default
 * from its name): purchases take the next ticket index, so agents buying in the
 * same minute knock each other's purchases out (8 Nov 2026: at the top of the
 * hour two of three failed with FailFallible). Once a draw it played has its numbers, it works out what it
 * won and says so (prizes reach its wallet by themselves). What it bought and
 * what it reported are kept in a small state file, so a restart doesn't buy
 * twice or report twice.
 *
 * Styles: `quickpick` (n random games), `lucky` (the same numbers every draw:
 * one set, or a list of sets), `moonhit` (7 numbers with every Moonball),
 * `system` (a System 8), `mix` (a random style each draw, weighted towards
 * small QuickPicks).
 *
 * An agent that is only awake for a short while each day (every open wallet
 * costs Blockfrost requests, bought or not: 13 Nov 2026) can buy its whole
 * day in one purchase with `rounds`: that many purchases' worth at once,
 * trimmed to what the budget for the draw still allows.
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
  /** For `lucky`: several sets of numbers, each played once a purchase (instead of `numbers` and `moonball`). */
  lines?: LuckyLine[];
  /**
   * Buy this many purchases' worth in one go (default 1): a QuickPick agent
   * with `games: 4` and `rounds: 24` buys 96 games. Trimmed to whole entries
   * that fit the budget for the draw.
   */
  rounds?: number;
  /** Most to spend on one draw, in STAR. Default 60 tNIGHT. */
  budget?: bigint;
  /** Don't buy when sales close within this many seconds. Default 180. */
  marginSecs?: number;
  /** Play at most this many draws, then stop (0 = forever). */
  maxDraws?: number;
  /** Most to spend in any 24 hours, in STAR (none by default). */
  dailyLimit?: bigint;
  /**
   * Buy again into the draw on sale once in every slot of this many seconds (3600: each clock
   * hour), not just once a draw. The budget still caps the whole draw. Default: once a draw.
   */
  buyEverySecs?: number;
  /** With buyEverySecs: the slots start this many seconds into each period (default 0). */
  buyOffsetSecs?: number;
};

export type LuckyLine = { numbers: number[]; moonball: number };

/** The most rounds one purchase may hold (two days of hourly purchases). */
export const MAX_ROUNDS = 48;

/**
 * Lucky sets from text: `3,11,17,23,26,30,34+7; 1,2,3,4,5,6,7+12` (seven
 * numbers, a plus, the Moonball; sets separated by semicolons or new lines).
 */
export const parseLines = (text: string): LuckyLine[] =>
  text
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const m = /^([\d\s,]+)\+\s*(\d+)$/.exec(s);
      if (!m) throw new Error(`a lucky set looks like "3,11,17,23,26,30,34+7" (seven numbers, a plus, the Moonball), not "${s}"`);
      const line = { numbers: m[1].split(/[\s,]+/).filter((x) => x !== '').map(Number), moonball: Number(m[2]) };
      if (line.numbers.length !== 7) throw new Error(`a lucky set has seven numbers: "${s}" has ${line.numbers.length}`);
      Starfall.checkEntry(line);
      return line;
    });

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
  /** The deployment these draws belong to (draw numbers start again at 1 with each one). */
  contract?: string;
};

export const emptyAgentState = (contract?: string): AgentState => ({ purchases: [], reported: [], ...(contract ? { contract } : {}) });

/**
 * The agent's state. Given the deployment it plays, a state kept for another
 * one (or from before states named theirs: the first Starfall deployment's)
 * is moved aside to `<path>.<its contract, or "earlier">.json` and a fresh one
 * begins: draw numbers start again at 1 with each deployment, so an old
 * purchase of draw 3 must never count as buying the new draw 3.
 */
export const loadAgentState = (path?: string, contract?: string): AgentState => {
  if (!path || !existsSync(path)) return emptyAgentState(contract);
  let s: Partial<AgentState>;
  try {
    s = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentState>;
  } catch {
    return emptyAgentState(contract);
  }
  const state: AgentState = { purchases: s.purchases ?? [], reported: s.reported ?? [], ...(s.contract ? { contract: s.contract } : {}) };
  if (contract === undefined) return state;
  const mine = contract.toLowerCase();
  if (state.contract?.toLowerCase() === mine) return state;
  if (state.contract === undefined && state.purchases.length === 0 && state.reported.length === 0) return emptyAgentState(contract);
  try {
    renameSync(path, `${path}.${state.contract ? state.contract.slice(0, 16) : 'earlier'}.json`);
  } catch {
    // left in place; the fresh state replaces it on the next save
  }
  return emptyAgentState(contract);
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
      if (o.lines?.length) return o.lines.map((l) => ({ numbers: [...l.numbers], moonball: l.moonball }));
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

/** How many purchases' worth one purchase holds: `rounds`, from 1 to MAX_ROUNDS. */
export const roundsOf = (o: AgentOptions): number => Math.max(1, Math.min(MAX_ROUNDS, Math.floor(o.rounds ?? 1) || 1));

/** What one purchase holds: `rounds` times the style's entries, in order. */
export const composePurchase = (o: AgentOptions, pick?: (n: number) => number): Starfall.PlainEntry[] =>
  Array.from({ length: roundsOf(o) }, () => composeEntries(o, pick)).flat();

export type Plan = { draw: bigint; salesClose: bigint; entries: Starfall.PlainEntry[]; games: number; cost: bigint };

/** What the purchases in `state` cost since `sinceMs` (STAR). */
export const spentSince = (state: AgentState, sinceMs: number): bigint =>
  state.purchases.filter((p) => Date.parse(p.at) >= sinceMs).reduce((a, p) => a + BigInt(p.cost), 0n);

/** What the purchases in `state` for one draw cost (STAR). */
export const spentOnDraw = (state: AgentState, draw: bigint): bigint =>
  state.purchases.filter((p) => p.draw === draw.toString()).reduce((a, p) => a + BigInt(p.cost), 0n);

/**
 * A minute within each period of `periodSecs`, from the agent's name (FNV-1a), so
 * agents left on the default spread out instead of all buying at the top of the hour.
 */
export const slotOffsetFor = (name: string, periodSecs: number): number => {
  let h = 0x811c9dc5;
  for (const c of new TextEncoder().encode(name)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  const minutes = Math.max(1, Math.floor(periodSecs / 60));
  return (h % minutes) * 60;
};

/** The draws the agent has bought into (several purchases of one draw count once). */
export const drawsPlayed = (state: AgentState): number => new Set(state.purchases.map((p) => p.draw)).size;

/**
 * What to buy now, or null: nothing on sale, sales closing too soon, already
 * bought into this draw (or, with buyEverySecs, already in this slot of it),
 * the budget for the draw, the daily limit or the limit of draws reached. `entries`
 * lets the caller (or a test) supply the composed entries.
 */
export const planPurchase = (
  view: StarfallView,
  nowSecs: number,
  state: AgentState,
  o: AgentOptions,
  wanted: Starfall.PlainEntry[] = composePurchase(o),
): Plan | null | { skipped: string } => {
  const now = BigInt(Math.floor(nowSecs));
  const margin = BigInt(o.marginSecs ?? 180);
  const selling = view.draws.find((d) => d.status === Starfall.DrawStatus.open && d.salesClose > now + margin);
  if (!selling) return null;
  const inDraw = state.purchases.filter((p) => p.draw === selling.id.toString());
  if (inDraw.length) {
    if (!o.buyEverySecs || o.buyEverySecs <= 0) return null;
    // once a slot: the slot of the latest purchase in this draw is done
    const offset = (o.buyOffsetSecs ?? 0) * 1000;
    const slot = (ms: number) => Math.floor((ms - offset) / (o.buyEverySecs! * 1000));
    const latest = Math.max(...inDraw.map((p) => Date.parse(p.at)).filter((t) => Number.isFinite(t)));
    if (!Number.isFinite(latest) || slot(latest) >= slot(nowSecs * 1000)) return null;
  } else if (o.maxDraws && drawsPlayed(state) >= o.maxDraws) {
    return { skipped: `played ${o.maxDraws} draw(s), the limit` };
  }
  const budget = o.budget ?? 60_000_000n;
  const spent = spentOnDraw(state, selling.id);
  const costOf = (list: Starfall.PlainEntry[]): bigint => view.ticketPrice * BigInt(list.reduce((a, e) => a + Starfall.gamesOf(e), 0));
  // A purchase of several rounds is trimmed to the whole entries the budget still allows, from the
  // front (a day's worth that is 10 tNIGHT over shouldn't buy nothing). One round is all or nothing, as before.
  let entries = wanted;
  if (roundsOf(o) > 1 && spent + costOf(entries) > budget) {
    const fits: Starfall.PlainEntry[] = [];
    for (const e of wanted) {
      if (spent + costOf([...fits, e]) > budget) break;
      fits.push(e);
    }
    if (fits.length) entries = fits;
  }
  const games = entries.reduce((a, e) => a + Starfall.gamesOf(e), 0);
  const cost = view.ticketPrice * BigInt(games);
  if (spent + cost > budget) {
    return {
      skipped: spent
        ? `${games} game(s) more (${Number(cost) / 1e6} tNIGHT) would take draw ${selling.id} to ${Number(spent + cost) / 1e6}, over the budget of ${Number(budget) / 1e6} a draw`
        : `${games} game(s) would cost ${Number(cost) / 1e6} tNIGHT, over the budget of ${Number(budget) / 1e6}`,
    };
  }
  if (o.dailyLimit !== undefined) {
    const spent = spentSince(state, nowSecs * 1000 - 24 * 3600_000);
    if (spent + cost > o.dailyLimit) {
      return { skipped: `${Number(cost) / 1e6} tNIGHT more would pass the daily limit of ${Number(o.dailyLimit) / 1e6} (${Number(spent) / 1e6} spent in the last 24 hours)` };
    }
  }
  return { draw: selling.id, salesClose: selling.salesClose, entries, games, cost };
};

export type Result = { draw: bigint; numbers: number[]; moonball: number; games: number; won: { division: number; games: number }[] };

/** Draws the agent played whose numbers are out and haven't been reported yet. */
export const settledResults = (view: StarfallView, state: AgentState): Result[] => {
  const out: Result[] = [];
  // one result a draw, however many purchases went into it
  for (const draw of new Set(state.purchases.map((p) => p.draw))) {
    if (state.reported.includes(draw)) continue;
    const d = view.draws.find((x) => x.id.toString() === draw);
    if (!d || (d.status !== Starfall.DrawStatus.drawn && d.status !== Starfall.DrawStatus.settled)) continue;
    const won = Array.from({ length: 9 }, () => 0n);
    let games = 0;
    for (const p of state.purchases.filter((x) => x.draw === draw)) {
      games += p.games;
      for (const e of p.entries) {
        Starfall.gamesByDivisionFor(e, d.numbers, d.moonball).forEach((n, i) => (won[i] += n));
      }
    }
    out.push({
      draw: d.id,
      numbers: d.numbers,
      moonball: d.moonball,
      games,
      won: won.map((n, i) => ({ division: i + 1, games: Number(n) })).filter((w) => w.games > 0),
    });
  }
  return out;
};

/** Draws the agent played that were cancelled (its games are refunded). */
export const voidedDraws = (view: StarfallView, state: AgentState): bigint[] =>
  [...new Set(state.purchases.map((p) => p.draw))]
    .filter((draw) => !state.reported.includes(draw))
    .map((draw) => view.draws.find((x) => x.id.toString() === draw))
    .filter((d): d is NonNullable<typeof d> => !!d && d.status === Starfall.DrawStatus.voided)
    .map((d) => d.id);

/** "3 games: Division 8 on 1 game" or "no prize". */
export const describeResult = (r: Result): string => {
  if (!r.won.length) return `no prize this time (${r.games} game${r.games === 1 ? '' : 's'})`;
  return r.won.map((w) => `Division ${w.division} on ${w.games} game${w.games === 1 ? '' : 's'}`).join(', ') + ` (${r.games} game${r.games === 1 ? '' : 's'})`;
};
