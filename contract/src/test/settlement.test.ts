import { webcrypto } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { generateOracleSecretKey, generateOperatorSecret, pureCircuits as nightcast } from '@nightcast/contract';
import { combineDrawSeed, drawStarfall, seedCommitment } from '@nightcast/sdk';
import { DrawStatus, pureCircuits, SyndicateStatus, type TicketPreimage } from '../managed/settlement/contract/index.js';
import { SettlementSimulator } from '../settlement-simulator.js';
import {
  expectedSettlement,
  makeTicket,
  POWERBALL_SHARES_BP,
  prizesByPowerballRules,
  memberPart,
  QUICK_PICK_PACKAGES,
  quickPickPackage,
  syndicatePayees,
  randomScalar,
  splitPrize,
  WHOLE,
} from '../settlement-tickets.js';
import { quickPick, type PlainLine } from '../tickets.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const bytes = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).slice(0, 32));
  return out;
};
const randomAddress = (): Uint8Array => webcrypto.getRandomValues(new Uint8Array(32));

const FEE = 200_000n; // 0.2 tNIGHT per game, to the operator
const PRIZE = 1_000_000n; // 1 tNIGHT per game, to the prize pool
const PRICE = PRIZE + FEE; // 1.2 tNIGHT: what a player pays per game
const SETTLE = 86_400n;
const SALES = 3_600;
const BATCH = Number(pureCircuits.batchSize());
const OPERATOR = bytes('operator wallet');

const setup = (opts: { feePerGame?: bigint } = {}) => {
  const oracleSecretKey = generateOracleSecretKey();
  const settlementSecret = randomScalar();
  const sim = new SettlementSimulator({
    oracleSecretKey,
    organiserSecret: generateOperatorSecret(),
    settlementSecret,
    operator: OPERATOR,
    feePerGame: opts.feePerGame ?? FEE,
    ticketPrice: PRICE,
    minSales: 600n,
    maxSales: 30n * 86_400n,
    revealWindow: 3_600n,
    drawWindow: 3_600n,
    settleWindow: SETTLE,
  });
  return { sim, oracleSecretKey, settlementSecret };
};

/** Open the next draw; returns its number, seed and the numbers it will draw. */
const openWithSeed = (sim: SettlementSimulator, sk: bigint, label = `seed ${sim.getLedger().lastDraw + 1n}`) => {
  const seed = bytes(label);
  const n = sim.openDraw(BigInt(sim.now + SALES), fromHex(seedCommitment(hex(seed))));
  const draw = drawStarfall(combineDrawSeed(hex(seed), nightcast.evaluate(sk, sim.alphaOf(n, seed)))) as {
    numbers: number[];
    moonball: number;
  };
  return { n, seed, draw };
};

/** Close sales and run the draw up to its numbers. */
const drawIt = (sim: SettlementSimulator, n: bigint, seed: Uint8Array) => {
  sim.advance(SALES + 1);
  sim.requestDraw(n, seed);
  sim.fulfilDraw(n);
  return sim.computeNumbers(n);
};

/** A line hitting exactly `match` main numbers, with or without the Moonball. */
const lineHitting = (numbers: number[], moonball: number, match: number, withMoonball: boolean): PlainLine => {
  const hits = numbers.slice(0, match);
  const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !numbers.includes(x)).slice(0, 7 - match);
  return { numbers: [...hits, ...misses], moonball: withMoonball ? moonball : (moonball % 20) + 1 };
};

/** A line that wins nothing (no Moonball, at most one main number). */
const losingLine = (numbers: number[], moonball: number): PlainLine => lineHitting(numbers, moonball, 1, false);

type Bought = { ticket: TicketPreimage; refundTo: Uint8Array };

/** Buy every ticket, each refundable to its own random address. */
const buyAll = (sim: SettlementSimulator, tickets: TicketPreimage[]): Bought[] =>
  tickets.map((ticket) => {
    const refundTo = randomAddress();
    sim.buyTicket(ticket, refundTo);
    return { ticket, refundTo };
  });

/** Sum a list of payments per recipient. */
const totals = (payments: { to: string; amount: bigint }[]): Map<string, bigint> => {
  const m = new Map<string, bigint>();
  for (const p of payments) m.set(p.to, (m.get(p.to) ?? 0n) + p.amount);
  return m;
};

const sortedEntries = (m: Map<string, bigint>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));

