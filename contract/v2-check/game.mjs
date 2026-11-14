// Starfall v2 and the Treasury end to end, in memory: the fixed jackpot, the ceiling, the
// Treasury's top-ups across contracts, the retarget (up, and waiting to step down) and the
// final draw. Every transaction is checked against the chain's rule for unshielded tokens
// (world.mjs), and after every stage nothing may have been created or lost.
import { World, STAR, LADDER, address, makeTicket, mkRung } from './world.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`); };
const tn = (star) => `${(Number(star) / 1e6).toLocaleString('en', { maximumFractionDigits: 2 })} tNIGHT`;
const others = (nums, range, want) => { const out = []; for (let x = 1; x <= range && out.length < want; x++) if (!nums.includes(x)) out.push(x); return out; };
const sorted = (a) => [...a].sort((x, y) => x - y);
const alice = address('alice'), bob = address('bob'), carol = address('carol');
const CEIL = 710_000n, FLOOR = 200_000n;
const cap = (rung) => CEIL * LADDER[rung].odds;
// What the Treasury pays of `amount` while keeping `held` back: all of it if it can, else whole tNIGHT.
const payable = (balance, amount, held) => (balance >= held + amount ? amount : balance > held ? ((balance - held) / STAR) * STAR < amount ? ((balance - held) / STAR) * STAR : amount : 0n);
const expectTopUp = (balance, kept, floor, capNext, capAim) => {
  const top = capAim < capNext ? capAim : capNext;
  const base = floor < top ? floor : top; const need = kept < base ? base - kept : 0n; const after = kept + need;
  const extra = after < top ? top - after : 0n;
  const paidNeed = payable(balance, need, 0n); return paidNeed + payable(balance, extra, paidNeed + floor);
};
const throws = async (f) => { try { await f(); return ''; } catch (e) { return String(e?.message ?? e); } };

// ---------------------------------------------------------------- a Treasury that is short pays whole tNIGHT
{
  const s = await World.create(); await s.bind(); await s.deposit(10_000n * STAR + 500_000n);
  await s.open('seed-1');
  ok('a Treasury holding 10,000.5 tNIGHT, asked for the 34,000 floor, pays 10,000 and keeps the half', s.ledger().carry === 10_000n * STAR && s.bal[s.tAddr] === 500_000n && s.conserved());
}

// ---------------------------------------------------------------- the bound the constructor enforces
// With division 1 at half the pool, the other divisions return 0.5 a game, so the ceiling must stay
// below 0.8 a combination for a 1.3 game: 0.79 deploys, 0.80 is refused.
ok('a ceiling of 0.79 a combination deploys with division 1 at half the pool', (await throws(() => World.create({ ceiling: 790_000n }))) === '');
ok('a ceiling of 0.80 is refused: a game could return what it costs', /ceiling is too high/.test(await throws(() => World.create({ ceiling: 800_000n }))));

// ---------------------------------------------------------------- setting up
const w = await World.create();
ok('the first draw cannot open before the Treasury is bound to the game', (await throws(() => w.open('early'))) !== '');
await w.bind();
ok('the Treasury binds once and never again', /already bound/.test(await throws(() => w.bind())));
await w.deposit(100_000n * STAR);
ok('a deposit reaches the Treasury', w.bal[w.tAddr] === 100_000n * STAR);
ok('nobody but the game can ask the Treasury for money', /only the bound game/.test(await throws(() => w.run('release', [5n, 0n, 1000n * STAR, 0n, 0n, false], {}, { on: 'treasury' }))));

// ---------------------------------------------------------------- draw 1: the opening jackpot, a win, a Pick
await w.open('seed-1');
let l = w.ledger();
ok(`draw 1 opens on 7 from 22 with the Treasury's opening jackpot: the floor (34,000) and what it holds above a reserve of one floor (32,000): ${tn(l.carry)}`,
   l.carry === 66_000n * STAR && w.bal[w.tAddr] === 34_000n * STAR && l.draws.lookup(1n).format.range === 22n && l.draws.lookup(1n).format.moonballs === 1n);
