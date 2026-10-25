import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DrawStatus, LottoSimulator, makeTicket, type PlainLine, pureCircuits } from '@lunardraw/contract';
import { generateOperatorSecret, generateOracleSecretKey, pureCircuits as nightcast } from '@nightcast/contract';
import { combineDrawSeed, drawStarfall } from '@nightcast/sdk';
import { type ChainView, type LunardrawChain, SimulatorChain } from '../chain.js';
import { dueSteps, Keeper, stepKey } from '../keeper.js';
import { every, STARFALL_WEEKLY, weekly } from '../schedule.js';
import { commitmentOf, FileSeedStore, MemorySeedStore, type SeedStore } from '../seeds.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const PLAYER = new Uint8Array(32).fill(7);
const SALES = 7_200; // the tests' draws sell for two hours
const CLAIM = 3_600;

const setup = (opts: { seeds?: SeedStore } = {}) => {
  const oracleSecretKey = generateOracleSecretKey();
  const sim = new LottoSimulator({
    oracleSecretKey,
    organiserSecret: generateOperatorSecret(),
    minSales: 600n,
    maxSales: 30n * 86_400n,
    revealWindow: 3_600n,
    drawWindow: 3_600n,
    claimWindow: BigInt(CLAIM),
  });
  const chain = new SimulatorChain(sim);
  const seeds = opts.seeds ?? new MemorySeedStore();
  // A local clock that follows the simulator, so grace periods and backoff
  // move with simulated time.
  const clock = () => sim.now * 1000;
  const keeper = new Keeper({ chain, seeds, schedule: every(SALES), clock, backoffMs: 1_000 });
  return { sim, chain, seeds, keeper, oracleSecretKey, clock };
};

type Setup = ReturnType<typeof setup>;

/** The oracle's part: answer every requested draw. */
const oracleAnswers = (sim: LottoSimulator) => {
  for (const [id, d] of sim.getLedger().draws) if (d.status === DrawStatus.requested) sim.fulfilDraw(id);
};

/** The numbers draw `n` will have, from its sealed seed and the oracle key. */
const numbersOf = async ({ sim, seeds, oracleSecretKey }: Setup, n: bigint) => {
  const d = sim.getLedger().draws.lookup(n);
  const seed = (await seeds.find(d.seedCommitment))!;
  const output = nightcast.evaluate(oracleSecretKey, sim.alphaOf(n, seed));
  return drawStarfall(combineDrawSeed(hex(seed), output));
};

const lineHitting = (numbers: number[], moonball: number, match: number): PlainLine => {
  const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !numbers.includes(x));
  return { numbers: [...numbers.slice(0, match), ...misses.slice(0, 7 - match)], moonball };
};

const statusOf = (sim: LottoSimulator, n: bigint) => sim.getLedger().draws.lookup(n).status;

/** Advance to just past a boundary plus the keeper's margin. */
const passing = (sim: LottoSimulator, boundary: bigint) => {
  const t = Number(boundary) + 31;
  if (sim.now < t) sim.advance(t - sim.now);
};

