/**
 * The house agents on Starfall v2 (`./lunardraw starfall-v2 agent`): Starfall's agent (starfall-agent.ts)
 * for the v2 game, whose draws each have their own format (7 numbers from N, M Moonballs; 7 from 20
 * with no Moonball at the bottom of the ladder).
 *
 * An agent buys once a draw (or `rounds` purchases' worth in one go: an agent started for a while each
 * day by a timer), in its style, turned into the draw's format:
 *   - quickpick: `games` QuickPick games from the draw's range;
 *   - lucky: its fixed sets, each fitted into the draw's range (a number above the range is folded
 *     back into it, `fitLine`; the Moonball likewise, or 1 when the draw has none);
 *   - moonhit: 7 numbers with Moonball Sweep, or a QuickPick game when the draw has no Moonball;
 *   - system: a System 8;
 *   - mix: QuickPicks most of the time, now and then a Sweep, a System 8 or a Pick 6.
 * Its games are packed as the website's engine packs them (consecutive standard games share a ticket,
 * 1 + maxLines() to a ticket, anything else a ticket of its own, maxTickets() tickets a transaction),
 * paid in full to the agent's wallet, which is also the refund address.
 *
 * Everything here is pure (the compiled game's module is passed in), so it is checked in memory
 * against the deployed build (starfall-v2/check/agent.mjs).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, webcrypto } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-explicit-any -- the generated v2 module is loaded at run time */
type Module = any;

export type V2Style = 'quickpick' | 'lucky' | 'moonhit' | 'system' | 'mix';
export const V2_STYLES: V2Style[] = ['quickpick', 'lucky', 'moonhit', 'system', 'mix'];
export const MAX_ROUNDS = 48;

/** A draw's format, as its ledger holds it. */
export type V2Format = { range: number; moonballs: number; pick5: bigint };

/** A game as the website's engine takes it: 7 numbers (a standard game), 8-12 (a System), 5-6 with `pick`; a Moonball or Sweep. */
export type V2Game = { numbers: number[]; moonball?: number; sweep?: boolean; pick?: boolean };

export type V2AgentOptions = {
  name: string;
  style: V2Style;
  /** QuickPick games a purchase (quickpick). Default 2. */
  games?: number;
  /** The lucky sets (lucky): 7 numbers and a Moonball each, as written for Starfall Classic (1-35, 1-20). */
  lines?: { numbers: number[]; moonball: number }[];
  /** This many purchases' worth in one go (1 to MAX_ROUNDS). */
  rounds?: number;
  /** Most to spend on one draw, STAR. Default 60 tNIGHT. */
  budget?: bigint;
  /** Don't buy when sales close within this many seconds. Default 300. */
  marginSecs?: number;
  /** Play at most this many draws (0: forever). */
  maxDraws?: number;
};

// ------------------------------------------------------------------ choosing the games

const rand = (n: number): number => {
  const r = new Uint32Array(1);
  const lim = Math.floor(4_294_967_296 / n) * n;
  do webcrypto.getRandomValues(r);
  while (r[0]! >= lim);
  return r[0]! % n;
};

const randomNumbers = (count: number, range: number, pick: (n: number) => number): number[] => {
  const out = new Set<number>();
  while (out.size < count) out.add(pick(range) + 1);
  return [...out].sort((a, b) => a - b);
};

const moonballOf = (f: V2Format, pick: (n: number) => number): number => (f.moonballs > 1 ? pick(f.moonballs) + 1 : 1);

/**
 * A lucky set fitted into a draw's format: each number above the range is folded back into it
 * ((n - 1) mod range + 1); a number that then repeats one already taken moves up to the next free
 * one (wrapping round). The Moonball is folded the same way, or 1 when the draw has none. A set that
 * already fits is unchanged, so an agent's numbers stay its own on bigger rungs.
 */
export const fitLine = (line: { numbers: number[]; moonball: number }, f: V2Format): { numbers: number[]; moonball: number } => {
  const taken = new Set<number>();
  for (const n of line.numbers) {
    let x = ((Math.max(1, Math.floor(n)) - 1) % f.range) + 1;
    while (taken.has(x)) x = (x % f.range) + 1;
    taken.add(x);
  }
  const mb = f.moonballs > 1 ? ((Math.max(1, Math.floor(line.moonball)) - 1) % f.moonballs) + 1 : 1;
  return { numbers: [...taken].sort((a, b) => a - b), moonball: mb };
};

