// Pure-circuit checks of the compiled Starfall v2 contract (compact-runtime 0.21).
import { pureCircuits } from './out/contract/index.js';

const comb = (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return Math.round(r); };
const fmt = (range, moonballs) => ({ range: BigInt(range), moonballs: BigInt(moonballs), pick5: BigInt(comb(range - 5, 2)) });
const line = (numbers, moonball) => ({ numbers: numbers.map(BigInt), moonball: BigInt(moonball) });
const noLine = line([0, 0, 0, 0, 0, 0, 0], 0);
const entry = (numbers, moonball, { kind = 0, sweep = false } = {}) => ({
  kind: BigInt(kind), count: BigInt(numbers.length),
  numbers: [...numbers, ...Array(12 - numbers.length).fill(0)].map(BigInt), moonball: BigInt(moonball), sweep,
});
const payees = [{ lo: 1n, hi: 2n, share: 10000n }, { lo: 0n, hi: 0n, share: 0n }, { lo: 0n, hi: 0n, share: 0n }];
const ticket = (e, lines = []) => ({ drawId: 1n, entry: e, lines: [...lines, ...Array(11 - lines.length).fill(noLine)], payees, salt: 7n });
let failed = 0;
const ok = (name, cond) => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- formats
const f22 = fmt(22, 1), f35 = fmt(35, 20), f30x5 = fmt(30, 5);
ok('7/22 no Moonball: a standard game with Moonball 1 is valid', pureCircuits.validTicket(ticket(entry([1, 5, 9, 13, 17, 21, 22], 1)), f22));
ok('7/22: number 23 is refused', !pureCircuits.validTicket(ticket(entry([1, 5, 9, 13, 17, 21, 23], 1)), f22));
ok('7/22: Moonball 2 is refused', !pureCircuits.validTicket(ticket(entry([1, 5, 9, 13, 17, 21, 22], 2)), f22));
ok('7/22: a Sweep is refused', !pureCircuits.validTicket(ticket(entry([1, 5, 9, 13, 17, 21, 22], 0, { sweep: true })), f22));
ok('7/22: a line with Moonball 2 is refused', !pureCircuits.validTicket(ticket(entry([1, 5, 9, 13, 17, 21, 22], 1), [line([2, 3, 4, 5, 6, 7, 8], 2)]), f22));
ok('7/35 x20: Moonball 20 is valid, 21 refused', pureCircuits.validTicket(ticket(entry([1, 5, 9, 13, 17, 21, 35], 20)), f35) && !pureCircuits.validTicket(ticket(entry([1, 5, 9, 13, 17, 21, 35], 21)), f35));
ok('Sweep is 20 games at M = 20, 5 at M = 5', pureCircuits.gamesIn(entry([1, 5, 9, 13, 17, 21, 30], 0, { sweep: true }), f35) === 20n && pureCircuits.gamesIn(entry([1, 5, 9, 13, 17, 21, 30], 0, { sweep: true }), f30x5) === 5n);
ok('System 9 Sweep at M = 5 is 180 games', pureCircuits.gamesIn(entry([1, 2, 3, 4, 5, 6, 7, 8, 9], 0, { sweep: true }), f30x5) === 180n);

