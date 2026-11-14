// Starfall v2 and its Treasury running together in memory (compact-runtime 0.21), with the
// cross-contract call, a controllable clock and a small ledger for unshielded tNIGHT:
// balances per contract, what users paid in and were paid, and the rule the chain applies
// to a transaction (a contract only gains tokens it receives in a call of its own, and
// every payment to a contract must be received by it in the same transaction).
import { createHash, webcrypto } from 'node:crypto';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as G from './out/contract/index.js';
import * as T from './out-treasury/contract/index.js';

const require = createRequire(import.meta.url);
const ocrt = await import(require.resolve('@midnightntwrk/onchain-runtime-v4'));

export const STAR = 1_000_000n;
const COIN = '0'.repeat(64);
const NATIVE = { tag: 'unshielded', raw: '0'.repeat(64) };
const BLOCK = '11'.repeat(32);
const hex = (b) => Buffer.from(b).toString('hex');
const comb = (n, k) => { let r = 1n; for (let i = 0n; i < BigInt(k); i++) r = (r * (BigInt(n) - i)) / (i + 1n); return r; };

// Division 1 takes half the pool (Jack, 14 Nov: bigger jackpots); the other divisions keep their proportions.
export const FOUR = [5000n, 0n, 752n, 0n, 1241n, 3007n, 0n, 0n, 0n];            // no Moonball: 7, 6, 5, 4 right
export const NINE = [5000n, 139n, 173n, 150n, 113n, 707n, 549n, 1165n, 2004n];  // Powerball's nine divisions, scaled
// The four Moonball rungs below today's format have their own tables: Powerball's split there would
// pay less than a game for 2 right + Moonball, and less for 5 + Moonball than for 5. Each prize is
// about (1 / chance)^0.6, scaled to the other half of the pool; a division whose prize would come
// to under three games pays nothing; where two divisions are equally likely (Moonball 1-2), the
// one with the Moonball pays 20% more. Divisions: 7+MB, 7, 6+MB, 6, 5+MB, 4+MB, 5, 3+MB, 2+MB.
export const MOONBALL_TABLES = {
  '30/2':  [5000n, 30n, 272n, 227n, 1101n, 2452n, 918n, 0n, 0n],
  '30/5':  [5000n, 25n, 110n, 191n, 445n, 1189n, 775n, 2265n, 0n],
  '35/5':  [5000n, 19n, 92n, 160n, 404n, 1175n, 703n, 2447n, 0n],
  '35/10': [5000n, 15n, 51n, 122n, 223n, 648n, 536n, 1348n, 2057n],
};
export const mkRung = (n, m = 1) => ({
  numbers: BigInt(n), moonball: BigInt(m), q: BigInt(Math.floor(65536 / n)), qm: BigInt(Math.floor(65536 / m)),
  odds: comb(n, 7) * BigInt(m), pick5: comb(n - 5, 2), shares: m === 1 ? FOUR : (MOONBALL_TABLES[`${n}/${m}`] ?? NINE),
});
export const LADDER = [[20, 1], [22, 1], [25, 1], [27, 1], [30, 1], [30, 2], [30, 5], [35, 5], [35, 10], [35, 20], [40, 20], [45, 20]].map(([n, m]) => mkRung(n, m));
export const formatOf = (r) => ({ range: r.numbers, moonballs: r.moonball, pick5: r.pick5 });

const le16 = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
export const address = (label) => new Uint8Array(createHash('sha256').update(label).digest());
const NO_LINE = { numbers: Array(7).fill(0n), moonball: 0n };
const NO_PAYEE = { lo: 0n, hi: 0n, share: 0n };
export const emptyTicket = (drawId) => ({ drawId, entry: { kind: 0n, count: 0n, numbers: Array(12).fill(0n), moonball: 0n, sweep: false }, lines: Array(11).fill(NO_LINE), payees: [NO_PAYEE, NO_PAYEE, NO_PAYEE], salt: 0n });
const randomScalar = () => BigInt('0x' + hex(webcrypto.getRandomValues(new Uint8Array(31))));
/** A ticket: an entry ({ numbers, moonball, pick?, sweep? }), extra standard lines, paid to one address. */
export const makeTicket = (drawId, entry, payTo, lines = []) => ({
  drawId: BigInt(drawId),
  entry: { kind: entry.pick ? 1n : 0n, count: BigInt(entry.numbers.length), numbers: [...entry.numbers, ...Array(12 - entry.numbers.length).fill(0)].map(BigInt), moonball: BigInt(entry.sweep ? 0 : entry.moonball), sweep: !!entry.sweep },
  lines: [...lines.map((l) => ({ numbers: l.numbers.map(BigInt), moonball: BigInt(l.moonball) })), ...Array(11 - lines.length).fill(NO_LINE)],
  payees: [{ lo: le16(payTo.subarray(0, 16)), hi: le16(payTo.subarray(16, 32)), share: 10000n }, NO_PAYEE, NO_PAYEE],
  salt: randomScalar(),
});

