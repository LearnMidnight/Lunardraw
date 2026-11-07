import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentAnalytics, agentHistory, agentStats, agentWins, type DrawOutcome, periodStart, prizeChance, signedListing, walletSigner } from '../listing.js';
import { createRegistry, ledgerVerifier } from '../registry.js';
import type { AgentState } from '../starfall-agent.js';

const SEED_A = '11'.repeat(32);
const SEED_B = '22'.repeat(32);

const state: AgentState = {
  purchases: [
    // draw 10: one game, 5 numbers + Moonball (division 5)
    { draw: '10', at: '2026-11-01T01:05:00.000Z', entries: [{ numbers: [1, 2, 3, 4, 5, 30, 31], moonball: 7 }], games: 1, cost: '1200000', txs: 1 },
    // draw 11: two games, nothing
    { draw: '11', at: '2026-11-01T02:05:00.000Z', entries: [{ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 1 }, { numbers: [8, 9, 10, 11, 12, 13, 14], moonball: 2 }], games: 2, cost: '2400000', txs: 1 },
    // draw 12: void (refunded): not counted
    { draw: '12', at: '2026-11-01T03:05:00.000Z', entries: [{ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 1 }], games: 1, cost: '1200000', txs: 1 },
  ],
  reported: [],
};
const prizes = [0, 0, 0, 0, 50_000_000, 0, 0, 0, 0];
const draws: DrawOutcome[] = [
  { num: 10, status: 'settled', numbers: [1, 2, 3, 4, 5, 20, 21], moonball: 7, prizes_star: prizes },
  { num: 11, status: 'settled', numbers: [20, 21, 22, 23, 24, 25, 26], moonball: 9, prizes_star: prizes },
  { num: 12, status: 'void' },
];

describe('an agent\'s totals', () => {
  it('counts draws, games, spending and prizes from its own record; void draws are refunds', () => {
    expect(agentStats(state, draws)).toEqual({
      draws: 2,
      games: 3,
      spent_star: 3_600_000,
      winning_games: 1,
      won_star: 50_000_000,
      last_draw: 11,
      first_played: '2026-11-01T01:05:00.000Z',
      last_played: '2026-11-01T02:05:00.000Z',
    });
    // a drawn draw whose prizes aren't fixed yet: the win counts, the amount waits
    const drawn = draws.map((d) => (d.num === 10 ? { ...d, status: 'drawn', prizes_star: undefined } : d));
    expect(agentStats(state, drawn)).toMatchObject({ winning_games: 1, won_star: 0 });
    // from a date on (the leaderboard's week and month)
    expect(agentStats(state, draws, '2026-11-01T02:00:00.000Z')).toMatchObject({ draws: 1, games: 2, won_star: 0 });
    expect(agentWins(state, draws)).toEqual([{ draw: 10, division: 5, games: 1, won_star: 50_000_000 }]);
  });

  it('works out its draws, its luck against the odds, its return and its dry spell', () => {
    // a Starfall game wins something about 1 time in 44
    expect(prizeChance()).toBeCloseTo(0.022737, 5);
    const history = agentHistory(state, draws);
    expect(history).toEqual([
      { draw: 10, games: 1, spent_star: 1_200_000, winning_games: 1, won_star: 50_000_000, at: '2026-11-01T01:05:00.000Z' },
      { draw: 11, games: 2, spent_star: 2_400_000, winning_games: 0, won_star: 0, at: '2026-11-01T02:05:00.000Z' },
    ]);
    const a = agentAnalytics(history, agentWins(state, draws));
    expect(a.expected_winning_games).toBe(0.07); // 3 games
    expect(a.luck).toBe(14.66); // 1 win where 0.07 were expected
    expect(a.return_ratio).toBe(13.889); // 50 tNIGHT back for 3.6
    expect(a.dry_spell).toBe(1); // draw 11 won nothing
    expect(a.best_win).toEqual({ draw: 10, division: 5, games: 1, won_star: 50_000_000 });
    // nothing settled yet: no luck or return to show
    expect(agentAnalytics([{ draw: 12, games: 4, spent_star: 4_800_000, winning_games: 0, won_star: 0, pending: true }], [])).toEqual({ expected_winning_games: 0, dry_spell: 0 });
  });

  it('counts weeks from Monday and months from the 1st, Brisbane time', () => {
    const wed = Date.parse('2026-11-04T02:00:00.000Z'); // Wednesday 4 Nov, 12:00 in Brisbane
    expect(periodStart('week', wed)).toBe('2026-11-01T14:00:00.000Z'); // Monday 2 Nov, 00:00
    expect(periodStart('month', wed)).toBe('2026-10-31T14:00:00.000Z'); // 1 Nov, 00:00
    expect(periodStart('week', Date.parse('2026-11-01T14:30:00.000Z'))).toBe('2026-11-01T14:00:00.000Z'); // Monday 00:30
    expect(periodStart('week', Date.parse('2026-11-01T13:30:00.000Z'))).toBe('2026-10-25T14:00:00.000Z'); // Sunday 23:30
  });
});

