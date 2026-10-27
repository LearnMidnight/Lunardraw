import { webcrypto } from 'node:crypto';
import type { Entry, Payee, TicketPreimage } from './managed/settlement/contract/index.js';
import { divisionFor, quickPick, type PlainLine } from './tickets.js';

/**
 * Division shares of the prize pool in basis points (division 1 first):
 * Australian Powerball's published allocation (The Lott, from draw 1410).
 */
export const POWERBALL_SHARES_BP = [3350, 185, 230, 200, 150, 940, 730, 1550, 2665] as const;

/** Up to three payees per ticket. */
export const MAX_PAYEES = 3;
/** Shares are in basis points: 10000 is the whole prize. */
export const WHOLE = 10_000;

/** A payee as plain values: a 32-byte unshielded address with a share in basis points. */
export type PlainPayee = { address: Uint8Array; share: number };

const ZERO_ADDRESS = new Uint8Array(32);
const NO_PAYEE: Payee = { address: { bytes: ZERO_ADDRESS }, share: 0n };

/** How many numbers an entry can hold (a System 12). */
export const MAX_NUMBERS = 12;

/**
 * One entry, as plain values. 7 numbers is a standard game, 8 to 12 a System
 * (every 7 of them). `pick: true` with 5 or 6 numbers is a Pick: those numbers
 * completed with every choice of the rest. `sweep: true` plays every Moonball
 * (20 times the games; `moonball` is then ignored). A plain line
 * (`{ numbers, moonball }`) is a standard game.
 */
export type PlainEntry = { numbers: number[]; moonball?: number; pick?: boolean; sweep?: boolean };

/** Entry types the contract accepts, with their games (before Moonball Sweep). */
export const ENTRY_TYPES = [
  { name: 'standard', pick: false, count: 7, games: 1 },
  { name: 'System 8', pick: false, count: 8, games: 8 },
  { name: 'System 9', pick: false, count: 9, games: 36 },
  { name: 'System 10', pick: false, count: 10, games: 120 },
  { name: 'System 11', pick: false, count: 11, games: 330 },
  { name: 'System 12', pick: false, count: 12, games: 792 },
  { name: 'Pick 6', pick: true, count: 6, games: 29 },
  { name: 'Pick 5', pick: true, count: 5, games: 435 },
] as const;

/** The entry's type, or undefined if the contract doesn't accept it. */
export const entryType = (e: PlainEntry) =>
  ENTRY_TYPES.find((t) => t.pick === (e.pick ?? false) && t.count === e.numbers.length);

/** The entry's name, as on the site: "standard", "System 9", "Pick 6", with " + Moonball Sweep". */
export const entryName = (e: PlainEntry): string =>
  `${entryType(e)?.name ?? 'invalid entry'}${e.sweep ? ' + Moonball Sweep' : ''}`;

/** Games in an entry: its type's games, times 20 with Moonball Sweep. */
export const gamesOf = (e: PlainEntry): number => {
  const t = entryType(e);
  if (t === undefined) throw new Error(`no such entry: ${e.pick ? 'Pick' : 'System'} with ${e.numbers.length} numbers`);
  return t.games * (e.sweep ? 20 : 1);
};

/** Check an entry the way the contract does; throws with a reason. */
export const checkEntry = (e: PlainEntry): void => {
  if (entryType(e) === undefined) {
    throw new Error(
      e.pick
        ? 'a Pick has 5 or 6 numbers'
        : 'an entry has 7 numbers (a standard game) or 8 to 12 (a System)',
    );
  }
  const n = [...e.numbers].sort((a, b) => a - b);
  for (let i = 0; i < n.length; i++) {
    if (!Number.isInteger(n[i]) || n[i] < 1 || n[i] > 35) throw new Error('numbers are 1..35');
    if (i > 0 && n[i] <= n[i - 1]) throw new Error('numbers must be distinct');
  }
  if (!e.sweep && (!Number.isInteger(e.moonball) || (e.moonball as number) < 1 || (e.moonball as number) > 20)) {
    throw new Error('the Moonball is 1..20 (or use Moonball Sweep)');
  }
};

/** The contract's form of an entry. */
export const toEntry = (e: PlainEntry): Entry => {
  checkEntry(e);
  const n = [...e.numbers].sort((a, b) => a - b).map(BigInt);
  while (n.length < MAX_NUMBERS) n.push(0n);
  return {
    kind: e.pick ? 1n : 0n,
    count: BigInt(e.numbers.length),
    numbers: n,
    moonball: e.sweep ? 0n : BigInt(e.moonball as number),
    sweep: e.sweep ?? false,
  };
};