describe('sealed tickets', () => {
  it('only the settlement key opens a ticket, and it opens to exactly what was bought', () => {
    const { sim, oracleSecretKey, settlementSecret } = setup();
    const { n, draw } = openWithSeed(sim, oracleSecretKey);
    const syndicate = [
      { address: randomAddress(), share: 5000 },
      { address: randomAddress(), share: 3000 },
      { address: randomAddress(), share: 2000 },
    ];
    const t = makeTicket(n, lineHitting(draw.numbers, draw.moonball, 3, true), syndicate);
    const c = sim.buyTicket(t, randomAddress());
    const rec = sim.getLedger().tickets.lookup(pureCircuits.ticketKey(n, 0n));
    expect(hex(rec.commitment)).toBe(hex(c));
    expect(hex(c)).toBe(hex(sim.commitmentOf(t)));

    const opened = pureCircuits.openTicket(settlementSecret, n, rec.cipher);
    expect(opened.line.numbers).toEqual(t.line.numbers);
    expect(opened.line.moonball).toBe(t.line.moonball);
    expect(opened.payees.map((p) => [hex(p.address.bytes), p.share])).toEqual(
      t.payees.map((p) => [hex(p.address.bytes), p.share]),
    );
    expect(hex(opened.salt)).toBe(hex(t.salt));
    expect(hex(sim.commitmentOf(opened))).toBe(hex(c));

    // Another key gets noise: it doesn't even decode to a ticket.
    expect(() => pureCircuits.openTicket(randomScalar(), n, rec.cipher)).toThrow(/range error/);

    // Nothing public carries the numbers: the record holds the commitment, the
    // ciphertext and the refund address only.
    expect(Object.keys(rec).sort()).toEqual(['cipher', 'commitment', 'refundTo', 'refunded', 'syndicate']);
  });

  it('rejects invalid tickets and duplicates, and closes with sales', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    const good = makeTicket(n, quickPick(), me);
    sim.buyTicket(good, me);
    expect(() => sim.buyTicket(good, me)).toThrow(/already bought/);

    const badShares = { ...makeTicket(n, quickPick(), me) };
    badShares.payees = [{ ...badShares.payees[0], share: 9000n }, badShares.payees[1], badShares.payees[2]];
    expect(() => sim.buyTicket(badShares, me)).toThrow(/invalid ticket/);

    const untidy = makeTicket(n, quickPick(), me);
    untidy.payees = [untidy.payees[0], { address: { bytes: randomAddress() }, share: 0n, syndicate: 0n }, untidy.payees[2]];
    expect(() => sim.buyTicket(untidy, me)).toThrow(/invalid ticket/);
    // An ordinary purchase can't name a syndicate as payee.
    const synd = makeTicket(n, quickPick(), [{ syndicate: 1, share: 10_000 }]);
    expect(() => sim.buyTicket(synd, me)).toThrow(/invalid ticket/);
    expect(() => sim.buyTicket(untidy, me)).toThrow(/invalid ticket/);

    const badLine = makeTicket(n, quickPick(), me);
    badLine.line = { numbers: [1n, 2n, 3n, 4n, 5n, 6n, 36n], moonball: 1n };
    expect(() => sim.buyTicket(badLine, me)).toThrow(/invalid ticket/);

    const unordered = makeTicket(n, quickPick(), me);
    unordered.line = { numbers: [2n, 1n, 3n, 4n, 5n, 6n, 7n], moonball: 1n };
    expect(() => sim.buyTicket(unordered, me)).toThrow(/invalid ticket/);

    expect(() => sim.buyTicket(makeTicket(n + 1n, quickPick(), me), me)).toThrow(/unknown draw/);
    sim.advance(SALES + 1);
    expect(() => sim.buyTicket(makeTicket(n, quickPick(), me), me)).toThrow(/sales have closed/);
    expect(sim.ticketsSold(n)).toBe(1n);
  });
});

describe('multi-game purchases', () => {
  it('buys a QuickPick package four games at a time, each game a ticket of its own', () => {
    const { sim, oracleSecretKey, settlementSecret } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    const games = quickPickPackage(n, 'regular', me);
    expect(games.length).toBe(12);
    expect(sim.buyPackage(games, me)).toBe(3);
    expect(sim.ticketsSold(n)).toBe(12n);
    const opened = sim.decryptDrawTickets(n, settlementSecret);
    expect(opened.map((t) => hex(sim.commitmentOf(t)))).toEqual(games.map((t) => hex(sim.commitmentOf(t))));
    for (const [, r] of sim.getLedger().tickets) expect(hex(r.refundTo.bytes)).toBe(hex(me));

    // Mixed with single purchases, indexes stay sequential.
    sim.buyTicket(makeTicket(n, quickPick(), me), me);
    expect(sim.buyTickets([makeTicket(n, quickPick(), me), makeTicket(n, quickPick(), me)], me)).toBe(2n);
    expect(sim.ticketsSold(n)).toBe(15n);
    expect(sim.decryptDrawTickets(n, settlementSecret).length).toBe(15);
  });

  it('rejects too many games, a bad game in the set, a duplicate, and a mixed draw', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    const five = Array.from({ length: 5 }, () => makeTicket(n, quickPick(), me));
    expect(() => sim.buyTickets(five, me)).toThrow(/games per purchase/);
    const bad = [makeTicket(n, quickPick(), me), makeTicket(n, quickPick(), me)];
    bad[1] = { ...bad[1], line: { numbers: [1n, 1n, 2n, 3n, 4n, 5n, 6n], moonball: 1n } };
    expect(() => sim.buyTickets(bad, me)).toThrow(/invalid ticket/);
    const dup = makeTicket(n, quickPick(), me);
    expect(() => sim.buyTickets([dup, dup], me)).toThrow(/already bought/);
    const mixed = [makeTicket(n, quickPick(), me), makeTicket(n + 1n, quickPick(), me)];
    expect(() => sim.buyTickets(mixed, me)).toThrow(/invalid ticket/);
    expect(sim.ticketsSold(n)).toBe(0n);
    expect(Object.keys(QUICK_PICK_PACKAGES)).toEqual(['single', 'starter', 'mini', 'regular', 'super', 'mega', 'jumbo', 'maxi']);
  });
});

