// The rehearsal player (cli/src/starfall-v2-player.ts) against both contracts in memory: its
// planning, its tickets (QuickPicks in the draw's format, paid to it or to its syndicate) and its
// syndicate (created, one share per member paid to the member's address, its games bought, one
// fewer than funded in odd draws), then the real keeper settling, paying every prize and member
// part, and refunding the unspent game. Needs the CLI built (npm run build).
import * as rt from '@midnight-ntwrk/compact-runtime';
import { DerivedSeeds, DrawOracle, every, StarfallKeeper } from '@lunardraw/keeper';
import { starfallV2ViewOf } from '../../cli/dist/starfall-v2.js';
import { newPlayerState, nextStep, stepDone, ticketsFor } from '../../cli/dist/starfall-v2-player.js';
import * as G from './out/contract/index.js';
import { World, STAR, address } from './world.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + detail}`); };
const PRICE = 1_300_000n;
const me = address('rehearsal player');
const members = [address('pixel'), address('orbit'), address('nova')];
const opts = { games: 4, members, syndicateGames: 3 };

const w = await World.create(); await w.bind(); await w.deposit(100_000n * STAR);
const chainAddr = rt.encodeContractAddress(w.gAddr);
const NONE = { is_some: false, value: { salesClose: 0n, seedCommitment: new Uint8Array(32), final: false } };
const chain = {
  addressBytes: chainAddr,
  view: async () => starfallV2ViewOf(G, w.ledger()),
  now: async () => w.now,
  storedTickets: async (n) => { const l = w.ledger(); const c = l.ticketCount.member(n) ? l.ticketCount.lookup(n) : 0n; const out = []; for (let i = 0n; i < c; i++) { const r = l.tickets.lookup(G.pureCircuits.ticketKey(n, i)); out.push({ commitment: r.commitment, cipher: r.cipher }); } return out; },
  openDraw: async (salesClose, seedCommitment, final = false) => { await w.run('requestDraw', [0n, new Uint8Array(32), { is_some: true, value: { salesClose, seedCommitment, final } }], { organiserSecret: w.organiserSecret }); },
  requestDraw: async (n, seed, next) => { await w.run('requestDraw', [n, seed, next ? { is_some: true, value: next } : NONE], { organiserSecret: w.organiserSecret }); },
  fulfilDraw: async (n) => { await w.run('fulfilDraw', [n], { oracleSecretKey: w.oracleSk }); },
  computeNumbers: async (n) => { await w.run('computeNumbers', [n, BigInt(w.now)]); },
  settleBatch: async (n, tickets) => { await w.run('settleBatch', [n], { settling: { drawId: n, tickets } }); },
  finaliseDraw: async (n) => { await w.run('finaliseDraw', [n]); },
  payEntitlement: async (id) => { await w.run('payEntitlement', [id]); },
  voidDraw: async (n) => { await w.run('voidDraw', [n]); },
  refundTicket: async (n, i) => { await w.run('refundTicket', [n, i]); },
  paySyndicateMember: async (id, payee, member) => { await w.run('paySyndicateMember', [id, BigInt(payee), member]); },
  refundSyndicate: async (s, m) => { await w.run('refundSyndicate', [s, m]); },
};
const clock = () => w.now * 1000;
const keeper = new StarfallKeeper({ chain, seeds: new DerivedSeeds(w.organiserSecret, chainAddr), settlementSecret: w.settlementSk, pure: G.pureCircuits, schedule: every(3600), clock, backoffMs: 1000 });
const oracle = new DrawOracle({ chain, publicKey: G.pureCircuits.settlementPublicKey(w.oracleSk), clock, newRequestDelayMs: 0 });