describe('the keeper', () => {
  it('runs draws from opening to paying a winner, and keeps them rolling', async () => {
    const ctx = setup();
    const { sim, keeper } = ctx;

    // First pass: no draw yet, so it opens one on the schedule.
    expect((await keeper.tick()).done).toEqual(['open after 0']);
    const first = sim.getLedger().draws.lookup(1n);
    expect(first.status).toBe(DrawStatus.open);
    expect(first.salesClose % BigInt(SALES)).toBe(0n);
    expect((await keeper.tick()).done).toEqual([]);

    // A player buys a winning ticket (3 + Moonball: division 8).
    const { numbers, moonball } = await numbersOf(ctx, 1n);
    const ticket = makeTicket(1n, [lineHitting(numbers, moonball, 3)]);
    sim.buyTicket(ticket);

    // Eight hours pass. The keeper looks every 10 minutes; the oracle answers
    // whatever is waiting; the winner registers once the numbers are out.
    const done: string[] = [];
    let registered = false;
    for (let minute = 0; minute < 8 * 60; minute += 10) {
      sim.advance(600);
      oracleAnswers(sim);
      done.push(...(await keeper.tick()).done);
      if (!registered && statusOf(sim, 1n) === DrawStatus.drawn) {
        expect(sim.getLedger().draws.lookup(1n).numbers.map(Number)).toEqual(numbers);
        expect(sim.registerWin(ticket, 0n, PLAYER)).toBe(8n);
        registered = true;
      }
    }

    // Draw 1 went all the way: revealed (opening draw 2), computed, settled, paid.
    const line = pureCircuits.lineId(sim.commitmentOf(ticket), 0n);
    for (const step of ['reveal 1', 'compute 1', 'settle 1', `pay ${hex(line)}`]) expect(done).toContain(step);
    expect(sim.getLedger().wins.lookup(line).paid).toBe(true);
    // A new draw every two hours, none of them voided, the older ones settled.
    const ledger = sim.getLedger();
    expect(ledger.lastDraw).toBeGreaterThanOrEqual(4n);
    const statuses = Array.from(ledger.draws)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, d]) => d.status);
    expect(statuses).not.toContain(DrawStatus.voided);
    expect(statuses.slice(0, 2)).toEqual([DrawStatus.settled, DrawStatus.settled]);
    // Every later draw was opened by the reveal before it, never on its own.
    expect(done.filter((d) => d.startsWith('open'))).toEqual([]);
  });

  it('sends nothing twice while the chain is unchanged', async () => {
    const { keeper } = setup();
    await keeper.tick();
    const again = await keeper.tick();
    expect(again.done).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  it('voids a draw whose seed was lost, then opens a new one', async () => {
    const ctx = setup();
    const { sim, chain, clock } = ctx;
    await ctx.keeper.tick();
    const first = sim.getLedger().draws.lookup(1n);

    // The keeper is restarted with an empty seed store: draw 1's seed is gone.
    const forgetful = new Keeper({ chain, seeds: new MemorySeedStore(), schedule: every(SALES), clock });
    passing(sim, first.salesClose);
    expect((await forgetful.tick()).skipped).toEqual([{ step: 'reveal 1', reason: 'cannot be sent' }]);
    expect(statusOf(sim, 1n)).toBe(DrawStatus.open);

    passing(sim, first.revealDeadline);
    expect((await forgetful.tick()).done).toEqual(['void 1']);
    expect(statusOf(sim, 1n)).toBe(DrawStatus.voided);
    expect((await forgetful.tick()).done).toEqual(['open after 1']);
    expect(statusOf(sim, 2n)).toBe(DrawStatus.open);
  });

  it("voids a draw the oracle doesn't answer, and the draw after it still settles", async () => {
    const ctx = setup();
    const { sim, keeper } = ctx;
    await keeper.tick();
    passing(sim, sim.getLedger().draws.lookup(1n).salesClose);
    expect((await keeper.tick()).done).toEqual(['reveal 1']); // and opens draw 2

    // The oracle misses draw 1.
    passing(sim, sim.getLedger().draws.lookup(1n).drawDeadline);
    expect((await keeper.tick()).done).toContain('void 1');
    expect(statusOf(sim, 1n)).toBe(DrawStatus.voided);

    // Draw 2 runs normally, and settles even though the draw before it was void.
    passing(sim, sim.getLedger().draws.lookup(2n).salesClose);
    if (statusOf(sim, 2n) === DrawStatus.open) await keeper.tick();
    expect(statusOf(sim, 2n)).toBe(DrawStatus.requested);
    oracleAnswers(sim);
    expect((await keeper.tick()).done).toContain('compute 2');
    passing(sim, sim.getLedger().draws.lookup(2n).claimDeadline);
    expect((await keeper.tick()).done).toContain('settle 2');
  });

  it('carries on after a restart, with only its seeds', async () => {
    const ctx = setup();
    const { sim, chain, seeds, clock } = ctx;
    await ctx.keeper.tick();
    // A brand-new keeper with the same seed store picks up where the first left off.
    const restarted = new Keeper({ chain, seeds, schedule: every(SALES), clock });
    passing(sim, sim.getLedger().draws.lookup(1n).salesClose);
    expect((await restarted.tick()).done).toEqual(['reveal 1']);
  });

  it("doesn't resend a step while a lagging indexer still shows it as due", async () => {
    const ctx = setup();
    const { sim, chain, seeds, clock } = ctx;
    await ctx.keeper.tick();
    passing(sim, sim.getLedger().draws.lookup(1n).salesClose);
    const stale = await chain.view();
    let reveals = 0;
    const lagging: LunardrawChain = {
      ...chain,
      view: async () => stale,
      now: () => chain.now(),
      openDraw: (c, s) => chain.openDraw(c, s),
      requestDraw: async (n, seed, next) => {
        reveals += 1;
        await chain.requestDraw(n, seed, next);
      },
      computeNumbers: (n) => chain.computeNumbers(n),
      settleDraw: (n) => chain.settleDraw(n),
      payWin: (l) => chain.payWin(l),
      voidDraw: (n) => chain.voidDraw(n),
    };
    const keeper = new Keeper({ chain: lagging, seeds, schedule: every(SALES), clock });
    expect((await keeper.tick()).done).toEqual(['reveal 1']);
    expect((await keeper.tick()).skipped).toEqual([{ step: 'reveal 1', reason: 'sent; waiting for the indexer' }]);
    expect(reveals).toBe(1);
  });

  it('backs off a failing step and reports it', async () => {
    const ctx = setup();
    const { sim, chain, seeds, clock } = ctx;
    let failuresLeft = 2;
    const flaky: LunardrawChain = Object.assign(Object.create(chain) as LunardrawChain, {
      openDraw: async (c: bigint, s: Uint8Array) => {
        if (failuresLeft-- > 0) throw new Error('node unavailable');
        await chain.openDraw(c, s);
      },
    });
    const keeper = new Keeper({ chain: flaky, seeds, schedule: every(SALES), clock, backoffMs: 1_000 });
    expect((await keeper.tick()).failed).toEqual([{ step: 'open after 0', error: 'node unavailable' }]);
    expect(keeper.status().failing).toEqual([{ step: 'open after 0', failures: 1, error: 'node unavailable' }]);
    expect((await keeper.tick()).skipped).toEqual([{ step: 'open after 0', reason: 'backing off' }]);
    sim.advance(2);
    expect((await keeper.tick()).failed).toHaveLength(1);
    sim.advance(3);
    expect((await keeper.tick()).done).toEqual(['open after 0']);
    expect(keeper.status().failing).toEqual([]);
  });

  it('winds down when told not to open new draws', async () => {
    const ctx = setup();
    const { sim, chain, seeds, clock } = ctx;
    await ctx.keeper.tick();
    const closing = new Keeper({ chain, seeds, schedule: every(SALES), clock, openNew: false });
    passing(sim, sim.getLedger().draws.lookup(1n).salesClose);
    expect((await closing.tick()).done).toEqual(['reveal 1']);
    expect(sim.getLedger().lastDraw).toBe(1n);
    expect((await closing.tick()).done).toEqual([]);
  });
});

