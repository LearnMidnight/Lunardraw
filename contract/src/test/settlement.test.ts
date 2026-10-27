import { webcrypto } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  generateOracleSecretKey,
  generateOperatorSecret,
  oraclePublicKey,
  pureCircuits as nightcast,
} from '@nightcast/contract';
import { combineDrawSeed, drawStarfall, seedCommitment } from '@nightcast/sdk';
import { DrawStatus, pureCircuits, type TicketPreimage } from '../managed/settlement/contract/index.js';
import { SettlementSimulator } from '../settlement-simulator.js';
import {
  entryOf,
  ENTRY_TYPES,
  expectedSettlement,
  gamesByDivisionFor,
  gamesIn as listGames,
  gamesOf,
  makeTicket,
  type PlainEntry,
  entryName,
  toEntry,
  POWERBALL_SHARES_BP,
  prizesByPowerballRules,
  QUICK_PICK_PACKAGES,
  quickPickPackage,
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
const MAX_SALES = 30n * 86_400n;
const REVEAL = 3_600n;
const SALES = 3_600;
const BATCH = Number(pureCircuits.batchSize());
const OPERATOR = bytes('operator wallet');

const setup = (opts: { feePerGame?: bigint; acceptKey?: boolean } = {}) => {
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
    maxSales: MAX_SALES,
    revealWindow: REVEAL,
    drawWindow: 3_600n,
    settleWindow: SETTLE,
    acceptKey: opts.acceptKey,
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

/** Up to 12 numbers in the contract's form (sorted as given, padded with zeros). */
const nums = (xs: number[]): bigint[] => [...xs.map(BigInt), ...Array.from({ length: 12 - xs.length }, () => 0n)];

/** A copy of a ticket with some of its entry's fields replaced (for tampering). */
const withEntry = (t: TicketPreimage, e: Partial<TicketPreimage['entry']>): TicketPreimage => ({ ...t, entry: { ...t.entry, ...e } });

describe('sealed tickets', () => {
  it('only the settlement key opens a ticket, and it opens to exactly what was bought', () => {
    const { sim, oracleSecretKey, settlementSecret } = setup();
    const { n, draw } = openWithSeed(sim, oracleSecretKey);
    const split = [
      { address: randomAddress(), share: 5000 },
      { address: randomAddress(), share: 3000 },
      { address: randomAddress(), share: 2000 },
    ];
    const t = makeTicket(n, lineHitting(draw.numbers, draw.moonball, 3, true), split);
    const c = sim.buyTicket(t, randomAddress());
    const rec = sim.getLedger().tickets.lookup(pureCircuits.ticketKey(n, 0n));
    expect(hex(rec.commitment)).toBe(hex(c));
    expect(hex(c)).toBe(hex(sim.commitmentOf(t)));

    const opened = pureCircuits.openTicket(settlementSecret, n, rec.cipher);
    expect(opened.entry).toEqual(t.entry);
    expect(opened.payees.map((p) => [hex(p.address.bytes), p.share])).toEqual(
      t.payees.map((p) => [hex(p.address.bytes), p.share]),
    );
    expect(hex(opened.salt)).toBe(hex(t.salt));
    expect(hex(sim.commitmentOf(opened))).toBe(hex(c));

    // Another key gets noise: it doesn't even decode to a ticket.
    expect(() => pureCircuits.openTicket(randomScalar(), n, rec.cipher)).toThrow(/range error/);

    // Nothing public carries the numbers: the record holds the commitment, the
    // ciphertext, the games paid for and the refund address only.
    expect(Object.keys(rec).sort()).toEqual(['cipher', 'commitment', 'games', 'refundTo', 'refunded']);
    expect(rec.games).toBe(1n);
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
    untidy.payees = [untidy.payees[0], { address: { bytes: randomAddress() }, share: 0n }, untidy.payees[2]];
    expect(() => sim.buyTicket(untidy, me)).toThrow(/invalid ticket/);

    const badLine = withEntry(makeTicket(n, quickPick(), me), { numbers: nums([1, 2, 3, 4, 5, 6, 36]) });
    expect(() => sim.buyTicket(badLine, me)).toThrow(/invalid ticket/);

    const unordered = withEntry(makeTicket(n, quickPick(), me), { numbers: nums([2, 1, 3, 4, 5, 6, 7]) });
    expect(() => sim.buyTicket(unordered, me)).toThrow(/invalid ticket/);

    expect(() => sim.buyTicket(makeTicket(n + 1n, quickPick(), me), me)).toThrow(/unknown draw/);
    sim.advance(SALES + 1);
    expect(() => sim.buyTicket(makeTicket(n, quickPick(), me), me)).toThrow(/sales have closed/);
    expect(sim.ticketsSold(n)).toBe(1n);
  });
});

describe('multi-ticket purchases', () => {
  it('buys a QuickPick package two games at a time, each game a ticket of its own', () => {
    const { sim, oracleSecretKey, settlementSecret } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    const games = quickPickPackage(n, 'regular', me);
    expect(games.length).toBe(12);
    expect(Number(pureCircuits.maxTickets())).toBe(2);
    expect(sim.buyPackage(games, me)).toBe(6);
    expect(sim.ticketsSold(n)).toBe(12n);
    const opened = sim.decryptDrawTickets(n, settlementSecret);
    expect(opened.map((t) => hex(sim.commitmentOf(t)))).toEqual(games.map((t) => hex(sim.commitmentOf(t))));
    for (const [, r] of sim.getLedger().tickets) expect(hex(r.refundTo.bytes)).toBe(hex(me));

    // Mixed with single purchases, indexes stay sequential; a purchase returns its first index.
    sim.buyTicket(makeTicket(n, quickPick(), me), me);
    expect(sim.buyTickets([makeTicket(n, quickPick(), me), makeTicket(n, quickPick(), me)], me)).toBe(13n);
    expect(sim.ticketsSold(n)).toBe(15n);
    expect(sim.decryptDrawTickets(n, settlementSecret).length).toBe(15);
  });

  it('rejects too many tickets, a bad ticket in the set, a duplicate, and a mixed draw', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    const five = Array.from({ length: 5 }, () => makeTicket(n, quickPick(), me));
    expect(() => sim.buyTickets(five, me)).toThrow(/tickets per purchase/);
    expect(() => sim.buyTickets([], me)).toThrow();
    const bad = [makeTicket(n, quickPick(), me), makeTicket(n, quickPick(), me)];
    bad[1] = withEntry(bad[1], { numbers: nums([1, 1, 2, 3, 4, 5, 6]) });
    expect(() => sim.buyTickets(bad, me)).toThrow(/invalid ticket/);
    const dup = makeTicket(n, quickPick(), me);
    expect(() => sim.buyTickets([dup, dup], me)).toThrow(/already bought/);
    const mixed = [makeTicket(n, quickPick(), me), makeTicket(n + 1n, quickPick(), me)];
    expect(() => sim.buyTickets(mixed, me)).toThrow(/invalid ticket/);
    expect(sim.ticketsSold(n)).toBe(0n);
    expect(Object.keys(QUICK_PICK_PACKAGES)).toEqual(['single', 'starter', 'mini', 'regular', 'super', 'mega', 'jumbo', 'maxi']);
  });
});

describe('System, Pick and Moonball Sweep entries', () => {
  /** An entry of `count` numbers (a Pick if `pick`), `h` of them among the drawn numbers. */
  const entryHitting = (
    draw: { numbers: number[]; moonball: number },
    o: { count: number; h: number; pick?: boolean; sweep?: boolean; moonballHit?: boolean },
  ): PlainEntry => {
    const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !draw.numbers.includes(x));
    return {
      numbers: [...draw.numbers.slice(0, o.h), ...misses.slice(0, o.count - o.h)],
      moonball: o.moonballHit === false ? (draw.moonball % 20) + 1 : draw.moonball,
      pick: o.pick,
      sweep: o.sweep,
    };
  };
  const totalOf = (v: bigint[]) => v.reduce((a, b) => a + b, 0n);

  // One test per entry type, yielding between cases: listing every game of a
  // System 12 or a Pick 5 with Moonball Sweep for every hit count is a lot of
  // work, and a worker busy for too long without a break makes vitest report
  // "Timeout calling onTaskUpdate" even though every test passes.
  it.each(ENTRY_TYPES.map((t) => [t.name, t] as const))(
    "%s: the contract's table agrees with listing every game, for every hit count and Moonball",
    async (_name: string, t: (typeof ENTRY_TYPES)[number]) => {
      const draw = { numbers: [3, 8, 12, 19, 24, 30, 35], moonball: 11 };
      for (let h = 0; h <= Math.min(t.count, 7); h++) {
        for (const sweep of [false, true]) {
          for (const moonballHit of [true, false]) {
            const e = entryHitting(draw, { count: t.count, h, pick: t.pick, sweep, moonballHit });
            const want = gamesByDivisionFor(e, draw.numbers, draw.moonball);
            const got = pureCircuits.gamesByDivision(toEntry(e), draw.numbers.map(BigInt), BigInt(draw.moonball));
            expect(got, `${entryName(e)}, ${h} drawn, Moonball ${moonballHit ? 'hit' : 'missed'}`).toEqual(want);
            expect(Number(pureCircuits.gamesIn(toEntry(e)))).toBe(gamesOf(e));
            if (h === 0) expect(listGames(e).length).toBe(gamesOf(e));
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }
      expect(gamesOf({ numbers: draw.numbers.slice(0, t.count), moonball: 1, pick: t.pick })).toBe(t.games);
    },
  );

  it('has the entry types the spec asks for', () => {
    expect(ENTRY_TYPES.map((t) => [t.name, t.games])).toEqual([
      ['standard', 1],
      ['System 8', 8],
      ['System 9', 36],
      ['System 10', 120],
      ['System 11', 330],
      ['System 12', 792],
      ['Pick 6', 29],
      ['Pick 5', 435],
    ]);
  });

  it('buys a System 12, a Pick 5 with Moonball Sweep and a PowerHit-style entry as one ticket each', () => {
    const { sim, oracleSecretKey, settlementSecret } = setup();
    const { n, draw } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    const system12 = makeTicket(n, entryHitting(draw, { count: 12, h: 3 }), me);
    const pick5Sweep = makeTicket(n, entryHitting(draw, { count: 5, h: 2, pick: true, sweep: true }), me);
    const powerHit = makeTicket(n, { ...quickPick(), sweep: true }, me);
    expect(sim.buyTickets([system12, pick5Sweep], me)).toBe(0n);
    sim.buyTicket(powerHit, me);
    // Three tickets (three settlement slots), 9,512 games paid for.
    expect(sim.ticketsSold(n)).toBe(3n);
    expect(sim.getLedger().gamesSold.lookup(n)).toBe(792n + 8_700n + 20n);
    expect([0n, 1n, 2n].map((i) => sim.getLedger().tickets.lookup(pureCircuits.ticketKey(n, i)).games)).toEqual([792n, 8_700n, 20n]);
    // The settler opens each to exactly what was bought.
    expect(sim.decryptDrawTickets(n, settlementSecret).map((t) => entryOf(t))).toEqual(
      [system12, pick5Sweep, powerHit].map((t) => entryOf(t)),
    );
    expect(entryName(entryOf(pick5Sweep))).toBe('Pick 5 + Moonball Sweep');
  });

  it('settles big entries one slot each, and pays every winning game to the STAR', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed, draw } = openWithSeed(sim, oracleSecretKey);
    const entries: PlainEntry[] = [
      // Pick 6 with all 6 fixed numbers drawn, all Moonballs: certain to win division 1.
      entryHitting(draw, { count: 6, h: 6, pick: true, sweep: true }),
      // System 9 holding 6 drawn numbers and the Moonball: divisions 3, 5, 6, 8 ...
      entryHitting(draw, { count: 9, h: 6 }),
      // System 8 with 3 drawn numbers and the wrong Moonball: nothing.
      entryHitting(draw, { count: 8, h: 3, moonballHit: false }),
      // Pick 5 with 4 drawn.
      entryHitting(draw, { count: 5, h: 4, pick: true }),
    ];
    const tickets = entries.map((e, i) =>
      makeTicket(n, e, i === 1 ? [{ address: randomAddress(), share: 7000 }, { address: randomAddress(), share: 3000 }] : randomAddress()),
    );
    tickets.push(...Array.from({ length: 30 }, () => makeTicket(n, quickPick(), randomAddress())));
    buyAll(sim, tickets);
    drawIt(sim, n, seed);
    const expected = expectedSettlement(tickets, draw.numbers, draw.moonball, PRICE, FEE, 0n);
    expect(expected.won[0][0]).toBe(1n); // the Pick 6 sweep's jackpot
    expect(totalOf(expected.won[1])).toBeGreaterThan(30n); // the System 9's many winning games
    expect(totalOf(expected.won[2])).toBe(0n);

    sim.payments = sim.payments === undefined ? undefined : [];
    // 34 tickets holding 1,089 games, settled as 34 slots.
    expect(sim.settleAll(n)).toBe(Math.ceil(34 / BATCH));
    const l = sim.getLedger();
    expect(l.progress.lookup(n).winners).toEqual(expected.winners);
    expect(l.gamesSold.lookup(n)).toBe(expected.games);
    const d = l.draws.lookup(n);
    expect(d.fee).toBe(expected.fee);
    expect(d.prizes).toEqual(expected.prizes);
    expect(l.carry).toBe(expected.carry);
    // Each winning ticket is one entitlement, holding its winning games per division.
    const ents = [...l.entitlements].map(([, e]) => e).filter((e) => e.drawId === n);
    expect(ents.map((e) => e.games.join('.')).sort()).toEqual(
      expected.won.filter((w) => totalOf(w) > 0n).map((w) => w.join('.')).sort(),
    );
    const paid = expected.prizes.reduce((a, prize, i) => a + prize * expected.winners[i], 0n);
    expect(expected.fee + paid + l.carry).toBe(expected.sales);
    if (sim.payments !== undefined) {
      const want = new Map(expected.payouts);
      want.set(hex(OPERATOR), expected.fee);
      expect(sortedEntries(totals(sim.payments))).toEqual(sortedEntries(want));
    }
  });

  it('rejects entries the contract has no type for, and badly formed ones', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    const system = makeTicket(n, { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9], moonball: 4 }, me);
    const bad: [string, Partial<TicketPreimage['entry']>][] = [
      ['a Pick of 7', { kind: 1n, count: 7n, numbers: nums([1, 2, 3, 4, 5, 6, 7]) }],
      ['a Pick of 4', { kind: 1n, count: 4n, numbers: nums([1, 2, 3, 4]) }],
      ['a System of 6', { count: 6n, numbers: nums([1, 2, 3, 4, 5, 6]) }],
      ['an unknown kind', { kind: 2n }],
      ['a number after the count', { count: 8n, numbers: nums([1, 2, 3, 4, 5, 6, 7, 8, 9]) }],
      ['too few numbers for the count', { count: 10n }],
      ['a number above 35', { numbers: nums([1, 2, 3, 4, 5, 6, 7, 8, 36]) }],
      ['a repeated number', { numbers: nums([1, 2, 3, 4, 5, 6, 7, 8, 8]) }],
      ['a Moonball with Sweep', { sweep: true }],
      ['no Moonball without Sweep', { moonball: 0n }],
      ['a Moonball of 21', { moonball: 21n }],
    ];
    for (const [why, e] of bad) expect(() => sim.buyTicket(withEntry(system, e), me), why).toThrow(/invalid ticket/);
    sim.buyTicket(system, me);
    expect(sim.getLedger().gamesSold.lookup(n)).toBe(36n);
    // The SDK refuses the same things before they reach the contract.
    expect(() => makeTicket(n, { numbers: [1, 2, 3, 4], pick: true, moonball: 1 }, me)).toThrow(/Pick has 5 or 6/);
    expect(() => makeTicket(n, { numbers: [1, 2, 3, 4, 5, 6], moonball: 1 }, me)).toThrow(/7 numbers/);
    expect(() => makeTicket(n, { numbers: [1, 2, 3, 4, 5, 6, 7] }, me)).toThrow(/Moonball/);
  });

  it('counts the fee per game and refunds every game of a void draw', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    const refundTo = randomAddress();
    sim.buyTickets([makeTicket(n, { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], sweep: true }, me), makeTicket(n, quickPick(), me)], refundTo);
    expect(sim.getLedger().gamesSold.lookup(n)).toBe(2_400n + 1n);
    // Nobody settles it in time: void, and both tickets are refunded in full.
    drawIt(sim, n, seed);
    sim.advance(Number(SETTLE) + 1);
    sim.voidDraw(n);
    sim.payments = sim.payments === undefined ? undefined : [];
    sim.refundTicket(n, 0n);
    sim.refundTicket(n, 1n);
    if (sim.payments !== undefined) expect(totals(sim.payments).get(hex(refundTo))).toBe(2_401n * PRICE);

    // In a draw that settles, the fee is per game: 8 + 1 games pay 9 fees.
    const next = openWithSeed(sim, oracleSecretKey);
    buyAll(sim, [makeTicket(next.n, { numbers: [1, 2, 3, 4, 5, 6, 7, 8], moonball: 1 }, me), makeTicket(next.n, quickPick(), me)]);
    drawIt(sim, next.n, next.seed);
    sim.settleAll(next.n);
    expect(sim.getLedger().draws.lookup(next.n).fee).toBe(9n * FEE);
  });
});