// The player's step as the live command takes it (cli/src/starfall-v2-commands.ts), as one transaction.
const state = newPlayerState('in memory');
const secret = Buffer.from(state.syndicateSecret, 'hex');
const play = async () => {
  const view = starfallV2ViewOf(G, w.ledger());
  const step = nextStep(view, w.now, state, opts);
  if (!step) return null;
  const d = view.draws.find((x) => x.id === step.draw);
  const tickets = ticketsFor(G, step, d.format, me);
  let id;
  if (step.kind === 'buy') {
    const games = tickets.reduce((n, t) => n + G.pureCircuits.ticketGames(t, w.ledger().draws.lookup(step.draw).format), 0n);
    await w.run('buyTickets', [BigInt(tickets.length), { bytes: me }], { pendingTickets: tickets }, { funding: games * PRICE });
  } else if (step.kind === 'create') {
    id = await w.run('createSyndicate', [step.draw, G.pureCircuits.syndicateCommitmentOf(secret), step.sharePrice, BigInt(step.shares), BigInt(step.games), step.joinDeadline]);
  } else if (step.kind === 'join') {
    await w.run('joinSyndicate', [step.syndicate, 1n, { bytes: members[step.member] }], {}, { funding: step.kind === 'join' ? (PRICE * 3n) / 3n : 0n });
  } else {
    await w.run('buySyndicateTickets', [step.syndicate, BigInt(tickets.length)], { pendingTickets: tickets, syndicateSecret: secret });
  }
  stepDone(state, step, id);
  return step;
};
const playAll = async () => { const done = []; for (let s; (s = await play()); ) done.push(s.kind); return done; };
const runUntil = async (done, max = 80) => { for (let i = 0; i < max; i++) { await keeper.tick(); await oracle.tick(); if (await done()) return true; w.advance(60); } return false; };

// Draw 1 (odd): the syndicate buys 2 of its 3 games.
await keeper.tick();
let steps = await playAll();
ok(`draw 1: the player creates its syndicate, takes a share for each of 3 members, buys its games, then its own ticket: ${steps.join(', ')}`,
   steps.join() === 'create,join,join,join,buySyndicate,buy');
let l = w.ledger();
const sy1 = l.syndicates.lookup(1n);
ok(`the syndicate is funded with 3 shares of 1.3 tNIGHT and bought 2 games (one fewer, in an odd draw); the player's own ticket has 4 QuickPicks on 7 from ${l.draws.lookup(1n).format.range}`,
   sy1.status === 1 && sy1.sold === 3n && sy1.sharePrice === PRICE && sy1.bought === 2n && l.gamesSold.lookup(1n) === 6n && l.ticketCount.lookup(1n) === 2n);
ok('nothing more to do in draw 1 once it has played', (await playAll()).length === 0);

const before = Object.fromEntries(['pixel', 'orbit', 'nova', 'rehearsal player'].map((n) => [n, w.paid(address(n))]));
w.now = Number(l.draws.lookup(1n).salesClose) + 31;
const finished = await runUntil(async () => {
  const v = await chain.view();
  return v.draws.find((d) => d.id === 1n).status === 4 && v.entitlements.every((e) => e.paid) && v.memberPayments.length === 0 &&
    v.syndicates.every((s) => s.members.every((m) => m.refunded > 0n));
});
l = w.ledger();
const d1 = l.draws.lookup(1n);
ok(`the keeper settles draw 1 (numbers ${d1.numbers.join(' ')}), pays every prize and member part, and refunds the unspent game`, finished);
const refund = PRICE / 3n;
const got = (n) => w.paid(address(n)) - before[n];
ok(`each member gets back a third of the unspent game (${Number(refund) / 1e6} tNIGHT) plus a third of any syndicate prize: pixel ${Number(got('pixel')) / 1e6}, orbit ${Number(got('orbit')) / 1e6}, nova ${Number(got('nova')) / 1e6}`,
   got('pixel') >= refund && got('pixel') === got('orbit') && got('orbit') === got('nova'));
ok('nothing created or lost', w.conserved());

// Draw 2 (even): all 3 games.
steps = await playAll();
l = w.ledger();
ok(`draw 2: a new syndicate, all 3 of its games bought (an even draw), and the player's own ticket: ${steps.join(', ')}`,
   steps.join() === 'create,join,join,join,buySyndicate,buy' && l.syndicates.lookup(2n).bought === 3n && l.gamesSold.lookup(2n) === 7n);
w.now = Number(l.draws.lookup(2n).salesClose) + 31;
ok('the keeper finishes draw 2 too, with nothing left to refund', await runUntil(async () => {
  const v = await chain.view();
  return v.draws.find((d) => d.id === 2n).status === 4 && v.entitlements.every((e) => e.paid) && v.memberPayments.length === 0;
}) && (await chain.view()).syndicates.find((s) => s.id === 2n).members.every((m) => m.refunded === 0n) && w.conserved());

console.log(failed ? `\n${failed} FAILED` : '\nall player checks passed');
process.exit(failed ? 1 : 0);