ok('opening the first draw called the Treasury across contracts', w.log.at(-1).calls.join(' > ') === 'treasury.release > game.requestDraw', w.log.at(-1).calls.join(' > '));
const n1 = await w.peek(1n, 'seed-1');
const miss1 = others(n1.main, 22, 15);
const games1 = await w.buy([
  makeTicket(1, { numbers: n1.main, moonball: 1 }, alice),                                                    // 7 right: the jackpot
  makeTicket(1, { numbers: sorted([...n1.main.slice(0, 4), ...miss1.slice(0, 3)]), moonball: 1 }, bob),       // 4 right
  makeTicket(1, { numbers: sorted([...n1.main.slice(0, 3), ...miss1.slice(0, 4)]), moonball: 1 }, carol),     // 3 right: nothing on this rung
  makeTicket(1, { numbers: sorted(miss1.slice(0, 7)), moonball: 1 }, carol, [{ numbers: sorted(miss1.slice(3, 10)), moonball: 1 }]),
  makeTicket(1, { numbers: sorted(miss1.slice(0, 6)), moonball: 1, pick: true }, carol),                      // Pick 6: 16 games on 7 from 22
]);
ok('draw 1 sold 21 games: four standard games, a line, and a Pick 6 counted as 16 games (22 - 6), not 29', games1 === 21n && w.bal[w.gAddr] === 66_000n * STAR + 21n * 1_300_000n);
const jackpot1 = w.ledger().carry;
await w.draw(1n, 'seed-1', 'seed-2');
await w.settle(1n);
const tBefore1 = w.bal[w.tAddr];
const f1 = await w.finalise(1n);
l = w.ledger();
const pool1 = 21n * STAR, share1 = (pool1 * 5000n) / 10000n;
ok(`division 1 paid the jackpot fixed before the draw, ${tn(jackpot1)}, and nothing from the draw's own sales`, f1.carried === jackpot1 && f1.prizes[0] === jackpot1);
ok('4 right took its 40% and, with nobody above it, the 6 and 5 right shares that fell to it', f1.prizes[5] === (pool1 * 752n) / 10000n + (pool1 * 1241n) / 10000n + (pool1 * 3007n) / 10000n, `${f1.prizes[5]}`);
ok('3 right pays nothing on a no-Moonball rung', f1.prizes[7] === 0n);
ok('the fees: 0.10 a game to the Treasury, 0.20 to the operator', f1.treasuryFee === 2_100_000n && f1.fee === 4_200_000n && w.paid(w.operator) === 4_200_000n);
ok(`the next jackpot starts with the draw's own division 1 share (${tn(share1)}) and the Treasury tops it up to the floor: ${tn(l.carry)}`,
   l.carry === 34_000n * STAR && f1.refill === expectTopUp(tBefore1, share1, 34_000n * STAR, cap(1), cap(1)) && f1.overflow === 0n, `carry ${l.carry} refill ${f1.refill}`);
ok('finalising settled with the Treasury in one transaction', w.log.at(-1).calls.join(' > ') === 'treasury.release > game.finaliseDraw');
const paid1 = await w.payAll(1n);
ok('two entitlements, both paid: Alice the jackpot, Bob the 4-right prize; the 3-right ticket has none', paid1 === 2 && w.paid(alice) === jackpot1 && w.paid(bob) === f1.prizes[5] && w.paid(carol) === 0n, `${paid1}`);
ok('nothing created or lost, and the game holds exactly the next jackpot', w.conserved() && w.bal[w.gAddr] === l.carry, `game ${w.bal[w.gAddr]} carry ${l.carry}`);

// ---------------------------------------------------------------- draws 2-4: rollovers and the ceiling
// 140 System 12 tickets a draw (110,880 games), each holding 4 drawn numbers: winners at 4 right, none above.
// What no division takes (remainders below one STAR per winning game) joins the jackpot too: allow 0.01 tNIGHT.
const sell = async (n, range, tickets, hits) => {
  const nums = await w.peek(n, `seed-${n}`); const miss = others(nums.main, range, 15);
  const ts = []; for (let i = 0; i < tickets; i++) ts.push(makeTicket(Number(n), { numbers: sorted([...nums.main.slice(0, hits), ...miss.slice(0, 12 - hits)]), moonball: 1 }, carol));
  let games = 0n; for (let i = 0; i < ts.length; i += 7) games += await w.buy(ts.slice(i, i + 7)); return games;
};
const play = async (n, opts) => { await w.draw(n, `seed-${n}`, `seed-${n + 1n}`, opts); await w.settle(n); const f = await w.finalise(n); await w.payAll(n); return f; };
const big = 110_880n, shareBig = (big * STAR * 5000n) / 10000n;
ok('140 System 12 tickets are 110,880 games', (await sell(2n, 22, 140, 4)) === big);
const f2 = await play(2n);
l = w.ledger();
ok(`draw 2 was not won at the top: the jackpot rolls over and the draw's own share (${tn(shareBig)}) joins it: ${tn(l.carry)}`, f2.prizes[0] === 0n && f2.carried === 34_000n * STAR && l.carry >= 34_000n * STAR + shareBig && l.carry < 34_000n * STAR + shareBig + STAR / 100n && f2.overflow === 0n, `carry ${l.carry}`);
await sell(3n, 22, 140, 4);
const tBefore3 = w.bal[w.tAddr];
const f3 = await play(3n);
l = w.ledger();
ok(`draw 3 would take it past the ceiling for 7 from 22 (${tn(cap(1))}): the jackpot stops there and ${tn(f3.overflow)} goes to the Treasury`,
   l.carry === cap(1) && f3.overflow > 0n && f3.overflow >= 34_000n * STAR + 2n * shareBig - cap(1) && w.bal[w.tAddr] === tBefore3 + f3.overflow + f3.treasuryFee, `carry ${l.carry} overflow ${f3.overflow}`);