describe('the seed store', () => {
  it('only keeps the seeds of draws still selling', async () => {
    const seeds = new MemorySeedStore();
    const ctx = setup({ seeds });
    const { sim, keeper } = ctx;
    await keeper.tick();
    expect(seeds.size).toBe(1);
    passing(sim, sim.getLedger().draws.lookup(1n).salesClose);
    await keeper.tick(); // reveal 1, open 2: draw 1's seed is public now
    expect(seeds.size).toBe(2);
    await keeper.tick();
    expect(seeds.size).toBe(1);
    expect(await seeds.find(sim.getLedger().draws.lookup(1n).seedCommitment)).toBeUndefined();
    expect(await seeds.find(sim.getLedger().draws.lookup(2n).seedCommitment)).toBeDefined();
  });

  it('prunes the seed file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lunardraw-seeds-'));
    const store = new FileSeedStore(join(dir, 'seeds.json'));
    const a = await store.create();
    const b = await store.create();
    expect(await store.forget([a.commitment])).toBe(1);
    expect(await store.find(a.commitment)).toBeUndefined();
    expect(await store.find(b.commitment)).toBeDefined();
    expect(Object.keys(JSON.parse(readFileSync(store.path, 'utf8')).seeds)).toHaveLength(1);
  });
});

describe('the background lane', () => {
  it('keeps revealing and opening draws while a slow numbers proof runs', async () => {
    const ctx = setup();
    const { sim, chain, seeds } = ctx;
    // A computeNumbers that only completes when the test says so.
    let release: (() => void) | undefined;
    const slow: LunardrawChain = Object.assign(Object.create(chain) as LunardrawChain, {
      computeNumbers: (n: bigint) =>
        new Promise<void>((res, rej) => {
          release = () => {
            try {
              sim.computeNumbers(n);
              res();
            } catch (e) {
              rej(e);
            }
          };
        }),
    });
    const keeper = new Keeper({ chain: slow, seeds, schedule: every(SALES), clock: () => sim.now * 1000, background: ['compute'] });

    expect((await keeper.tick()).done).toEqual(['open after 0']);
    passing(sim, sim.getLedger().draws.lookup(1n).salesClose);
    expect((await keeper.tick()).done).toEqual(['reveal 1']);
    oracleAnswers(sim);

    // The compute starts and the pass doesn't wait for it.
    const started = await keeper.tick();
    expect(started.skipped).toContainEqual({ step: 'compute 1', reason: 'started in the background' });
    expect(keeper.inProgress()).toEqual(['compute 1']);

    // Draw 2 closes while draw 1's proof is still running: it's revealed anyway.
    passing(sim, sim.getLedger().draws.lookup(2n).salesClose);
    const meanwhile = await keeper.tick();
    expect(meanwhile.done).toEqual(['reveal 2']);
    expect(meanwhile.skipped).toContainEqual({ step: 'compute 1', reason: 'proving in the background' });

    // The proof lands; the next pass reports it.
    release!();
    await keeper.settled();
    expect(statusOf(sim, 1n)).toBe(DrawStatus.drawn);
    expect((await keeper.tick()).done).toContain('compute 1');
    expect(keeper.inProgress()).toEqual([]);
  });

  it('reports a failed background proof and retries it later', async () => {
    const ctx = setup();
    const { sim, chain, seeds } = ctx;
    let fail = true;
    const flaky: LunardrawChain = Object.assign(Object.create(chain) as LunardrawChain, {
      computeNumbers: async (n: bigint) => {
        if (fail) throw new Error('proof server 500');
        sim.computeNumbers(n);
      },
    });
    const keeper = new Keeper({ chain: flaky, seeds, schedule: every(SALES), clock: () => sim.now * 1000, backoffMs: 1_000, background: ['compute'] });
    await keeper.tick();
    passing(sim, sim.getLedger().draws.lookup(1n).salesClose);
    await keeper.tick();
    oracleAnswers(sim);
    await keeper.tick();
    await keeper.settled();
    expect((await keeper.tick()).failed).toEqual([{ step: 'compute 1', error: 'proof server 500' }]);
    fail = false;
    sim.advance(5);
    await keeper.tick();
    await keeper.settled();
    expect(statusOf(sim, 1n)).toBe(DrawStatus.drawn);
  });
});