describe('settling 100 private tickets', () => {
  /**
   * 100 tickets: winners in every division (some shared with a syndicate, two
   * jackpot winners splitting division 1), the rest quick picks that may or
   * may not win. Returns everything needed to check the result.
   */
  const hundred = () => {
    const { sim, oracleSecretKey, settlementSecret } = setup();
    const { n, seed, draw } = openWithSeed(sim, oracleSecretKey);
    const { numbers, moonball } = draw;
    const crafted: [number, boolean][] = [
      [7, true], [7, true], [7, false], [6, true], [6, false], [5, true], [4, true], [5, false], [3, true], [2, true],
      [3, true], [2, true], [2, true], [6, false],
    ];
    const tickets: TicketPreimage[] = [];
    crafted.forEach(([m, mb], i) => {
      const payees =
        i % 3 === 0
          ? [
              { address: randomAddress(), share: 4000 },
              { address: randomAddress(), share: 3333 },
              { address: randomAddress(), share: 2667 },
            ]
          : i % 3 === 1
            ? [
                { address: randomAddress(), share: 9999 },
                { address: randomAddress(), share: 1 },
              ]
            : randomAddress();
      tickets.push(makeTicket(n, lineHitting(numbers, moonball, m, mb), payees));
    });
    while (tickets.length < 100) tickets.push(makeTicket(n, quickPick(), randomAddress()));
    // Shuffle so winners land in every batch, not just the first.
    for (let i = tickets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tickets[i], tickets[j]] = [tickets[j], tickets[i]];
    }
    const bought = buyAll(sim, tickets);
    return { sim, n, seed, draw, tickets, bought, settlementSecret };
  };

  it('counts every winner, pays every payee exactly, and sets aside the fee and rollover', () => {
    const { sim, n, seed, draw, tickets } = hundred();
    expect(sim.ticketsSold(n)).toBe(100n);
    const nums = drawIt(sim, n, seed);
    expect(nums.main.map(Number)).toEqual(draw.numbers);

    const expected = expectedSettlement(tickets, draw.numbers, draw.moonball, PRICE, FEE, 0n);
    expect(expected.winners[0]).toBe(2n); // the two crafted jackpot winners
    expect(expected.winners.every((w) => w > 0n)).toBe(true);

    sim.payments = sim.payments === undefined ? undefined : [];
    const batches = sim.settleAll(n);
    expect(batches).toBe(Math.ceil(100 / BATCH));

    const l = sim.getLedger();
    const p = l.progress.lookup(n);
    expect(p.next).toBe(100n);
    expect(p.winners).toEqual(expected.winners);
    const d = l.draws.lookup(n);
    expect(d.status).toBe(DrawStatus.settled);
    expect(d.fee).toBe(expected.fee);
    expect(d.prizes).toEqual(expected.prizes);
    expect(l.carry).toBe(expected.carry);
    expect(l.feesOwed).toBe(expected.fee);

    // One entitlement per winning ticket, with the payees that ticket named, all paid.
    const winning = tickets.filter((_, i) => expected.divisions[i] !== 0);
    const ents = [...l.entitlements].map(([, e]) => e).filter((e) => e.drawId === n);
    expect(ents.length).toBe(winning.length);
    expect(ents.every((e) => e.paid)).toBe(true);
    const key = (division: bigint, payees: { address: { bytes: Uint8Array }; share: bigint }[]) =>
      `${division}:${payees.map((x) => `${hex(x.address.bytes)}/${x.share}`).join(',')}`;
    expect(ents.map((e) => key(e.division, e.payees)).sort()).toEqual(
      winning.map((t) => key(BigInt(expected.divisions[tickets.indexOf(t)]), t.payees)).sort(),
    );

    // Every STAR of sales is accounted for: fee + prizes paid + rollover.
    const paid = expected.prizes.reduce((a, prize, i) => a + prize * expected.winners[i], 0n);
    expect(expected.fee + paid + l.carry).toBe(expected.sales);
    // With winners in every division nothing cascades: each prize is its division's share.
    expected.prizes.forEach((prize, i) => {
      expect(prize).toBe((expected.pool * BigInt(POWERBALL_SHARES_BP[i])) / 10_000n / expected.winners[i]);
    });

    // The payments made match the reference to the STAR (when the runtime reports them).
    if (sim.payments !== undefined) {
      expect(sortedEntries(totals(sim.payments))).toEqual(sortedEntries(expected.payouts));
    }

    // Fees go to the operator, once.
    expect(sim.withdrawFees()).toBe(expected.fee);
    expect(sim.getLedger().feesOwed).toBe(0n);
    expect(sim.withdrawFees()).toBe(0n);
  });

  it("splits a syndicate's prize by its shares, with the remainder to the first payee", () => {
    expect(splitPrize(1_000_003n, [4000n, 3333n, 2667n])).toEqual([400_003n, 333_300n, 266_700n]);
    expect(splitPrize(7n, [9999n, 1n, 0n])).toEqual([7n, 0n, 0n]);
    for (const prize of [0n, 1n, 99_999n, 123_456_789n]) {
      const parts = splitPrize(prize, [4000n, 3333n, 2667n]);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(prize);
    }
    expect(WHOLE).toBe(10_000);
  });

  it("doesn't reveal which ticket won: entitlement ids can't be matched to purchases", () => {
    const { sim, n, seed, tickets } = hundred();
    const before = [...sim.getLedger().tickets].map(([k, r]) => [k, hex(r.commitment)]);
    drawIt(sim, n, seed);
    sim.settleAll(n);
    const l = sim.getLedger();
    const commitments = new Set(tickets.map((t) => hex(sim.commitmentOf(t))));
    for (const [id] of l.entitlements) expect(commitments.has(hex(id))).toBe(false);
    // Settlement changes nothing in the public ticket records.
    expect([...l.tickets].map(([k, r]) => [k, hex(r.commitment)])).toEqual(before);
    for (const [, r] of l.tickets) expect(r.refunded).toBe(false);
  });

  it('works for any batch boundary: 1, a full batch, and a full batch plus one', () => {
    for (const count of [1, BATCH, BATCH + 1]) {
      const { sim, oracleSecretKey } = setup();
      const { n, seed, draw } = openWithSeed(sim, oracleSecretKey);
      const tickets = Array.from({ length: count }, (_, i) =>
        makeTicket(n, i === 0 ? lineHitting(draw.numbers, draw.moonball, 4, true) : quickPick(), randomAddress()),
      );
      buyAll(sim, tickets);
      drawIt(sim, n, seed);
      expect(sim.settleAll(n)).toBe(Math.ceil(count / BATCH));
      const expected = expectedSettlement(tickets, draw.numbers, draw.moonball, PRICE, FEE, 0n);
      expect(sim.getLedger().progress.lookup(n).winners).toEqual(expected.winners);
      expect(sim.getLedger().draws.lookup(n).prizes).toEqual(expected.prizes);
    }
  });
});

