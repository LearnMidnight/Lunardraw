// The Starfall keeper and draw oracle (keeper/src) running Starfall v2 in memory: the real keeper
// and oracle, with the v2 view and its syndicate steps (cli/src/starfall-v2.ts), against both
// contracts in world.mjs. Nobody calls a circuit by hand after the purchases: the keeper opens,
// reveals, computes, settles, finalises (the Treasury tops the next jackpot up), pays every
// prize, pays each syndicate member its part, refunds syndicates, voids a draw the oracle let
// run out of time and refunds it. Needs the keeper and the CLI built (npm run build).
import * as rt from '@midnight-ntwrk/compact-runtime';
import { DerivedSeeds, DrawOracle, every, idle, StarfallKeeper, buildStarfallFeed } from '@lunardraw/keeper';
import { starfallV2ViewOf, v2StoredTickets } from '../../cli/dist/starfall-v2.js';
import * as G from './out/contract/index.js';
import { World, STAR, address, makeTicket, syndicateTicket } from './world.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`); };
const tn = (star) => `${(Number(star) / 1e6).toLocaleString('en', { maximumFractionDigits: 6 })} tNIGHT`;
const others = (nums, range, want) => { const out = []; for (let x = 1; x <= range && out.length < want; x++) if (!nums.includes(x)) out.push(x); return out; };
const sorted = (a) => [...a].sort((x, y) => x - y);
const PRICE = 1_300_000n;
const NONE = { is_some: false, value: { salesClose: 0n, seedCommitment: new Uint8Array(32), final: false } };
const alice = address('alice'), bob = address('bob'), carol = address('carol'), dave = address('dave'), erin = address('erin');
const creator = address('syndicate creator');

/** World as the keeper's and the oracle's chain: each call is one transaction. */
class WorldChain {
  constructor(w) { this.w = w; this.addressBytes = rt.encodeContractAddress(w.gAddr); }
  organiser(circuit, args) { return this.w.run(circuit, args, { organiserSecret: this.w.organiserSecret }); }
  async view() { return starfallV2ViewOf(G, this.w.ledger()); }
  async now() { return this.w.now; }
  async storedTickets(n) { return v2StoredTickets(G, this.w.ledger(), n); }
  async openDraw(salesClose, seedCommitment, final = false) { await this.organiser('requestDraw', [0n, new Uint8Array(32), { is_some: true, value: { salesClose, seedCommitment, final } }]); }
  async requestDraw(n, seed, next) { await this.organiser('requestDraw', [n, seed, next ? { is_some: true, value: next } : NONE]); }
  async fulfilDraw(n) { await this.w.run('fulfilDraw', [n], { oracleSecretKey: this.w.oracleSk }); }
  async computeNumbers(n) { await this.w.run('computeNumbers', [n, BigInt(this.w.now)]); }
  async settleBatch(n, tickets) { await this.w.run('settleBatch', [n], { settling: { drawId: n, tickets } }); }
  async finaliseDraw(n) { await this.w.run('finaliseDraw', [n]); }
  async payEntitlement(id) { await this.w.run('payEntitlement', [id]); }
  async voidDraw(n) { await this.w.run('voidDraw', [n]); }
  async refundTicket(n, index) { await this.w.run('refundTicket', [n, index]); }
  async paySyndicateMember(id, payee, member) { await this.w.run('paySyndicateMember', [id, BigInt(payee), member]); }
  async refundSyndicate(syndicate, member) { await this.w.run('refundSyndicate', [syndicate, member]); }
}