describe('dueSteps', () => {
  const view = (draws: Partial<ChainView['draws'][number]>[], lastDraw = BigInt(draws.length)): ChainView => ({
    lastDraw,
    minSales: 600n,
    maxSales: 86_400n * 30n,
    linePrice: 1_000_000n,
    claimWindow: 7_000n,
    carry: 0n,
    oracleKeyReady: true,
    wins: [],
    draws: draws.map((d, i) => ({
      id: BigInt(i + 1),
      status: DrawStatus.open,
      salesClose: 1_000n,
      revealDeadline: 2_000n,
      drawDeadline: 3_000n,
      claimDeadline: 10_000n,
      seedCommitment: new Uint8Array(32),
      oracleKey: { x: 0n, y: 1n },
      seed: new Uint8Array(32),
      output: new Uint8Array(32),
      numbers: [0, 0, 0, 0, 0, 0, 0],
      moonball: 0,
      lines: 0n,
      winners: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
      carried: 0n,
      prizes: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
      ...d,
    })),
  });
  const plan = (v: ChainView, now: number) => dueSteps(v, now, { marginSecs: 30, openNew: true }).map((s) => stepKey(s, v.lastDraw));

  it('waits out the margin after each boundary', () => {
    expect(plan(view([{}]), 1_029)).toEqual([]);
    expect(plan(view([{}]), 1_030)).toEqual(['reveal 1']);
    expect(plan(view([{}]), 2_030)).toEqual(['void 1']);
    // A reveal comes before a slow compute, whatever the draw order.
    const closing = { status: DrawStatus.open, salesClose: 4_000n, revealDeadline: 5_000n };
    expect(plan(view([{ status: DrawStatus.fulfilled, claimDeadline: 9_000n }, closing]), 4_030)).toEqual(['reveal 2', 'compute 1']);
  });

  it('settles in order and only after the claim window', () => {
    const drawn = { status: DrawStatus.drawn, claimDeadline: 5_000n };
    expect(plan(view([drawn, drawn]), 4_000)).toEqual(['open after 2']);
    expect(plan(view([drawn, drawn]), 5_030)).toEqual(['open after 2', 'settle 1']);
    expect(plan(view([{ status: DrawStatus.voided }, drawn]), 5_030)).toEqual(['open after 2', 'settle 2']);
  });

  it('computes, or voids once computing is too late', () => {
    const fulfilled = { status: DrawStatus.fulfilled, claimDeadline: 5_000n };
    expect(plan(view([fulfilled]), 4_999)).toEqual(['open after 1', 'compute 1']);
    expect(plan(view([fulfilled]), 5_010)).toEqual(['open after 1']);
    expect(plan(view([fulfilled]), 5_030)).toEqual(['open after 1', 'void 1']);
  });
});

