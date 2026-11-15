// Starfall v2 as launched (Jack, 14-15 Nov 2026): daily draws aiming for a jackpot about monthly
// (targetDraws 28, retargetEvery 7), starting on 7 from 20 with the treasury wallet's 10,000 tNIGHT
// as the opening deposit and a first floor for about 330 games a draw (28 x 330 x 0.20 = 1,840).
// A week of busy daily draws moves the ladder up at the weekly retarget, not before.
import { World, STAR, address, makeTicket } from './world.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`); };
const others = (nums, range, want) => { const out = []; for (let x = 1; x <= range && out.length < want; x++) if (!nums.includes(x)) out.push(x); return out; };
const sorted = (a) => [...a].sort((x, y) => x - y);
const carol = address('carol');

const w = await World.create({ startRung: 0n, target: 28n, every: 7n, floor0: 1_840n * STAR });
await w.bind(); await w.deposit(10_000n * STAR); await w.open('d-1', 86_400 - 600);
let l = w.ledger();
ok('day 1 opens on 7 from 20 with an 8,160 tNIGHT jackpot; the Treasury keeps 1,840', l.draws.lookup(1n).format.range === 20n && l.carry === 8_160n * STAR && w.bal[w.tAddr] === 1_840n * STAR);

// Six System 12 tickets a day (4,752 games), each holding 4 drawn numbers: winners at 4 right.
// Target odds after a week: 4,752 x 28 = 133,056, past the midpoint of 7 from 20 and 7 from 22.
let rungs = [];
for (let n = 1n; n <= 7n; n++) {
  const nums = await w.peek(n, `d-${n}`); const miss = others(nums.main, Number(w.ledger().draws.lookup(n).format.range), 15);
  const ts = []; for (let i = 0; i < 6; i++) ts.push(makeTicket(Number(n), { numbers: sorted([...nums.main.slice(0, 4), ...miss.slice(i, i + 8)]), moonball: 1 }, carol));
  await w.buy(ts);
  await w.draw(n, `d-${n}`, `d-${n + 1n}`, { sales: 86_400 - 600 }); await w.settle(n); await w.finalise(n); await w.payAll(n);
  rungs.push(w.ledger().rung);
}
l = w.ledger();
ok(`a week of 4,752 games a day: the ladder holds on 7 from 20 for six draws and moves to 7 from 22 at the seventh (rungs ${rungs.join(', ')})`,
   rungs.slice(0, 6).every((r) => r === 0n) && rungs[6] === 1n, rungs.join(','));
ok('day 8, already open when the retarget ran, keeps 7 from 20; the jackpot carried on', l.draws.lookup(8n).format.range === 20n && l.carry > 0n);
ok('nothing created or lost over the week', w.conserved());

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