/** One purchase's worth of games in this style for a draw of format `f` (before `rounds`). */
export const composeV2 = (o: V2AgentOptions, f: V2Format, pick: (n: number) => number = rand): V2Game[] => {
  const qp = (): V2Game => ({ numbers: randomNumbers(7, f.range, pick), moonball: moonballOf(f, pick) });
  const games = Math.max(1, Math.min(18, o.games ?? 2));
  switch (o.style) {
    case 'quickpick':
      return Array.from({ length: games }, qp);
    case 'lucky':
      if (!o.lines?.length) throw new Error('the lucky style needs its sets of numbers');
      return o.lines.map((l) => fitLine(l, f));
    case 'moonhit':
      return [f.moonballs > 1 ? { numbers: randomNumbers(7, f.range, pick), sweep: true } : qp()];
    case 'system':
      return [{ numbers: randomNumbers(8, f.range, pick), moonball: moonballOf(f, pick) }];
    case 'mix': {
      const roll = pick(10);
      if (roll < 6) return Array.from({ length: 1 + pick(4) }, qp);
      if (roll < 8) return [f.moonballs > 1 ? { numbers: randomNumbers(7, f.range, pick), sweep: true } : qp()];
      if (roll < 9) return [{ numbers: randomNumbers(8, f.range, pick), moonball: moonballOf(f, pick) }];
      return [{ numbers: randomNumbers(6, f.range, pick), moonball: moonballOf(f, pick), pick: true }];
    }
    default:
      throw new Error(`unknown style ${String(o.style)}`);
  }
};

export const roundsOf = (o: V2AgentOptions): number => Math.max(1, Math.min(MAX_ROUNDS, Math.floor(o.rounds ?? 1) || 1));

/** What one purchase holds: `rounds` times the style's games, in order. */
export const composeV2Purchase = (o: V2AgentOptions, f: V2Format, pick?: (n: number) => number): V2Game[] =>
  Array.from({ length: roundsOf(o) }, () => composeV2(o, f, pick)).flat();

// ------------------------------------------------------------------ tickets

const le = (b: Uint8Array): bigint => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
};
const NO_LINE = { numbers: Array(7).fill(0n), moonball: 0n };
const NO_PAYEE = { lo: 0n, hi: 0n, share: 0n };
const salt = (): bigint => BigInt('0x' + randomBytes(31).toString('hex'));
const sorted = (xs: number[]): bigint[] => [...xs].sort((a, b) => a - b).map(BigInt);
/** A format as the contract's circuits take it. */
export const circuitFormat = (f: V2Format) => ({ range: BigInt(f.range), moonballs: BigInt(f.moonballs), pick5: BigInt(f.pick5) });

/** A standard game: the kind that can share a ticket. */
const isStandard = (g: V2Game): boolean => !g.pick && !g.sweep && g.numbers.length === 7;

/**
 * One v2 ticket of draw `drawId`: `entry` and up to maxLines() more standard games, paid in full to
 * `payTo` (32 bytes). As the website engine's makeTicketV2.
 */
export const v2Ticket = (G: Module, drawId: bigint, entry: V2Game, lines: V2Game[], payTo: Uint8Array, f: V2Format) => {
  const maxLines = Number(G.pureCircuits.maxLines());
  if (lines.length > maxLines) throw new Error(`a ticket holds at most ${1 + maxLines} games`);
  const mb = (m: number | undefined): bigint => BigInt(f.moonballs <= 1 ? 1 : (m ?? 1));
  return {
    drawId,
    entry: {
      kind: entry.pick ? 1n : 0n,
      count: BigInt(entry.numbers.length),
      numbers: [...sorted(entry.numbers), ...Array(12 - entry.numbers.length).fill(0n)],
      moonball: entry.sweep ? 0n : mb(entry.moonball),
      sweep: !!entry.sweep,
    },
    lines: [...lines.map((l) => ({ numbers: sorted(l.numbers), moonball: mb(l.moonball) })), ...Array(maxLines - lines.length).fill(NO_LINE)],
    payees: [{ lo: le(payTo.subarray(0, 16)), hi: le(payTo.subarray(16, 32)), share: 10000n }, NO_PAYEE, NO_PAYEE],
    salt: salt(),
  };
};

/** Games a ticket holds in format f (0: not a valid ticket). */
export const ticketGames = (G: Module, t: unknown, f: V2Format): number => Number(G.pureCircuits.ticketGames(t, circuitFormat(f)));

