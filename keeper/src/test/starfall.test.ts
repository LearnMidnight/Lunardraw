import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { quickPick, type PlainLine, Starfall } from '@lunardraw/contract';
import { generateOperatorSecret, generateOracleSecretKey, pureCircuits as nightcast } from '@nightcast/contract';
import { combineDrawSeed, drawStarfall } from '@nightcast/sdk';
import { every } from '../schedule.js';
import { buildStarfallFeed } from '../starfall-feed.js';
import { StepTimes } from '../step-times.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitmentOf, DerivedSeeds } from '../seeds.js';
import {
  decryptTickets,
  isMine,
  shareOf,
  StarfallKeeper,
  type StarfallKeeperOptions,
  StarfallSimulatorChain,
  type StarfallStep,
  starfallSteps,
  type StarfallView,
  storedTicketsOf,
  mustBeWonStatus,
  woundDown,
} from '../starfall.js';

const { DrawStatus, SettlementSimulator, makeTicket, randomScalar } = Starfall;
/** Tickets that take two settlement batches: a full one and part of the next. */
const TWO_BATCHES = Number(Starfall.pureCircuits.batchSize()) + 8;
type Sim = InstanceType<typeof SettlementSimulator>;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const randomAddress = (): Uint8Array => webcrypto.getRandomValues(new Uint8Array(32));
const OPERATOR = new Uint8Array(32).fill(9);
const BUYER = new Uint8Array(32).fill(7);
const FEE = 200_000n;
const PRICE = 1_200_000n;
const SALES = 3_600; // the tests' draws close on the hour
const REVEAL = 1_800;
const DRAW = 1_800;
const SETTLE = 7_200;

const setup = (opts: { finalSales?: bigint } = {}) => {
  const oracleSecretKey = generateOracleSecretKey();
  const organiserSecret = generateOperatorSecret();
  const settlementSecret = randomScalar();
  const sim = new SettlementSimulator({
    oracleSecretKey,
    organiserSecret,
    settlementSecret,
    operator: OPERATOR,
    feePerGame: FEE,
    ticketPrice: PRICE,
    minSales: 600n,
    maxSales: 30n * 86_400n,
    revealWindow: BigInt(REVEAL),
    drawWindow: BigInt(DRAW),
    settleWindow: BigInt(SETTLE),
    finalSales: opts.finalSales,
  });
  const chain = new StarfallSimulatorChain(sim);
  const seeds = new DerivedSeeds(organiserSecret, sim.addressBytes);
  // A local clock that follows the simulator, so grace, backoff and take-over move with it.
  const clock = () => sim.now * 1000;
  const keeper = (opts: Partial<StarfallKeeperOptions> = {}) =>
    new StarfallKeeper({ chain, seeds, settlementSecret, schedule: every(SALES), clock, backoffMs: 1_000, ...opts });
  return { sim, chain, seeds, keeper, oracleSecretKey, organiserSecret, settlementSecret, clock };
};

type Setup = ReturnType<typeof setup>;

const draw = (sim: Sim, n: bigint) => sim.getLedger().draws.lookup(n);

/** The numbers draw `n` will have, from its derived seed and the oracle key. */
const numbersOf = ({ sim, seeds, oracleSecretKey }: Setup, n: bigint) => {
  const seed = seeds.seedFor(n);
  expect(hex(commitmentOf(seed))).toBe(hex(draw(sim, n).seedCommitment));
  return drawStarfall(combineDrawSeed(hex(seed), nightcast.evaluate(oracleSecretKey, sim.alphaOf(n, seed)))) as {
    numbers: number[];
    moonball: number;
  };
};

/** A line with exactly `match` main numbers and the Moonball. */
const lineHitting = (numbers: number[], moonball: number, match: number): PlainLine => {
  const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !numbers.includes(x));
  return { numbers: [...numbers.slice(0, match), ...misses.slice(0, 7 - match)], moonball };
};

/** Advance to just past a boundary plus the keeper's margin. */
const passing = (sim: Sim, boundary: bigint) => {
  const t = Number(boundary) + 31;
  if (sim.now < t) sim.advance(t - sim.now);
};

/** Open draw 1 by hand (with its derived seed), for keepers that don't open draws. */
const openFirst = ({ sim, seeds }: Setup) => {
  const close = BigInt(Math.ceil((sim.now + 900) / SALES) * SALES);
  sim.openDraw(close, commitmentOf(seeds.seedFor(1n)));
};

const oracleAnswers = (sim: Sim) => {
  for (const [id, d] of sim.getLedger().draws) if (d.status === DrawStatus.requested) sim.fulfilDraw(id);
};

