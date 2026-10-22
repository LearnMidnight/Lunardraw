import {
  type ChargedState,
  type CircuitContext,
  type ContractState,
  createCircuitContext,
  createConstructorContext,
  encodeContractAddress,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { oraclePublicKey } from '@nightcast/contract';
import {
  Contract,
  type Ledger,
  type NextDraw,
  type Numbers,
  type TicketPreimage,
  ledger,
  pureCircuits,
} from './managed/settlement/contract/index.js';
import { type SettlementPrivateState, settlementWitnesses } from './settlement-witnesses.js';

const COIN_PUBLIC_KEY = '0'.repeat(64);

export type SettlementSimulatorOptions = {
  oracleSecretKey: bigint;
  organiserSecret: Uint8Array;
  /** Secret of the settlement key the tickets are encrypted to. */
  settlementSecret: bigint;
  /** Where operator fees go (32-byte unshielded address). */
  operator: Uint8Array;
  /** Operator fee in basis points of sales (default 200 = 2%). */
  feeShare?: bigint;
  /** Price of one ticket (one line) in STAR (default 1 tNIGHT). */
  ticketPrice?: bigint;
  minSales?: bigint;
  maxSales?: bigint;
  revealWindow?: bigint;
  drawWindow?: bigint;
  settleWindow?: bigint;
  /** Starting block time, seconds since the epoch. */
  now?: number;
  /** Activate the oracle key right after deployment (default true). */
  acceptKey?: boolean;
};

type Result<R> = { result: R; context: CircuitContext<SettlementPrivateState> };

/** One unshielded payment a circuit made: recipient (hex) and amount in STAR. */
export type Payment = { to: string; amount: bigint };

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** A compact description of an unknown value, for error messages. */
const describe = (x: unknown): string =>
  JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? `0x${hex(v)}` : v));

/**
 * Pull the unshielded payments out of a circuit's effects, if the runtime
 * exposes them. Returns undefined if it doesn't (the ledger is then the only
 * record, and the tests check that instead).
 */
const paymentsOf = (context: unknown): Payment[] | undefined => {
  const effects = (context as { currentQueryContext?: { effects?: Record<string, unknown> } }).currentQueryContext?.effects;
  if (effects === undefined || effects === null) return undefined;
  // Payments are kept per (token, recipient) in the claimed unshielded spends;
  // the plain unshielded outputs are totals per token only.
  const keys = Object.keys(effects);
  const key =
    keys.find((k) => /claimed/i.test(k) && /unshielded/i.test(k) && /spend/i.test(k)) ??
    keys.find((k) => /unshielded/i.test(k) && /spend/i.test(k) && !/input/i.test(k));
  if (key === undefined) return undefined;
  const entries = effects[key] as Map<unknown, bigint> | Record<string, bigint> | undefined;
  if (entries === undefined) return undefined;
  const pairs: [unknown, bigint][] = entries instanceof Map ? [...entries.entries()] : Object.entries(entries);
  const out: Payment[] = [];
  for (const [k, amount] of pairs) {
    // The key is (token type, recipient); the recipient is the last 32-byte
    // value in it, as bytes or hex.
    const found: string[] = [];
    const walk = (x: unknown): void => {
      if (x instanceof Uint8Array) {
        if (x.length === 32) found.push(hex(x));
      } else if (typeof x === 'string') {
        if (/^[0-9a-f]{64}$/i.test(x)) found.push(x.toLowerCase());
      } else if (Array.isArray(x)) x.forEach(walk);
      else if (x !== null && typeof x === 'object') Object.values(x as Record<string, unknown>).forEach(walk);
    };
    walk(k);
    const to = found.length > 0 ? found[found.length - 1] : `unparsed ${describe(k)}`;
    out.push({ to, amount: BigInt(amount) });
  }
  return out;
};

/**
 * Runs the compiled Starfall settlement contract in memory, with a
 * controllable clock. Each call picks whose private state the witnesses see;
 * a failed call leaves the state unchanged. Token transfers aren't executed;
 * the payments each circuit makes are recorded from its effects when the
 * runtime exposes them (`payments`), and the ledger keeps its own accounts.
 */
export class SettlementSimulator {
  readonly contract = new Contract<SettlementPrivateState>(settlementWitnesses);
  readonly address = sampleContractAddress();
  readonly addressBytes: Uint8Array;
  now: number;
  /** Payments made by every successful call so far, if the runtime exposes them. */
  payments: Payment[] | undefined = [];
  private state: ContractState | ChargedState;

  constructor(readonly opts: SettlementSimulatorOptions) {
    this.now = opts.now ?? 1_800_000_000;
    this.addressBytes = encodeContractAddress(this.address);
    const result = this.contract.initialState(
      createConstructorContext<SettlementPrivateState>({}, COIN_PUBLIC_KEY),
      oraclePublicKey(opts.oracleSecretKey),
      pureCircuits.organiserCommitmentOf(opts.organiserSecret),
      pureCircuits.settlementPublicKey(opts.settlementSecret),
      { bytes: opts.operator },
      opts.feeShare ?? 200n,
      opts.ticketPrice ?? 1_000_000n,
      opts.minSales ?? 600n,
      opts.maxSales ?? 2_592_000n,
      opts.revealWindow ?? 3_600n,
      opts.drawWindow ?? 3_600n,
      opts.settleWindow ?? 86_400n,
    );
    this.state = result.currentContractState;
    if (opts.acceptKey ?? true) this.acceptOracleKey();
  }

