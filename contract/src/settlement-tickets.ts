import { webcrypto } from 'node:crypto';
import type { Payee, TicketPreimage } from './managed/settlement/contract/index.js';
import { checkLine, divisionFor, quickPick, type PlainLine } from './tickets.js';

/**
 * Division shares of the prize pool in basis points (division 1 first):
 * Australian Powerball's published allocation (The Lott, from draw 1410).
 */
export const POWERBALL_SHARES_BP = [3350, 185, 230, 200, 150, 940, 730, 1550, 2665] as const;

/** Up to three payees per ticket (a syndicate). */
export const MAX_PAYEES = 3;
/** Shares are in basis points: 10000 is the whole prize. */
export const WHOLE = 10_000;

/**
 * A payee as plain values: a 32-byte unshielded address, or a syndicate id,
 * with a share in basis points.
 */
export type PlainPayee = { address?: Uint8Array; syndicate?: number | bigint; share: number };

const ZERO_ADDRESS = new Uint8Array(32);
const NO_PAYEE: Payee = { address: { bytes: ZERO_ADDRESS }, share: 0n, syndicate: 0n };

/** The payees of a syndicate's own ticket: the syndicate, for all of it. */
export const syndicatePayees = (syndicate: number | bigint): PlainPayee[] => [{ syndicate, share: WHOLE }];

/**
 * Build a Starfall ticket (one line) for draw `drawId`, paid to `payees`: a
 * single address (the whole prize) or up to three payees whose shares add up
 * to 10000. Numbers may be in any order. `salt` defaults to 32 random bytes.
 * The buyer doesn't need to keep it: the settlement key holder decrypts the
 * ticket from the chain, and refunds go to the address given at purchase.
 */
export const makeTicket = (
  drawId: number | bigint,
  line: PlainLine,
  payees: Uint8Array | PlainPayee[],
  salt?: Uint8Array,
): TicketPreimage => {
  const sorted = { numbers: [...line.numbers].sort((a, b) => a - b), moonball: line.moonball };
  checkLine(sorted);
  const list = payees instanceof Uint8Array ? [{ address: payees, share: WHOLE }] : payees;
  if (list.length < 1 || list.length > MAX_PAYEES) throw new Error(`a ticket has 1 to ${MAX_PAYEES} payees`);
  for (const p of list) {
    if (!Number.isInteger(p.share) || p.share < 1 || p.share > WHOLE) throw new Error('each share is 1..10000 basis points');
    if (p.syndicate !== undefined && p.syndicate !== 0 && p.syndicate !== 0n) {
      if (p.address !== undefined) throw new Error('a syndicate payee has no address');
    } else if (p.address === undefined || p.address.length !== 32) throw new Error('an address is 32 bytes');
  }
  if (list.reduce((a, p) => a + p.share, 0) !== WHOLE) throw new Error('shares must add up to 10000');
  const out: Payee[] = list.map((p) => ({
    address: { bytes: p.address ?? ZERO_ADDRESS },
    share: BigInt(p.share),
    syndicate: BigInt(p.syndicate ?? 0),
  }));
  while (out.length < MAX_PAYEES) out.push(NO_PAYEE);
  return {
    drawId: BigInt(drawId),
    line: { numbers: sorted.numbers.map(BigInt), moonball: BigInt(sorted.moonball) },
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

/** A ticket with every field zero: fills the unused slots of a draw's last settlement batch. */
export const emptyTicket = (drawId: bigint): TicketPreimage => ({
  drawId,
  line: { numbers: [0n, 0n, 0n, 0n, 0n, 0n, 0n], moonball: 0n },
  payees: [NO_PAYEE, NO_PAYEE, NO_PAYEE],
  salt: new Uint8Array(32),
});

/** A ticket's line as plain numbers. */
export const lineOf = (t: TicketPreimage): PlainLine => ({
  numbers: t.line.numbers.map(Number),
  moonball: Number(t.line.moonball),
});

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
 * rules as `finaliseDraw` applies them: each division gets its share of the
 * pool; the rollover joins division 1; an unwon division 2..8 falls to the
 * next lower division with a winner; an unwon division 1 or 9 and rounding
 * remainders roll over.
 */
export const prizesByPowerballRules = (
  pool: bigint,
  carryIn: bigint,
  winners: readonly bigint[],
): { prizes: bigint[]; carry: bigint } => {
  const prizes: bigint[] = [];
  let cascade = 0n;
  let carry = 0n;
  POWERBALL_SHARES_BP.forEach((bp, j) => {
    const amount = (pool * BigInt(bp)) / BigInt(WHOLE) + (j === 0 ? carryIn : cascade);
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
  return { prizes, carry };
};

/** What a draw's settlement must come to, worked out off-chain from the plain tickets. */
export type ExpectedSettlement = {
  /** Winning tickets per division (division 1 first). */
  winners: bigint[];
  sales: bigint;
  fee: bigint;
  /** Sales less the fee (a flat amount per game); the rollover is added to division 1 on top. */
  pool: bigint;
  /** Prize per winning ticket per division. */
  prizes: bigint[];
  /** Rollover after this draw (into the next draw's jackpot). */
  carry: bigint;
  /** Total owed to each payee address (hex) or syndicate ("syndicate:<id>"), over all winning tickets. */
  payouts: Map<string, bigint>;
  /** Division of each ticket, in index order (0 for no prize). */
  divisions: number[];
};

/**
 * The reference settlement: the same rules as `settleBatch`, `finaliseDraw`
 * and `payEntitlement`, from plain tickets. Tests compare the contract with it.
 */
export const expectedSettlement = (
  tickets: readonly TicketPreimage[],
  numbers: number[],
  moonball: number,
  price: bigint,
  feePerGame: bigint,
  carryIn: bigint,
): ExpectedSettlement => {
  const divisions = tickets.map((t) => divisionFor(lineOf(t), numbers, moonball));
  const winners = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => BigInt(divisions.filter((x) => x === d).length));
  const sales = price * BigInt(tickets.length);
  const fee = feePerGame * BigInt(tickets.length);
  const pool = sales - fee;
  const { prizes, carry } = prizesByPowerballRules(pool, carryIn, winners);
  const payouts = new Map<string, bigint>();
  tickets.forEach((t, i) => {
    if (divisions[i] === 0) return;
    const amounts = splitPrize(prizes[divisions[i] - 1], t.payees.map((p) => p.share));
    t.payees.forEach((p, j) => {
      if (amounts[j] === 0n) return;
      // A syndicate's part is keyed "syndicate:<id>"; its members' shares are worked out separately.
      const k = p.syndicate !== 0n ? `syndicate:${p.syndicate}` : hex(p.address.bytes);
      payouts.set(k, (payouts.get(k) ?? 0n) + amounts[j]);
    });
  });
  return { winners, sales, fee, pool, prizes, carry, payouts, divisions };
};

/**
 * A member's part of an amount owed to its syndicate, as the contract pays
 * it: floor(amount x shares / sold), where `sold` is the shares actually
 * sold (all of them once the syndicate is funded).
 */
export const memberPart = (amount: bigint, shares: bigint, sold: bigint): bigint => (amount * shares) / sold;
