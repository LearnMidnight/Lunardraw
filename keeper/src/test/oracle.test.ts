import { describe, it, expect } from 'vitest';
import { DrawStatus, LottoSimulator } from '@lunardraw/contract';
import { generateOperatorSecret, generateOracleSecretKey, oraclePublicKey, pureCircuits as nightcast } from '@nightcast/contract';
import { type ChainView, type DrawOracleChain, SimulatorChain } from '../chain.js';
import { Keeper } from '../keeper.js';
import { DrawOracle } from '../oracle.js';
import { every } from '../schedule.js';
import { MemorySeedStore } from '../seeds.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

const setup = () => {
  const oracleSecretKey = generateOracleSecretKey();
  const sim = new LottoSimulator({
    oracleSecretKey,
    organiserSecret: generateOperatorSecret(),
    minSales: 600n,
    maxSales: 30n * 86_400n,
    revealWindow: 3_600n,
    drawWindow: 3_600n,
    claimWindow: 3_600n,
  });
  const chain = new SimulatorChain(sim);
  const seeds = new MemorySeedStore();
  const clock = () => sim.now * 1000;
  const keeper = new Keeper({ chain, seeds, schedule: every(7_200), clock });
  const oracle = new DrawOracle({ chain, publicKey: oraclePublicKey(oracleSecretKey), clock });
  return { sim, chain, seeds, keeper, oracle, oracleSecretKey, clock };
};

/** Open draw 1 and reveal it, so it waits for the oracle. */
const requested = async (ctx: ReturnType<typeof setup>) => {
  await ctx.keeper.tick();
  const close = Number(ctx.sim.getLedger().draws.lookup(1n).salesClose);
  ctx.sim.advance(close + 31 - ctx.sim.now);
  await ctx.keeper.tick();
  expect(ctx.sim.getLedger().draws.lookup(1n).status).toBe(DrawStatus.requested);
};

describe('the draw oracle', () => {
  it("answers a revealed draw with Nightcast's VRF, after letting the node catch up", async () => {
    const ctx = setup();
    const { sim, oracle, oracleSecretKey } = ctx;
    await requested(ctx);
    expect((await oracle.tick()).skipped).toEqual([{ draw: 1n, reason: 'new; letting the node catch up' }]);
    sim.advance(21);
    expect((await oracle.tick()).fulfilled).toEqual([1n]);
    const d = sim.getLedger().draws.lookup(1n);
    expect(d.status).toBe(DrawStatus.fulfilled);
    // The seed is public once revealed (the keeper drops its own copy).
    expect(hex(d.output)).toBe(hex(nightcast.evaluate(oracleSecretKey, sim.alphaOf(1n, d.seed))));
  });

  it('ignores draws bound to another key, and draws too close to their deadline', async () => {
    const ctx = setup();
    const { sim, chain, clock } = ctx;
    await requested(ctx);
    const stranger = new DrawOracle({ chain, publicKey: oraclePublicKey(generateOracleSecretKey()), clock, newRequestDelayMs: 0 });
    expect(await stranger.tick()).toEqual({ fulfilled: [], failed: [], skipped: [] });

    const late = new DrawOracle({ chain, publicKey: oraclePublicKey(ctx.oracleSecretKey), clock, newRequestDelayMs: 0 });
    sim.advance(Number(sim.getLedger().draws.lookup(1n).drawDeadline) - 100 - sim.now);
    expect((await late.tick()).fulfilled).toEqual([]);
    expect(sim.getLedger().draws.lookup(1n).status).toBe(DrawStatus.requested);
  });

  it("doesn't answer the same draw twice while the indexer catches up", async () => {
    const ctx = setup();
    const { chain, clock, oracleSecretKey } = ctx;
    await requested(ctx);
    const stale: ChainView = await chain.view();
    let answers = 0;
    const lagging: DrawOracleChain = {
      view: async () => stale,
      now: () => chain.now(),
      fulfilDraw: async (n) => {
        answers += 1;
        await chain.fulfilDraw(n);
      },
    };
    const oracle = new DrawOracle({ chain: lagging, publicKey: oraclePublicKey(oracleSecretKey), clock, newRequestDelayMs: 0 });
    expect((await oracle.tick()).fulfilled).toEqual([1n]);
    expect((await oracle.tick()).skipped).toEqual([{ draw: 1n, reason: 'answered; waiting for the indexer' }]);
    expect(answers).toBe(1);
  });

  it('runs draws with the keeper, nobody else involved', async () => {
    const { sim, keeper, oracle } = setup();
    // Six hours, both looking every five minutes.
    for (let minute = 0; minute < 6 * 60; minute += 5) {
      sim.advance(300);
      await keeper.tick();
      await oracle.tick();
    }
    const draws = Array.from(sim.getLedger().draws)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, d]) => d.status);
    expect(draws.length).toBeGreaterThanOrEqual(3);
    expect(draws).not.toContain(DrawStatus.voided);
    expect(draws[0]).toBe(DrawStatus.settled);
  });
});