describe('the Starfall keeper', () => {
  it('runs a draw from opening to paying its winners: decrypts, settles batch by batch, finalises', async () => {
    const ctx = setup();
    const { sim } = ctx;
    const keeper = ctx.keeper();

    expect((await keeper.tick()).done).toEqual(['open after 0']);
    expect(draw(sim, 1n).status).toBe(DrawStatus.open);

    // Two batches of tickets. One is a sure winner (3 + Moonball); the rest are QuickPicks.
    const { numbers, moonball } = numbersOf(ctx, 1n);
    const winner = randomAddress();
    const games = [makeTicket(1n, lineHitting(numbers, moonball, 3), winner)];
    for (let i = 1; i < TWO_BATCHES; i++) games.push(makeTicket(1n, quickPick(), randomAddress()));
    sim.buyPackage(games, BUYER);
    expect(sim.ticketsSold(1n)).toBe(BigInt(TWO_BATCHES));

    passing(sim, draw(sim, 1n).salesClose);
    expect((await keeper.tick()).done).toEqual(['reveal 1']);
    expect(draw(sim, 2n).status).toBe(DrawStatus.open);
    oracleAnswers(sim);

    expect((await keeper.tick()).done).toEqual(['compute 1']);
    expect(draw(sim, 1n).status).toBe(DrawStatus.drawn);
    // One batch a pass, in order, until every ticket is settled.
    expect((await keeper.tick()).done).toEqual(['settle 1 from 0']);
    expect((await keeper.tick()).done).toEqual([`settle 1 from ${Starfall.pureCircuits.batchSize()}`]);
    expect(sim.getLedger().progress.lookup(1n).next).toBe(BigInt(TWO_BATCHES));
    expect((await keeper.tick()).done).toEqual(['finalise 1']);
    const settled = draw(sim, 1n);
    expect(settled.status).toBe(DrawStatus.settled);
    expect(settled.fee).toBe(BigInt(TWO_BATCHES) * FEE);

    // Then every entitlement is paid, the sure winner's among them.
    const ids = sim.entitlementsOf(1n);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    for (let pass = 0; pass < 10 && sim.entitlementsOf(1n).some((id) => !sim.getLedger().entitlements.lookup(id).paid); pass++) {
      await keeper.tick();
    }
    for (const id of ids) expect(sim.getLedger().entitlements.lookup(id).paid).toBe(true);
    if (sim.payments) expect(sim.payments.some((p) => p.to === hex(winner) && p.amount > 0n)).toBe(true);
    expect((await keeper.tick()).done).toEqual([]);
  }, 120_000);

  it('winds down when told to: the next draw is the final draw, which gives out the rollover, and then nothing opens', async () => {
    const ctx = setup({ finalSales: 2n * BigInt(SALES) });
    const { sim } = ctx;
    let last = false;
    const said: string[] = [];
    const log = (m: string) => said.push(m);
    const keeper = ctx.keeper({ finalDraw: () => last, logger: { info: log, warn: log, error: log } });
    expect((await keeper.tick()).done).toEqual(['open after 0']);
    const { numbers, moonball } = numbersOf(ctx, 1n);
    sim.buyTickets([makeTicket(1n, lineHitting(numbers, moonball, 3), randomAddress()), makeTicket(1n, quickPick(), randomAddress())], BUYER);
    // Told to wind down while draw 1 is selling.
    last = true;
    await keeper.tick();
    expect(said.some((m) => /winding down: the next draw to open will be the final draw/.test(m))).toBe(true);
    passing(sim, draw(sim, 1n).salesClose);
    expect((await keeper.tick()).done).toEqual(['reveal 1']);
    // Draw 2 is the final draw, selling for at least finalSales.
    const final = draw(sim, 2n);
    expect(final.final).toBe(true);
    expect(Number(final.salesClose) - sim.now).toBeGreaterThanOrEqual(2 * SALES);
    oracleAnswers(sim);
    for (let pass = 0; pass < 10; pass++) await keeper.tick();
    expect(draw(sim, 1n).status).toBe(DrawStatus.settled);
    const carried = sim.getLedger().carry;
    expect(carried).toBeGreaterThan(0n);
    expect(woundDown(await ctx.chain.view())).toBe(false);
    // Players buy into the final draw: losing games only, so they share everything.
    const n2 = numbersOf(ctx, 2n);
    const losing = { numbers: Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !n2.numbers.includes(x)).slice(0, 7), moonball: (n2.moonball % 20) + 1 };
    const players = [randomAddress(), randomAddress(), randomAddress()];
    for (const p of players) sim.buyTickets([makeTicket(2n, losing, p)], p);
    passing(sim, final.salesClose);
    expect((await keeper.tick()).done).toEqual(['reveal 2']);
    expect(sim.getLedger().lastDraw).toBe(2n); // nothing opens after the final draw
    oracleAnswers(sim);
    for (let pass = 0; pass < 10; pass++) await keeper.tick();
    const l = sim.getLedger();
    expect(l.draws.lookup(2n).status).toBe(DrawStatus.settled);
    expect(l.ended).toBe(true);
    expect(l.carry).toBe(0n);
    const share = l.draws.lookup(2n).finalShare;
    expect(share).toBe((carried + 3n * (PRICE - FEE)) / 3n);
    // Every player's share is paid to the address they bought with.
    for (let i = 0n; i < 3n; i++) expect(l.tickets.lookup(Starfall.pureCircuits.ticketKey(2n, i)).refunded).toBe(true);
    if (sim.payments) for (const p of players) expect(sim.payments.some((x) => x.to === hex(p) && x.amount === share)).toBe(true);
    // Nothing more: it says so once, and never opens a draw, even told to carry on.
    sim.advance(5 * SALES);
    for (let pass = 0; pass < 3; pass++) expect((await keeper.tick()).done).toEqual([]);
    expect(said.filter((m) => /^wound down: .*the final draw gave out the rollover.*safe to switch/.test(m))).toHaveLength(1);
    expect(woundDown(await ctx.chain.view())).toBe(true);
    last = false;
    expect((await keeper.tick()).done).toEqual([]);
    expect(sim.getLedger().lastDraw).toBe(2n);
  }, 180_000);

  it('counts a void draw as wound down only once every ticket is refunded', async () => {
    const ctx = setup();
    const { sim } = ctx;
    const keeper = ctx.keeper({ openNew: false, paymentsPerPass: 1 });
    openFirst(ctx);
    sim.buyTickets([makeTicket(1n, quickPick(), randomAddress())], BUYER);
    sim.buyTickets([makeTicket(1n, quickPick(), randomAddress())], BUYER);
    expect(woundDown(await ctx.chain.view())).toBe(false);
    // Nobody reveals it: void, then refunds one a pass.
    passing(sim, draw(sim, 1n).revealDeadline);
    sim.voidDraw(1n);
    expect(woundDown(await ctx.chain.view())).toBe(false);
    await keeper.tick();
    expect(woundDown(await ctx.chain.view())).toBe(false);
    await keeper.tick();
    expect(woundDown(await ctx.chain.view())).toBe(true);
  }, 60_000);

  it('settles QuickPick tickets of 12 games in one batch and pays a winning line', async () => {
    const ctx = setup();
    const { sim } = ctx;
    const keeper = ctx.keeper();
    await keeper.tick(); // open 1
    const { numbers, moonball } = numbersOf(ctx, 1n);
    const winner = randomAddress();
    // 84 games in 7 tickets, one purchase: the sure winner is the last line of a full ticket.
    const games = Array.from({ length: 84 }, () => quickPick());
    games[23] = lineHitting(numbers, moonball, 3);
    const tickets = Starfall.ticketsFor(1n, games, winner);
    expect(tickets.length).toBe(7);
    expect(Starfall.linesOf(tickets[1]).length).toBe(11);
    expect(sim.buyPackage(tickets, BUYER)).toBe(1);
    passing(sim, draw(sim, 1n).salesClose);
    await keeper.tick(); // reveal
    oracleAnswers(sim);
    await keeper.tick(); // compute
    expect((await keeper.tick()).done).toEqual(['settle 1 from 0']);
    expect((await keeper.tick()).done).toEqual(['finalise 1']);
    expect(draw(sim, 1n).fee).toBe(84n * FEE);
    expect(sim.getLedger().progress.lookup(1n).winners[7]).toBeGreaterThanOrEqual(1n); // the 3 + Moonball
    for (let pass = 0; pass < 10 && sim.entitlementsOf(1n).some((id) => !sim.getLedger().entitlements.lookup(id).paid); pass++) {
      await keeper.tick();
    }
    for (const id of sim.entitlementsOf(1n)) expect(sim.getLedger().entitlements.lookup(id).paid).toBe(true);
    if (sim.payments) expect(sim.payments.some((p) => p.to === hex(winner) && p.amount > 0n)).toBe(true);
  }, 120_000);

  it('finalises an unsold draw straight away, and draws in order', async () => {
    const ctx = setup();
    const { sim } = ctx;
    const keeper = ctx.keeper();
    await keeper.tick();
    passing(sim, draw(sim, 1n).salesClose);
    await keeper.tick(); // reveal 1, open 2
    oracleAnswers(sim);
    expect((await keeper.tick()).done).toEqual(['compute 1']);
    expect((await keeper.tick()).done).toEqual(['finalise 1']);
    expect(draw(sim, 1n).status).toBe(DrawStatus.settled);
    expect(draw(sim, 1n).fee).toBe(0n);
  }, 60_000);

  it('voids a draw the oracle never answered, then refunds every ticket, a few per pass', async () => {
    const ctx = setup();
    const { sim } = ctx;
    const keeper = ctx.keeper({ paymentsPerPass: 4, openNew: false });
    openFirst(ctx);
    const buyers = Array.from({ length: 6 }, () => randomAddress());
    for (const b of buyers) sim.buyTickets([makeTicket(1n, quickPick(), b)], b);
    passing(sim, draw(sim, 1n).salesClose);
    expect((await keeper.tick()).done).toEqual(['reveal 1']);
    // Nobody answers.
    passing(sim, draw(sim, 1n).drawDeadline);
    expect((await keeper.tick()).done).toEqual(['void 1']);
    const first = await keeper.tick();
    expect(first.done).toEqual(['refund 1 #0', 'refund 1 #1', 'refund 1 #2', 'refund 1 #3']);
    expect(first.skipped.filter((s) => s.reason === 'next pass').map((s) => s.step)).toEqual(['refund 1 #4', 'refund 1 #5']);
    expect((await keeper.tick()).done).toEqual(['refund 1 #4', 'refund 1 #5']);
    for (let i = 0n; i < 6n; i++) expect(sim.getLedger().tickets.lookup(i + 4_294_967_296n).refunded).toBe(true);
    if (sim.payments) for (const b of buyers) expect(sim.payments).toContainEqual({ to: hex(b), amount: PRICE });
  }, 60_000);

  it('back after missing a reveal: voids that draw and opens the next in the same pass, then refunds', async () => {
    // Chaos test 3 (1 Nov 2026): the next draw opened only a pass of refunds after the void.
    const ctx = setup();
    const { sim } = ctx;
    const keeper = ctx.keeper({ paymentsPerPass: 2 });
    expect((await keeper.tick()).done).toEqual(['open after 0']);
    for (let i = 0; i < 3; i++) sim.buyTickets([makeTicket(1n, quickPick(), BUYER)], BUYER);
    // The keeper is down through draw 1's close and reveal deadline.
    passing(sim, draw(sim, 1n).revealDeadline);
    expect((await keeper.tick()).done).toEqual(['void 1', 'open after 1']);
    expect(draw(sim, 1n).status).toBe(DrawStatus.voided);
    expect(draw(sim, 2n).status).toBe(DrawStatus.open);
    // Then the refunds, a few per pass.
    expect((await keeper.tick()).done).toEqual(['refund 1 #0', 'refund 1 #1']);
  }, 60_000);

  it('voids a draw that was not settled in time, and refunds it', async () => {
    const ctx = setup();
    const { sim } = ctx;
    // This keeper can't settle (no settlement secret), so the draw runs late.
    const keeper = ctx.keeper({ settlementSecret: undefined, openNew: false });
    openFirst(ctx);
    sim.buyTickets([makeTicket(1n, quickPick(), BUYER)], BUYER);
    passing(sim, draw(sim, 1n).salesClose);
    await keeper.tick();
    oracleAnswers(sim);
    expect((await keeper.tick()).done).toEqual(['compute 1']);
    expect((await keeper.tick()).done).toEqual([]);
    passing(sim, draw(sim, 1n).settleDeadline);
    expect((await keeper.tick()).done).toEqual(['void 1']);
    expect((await keeper.tick()).done).toEqual(['refund 1 #0']);
  }, 60_000);

  it("won't settle with someone else's settlement secret", async () => {
    const ctx = setup();
    const { sim } = ctx;
    const errors: string[] = [];
    const logger = { info() {}, warn() {}, error: (m: string) => errors.push(m) };
    const keeper = ctx.keeper({ settlementSecret: randomScalar(), logger, openNew: false });
    openFirst(ctx);
    sim.buyTickets([makeTicket(1n, quickPick(), BUYER)], BUYER);
    passing(sim, draw(sim, 1n).salesClose);
    await keeper.tick();
    oracleAnswers(sim);
    await keeper.tick(); // compute
    const r = await keeper.tick();
    expect(r.done).toEqual([]);
    expect(errors.some((e) => /settlement secret given isn't this deployment's/.test(e))).toBe(true);
    // And decrypting with it fails with a clear message.
    expect(() => decryptTickets(storedTicketsOf(sim.getLedger(), 1n), 1n, randomScalar(), sim.addressBytes)).toThrow(/ticket 0 of draw 1/);
    expect(decryptTickets(storedTicketsOf(sim.getLedger(), 1n), 1n, ctx.settlementSecret, sim.addressBytes)).toHaveLength(1);
  }, 60_000);
});