/**
 * The games packed into tickets and transactions, in order: consecutive standard games share a
 * ticket (1 + maxLines()), anything else is a ticket of its own; maxTickets() tickets a transaction.
 * Every ticket is checked with the contract's validTicket, so a bad pick stops before anything is proved.
 */
export const packV2 = (G: Module, drawId: bigint, games: V2Game[], payTo: Uint8Array, f: V2Format): unknown[][] => {
  const perTicket = 1 + Number(G.pureCircuits.maxLines());
  const perTx = Number(G.pureCircuits.maxTickets());
  const groups: V2Game[][] = [];
  for (const g of games) {
    const last = groups[groups.length - 1];
    if (last && isStandard(g) && isStandard(last[0]!) && last.length < perTicket) last.push(g);
    else groups.push([g]);
  }
  const tickets = groups.map(([entry, ...lines]) => {
    const t = v2Ticket(G, drawId, entry!, lines, payTo, f);
    if (!G.pureCircuits.validTicket(t, circuitFormat(f))) throw new Error(`not a valid ticket in draw ${drawId}'s format (7 from ${f.range}): ${JSON.stringify(entry)}`);
    return t;
  });
  const txs: unknown[][] = [];
  for (let i = 0; i < tickets.length; i += perTx) txs.push(tickets.slice(i, i + perTx));
  return txs;
};

// ------------------------------------------------------------------ what to buy

/**
 * A ticket as kept in an agent's state (its numbers, never its salt or payees), so its result can be
 * worked out once the draw's numbers are out: kind 0 a standard game or a System, 1 a Pick; Moonball
 * 0 with `sweep`. `lines`: the ticket's other standard games.
 */
export type SavedV2Ticket = { kind: number; numbers: number[]; moonball: number; sweep: boolean; lines: { numbers: number[]; moonball: number }[] };

/** What a ticket's preimage holds, as kept in the state. */
export const savedTicketOf = (t: unknown): SavedV2Ticket => {
  const x = t as { entry: { kind: bigint; count: bigint; numbers: bigint[]; moonball: bigint; sweep: boolean }; lines: { numbers: bigint[]; moonball: bigint }[] };
  return {
    kind: Number(x.entry.kind),
    numbers: x.entry.numbers.slice(0, Number(x.entry.count)).map(Number),
    moonball: Number(x.entry.moonball),
    sweep: !!x.entry.sweep,
    lines: x.lines.filter((l) => l.moonball !== 0n).map((l) => ({ numbers: l.numbers.map(Number), moonball: Number(l.moonball) })),
  };
};

/** A kept ticket as a preimage again (no payees, no salt): enough for the contract's pure circuits. */
export const preimageOfSaved = (G: Module, drawId: bigint, s: SavedV2Ticket) => {
  const maxLines = Number(G.pureCircuits.maxLines());
  return {
    drawId,
    entry: { kind: BigInt(s.kind), count: BigInt(s.numbers.length), numbers: [...s.numbers.map(BigInt), ...Array(12 - s.numbers.length).fill(0n)], moonball: BigInt(s.moonball), sweep: s.sweep },
    lines: [...s.lines.map((l) => ({ numbers: l.numbers.map(BigInt), moonball: BigInt(l.moonball) })), ...Array(maxLines - s.lines.length).fill(NO_LINE)],
    payees: [NO_PAYEE, NO_PAYEE, NO_PAYEE],
    salt: 0n,
  };
};

/** A kept ticket's winning games in each of the 9 divisions, for a draw's numbers, Moonball and format. */
export const savedTicketWins = (G: Module, drawId: bigint, s: SavedV2Ticket, numbers: number[], moonball: number, f: V2Format): number[] =>
  [...(G.pureCircuits.ticketDivisions(preimageOfSaved(G, drawId, s), numbers.map(BigInt), BigInt(moonball), circuitFormat(f)) as bigint[])].map(Number);

/** A kept ticket in words: "3 7 11 14 15 18 20 + 5", "System 8: ...", "Pick 6: ...", "... Moonball Sweep". */
export const describeSavedTicket = (s: SavedV2Ticket, f?: { moonballs: number }): string => {
  const mb = (m: number) => (f && f.moonballs <= 1 ? '' : ` + ${m}`);
  const kind = s.kind === 1 ? `Pick ${s.numbers.length}: ` : s.numbers.length > 7 ? `System ${s.numbers.length}: ` : '';
  const entry = `${kind}${s.numbers.join(' ')}${s.sweep ? ' with Moonball Sweep' : mb(s.moonball)}`;
  return [entry, ...s.lines.map((l) => `${l.numbers.join(' ')}${mb(l.moonball)}`)].join('; ');
};