const gameWitnesses = {
  oracleSecretKey: ({ privateState }) => [privateState, privateState.oracleSecretKey],
  organiserSecret: ({ privateState }) => [privateState, privateState.organiserSecret],
  newTickets: ({ privateState }) => { const ts = [...privateState.pendingTickets]; const max = Number(G.pureCircuits.maxTickets()); while (ts.length < max) ts.push(emptyTicket(ts[0].drawId)); return [privateState, ts]; },
  sealingRandomnessFor: ({ privateState }) => [privateState, Array.from({ length: Number(G.pureCircuits.maxTickets()) }, randomScalar)],
  settlementBatch: ({ privateState }, drawId, first) => { const size = Number(G.pureCircuits.batchSize()); const out = []; for (let i = 0; i < size; i++) out.push(privateState.settling.tickets[Number(first) + i] ?? emptyTicket(drawId)); return [privateState, out]; },
  splitByte: ({ privateState }, x) => [privateState, [x >> 4n, x & 15n]],
  divMod16: ({ privateState }, v, m) => [privateState, [v / m, v % m]],
  sortSeven: ({ privateState }, v) => [privateState, [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))],
  divModWide: ({ privateState }, n, d) => [privateState, [n / d, n % d]],
};
const treasuryWitnesses = { binderSecret: ({ privateState }) => [privateState, privateState.binderSecret] };

const sum = (m) => { let t = 0n; for (const [k, v] of m ?? []) if (k.tag === 'unshielded' && k.raw === NATIVE.raw) t += BigInt(v); return t; };

export class World {
  constructor(opts = {}) { this.opts = opts; }

  static async create(opts = {}) {
    const w = new World(opts);
    w.now = 1_800_000_000;
    w.game = new G.Contract(gameWitnesses);
    w.treasury = new T.Contract(treasuryWitnesses);
    w.gAddr = rt.sampleContractAddress();
    w.tAddr = rt.sampleContractAddress();
    w.oracleSk = 12345678901234567890n; w.settlementSk = 98765432109876543210n;
    w.organiserSecret = address('organiser'); w.backupSecret = address('backup'); w.binderSecret = address('binder');
    w.operator = address('operator');
    w.paidIn = 0n; w.paidOut = new Map(); w.bal = { [w.gAddr]: 0n, [w.tAddr]: 0n }; w.log = [];
    // The Treasury first (the game needs its address), with its verifier keys as a deployment has.
    const t0 = await w.treasury.initialState(rt.createConstructorContext({}, COIN), T.pureCircuits.binderCommitmentOf(w.binderSecret));
    w.tState = t0.currentContractState;
    for (const name of ['bind', 'deposit', 'release']) {
      const op = new ocrt.ContractOperation();
      op.verifierKey = readFileSync(new URL(`./out-treasury/keys/${name}.verifier`, import.meta.url));
      w.tState.setOperation(name, op);
    }
    const tBytes = { bytes: rt.encodeContractAddress(w.tAddr) };
    const o = { fee: 200_000n, price: 1_300_000n, treasuryFee: 100_000n, floorPer: 200_000n, ceiling: 710_000n, floor0: 34_000n * STAR, startRung: 1n, target: 4n, every: 4n, rolloverCap: 0n, finalNotice: 600n, ...opts };
    const g0 = await w.game.initialState(rt.createConstructorContext({}, COIN),
      G.pureCircuits.settlementPublicKey(w.oracleSk), G.pureCircuits.organiserCommitmentOf(w.organiserSecret), G.pureCircuits.organiserCommitmentOf(w.backupSecret),
      G.pureCircuits.settlementPublicKey(w.settlementSk), { bytes: w.operator }, o.fee, o.price, 600n, 2_592_000n, 3600n, 3600n, 86_400n, 10_000n, o.finalNotice, o.rolloverCap,
      o.ladder ?? LADDER, BigInt((o.ladder ?? LADDER).length), o.startRung, o.target, o.every, o.floor0, o.floorPer, o.ceiling, tBytes, tBytes, o.treasuryFee);
    w.gState = g0.currentContractState;
    w.o = o;
    await w.run('acceptOracleKey', [], { oracleSecretKey: w.oracleSk });
    return w;
  }