describe('the standby keeper', () => {
  it("leaves the primary's steps alone while the primary is working", async () => {
    const ctx = setup();
    const { sim } = ctx;
    const primary = ctx.keeper({ split: { index: 0, of: 2 } });
    const standby = ctx.keeper({ role: 'standby', split: { index: 1, of: 2 } });
    const both = async () => ({ p: await primary.tick(), s: await standby.tick() });

    let r = await both();
    expect(r.p.done).toEqual(['open after 0']);
    expect(r.s.done).toEqual([]);
    // A game that can't win, so there's nothing to pay (a payment could be the standby's share).
    const { numbers, moonball } = numbersOf(ctx, 1n);
    const loser = { ...lineHitting(numbers, moonball, 0), moonball: (moonball % 20) + 1 };
    sim.buyTickets([makeTicket(1n, loser, BUYER)], BUYER);
    passing(sim, draw(sim, 1n).salesClose);
    r = await both();
    expect(r.p.done).toEqual(['reveal 1']);
    expect(r.s.done).toEqual([]);
    oracleAnswers(sim);
    r = await both();
    expect(r.p.done).toEqual(['compute 1']);
    expect(r.s.done).toEqual([]);
    r = await both();
    expect(r.p.done).toEqual(['settle 1 from 0']);
    expect(r.s.done).toEqual([]);
    r = await both();
    expect(r.p.done).toEqual(['finalise 1']);
    expect(r.s.done).toEqual([]);
  }, 60_000);

  it('takes over once a step has been overdue for its take-over time', async () => {
    const ctx = setup();
    const { sim } = ctx;
    const warnings: string[] = [];
    const standby = ctx.keeper({ role: 'standby', takeOverAfterSecs: 300, logger: { info() {}, warn: (m) => warnings.push(m), error() {} } });

    // The primary never starts: the standby waits, then opens the first draw itself.
    let r = await standby.tick();
    expect(r.done).toEqual([]);
    expect(r.skipped).toEqual([{ step: 'open after 0', reason: "the other keeper's step" }]);
    sim.advance(299);
    expect((await standby.tick()).done).toEqual([]);
    sim.advance(2);
    expect((await standby.tick()).done).toEqual(['open after 0']);
    expect(warnings.some((w) => /taking over: open a new draw/.test(w))).toBe(true);

    // It knows the seed (worked out from the organiser secret), so it can reveal too.
    passing(sim, draw(sim, 1n).salesClose);
    expect((await standby.tick()).done).toEqual([]);
    sim.advance(300);
    expect((await standby.tick()).done).toEqual(['reveal 1']);
    expect(draw(sim, 1n).status).toBe(DrawStatus.requested);
    expect(draw(sim, 2n).status).toBe(DrawStatus.open);
  }, 60_000);

  it('carries on settling from the next batch when the primary stops halfway', async () => {
    const ctx = setup();
    const { sim } = ctx;
    const primary = ctx.keeper({ openNew: false });
    const standby = ctx.keeper({ role: 'standby', openNew: false, takeOverAfterSecs: 300 });
    openFirst(ctx);
    sim.buyPackage(Array.from({ length: TWO_BATCHES }, () => makeTicket(1n, quickPick(), randomAddress())), BUYER);
    passing(sim, draw(sim, 1n).salesClose);
    await primary.tick(); // reveal
    oracleAnswers(sim);
    await primary.tick(); // compute
    expect((await standby.tick()).done).toEqual([]);
    expect((await primary.tick()).done).toEqual(['settle 1 from 0']);
    // The primary stops here.
    expect((await standby.tick()).done).toEqual([]);
    sim.advance(301);
    expect((await standby.tick()).done).toEqual([`settle 1 from ${Starfall.pureCircuits.batchSize()}`]);
    // Having stepped in, it keeps going without waiting again.
    expect((await standby.tick()).done).toEqual(['finalise 1']);
    expect(draw(sim, 1n).status).toBe(DrawStatus.settled);
  }, 60_000);

  it('splits the refunds: each keeper sends its share at once, and the other share once overdue', async () => {
    const ctx = setup();
    const { sim } = ctx;
    const primary = ctx.keeper({ split: { index: 0, of: 2 }, openNew: false, takeOverAfterSecs: 300 });
    const standby = ctx.keeper({ role: 'standby', split: { index: 1, of: 2 }, openNew: false, takeOverAfterSecs: 300, paymentsPerPass: 1 });
    openFirst(ctx);
    for (let i = 0; i < 4; i++) sim.buyTickets([makeTicket(1n, quickPick(), randomAddress())], BUYER);
    passing(sim, draw(sim, 1n).salesClose);
    await primary.tick();
    passing(sim, draw(sim, 1n).drawDeadline);
    expect((await standby.tick()).done).toEqual([]); // voiding is the primary's
    expect((await primary.tick()).done).toEqual(['void 1']);

    expect((await primary.tick()).done).toEqual(['refund 1 #0', 'refund 1 #2']);
    expect((await standby.tick()).done).toEqual(['refund 1 #1']); // one a pass
    // The standby stops; the primary takes its last refund over after 5 minutes.
    expect((await primary.tick()).done).toEqual([]);
    sim.advance(301);
    expect((await primary.tick()).done).toEqual(['refund 1 #3']);
  }, 60_000);

  it('shares out payments by entitlement id and refunds by ticket index', () => {
    const id = (first: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 3 ? first : 0));
    const pay = (n: number): StarfallStep => ({ kind: 'pay', draw: 1n, id: id(n) });
    const refund = (i: bigint): StarfallStep => ({ kind: 'refund', draw: 1n, index: i });
    expect([0, 1, 2, 3].map((n) => shareOf(pay(n), 2))).toEqual([0, 1, 0, 1]);
    expect([0n, 1n, 2n].map((i) => shareOf(refund(i), 3))).toEqual([0, 1, 2]);
    expect(shareOf({ kind: 'open', final: false }, 2)).toBeUndefined();
    expect(isMine({ kind: 'open', final: false }, 'primary', { index: 0, of: 2 })).toBe(true);
    expect(isMine({ kind: 'open', final: false }, 'standby', { index: 1, of: 2 })).toBe(false);
    expect(isMine(refund(1n), 'standby', { index: 1, of: 2 })).toBe(true);
    expect(isMine(refund(1n), 'primary', { index: 0, of: 2 })).toBe(false);
    expect(() => setup().keeper({ split: { index: 2, of: 2 } })).toThrow(/split/);
  });
});

