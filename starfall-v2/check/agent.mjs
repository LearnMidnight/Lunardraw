// The house agents on v2 (cli/src/starfall-v2-agent.ts) against the game in memory: each style's
// games in the draw's own format (7 from 20 with no Moonball, and Moonball rungs), lucky sets
// folded into the range, packing into tickets and transactions as the website does, the budget,
// once a draw, and every purchase accepted by buyTickets at the price the agent expects.
// Needs the CLI built (npm run build).
import { composeV2, composeV2Purchase, fitLine, packV2, parseV2Lines, planV2, ticketGames } from '../../cli/dist/starfall-v2-agent.js';
import * as G from './out/contract/index.js';
import { World, STAR, address, LADDER, formatOf } from './world.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`); };
const PRICE = 1_300_000n;
const me = address('orbit');
const ORBIT = parseV2Lines('3,11,17,23,26,30,34+7;1,12,21,23,26,31,35+16;2,4,6,8,10,12,14+3');
const f20 = { range: 20, moonballs: 1, pick5: formatOf(LADDER[0]).pick5 };
const f30m5 = formatOf(LADDER[6]);
const f30m5n = { range: Number(f30m5.range), moonballs: Number(f30m5.moonballs), pick5: f30m5.pick5 };

// lucky sets
const a = fitLine(ORBIT[0], f20);
ok('a lucky set above the range is folded into 1-20, 7 different numbers', a.numbers.length === 7 && new Set(a.numbers).size === 7 && a.numbers.every((n) => n >= 1 && n <= 20) && a.moonball === 1, JSON.stringify(a));
ok('orbit 3 11 17 23 26 30 34 on 7/20 is 3 4 6 10 11 14 17 (23 folds to 3, taken, so 4)', JSON.stringify(a.numbers) === JSON.stringify([3, 4, 6, 10, 11, 14, 17]), JSON.stringify(a.numbers));
const b = fitLine(ORBIT[2], f20);
ok('a set that fits is unchanged', JSON.stringify(b.numbers) === JSON.stringify([2, 4, 6, 8, 10, 12, 14]) && b.moonball === 1);
const c = fitLine(ORBIT[1], f30m5n);
ok('on 7/30 + Moonball 1-5 the Moonball is folded too (16 → 1)', c.moonball === 1 && c.numbers.every((n) => n <= 30), JSON.stringify(c));
ok('a bad lucky set is refused', (() => { try { parseV2Lines('1,2,3+4'); return false; } catch { return true; } })());

// every style, both formats: valid tickets, priced as the contract prices them
for (const f of [f20, f30m5n]) {
  for (const style of ['quickpick', 'lucky', 'moonhit', 'system', 'mix']) {
    let all = true;
    let detail = '';
    for (let i = 0; i < 40; i++) {
      const games = composeV2({ name: 'x', style, games: 4, lines: ORBIT }, f);
      try {
        const txs = packV2(G, 1n, games, me, f);
        for (const t of txs.flat()) if (ticketGames(G, t, f) < 1) { all = false; detail = JSON.stringify(games); }
      } catch (e) { all = false; detail = e.message; }
    }
    ok(`${style} on 7/${f.range}${f.moonballs > 1 ? ` + Moonball 1-${f.moonballs}` : ''}: valid tickets`, all, detail);
  }
}
const sweep20 = composeV2({ name: 'x', style: 'moonhit' }, f20);
ok('moonhit on a rung with no Moonball plays a QuickPick game, not a Sweep', !sweep20[0].sweep && sweep20[0].numbers.length === 7);
const sweep30 = composeV2({ name: 'x', style: 'moonhit' }, f30m5n);
ok('moonhit with Moonballs is a Sweep of 5 games', sweep30[0].sweep && ticketGames(G, packV2(G, 1n, sweep30, me, f30m5n)[0][0], f30m5n) === 5);

