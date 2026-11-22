/**
 * The agent kit on Starfall v2, without a chain: the packed game (cli/game-v2/preprod), choices in a
 * draw's format, tickets built and checked by the deployed contract's own circuits, the limits, and
 * the reports.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StarfallView } from '@lunardraw/keeper';
import { describeSavedTicket, packV2, savedTicketOf, savedTicketWins, saveV2AgentState, ticketGames, type V2Format } from '../starfall-v2-agent.js';
import {
  divisionName,
  formatText,
  gamesForChoice,
  hasKitV2,
  kitV2Dir,
  kitV2StatePath,
  loadKitV2State,
  openSyndicatesOf,
  overLimits,
  overviewV2Of,
  readKitV2Record,
  ticketsReportV2,
  v2ChoiceOf,
  v2SpentOnDraw,
  gameOf,
  v2SpentSince,
} from '../kit/player-v2.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let G: any;
const dir = kitV2Dir('preprod', {});
beforeAll(async () => {
  G = await import(pathToFileURL(join(dir, 'settlement', 'contract', 'index.js')).href);
});

const f20: V2Format = { range: 20, moonballs: 1, pick5: 105n };
const f35: V2Format = { range: 35, moonballs: 20, pick5: 435n };
const me = new Uint8Array(32).fill(7);

describe('the packed Starfall v2 game', () => {
  it('is in cli/game-v2/preprod, with the deployed addresses and verifier keys the record names', () => {
    expect(hasKitV2('preprod', {})).toBe(true);
    expect(hasKitV2('preview', {})).toBe(false);
    const r = readKitV2Record('preprod', {}) as ReturnType<typeof readKitV2Record> & { verifiers: Record<string, Record<string, string>> };
    expect(r.contractAddress).toBe('9e390a2308e82fcf1945540047a3cb3b022a4739d1859513d0c640cc5a89c264');
    expect(r.treasuryAddress).toBe('02b53954e20328440b4ed0fedf656b49bc136ad1612ae97e2ff163e187437f6d');
    for (const part of ['settlement', 'treasury']) {
      const keys = join(dir, part, 'keys');
      const files = readdirSync(keys).filter((f) => f.endsWith('.verifier'));
      expect(files.length).toBe(Object.keys(r.verifiers[part]!).length);
      for (const f of files) expect(createHash('sha256').update(readFileSync(join(keys, f))).digest('hex')).toBe(r.verifiers[part]![f.replace(/\.verifier$/, '')]);
      expect(files.some((f) => f.endsWith('.prover')) || readdirSync(keys).some((f) => f.endsWith('.prover'))).toBe(false);
      expect(existsSync(join(dir, part, 'contract', 'index.js'))).toBe(true);
    }
    // the generated code names the same keys (a build with keys lists their hashes)
    expect(G.expectedVk).toEqual(r.verifiers.settlement);
    for (const c of ['buyTickets', 'joinSyndicate']) expect(existsSync(join(dir, 'settlement', 'keys', `${c}.verifier`))).toBe(true);
    expect(kitV2Dir('preprod', { LUNARDRAW_KIT_V2_DIR: '/somewhere/else' })).toBe('/somewhere/else');
  });
});

describe('choosing games in a draw\'s format', () => {
  it('QuickPicks in a draw with no Moonball: numbers from its range, Moonball 1', () => {
    const games = gamesForChoice({ games: 13 }, f20);
    expect(games).toHaveLength(13);
    for (const g of games) {
      expect(g.numbers).toHaveLength(7);
      expect(new Set(g.numbers).size).toBe(7);
      expect(g.numbers.every((n) => n >= 1 && n <= 20)).toBe(true);
      expect(g.moonball).toBe(1);
    }
    // 13 standard games: a ticket of 12 and one of 1, in one transaction, every ticket valid
    const txs = packV2(G, 2n, games, me, f20);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toHaveLength(2);
    expect(txs.flat().reduce((a: number, t) => a + ticketGames(G, t, f20), 0)).toBe(13);
  });

  it('own numbers: a standard game, a System, a Pick, a Sweep; anything outside the format is refused', () => {
    expect(gamesForChoice({ numbers: [20, 1, 5, 9, 12, 14, 17] }, f20)).toEqual([{ numbers: [1, 5, 9, 12, 14, 17, 20], moonball: 1 }]);
    const sys = gamesForChoice({ numbers: [1, 2, 3, 4, 5, 6, 7, 8] }, f20);
    expect(ticketGames(G, packV2(G, 2n, sys, me, f20)[0]![0], f20)).toBe(8);
    const pick = gamesForChoice({ numbers: [1, 2, 3, 4, 5, 6], pick: true }, f20);
    expect(ticketGames(G, packV2(G, 2n, pick, me, f20)[0]![0], f20)).toBe(14);
    const sweep = gamesForChoice({ numbers: [1, 2, 3, 4, 5, 6, 7], sweep: true }, f35);
    expect(ticketGames(G, packV2(G, 2n, sweep, me, f35)[0]![0], f35)).toBe(20);
    expect(gamesForChoice({ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 9 }, f35)[0]!.moonball).toBe(9);
    expect(() => gamesForChoice({ numbers: [1, 2, 3, 4, 5, 6, 23] }, f20)).toThrow(/1-20.*23 isn't one/);
    expect(() => gamesForChoice({ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 3 }, f20)).toThrow(/no Moonball/);
    expect(() => gamesForChoice({ games: 1, sweep: true }, f20)).toThrow(/nothing to sweep/);
    expect(() => gamesForChoice({ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 21 }, f35)).toThrow(/1-20/);
    expect(() => gamesForChoice({ numbers: [1, 1, 3, 4, 5, 6, 7] }, f20)).toThrow(/once/);
    expect(() => gamesForChoice({ numbers: [1, 2, 3, 4, 5, 6] }, f20)).toThrow(/7 numbers/);
    expect(() => gamesForChoice({ games: 61 }, f20)).toThrow(/1 to 60/);
  });

  it('reads the buy tool\'s arguments, and picks the game', () => {
    expect(v2ChoiceOf({ games: 3 })).toEqual({ games: 3 });
    expect(v2ChoiceOf({ numbers: '1 2,3 4 5 6 7', moonball: 4 })).toEqual({ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 4 });
    expect(v2ChoiceOf({ numbers: [1, 2, 3, 4, 5], pick: 5 })).toEqual({ numbers: [1, 2, 3, 4, 5], pick: true });
    expect(() => v2ChoiceOf({ package: 'lucky-dip' })).toThrow(/no QuickPick packages/);
    expect(() => v2ChoiceOf({})).toThrow(/give games/);
    expect(() => v2ChoiceOf({ games: 2, numbers: [1, 2, 3, 4, 5, 6, 7] })).toThrow(/not both/);
    expect(() => v2ChoiceOf({ system: 9, numbers: [1, 2, 3, 4, 5, 6, 7, 8] })).toThrow(/System 9 takes 9/);
    expect(gameOf({}, true)).toBe('starfall');
    expect(gameOf({ game: 'Starfall' }, true)).toBe('starfall');
    // Classic ended with its final draw (27 Nov 2026): asked for by name, it's refused in plain words
    expect(() => gameOf({ game: 'classic' }, true)).toThrow(/Starfall Classic ended.*nothing was bought/);
    expect(() => gameOf({ game: 'Classic' }, false)).toThrow(/Starfall Classic ended/);
    expect(() => gameOf({}, false)).toThrow(/carries no Starfall game/);
    expect(() => gameOf({ game: 'lotto' }, true)).toThrow(/must be 'starfall'/);
    expect(formatText(f20)).toBe('7 numbers from 1-20, no Moonball');
    expect(formatText(f35)).toBe('7 numbers from 1-35 and a Moonball from 1-20');
  });
});

describe('results and limits', () => {
  const settled = (over: Partial<StarfallView['draws'][number]> = {}) =>
    ({
      id: 1n,
      status: 4,
      salesClose: 1n,
      numbers: [3, 4, 5, 14, 16, 18, 19],
      moonball: 1,
      tickets: 2n,
      games: 2857n,
      winners: [0n, 0n, 0n, 0n, 60n, 524n, 0n, 0n, 0n],
      prizes: [0n, 0n, 0n, 0n, 9_490_001n, 1_639_503n, 0n, 0n, 0n],
      final: false,
      format: { range: 20, moonballs: 1 },
      ...over,
    }) as unknown as StarfallView['draws'][number];

  it('works out a kept ticket\'s winning games with the contract\'s prize circuit, and what they won', () => {
    // entry: 5 right (Division 5); lines: 4 right (Division 6) and nothing
    const t = packV2(G, 1n, [{ numbers: [3, 4, 5, 14, 16, 1, 2], moonball: 1 }, { numbers: [3, 4, 5, 14, 1, 2, 6], moonball: 1 }, { numbers: [1, 2, 6, 7, 8, 9, 10], moonball: 1 }], me, f20)[0]![0];
    const saved = savedTicketOf(t);
    expect(saved).toEqual({ kind: 0, numbers: [1, 2, 3, 4, 5, 14, 16], moonball: 1, sweep: false, lines: [{ numbers: [1, 2, 3, 4, 5, 6, 14], moonball: 1 }, { numbers: [1, 2, 6, 7, 8, 9, 10], moonball: 1 }] });
    expect(savedTicketWins(G, 1n, saved, [3, 4, 5, 14, 16, 18, 19], 1, f20)).toEqual([0, 0, 0, 0, 1, 1, 0, 0, 0]);
    expect(describeSavedTicket(saved, f20)).toBe('1 2 3 4 5 14 16; 1 2 3 4 5 6 14; 1 2 6 7 8 9 10');
    expect(describeSavedTicket({ ...saved, lines: [], moonball: 7 }, f35)).toBe('1 2 3 4 5 14 16 + 7');
    expect(divisionName(4, 1)).toBe('Division 5 (5 right)');
    expect(divisionName(0, 20)).toBe('Division 1 (7 + Moonball)');

    const home = mkdtempSync(join(tmpdir(), 'kitv2-'));
    const path = kitV2StatePath(home);
    const s = loadKitV2State(path, 'ab'.repeat(32));
    const now = Date.now();
    s.purchases.push({ draw: '1', at: new Date(now - 3600_000).toISOString(), games: 3, cost: '3900000', txs: 1, numbers: [saved.numbers], tickets: [saved] });
    s.syndicates.push({ syndicate: '1', draw: '2', at: new Date(now - 60_000).toISOString(), shares: 2, cost: '2600000', member: 4 });
    saveV2AgentState(path, s);
    const back = loadKitV2State(path, 'ab'.repeat(32));
    expect(back.syndicates).toHaveLength(1); // kept by the house agents' loader too
    expect(v2SpentOnDraw(back, 1n)).toBe(3_900_000n);
    expect(v2SpentOnDraw(back, 2n)).toBe(2_600_000n);
    expect(v2SpentSince(back, now - 24 * 3600_000)).toBe(6_500_000n);

    const view = { draws: [settled(), settled({ id: 2n, status: 0, salesClose: BigInt(Math.floor(now / 1000) + 3600) })], ticketPrice: 1_300_000n, carry: 19_588_500_368n, ended: false } as unknown as StarfallView;
    const syndicate = { drawId: 2n, status: 0, sharePrice: 1_300_000n, totalShares: 10n, sold: 6n, games: 10n, bought: 0n, joinDeadline: 0n, members: 5n };
    const report = ticketsReportV2(G, back, view, (d) => (d === 1n || d === 2n ? f20 : undefined), (id) => (id === 1n ? syndicate : undefined), now);
    expect(report.purchases[0]!.result).toBe(
      '3 4 5 14 16 18 19: 2 winning game(s): 1 in Division 5 (5 right), 1 in Division 6 (4 right); 11.129504 tNIGHT in all, paid to the payout address automatically',
    );
    expect(report.purchases[0]!.tickets).toEqual(['1 2 3 4 5 14 16; 1 2 3 4 5 6 14; 1 2 6 7 8 9 10']);
    expect(report.syndicates[0]).toMatchObject({ syndicate: 1, draw: 2, shares: 2, cost: '2.6 tNIGHT', status: 'filling: 6 of 10 shares sold' });
    expect(report.spentLast24h).toBe('6.5 tNIGHT');
    // an older purchase with only its entries' numbers
    const old = { ...back, purchases: [{ draw: '1', at: new Date(now).toISOString(), games: 1, cost: '1300000', txs: 1, numbers: [[1, 2, 3, 4, 5, 6, 7]] }], syndicates: [] };
    expect(ticketsReportV2(G, old, view, () => f20, () => undefined, now).purchases[0]!.result).toMatch(/weren't kept/);
  });

  it('keeps to the owner\'s limits, a draw and a day', () => {
    const base = { draw: 2n, inDraw: 0n, today: 0n, cost: 13_000_000n, perDraw: 25_000_000n, perDay: 100_000_000n };
    expect(overLimits(base)).toBeUndefined();
    expect(overLimits({ ...base, inDraw: 13_000_000n })).toMatch(/26 tNIGHT in draw 2, over the owner's limit of 25 tNIGHT a draw \(13 tNIGHT already/);
    expect(overLimits({ ...base, today: 90_000_000n })).toMatch(/103 tNIGHT in 24 hours/);
  });

  it('says what is on sale: the format, the fixed jackpot, open syndicates and the results', () => {
    const now = 1_795_000_000;
    const view = {
      draws: [settled(), settled({ id: 2n, status: 0, salesClose: BigInt(now + 7200), games: 1584n, tickets: 2n })],
      ticketPrice: 1_300_000n,
      carry: 19_588_500_368n,
      ended: false,
    } as unknown as StarfallView;
    const o = overviewV2Of(view, 'preprod', 'ab'.repeat(32), now, 1);
    expect(o.onSale).toMatchObject({ draw: 2, minutesLeft: 120, format: '7 numbers from 1-20, no Moonball', range: 20, moonballs: 1, games: 1584, jackpot: '19588.500368 tNIGHT', syndicatesOpen: 1 });
    expect(o.gamePrice).toBe('1.3 tNIGHT');
    expect(o.recent).toEqual([{ draw: 1, status: 'settled', format: '7 numbers from 1-20, no Moonball', numbers: [3, 4, 5, 14, 16, 18, 19], games: 2857, winningGames: 584, jackpotWon: false }]);

    const sy = (o2: object) => ({ drawId: 2n, status: 0, sharePrice: 650_000n, totalShares: 20n, sold: 5n, games: 10n, bought: 0n, joinDeadline: BigInt(now + 3000), members: 3n, ...o2 });
    const ledger = { syndicates: new Map<bigint, unknown>([[1n, sy({})], [2n, sy({ status: 1 })], [3n, sy({ drawId: 1n })], [4n, sy({ joinDeadline: BigInt(now - 1) })]]) };
    expect(openSyndicatesOf(ledger as never, 2n, now)).toEqual([
      { syndicate: 1, draw: 2, sharePrice: '0.65 tNIGHT', sharesLeft: 15, totalShares: 20, games: 10, members: 3, joinDeadline: new Date((now + 3000) * 1000).toISOString(), minutesLeft: 50 },
    ]);
    expect(openSyndicatesOf(ledger as never, undefined, now)).toEqual([]);
  });
});