describe('derived seeds', () => {
  it('gives the same seed for a draw to anyone with the organiser secret, and differs by deployment', async () => {
    const secret = generateOperatorSecret();
    const a = new DerivedSeeds(secret, new Uint8Array(32).fill(1));
    const b = new DerivedSeeds(secret, new Uint8Array(32).fill(1));
    const other = new DerivedSeeds(secret, new Uint8Array(32).fill(2));
    const s = await a.forDraw(5n);
    expect(hex(s.seed)).toBe(hex((await b.forDraw(5n)).seed));
    expect(hex(s.seed)).not.toBe(hex((await other.forDraw(5n)).seed));
    expect(hex(s.seed)).not.toBe(hex((await a.forDraw(6n)).seed));
    expect(hex(s.commitment)).toBe(hex(commitmentOf(s.seed)));
    // Found under its own number, or a nearby one (a draw that got another number than expected).
    expect(hex((await a.find(s.commitment, 5n))!)).toBe(hex(s.seed));
    expect(hex((await a.find(s.commitment, 7n))!)).toBe(hex(s.seed));
    expect(await a.find(s.commitment, 20n)).toBeUndefined();
    expect(await other.find(s.commitment, 5n)).toBeUndefined();
  });
});

describe('the Starfall plan', () => {
  const base = (draws: Partial<StarfallView['draws'][number]>[]): StarfallView => ({
    lastDraw: BigInt(draws.length),
    minSales: 600n,
    maxSales: 86_400n,
    ticketPrice: PRICE,
    feePerGame: FEE,
    revealWindow: 600n,
    drawWindow: 600n,
    settleWindow: 3_600n,
    maxTicketsPerDraw: 10_000n,
    carry: 0n,
    finalSales: 1_200n,
    ended: false,
    mustBeWonAfter: 5n,
    rollovers: 0n,
    oracleKeyReady: true,
    settlementKey: { x: 0n, y: 0n },
    entitlements: [],
    draws: draws.map((d, i) => ({
      id: BigInt(i + 1),
      status: DrawStatus.drawn,
      salesClose: 0n,
      revealDeadline: 0n,
      drawDeadline: 0n,
      settleDeadline: 10_000n,
      seedCommitment: new Uint8Array(32),
      oracleKey: { x: 0n, y: 0n },
      seed: new Uint8Array(32),
      output: new Uint8Array(32),
      numbers: [],
      moonball: 0,
      tickets: 0n,
      settled: 0n,
      games: 0n,
      winners: [],
      carried: 0n,
      fee: 0n,
      prizes: [],
      final: false,
      mustBeWon: false,
      finalShare: 0n,
      unrefunded: [],
      refundedGames: 0n,
      ...d,
    })),
  });
  const opts = { marginSecs: 30, openNew: false, organise: true, settle: true };

  it('settles the next batch, but finalises only after the previous draw', () => {
    const view = base([{ tickets: 50n, settled: 25n }, { tickets: 3n, settled: 3n }]);
    expect(starfallSteps(view, 1_000, opts)).toEqual([{ kind: 'settle', draw: 1n, from: 25n, of: 50n }]);
    expect(starfallSteps(view, 1_000, { ...opts, settle: false })).toEqual([]);
    const done = base([{ status: DrawStatus.settled }, { tickets: 3n, settled: 3n }]);
    expect(starfallSteps(done, 1_000, opts)).toEqual([{ kind: 'finalise', draw: 2n }]);
  });

  it('voids a draw past its settlement deadline instead of settling it', () => {
    const view = base([{ tickets: 50n, settled: 25n, settleDeadline: 1_000n }]);
    expect(starfallSteps(view, 999, opts)).toEqual([{ kind: 'settle', draw: 1n, from: 25n, of: 50n }]);
    expect(starfallSteps(view, 1_010, opts)).toEqual([]);
    expect(starfallSteps(view, 1_030, opts)).toEqual([{ kind: 'void', draw: 1n, reason: 'it was not settled in time' }]);
  });

  it('opens the next draw in the same pass as voiding a draw whose reveal was missed, after the void and before refunds', () => {
    const view = base([
      { status: DrawStatus.voided, unrefunded: [3n, 4n] },
      { status: DrawStatus.open, salesClose: 100n, revealDeadline: 700n },
    ]);
    // Before the deadline (and its margin): nothing to do yet.
    expect(starfallSteps(view, 720, { ...opts, openNew: true })).toEqual([
      { kind: 'refund', draw: 1n, index: 3n },
      { kind: 'refund', draw: 1n, index: 4n },
    ]);
    // Past it: void, then open, then the refunds.
    expect(starfallSteps(view, 740, { ...opts, openNew: true })).toEqual([
      { kind: 'void', draw: 2n, reason: 'its seed was not revealed in time' },
      { kind: 'open', final: false },
      { kind: 'refund', draw: 1n, index: 3n },
      { kind: 'refund', draw: 1n, index: 4n },
    ]);
    // Without openNew, or without the organiser's seeds, only the void.
    expect(starfallSteps(view, 740, opts).map((x) => x.kind)).toEqual(['void', 'refund', 'refund']);
    expect(starfallSteps(view, 740, { ...opts, openNew: true, organise: false }).map((x) => x.kind)).toEqual(['void', 'refund', 'refund']);
  });

  it("doesn't open or reveal without the organiser's seeds", () => {
    const view = base([{ status: DrawStatus.open, salesClose: 100n, revealDeadline: 2_000n }]);
    expect(starfallSteps(view, 200, { ...opts, openNew: true })).toEqual([{ kind: 'reveal', draw: 1n, openNext: true, final: false }]);
    expect(starfallSteps(view, 200, { ...opts, openNew: true, organise: false })).toEqual([]);
  });

  it('winding down, announces the final draw when the draw on sale is revealed, and opens nothing while it runs or once the game has ended', () => {
    const wind = { ...opts, openNew: true, final: true };
    const selling = base([{ status: DrawStatus.open, salesClose: 100n, revealDeadline: 2_000n }]);
    expect(starfallSteps(selling, 200, wind)).toEqual([{ kind: 'reveal', draw: 1n, openNext: true, final: true }]);
    // The final draw itself is revealed without opening another.
    const finalSelling = base([{ status: DrawStatus.settled }, { status: DrawStatus.open, final: true, salesClose: 100n, revealDeadline: 2_000n }]);
    expect(starfallSteps(finalSelling, 200, wind)).toEqual([{ kind: 'reveal', draw: 2n, openNext: false, final: false }]);
    expect(starfallSteps(finalSelling, 200, { ...opts, openNew: true })).toEqual([{ kind: 'reveal', draw: 2n, openNext: false, final: false }]);
    // While it settles, nothing opens, even when no longer winding down.
    const finalDrawn = base([{ status: DrawStatus.settled }, { final: true, tickets: 3n, settled: 3n }]);
    expect(starfallSteps(finalDrawn, 200, { ...opts, openNew: true })).toEqual([{ kind: 'finalise', draw: 2n }]);
    // Once it has given everything out, its shares are paid and nothing more opens.
    const ended = { ...base([{ status: DrawStatus.settled }, { status: DrawStatus.settled, final: true, finalShare: 5n, unrefunded: [0n, 2n] }]), ended: true };
    expect(starfallSteps(ended, 200, { ...opts, openNew: true })).toEqual([
      { kind: 'refund', draw: 2n, index: 0n, share: true },
      { kind: 'refund', draw: 2n, index: 2n, share: true },
    ]);
  });

  it("says when a draw's jackpot must be won: after the rollovers, or possibly, while a draw before it is still settling", () => {
    const selling = (rollovers: bigint, before: StarfallView['draws'][number]['status'] = DrawStatus.settled) => ({
      ...base([{ status: before }, { status: DrawStatus.open }]),
      rollovers,
    });
    expect(mustBeWonStatus(selling(4n), 2n)).toBe('no');
    expect(mustBeWonStatus(selling(5n), 2n)).toBe('yes');
    expect(mustBeWonStatus(selling(4n, DrawStatus.drawn), 2n)).toBe('possible');
    expect(mustBeWonStatus(selling(3n, DrawStatus.drawn), 2n)).toBe('no');
    // With the rule off, only a final draw.
    expect(mustBeWonStatus({ ...selling(9n), mustBeWonAfter: 0n }, 2n)).toBe('no');
    const final = base([{ status: DrawStatus.settled }, { status: DrawStatus.open, final: true }]);
    expect(mustBeWonStatus({ ...final, mustBeWonAfter: 0n }, 2n)).toBe('yes');
    // The feed passes it on with the draw on sale.
    const feed = buildStarfallFeed(selling(5n), { network: 'local', contract: 'x', nowSecs: 0 });
    expect(feed.games.starfall.open?.must_be_won).toBe('yes');
    expect(feed.games.starfall).toMatchObject({ must_be_won_after: 5, rollovers: 5 });
    expect(buildStarfallFeed(selling(1n), { network: 'local', contract: 'x', nowSecs: 0 }).games.starfall.open?.must_be_won).toBeUndefined();
  });

  it('winding down with nothing selling, opens a final draw only if there is a rollover to give out', () => {
    const wind = { ...opts, openNew: true, final: true };
    const after = (carry: bigint, d: Partial<StarfallView['draws'][number]>[] = [{ status: DrawStatus.settled }]) => ({ ...base(d), carry });
    expect(starfallSteps(after(0n), 200, wind)).toEqual([]);
    expect(starfallSteps(after(5_000n), 200, wind)).toEqual([{ kind: 'open', final: true }]);
    // A void or empty final draw kept the rollover: another final draw opens.
    expect(starfallSteps(after(5_000n, [{ status: DrawStatus.voided, final: true }]), 200, wind)).toEqual([{ kind: 'open', final: true }]);
    // Not until the draws before it are finished, so the rollover is known.
    expect(starfallSteps(after(5_000n, [{ status: DrawStatus.settled }, { status: DrawStatus.drawn, tickets: 1n, settled: 0n }]), 200, wind)).toEqual([
      { kind: 'settle', draw: 2n, from: 0n, of: 1n },
    ]);
  });
});