describe('the agent registry', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const house = join(dir, 'agents');
    mkdirSync(house);
    writeFileSync(join(house, 'nova.env'), 'AGENT_ARGS=--style mix --budget 30\n');
    writeFileSync(join(house, 'nova.state.json'), JSON.stringify(state));
    const feed = join(dir, 'feed.json');
    writeFileSync(feed, JSON.stringify({ games: { starfall: { draws } } }));
    return { dir, house, feed };
  };

  it("lists Lunardraw's own agents from their records, and a signed listing from anyone; refuses forgeries, stale reports and taken names", async () => {
    const { dir, house, feed } = setup();
    let t = Date.parse('2026-11-04T02:00:00.000Z');
    const verifier = await ledgerVerifier('preprod');
    const reg = createRegistry({ network: 'preprod', dir: join(dir, 'store'), feedPath: feed, houseDir: house, verifier, isActive: async (u) => u === 'lunardraw-agent@nova', now: () => t });

    let d = await reg.directory();
    expect(d.agents).toHaveLength(1);
    expect(d.agents[0]).toMatchObject({ id: 'nova', name: 'NOVA', via: 'lunardraw', house: true, status: 'online', style: 'A bit of everything' });
    expect(d.agents[0]!.stats).toMatchObject({ draws: 2, games: 3, won_star: 50_000_000 });
    expect(d.events[0]).toMatchObject({ agent: 'NOVA', text: 'bought 1 game in draw 12' });
    expect(d.wins).toEqual([{ agent: 'NOVA', draw: 10, division: 5, games: 1, won_star: 50_000_000 }]);
    expect(d.agents[0]!.analytics).toMatchObject({ luck: 14.66, dry_spell: 1 });
    expect(d.agents[0]!.history.map((h) => h.draw)).toEqual([10, 11]);
    expect(d.agents[0]!.favourites).toEqual({ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 1 });

    // a friend's agent lists itself, signed by its wallet
    const a = await walletSigner(SEED_A, 'preprod');
    expect(a.address).toMatch(/^mn_addr_preprod1/);
    const stats = { draws: 1, games: 2, spent_star: 2_400_000, winning_games: 0, won_star: 0, last_draw: 12 };
    const listing = { network: 'preprod', action: 'list' as const, name: 'NightOwl', style: 'Plays every night', via: 'openclaw' as const, stats };
    expect(await reg.report(signedListing(a, listing, new Date(t)))).toBe('listed');
    d = await reg.directory();
    expect(d.agents.map((x) => x.name)).toEqual(['NOVA', 'NightOwl']);
    expect(d.agents[1]).toMatchObject({ via: 'openclaw', house: false, status: 'online', address: a.address, style: 'Plays every night' });
    expect(d.agents[1]!.favourites).toBeUndefined(); // never a player's numbers
    expect(d.events[0]).toMatchObject({ agent: 'NightOwl', text: 'joined the directory' });

    // someone else can't sign for that wallet, or take its name, or a house agent's
    const b = await walletSigner(SEED_B, 'preprod');
    const forged = signedListing({ ...b, key: a.key }, { ...listing, name: 'Mallory' }, new Date(t));
    await expect(reg.report(forged)).rejects.toThrow("the signature doesn't match");
    await expect(reg.report(signedListing(b, { ...listing, name: 'nightowl' }, new Date(t)))).rejects.toThrow('is taken');
    t += 31_000;
    await expect(reg.report(signedListing(b, { ...listing, name: 'Nova' }, new Date(t)))).rejects.toThrow('is taken');
    // a payload changed after signing
    const signed = signedListing(a, listing, new Date(t));
    await expect(reg.report({ ...signed, payload: signed.payload.replace('NightOwl', 'NightOwl2') })).rejects.toThrow("the signature doesn't match");
    // an old report (replayed)
    await expect(reg.report(signedListing(a, listing, new Date(t - 11 * 60_000)))).rejects.toThrow('more than 10 minutes');

    // an update: new games become an event; too soon after the last is refused
    t += 31_000;
    expect(await reg.report(signedListing(a, { ...listing, stats: { ...stats, games: 5, last_draw: 13 } }, new Date(t)))).toBe('updated');
    await expect(reg.report(signedListing(a, listing, new Date(t)))).rejects.toThrow('one every 30 seconds');
    d = await reg.directory();
    expect(d.events[0]).toMatchObject({ agent: 'NightOwl', text: 'bought 3 games in draw 13' });

    // two days quiet: offline; then the owner unlists it
    t += 49 * 3_600_000;
    expect((await reg.directory()).agents.find((x) => x.name === 'NightOwl')!.status).toBe('offline');
    expect(await reg.report(signedListing(a, { ...listing, action: 'unlist' }, new Date(t)))).toBe('unlisted');
    expect((await reg.directory()).agents.map((x) => x.name)).toEqual(['NOVA']);

    // running but not buying: NOVA last played draw 11; with draw 15 on sale it has missed 12-14
    writeFileSync(feed, JSON.stringify({ games: { starfall: { open: { num: 14 }, draws } } }));
    expect((await reg.directory()).agents[0]!.status).toBe('online');
    writeFileSync(feed, JSON.stringify({ games: { starfall: { open: { num: 15 }, draws } } }));
    expect((await reg.directory()).agents[0]!.status).toBe('idle');
  });
  it('starts a new season when the feed shows a new deployment: listings stay, numbers and events clear, and only reports for it count', async () => {
    const { dir, house, feed } = setup();
    const OLD = 'aa'.repeat(32);
    const NEW = 'bb'.repeat(32);
    writeFileSync(feed, JSON.stringify({ contracts: { starfall: OLD }, games: { starfall: { draws } } }));
    writeFileSync(join(house, 'nova.state.json'), JSON.stringify({ ...state, contract: OLD }));
    let t = Date.parse('2026-11-04T02:00:00.000Z');
    const verifier = await ledgerVerifier('preprod');
    const store = join(dir, 'store');
    const reg = createRegistry({ network: 'preprod', dir: store, feedPath: feed, houseDir: house, verifier, isActive: async () => true, now: () => t });
    const a = await walletSigner(SEED_A, 'preprod');
    const stats = { draws: 1, games: 2, spent_star: 2_400_000, winning_games: 0, won_star: 0, last_draw: 211 };
    const listing = { network: 'preprod', action: 'list' as const, name: 'OmegaCandle', style: 'QuickPicks', via: 'claude' as const, stats, contract: OLD };
    expect(await reg.report(signedListing(a, listing, new Date(t)))).toBe('listed');
    let d = await reg.directory();
    expect(d.agents.find((x) => x.name === 'OmegaCandle')!.stats.games).toBe(2);
    expect(d.agents.find((x) => x.name === 'NOVA')!.stats.games).toBe(3);

    // the switch: the feed shows the new deployment
    writeFileSync(feed, JSON.stringify({ contracts: { starfall: NEW }, games: { starfall: { draws: [] } } }));
    d = await reg.directory();
    expect(d.agents.find((x) => x.name === 'OmegaCandle')!.stats.games).toBe(0); // still listed, at zero
    expect(d.agents.find((x) => x.name === 'NOVA')!.stats.games).toBe(0); // its state is the old deployment's
    expect(d.events).toEqual([]);
    expect(existsSync(join(store, `listings.${OLD.slice(0, 16)}.json`))).toBe(true);
    // an old kit (no contract) or one still on the old deployment: seen, but its numbers don't count
    t += 31_000;
    expect(await reg.report(signedListing(a, { ...listing, contract: undefined, stats: { ...stats, games: 9 } }, new Date(t)))).toBe('updated');
    t += 31_000;
    expect(await reg.report(signedListing(a, { ...listing, stats: { ...stats, games: 9 } }, new Date(t)))).toBe('updated');
    d = await reg.directory();
    expect(d.agents.find((x) => x.name === 'OmegaCandle')!.stats.games).toBe(0);
    expect(d.events).toEqual([]);
    // a kit on the new deployment: counted
    t += 31_000;
    expect(await reg.report(signedListing(a, { ...listing, contract: NEW, stats: { ...stats, games: 1, last_draw: 1 } }, new Date(t)))).toBe('updated');
    d = await reg.directory();
    expect(d.agents.find((x) => x.name === 'OmegaCandle')!.stats.games).toBe(1);
    expect(d.events[0]).toMatchObject({ agent: 'OmegaCandle', text: 'bought 1 game in draw 1' });
  });
});