await sell(4n, 22, 140, 4);
const f4 = await play(4n);
l = w.ledger();
ok(`draw 4, the jackpot at the ceiling: all of its division 1 share (${tn(shareBig)}) is overflow`, l.carry === cap(1) && f4.overflow >= shareBig && f4.overflow < shareBig + STAR / 100n);
const avg1 = (21n + 3n * big) / 4n;
ok(`after 4 draws the game retargets: ${avg1} games a draw on average, target odds 1 in ${avg1 * 4n}, past the midpoint to 7 from 25: up one rung, and the floor follows (${tn(avg1 * 4n * FLOOR)})`,
   l.rung === 2n && l.aim === 2n && l.windowDraws === 0n && l.floor === avg1 * 4n * FLOOR, `rung ${l.rung} aim ${l.aim} floor ${l.floor}`);
ok('nothing created or lost after four draws', w.conserved() && w.bal[w.gAddr] === l.carry);

// ---------------------------------------------------------------- draw 5: a win at the ceiling, and the refill
await w.deposit(360_000n * STAR);                                // a sponsor (enough for the refills to the ceilings below)
const n5 = await w.peek(5n, 'seed-5');
ok('draw 5 opened before the retarget and keeps 7 from 22', w.ledger().draws.lookup(5n).format.range === 22n);
await w.buy([makeTicket(5, { numbers: n5.main, moonball: 1 }, alice)]);
const aliceBefore = w.paid(alice), tBefore5 = w.bal[w.tAddr], floor5 = w.ledger().floor;
const f5 = await play(5n);
l = w.ledger();
ok(`Alice wins the jackpot at the ceiling, ${tn(cap(1))}`, w.paid(alice) - aliceBefore === cap(1));
const kept5 = STAR;        // one game sold, nobody below division 1: its whole pool joins the next jackpot
ok(`the next draw is 7 from 25: the Treasury (holding ${tn(tBefore5)}) pays ${tn(f5.refill)}: up to the floor and on to that draw's ceiling, keeping a reserve of one floor (${tn(floor5)}); the jackpot is ${tn(l.carry)}`,
   l.draws.lookup(6n).format.range === 25n && f5.refill === expectTopUp(tBefore5, kept5, floor5, cap(2), cap(2)) && l.carry === kept5 + f5.refill && l.carry === cap(2) && w.bal[w.tAddr] >= floor5,
   `refill ${f5.refill} expected ${expectTopUp(tBefore5, kept5, floor5, cap(2), cap(2))} carry ${l.carry}`);
ok('nothing created or lost', w.conserved() && w.bal[w.gAddr] === l.carry);

// ---------------------------------------------------------------- volume falls: the ladder waits for the jackpot to fit
for (const n of [6n, 7n, 8n]) { await sell(n, 25, 1, 0); await play(n); }          // 792 games a draw, nobody wins anything
l = w.ledger();
ok(`a quiet window (target 1 in ${l.floor / FLOOR}) calls for 7 from 22 again, but the jackpot (${tn(l.carry)}) is over that rung's ceiling (${tn(cap(1))}): the ladder stays on 7 from 25 and notes where it is headed`,
   l.rung === 2n && l.aim === 1n && l.carry > cap(1), `rung ${l.rung} aim ${l.aim} carry ${l.carry}`);
const n9 = await w.peek(9n, 'seed-9');
await w.buy([makeTicket(9, { numbers: n9.main, moonball: 1 }, bob)]);
const bobBefore = w.paid(bob), jackpot9 = w.ledger().carry, tBefore9 = w.bal[w.tAddr], floor9 = w.ledger().floor;
const f9 = await play(9n);
l = w.ledger();
ok(`Bob wins it on draw 9 (${tn(jackpot9)}); the refill now stops at the ceiling of the rung the game is headed for: ${tn(l.carry)}`,
   w.paid(bob) - bobBefore === jackpot9 && f9.refill === expectTopUp(tBefore9, STAR, floor9, cap(2), cap(1)) && l.carry === cap(1), `carry ${l.carry} refill ${f9.refill}`);
