import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Starfall } from '@lunardraw/contract';
import type { StarfallDrawView, StarfallView } from '@lunardraw/keeper';
import {
  composeEntries,
  describeResult,
  drawsPlayed,
  emptyAgentState,
  loadAgentState,
  planPurchase,
  saveAgentState,
  settledResults,
  slotOffsetFor,
  voidedDraws,
} from '../starfall-agent.js';

const { DrawStatus } = Starfall;

const draw = (id: number, status: number, salesClose: number, extra: Partial<StarfallDrawView> = {}): StarfallDrawView =>
  ({
    id: BigInt(id),
    status,
    salesClose: BigInt(salesClose),
    revealDeadline: BigInt(salesClose + 600),
    drawDeadline: BigInt(salesClose + 1500),
    settleDeadline: BigInt(salesClose + 5100),
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
    unrefunded: [],
    refundedGames: 0n,
    ...extra,
  }) as StarfallDrawView;

const view = (draws: StarfallDrawView[]): StarfallView =>
  ({ lastDraw: BigInt(draws.length), ticketPrice: 1_200_000n, feePerGame: 200_000n, settleWindow: 3600n, draws, entitlements: [] }) as unknown as StarfallView;

describe('the Starfall agent', () => {
  it('composes entries in each style', () => {
    expect(composeEntries({ name: 'a', style: 'quickpick', games: 3 })).toHaveLength(3);
    expect(composeEntries({ name: 'a', style: 'quickpick', games: 40 })).toHaveLength(18); // a purchase's worth at most
    const lucky = composeEntries({ name: 'a', style: 'lucky', numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 9 });
    expect(lucky).toEqual([{ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 9 }]);
    expect(() => composeEntries({ name: 'a', style: 'lucky' })).toThrow(/7 numbers/);
    const moonhit = composeEntries({ name: 'a', style: 'moonhit' });
    expect(moonhit[0].sweep).toBe(true);
    expect(Starfall.gamesOf(moonhit[0])).toBe(20);
    expect(Starfall.gamesOf(composeEntries({ name: 'a', style: 'system' })[0])).toBe(8);
    // mix: the roll picks the arm; every arm is a valid entry
    for (let roll = 0; roll < 10; roll++) {
      const es = composeEntries({ name: 'a', style: 'mix' }, (n) => (n === 10 ? roll : 0));
      es.forEach((e) => Starfall.checkEntry(e));
    }
    expect(composeEntries({ name: 'a', style: 'mix' }, (n) => (n === 10 ? 9 : 0))[0].pick).toBe(true);
  });

  it('buys once per draw on sale, not when sales close soon, over budget or past its limit', () => {
    const state = emptyAgentState();
    const o = { name: 'a', style: 'quickpick' as const, games: 2 };
    const entries = composeEntries(o);
    const v = view([draw(1, DrawStatus.open, 10_000)]);
    const plan = planPurchase(v, 5_000, state, o, entries);
    expect(plan && !('skipped' in plan) ? { draw: plan.draw, games: plan.games, cost: plan.cost } : plan).toEqual({ draw: 1n, games: 2, cost: 2_400_000n });
    expect(planPurchase(v, 9_900, state, o, entries)).toBeNull(); // 100 s to close: inside the 180 s margin
    state.purchases.push({ draw: '1', at: 'now', entries, games: 2, cost: '2400000', txs: 1 });
    expect(planPurchase(v, 5_000, state, o, entries)).toBeNull(); // already in
    const v2 = view([draw(2, DrawStatus.open, 20_000), draw(1, DrawStatus.drawn, 10_000)]);
    expect(planPurchase(v2, 11_000, state, { ...o, maxDraws: 1 }, entries)).toEqual({ skipped: 'played 1 draw(s), the limit' });
    expect(planPurchase(v2, 11_000, state, { ...o, budget: 1_000_000n }, entries)).toMatchObject({ skipped: expect.stringMatching(/over the budget/) });
    const p2 = planPurchase(v2, 11_000, state, o, entries);
    expect(p2 && !('skipped' in p2) ? p2.draw : p2).toBe(2n);
    expect(planPurchase(view([draw(1, DrawStatus.requested, 10_000)]), 11_000, emptyAgentState(), o, entries)).toBeNull(); // nothing on sale
  });

  it('with buyOffsetSecs, each slot starts that far into the hour, so agents buy at different minutes', () => {
    const hour = 3600;
    const o = { name: 'a', style: 'quickpick' as const, games: 1, buyEverySecs: hour, buyOffsetSecs: 30 * 60, budget: 100_000_000n };
    const entries = composeEntries(o);
    const top = 1_800_000_000 - (1_800_000_000 % hour); // a top of the hour
    const v = view([draw(1, DrawStatus.open, top + 24 * hour)]);
    const state = emptyAgentState();
    state.purchases.push({ draw: '1', at: new Date((top + 35 * 60) * 1000).toISOString(), entries, games: 1, cost: '1300000', txs: 1 });
    const planned = (now: number) => {
      const p = planPurchase(v, now, state, o, entries);
      return p && !('skipped' in p) ? p.draw : p;
    };
    expect(planned(top + hour + 5)).toBeNull(); // the top of the next hour: still the :30 slot it bought in
    expect(planned(top + hour + 29 * 60)).toBeNull();
    expect(planned(top + hour + 30 * 60)).toBe(1n); // :30, its next slot
    // the default minute comes from the name: the same every time, within the hour, whole minutes
    for (const n of ['nova', 'pixel', 'orbit', 'x']) {
      const s = slotOffsetFor(n, hour);
      expect(s).toBe(slotOffsetFor(n, hour));
      expect(s % 60).toBe(0);
      expect(s >= 0 && s < hour).toBe(true);
    }
    expect(new Set(['nova', 'pixel', 'orbit'].map((n) => slotOffsetFor(n, hour))).size).toBe(3);
  });

  it('with buyEverySecs, buys again in each later slot of a draw while it sells, within its budget for the draw', () => {
    const hour = 3600;
    const o = { name: 'a', style: 'quickpick' as const, games: 2, buyEverySecs: hour, budget: 6_000_000n };
    const entries = composeEntries(o);
    const t0 = 1_800_000_000; // a moment within a clock hour
    const v = view([draw(1, DrawStatus.open, t0 + 24 * hour)]);
    const state = emptyAgentState();
    const at = (secs: number) => new Date(secs * 1000).toISOString();
    const planned = (now: number) => {
      const p = planPurchase(v, now, state, o, entries);
      return p && !('skipped' in p) ? p.draw : p;
    };
    expect(planned(t0)).toBe(1n);
    state.purchases.push({ draw: '1', at: at(t0), entries, games: 2, cost: '2400000', txs: 1 });
    expect(planned(t0 + 60)).toBeNull(); // the same hour: done
    const nextHour = (Math.floor(t0 / hour) + 1) * hour;
    expect(planned(nextHour - 1)).toBeNull();
    expect(planned(nextHour + 5)).toBe(1n); // the next clock hour
    state.purchases.push({ draw: '1', at: at(nextHour + 5), entries, games: 2, cost: '2400000', txs: 1 });
    // 4.8 spent of a 6 tNIGHT budget for the draw: 2.4 more would pass it
    expect(planPurchase(v, nextHour + 2 * hour, state, o, entries)).toMatchObject({ skipped: expect.stringMatching(/take draw 1 to 7\.2, over the budget of 6 a draw/) });
    // without buyEverySecs: once a draw, as before
    expect(planPurchase(v, nextHour + 2 * hour, state, { ...o, buyEverySecs: undefined }, entries)).toBeNull();
    // the limit of draws counts draws, not purchases
    expect(drawsPlayed(state)).toBe(1);
    const v2 = view([draw(2, DrawStatus.open, t0 + 48 * hour), draw(1, DrawStatus.drawn, t0 + 24 * hour)]);
    expect(planPurchase(v2, t0 + 25 * hour, state, { ...o, maxDraws: 2 }, entries)).toMatchObject({ draw: 2n });
    expect(planPurchase(v2, t0 + 25 * hour, state, { ...o, maxDraws: 1 }, entries)).toEqual({ skipped: 'played 1 draw(s), the limit' });
  });

  it('reports a draw bought into several times once, with all its games', () => {
    const state = emptyAgentState();
    const a = { numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 9 };
    const b = { numbers: [1, 2, 3, 30, 31, 32, 33], moonball: 9 };
    state.purchases.push({ draw: '1', at: 'a', entries: [a], games: 1, cost: '1300000', txs: 1 });
    state.purchases.push({ draw: '1', at: 'b', entries: [b], games: 1, cost: '1300000', txs: 1 });
    const v = view([draw(1, DrawStatus.drawn, 10_000, { numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 9 })]);
    const results = settledResults(v, state);
    expect(results).toHaveLength(1);
    expect(results[0].games).toBe(2);
    expect(results[0].won).toEqual([
      { division: 1, games: 1 },
      { division: 8, games: 1 },
    ]);
    expect(voidedDraws(view([draw(1, DrawStatus.voided, 10_000)]), state)).toEqual([1n]);
  });

  it('reports each played draw once its numbers are out, with what it won, and cancelled draws', () => {
    const state = emptyAgentState();
    state.purchases.push({
      draw: '1',
      at: 'now',
      entries: [
        { numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 9 }, // the jackpot
        { numbers: [1, 2, 3, 30, 31, 32, 33], moonball: 9 }, // 3 + Moonball: division 8
        { numbers: [20, 21, 22, 23, 24, 25, 26], moonball: 1 },
      ],
      games: 3,
      cost: '3600000',
      txs: 1,
    });
    state.purchases.push({ draw: '2', at: 'now', entries: [{ numbers: [8, 9, 10, 11, 12, 13, 14], moonball: 2 }], games: 1, cost: '1200000', txs: 1 });
    const v = view([
      draw(2, DrawStatus.voided, 20_000),
      draw(1, DrawStatus.settled, 10_000, { numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 9 }),
    ]);
    const results = settledResults(v, state);
    expect(results).toHaveLength(1);
    expect(results[0].won).toEqual([
      { division: 1, games: 1 },
      { division: 8, games: 1 },
    ]);
    expect(describeResult(results[0])).toBe('Division 1 on 1 game, Division 8 on 1 game (3 games)');
    expect(describeResult({ ...results[0], won: [] })).toBe('no prize this time (3 games)');
    expect(voidedDraws(v, state)).toEqual([2n]);
    state.reported.push('1', '2');
    expect(settledResults(v, state)).toEqual([]);
    expect(voidedDraws(v, state)).toEqual([]);
    // a draw still selling or being drawn isn't reported yet
    expect(settledResults(view([draw(1, DrawStatus.fulfilled, 10_000)]), { ...emptyAgentState(), purchases: state.purchases })).toEqual([]);
  });

  it('keeps its state across restarts', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agent-')), 'a.state.json');
    expect(loadAgentState(path)).toEqual(emptyAgentState());
    const state = emptyAgentState();
    state.purchases.push({ draw: '7', at: 'now', entries: [{ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 1 }], games: 1, cost: '1200000', txs: 1 });
    state.reported.push('6');
    saveAgentState(path, state);
    expect(loadAgentState(path)).toEqual(state);
  });
});
