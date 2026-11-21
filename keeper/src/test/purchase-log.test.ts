import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Starfall } from '@lunardraw/contract';
import { describe, expect, it } from 'vitest';
import { PurchaseLog } from '../purchase-log.js';

const { DrawStatus } = Starfall;
const draw = (id: number, games: number, tickets = games, status = DrawStatus.open) => ({ id: BigInt(id), status, games: BigInt(games), tickets: BigInt(tickets) });
const at = (secs: number) => new Date(secs * 1000).toISOString();

describe('the purchase log', () => {
  it("notes each selling draw's new games as a purchase, timed by the keeper's pass, and keeps them across a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), 'purchases-')), 'feed.json.purchases.json');
    let log = new PurchaseLog(path);
    // the first pass: games already sold aren't news
    log.observe({ draws: [draw(158, 6, 6, DrawStatus.drawn), draw(159, 7)] }, 1000);
    expect(log.recent()).toEqual([]);
    log.observe({ draws: [draw(159, 7)] }, 1060); // nothing new
    log.observe({ draws: [draw(159, 19, 19)] }, 1120); // 12 games
    log.observe({ draws: [draw(159, 23, 20)] }, 1180); // a System entry: 1 ticket, 4 games
    expect(log.recent()).toEqual([
      { draw: 159, games: 4, tickets: 1, at: at(1180) },
      { draw: 159, games: 12, tickets: 12, at: at(1120) },
    ]);

    // a restart reads it back, and doesn't count draw 159's games again
    log = new PurchaseLog(path);
    log.observe({ draws: [draw(159, 23, 20)] }, 1240);
    expect(log.recent()).toHaveLength(2);
    // sales close and a new draw opens: its games are all new
    log.observe({ draws: [draw(159, 23, 20, DrawStatus.requested), draw(160, 3)] }, 1300);
    expect(log.recent(1)).toEqual([{ draw: 160, games: 3, tickets: 3, at: at(1300) }]);
    expect(JSON.parse(readFileSync(path, 'utf8')).seen).toEqual({ '160': { games: 3, tickets: 3 } });
  });

  it('keeps the newest ones only', () => {
    const log = new PurchaseLog(undefined, 3);
    log.observe({ draws: [draw(1, 0)] }, 0);
    for (let i = 1; i <= 5; i++) log.observe({ draws: [draw(1, i)] }, i * 60);
    expect(log.recent().map((p) => p.at)).toEqual([at(300), at(240), at(180)]);
  });

  it('notes the wallet that bought each purchase where the draw says who bought (Starfall v2)', () => {
    const log = new PurchaseLog();
    const A = 'e45e'.padEnd(64, '0');
    const B = 'b0b0'.padEnd(64, '0');
    const v2 = (games: number, tickets: number, buyers: { address: string; games: number; tickets: number }[]) => ({
      ...draw(3, games, tickets),
      buyers: buyers.map((b) => ({ ...b, games: BigInt(b.games) })),
    });
    log.observe({ draws: [v2(10, 2, [{ address: B, games: 10, tickets: 2 }])] }, 1000);
    log.observe({ draws: [v2(11, 3, [{ address: B, games: 10, tickets: 2 }, { address: A, games: 1, tickets: 1 }])] }, 1060);
    // two wallets between one pass and the next: one purchase each
    log.observe({ draws: [v2(66, 5, [{ address: B, games: 15, tickets: 3 }, { address: A.toUpperCase(), games: 51, tickets: 2 }])] }, 1120);
    expect(log.recent()).toEqual([
      { draw: 3, games: 50, tickets: 1, at: at(1120), buyer: A },
      { draw: 3, games: 5, tickets: 1, at: at(1120), buyer: B },
      { draw: 3, games: 1, tickets: 1, at: at(1060), buyer: A },
    ]);
    // a draw with no buyers on record (Classic) is still a purchase, just not anyone's
    log.observe({ draws: [draw(4, 2)] }, 1180);
    expect(log.recent(1)).toEqual([{ draw: 4, games: 2, tickets: 2, at: at(1180) }]);
  });
});