for (const n of [10n, 11n, 12n]) { await sell(n, 25, 1, 0); await play(n); }
l = w.ledger();
ok(`three more quiet draws leave the jackpot at that ceiling (their shares go to the Treasury), so at the retarget it fits and the ladder steps down to 7 from 22`, l.rung === 1n && l.aim === 1n && l.carry === cap(1), `rung ${l.rung} aim ${l.aim} carry ${l.carry}`);
ok('nothing created or lost', w.conserved() && w.bal[w.gAddr] === l.carry);

// ---------------------------------------------------------------- the final draw
ok('draw 13, already open, is still 7 from 25', l.draws.lookup(13n).format.range === 25n);
await w.draw(13n, 'seed-13', 'seed-14', { final: true });
await w.settle(13n); await w.finalise(13n); await w.payAll(13n);
l = w.ledger();
ok('draw 14 opens as the final draw, on 7 from 22', l.draws.lookup(14n).final && l.draws.lookup(14n).format.range === 22n);
const n14 = await w.peek(14n, 'seed-14');
const miss14 = others(n14.main, 22, 15);
await w.buy([makeTicket(14, { numbers: sorted([...n14.main.slice(0, 5), ...miss14.slice(0, 2)]), moonball: 1 }, bob),        // 5 right
             makeTicket(14, { numbers: sorted(miss14.slice(0, 7)), moonball: 1 }, carol)], address('refund-14'));
const tBeforeEnd = w.bal[w.tAddr], carryBeforeEnd = w.ledger().carry, bobBeforeEnd = w.paid(bob);
await w.draw(14n, 'seed-14', undefined);
await w.settle(14n);
const f14 = await w.finalise(14n);
await w.payAll(14n);
l = w.ledger();
ok(`the final draw takes everything the Treasury holds (${tn(tBeforeEnd)}) into its jackpot (${tn(carryBeforeEnd)} carried in)`, f14.refill > tBeforeEnd - STAR && f14.carried === carryBeforeEnd + f14.refill && w.bal[w.tAddr] < STAR, `refill ${f14.refill} treasury ${w.bal[w.tAddr]}`);
ok(`unwon at the top, all of it falls to the next division with a winner: Bob, with 5 right, is paid ${tn(w.paid(bob) - bobBeforeEnd)}`, w.paid(bob) - bobBeforeEnd >= f14.carried && l.ended && l.carry === 0n);
if (f14.finalShare > 0n) { await w.run('refundTicket', [14n, 0n]); await w.run('refundTicket', [14n, 1n]); }
ok(`the game has ended: it holds ${w.bal[w.gAddr]} STAR and the Treasury ${w.bal[w.tAddr]} STAR (under one tNIGHT)`, w.bal[w.gAddr] < 10n && w.bal[w.tAddr] < STAR && w.conserved());
ok('no draw opens after the game has ended', /ended/.test(await throws(() => w.open('after'))));
ok('the Treasury is finished', w.tLedger().gameEnded === true);

// ---------------------------------------------------------------- growth: the ladder jumps straight up
{
  // A ladder of small formats, retargeting every draw, so one busy draw shows the jump.
  const g = await World.create({ ladder: [14, 15, 16, 17, 18, 19, 20, 22, 25, 27, 30, 35].map((n) => mkRung(n)), startRung: 0n, every: 1n, floor0: 100n * STAR });
  await g.bind(); await g.deposit(1_000n * STAR); await g.open('g-1');
  const nums = await g.peek(1n, 'g-1'); const miss = others(nums.main, 14, 7);
  const ts = []; for (let i = 0; i < 10; i++) ts.push(makeTicket(1, { numbers: sorted([...nums.main.slice(0, 5), ...miss]), moonball: 1 }, carol));
  let games = 0n; for (let i = 0; i < ts.length; i += 7) games += await g.buy(ts.slice(i, i + 7));
  await g.draw(1n, 'g-1', 'g-2'); await g.settle(1n); await g.finalise(1n); await g.payAll(1n);
  const gl = g.ledger();
  ok(`growth: one draw of ${games} games (target 1 in ${games * 4n}) moves the ladder from 7 from 14 straight to 7 from 18, four rungs at once; the draw already open keeps its format`,
     gl.rung === 4n && gl.aim === 4n && gl.draws.lookup(2n).format.range === 14n && g.conserved(), `rung ${gl.rung}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