const w = await World.create(); await w.bind(); await w.deposit(100_000n * STAR);
const chain = new WorldChain(w);
const seeds = new DerivedSeeds(w.organiserSecret, chain.addressBytes);
const clock = () => w.now * 1000;
const log = [];
const logger = { info: (m) => log.push(m), warn: (m) => log.push(m), error: (m) => log.push(`ERROR ${m}`) };
const keeper = new StarfallKeeper({ chain, seeds, settlementSecret: w.settlementSk, pure: G.pureCircuits, schedule: every(3600), clock, backoffMs: 1_000, logger });
const oracle = new DrawOracle({ chain, publicKey: G.pureCircuits.settlementPublicKey(w.oracleSk), clock, newRequestDelayMs: 0, logger });
const ran = () => w.log.map((x) => x.circuit);
/** Keeper and oracle passes, a minute apart, until `done` (or `max` passes). */
const run = async (done, max = 60, { oracleOn = true } = {}) => {
  for (let i = 0; i < max; i++) {
    const r = await keeper.tick();
    if (r.failed.length) log.push(`FAILED ${JSON.stringify(r.failed)}`);
    if (oracleOn) await oracle.tick();
    if (await done()) return true;
    w.advance(60);
  }
  return false;
};
/** The numbers draw n will have with the keeper's seed (found on a copy: they don't depend on the tickets). */
const peek = async (n) => {
  const s = w.snapshot();
  const d = w.ledger().draws.lookup(n);
  w.now = Number(d.salesClose) + 1;
  await chain.requestDraw(n, (await seeds.forDraw(n)).seed);
  await chain.fulfilDraw(n);
  const nums = await w.run('computeNumbers', [n, BigInt(w.now)]);
  w.restore(s);
  return nums.main.map(Number);
};

// ---------------------------------------------------------------- a draw the keeper runs end to end
await keeper.tick();
let l = w.ledger();
const d1 = l.draws.lookup(1n);
ok(`the keeper opens draw 1 on its rung (7 from ${d1.format.range}), and the Treasury pays its opening jackpot (${tn(l.carry)}, at least the floor) in the same transaction`,
   l.lastDraw === 1n && d1.status === 0 && l.carry >= w.o.floor0 && w.bal[w.tAddr] === 100_000n * STAR - l.carry && [...w.log.at(-1).calls].sort().join() === 'game.requestDraw,treasury.release', w.log.at(-1).calls.join());
const range = Number(d1.format.range);
const nums = await peek(1n);
const miss = others(nums, range, 15);
// Carol wins the jackpot, Dave 4 right; 24 tickets that win nothing make two settlement batches.
await w.buy([makeTicket(1, { numbers: nums, moonball: 1 }, carol)]);
await w.buy([makeTicket(1, { numbers: sorted([...nums.slice(0, 4), ...miss.slice(0, 3)]), moonball: 1 }, dave)]);
for (let k = 0; k < 3; k++) {
  await w.buy(Array.from({ length: 8 }, (_, j) => makeTicket(1, { numbers: sorted(miss.slice((k + j) % 6, ((k + j) % 6) + 7)), moonball: 1 }, erin)));
}
// Syndicate 1: 4 shares of 0.65 for 2 games; Alice 1 share, Bob 3. The creator buys one game: 6 right.
const by = d1.salesClose - 600n;
const s1 = await w.createSyndicate(1, creator, 650_000n, 4, 2, by);
await w.join(s1, 1, alice); await w.join(s1, 3, bob);
await w.buySyndicate(s1, [syndicateTicket(1, { numbers: sorted([...nums.slice(0, 6), miss[0]]), moonball: 1 }, s1)], creator);
// Syndicate 2 never fills: Dave takes 2 of its 5 shares.
const s2 = await w.createSyndicate(1, creator, PRICE, 5, 5, by);
await w.join(s2, 2, dave);
l = w.ledger();
ok(`27 tickets (28 games) are sold, 2 settlement batches of ${G.pureCircuits.batchSize()}`, l.ticketCount.lookup(1n) === 27n && l.gamesSold.lookup(1n) === 27n);

// The join deadline passes: the keeper refunds the unfilled syndicate while the draw still sells.
w.now = Number(by) + 31;
await keeper.tick();
ok(`after its join deadline the keeper refunds the unfilled syndicate's member (Dave ${tn(w.paid(dave))}), during sales`, w.paid(dave) === 2n * PRICE && ran().at(-1) === 'refundSyndicate');