  ledger() { return G.ledger(this.gState.data); }
  tLedger() { return T.ledger(this.tState.data); }
  advance(s) { this.now += s; }
  snapshot() { return { g: this.gState.serialize(), t: this.tState.serialize(), now: this.now, paidIn: this.paidIn, paidOut: new Map(this.paidOut), bal: { ...this.bal } }; }
  restore(s) { this.gState = ocrt.ContractState.deserialize(s.g); this.tState = ocrt.ContractState.deserialize(s.t); this.now = s.now; this.paidIn = s.paidIn; this.paidOut = new Map(s.paidOut); this.bal = { ...s.bal }; }

  /** Run one circuit as one transaction. `funding`: tNIGHT (STAR) the sender puts in from its own wallet. */
  async run(circuit, args, privateState = {}, { on = 'game', funding = 0n } = {}) {
    const root = on === 'game' ? this.gAddr : this.tAddr;
    for (const [a, s] of [[this.gAddr, this.gState], [this.tAddr, this.tState]]) s.balance = new Map([[NATIVE, this.bal[a]]]);
    const ctx = rt.createCircuitContext({
      circuitId: circuit, contractAddress: root, coinPublicKeyOrZswapState: COIN,
      contractState: on === 'game' ? this.gState : this.tState, privateState, time: this.now, parentBlockHash: BLOCK,
      crossContract: {
        stateProvider: { getContractState: async (_h, a) => (a === this.tAddr ? this.tState : a === this.gAddr ? this.gState : undefined) },
        moduleProvider: { resolve: (a) => (a === this.tAddr ? async () => T : a === this.gAddr ? async () => G : undefined) },
      },
    });
    const contract = on === 'game' ? this.game : this.treasury;
    const out = await contract.impureCircuits[circuit](ctx, ...args);
    // The transaction's unshielded effects, call by call.
    const received = {}, sent = {}, owed = {}; const toUsers = [];
    for (const call of out.context.callProofDataTrace) {
      const fx = call.finalQueryContext.effects; const a = call.contractAddress;
      received[a] = (received[a] ?? 0n) + sum(fx.unshieldedInputs);
      sent[a] = (sent[a] ?? 0n) + sum(fx.unshieldedOutputs);
      let claimed = 0n;
      for (const [[token, to], amount] of fx.claimedUnshieldedSpends ?? []) {
        if (token.tag !== 'unshielded' || token.raw !== NATIVE.raw) throw new Error('unexpected token');
        claimed += BigInt(amount);
        if (to.tag === 'contract') owed[to.address] = (owed[to.address] ?? 0n) + BigInt(amount);
        else toUsers.push([to.address, BigInt(amount)]);
      }
      if (claimed !== sum(fx.unshieldedOutputs)) throw new Error(`${circuit}: ${a} sends ${sum(fx.unshieldedOutputs)} but names recipients for ${claimed}`);
    }
    // The chain's rule: what contracts receive is exactly what contracts sent them plus what the sender funds.
    let fromContracts = 0n, taken = 0n;
    for (const a of Object.keys({ ...received, ...owed })) {
      if ((owed[a] ?? 0n) > (received[a] ?? 0n)) throw new Error(`${circuit}: ${owed[a]} STAR is sent to contract ${a === this.gAddr ? 'game' : 'treasury'} but it only receives ${received[a] ?? 0n}`);
      fromContracts += owed[a] ?? 0n; taken += received[a] ?? 0n;
    }
    if (taken - fromContracts !== funding) throw new Error(`${circuit}: contracts take ${taken - fromContracts} STAR from the sender, expected ${funding}`);
    for (const a of Object.keys({ ...received, ...sent })) {
      this.bal[a] = (this.bal[a] ?? 0n) + (received[a] ?? 0n) - (sent[a] ?? 0n);
      if (this.bal[a] < 0n) throw new Error(`${circuit}: contract ${a} would go below zero`);
    }
    this.paidIn += funding;
    for (const [to, amount] of toUsers) this.paidOut.set(to, (this.paidOut.get(to) ?? 0n) + amount);
    // Commit the new states.
    const q = out.context.queryContexts;
    if (q[this.gAddr]) this.gState.data = q[this.gAddr].state;
    if (q[this.tAddr]) this.tState.data = q[this.tAddr].state;
    this.log.push({ circuit, calls: out.context.callProofDataTrace.map((c) => `${c.contractAddress === this.gAddr ? 'game' : 'treasury'}.${c.circuitId}`) });
    return out.result;
  }