// packing: 96 QuickPicks (pixel's day: 24 rounds of 4) = 8 tickets of 12 in one transaction
const pixel = composeV2Purchase({ name: 'pixel', style: 'quickpick', games: 4, rounds: 24 }, f20);
const pixelTx = packV2(G, 1n, pixel, me, f20);
ok('pixel\'s 96 games: 8 tickets of 12 in one transaction', pixelTx.length === 1 && pixelTx[0].length === 8 && pixelTx[0].every((t) => ticketGames(G, t, f20) === 12), `${pixelTx.length} tx, ${pixelTx.map((x) => x.length)}`);
const many = composeV2Purchase({ name: 'x', style: 'system', rounds: 12 }, f20);
const manyTx = packV2(G, 1n, many, me, f20);
ok('12 System 8s: 12 tickets in two transactions (10 + 2)', manyTx.length === 2 && manyTx[0].length === 10 && manyTx[1].length === 2);

// planning against a real draw, then buying it
const w = await World.create(); await w.bind(); await w.deposit(100_000n * STAR);
const n = await w.open('agent-1');
const l = w.ledger();
const dr = l.draws.lookup(n);
const draws = [{ id: n, status: Number(dr.status), salesClose: dr.salesClose, format: { range: Number(dr.format.range), moonballs: Number(dr.format.moonballs), pick5: BigInt(dr.format.pick5) } }];
const state = { contract: 'x', purchases: [], reported: [] };
const nowS = Number(w.now);
const plan = planV2(G, draws, PRICE, nowS, state, { name: 'pixel', style: 'quickpick', games: 4, rounds: 24, budget: 130_000_000n }, me);
ok('pixel\'s plan: 96 games for 124.8 tNIGHT, under its 130 budget', plan && !plan.skipped && plan.games === 96 && plan.cost === 96n * PRICE, JSON.stringify(plan && { games: plan.games, cost: String(plan.cost), skipped: plan.skipped }));
let bought = 0n;
for (const tickets of plan.txs) bought += await w.buy(tickets, me);
ok('buyTickets accepts it, at the price the agent expects', bought === 96n);
state.purchases.push({ draw: n.toString(), at: new Date().toISOString(), games: 96, cost: String(plan.cost), txs: 1, numbers: [] });
ok('once a draw: nothing more to buy in it', planV2(G, draws, PRICE, nowS, state, { name: 'pixel', style: 'quickpick', games: 4, rounds: 24 }, me) === null);
const tight = planV2(G, draws, PRICE, nowS, { contract: 'x', purchases: [], reported: [] }, { name: 'pixel', style: 'quickpick', games: 4, rounds: 24, budget: 50_000_000n }, me);
ok('a budget of 50 trims 24 rounds to 9 (36 games)', tight && tight.games === 36, JSON.stringify(tight && { games: tight.games }));
const none = planV2(G, draws, PRICE, nowS, { contract: 'x', purchases: [], reported: [] }, { name: 'x', style: 'quickpick', games: 4, budget: 1_000_000n }, me);
ok('a budget below one round sits the draw out', none && none.skipped, String(none && none.skipped));
ok('nothing to buy close to sales close', planV2(G, draws, PRICE, Number(dr.salesClose) - 60, { contract: 'x', purchases: [], reported: [] }, { name: 'x', style: 'quickpick' }, me) === null);
const orbit = planV2(G, draws, PRICE, nowS, { contract: 'x', purchases: [], reported: [] }, { name: 'orbit', style: 'lucky', lines: ORBIT, rounds: 1, budget: 40_000_000n }, me);
let ob = 0n;
for (const tickets of orbit.txs) ob += await w.buy(tickets, me);
ok('orbit\'s folded sets are accepted: 3 games', ob === 3n && orbit.games === 3);
const mix = planV2(G, draws, PRICE, nowS, { contract: 'x', purchases: [], reported: [] }, { name: 'nova', style: 'mix', rounds: 24, budget: 300_000_000n }, me);
let mb = 0n;
for (const tickets of mix.txs) mb += await w.buy(tickets, me);
ok(`nova's mix of 24 rounds is accepted: ${mix.games} games in ${mix.txs.length} transaction(s)`, mb === BigInt(mix.games) && mix.cost <= 300_000_000n);

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