// ---- divisions without a Moonball: 7, 6, 5, 4, 3, 2 right land in slots 1, 3, 5, 6, 8, 9
const drawn = [1, 2, 3, 4, 5, 6, 7].map(BigInt);
const div = (e, mb, f) => pureCircuits.gamesByDivision(e, drawn, BigInt(mb), f).map(Number);
ok('no Moonball: 7 right is division 1', same(div(entry([1, 2, 3, 4, 5, 6, 7], 1), 1, f22), [1, 0, 0, 0, 0, 0, 0, 0, 0]));
ok('no Moonball: 6 right is slot 3', same(div(entry([1, 2, 3, 4, 5, 6, 9], 1), 1, f22), [0, 0, 1, 0, 0, 0, 0, 0, 0]));
ok('no Moonball: 4 right is slot 6', same(div(entry([1, 2, 3, 4, 10, 11, 12], 1), 1, f22), [0, 0, 0, 0, 0, 1, 0, 0, 0]));
ok('no Moonball: 3 right is slot 8 (no share on the small rungs)', same(div(entry([1, 2, 3, 9, 10, 11, 12], 1), 1, f22), [0, 0, 0, 0, 0, 0, 0, 1, 0]));
ok('Moonball: Sweep with 7 right is 1 in division 1 and 19 in division 2', same(div(entry([1, 2, 3, 4, 5, 6, 7], 0, { sweep: true }), 7, f35), [1, 19, 0, 0, 0, 0, 0, 0, 0]));
ok('Moonball 1-5: Sweep with 7 right is 1 and 4', same(div(entry([1, 2, 3, 4, 5, 6, 7], 0, { sweep: true }), 3, f30x5), [1, 4, 0, 0, 0, 0, 0, 0, 0]));
const t = ticket(entry([1, 2, 3, 4, 5, 6, 7], 1), [line([1, 2, 3, 4, 5, 6, 8], 1), line([1, 2, 3, 4, 11, 12, 13], 1)]);
ok('a ticket with lines on 7/22: entry 7 right, lines 6 and 4 right', same(pureCircuits.ticketDivisions(t, drawn, 1n, f22).map(Number), [1, 0, 1, 0, 0, 1, 0, 0, 0]) && pureCircuits.ticketGames(t, f22) === 3n);

// ---- Picks against every game listed, for each number range on the ladder and a few others
const slotOf = (m) => ({ 7: 0, 6: 2, 5: 4, 4: 5, 3: 7, 2: 8 })[m];
let pickCases = 0, pickBad = 0;
for (const N of [14, 20, 22, 25, 27, 30, 35, 40, 45, 60]) {
  const f = fmt(N, 1);
  for (const count of [6, 5]) {
    for (let h = 0; h <= count; h++) {
      const chosen = [...Array(h).keys()].map((i) => i + 1).concat([...Array(count - h).keys()].map((i) => i + 8));
      const rest = []; for (let x = 1; x <= N; x++) if (!chosen.includes(x)) rest.push(x);
      const want = Array(9).fill(0); let games = 0;
      const score = (extra) => { games++; const m = [...chosen, ...extra].filter((x) => x <= 7).length; if (m >= 2) want[slotOf(m)]++; };
      if (count === 6) for (const a of rest) score([a]);
      else for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) score([rest[i], rest[j]]);
      const e = entry([...chosen].sort((a, b) => a - b), 1, { kind: 1 });
      const got = div(e, 1, f);
      pickCases++;
      if (!same(got, want) || Number(pureCircuits.gamesIn(e, f)) !== games || !pureCircuits.validTicket(ticket(e), f)) {
        pickBad++; console.log(`     N=${N} Pick ${count} h=${h}: got ${got} (${pureCircuits.gamesIn(e, f)} games), want ${want} (${games} games)`);
      }
    }
  }
}
ok(`Picks: ${pickCases} cases (Pick 6 and Pick 5, every number of hits, 10 number ranges) match every game listed`, pickBad === 0);
// Systems unchanged across ranges
for (const N of [22, 45]) {
  const e = entry([1, 2, 3, 4, 8, 9, 10, 11, 12], 1);   // System 9 with 4 drawn
  const want = Array(9).fill(0);
  const nums = [1, 2, 3, 4, 8, 9, 10, 11, 12];
  const rec = (start, pick) => { if (pick.length === 7) { const m = pick.filter((x) => x <= 7).length; if (m >= 2) want[slotOf(m)]++; return; } for (let i = start; i < nums.length; i++) rec(i + 1, [...pick, nums[i]]); };
  rec(0, []);
  ok(`System 9 on 7/${N} matches every game listed`, same(div(e, 1, fmt(N, 1)), want) && pureCircuits.gamesIn(e, fmt(N, 1)) === 36n);
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