/**
 * Build a Starfall ticket (one entry) for draw `drawId`, paid to `payees`: a
 * single address (the whole prize) or up to three payees whose shares add up
 * to 10000. Numbers may be in any order. `salt` defaults to 32 random bytes.
 * The buyer doesn't need to keep it: the settlement key holder decrypts the
 * ticket from the chain, and refunds go to the address given at purchase.
 */
export const makeTicket = (
  drawId: number | bigint,
  entry: PlainEntry | PlainLine,
  payees: Uint8Array | PlainPayee[],
  salt?: Uint8Array,
): TicketPreimage => {
  const e = toEntry(entry);
  const list = payees instanceof Uint8Array ? [{ address: payees, share: WHOLE }] : payees;
  if (list.length < 1 || list.length > MAX_PAYEES) throw new Error(`a ticket has 1 to ${MAX_PAYEES} payees`);
  for (const p of list) {
    if (!Number.isInteger(p.share) || p.share < 1 || p.share > WHOLE) throw new Error('each share is 1..10000 basis points');
    if (p.address.length !== 32) throw new Error('an address is 32 bytes');
  }
  if (list.reduce((a, p) => a + p.share, 0) !== WHOLE) throw new Error('shares must add up to 10000');
  const out: Payee[] = list.map((p) => ({ address: { bytes: p.address }, share: BigInt(p.share) }));
  while (out.length < MAX_PAYEES) out.push(NO_PAYEE);
  return {
    drawId: BigInt(drawId),
    entry: e,
    payees: out,
    salt: salt ?? webcrypto.getRandomValues(new Uint8Array(32)),
  };
};

/**
 * QuickPick packages: how many random games each buys. Powerball's six
 * (Mini to Maxi) plus Single and Starter.
 */
export const QUICK_PICK_PACKAGES = {
  single: 1,
  starter: 4,
  mini: 8,
  regular: 12,
  super: 18,
  mega: 25,
  jumbo: 36,
  maxi: 50,
} as const;

export type QuickPickPackage = keyof typeof QUICK_PICK_PACKAGES;

/** The games of a QuickPick package for draw `drawId`, all paid to `payees`. */
export const quickPickPackage = (
  drawId: number | bigint,
  pkg: QuickPickPackage,
  payees: Uint8Array | PlainPayee[],
): TicketPreimage[] => Array.from({ length: QUICK_PICK_PACKAGES[pkg] }, () => makeTicket(drawId, quickPick(), payees));

/** A ticket with every field zero: fills the unused slots of a purchase and of a draw's last settlement batch. */
export const emptyTicket = (drawId: bigint): TicketPreimage => ({
  drawId,
  entry: { kind: 0n, count: 0n, numbers: Array.from({ length: MAX_NUMBERS }, () => 0n), moonball: 0n, sweep: false },
  payees: [NO_PAYEE, NO_PAYEE, NO_PAYEE],
  salt: new Uint8Array(32),
});

/** A ticket's entry as plain numbers. */
export const entryOf = (t: TicketPreimage): PlainEntry => ({
  numbers: t.entry.numbers.slice(0, Number(t.entry.count)).map(Number),
  moonball: Number(t.entry.moonball),
  pick: t.entry.kind === 1n,
  sweep: t.entry.sweep,
});

/** Every game in an entry, as lines (a Pick 5 + Moonball Sweep is 8,700). */
export const gamesIn = (e: PlainEntry): PlainLine[] => {
  checkEntry(e);
  const chosen = [...e.numbers].sort((a, b) => a - b);
  const combos = (from: number[], k: number): number[][] =>
    k === 0 ? [[]] : from.flatMap((x, i) => combos(from.slice(i + 1), k - 1).map((c) => [x, ...c]));
  const mains = e.pick
    ? combos(Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !chosen.includes(x)), 7 - chosen.length).map((rest) =>
        [...chosen, ...rest].sort((a, b) => a - b),
      )
    : combos(chosen, 7);
  const moonballs = e.sweep ? Array.from({ length: 20 }, (_, i) => i + 1) : [e.moonball as number];
  return mains.flatMap((numbers) => moonballs.map((moonball) => ({ numbers, moonball })));
};

/**
 * An entry's winning games per division (division 1 first), by checking every
 * game in it: the reference for the contract's `gamesByDivision`, which uses
 * a table instead.
 */