  paid(to) { return this.paidOut.get(hex(to)) ?? this.paidOut.get(to) ?? 0n; }
  totalPaidOut() { let t = 0n; for (const v of this.paidOut.values()) t += v; return t; }
  /** Nothing is created or lost: what users paid in is what the contracts hold plus what was paid out. */
  conserved() { return this.paidIn === this.bal[this.gAddr] + this.bal[this.tAddr] + this.totalPaidOut(); }

  seedCommitment(seed) { return new Uint8Array(createHash('sha256').update(hex(seed)).digest()); }
  next(seedLabel, sales = 3600, final = false) { return { is_some: true, value: { salesClose: BigInt(this.now + sales), seedCommitment: this.seedCommitment(address(seedLabel)), final } }; }
  async bind() { return this.run('bind', [{ bytes: rt.encodeContractAddress(this.gAddr) }], { binderSecret: this.binderSecret }, { on: 'treasury' }); }
  async deposit(amount) { return this.run('deposit', [amount], {}, { on: 'treasury', funding: amount }); }
  async open(seedLabel, sales = 3600, final = false) {
    await this.run('requestDraw', [0n, new Uint8Array(32), this.next(seedLabel, sales, final)], { organiserSecret: this.organiserSecret });
    return this.ledger().lastDraw;
  }
  async buy(tickets, refundTo = address('refund')) {
    const d = this.ledger().draws.lookup(tickets[0].drawId);
    const games = tickets.reduce((n, t) => n + G.pureCircuits.ticketGames(t, d.format), 0n);
    await this.run('buyTickets', [BigInt(tickets.length), { bytes: refundTo }], { pendingTickets: tickets }, { funding: games * this.o.price });
    return games;
  }
  /** Close sales on draw n, reveal its seed (opening the next draw if asked), answer and compute the numbers. */
  async draw(n, seedLabel, nextSeedLabel, { final = false, sales = 3600 } = {}) {
    const d = this.ledger().draws.lookup(n);
    if (BigInt(this.now) < d.salesClose) this.now = Number(d.salesClose) + 1;
    const nx = nextSeedLabel ? this.next(nextSeedLabel, sales, final) : { is_some: false, value: { salesClose: 0n, seedCommitment: new Uint8Array(32), final: false } };
    await this.run('requestDraw', [n, address(seedLabel), nx], { organiserSecret: this.organiserSecret });
    await this.run('fulfilDraw', [n], { oracleSecretKey: this.oracleSk });
    return this.run('computeNumbers', [n, BigInt(this.now)]);
  }
  /** The numbers draw n will have, found on a copy (they don't depend on the tickets). */
  async peek(n, seedLabel) { const s = this.snapshot(); const nums = await this.draw(n, seedLabel, undefined); this.restore(s); return { main: nums.main.map(Number), moonball: Number(nums.moonball) }; }
  async settle(n) {
    const l = this.ledger(); const count = l.ticketCount.lookup(n); const tickets = [];
    for (let i = 0n; i < count; i++) tickets.push(G.pureCircuits.openTicket(this.settlementSk, n, l.tickets.lookup(G.pureCircuits.ticketKey(n, i)).cipher));
    while (this.ledger().progress.lookup(n).next < count) await this.run('settleBatch', [n], { settling: { drawId: n, tickets } });
  }
  async finalise(n) { await this.run('finaliseDraw', [n]); return this.ledger().draws.lookup(n); }
  async payAll(n) { let k = 0; for (const [id, e] of this.ledger().entitlements) if (e.drawId === n && !e.paid) { await this.run('payEntitlement', [id]); k++; } return k; }
}