  get oracle(): SettlementPrivateState {
    return { oracleSecretKey: this.opts.oracleSecretKey };
  }

  get organiser(): SettlementPrivateState {
    return { organiserSecret: this.opts.organiserSecret };
  }

  readonly anyone: SettlementPrivateState = {};

  advance(seconds: number): void {
    this.now += seconds;
  }

  publicState(): ChargedState {
    const s = this.state as ContractState;
    return 'data' in s ? s.data : (this.state as ChargedState);
  }

  getLedger(): Ledger {
    return ledger(this.publicState());
  }

  commitmentOf(t: TicketPreimage): Uint8Array {
    return pureCircuits.ticketCommitment({ bytes: this.addressBytes }, t);
  }

  alphaOf(drawId: bigint, seed: Uint8Array): Uint8Array {
    return pureCircuits.drawAlpha({ bytes: this.addressBytes }, drawId, seed);
  }

  /** Tickets sold for a draw. */
  ticketsSold(n: bigint): bigint {
    return this.getLedger().ticketCount.lookup(n);
  }

  /**
   * The settler's view: every ticket of draw `n`, decrypted from the ledger
   * with the settlement secret, in index order.
   */
  decryptDrawTickets(n: bigint, secret: bigint = this.opts.settlementSecret): TicketPreimage[] {
    const l = this.getLedger();
    const count = l.ticketCount.lookup(n);
    const out: TicketPreimage[] = [];
    for (let i = 0n; i < count; i++) {
      out.push(pureCircuits.openTicket(secret, n, l.tickets.lookup(pureCircuits.ticketKey(n, i)).cipher));
    }
    return out;
  }

  private run<R>(privateState: SettlementPrivateState, call: (ctx: CircuitContext<SettlementPrivateState>) => Result<R>): R {
    const ctx = createCircuitContext<SettlementPrivateState>(
      this.address,
      COIN_PUBLIC_KEY,
      this.state,
      privateState,
      undefined,
      undefined,
      this.now,
    );
    const out = call(ctx);
    this.state = out.context.currentQueryContext.state;
    const paid = paymentsOf(out.context);
    if (paid === undefined) this.payments = undefined;
    else if (this.payments !== undefined) this.payments.push(...paid);
    return out.result;
  }

  acceptOracleKey(as: SettlementPrivateState = this.oracle): void {
    this.run(as, (ctx) => this.contract.impureCircuits.acceptOracleKey(ctx));
  }

  openDraw(salesClose: bigint, seedCommitment: Uint8Array, as: SettlementPrivateState = this.organiser): bigint {
    return this.run(as, (ctx) => this.contract.impureCircuits.openDraw(ctx, salesClose, seedCommitment));
  }

