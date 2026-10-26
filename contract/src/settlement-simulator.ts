import {
  type ChargedState,
  type CircuitContext,
  type ContractState,
  createCircuitContext,
  createConstructorContext,
  encodeContractAddress,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { generateOperatorSecret, oraclePublicKey } from '@nightcast/contract';
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
const NO_NEXT = { is_some: false, value: { salesClose: 0n, seedCommitment: new Uint8Array(32) } };

export type SettlementSimulatorOptions = {
  oracleSecretKey: bigint;
  organiserSecret: Uint8Array;
  /** The backup organiser's secret (default: a fresh random one). */
  backupSecret?: Uint8Array;
  /** Secret of the settlement key the tickets are encrypted to. */
  settlementSecret: bigint;
  /** Where operator fees go (32-byte unshielded address). */
  operator: Uint8Array;
  /** Operator fee per game in STAR, out of the ticket price (default 200,000 = 0.2 tNIGHT). */
  feePerGame?: bigint;
  /** Price of one game (one line) in STAR (default 1.2 tNIGHT: 1 tNIGHT to the prize pool + the 0.2 tNIGHT fee). */
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
  /**
   * Called with every successful circuit call's name and proof data (what a
   * proof server would be asked to prove), so tests can check each run
   * against the circuit's zkir.
   */
  onProof?: (circuit: string, proofData: ProofData) => void;
};

/** What a circuit call hands the prover. */
export type ProofData = {
  input: unknown;
  output: unknown;
  publicTranscript: unknown[];
  privateTranscriptOutputs: unknown[];
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
  readonly backupSecret: Uint8Array;
  /** Payments made by every successful call so far, if the runtime exposes them. */
  payments: Payment[] | undefined = [];
  private state: ContractState | ChargedState;

  constructor(readonly opts: SettlementSimulatorOptions) {
    this.now = opts.now ?? 1_800_000_000;
    this.addressBytes = encodeContractAddress(this.address);
    this.backupSecret = opts.backupSecret ?? generateOperatorSecret();
    if (opts.onProof) {
      const report = opts.onProof;
      const circuits = this.contract.impureCircuits as unknown as Record<string, (...args: unknown[]) => { proofData: ProofData }>;
      for (const name of Object.keys(circuits)) {
        const circuit = circuits[name];
        circuits[name] = (...args: unknown[]) => {
          const out = circuit(...args);
          report(name, out.proofData);
          return out;
        };
      }
    }
    const result = this.contract.initialState(
      createConstructorContext<SettlementPrivateState>({}, COIN_PUBLIC_KEY),
      oraclePublicKey(opts.oracleSecretKey),
      pureCircuits.organiserCommitmentOf(opts.organiserSecret),
      pureCircuits.organiserCommitmentOf(this.backupSecret),
      pureCircuits.settlementPublicKey(opts.settlementSecret),
      { bytes: opts.operator },
      opts.feePerGame ?? 200_000n,
      opts.ticketPrice ?? 1_200_000n,
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

  /** The backup organiser's private state (its secret goes in as `organiserSecret`). */
  get backup(): SettlementPrivateState {
    return { organiserSecret: this.backupSecret };
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

  /** The proposed key's holder activates it, or the current oracle approves a hand-over. */
  acceptOracleKey(as: SettlementPrivateState = this.oracle): void {
    this.run(as, (ctx) => this.contract.impureCircuits.acceptOracleKey(ctx));
  }

  /** Propose a new oracle key; `now` defaults to the simulator's clock. */
  proposeOracleKey(
    key: { x: bigint; y: bigint },
    as: SettlementPrivateState = this.organiser,
    now: bigint = BigInt(this.now),
  ): void {
    this.run(as, (ctx) => this.contract.impureCircuits.proposeOracleKey(ctx, key, now));
  }

  /** The current oracle approves the proposed key (`acceptOracleKey` by the current oracle). */
  approveOracleKey(as: SettlementPrivateState = this.oracle): void {
    this.acceptOracleKey(as);
  }

  changeOrganiser(commitment: Uint8Array, as: SettlementPrivateState): void {
    this.run(as, (ctx) => this.contract.impureCircuits.changeOrganiser(ctx, commitment));
  }

  /** The organiser proposes a successor. */
  proposeOrganiser(commitment: Uint8Array, as: SettlementPrivateState = this.organiser): void {
    this.changeOrganiser(commitment, as);
  }

  /** The proposed organiser accepts (passing its own commitment). */
  acceptOrganiser(as: SettlementPrivateState): void {
    if (!as.organiserSecret) throw new Error('acceptOrganiser needs the accepting secret');
    this.changeOrganiser(pureCircuits.organiserCommitmentOf(as.organiserSecret), as);
  }

  /** The backup organiser installs a new organiser. */
  recoverOrganiser(commitment: Uint8Array, as: SettlementPrivateState = this.backup): void {
    this.changeOrganiser(commitment, as);
  }

  /** Open the next draw without revealing one (`requestDraw(0, …, next)`); returns its number. */
  openDraw(salesClose: bigint, seedCommitment: Uint8Array, as: SettlementPrivateState = this.organiser): bigint {
    this.run(as, (ctx) =>
      this.contract.impureCircuits.requestDraw(ctx, 0n, new Uint8Array(32), { is_some: true, value: { salesClose, seedCommitment } }),
    );
    return this.getLedger().lastDraw;
  }

  /** Buy one game, with refunds going to `refundTo`; returns its commitment. */
  buyTicket(t: TicketPreimage, refundTo: Uint8Array): Uint8Array {
    this.buyTickets([t], refundTo);
    return this.commitmentOf(t);
  }

  /**
   * Buy 1 to `maxGames()` games in one transaction, refundable to
   * `refundTo`; returns the index of the first. `buyPackage` handles bigger
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

  requestDraw(n: bigint, seed: Uint8Array, as: SettlementPrivateState = this.organiser): void {
    this.run(as, (ctx) => this.contract.impureCircuits.requestDraw(ctx, n, seed, NO_NEXT));
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
   * every ticket, settle them batch by batch, finalise (which pays the
   * operator fee) and pay every entitlement. Returns the number of batches it took.
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
    return batches;
  }
}