describe('the Starfall site feed', () => {
  it('shows settlement progress, then a settled draw whose prizes and rollover check out', async () => {
    const ctx = setup();
    const { sim, chain } = ctx;
    const keeper = ctx.keeper();
    const feed = async () => buildStarfallFeed(await chain.view(), { network: 'local', contract: sim.address, nowSecs: sim.now });
    await keeper.tick();
    const { numbers, moonball } = numbersOf(ctx, 1n);
    const games = [makeTicket(1n, lineHitting(numbers, moonball, 3), randomAddress())];
    for (let i = 1; i < TWO_BATCHES; i++) games.push(makeTicket(1n, quickPick(), randomAddress()));
    sim.buyPackage(games, BUYER);

    let f = await feed();
    const game = f.games.starfall;
    expect(game.price_star).toBe(1_200_000);
    expect(game.fee_star).toBe(200_000);
    expect(game.allocation_bp).toEqual([3350, 185, 230, 200, 150, 940, 730, 1550, 2665]);
    expect(game.open).toMatchObject({ num: 1, games_sold: TWO_BATCHES });
    // the monitor warns before the reveal deadline
    expect(game.open!.reveal_deadline).toBe(new Date(Number(draw(sim, 1n).revealDeadline) * 1000).toISOString());
    expect(game.draws).toEqual([]);

    passing(sim, draw(sim, 1n).salesClose);
    await keeper.tick();
    oracleAnswers(sim);
    await keeper.tick(); // numbers
    f = await feed();
    let d1 = f.games.starfall.draws.find((d) => d.num === 1)!;
    expect(d1).toMatchObject({ status: 'drawn', numbers, moonball, batches: 2, batches_done: 0 });
    expect(d1.settle_deadline).toBeDefined();
    expect(f.games.starfall.open?.num).toBe(2);

    await keeper.tick(); // first batch
    d1 = (await feed()).games.starfall.draws.find((d) => d.num === 1)!;
    expect(d1).toMatchObject({ status: 'settling', batches: 2, batches_done: 1 });

    await keeper.tick();
    await keeper.tick(); // finalise
    d1 = (await feed()).games.starfall.draws.find((d) => d.num === 1)!;
    expect(d1.status).toBe('settled');
    // The site's check: prizes and rollover by Powerball's rules from the games sold and the winners.
    const pool = BigInt(TWO_BATCHES) * (PRICE - FEE);
    const expected = Starfall.prizesByPowerballRules(pool, BigInt(d1.carried_in_star!), d1.winners!.map(BigInt));
    expect(d1.prizes_star).toEqual(expected.prizes.map(Number));
    expect(d1.carry_out_star).toBe(Number(expected.carry));
    expect(d1.winners![7]).toBeGreaterThanOrEqual(1); // the sure 3 + Moonball
  }, 60_000);

  it('records when each step happened, as the keeper saw it, and keeps them across a restart', async () => {
    const ctx = setup();
    const { sim, chain } = ctx;
    const keeper = ctx.keeper();
    const dir = mkdtempSync(join(tmpdir(), 'steps-'));
    const path = join(dir, 'feed.json.steps.json');
    let times = new StepTimes(path);
    const feed = async () => {
      const view = await chain.view();
      times.observe(view, sim.now);
      return buildStarfallFeed(view, { network: 'local', contract: sim.address, nowSecs: sim.now, steps: times.lookup() });
    };
    await keeper.tick();
    sim.buyTickets([makeTicket(1n, quickPick(), BUYER)], BUYER);
    await feed();
    passing(sim, draw(sim, 1n).salesClose);
    await keeper.tick(); // reveal
    const revealedAt = sim.now;
    let d1 = (await feed()).games.starfall.draws.find((d) => d.num === 1)!;
    expect(d1.timeline).toEqual({ revealed_at: new Date(revealedAt * 1000).toISOString() });
    sim.advance(20);
    oracleAnswers(sim);
    const answeredAt = sim.now;
    await feed();
    sim.advance(100);
    await keeper.tick(); // numbers
    times = new StepTimes(path); // a restarted keeper reads the file back
    d1 = (await feed()).games.starfall.draws.find((d) => d.num === 1)!;
    expect(d1.timeline).toEqual({
      revealed_at: new Date(revealedAt * 1000).toISOString(),
      answered_at: new Date(answeredAt * 1000).toISOString(),
      drawn_at: d1.drawn_at,
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))['1']).toMatchObject({ revealed: revealedAt, answered: answeredAt });
    for (let i = 0; i < 3; i++) await keeper.tick(); // settle, finalise
    d1 = (await feed()).games.starfall.draws.find((d) => d.num === 1)!;
    expect(d1.status).toBe('settled');
    expect(d1.timeline?.settled_at).toBeDefined();
  }, 60_000);

  it("links each step to the transaction the keeper sent it in, across a restart; a failing listener doesn't stop the keeper", async () => {
    const ctx = setup();
    const { sim } = ctx;
    // The simulator has no transactions: this chain makes up an id for each step it sends.
    let n = 0;
    const id = (step: string) => `${step}-${++n}`;
    class IdChain extends StarfallSimulatorChain {
      override async openDraw(c: bigint, s: Uint8Array) {
        await super.openDraw(c, s);
        return id('open');
      }
      override async requestDraw(d: bigint, seed: Uint8Array, next?: Parameters<StarfallSimulatorChain['requestDraw']>[2]) {
        await super.requestDraw(d, seed, next);
        return id('request');
      }
      override async computeNumbers(d: bigint) {
        await super.computeNumbers(d);
        return id('numbers');
      }
      override async finaliseDraw(d: bigint) {
        await super.finaliseDraw(d);
        return id('finalise');
      }
    }
    const chain = new IdChain(sim);
    const dir = mkdtempSync(join(tmpdir(), 'steps-'));
    const path = join(dir, 'feed.json.steps.json');
    let times = new StepTimes(path);
    let fail = false;
    const keeper = ctx.keeper({
      chain,
      onTx: (draw, step, txId) => {
        if (fail) throw new Error('disk full');
        times.noteTx(draw, step, txId);
      },
    });
    const feed = async () => {
      const view = await chain.view();
      times.observe(view, sim.now);
      return buildStarfallFeed(view, { network: 'local', contract: sim.address, nowSecs: sim.now, steps: times.lookup() });
    };
    await keeper.tick(); // opens draw 1
    sim.buyTickets([makeTicket(1n, quickPick(), BUYER)], BUYER);
    passing(sim, draw(sim, 1n).salesClose);
    await keeper.tick(); // reveals draw 1 and opens draw 2 in the same transaction
    let f = await feed();
    expect(f.games.starfall.draws.find((d) => d.num === 1)!.tx).toEqual({ open: 'open-1', reveal: 'request-2' });
    expect(times.get(2n)?.tx).toEqual({ open: 'request-2' }); // draw 2 is on sale: the feed lists it under open, and its tx once it closes
    sim.advance(20);
    oracleAnswers(sim);
    sim.advance(100);
    await keeper.tick(); // numbers
    times = new StepTimes(path); // a restarted keeper reads the ids back
    for (let i = 0; i < 4 && draw(sim, 1n).status !== DrawStatus.settled; i++) await keeper.tick(); // settle, finalise
    f = await feed();
    const d1 = f.games.starfall.draws.find((d) => d.num === 1)!;
    expect(d1.status).toBe('settled');
    expect(d1.tx).toEqual({ open: 'open-1', reveal: 'request-2', numbers: 'numbers-3', finalise: 'finalise-4' });
    expect(JSON.parse(readFileSync(path, 'utf8'))['1'].tx).toEqual(d1.tx);

    // The draw is settled even when its id can't be written down.
    fail = true;
    sim.buyTickets([makeTicket(2n, quickPick(), BUYER)], BUYER);
    passing(sim, draw(sim, 2n).salesClose);
    await keeper.tick();
    expect(draw(sim, 2n).status).toBe(DrawStatus.requested);
  }, 60_000);

  it("merges transaction ids read back from the chain under the keeper's own, and picks up a new backfill file", () => {
    const dir = mkdtempSync(join(tmpdir(), 'steps-'));
    const back = join(dir, 'feed.json.backfill.json');
    const times = new StepTimes(join(dir, 'feed.json.steps.json'), 60, back);
    times.noteTx(5n, 'numbers', 'mine');
    expect(times.lookup()(4n)).toBeUndefined(); // no backfill file yet
    writeFileSync(back, JSON.stringify({ 4: { tx: { reveal: 'r4', numbers: 'n4' } }, 5: { tx: { numbers: 'old', finalise: 'f5' } } }));
    const look = times.lookup();
    expect(look(4n)).toEqual({ tx: { reveal: 'r4', numbers: 'n4' } });
    expect(look(5n)?.tx).toEqual({ numbers: 'mine', finalise: 'f5' }); // its own record wins
  });

  it('counts games (not tickets) sold and refunded: a System 8 is one ticket of 8 games', async () => {
    const ctx = setup();
    const { sim, chain } = ctx;
    const keeper = ctx.keeper({ openNew: false, paymentsPerPass: 1 });
    openFirst(ctx);
    const system8 = makeTicket(1n, { numbers: [1, 2, 3, 4, 5, 6, 7, 8], moonball: 9 }, BUYER);
    sim.buyTickets([system8, makeTicket(1n, quickPick(), BUYER)], BUYER);
    expect(buildStarfallFeed(await chain.view(), { network: 'local', contract: sim.address, nowSecs: sim.now }).games.starfall.open).toMatchObject(
      { num: 1, games_sold: 9, tickets: 2 },
    );
    passing(sim, draw(sim, 1n).revealDeadline);
    await keeper.tick(); // void
    await keeper.tick(); // one refund: ticket 0, the System 8
    const f = buildStarfallFeed(await chain.view(), { network: 'local', contract: sim.address, nowSecs: sim.now });
    expect(f.games.starfall.draws[0]).toMatchObject({ num: 1, status: 'void', games_sold: 9, tickets: 2, refunded: 8 });
  }, 60_000);
});