describe('settlement fails safely', () => {
  const ready = (count = 60) => {
    const { sim, oracleSecretKey, settlementSecret } = setup();
    const { n, seed, draw } = openWithSeed(sim, oracleSecretKey);
    const tickets = Array.from({ length: count }, (_, i) =>
      makeTicket(n, i % 7 === 0 ? lineHitting(draw.numbers, draw.moonball, 3, true) : quickPick(), randomAddress()),
    );
    const bought = buyAll(sim, tickets);
    return { sim, n, seed, draw, tickets, bought, settlementSecret };
  };

  it("can't settle before the numbers are drawn", () => {
    const { sim, n, seed, tickets } = ready();
    expect(() => sim.settleBatch(n, tickets)).toThrow(/not drawn/);
    sim.advance(SALES + 1);
    sim.requestDraw(n, seed);
    expect(() => sim.settleBatch(n, tickets)).toThrow(/not drawn/);
    sim.fulfilDraw(n);
    expect(() => sim.settleBatch(n, tickets)).toThrow(/not drawn/);
  });

  it('rejects a forged ticket: winning numbers swapped into a real ticket', () => {
    const { sim, n, seed, draw, tickets } = ready();
    drawIt(sim, n, seed);
    const forged = tickets.map((t) => ({ ...t }));
    forged[3] = { ...forged[3], line: { numbers: draw.numbers.map(BigInt), moonball: BigInt(draw.moonball) } };
    expect(() => sim.settleBatch(n, forged)).toThrow(/does not match its commitment/);
    // Paying the forger instead doesn't work either.
    const redirected = tickets.map((t) => ({ ...t }));
    redirected[5] = { ...redirected[5], payees: [{ address: { bytes: randomAddress() }, share: 10_000n, syndicate: 0n }, ...redirected[5].payees.slice(1)] };
    expect(() => sim.settleBatch(n, redirected)).toThrow(/does not match its commitment/);
    expect(sim.getLedger().progress.lookup(n).next).toBe(0n);
  });

  it('rejects tickets out of order, left out, or counted twice', () => {
    const { sim, n, seed, tickets } = ready();
    drawIt(sim, n, seed);
    const swapped = [...tickets];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(() => sim.settleBatch(n, swapped)).toThrow(/does not match its commitment/);
    const missing = tickets.filter((_, i) => i !== 10);
    expect(() => sim.settleBatch(n, missing)).toThrow(/does not match its commitment/);
    const twice = [tickets[0], ...tickets];
    expect(() => sim.settleBatch(n, twice)).toThrow(/does not match its commitment/);
    // A later batch can't repeat the first batch's tickets either.
    sim.settleBatch(n, tickets);
    expect(sim.getLedger().progress.lookup(n).next).toBe(BigInt(BATCH));
    expect(() => sim.settleBatch(n, [...tickets.slice(0, BATCH), ...tickets.slice(0, BATCH)])).toThrow(
      /does not match its commitment/,
    );
  });

  it("a settler without the settlement key can't settle", () => {
    const { sim, n, seed } = ready();
    drawIt(sim, n, seed);
    expect(() => sim.decryptDrawTickets(n, randomScalar())).toThrow(/range error/);
    // Guessing at the tickets instead doesn't help.
    const guessed = Array.from({ length: 60 }, () => makeTicket(n, quickPick(), randomAddress()));
    expect(() => sim.settleBatch(n, guessed)).toThrow(/does not match its commitment/);
  });

  it("can't finalise until every ticket is settled, or settle past the end", () => {
    const { sim, n, seed, tickets } = ready();
    drawIt(sim, n, seed);
    expect(() => sim.finaliseDraw(n)).toThrow(/not every ticket is settled/);
    sim.settleBatch(n, tickets);
    expect(() => sim.finaliseDraw(n)).toThrow(/not every ticket is settled/);
    while (sim.getLedger().progress.lookup(n).next < BigInt(tickets.length)) sim.settleBatch(n, tickets);
    expect(() => sim.settleBatch(n, tickets)).toThrow(/already settled/);
    expect(() => sim.payEntitlement(sim.entitlementsOf(n)[0])).toThrow(/not finalised/);
    sim.finaliseDraw(n);
    expect(() => sim.finaliseDraw(n)).toThrow(/not drawn/);
  });

  it('pays each entitlement once', () => {
    const { sim, n, seed } = ready();
    drawIt(sim, n, seed);
    sim.settleAll(n);
    const [first] = sim.entitlementsOf(n);
    expect(() => sim.payEntitlement(first)).toThrow(/already paid/);
    expect(() => sim.payEntitlement(bytes('no such entitlement'))).toThrow(/unknown entitlement/);
  });

  it("voids an unsettled draw at the deadline and refunds every ticket to its buyer's address", () => {
    const { sim, n, seed, tickets, bought } = ready();
    drawIt(sim, n, seed);
    sim.settleBatch(n, tickets);
    expect(() => sim.voidDraw(n)).toThrow(/can't be voided/);
    sim.advance(Number(SETTLE) + 1);
    expect(() => sim.settleBatch(n, tickets)).toThrow(/deadline has passed/);
    expect(() => sim.finaliseDraw(n)).toThrow(/deadline has passed/);
    sim.voidDraw(n);
    expect(sim.getLedger().draws.lookup(n).status).toBe(DrawStatus.voided);
    // Nothing is paid from a void draw, even entitlements recorded before the deadline.
    for (const id of sim.entitlementsOf(n)) expect(() => sim.payEntitlement(id)).toThrow(/not finalised/);

    sim.payments = sim.payments === undefined ? undefined : [];
    for (let i = 0n; i < BigInt(tickets.length); i++) sim.refundTicket(n, i);
    expect(() => sim.refundTicket(n, 0n)).toThrow(/already refunded/);
    expect(() => sim.refundTicket(n, BigInt(tickets.length))).toThrow(/unknown ticket/);
    for (const [, r] of sim.getLedger().tickets) expect(r.refunded).toBe(true);
    if (sim.payments !== undefined) {
      const want = new Map(bought.map((b) => [hex(b.refundTo), PRICE]));
      expect(sortedEntries(totals(sim.payments))).toEqual(sortedEntries(want));
    }
    // The rollover is untouched by a void draw.
    expect(sim.getLedger().carry).toBe(0n);
  });

  it('voids a draw whose numbers were never computed, and never one that is settled', () => {
    const { sim, oracleSecretKey } = setup();
    const a = openWithSeed(sim, oracleSecretKey, 'uncomputed');
    sim.buyTicket(makeTicket(a.n, quickPick(), randomAddress()), randomAddress());
    sim.advance(SALES + 1);
    sim.requestDraw(a.n, a.seed);
    sim.fulfilDraw(a.n);
    expect(() => sim.voidDraw(a.n)).toThrow(/can't be voided/);
    sim.advance(2 * 3_600 + Number(SETTLE) + 1);
    expect(() => sim.computeNumbers(a.n)).toThrow(/too late/);
    sim.voidDraw(a.n);

    const b = openWithSeed(sim, oracleSecretKey, 'settled');
    sim.buyTicket(makeTicket(b.n, quickPick(), randomAddress()), randomAddress());
    drawIt(sim, b.n, b.seed);
    sim.settleAll(b.n);
    sim.advance(Number(SETTLE) + 1);
    expect(() => sim.voidDraw(b.n)).toThrow(/can't be voided/);
    expect(() => sim.refundTicket(b.n, 0n)).toThrow(/not void/);
  });
});

describe('syndicates', () => {
  const CREATOR = bytes('syndicate creator secret');
  /** A syndicate of 20 shares at 10 tickets' worth, for 200 games: funding = 200 x price. */
  const open = (sim: SettlementSimulator, n: bigint, games = 200n, shares = 20n) => {
    const sharePrice = (PRICE * games) / shares;
    return {
      sid: sim.createSyndicate(n, CREATOR, sharePrice, shares, games, BigInt(sim.now + SALES / 2)),
      sharePrice,
    };
  };
  const memberSet = () => [
    { who: 'human A', payTo: randomAddress(), shares: 5n },
    { who: 'human B', payTo: randomAddress(), shares: 3n },
    { who: 'agent A', payTo: randomAddress(), shares: 4n },
    { who: 'agent B', payTo: randomAddress(), shares: 2n },
    { who: 'others', payTo: randomAddress(), shares: 6n },
  ];

  it('fills, buys its games from its own funds, and pays members in proportion to their shares', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed, draw } = openWithSeed(sim, oracleSecretKey);
    const { sid, sharePrice } = open(sim, n, 8n, 20n);
    const ms = memberSet();
    sim.payments = sim.payments === undefined ? undefined : [];
    ms.forEach((m, i) => expect(sim.joinSyndicate(sid, m.shares, m.payTo)).toBe(BigInt(i)));
    const sy = sim.getLedger().syndicates.lookup(sid);
    expect(sy.status).toBe(SyndicateStatus.funded);
    expect(sy.sold).toBe(20n);
    expect(sy.members).toBe(5n);

    // Only the creator buys, only for the syndicate, only as many games as it funded.
    const games = [
      makeTicket(n, lineHitting(draw.numbers, draw.moonball, 7, true), syndicatePayees(sid)), // the jackpot
      makeTicket(n, lineHitting(draw.numbers, draw.moonball, 3, true), syndicatePayees(sid)),
      ...Array.from({ length: 6 }, () => makeTicket(n, losingLine(draw.numbers, draw.moonball), syndicatePayees(sid))),
    ];
    expect(() => sim.buySyndicateTickets(sid, bytes('impostor'), games.slice(0, 4))).toThrow(/not the syndicate's creator/);
    const own = makeTicket(n, quickPick(), randomAddress());
    expect(() => sim.buySyndicateTickets(sid, CREATOR, [own])).toThrow(/invalid syndicate ticket/);
    expect(sim.buySyndicateTickets(sid, CREATOR, games.slice(0, 4))).toBe(4n);
    expect(sim.buySyndicateTickets(sid, CREATOR, games.slice(4, 8))).toBe(4n);
    expect(() => sim.buySyndicateTickets(sid, CREATOR, [games[0]])).toThrow(/more games than the syndicate funded/);
    expect(sim.ticketsSold(n)).toBe(8n);
    // Buying took no money: the members' contributions paid for the games.
    if (sim.payments !== undefined) expect(sim.payments).toEqual([]);
    for (const [, r] of sim.getLedger().tickets) expect(r.syndicate).toBe(sid);

    // A few outside tickets, then the draw and settlement.
    const others = Array.from({ length: 12 }, () => makeTicket(n, quickPick(), randomAddress()));
    buyAll(sim, others);
    drawIt(sim, n, seed);
    sim.payments = sim.payments === undefined ? undefined : [];
    sim.settleAll(n);

    const expected = expectedSettlement([...games, ...others], draw.numbers, draw.moonball, PRICE, FEE, 0n);
    const owed = expected.payouts.get(`syndicate:${sid}`) ?? 0n;
    expect(owed).toBeGreaterThan(0n);
    expect(owed).toBe(expected.prizes[0] + expected.prizes[7]); // jackpot + division 8, unless a quick pick shared them
    // Each member got floor(owed x shares / 20) per entitlement, to its own address.
    if (sim.payments !== undefined) {
      const got = totals(sim.payments);
      const pots = [expected.prizes[0], expected.prizes[7]].filter((p) => p > 0n);
      for (const m of ms) {
        const want = pots.reduce((a, pot) => a + memberPart(pot, m.shares, 20n), 0n);
        expect(got.get(hex(m.payTo)), m.who).toBe(want);
      }
      // No payment went to the syndicate's zero address.
      expect(got.get(hex(new Uint8Array(32)))).toBeUndefined();
    }
    // Paying a member twice, or someone who isn't one, fails.
    const eid = sim.entitlementsOf(n).find((id) => sim.getLedger().entitlements.lookup(id).payees[0].syndicate === sid)!;
    expect(() => sim.paySyndicateMember(eid, 0n, 0n)).toThrow(/already paid/);
    expect(() => sim.paySyndicateMember(eid, 0n, 5n)).toThrow(/unknown member/);
    expect(() => sim.paySyndicateMember(eid, 1n, 0n)).toThrow(/not a syndicate/);
    // Nothing unspent to refund once sales have closed and every game was bought.
    expect(sim.refundSyndicateUnspent(sid, 0n)).toBe(0n);
    expect(sharePrice * 20n).toBe(PRICE * 8n);
  });

  it('refunds every contribution when the shares do not all sell by the deadline', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const { sid, sharePrice } = open(sim, n, 200n, 20n);
    const ms = memberSet().slice(0, 4); // 14 of 20 shares
    ms.forEach((m) => sim.joinSyndicate(sid, m.shares, m.payTo));
    expect(() => sim.joinSyndicate(sid, 7n, randomAddress())).toThrow(/not that many shares left/);
    expect(() => sim.refundSyndicateUnspent(sid, 0n)).toThrow(/still filling/);
    const game = makeTicket(n, quickPick(), syndicatePayees(sid));
    expect(() => sim.buySyndicateTickets(sid, CREATOR, [game])).toThrow(/not funded/);
    sim.advance(SALES / 2 + 1);
    expect(() => sim.joinSyndicate(sid, 1n, randomAddress())).toThrow(/join deadline has passed/);
    sim.payments = sim.payments === undefined ? undefined : [];
    // Every contribution comes back in full: the refund is shared by shares sold, not shares advertised.
    ms.forEach((m, i) => expect(sim.refundSyndicateUnspent(sid, BigInt(i))).toBe(sharePrice * m.shares));
    expect(() => sim.refundSyndicateUnspent(sid, 0n)).toThrow(/already refunded/);
    if (sim.payments !== undefined) {
      expect(sortedEntries(totals(sim.payments))).toEqual(sortedEntries(new Map(ms.map((m) => [hex(m.payTo), sharePrice * m.shares]))));
    }
  });

  it("refunds what the creator didn't spend, and everything spent if the draw is void", () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    const { sid, sharePrice } = open(sim, n, 8n, 20n);
    const ms = memberSet();
    ms.forEach((m) => sim.joinSyndicate(sid, m.shares, m.payTo));
    // The creator buys only 6 of the 8 games.
    const games = Array.from({ length: 6 }, () => makeTicket(n, quickPick(), syndicatePayees(sid)));
    sim.buySyndicateTickets(sid, CREATOR, games.slice(0, 4));
    sim.buySyndicateTickets(sid, CREATOR, games.slice(4));
    expect(() => sim.refundSyndicateUnspent(sid, 0n)).toThrow(/still filling or buying/);
    // The draw runs, but nobody settles it in time.
    drawIt(sim, n, seed);
    // Unspent funds (2 games' worth) are refundable now that sales have closed.
    const unspent = PRICE * 2n;
    ms.forEach((m, i) => expect(sim.refundSyndicateUnspent(sid, BigInt(i))).toBe(memberPart(unspent, m.shares, 20n)));
    expect(() => sim.refundSyndicateVoid(sid, 0n)).toThrow(/not void/);
    sim.advance(Number(SETTLE) + 1);
    sim.voidDraw(n);
    // The syndicate's tickets are marked refunded but their price stays for the members.
    sim.payments = sim.payments === undefined ? undefined : [];
    for (let i = 0n; i < 6n; i++) sim.refundTicket(n, i);
    if (sim.payments !== undefined) expect(sim.payments).toEqual([]);
    const spent = PRICE * 6n;
    ms.forEach((m, i) => expect(sim.refundSyndicateVoid(sid, BigInt(i))).toBe(memberPart(spent, m.shares, 20n)));
    expect(() => sim.refundSyndicateVoid(sid, 0n)).toThrow(/already refunded/);
    // Altogether each member got back its contribution, less rounding dust.
    for (const m of ms) {
      const back = memberPart(unspent, m.shares, 20n) + memberPart(spent, m.shares, 20n);
      expect(sharePrice * m.shares - back).toBeLessThan(2n);
    }
  });

  it('checks the funding arithmetic and the join deadline when a syndicate is created', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    expect(() => sim.createSyndicate(n, CREATOR, PRICE, 20n, 19n, BigInt(sim.now + 60))).toThrow(/must equal games x ticket price/);
    expect(() => sim.createSyndicate(n, CREATOR, PRICE, 20n, 20n, BigInt(sim.now + SALES + 1))).toThrow(/before sales close/);
    expect(() => sim.createSyndicate(n, CREATOR, PRICE, 20n, 20n, BigInt(sim.now - 1))).toThrow(/join deadline has passed/);
    expect(() => sim.createSyndicate(n, CREATOR, PRICE, 0n, 0n, BigInt(sim.now + 60))).toThrow(/at least one share/);
    expect(sim.createSyndicate(n, CREATOR, PRICE, 20n, 20n, BigInt(sim.now + 60))).toBe(1n);
    expect(sim.createSyndicate(n, CREATOR, PRICE * 2n, 10n, 20n, BigInt(sim.now + 60))).toBe(2n);
  });
});