describe('schedules', () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();

  it('closes Starfall on Thursdays at 10:00 UTC (20:00 Brisbane)', () => {
    // Monday 26 Oct 2026.
    expect(iso(STARFALL_WEEKLY(at('2026-10-26T00:00:00Z'), 3_600))).toBe('2026-10-29T10:00:00.000Z');
    // Too close to Thursday's close for the minimum sales period: next week.
    expect(iso(STARFALL_WEEKLY(at('2026-10-29T09:00:00Z'), 3_600))).toBe('2026-11-05T10:00:00.000Z');
    expect(iso(weekly({ weekday: 0, hour: 23, minute: 30 })(at('2026-10-26T00:00:00Z'), 60))).toBe('2026-11-01T23:30:00.000Z');
  });

  it('closes on period boundaries for test networks', () => {
    expect(iso(every(1_800)(at('2026-10-26T00:00:00Z'), 600))).toBe('2026-10-26T00:30:00.000Z');
    expect(iso(every(1_800)(at('2026-10-26T00:20:00Z'), 600))).toBe('2026-10-26T01:00:00.000Z');
  });
});

describe('seed stores', () => {
  it('keep each seed, private and checked against its commitment', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lunardraw-seeds-')), 'keeper', 'seeds.json');
    const store = new FileSeedStore(path);
    const a = await store.create();
    const b = await store.create();
    expect(hex(a.seed)).not.toBe(hex(b.seed));
    expect(hex(a.commitment)).toBe(hex(commitmentOf(a.seed)));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // A fresh instance (a restart) reads the same seeds back.
    const again = new FileSeedStore(path);
    expect(hex((await again.find(a.commitment))!)).toBe(hex(a.seed));
    expect(await again.find(new Uint8Array(32))).toBeUndefined();
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).seeds)).toHaveLength(2);
  });
});