export const gamesByDivisionFor = (e: PlainEntry, numbers: number[], moonball: number): bigint[] => {
  const out = Array.from({ length: 9 }, () => 0n);
  for (const g of gamesIn(e)) {
    const d = divisionFor(g, numbers, moonball);
    if (d > 0) out[d - 1] += 1n;
  }
  return out;
};

/** Random scalar for sealing a ticket (31 random bytes, so always below the field size). */
export const randomScalar = (): bigint => {
  const b = webcrypto.getRandomValues(new Uint8Array(31));
  return BigInt('0x' + Buffer.from(b).toString('hex'));
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** How one payee is paid from a prize: the same arithmetic as `payEntitlement`. */
export const splitPrize = (prize: bigint, shares: readonly bigint[]): bigint[] => {
  const later = shares.slice(1).map((s) => (prize * s) / BigInt(WHOLE));
  return [prize - later.reduce((a, b) => a + b, 0n), ...later];
};

/**
 * Prize per winning ticket per division, and the rollover, by Powerball's
 * rules as `finaliseDraw` applies them: each division gets its (floored)
 * share of the pool; the rollover joins division 1; an unwon division 2..8
 * falls to the next lower division with a winner; an unwon division 1 or 9,
 * rounding remainders, and what the floored shares leave of the pool (at
 * most 8 STAR) roll over.
 */
export const prizesByPowerballRules = (
  pool: bigint,
  carryIn: bigint,
  winners: readonly bigint[],
): { prizes: bigint[]; carry: bigint } => {
  const prizes: bigint[] = [];
  let cascade = 0n;
  let carry = 0n;
  let allocated = 0n;
  POWERBALL_SHARES_BP.forEach((bp, j) => {
    const share = (pool * BigInt(bp)) / BigInt(WHOLE);
    allocated += share;
    const amount = share + (j === 0 ? carryIn : cascade);
    const w = winners[j];
    if (w > 0n) {
      const per = amount / w;
      prizes.push(per);
      carry += amount - per * w;
      cascade = 0n;
    } else {
      prizes.push(0n);
      if (j === 0 || j === 8) {
        carry += amount;
        cascade = 0n;
      } else cascade = amount;
    }
  });
  return { prizes, carry: carry + (pool - allocated) };
};

/** What a draw's settlement must come to, worked out off-chain from the plain tickets. */
export type ExpectedSettlement = {
  /** Winning games per division (division 1 first). */
  winners: bigint[];
  /** Games sold (a ticket holds one or more). */
  games: bigint;
  sales: bigint;
  fee: bigint;
  /** Sales less the fee (a flat amount per game); the rollover is added to division 1 on top. */
  pool: bigint;
  /** Prize per winning game per division. */
  prizes: bigint[];
  /** Rollover after this draw (into the next draw's jackpot). */
  carry: bigint;
  /** Total owed to each payee address (hex), over all winning tickets. */
  payouts: Map<string, bigint>;
  /** Each ticket's winning games per division, in index order. */
  won: bigint[][];
};

/**
 * The reference settlement: the same rules as `settleBatch`, `finaliseDraw`
 * and `payEntitlement`, from plain tickets, checking every game of every
 * entry. Tests compare the contract with it.
 */
export const expectedSettlement = (
  tickets: readonly TicketPreimage[],
  numbers: number[],
  moonball: number,
  price: bigint,
  feePerGame: bigint,
  carryIn: bigint,
): ExpectedSettlement => {
  const won = tickets.map((t) => gamesByDivisionFor(entryOf(t), numbers, moonball));
  const winners = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((j) => won.reduce((a, w) => a + w[j], 0n));
  const games = tickets.reduce((a, t) => a + BigInt(gamesOf(entryOf(t))), 0n);
  const sales = price * games;
  const fee = feePerGame * games;
  const pool = sales - fee;
  const { prizes, carry } = prizesByPowerballRules(pool, carryIn, winners);
  const payouts = new Map<string, bigint>();
  tickets.forEach((t, i) => {
    const prize = won[i].reduce((a, g, j) => a + g * prizes[j], 0n);
    if (prize === 0n) return;
    const amounts = splitPrize(prize, t.payees.map((p) => p.share));
    t.payees.forEach((p, j) => {
      if (amounts[j] === 0n) return;
      const k = hex(p.address.bytes);
      payouts.set(k, (payouts.get(k) ?? 0n) + amounts[j]);
    });
  });
  return { winners, games, sales, fee, pool, prizes, carry, payouts, won };
};
