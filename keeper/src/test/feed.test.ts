import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DrawStatus, LottoSimulator, makeTicket, type PlainLine } from '@lunardraw/contract';
import { generateOperatorSecret, generateOracleSecretKey, pureCircuits as nightcast } from '@nightcast/contract';
import { combineDrawSeed, drawStarfall, seedCommitment } from '@nightcast/sdk';
import { SimulatorChain } from '../chain.js';
import { buildFeed, type Feed, feedStatus, V0_SHARES_BP, writeFeed } from '../feed.js';
import { Keeper } from '../keeper.js';
import { every } from '../schedule.js';
import { MemorySeedStore } from '../seeds.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const PLAYER = new Uint8Array(32).fill(7);
const SALES = 7_200;

const lineHitting = (numbers: number[], moonball: number, match: number): PlainLine => {
  const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !numbers.includes(x));
  return { numbers: [...numbers.slice(0, match), ...misses.slice(0, 7 - match)], moonball };
};

describe('the site feed', () => {
  it('describes the draw on sale and every past draw from the contract state', async () => {
    const oracleSecretKey = generateOracleSecretKey();
    const sim = new LottoSimulator({ oracleSecretKey, organiserSecret: generateOperatorSecret(), minSales: 600n, claimWindow: 3_600n });
    const chain = new SimulatorChain(sim);
    const seeds = new MemorySeedStore();
    const feeds: Feed[] = [];
    const keeper = new Keeper({
      chain,
      seeds,
      schedule: every(SALES),
      clock: () => sim.now * 1000,
      onView: (view, now) => feeds.push(buildFeed(view, { network: 'local', contract: sim.address, nowSecs: now, generatedAt: new Date(0) })),
    });

    // Nothing yet: an empty feed with the game's parameters.
    await keeper.tick();
    const empty = feeds[0];
    expect(empty.schema).toBe('lunardraw-feed/1');
    expect(empty.games.starfall).toMatchObject({ contract: 'lunardraw-v0', price_star: 1_000_000, fee_star: 0, allocation_bp: [...V0_SHARES_BP], carry_star: 0 });
    expect(empty.games.starfall.draws).toEqual([]);

    // Draw 1 opened by that first pass; a player buys a division-8 line.
    let d1 = sim.getLedger().draws.lookup(1n);
    const seed = (await seeds.find(d1.seedCommitment))!;
    const { numbers, moonball } = drawStarfall(combineDrawSeed(hex(seed), nightcast.evaluate(oracleSecretKey, sim.alphaOf(1n, seed))));
    const ticket = makeTicket(1n, [lineHitting(numbers, moonball, 3)]);
    sim.buyTicket(ticket);
    await keeper.tick();
    const selling = feeds.at(-1)!.games.starfall.open!;
    expect(selling).toEqual({ num: 1, sales_close: new Date(Number(d1.salesClose) * 1000).toISOString(), seed_commitment: hex(d1.seedCommitment), games_sold: 1 });
    expect(hex(d1.seedCommitment)).toBe(seedCommitment(hex(seed)));

    // Sales close: "closed" until the keeper reveals; then requested, drawn, settled.
    sim.advance(Number(d1.salesClose) - sim.now + 1);
    expect(feedStatus((await chain.view()).draws[0], sim.now)).toBe('closed');
    sim.advance(30);
    await keeper.tick(); // reveal 1, open 2
    let past = feeds.at(-1)!.games.starfall.draws;
    expect(past.map((d) => [d.num, d.status])).toEqual([[1, 'requested']]);
    expect(past[0].seed).toBe(hex(seed));
    expect(past[0].vrf_output).toBeUndefined();
    expect(feeds.at(-1)!.games.starfall.open?.num).toBe(2);

    sim.fulfilDraw(1n);
    await keeper.tick(); // compute 1
    d1 = sim.getLedger().draws.lookup(1n);
    expect(d1.status).toBe(DrawStatus.drawn);
    past = feeds.at(-1)!.games.starfall.draws;
    expect(past[0]).toMatchObject({ status: 'drawn', numbers, moonball, vrf_output: hex(d1.output), winners: [0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(past[0].drawn_at).toBe(new Date((Number(d1.claimDeadline) - 3_600) * 1000).toISOString());

    sim.registerWin(ticket, 0n, PLAYER);
    sim.advance(3_600 + 31);
    await keeper.tick(); // settle 1, pay
    past = feeds.at(-1)!.games.starfall.draws;
    expect(past[0].status).toBe('settled');
    expect(past[0].winners).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0]);
    expect(past[0].carried_in_star).toBe(0);
    // One line sold: the pool is 1 tNIGHT; division 8 gets 14% of it, the rest rolls over.
    expect(past[0].prizes_star![7]).toBe(140_000);
    expect(past[0].carry_out_star).toBe(860_000);
    expect(feeds.at(-1)!.games.starfall.carry_star).toBe(860_000);
  });

  it('marks a void draw and writes the file atomically', async () => {
    const sim = new LottoSimulator({ oracleSecretKey: generateOracleSecretKey(), organiserSecret: generateOperatorSecret(), minSales: 600n });
    const chain = new SimulatorChain(sim);
    const keeper = new Keeper({ chain, seeds: new MemorySeedStore(), schedule: every(SALES), clock: () => sim.now * 1000 });
    await keeper.tick();
    const d1 = sim.getLedger().draws.lookup(1n);
    sim.advance(Number(d1.revealDeadline) - sim.now + 1);
    sim.voidDraw(1n);
    const feed = buildFeed(await chain.view(), { network: 'local', contract: sim.address, nowSecs: sim.now });
    expect(feed.games.starfall.open).toBeUndefined();
    expect(feed.games.starfall.draws[0]).toMatchObject({ num: 1, status: 'void', games_sold: 0 });

    const dir = mkdtempSync(join(tmpdir(), 'lunardraw-feed-'));
    const path = join(dir, 'public', 'feed.json');
    writeFeed(path, feed);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(feed)));
  });
});
