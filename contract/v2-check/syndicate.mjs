// Starfall v2 syndicates end to end, in memory: create, join, the creator's purchase from the
// syndicate's funds, a win split by shares, refunds of what wasn't played (unspent, unfilled, a
// void draw), and the checks that keep the money with the members. Every transaction is checked
// against the chain's rule for unshielded tokens (world.mjs); nothing may be created or lost.
import { World, STAR, address, makeTicket, syndicateTicket } from './world.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`); };
const tn = (star) => `${(Number(star) / 1e6).toLocaleString('en', { maximumFractionDigits: 6 })} tNIGHT`;
const throws = async (f) => { try { await f(); return ''; } catch (e) { return String(e?.message ?? e); } };
const others = (nums, range, want) => { const out = []; for (let x = 1; x <= range && out.length < want; x++) if (!nums.includes(x)) out.push(x); return out; };
const sorted = (a) => [...a].sort((x, y) => x - y);
const alice = address('alice'), bob = address('bob'), carol = address('carol'), dave = address('dave');
const creator = address('syndicate creator'), stranger = address('not the creator');
const PRICE = 1_300_000n;
const tkey = (drawId, index) => BigInt(drawId) * 4294967296n + BigInt(index);

// ---------------------------------------------------------------- a syndicate that wins
{
  const w = await World.create(); await w.bind(); await w.deposit(100_000n * STAR);
  const n = await w.open('s-1');
  const d = w.ledger().draws.lookup(n);
  const by = d.salesClose - 600n;
  // 10 games, 5 shares of 2.6 tNIGHT.
  const sid = await w.createSyndicate(n, creator, 2_600_000n, 5, 10, by);
  ok('a syndicate opens for draw 1: 5 shares of 2.6 tNIGHT for 10 games of 1.3', sid === 1n && w.ledger().syndicates.lookup(1n).status === 0);
  ok('shares x share price must equal games x ticket price', /shares x share price/.test(await throws(() => w.createSyndicate(n, creator, 2_500_000n, 5, 10, by))));
  ok('members must join before sales close', /before sales close/.test(await throws(() => w.createSyndicate(n, creator, 2_600_000n, 5, 10, d.salesClose + 1n))));
  ok('the creator can\'t buy before it is funded', /not funded/.test(await throws(() => w.buySyndicate(sid, [syndicateTicket(1, { numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 1 }, sid)], creator))));
  const ia = await w.join(sid, 2, alice);
  const ib = await w.join(sid, 3, bob);
  const sy = w.ledger().syndicates.lookup(sid);
  ok('Alice takes 2 shares and Bob 3: the syndicate is funded with 13 tNIGHT, held by the game', ia === 0n && ib === 1n && sy.status === 1 && sy.sold === 5n && w.bal[w.gAddr] === 66_000n * STAR + 13n * STAR && w.conserved());
  ok('no more shares once it is funded', /already funded/.test(await throws(() => w.join(sid, 1, carol))));

  const nums = await w.peek(n, 's-1');
  const miss = others(nums.main, 22, 15);
  const win7 = syndicateTicket(1, { numbers: nums.main, moonball: 1 }, sid);
  const win4 = syndicateTicket(1, { numbers: sorted([...nums.main.slice(0, 4), ...miss.slice(0, 3)]), moonball: 1 }, sid);
  ok('only the creator buys its games', /not the syndicate's creator/.test(await throws(() => w.buySyndicate(sid, [win7], stranger))));
  ok('a syndicate ticket must name the syndicate as its only payee', /invalid syndicate ticket/.test(await throws(() => w.buySyndicate(sid, [makeTicket(1, { numbers: nums.main, moonball: 1 }, creator)], creator))));
  const big = syndicateTicket(1, { numbers: sorted(miss.slice(0, 9)), moonball: 1 }, sid); // a System 9: 36 games
  ok('it can\'t buy more games than it funded (a System 9 is 36)', /more games than the syndicate funded/.test(await throws(() => w.buySyndicate(sid, [big], creator))));
  const before = w.bal[w.gAddr];
  const first = await w.buySyndicate(sid, [win7, win4], creator);
  const l1 = w.ledger();
  ok('the creator buys 2 games from the syndicate\'s funds: nobody pays anything in, the draw sells 2 games, the tickets have no refund address',
     first === 0n && w.bal[w.gAddr] === before && l1.gamesSold.lookup(n) === 2n && l1.syndicates.lookup(sid).bought === 2n &&
     Buffer.from(l1.tickets.lookup(tkey(n, 0)).refundTo.bytes).every((b) => b === 0) && w.conserved());
  await w.buy([makeTicket(1, { numbers: sorted([...nums.main.slice(0, 4), ...miss.slice(3, 6)]), moonball: 1 }, carol)]); // Carol: 4 right too
  ok('nothing is refunded while the syndicate can still buy', /still filling or buying/.test(await throws(() => w.run('refundSyndicate', [sid, 0n]))));

  const jackpot = w.ledger().carry;
  await w.draw(n, 's-1', 's-2'); await w.settle(n); const f = await w.finalise(n);
  const paidBefore = w.totalPaidOut();
  await w.payAll(n);
  const l = w.ledger();
  const pots = [...l.syndicatePots];
  const potTotal = pots.reduce((t, [, v]) => t + v[0] + v[1] + v[2], 0n);
  ok(`paying the entitlements keeps the syndicate's prizes for its members (${tn(potTotal)}: the jackpot and a 4-right prize) and pays Carol hers`,
     pots.length === 2 && potTotal === f.carried + f.prizes[5] && f.carried === jackpot && w.paid(carol) === f.prizes[5] && w.totalPaidOut() - paidBefore === f.prizes[5], `${pots.length} pots, ${potTotal}`);
  let toAlice = 0n, toBob = 0n;
  for (const [eid] of pots) {
    toAlice += await w.run('paySyndicateMember', [eid, 0n, 0n]);
    toBob += await w.run('paySyndicateMember', [eid, 0n, 1n]);
  }
  ok(`each member gets their shares' part of every prize: Alice 2/5 (${tn(toAlice)}), Bob 3/5 (${tn(toBob)}); under 5 STAR of rounding stays`,
     toAlice === (jackpot * 2n) / 5n + (f.prizes[5] * 2n) / 5n && toBob === (jackpot * 3n) / 5n + (f.prizes[5] * 3n) / 5n && potTotal - toAlice - toBob < 5n && w.paid(alice) === toAlice && w.paid(bob) === toBob);
  const eid = pots[0][0];
  ok('a member is paid once from each prize', /already paid/.test(await throws(() => w.run('paySyndicateMember', [eid, 0n, 0n]))));
  ok('nobody else can be paid from it', /unknown member/.test(await throws(() => w.run('paySyndicateMember', [eid, 0n, 2n]))));
  ok('a payee that isn\'t a syndicate has nothing kept', /nothing owed/.test(await throws(() => w.run('paySyndicateMember', [eid, 1n, 0n]))));
  const ra = await w.run('refundSyndicate', [sid, 0n]);
  const rb = await w.run('refundSyndicate', [sid, 1n]);
  ok(`after sales close the 8 games it didn't buy are refunded by shares: Alice ${tn(ra)}, Bob ${tn(rb)}`, ra === (8n * PRICE * 2n) / 5n && rb === (8n * PRICE * 3n) / 5n);
  ok('and only once', /nothing more to refund/.test(await throws(() => w.run('refundSyndicate', [sid, 0n]))));
  ok('nothing created or lost; the game holds the next jackpot and under 5 STAR of rounding', w.conserved() && w.bal[w.gAddr] - w.ledger().carry < 5n, `${w.bal[w.gAddr] - w.ledger().carry}`);
}

// ---------------------------------------------------------------- a syndicate that never fills
{
  const w = await World.create(); await w.bind(); await w.deposit(100_000n * STAR);
  const n = await w.open('u-1');
  const d = w.ledger().draws.lookup(n);
  const sid = await w.createSyndicate(n, creator, 1_300_000n, 4, 4, d.salesClose - 1200n);
  await w.join(sid, 1, alice);
  await w.join(sid, 2, bob);
  ok('nothing is refunded before the join deadline', /still filling or buying/.test(await throws(() => w.run('refundSyndicate', [sid, 0n]))));
  w.advance(Number(d.salesClose - 1200n) - w.now + 1);
  ok('nobody joins after the join deadline', /join deadline has passed/.test(await throws(() => w.join(sid, 1, carol))));
  ok('an unfilled syndicate buys nothing', /not funded/.test(await throws(() => w.buySyndicate(sid, [syndicateTicket(1, { numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 1 }, sid)], creator))));
  const ra = await w.run('refundSyndicate', [sid, 0n]);
  const rb = await w.run('refundSyndicate', [sid, 1n]);
  ok(`after its join deadline every member gets back exactly what they paid: Alice ${tn(ra)}, Bob ${tn(rb)}`, ra === 1_300_000n && rb === 2_600_000n && w.paid(alice) === ra && w.paid(bob) === rb && w.conserved());
}

// ---------------------------------------------------------------- a void draw: unspent first, then the rest
{
  const w = await World.create(); await w.bind(); await w.deposit(100_000n * STAR);
  const n = await w.open('v-1');
  const d = w.ledger().draws.lookup(n);
  const sid = await w.createSyndicate(n, creator, 3_900_000n, 2, 6, d.salesClose - 600n);
  await w.join(sid, 1, alice); await w.join(sid, 1, dave);
  await w.buySyndicate(sid, [syndicateTicket(1, { numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 1 }, sid),
                             syndicateTicket(1, { numbers: [2, 3, 4, 5, 6, 7, 8], moonball: 1 }, sid, [{ numbers: [3, 4, 5, 6, 7, 8, 9], moonball: 1 }])], creator);
  ok('a syndicate funded for 6 games buys 3 (a ticket with a line is 2)', w.ledger().syndicates.lookup(sid).bought === 3n);
  w.advance(Number(d.salesClose) - w.now + 1);
  const unspent = await w.run('refundSyndicate', [sid, 0n]);
  ok(`after sales close Alice gets her half of the 3 unplayed games: ${tn(unspent)}`, unspent === (3n * PRICE) / 2n);
  w.advance(Number(d.revealDeadline) - w.now + 1);
  await w.run('voidDraw', [n]);
  const out0 = w.totalPaidOut();
  await w.run('refundTicket', [n, 0n]); await w.run('refundTicket', [n, 1n]);
  ok('the draw is void: refunding the syndicate\'s tickets sends nothing (they have no refund address), the money stays for the members', w.totalPaidOut() === out0 && w.ledger().tickets.lookup(tkey(n, 1)).refunded);
  const rest = await w.run('refundSyndicate', [sid, 0n]);
  const daveAll = await w.run('refundSyndicate', [sid, 1n]);
  ok(`then Alice gets the rest of her share (${tn(rest)}) and Dave all of his (${tn(daveAll)}): each paid 3.9 and gets 3.9 back`,
     unspent + rest === 3_900_000n && daveAll === 3_900_000n && w.paid(alice) === 3_900_000n && w.paid(dave) === 3_900_000n);
  ok('nothing created or lost', w.conserved());
}

// ---------------------------------------------------------------- not in a final draw
{
  const w = await World.create(); await w.bind(); await w.deposit(100_000n * STAR);
  const n = await w.open('f-1', 3600, true);
  const d = w.ledger().draws.lookup(n);
  ok('no syndicate opens in a final draw', /final draw/.test(await throws(() => w.createSyndicate(n, creator, 1_300_000n, 1, 1, d.salesClose - 600n))));
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
