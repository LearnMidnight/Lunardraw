import { webcrypto } from 'node:crypto';
import type { Payee, TicketPreimage } from './managed/settlement/contract/index.js';
import { checkLine, divisionFor, SHARES_BP, type PlainLine } from './tickets.js';

/** Up to three payees per ticket (a syndicate). */
export const MAX_PAYEES = 3;
/** Shares are in basis points: 10000 is the whole prize. */
export const WHOLE = 10_000;

/** A payee as plain values: a 32-byte unshielded address and a share in basis points. */
export type PlainPayee = { address: Uint8Array; share: number };

const NO_PAYEE: Payee = { address: { bytes: new Uint8Array(32) }, share: 0n };

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
    if (p.address.length !== 32) throw new Error('an address is 32 bytes');
  }
  if (list.reduce((a, p) => a + p.share, 0) !== WHOLE) throw new Error('shares must add up to 10000');
  const out: Payee[] = list.map((p) => ({ address: { bytes: p.address }, share: BigInt(p.share) }));
  while (out.length < MAX_PAYEES) out.push(NO_PAYEE);
  return {
    drawId: BigInt(drawId),
    line: { numbers: sorted.numbers.map(BigInt), moonball: BigInt(sorted.moonball) },
    payees: out,
    salt: salt ?? webcrypto.getRandomValues(new Uint8Array(32)),
  };
};

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

/** What a draw's settlement must come to, worked out off-chain from the plain tickets. */
export type ExpectedSettlement = {
  /** Winning tickets per division (division 1 first). */
  winners: bigint[];
  sales: bigint;
  fee: bigint;
  pool: bigint;
  /** Prize per winning ticket per division. */
  prizes: bigint[];
  /** Rollover after this draw. */
  carry: bigint;
  /** Total owed to each payee address (hex), over all winning tickets. */
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
  feeShare: bigint,
  carryIn: bigint,
): ExpectedSettlement => {
  const divisions = tickets.map((t) => divisionFor(lineOf(t), numbers, moonball));
  const winners = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => BigInt(divisions.filter((x) => x === d).length));
  const sales = price * BigInt(tickets.length);
  const fee = (sales * feeShare) / BigInt(WHOLE);
  const pool = sales - fee + carryIn;
  const prizes = SHARES_BP.map((bp, i) => (winners[i] === 0n ? 0n : (pool * BigInt(bp)) / BigInt(WHOLE) / winners[i]));
  const paid = prizes.reduce((acc, p, i) => acc + p * winners[i], 0n);
  const payouts = new Map<string, bigint>();
  tickets.forEach((t, i) => {
    if (divisions[i] === 0) return;
    const amounts = splitPrize(prizes[divisions[i] - 1], t.payees.map((p) => p.share));
    t.payees.forEach((p, j) => {
      if (amounts[j] === 0n) return;
      const k = hex(p.address.bytes);
      payouts.set(k, (payouts.get(k) ?? 0n) + amounts[j]);
    });
  });
  return { winners, sales, fee, pool, prizes, carry: pool - paid, payouts, divisions };
};