describe('rolling draws', () => {
  it('rolls unwon divisions into the next draw, finalising in order', () => {
    const { sim, oracleSecretKey } = setup();
    const first = openWithSeed(sim, oracleSecretKey, 'first');
    // Only losing tickets: the whole pool rolls over.
    const losers = Array.from({ length: 30 }, () =>
      makeTicket(first.n, losingLine(first.draw.numbers, first.draw.moonball), randomAddress()),
    );
    buyAll(sim, losers);
    sim.advance(SALES + 1);
    const second = { n: first.n + 1n, seed: bytes('second') };
    sim.requestAndOpenNext(first.n, first.seed, {
      salesClose: BigInt(sim.now + SALES),
      seedCommitment: fromHex(seedCommitment(hex(second.seed))),
    });
    sim.fulfilDraw(first.n);
    sim.computeNumbers(first.n);

    const draw2 = drawStarfall(
      combineDrawSeed(hex(second.seed), nightcast.evaluate(oracleSecretKey, sim.alphaOf(second.n, second.seed))),
    ) as { numbers: number[]; moonball: number };
    const winners2 = [
      makeTicket(second.n, lineHitting(draw2.numbers, draw2.moonball, 7, true), randomAddress()),
      makeTicket(second.n, lineHitting(draw2.numbers, draw2.moonball, 2, true), randomAddress()),
    ];
    buyAll(sim, winners2);
    sim.advance(SALES + 1);
    sim.requestDraw(second.n, second.seed);
    sim.fulfilDraw(second.n);
    sim.computeNumbers(second.n);

    // The second draw can't be finalised before the first.
    sim.settleBatch(second.n);
    expect(() => sim.finaliseDraw(second.n)).toThrow(/previous draw isn't finalised/);

    sim.settleAll(first.n);
    const e1 = expectedSettlement(losers, first.draw.numbers, first.draw.moonball, PRICE, FEE, 0n);
    expect(e1.winners.every((w) => w === 0n)).toBe(true);
    expect(sim.getLedger().carry).toBe(e1.pool);
    expect(e1.pool).toBe(30n * PRICE - e1.fee);

    sim.finaliseDraw(second.n);
    const e2 = expectedSettlement(winners2, draw2.numbers, draw2.moonball, PRICE, FEE, e1.pool);
    const d2 = sim.getLedger().draws.lookup(second.n);
    expect(d2.carried).toBe(e1.pool);
    expect(d2.prizes).toEqual(e2.prizes);
    // The rollover went to the jackpot alone: division 1 = its share + all of the rollover.
    expect(d2.prizes[0]).toBe((e2.pool * 3350n) / 10_000n + e1.pool);
    // Divisions 2..8 nobody won fell through to division 9's single winner.
    const fallen = [185, 230, 200, 150, 940, 730, 1550, 2665].reduce((a, bp) => a + (e2.pool * BigInt(bp)) / 10_000n, 0n);
    expect(d2.prizes[8]).toBe(fallen);
    expect(sim.getLedger().carry).toBe(e2.carry);
    expect(sim.getLedger().feesOwed).toBe(e1.fee + e2.fee);
  });

  it('finalises a draw nobody played', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    drawIt(sim, n, seed);
    expect(sim.settleAll(n)).toBe(0);
    const d = sim.getLedger().draws.lookup(n);
    expect(d.status).toBe(DrawStatus.settled);
    expect(d.fee).toBe(0n);
    expect(sim.getLedger().carry).toBe(0n);
  });
});