describe('settling 100 private tickets', () => {
  /**
   * 100 tickets: winners in every division (some split between payees, two
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

  it('counts every winner, pays every payee and the operator exactly, and keeps the rollover', () => {
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

    // One entitlement per winning ticket, with its winning games and the payees it named, all paid.
    const winning = tickets.filter((_, i) => expected.won[i].some((g) => g > 0n));
    const ents = [...l.entitlements].map(([, e]) => e).filter((e) => e.drawId === n);
    expect(ents.length).toBe(winning.length);
    expect(ents.every((e) => e.paid)).toBe(true);
    const key = (games: bigint[], payees: { address: { bytes: Uint8Array }; share: bigint }[]) =>
      `${games.join('.')}:${payees.map((x) => `${hex(x.address.bytes)}/${x.share}`).join(',')}`;
    expect(ents.map((e) => key(e.games, e.payees)).sort()).toEqual(
      winning.map((t) => key(expected.won[tickets.indexOf(t)], t.payees)).sort(),
    );

    // Every STAR of sales is accounted for: fee + prizes paid + rollover.
    const paid = expected.prizes.reduce((a, prize, i) => a + prize * expected.winners[i], 0n);
    expect(expected.fee + paid + l.carry).toBe(expected.sales);
    // With winners in every division nothing cascades: each prize is its division's share.
    expected.prizes.forEach((prize, i) => {
      expect(prize).toBe((expected.pool * BigInt(POWERBALL_SHARES_BP[i])) / 10_000n / expected.winners[i]);
    });

    // The payments made match the reference to the STAR (when the runtime
    // reports them): every payee's prizes, and the operator's fee, paid once
    // when the draw was finalised.
    if (sim.payments !== undefined) {
      const want = new Map(expected.payouts);
      want.set(hex(OPERATOR), expected.fee);
      expect(sortedEntries(totals(sim.payments))).toEqual(sortedEntries(want));
    }
  });

  it("splits a ticket's prize by its payees' shares, with the remainder to the first payee", () => {
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
    forged[3] = withEntry(forged[3], { numbers: nums(draw.numbers), moonball: BigInt(draw.moonball) });
    expect(() => sim.settleBatch(n, forged)).toThrow(/does not match its commitment/);
    // Paying the forger instead doesn't work either.
    const redirected = tickets.map((t) => ({ ...t }));
    redirected[5] = { ...redirected[5], payees: [{ address: { bytes: randomAddress() }, share: 10_000n }, ...redirected[5].payees.slice(1)] };
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

describe('the circuit budget', () => {
  // A deploy transaction carries every circuit's verifier key and must fit
  // Midnight's block limits: 12 circuits fit, 16 were rejected (v0, Oct 2026).
  it('has at most 12 circuits, so the contract can be deployed', () => {
    const { sim } = setup();
    const circuits = Object.keys(sim.contract.impureCircuits).sort();
    expect(circuits).toEqual([
      'acceptOracleKey',
      'buyTickets',
      'changeOrganiser',
      'computeNumbers',
      'finaliseDraw',
      'fulfilDraw',
      'payEntitlement',
      'proposeOracleKey',
      'refundTicket',
      'requestDraw',
      'settleBatch',
      'voidDraw',
    ]);
    expect(circuits.length).toBeLessThanOrEqual(12);
  });
});

describe('the oracle and the organiser', () => {
  it('needs an accepted oracle key before a draw can open, and only that oracle can answer', () => {
    const { sim, oracleSecretKey } = setup({ acceptKey: false });
    expect(() => openWithSeed(sim, oracleSecretKey)).toThrow(/no active oracle key/);
    expect(() => sim.acceptOracleKey({ oracleSecretKey: generateOracleSecretKey() })).toThrow(/does not match/);
    sim.acceptOracleKey();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    sim.advance(SALES + 1);
    sim.requestDraw(n, seed);
    expect(() => sim.fulfilDraw(n, { oracleSecretKey: generateOracleSecretKey() })).toThrow(/not the oracle/);
    sim.fulfilDraw(n);
  });

  it('only the organiser opens draws and reveals seeds, and only after sales close', () => {
    const { sim, oracleSecretKey } = setup();
    expect(() => sim.openDraw(BigInt(sim.now + SALES), bytes('c'), { organiserSecret: generateOperatorSecret() })).toThrow(
      /not the organiser/,
    );
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    expect(n).toBe(1n);
    expect(() => sim.requestDraw(n, seed)).toThrow(/sales are still open/);
    sim.advance(SALES + 1);
    expect(() => sim.requestDraw(n, bytes('a different seed'))).toThrow(/does not match the commitment/);
    // Not even the oracle may fix the VRF input.
    expect(() => sim.requestDraw(n, seed, sim.anyone)).toThrow();
    expect(() => sim.requestDraw(n, seed, sim.oracle)).toThrow();
    sim.requestDraw(n, seed);
    expect(sim.getLedger().draws.lookup(n).status).toBe(DrawStatus.requested);
  });

  it('binds a draw to the oracle key it opened with: a key change never reaches an open draw', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const key = oraclePublicKey(oracleSecretKey);
    expect(sim.getLedger().draws.lookup(n).oracleKey).toEqual(key);
    // The organiser proposes a key it made itself, and waits out the delay...
    const own = generateOracleSecretKey();
    expect(() => sim.proposeOracleKey(oraclePublicKey(own), sim.anyone)).toThrow();
    sim.proposeOracleKey(oraclePublicKey(own));
    sim.advance(Number(MAX_SALES + REVEAL) + 1);
    sim.acceptOracleKey({ oracleSecretKey: own });
    expect(sim.getLedger().oracleKey).toEqual(oraclePublicKey(own));
    // ...but the draw that was selling still belongs to the old oracle.
    expect(sim.getLedger().draws.lookup(n).oracleKey).toEqual(key);
    sim.voidDraw(n);
    // The next draw is bound to the new key.
    const m = openWithSeed(sim, own).n;
    expect(sim.getLedger().draws.lookup(m).oracleKey).toEqual(oraclePublicKey(own));
    sim.advance(SALES + 1);
    sim.requestDraw(m, bytes(`seed ${m}`));
    expect(() => sim.fulfilDraw(m)).toThrow(/not the oracle/);
    sim.fulfilDraw(m, { oracleSecretKey: own });
  });

  it('makes a new oracle key wait longer than any draw sells for, unless the current oracle agrees', () => {
    const { sim } = setup();
    const next = generateOracleSecretKey();
    sim.proposeOracleKey(oraclePublicKey(next));
    expect(sim.getLedger().oracleKeyChangeAt).toBe(BigInt(sim.now) + MAX_SALES + REVEAL);
    expect(() => sim.acceptOracleKey({ oracleSecretKey: next })).toThrow(/still waiting/);
    sim.advance(Number(MAX_SALES + REVEAL) - 10);
    // Proposing again restarts the wait.
    sim.proposeOracleKey(oraclePublicKey(next));
    sim.advance(20);
    expect(() => sim.acceptOracleKey({ oracleSecretKey: next })).toThrow(/still waiting/);
    // The proposal's clock must be within 10 minutes of block time.
    expect(() => sim.proposeOracleKey(oraclePublicKey(next), sim.organiser, BigInt(sim.now + 1_000))).toThrow(/clock/);
    // The current oracle's approval lifts the wait; the new key's holder can't approve for itself.
    expect(() => sim.approveOracleKey({ oracleSecretKey: next })).toThrow(/still waiting/);
    sim.approveOracleKey();
    sim.acceptOracleKey({ oracleSecretKey: next });
    expect(sim.getLedger().oracleKey).toEqual(oraclePublicKey(next));
    expect(sim.getLedger().proposedOracleKey.is_some).toBe(false);
    expect(sim.getLedger().oracleKeyApproved).toBe(false);
  });

  it('lets the organiser hand over, and the backup organiser take over', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    const successor = generateOperatorSecret();
    const asSuccessor = { organiserSecret: successor };
    expect(() => sim.proposeOrganiser(pureCircuits.organiserCommitmentOf(successor), sim.anyone)).toThrow();
    expect(() => sim.acceptOrganiser(asSuccessor)).toThrow(/not the organiser/);
    sim.proposeOrganiser(pureCircuits.organiserCommitmentOf(successor));
    expect(() => sim.acceptOrganiser({ organiserSecret: generateOperatorSecret() })).toThrow(/not the organiser/);
    sim.acceptOrganiser(asSuccessor);
    // The old organiser is out; the new one carries on with the open draw.
    sim.advance(SALES + 1);
    expect(() => sim.requestDraw(n, seed)).toThrow(/not the organiser/);
    sim.requestDraw(n, seed, asSuccessor);
    // The backup replaces a lost organiser without a proposal, but never with itself.
    const replacement = generateOperatorSecret();
    expect(() =>
      sim.recoverOrganiser(pureCircuits.organiserCommitmentOf(replacement), { organiserSecret: generateOperatorSecret() }),
    ).toThrow(/not the organiser/);
    expect(() => sim.recoverOrganiser(pureCircuits.organiserCommitmentOf(sim.backupSecret))).toThrow(/can't be the organiser/);
    sim.recoverOrganiser(pureCircuits.organiserCommitmentOf(replacement));
    expect(sim.getLedger().organiser).toEqual(pureCircuits.organiserCommitmentOf(replacement));
    sim.fulfilDraw(n);
    sim.computeNumbers(n);
  });

  it('starts the settlement window when the numbers are computed, with a 30-minute clock tolerance', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    sim.buyTicket(makeTicket(n, quickPick(), randomAddress()), randomAddress());
    sim.advance(SALES + 1);
    sim.requestDraw(n, seed);
    sim.fulfilDraw(n);
    // A slow numbers proof (stamped up to 30 minutes before it lands) is still accepted.
    expect(() => sim.computeNumbers(n, BigInt(sim.now + 1_801))).toThrow(/clock/);
    expect(() => sim.computeNumbers(n, BigInt(sim.now - 1_801))).toThrow(/clock/);
    const stamp = BigInt(sim.now - 1_700);
    sim.computeNumbers(n, stamp);
    expect(sim.getLedger().draws.lookup(n).settleDeadline).toBe(stamp + SETTLE);
  });

  it('sells one draw at a time, never reuses a seed commitment, and enforces the sales period', () => {
    const { sim, oracleSecretKey } = setup();
    expect(() => sim.openDraw(BigInt(sim.now) + 599n, bytes('a'))).toThrow(/too short/);
    expect(() => sim.openDraw(BigInt(sim.now) + MAX_SALES + 1n, bytes('a'))).toThrow(/too long/);
    const first = openWithSeed(sim, oracleSecretKey, 'reused');
    expect(() => openWithSeed(sim, oracleSecretKey, 'second')).toThrow(/still selling/);
    sim.advance(SALES + 1);
    const again = { salesClose: BigInt(sim.now + SALES), seedCommitment: fromHex(seedCommitment(hex(bytes('reused')))) };
    expect(() => sim.requestAndOpenNext(first.n, first.seed, again)).toThrow(/already used/);
    // The failed step is undone as a whole: the first draw still waits for its seed.
    expect(sim.getLedger().draws.lookup(first.n).status).toBe(DrawStatus.open);
    sim.requestDraw(first.n, first.seed);
    expect(openWithSeed(sim, oracleSecretKey, 'second').n).toBe(2n);
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
    expect(sim.getLedger().draws.lookup(first.n).fee + d2.fee).toBe(e1.fee + e2.fee);
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

  it('rolls over what the floored division shares leave of the pool, so no STAR is ever stranded', () => {
    // 1,234,567 STAR: each share is floored; the 9 floors leave a few STAR over.
    const pool = 1_234_567n;
    const floors = POWERBALL_SHARES_BP.reduce((a, bp) => a + (pool * BigInt(bp)) / 10_000n, 0n);
    expect(pool - floors).toBeGreaterThan(0n);
    expect(pool - floors).toBeLessThanOrEqual(8n);
    const all = prizesByPowerballRules(pool, 0n, [1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n]);
    expect(all.carry).toBe(pool - floors);
    // Whatever the winners, prizes paid + carry = pool + rollover, to the STAR.
    for (let k = 0; k < 200; k++) {
      const winners = Array.from({ length: 9 }, () => BigInt(Math.random() < 0.4 ? 0 : Math.floor(Math.random() * 50) + 1));
      const carryIn = BigInt(Math.floor(Math.random() * 1_000_000));
      const r = prizesByPowerballRules(pool, carryIn, winners);
      const paid = r.prizes.reduce((a, p, j) => a + p * winners[j], 0n);
      expect(paid + r.carry).toBe(pool + carryIn);
    }
  });

  it('the contract agrees: an awkward pool leaves no STAR unaccounted for', () => {
    // 7 games at 1.2 tNIGHT with a fee of 0.2 tNIGHT + 1 STAR leaves a pool that doesn't divide evenly.
    const { sim, oracleSecretKey } = setup({ feePerGame: FEE + 1n });
    const { n, seed, draw } = openWithSeed(sim, oracleSecretKey);
    const tickets = [
      makeTicket(n, lineHitting(draw.numbers, draw.moonball, 2, true), randomAddress()),
      ...Array.from({ length: 6 }, () => makeTicket(n, losingLine(draw.numbers, draw.moonball), randomAddress())),
    ];
    buyAll(sim, tickets);
    drawIt(sim, n, seed);
    sim.settleAll(n);
    const expected = expectedSettlement(tickets, draw.numbers, draw.moonball, PRICE, FEE + 1n, 0n);
    const l = sim.getLedger();
    expect(l.draws.lookup(n).prizes).toEqual(expected.prizes);
    expect(l.carry).toBe(expected.carry);
    const paid = expected.prizes.reduce((a, p, j) => a + p * expected.winners[j], 0n);
    expect(expected.fee + paid + l.carry).toBe(7n * PRICE);
  });
});

describe('the operator fee', () => {
  it('is a flat amount per game, so a ticket of several lines pays it several times', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    const me = randomAddress();
    sim.buyTicket(makeTicket(n, quickPick(), me), me); // 1 line
    sim.buyPackage(quickPickPackage(n, 'mini', me), me); // 8 lines
    sim.buyPackage(Array.from({ length: 3 }, () => makeTicket(n, quickPick(), me)), me); // 3 lines
    drawIt(sim, n, seed);
    sim.payments = sim.payments === undefined ? undefined : [];
    sim.settleAll(n);
    if (sim.payments !== undefined) {
      expect(sim.payments.filter((p) => p.to === hex(OPERATOR))).toEqual([{ to: hex(OPERATOR), amount: 12n * FEE }]);
    }
    const l = sim.getLedger();
    const d = l.draws.lookup(n);
    // Of each 1.2 tNIGHT game, 0.2 goes to the operator, paid when the draw is finalised ...
    expect(d.fee).toBe(12n * FEE);
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
    sim.payments = sim.payments === undefined ? undefined : [];
    sim.settleAll(n);
    expect(sim.getLedger().draws.lookup(n).fee).toBe(0n);
    if (sim.payments !== undefined) expect(sim.payments.some((p) => p.to === hex(OPERATOR))).toBe(false);
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