  /** Buy a ticket, with refunds going to `refundTo`; returns its commitment. */
  buyTicket(
    t: TicketPreimage,
    refundTo: Uint8Array,
    as: SettlementPrivateState = { pendingTicket: t },
  ): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.buyTicket(ctx, { bytes: refundTo }));
  }

  /**
   * Buy several games in one transaction (at most `maxGames()`), refundable
   * to `refundTo`; returns how many were bought. `buyPackage` handles bigger
   * packages.
   */
  buyTickets(ts: readonly TicketPreimage[], refundTo: Uint8Array): bigint {
    return this.run({ pendingTickets: ts }, (ctx) =>
      this.contract.impureCircuits.buyTickets(ctx, BigInt(ts.length), { bytes: refundTo }),
    );
  }

  /** Buy any number of games, `maxGames()` per transaction; returns the number of transactions. */
  buyPackage(ts: readonly TicketPreimage[], refundTo: Uint8Array): number {
    const max = Number(pureCircuits.maxGames());
    let txs = 0;
    for (let i = 0; i < ts.length; i += max) {
      this.buyTickets(ts.slice(i, i + max), refundTo);
      txs++;
    }
    return txs;
  }

  /** Open a syndicate for draw `n`; returns its id. */
  createSyndicate(
    n: bigint,
    creatorSecret: Uint8Array,
    sharePrice: bigint,
    totalShares: bigint,
    games: bigint,
    joinDeadline: bigint,
  ): bigint {
    return this.run(this.anyone, (ctx) =>
      this.contract.impureCircuits.createSyndicate(
        ctx,
        n,
        pureCircuits.creatorCommitmentOf(creatorSecret),
        sharePrice,
        totalShares,
        games,
        joinDeadline,
      ),
    );
  }

  /** Buy shares in a syndicate, paid to `payTo`; returns the member's index. */
  joinSyndicate(syndicate: bigint, shares: bigint, payTo: Uint8Array): bigint {
    return this.run(this.anyone, (ctx) => this.contract.impureCircuits.joinSyndicate(ctx, syndicate, shares, { bytes: payTo }));
  }

  /** The creator buys games for the syndicate (at most `maxGames()` per call). */
  buySyndicateTickets(syndicate: bigint, creatorSecret: Uint8Array, ts: readonly TicketPreimage[]): bigint {
    return this.run({ creatorSecret, pendingTickets: ts }, (ctx) =>
      this.contract.impureCircuits.buySyndicateTickets(ctx, syndicate, BigInt(ts.length)),
    );
  }

  paySyndicateMember(entitlement: Uint8Array, payee: bigint, member: bigint): bigint {
    return this.run(this.anyone, (ctx) => this.contract.impureCircuits.paySyndicateMember(ctx, entitlement, payee, member));
  }

  refundSyndicateUnspent(syndicate: bigint, member: bigint): bigint {
    return this.run(this.anyone, (ctx) => this.contract.impureCircuits.refundSyndicateUnspent(ctx, syndicate, member));
  }

  refundSyndicateVoid(syndicate: bigint, member: bigint): bigint {
    return this.run(this.anyone, (ctx) => this.contract.impureCircuits.refundSyndicateVoid(ctx, syndicate, member));
  }

  /** Pay every member of every syndicate owed from the paid entitlements of draw `n`; returns the payments made. */
  payAllSyndicateMembers(n: bigint): number {
    const l = this.getLedger();
    let paid = 0;
    for (const [id, e] of l.entitlements) {
      if (e.drawId !== n || !e.paid) continue;
      e.payees.forEach((p, j) => {
        if (p.syndicate === 0n || !l.syndicatePots.member(pureCircuits.potId(id, BigInt(j)))) return;
        const sy = l.syndicates.lookup(p.syndicate);
        for (let m = 0n; m < sy.members; m++) {
          this.paySyndicateMember(id, BigInt(j), m);
          paid++;
        }
      });
    }
    return paid;
  }

  requestDraw(n: bigint, seed: Uint8Array, as: SettlementPrivateState = this.organiser): void {
    const none = { is_some: false, value: { salesClose: 0n, seedCommitment: new Uint8Array(32) } };
    this.run(as, (ctx) => this.contract.impureCircuits.requestDraw(ctx, n, seed, none));
  }

  requestAndOpenNext(n: bigint, seed: Uint8Array, next: NextDraw, as: SettlementPrivateState = this.organiser): void {
    this.run(as, (ctx) => this.contract.impureCircuits.requestDraw(ctx, n, seed, { is_some: true, value: next }));
  }

  fulfilDraw(n: bigint, as: SettlementPrivateState = this.oracle): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.fulfilDraw(ctx, n));
  }

  computeNumbers(n: bigint, now: bigint = BigInt(this.now), as: SettlementPrivateState = this.anyone): Numbers {
    return this.run(as, (ctx) => this.contract.impureCircuits.computeNumbers(ctx, n, now));
  }

  /** Settle the next batch of draw `n` with the given decrypted tickets (default: decrypt them). */
  settleBatch(n: bigint, tickets: readonly TicketPreimage[] = this.decryptDrawTickets(n)): bigint {
    return this.run({ settling: { drawId: n, tickets } }, (ctx) => this.contract.impureCircuits.settleBatch(ctx, n));
  }

  finaliseDraw(n: bigint, as: SettlementPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.finaliseDraw(ctx, n));
  }

  payEntitlement(id: Uint8Array, as: SettlementPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.payEntitlement(ctx, id));
  }

  withdrawFees(as: SettlementPrivateState = this.anyone): bigint {
    return this.run(as, (ctx) => this.contract.impureCircuits.withdrawFees(ctx));
  }

  voidDraw(n: bigint, as: SettlementPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.voidDraw(ctx, n));
  }

  refundTicket(n: bigint, index: bigint, as: SettlementPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.refundTicket(ctx, n, index));
  }

  /** Entitlement ids of a draw, unpaid ones first. */
  entitlementsOf(n: bigint): Uint8Array[] {
    const out: [Uint8Array, boolean][] = [];
    for (const [id, e] of this.getLedger().entitlements) if (e.drawId === n) out.push([id, e.paid]);
    return out.sort((a, b) => Number(a[1]) - Number(b[1])).map(([id]) => id);
  }

  /**
   * What the settlement engine does after a draw's numbers are in: decrypt
   * every ticket, settle them batch by batch, finalise, pay every
   * entitlement and every syndicate member. Returns the number of batches it took.
   */
  settleAll(n: bigint): number {
    const tickets = this.decryptDrawTickets(n);
    let batches = 0;
    while (this.getLedger().progress.lookup(n).next < BigInt(tickets.length)) {
      this.settleBatch(n, tickets);
      batches++;
    }
    this.finaliseDraw(n);
    for (const id of this.entitlementsOf(n)) this.payEntitlement(id);
    this.payAllSyndicateMembers(n);
    return batches;
  }
}