describe("Powerball's prize rules", () => {
  it('allocates the pool by the published shares, jackpots division 1 and cascades unwon divisions', () => {
    expect(POWERBALL_SHARES_BP.reduce((a, b) => a + b, 0)).toBe(10_000);
    const pool = 1_000_000_000n;
    // One winner in every division: each gets its share, and the rollover goes to division 1.
    const all = prizesByPowerballRules(pool, 5_000n, [1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n]);
    expect(all.prizes).toEqual(POWERBALL_SHARES_BP.map((bp, i) => (pool * BigInt(bp)) / 10_000n + (i === 0 ? 5_000n : 0n)));
    expect(all.carry).toBe(0n);
    // Nobody wins 1..3; 4 has two winners: 2 and 3 fall into 4, 1 rolls over.
    const some = prizesByPowerballRules(pool, 0n, [0n, 0n, 0n, 2n, 1n, 1n, 1n, 1n, 1n]);
    expect(some.prizes[0]).toBe(0n);
    expect(some.prizes[3]).toBe((pool * (185n + 230n + 200n)) / 10_000n / 2n);
    expect(some.carry).toBe((pool * 3350n) / 10_000n + ((pool * (185n + 230n + 200n)) / 10_000n) % 2n);
    // Nobody wins anything: everything rolls over.
    const none = prizesByPowerballRules(pool, 7n, [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
    expect(none.prizes.every((p) => p === 0n)).toBe(true);
    expect(none.carry).toBe(pool + 7n);
    // Remainders roll over: 3 winners share 10 units.
    const odd = prizesByPowerballRules(10_000n, 0n, [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 3n]);
    expect(odd.prizes[8]).toBe((10_000n - 3_350n) / 3n);
    expect(odd.carry).toBe(3_350n + ((10_000n - 3_350n) % 3n));
  });
});

describe('the operator fee', () => {
  it('is a flat amount per game, so a ticket of several lines pays it several times', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    sim.buyTicket(makeTicket(n, quickPick(), me), me); // 1 line
    sim.buyPackage(quickPickPackage(n, 'mini', me), me); // 8 lines
    sim.buyTickets(Array.from({ length: 3 }, () => makeTicket(n, quickPick(), me)), me); // 3 lines
    drawIt(sim, n, seed);
    sim.settleAll(n);
    const l = sim.getLedger();
    const d = l.draws.lookup(n);
    // Of each 1.2 tNIGHT game, 0.2 goes to the operator ...
    expect(d.fee).toBe(12n * FEE);
    expect(sim.withdrawFees()).toBe(12n * FEE);
    // ... and 1 tNIGHT is the pool: paid out or rolled over.
    const paid = d.prizes.reduce((a, x, j) => a + x * l.progress.lookup(n).winners[j], 0n);
    expect(paid + l.carry).toBe(12n * PRIZE);
    // A QuickPick package costs its games x the price: a Mini is 9.6 tNIGHT.
    expect(BigInt(QUICK_PICK_PACKAGES.mini) * PRICE).toBe(9_600_000n);
  });

  it('must be below the ticket price, and can be zero', () => {
    expect(() => setup({ feePerGame: PRICE })).toThrow(/below the ticket price/);
    const { sim, oracleSecretKey } = setup({ feePerGame: 0n });
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    buyAll(sim, Array.from({ length: 5 }, () => makeTicket(n, quickPick(), randomAddress())));
    drawIt(sim, n, seed);
    sim.settleAll(n);
    expect(sim.getLedger().draws.lookup(n).fee).toBe(0n);
    expect(sim.withdrawFees()).toBe(0n);
  });
});

describe('the runtime', () => {
  // Informational: if this fails, the simulator can't see token transfers and
  // the payout checks above fall back to the ledger's own accounts.
  it('reports the payments each circuit makes', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    const to = randomAddress();
    sim.buyTicket(makeTicket(n, quickPick(), randomAddress()), to);
    sim.advance(SALES + 1);
    sim.requestDraw(n, seed);
    sim.advance(3_600 * 2 + 1);
    sim.voidDraw(n);
    sim.payments = sim.payments === undefined ? undefined : [];
    sim.refundTicket(n, 0n);
    expect(sim.payments, 'the runtime did not expose unshielded payments in effects').toBeDefined();
    expect(sim.payments).toEqual([{ to: hex(to), amount: PRICE }]);
  });
});
