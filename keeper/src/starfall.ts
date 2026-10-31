/**
 * The Starfall keeper: runs the private-settlement contract (docs/SETTLEMENT.md)
 * with nobody at the keyboard.
 *
 *   open draw ──▶ sales close ──▶ reveal its seed and open the next draw
 *   fulfilled ──▶ compute the numbers
 *   drawn     ──▶ decrypt the tickets, settle them a batch (22) at a time, in order
 *             ──▶ finalise (prizes fixed, operator fee paid; draws in order)
 *   settled   ──▶ pay every winning ticket's entitlement
 *   a deadline missed ──▶ void the draw, then refund every ticket
 *
 * Like v0's keeper it keeps no state of its own: seeds are worked out from the
 * organiser secret (DerivedSeeds), tickets are decrypted from the chain with
 * the settlement secret, and sending a step twice is harmless.
 *
 * Two keepers can run one deployment. The primary sends everything; a standby
 * (its own wallet, the same organiser and settlement secrets) sends a step
 * only once it has been due for `takeOverAfterSecs` without the primary
 * sending it. Payments and refunds are split between them (`split`): each
 * sends its share straight away and the other's only once overdue, so both
 * wallets' fees are used and either keeper alone still pays everyone.
 */
import { Starfall } from '@lunardraw/contract';
import { type EngineTiming, type KeeperStatus, reasonOf, StepEngine, type TickReport } from './engine.js';
import type { Schedule } from './schedule.js';
import type { DrawSeeds } from './seeds.js';

const { DrawStatus } = Starfall;
type DrawStatus = Starfall.Contract.DrawStatus;
type TicketPreimage = Starfall.TicketPreimage;
type SealedTicket = Starfall.SealedTicket;
type NextDraw = Starfall.NextDraw;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

// ------------------------------------------------------------------ view

export type StarfallDrawView = {
  id: bigint;
  status: DrawStatus;
  salesClose: bigint;
  revealDeadline: bigint;
  drawDeadline: bigint;
  /** Last moment to compute the numbers, then (reset when they are) to finish settling. */
  settleDeadline: bigint;
  seedCommitment: Uint8Array;
  oracleKey: { x: bigint; y: bigint };
  /** The revealed seed and the VRF output (all zeros until known). */
  seed: Uint8Array;
  output: Uint8Array;
  numbers: number[];
  moonball: number;
  /**
   * Tickets sold, and how many are settled so far. A ticket is one entry: a
   * standard game, a System or a Pick, settled as one, however many games.
   */
  tickets: bigint;
  settled: bigint;
  /** Games sold (what sales, the fee and the prizes are counted in). */
  games: bigint;
  /** Winning games per division so far (division 1 first). */
  winners: bigint[];
  /** Fixed when the draw is finalised: rollover added to the jackpot, the operator fee, each division's prize per game. */
  carried: bigint;
  fee: bigint;
  prizes: bigint[];
  /** For a void draw: the indexes of tickets not refunded yet, and the games refunded so far. */
  unrefunded: bigint[];
  refundedGames: bigint;
};

/** A winning ticket's prize: its winning games per division (division 1 first). */
export type EntitlementView = { id: Uint8Array; drawId: bigint; games: bigint[]; paid: boolean };

export type StarfallView = {
  lastDraw: bigint;
  minSales: bigint;
  maxSales: bigint;
  ticketPrice: bigint;
  feePerGame: bigint;
  revealWindow: bigint;
  drawWindow: bigint;
  settleWindow: bigint;
  /** Rollover waiting for the next draw to be finalised, in STAR. */
  carry: bigint;
  oracleKeyReady: boolean;
  oracleKeyChange?: { key: { x: bigint; y: bigint }; at: bigint; approved: boolean };
  /** The key tickets are encrypted to. */
  settlementKey: { x: bigint; y: bigint };
  draws: StarfallDrawView[];
  entitlements: EntitlementView[];
};