// Sales close: the keeper and the oracle do the rest.
const jackpot = w.ledger().carry;
const mark = w.log.length;
w.now = Number(d1.salesClose) + 31;
const settledUp = await run(async () => {
  const v = await chain.view();
  const d = v.draws.find((x) => x.id === 1n);
  return d.status === 4 && v.entitlements.every((e) => e.paid) && v.memberPayments.every((p) => p.amount === 0n) &&
    v.syndicates.every((sy) => sy.members.every((m) => !(sy.id === s1 && m.refunded === 0n)));
});
l = w.ledger();
const f1 = l.draws.lookup(1n);
ok('the keeper reveals draw 1 and opens draw 2, the oracle answers, and the keeper computes, settles, finalises and pays everything',
   settledUp && f1.status === 4 && l.lastDraw === 2n, log.filter((m) => /ERROR|FAILED/.test(m)).join(' | '));
const order = ran().slice(mark);
const i = (c) => order.indexOf(c);
ok(`in order: ${['requestDraw', 'fulfilDraw', 'computeNumbers', 'settleBatch', 'finaliseDraw', 'payEntitlement', 'paySyndicateMember'].join(', ')}; 2 batches`,
   i('requestDraw') === 0 && i('fulfilDraw') > i('requestDraw') && i('computeNumbers') > i('fulfilDraw') && i('settleBatch') > i('computeNumbers') &&
   i('finaliseDraw') > order.lastIndexOf('settleBatch') && i('payEntitlement') > i('finaliseDraw') && i('paySyndicateMember') > i('payEntitlement') &&
   order.filter((c) => c === 'settleBatch').length === 2, order.join(' '));
ok(`Carol gets the jackpot she played for (${tn(f1.carried)}), fixed before the draw's sales`, w.paid(carol) === f1.prizes[0] && f1.prizes[0] === jackpot && f1.carried === jackpot);
ok(`Dave gets 4 right (${tn(f1.prizes[5])}) on top of his syndicate refund`, w.paid(dave) === 2n * PRICE + f1.prizes[5]);
const sixRight = f1.prizes[2];
const refund1 = (game) => (PRICE * game) / 4n;
ok(`the syndicate's 6-right prize (${tn(sixRight)}) is split by shares, and the game it didn't buy refunded: Alice ${tn(w.paid(alice))}, Bob ${tn(w.paid(bob))}`,
   sixRight > 0n && w.paid(alice) === (sixRight * 1n) / 4n + refund1(1n) && w.paid(bob) === (sixRight * 3n) / 4n + refund1(3n),
   `${w.paid(alice)} ${w.paid(bob)}`);
const v1 = await chain.view();
ok('nothing is left to pay for draw 1: every entitlement, member part and refund', v1.entitlements.every((e) => e.paid) && v1.memberPayments.length === 0 &&
   v1.syndicates.every((sy) => sy.members.every((m) => m.refunded > 0n || sy.id !== s2)));
ok('nothing created or lost', w.conserved());

// ---------------------------------------------------------------- a draw the oracle lets run out of time
const d2 = w.ledger().draws.lookup(2n);
await w.buy([makeTicket(2, { numbers: sorted(miss.slice(0, 7)), moonball: 1 }, erin)], erin);
const s3 = await w.createSyndicate(2, creator, PRICE, 2, 2, d2.salesClose - 600n);
await w.join(s3, 1, alice); await w.join(s3, 1, bob);
await w.buySyndicate(s3, [syndicateTicket(2, { numbers: sorted(miss.slice(1, 8)), moonball: 1 }, s3), syndicateTicket(2, { numbers: sorted(miss.slice(2, 9)), moonball: 1 }, s3)], creator);
const paid = { erin: w.paid(erin), alice: w.paid(alice), bob: w.paid(bob) };
w.now = Number(d2.salesClose) + 31;
await keeper.tick();
ok('the keeper reveals draw 2 and opens draw 3', w.ledger().draws.lookup(2n).status === 1 && w.ledger().lastDraw === 3n);
// The oracle is down: past the draw deadline the keeper voids draw 2 and refunds everyone.
w.now = Number(w.ledger().draws.lookup(2n).drawDeadline) + 31;
const refunded = await run(async () => {
  const v = await chain.view();
  const d = v.draws.find((x) => x.id === 2n);
  return d.status === 5 && d.unrefunded.length === 0 && v.syndicates.find((sy) => sy.id === s3).members.every((m) => m.refunded === PRICE);
}, 20, { oracleOn: false });
ok(`with no answer by the deadline the keeper voids draw 2, refunds Erin's ticket and the syndicate's members in full`,
   refunded && w.paid(erin) - paid.erin === PRICE && w.paid(alice) - paid.alice === PRICE && w.paid(bob) - paid.bob === PRICE,
   `${w.paid(erin) - paid.erin} ${w.paid(alice) - paid.alice} ${w.paid(bob) - paid.bob}`);