/** `tickets`: the tickets bought (savedTicketOf), for working out their results; older states have only `numbers`. */
export type V2Purchase = { draw: string; at: string; games: number; cost: string; txs: number; numbers: number[][]; tickets?: SavedV2Ticket[] };
/** `address`: the agent's wallet (32 bytes in hex), for the directory to find the prizes paid to it. */
export type V2AgentState = { contract: string; purchases: V2Purchase[]; reported: string[]; address?: string };

export const loadV2AgentState = (path: string, contract: string): V2AgentState => {
  const fresh = { contract, purchases: [], reported: [] };
  if (!existsSync(path)) return fresh;
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as V2AgentState;
    // (anything else in the file is kept: the agent kit keeps its syndicate shares there too)
    if (s.contract?.toLowerCase() === contract.toLowerCase()) return { ...s, contract, purchases: s.purchases ?? [], reported: s.reported ?? [] };
    renameSync(path, `${path}.${(s.contract ?? 'earlier').slice(0, 16)}.json`);
  } catch {
    // unreadable: start again
  }
  return fresh;
};

export const saveV2AgentState = (path: string, s: V2AgentState): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

export type V2Draw = { id: bigint; status: number; salesClose: bigint; format: V2Format };
export type V2Plan = { draw: bigint; salesClose: bigint; format: V2Format; txs: unknown[][]; games: number; cost: bigint };

/**
 * What to buy now, or null (nothing on sale, too close to sales close, already in this draw, or the
 * limit of draws reached), or why it sits the draw out (the budget). A purchase of several rounds is
 * trimmed to the whole rounds the budget allows.
 */
export const planV2 = (
  G: Module,
  draws: V2Draw[],
  ticketPrice: bigint,
  nowSecs: number,
  s: V2AgentState,
  o: V2AgentOptions,
  me: Uint8Array,
  pick?: (n: number) => number,
): V2Plan | null | { skipped: string; draw: bigint } => {
  const now = BigInt(Math.floor(nowSecs));
  const d = draws.find((x) => x.status === 0 && x.salesClose > now + BigInt(o.marginSecs ?? 300));
  if (!d) return null;
  if (s.purchases.some((p) => p.draw === d.id.toString())) return null;
  if (o.maxDraws && new Set(s.purchases.map((p) => p.draw)).size >= o.maxDraws) return { skipped: `played ${o.maxDraws} draw(s), the limit`, draw: d.id };
  const budget = o.budget ?? 60_000_000n;
  const round = () => composeV2(o, d.format, pick);
  const games: V2Game[] = [];
  let count = 0;
  const gamesIn = (list: V2Game[]) => packV2(G, d.id, list, me, d.format).flat().reduce((a: number, t) => a + ticketGames(G, t, d.format), 0);
  for (let r = 0; r < roundsOf(o); r++) {
    const next = round();
    const n = gamesIn(next);
    if (ticketPrice * BigInt(count + n) > budget) break;
    games.push(...next);
    count += n;
  }
  if (!games.length) {
    const one = gamesIn(round());
    return { skipped: `${one} game(s) would cost ${Number(ticketPrice * BigInt(one)) / 1e6} tNIGHT, over the budget of ${Number(budget) / 1e6} a draw`, draw: d.id };
  }
  const txs = packV2(G, d.id, games, me, d.format);
  return { draw: d.id, salesClose: d.salesClose, format: d.format, txs, games: count, cost: ticketPrice * BigInt(count) };
};

/** Lucky sets as written on the command line: "3,11,17,23,26,30,34+7;1,12,21,23,26,31,35+16". */
export const parseV2Lines = (text: string): { numbers: number[]; moonball: number }[] =>
  text
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((set) => {
      const [nums, mb] = set.split('+');
      const numbers = (nums ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      const moonball = Number(mb ?? 1);
      if (numbers.length !== 7 || numbers.some((n) => !Number.isInteger(n) || n < 1) || !Number.isInteger(moonball) || moonball < 1) {
        throw new Error(`a lucky set is 7 numbers and a Moonball, like 3,11,17,23,26,30,34+7 (not "${set}")`);
      }
      return { numbers, moonball };
    });