/** Key of a draw's ticket in the ledger's `tickets` map (the contract's ticketKey). */
export const ticketKeyOf = (drawId: bigint, index: bigint): bigint => drawId * 4_294_967_296n + index;

/** The keeper's view of a Starfall ledger. */
export const starfallViewOf = (l: Starfall.Ledger): StarfallView => ({
  lastDraw: l.lastDraw,
  minSales: l.minSales,
  maxSales: l.maxSales,
  ticketPrice: l.ticketPrice,
  feePerGame: l.feePerGame,
  revealWindow: l.revealWindow,
  drawWindow: l.drawWindow,
  settleWindow: l.settleWindow,
  carry: l.carry,
  oracleKeyReady: l.oracleKeyReady,
  oracleKeyChange: l.proposedOracleKey.is_some
    ? { key: { x: l.proposedOracleKey.value.x, y: l.proposedOracleKey.value.y }, at: l.oracleKeyChangeAt, approved: l.oracleKeyApproved }
    : undefined,
  settlementKey: { x: l.settlementKey.x, y: l.settlementKey.y },
  draws: Array.from(l.draws, ([id, d]) => {
    const tickets = l.ticketCount.member(id) ? l.ticketCount.lookup(id) : 0n;
    const p = l.progress.member(id) ? l.progress.lookup(id) : undefined;
    const unrefunded: bigint[] = [];
    let refundedGames = 0n;
    if (d.status === DrawStatus.voided) {
      for (let i = 0n; i < tickets; i++) {
        const key = ticketKeyOf(id, i);
        if (!l.tickets.member(key)) continue;
        const rec = l.tickets.lookup(key);
        if (rec.refunded) refundedGames += rec.games;
        else unrefunded.push(i);
      }
    }
    return {
      id,
      status: d.status,
      salesClose: d.salesClose,
      revealDeadline: d.revealDeadline,
      drawDeadline: d.drawDeadline,
      settleDeadline: d.settleDeadline,
      seedCommitment: d.seedCommitment,
      oracleKey: { x: d.oracleKey.x, y: d.oracleKey.y },
      seed: d.seed,
      output: d.output,
      numbers: d.numbers.map(Number),
      moonball: Number(d.moonball),
      tickets,
      settled: p?.next ?? 0n,
      games: l.gamesSold.member(id) ? l.gamesSold.lookup(id) : 0n,
      winners: p ? [...p.winners] : Array.from({ length: 9 }, () => 0n),
      carried: d.carried,
      fee: d.fee,
      prizes: [...d.prizes],
      unrefunded,
      refundedGames,
    };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  entitlements: Array.from(l.entitlements, ([id, e]) => ({ id, drawId: e.drawId, games: [...e.games], paid: e.paid })),
});

/** A ticket as stored: its commitment and its encryption to the settlement key. */
export type StoredTicket = { commitment: Uint8Array; cipher: SealedTicket };

/** What the Starfall keeper needs from a deployment. */
export interface StarfallChain {
  view(): Promise<StarfallView>;
  /** Chain time in seconds. */
  now(): Promise<number>;
  /** The deployment's address, 32 bytes (tickets commit to it). */
  readonly addressBytes: Uint8Array;
  /** Draw `n`'s tickets, in index order. */
  storedTickets(n: bigint): Promise<StoredTicket[]>;
  /**
   * Organiser only. Each resolves once the transaction is on chain, with its
   * transaction id when the chain knows it (the site's feed links to it).
   */
  openDraw(salesClose: bigint, seedCommitment: Uint8Array): Promise<string | void>;
  requestDraw(n: bigint, seed: Uint8Array, next?: NextDraw): Promise<string | void>;
  /** Anyone. */
  computeNumbers(n: bigint): Promise<string | void>;
  /** Anyone holding the decrypted tickets: settles the next batch. `tickets` is every ticket of the draw, in index order. */
  settleBatch(n: bigint, tickets: readonly TicketPreimage[]): Promise<void>;
  finaliseDraw(n: bigint): Promise<string | void>;
  payEntitlement(id: Uint8Array): Promise<void>;
  voidDraw(n: bigint): Promise<string | void>;
  refundTicket(n: bigint, index: bigint): Promise<void>;
}

/** A {@link Starfall.SettlementSimulator} as a chain: the keeper is its organiser and settler, the oracle its oracle. */
export class StarfallSimulatorChain implements StarfallChain {
  constructor(readonly sim: Starfall.SettlementSimulator) {}

  get addressBytes(): Uint8Array {
    return this.sim.addressBytes;
  }

  async view(): Promise<StarfallView> {
    return starfallViewOf(this.sim.getLedger());
  }

  async now(): Promise<number> {
    return this.sim.now;
  }

  async storedTickets(n: bigint): Promise<StoredTicket[]> {
    return storedTicketsOf(this.sim.getLedger(), n);
  }

  async openDraw(salesClose: bigint, seedCommitment: Uint8Array): Promise<string | void> {
    this.sim.openDraw(salesClose, seedCommitment);
  }

  async requestDraw(n: bigint, seed: Uint8Array, next?: NextDraw): Promise<string | void> {
    if (next) this.sim.requestAndOpenNext(n, seed, next);
    else this.sim.requestDraw(n, seed);
  }

  async fulfilDraw(n: bigint): Promise<void> {
    this.sim.fulfilDraw(n);
  }

  async computeNumbers(n: bigint): Promise<string | void> {
    this.sim.computeNumbers(n);
  }

  async settleBatch(n: bigint, tickets: readonly TicketPreimage[]): Promise<void> {
    this.sim.settleBatch(n, tickets);
  }

  async finaliseDraw(n: bigint): Promise<string | void> {
    this.sim.finaliseDraw(n);
  }

  async payEntitlement(id: Uint8Array): Promise<void> {
    this.sim.payEntitlement(id);
  }

  async voidDraw(n: bigint): Promise<string | void> {
    this.sim.voidDraw(n);
  }

  async refundTicket(n: bigint, index: bigint): Promise<void> {
    this.sim.refundTicket(n, index);
  }
}

/** Draw `n`'s stored tickets from a ledger, in index order. */
export const storedTicketsOf = (l: Starfall.Ledger, n: bigint): StoredTicket[] => {
  const count = l.ticketCount.member(n) ? l.ticketCount.lookup(n) : 0n;
  const out: StoredTicket[] = [];
  for (let i = 0n; i < count; i++) {
    const rec = l.tickets.lookup(ticketKeyOf(n, i));
    out.push({ commitment: rec.commitment, cipher: rec.cipher });
  }
  return out;
};

/**
 * Decrypt draw `n`'s tickets with the settlement secret, checking each
 * against its commitment (a wrong secret, or a corrupt ticket, fails here
 * with a clear message rather than in the proof).
 */
export const decryptTickets = (stored: readonly StoredTicket[], n: bigint, secret: bigint, deployment: Uint8Array): TicketPreimage[] =>
  stored.map((s, i) => {
    let t: TicketPreimage;
    try {
      t = Starfall.pureCircuits.openTicket(secret, n, s.cipher);
    } catch (err) {
      throw new Error(`ticket ${i} of draw ${n} doesn't decrypt with this settlement secret: ${reasonOf(err)}`);
    }
    if (hex(Starfall.pureCircuits.ticketCommitment({ bytes: deployment }, t)) !== hex(s.commitment)) {
      throw new Error(`ticket ${i} of draw ${n} doesn't match its commitment once decrypted: is this the deployment's settlement secret?`);
    }
    return t;
  });

// ------------------------------------------------------------------ plan

export type StarfallStep =
  | { kind: 'open' }
  | { kind: 'reveal'; draw: bigint; openNext: boolean }
  | { kind: 'compute'; draw: bigint }
  | { kind: 'settle'; draw: bigint; from: bigint; of: bigint }
  | { kind: 'finalise'; draw: bigint }
  | { kind: 'pay'; draw: bigint; id: Uint8Array }
  | { kind: 'void'; draw: bigint; reason: string }
  | { kind: 'refund'; draw: bigint; index: bigint };

export type StarfallPlanOptions = {
  /** Seconds to wait after a boundary before acting on it, so block time has passed it too. Default 30. */
  marginSecs: number;
  /** Open a new draw when the last one closes. Turn off to wind down. */
  openNew: boolean;
  /** This keeper holds the organiser secret (it may open and reveal). */
  organise: boolean;
  /** This keeper holds the settlement secret (it may settle). */
  settle: boolean;
};

const finished = (d: StarfallDrawView | undefined) => d !== undefined && (d.status === DrawStatus.settled || d.status === DrawStatus.voided);

/** The steps due at chain time `now`, most urgent first. Pure. */
export const starfallSteps = (view: StarfallView, now: number, opts: StarfallPlanOptions): StarfallStep[] => {
  const t = BigInt(Math.floor(now));
  const m = BigInt(opts.marginSecs);
  const past = (boundary: bigint) => t >= boundary + m;
  const byId = new Map(view.draws.map((d) => [d.id, d] as const));
  const steps: StarfallStep[] = [];
  let opensNext = false;

  for (const d of view.draws) {
    switch (d.status) {
      case DrawStatus.open:
        if (past(d.revealDeadline)) steps.push({ kind: 'void', draw: d.id, reason: 'its seed was not revealed in time' });
        else if (opts.organise && past(d.salesClose) && t < d.revealDeadline) {
          const openNext = opts.openNew && d.id === view.lastDraw;
          opensNext ||= openNext;
          steps.push({ kind: 'reveal', draw: d.id, openNext });
        }
        break;
      case DrawStatus.requested:
        if (past(d.drawDeadline)) steps.push({ kind: 'void', draw: d.id, reason: 'the oracle did not answer in time' });
        break;
      case DrawStatus.fulfilled:
        if (past(d.settleDeadline)) steps.push({ kind: 'void', draw: d.id, reason: 'its numbers were not computed in time' });
        else if (t < d.settleDeadline) steps.push({ kind: 'compute', draw: d.id });
        break;
      case DrawStatus.drawn:
        if (past(d.settleDeadline)) steps.push({ kind: 'void', draw: d.id, reason: 'it was not settled in time' });
        else if (t < d.settleDeadline) {
          if (d.settled < d.tickets) {
            if (opts.settle) steps.push({ kind: 'settle', draw: d.id, from: d.settled, of: d.tickets });
          } else if (d.id === 1n || finished(byId.get(d.id - 1n))) {
            // Draws finalise in order, so the rollover always goes to the next draw.
            steps.push({ kind: 'finalise', draw: d.id });
          }
        }
        break;
      case DrawStatus.settled:
        for (const e of view.entitlements) if (e.drawId === d.id && !e.paid) steps.push({ kind: 'pay', draw: d.id, id: e.id });
        break;
      case DrawStatus.voided:
        for (const index of d.unrefunded) steps.push({ kind: 'refund', draw: d.id, index });
        break;
      default:
        break;
    }
  }

  // Nothing selling and nothing about to open one: open a draw directly.
  const last = byId.get(view.lastDraw);
  if (opts.organise && opts.openNew && !opensNext && (view.lastDraw === 0n || (last !== undefined && last.status !== DrawStatus.open))) {
    steps.push({ kind: 'open' });
  }
  // Most urgent first: reveals have the shortest deadline and only the
  // organiser can send them; settling has a deadline too; payments and
  // refunds have none.
  const rank: Record<StarfallStep['kind'], number> = { reveal: 0, open: 1, void: 2, settle: 3, finalise: 4, compute: 5, pay: 6, refund: 7 };
  return steps
    .map((step, i) => ({ step, i }))
    .sort((a, b) => rank[a.step.kind] - rank[b.step.kind] || a.i - b.i)
    .map(({ step }) => step);
};

export const starfallStepKey = (s: StarfallStep, lastDraw: bigint): string => {
  switch (s.kind) {
    case 'open':
      return `open after ${lastDraw}`;
    case 'settle':
      return `settle ${s.draw} from ${s.from}`;
    case 'pay':
      return `pay ${hex(s.id)}`;
    case 'refund':
      return `refund ${s.draw} #${s.index}`;
    default:
      return `${s.kind} ${s.draw}`;
  }
};

export const describeStarfallStep = (s: StarfallStep, batchSize = 25n): string => {
  switch (s.kind) {
    case 'open':
      return 'open a new draw';
    case 'reveal':
      return `reveal draw ${s.draw}'s seed${s.openNext ? ' and open the next draw' : ''}`;
    case 'compute':
      return `compute draw ${s.draw}'s numbers`;
    case 'settle': {
      const to = s.from + batchSize < s.of ? s.from + batchSize : s.of;
      return `settle draw ${s.draw}'s tickets ${s.from + 1n}-${to} of ${s.of}`;
    }
    case 'finalise':
      return `finalise draw ${s.draw}`;
    case 'pay':
      return `pay a winning ticket of draw ${s.draw} (${hex(s.id).slice(0, 12)}...)`;
    case 'void':
      return `void draw ${s.draw}: ${s.reason}`;
    case 'refund':
      return `refund ticket ${s.index} of void draw ${s.draw}`;
  }
};

// ------------------------------------------------------------------ roles

/** Which payments and refunds are this keeper's: those whose share (0 .. of-1) is `index`. */
export type Split = { index: number; of: number };

/** The share a payment or refund falls in, of `of` shares; undefined for other steps. */
export const shareOf = (s: StarfallStep, of: number): number | undefined => {
  if (s.kind === 'pay') return Buffer.from(s.id).readUInt32BE(0) % of;
  if (s.kind === 'refund') return Number(s.index % BigInt(of));
  return undefined;
};

export type StarfallRole = 'primary' | 'standby';

/** Whether a step is this keeper's to send straight away. */
export const isMine = (s: StarfallStep, role: StarfallRole, split: Split): boolean => {
  const share = shareOf(s, split.of);
  return share === undefined ? role === 'primary' : share === split.index;
};

// ------------------------------------------------------------------ keeper

/** The steps of a draw whose transactions the site's feed links to (`tx` in the feed). */
export type StarfallTxStep = 'open' | 'reveal' | 'numbers' | 'finalise' | 'void';

export type StarfallKeeperOptions = EngineTiming & {
  chain: StarfallChain;
  schedule: Schedule;
  /** The organiser's seeds. Without them this keeper doesn't open or reveal draws. */
  seeds?: DrawSeeds;
  /** The settlement secret. Without it this keeper doesn't settle. */
  settlementSecret?: bigint;
  /** Default primary. A standby sends the primary's steps only once they're overdue. */
  role?: StarfallRole;
  /**
   * This keeper's share of the payments and refunds. Default: all of them
   * for a primary ({ index: 0, of: 1 }), the second of two for a standby
   * ({ index: 1, of: 2 }). With two keepers, give the primary { index: 0, of: 2 }.
   */
  split?: Split;
  /** How long a step that isn't this keeper's must be due before it sends it (seconds). Default 300. */
  takeOverAfterSecs?: number;
  /** Payments and refunds sent in one pass at most, so urgent steps aren't kept waiting. Default 5. */
  paymentsPerPass?: number;
  marginSecs?: number;
  openNew?: boolean;
  onView?: (view: StarfallView, nowSecs: number) => void;
  /** Called with the id of each draw step this keeper sends (the feed's `tx`). */
  onTx?: (draw: bigint, step: StarfallTxStep, txId: string) => void;
  /** Step kinds to run in the background (see the v0 keeper). */
  background?: StarfallStep['kind'][];
  /** At most this many background proofs at once, and the gap between them (see the engine). */
  backgroundLimit?: number;
  backgroundGapMs?: number;
};

const silent = { info() {}, warn() {}, error() {} };

export class StarfallKeeper {
  private readonly engine: StepEngine<StarfallView, StarfallStep>;
  private readonly warned = new Set<string>();
  /** Decrypted tickets by draw, kept while the draw settles. */
  private readonly decrypted = new Map<bigint, TicketPreimage[]>();
  private readonly batchSize = Starfall.pureCircuits.batchSize();
  private settleKeyOk = true;
  readonly role: StarfallRole;
  readonly split: Split;

  constructor(private readonly options: StarfallKeeperOptions) {
    this.role = options.role ?? 'primary';
    this.split = options.split ?? (this.role === 'primary' ? { index: 0, of: 1 } : { index: 1, of: 2 });
    const { index, of } = this.split;
    if (!Number.isInteger(of) || of < 1 || !Number.isInteger(index) || index < 0 || index >= of) {
      throw new Error('split: index must be 0 to of-1');
    }
    const marginSecs = options.marginSecs ?? 30;
    const openNew = options.openNew ?? true;
    this.engine = new StepEngine<StarfallView, StarfallStep>({
      ...options,
      read: () => Promise.all([options.chain.view(), options.chain.now()]),
      beforePlan: (view) => this.beforePlan(view),
      plan: (view, now) =>
        starfallSteps(view, now, {
          marginSecs,
          openNew,
          organise: options.seeds !== undefined,
          settle: options.settlementSecret !== undefined && this.settleKeyOk,
        }),
      key: (step, view) => starfallStepKey(step, view.lastDraw),
      describe: (step) => describeStarfallStep(step, this.batchSize),
      run: (step, view, now) => this.run(step, view, now),
      mine: (step) => isMine(step, this.role, this.split),
      takeOverAfterMs: (options.takeOverAfterSecs ?? 300) * 1000,
      bulk: { kinds: ['pay', 'refund'], perPass: options.paymentsPerPass ?? 5 },
    });
  }

  private get logger() {
    return this.options.logger ?? silent;
  }

  /** Pass a sent step's transaction id on (when the chain gave one); a failing listener never stops the keeper. */
  private noteTx(draw: bigint, step: StarfallTxStep, txId: string | void): void {
    if (typeof txId !== 'string' || !txId) return;
    try {
      this.options.onTx?.(draw, step, txId);
    } catch (err) {
      this.logger.warn(`couldn't note draw ${draw}'s ${step} transaction: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private warnOnce(key: string, level: 'warn' | 'error', msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger[level](msg);
  }

  tick(): Promise<TickReport> {
    return this.engine.tick();
  }

  status(): KeeperStatus {
    return this.engine.status();
  }

  inProgress(): string[] {
    return this.engine.inProgress();
  }

  start(): void {
    this.engine.start();
  }

  stop(): Promise<void> {
    return this.engine.stop();
  }

  settled(): Promise<void> {
    return this.engine.settled();
  }

  private async beforePlan(view: StarfallView): Promise<void> {
    if (view.oracleKeyChange) {
      const c = view.oracleKeyChange;
      this.warnOnce(
        `key change ${c.key.x}:${c.key.y}:${c.at}`,
        'warn',
        `an oracle key change is pending: it can take effect ${c.approved ? 'now (the current oracle approved it)' : `from ${new Date(Number(c.at) * 1000).toISOString()}`}; ` +
          'draws already open keep their key. If you did not propose this, the organiser secret may be compromised.',
      );
    }
    if (this.options.settlementSecret !== undefined) {
      const k = Starfall.pureCircuits.settlementPublicKey(this.options.settlementSecret);
      this.settleKeyOk = k.x === view.settlementKey.x && k.y === view.settlementKey.y;
      if (!this.settleKeyOk) {
        this.warnOnce('settlement key', 'error', "the settlement secret given isn't this deployment's (its public key differs), so this keeper won't settle");
      }
    }
    // Keep decrypted tickets only while their draw is still being settled.
    for (const id of this.decrypted.keys()) {
      const d = view.draws.find((x) => x.id === id);
      if (!d || d.status !== DrawStatus.drawn) this.decrypted.delete(id);
    }
  }

  private async ticketsOf(n: bigint, count: bigint): Promise<TicketPreimage[]> {
    const cached = this.decrypted.get(n);
    if (cached && BigInt(cached.length) === count) return cached;
    const stored = await this.options.chain.storedTickets(n);
    if (BigInt(stored.length) !== count) throw new Error(`draw ${n} shows ${count} tickets but ${stored.length} were read; the indexer may be catching up`);
    const tickets = decryptTickets(stored, n, this.options.settlementSecret!, this.options.chain.addressBytes);
    this.decrypted.set(n, tickets);
    this.logger.info(`decrypted draw ${n}'s ${tickets.length} ticket(s)`);
    return tickets;
  }

  private async run(step: StarfallStep, view: StarfallView, now: number): Promise<boolean> {
    const { chain, schedule } = this.options;
    const nextClose = () => {
      const close = schedule(now, Number(view.minSales));
      if (close - BigInt(Math.floor(now)) > view.maxSales) {
        throw new Error(`the schedule's next close (${new Date(Number(close) * 1000).toISOString()}) is beyond the contract's longest sales period`);
      }
      return close;
    };
    const keyReady = (): boolean => {
      if (view.oracleKeyReady) return true;
      this.warnOnce('no oracle key', 'error', 'the oracle has not accepted its key yet, so no draw can open');
      return false;
    };
    switch (step.kind) {
      case 'open': {
        if (!keyReady()) return false;
        const close = nextClose();
        const sealed = await this.options.seeds!.forDraw(view.lastDraw + 1n);
        this.noteTx(view.lastDraw + 1n, 'open', await chain.openDraw(close, sealed.commitment));
        this.logger.info(`opened draw ${view.lastDraw + 1n}, selling until ${new Date(Number(close) * 1000).toISOString()}`);
        return true;
      }
      case 'reveal': {
        const d = view.draws.find((x) => x.id === step.draw)!;
        const seed = await this.options.seeds!.find(d.seedCommitment, d.id);
        if (!seed) {
          this.warnOnce(
            `no seed ${step.draw}`,
            'error',
            `draw ${step.draw}'s seed doesn't come from this organiser secret, so it can't be revealed; it will be voided and refunded after ` +
              `${new Date(Number(d.revealDeadline) * 1000).toISOString()}, and a new draw opened`,
          );
          return false;
        }
        if (step.openNext && keyReady()) {
          const close = nextClose();
          const sealed = await this.options.seeds!.forDraw(view.lastDraw + 1n);
          const id = await chain.requestDraw(step.draw, seed, { salesClose: close, seedCommitment: sealed.commitment });
          this.noteTx(step.draw, 'reveal', id);
          this.noteTx(view.lastDraw + 1n, 'open', id); // the same transaction opens the next draw
          this.logger.info(`opened draw ${view.lastDraw + 1n}, selling until ${new Date(Number(close) * 1000).toISOString()}`);
        } else {
          this.noteTx(step.draw, 'reveal', await chain.requestDraw(step.draw, seed));
        }
        return true;
      }
      case 'compute':
        this.noteTx(step.draw, 'numbers', await chain.computeNumbers(step.draw));
        return true;
      case 'settle': {
        const tickets = await this.ticketsOf(step.draw, step.of);
        await chain.settleBatch(step.draw, tickets);
        return true;
      }
      case 'finalise':
        this.noteTx(step.draw, 'finalise', await chain.finaliseDraw(step.draw));
        this.decrypted.delete(step.draw);
        return true;
      case 'pay':
        await chain.payEntitlement(step.id);
        return true;
      case 'void':
        this.noteTx(step.draw, 'void', await chain.voidDraw(step.draw));
        return true;
      case 'refund':
        await chain.refundTicket(step.draw, step.index);
        return true;
    }
  }
}