// (with the oracle still down, draw 3 ran out of time too, and the keeper opened draw 4)
const last = w.ledger().draws.lookup(w.ledger().lastDraw);
ok('nothing created or lost; the keeper keeps a draw selling', w.conserved() && last.status === 0 && w.ledger().lastDraw >= 3n, `conserved ${w.conserved()}, last ${w.ledger().lastDraw} status ${last.status}`);
const v = await chain.view();
ok("the keeper's view: the draws with their formats, three syndicates, nothing owed", v.draws.length >= 3 && v.draws.every((d) => d.format?.range === range) &&
   v.syndicates.length === 3 && v.memberPayments.length === 0 && !idle(v), JSON.stringify({ draws: v.draws.length, f: v.draws.map((d) => d.format), s: v.syndicates.length, m: v.memberPayments.length }));
// ---------------------------------------------------------------- the site feed carries v2's format, prize tables and Treasury
{
  const L = w.ledger();
  const feed = buildStarfallFeed(v, { network: 'preprod', contract: 'c0ffee', nowSecs: w.now });
  const g = feed.games.starfall;
  const rungOf = (n) => L.ladder[Number(L.draws.lookup(BigInt(n)).rung)];
  const sharesOf = (n) => [...rungOf(n).shares].map(Number);
  const d1f = g.draws.find((d) => d.num === 1);
  ok('the feed: each draw has its format, rung and prize table, read from the contract',
     g.draws.every((d) => d.format?.numbers === Number(L.draws.lookup(BigInt(d.num)).format.range) && d.format.moonball === Number(L.draws.lookup(BigInt(d.num)).format.moonballs)
       && d.rung === Number(L.draws.lookup(BigInt(d.num)).rung) && JSON.stringify(d.allocation_bp) === JSON.stringify(sharesOf(d.num)))
     && d1f.allocation_bp[0] === 5000 && d1f.format.moonball === 1 && (!g.open || (g.open.format?.numbers === range && JSON.stringify(g.open.allocation_bp) === JSON.stringify(sharesOf(g.open.num)))),
     JSON.stringify({ d1: d1f && { format: d1f.format, rung: d1f.rung, a: d1f.allocation_bp }, open: g.open && { format: g.open.format, a: g.open.allocation_bp } }));
  const a = g.adaptive;
  ok(`the feed: the ladder (${a?.ladder.length} rungs from 7 from ${a?.ladder[0]?.numbers}), the rung, the floor and the Treasury, as the contract holds them`,
     a && a.ladder.length === Number(L.rungCount) && a.ladder.every((r, i) => r.numbers === Number(L.ladder[i].numbers) && r.moonball === Number(L.ladder[i].moonball) && r.odds === Number(L.ladder[i].odds)
       && JSON.stringify(r.allocation_bp) === JSON.stringify([...L.ladder[i].shares].map(Number)))
     && a.rung === Number(L.rung) && a.aim === Number(L.aim) && a.floor_star === Number(L.floor) && a.target_draws === Number(L.targetDraws)
     && a.treasury_contract === Buffer.from(L.treasuryAddress.bytes ?? L.treasuryAddress).toString('hex') && a.treasury_contract.length === 64
     && JSON.stringify(g.allocation_bp) === JSON.stringify(g.open ? sharesOf(g.open.num) : a.ladder[a.rung].allocation_bp),
     JSON.stringify(a && { rung: a.rung, aim: a.aim, floor: a.floor_star, t: a.treasury_contract, r0: a.ladder[0] }));
}
if (log.some((m) => /^ERROR|^FAILED/.test(m))) console.log(log.filter((m) => /^ERROR|^FAILED/.test(m)).join('\n'));

console.log(failed ? `\n${failed} FAILED` : '\nall keeper checks passed');
process.exit(failed ? 1 : 0);
