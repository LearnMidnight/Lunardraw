/**
 * The keeper: keeps Lunardraw's draws moving with nobody at the keyboard.
 *
 * Every few seconds it reads the contract and sends whichever step is due:
 *
 *   open draw     ──▶ sales close ──▶ reveal its seed and open the next draw
 *   fulfilled     ──▶ compute the numbers (the claim window starts)
 *   claim window over ──▶ settle (in order), then pay each registered win
 *   a deadline missed ──▶ void the draw (everyone is refunded; never redrawn)
 *
 * It keeps no state of its own apart from its sealed seeds, so it can be
 * stopped and restarted at any time, and running a step twice is harmless
 * (the contract refuses the second one). Only revealing and opening need the
 * organiser secret; everything else anyone could send.
 */
import { DrawStatus } from '@lunardraw/contract';
import type { ChainView, DrawView, LunardrawChain } from './chain.js';
import type { Schedule } from './schedule.js';
import type { SeedStore } from './seeds.js';
import { type EngineTiming, type KeeperStatus, reasonOf, StepEngine, type TickReport } from './engine.js';

export type Step =
  | { kind: 'open' }
  | { kind: 'reveal'; draw: bigint; openNext: boolean }
  | { kind: 'compute'; draw: bigint }
  | { kind: 'settle'; draw: bigint }
  | { kind: 'pay'; draw: bigint; line: Uint8Array }
  | { kind: 'void'; draw: bigint; reason: string };

export type PlanOptions = {
  /**
   * Seconds to wait after a boundary (sales close, a deadline) before acting
   * on it, so that block time has passed it too. Default 30.
   */
  marginSecs: number;
  /** Open a new draw when the last one closes. Turn off to wind down. */
  openNew: boolean;
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * The steps that are due, in the order to send them, for a view of the
 * contract at chain time `now` (seconds). Pure: the keeper and its tests both
 * use it.
 */
export const dueSteps = (view: ChainView, now: number, opts: PlanOptions): Step[] => {
  const t = BigInt(Math.floor(now));
  const m = BigInt(opts.marginSecs);
  const past = (boundary: bigint) => t >= boundary + m;
  const byId = new Map(view.draws.map((d) => [d.id, d] as const));
  const finished = (d: DrawView | undefined) => d !== undefined && (d.status === DrawStatus.settled || d.status === DrawStatus.voided);
  const steps: Step[] = [];
  let opensNext = false;

  for (const d of view.draws) {
    switch (d.status) {
      case DrawStatus.open:
        if (past(d.revealDeadline)) steps.push({ kind: 'void', draw: d.id, reason: 'its seed was not revealed in time' });
        else if (past(d.salesClose) && t < d.revealDeadline) {
          const openNext = opts.openNew && d.id === view.lastDraw;
          opensNext ||= openNext;
          steps.push({ kind: 'reveal', draw: d.id, openNext });
        }
        break;
      case DrawStatus.requested:
        if (past(d.drawDeadline)) steps.push({ kind: 'void', draw: d.id, reason: 'the oracle did not answer in time' });
        break;
      case DrawStatus.fulfilled:
        if (past(d.claimDeadline)) steps.push({ kind: 'void', draw: d.id, reason: 'its numbers were not computed in time' });
        else if (t < d.claimDeadline) steps.push({ kind: 'compute', draw: d.id });
        break;
      case DrawStatus.drawn:
        // Draws settle in order, so the rollover always goes to the next draw.
        if (past(d.claimDeadline) && (d.id === 1n || finished(byId.get(d.id - 1n)))) steps.push({ kind: 'settle', draw: d.id });
        break;
      case DrawStatus.settled:
        for (const w of view.wins) if (w.drawId === d.id && !w.paid) steps.push({ kind: 'pay', draw: d.id, line: w.line });
        break;
      default:
        break;
    }
  }

  // Nothing selling and nothing about to open one: open a draw directly (the
  // first draw, or after a draw that was voided or revealed without a next).
  const last = byId.get(view.lastDraw);
  if (opts.openNew && !opensNext && (view.lastDraw === 0n || (last !== undefined && last.status !== DrawStatus.open))) {
    steps.push({ kind: 'open' });
  }
  // Most urgent first. Only the organiser can reveal or open, and a reveal has
  // a deadline (reveal window) that a slow proof elsewhere must not eat into;
  // voids and settlements have no deadline; computing the numbers is the
  // slowest proof by far (minutes on a home PC) and has an hour.
  const rank: Record<Step['kind'], number> = { reveal: 0, open: 1, void: 2, settle: 3, pay: 4, compute: 5 };
  return steps
    .map((step, i) => ({ step, i }))
    .sort((a, b) => rank[a.step.kind] - rank[b.step.kind] || a.i - b.i)
    .map(({ step }) => step);
};

/** A step's identity, for not sending the same one twice in a row. */
export const stepKey = (s: Step, lastDraw: bigint): string => {
  switch (s.kind) {
    case 'open':
      return `open after ${lastDraw}`;
    case 'pay':
      return `pay ${hex(s.line)}`;
    default:
      return `${s.kind} ${s.draw}`;
  }
};

export const describeStep = (s: Step): string => {
  switch (s.kind) {
    case 'open':
      return 'open a new draw';
    case 'reveal':
      return `reveal draw ${s.draw}'s seed${s.openNext ? ' and open the next draw' : ''}`;
    case 'compute':
      return `compute draw ${s.draw}'s numbers`;
    case 'settle':
      return `settle draw ${s.draw}`;
    case 'pay':
      return `pay a winning line of draw ${s.draw} (${hex(s.line).slice(0, 12)}...)`;
    case 'void':
      return `void draw ${s.draw}: ${s.reason}`;
  }
};

export type KeeperOptions = EngineTiming & {
  chain: LunardrawChain;
  seeds: SeedStore;
  schedule: Schedule;
  marginSecs?: number;
  openNew?: boolean;
  /** Called with the contract's state after every pass (used to publish the site feed). */
  onView?: (view: ChainView, nowSecs: number) => void;
  /**
   * Step kinds to run in the background: started in a pass but not waited
   * for, so later passes (and urgent steps such as reveals) go ahead while
   * the proof runs. Meant for `compute`, whose proof takes minutes on a small
   * machine. A background step that finishes or fails is reported in the
   * next pass's `done` / `failed`. Default: none.
   */
  background?: Step['kind'][];
};

/** Lunardraw v0's keeper (one keeper per deployment). */
export class Keeper {
  private readonly engine: StepEngine<ChainView, Step>;
  private readonly warned = new Set<string>();

  constructor(private readonly options: KeeperOptions) {
    const marginSecs = options.marginSecs ?? 30;
    const openNew = options.openNew ?? true;
    this.engine = new StepEngine<ChainView, Step>({
      ...options,
      read: () => Promise.all([options.chain.view(), options.chain.now()]),
      beforePlan: (view) => this.beforePlan(view),
      plan: (view, now) => dueSteps(view, now, { marginSecs, openNew }),
      key: (step, view) => stepKey(step, view.lastDraw),
      describe: describeStep,
      run: (step, view, now) => this.run(step, view, now),
    });
  }

  private get logger() {
    return this.options.logger ?? { info() {}, warn() {}, error() {} };
  }

  /** One pass: read the chain, send every due step. Never runs twice at once. */
  tick(): Promise<TickReport> {
    return this.engine.tick();
  }

  status(): KeeperStatus {
    return this.engine.status();
  }

  /** Background steps still running (their step keys). */
  inProgress(): string[] {
    return this.engine.inProgress();
  }

  private async beforePlan(view: ChainView): Promise<void> {
    if (view.oracleKeyChange) {
      const c = view.oracleKeyChange;
      const key = `key change ${c.key.x}:${c.key.y}:${c.at}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.logger.warn(
          `an oracle key change is pending: it can take effect ${c.approved ? 'now (the current oracle approved it)' : `from ${new Date(Number(c.at) * 1000).toISOString()}`}; ` +
            'draws already open keep their key. If you did not propose this, the organiser secret may be compromised.',
        );
      }
    }
    // Seeds of draws that are no longer selling are public (revealed) or
    // useless (void): drop them, so the seed store stays small.
    if (this.options.seeds.forget) {
      const gone = view.draws.filter((d) => d.status !== DrawStatus.open).map((d) => d.seedCommitment);
      try {
        await this.options.seeds.forget(gone);
      } catch (err) {
        this.logger.error(`could not tidy the seed store: ${reasonOf(err)}`);
      }
    }
  }

  /** Send one step. Returns false if it can't be sent (and says why once). */
  private async run(step: Step, view: ChainView, now: number): Promise<boolean> {
    const { chain, seeds, schedule } = this.options;
    const nextClose = () => {
      const close = schedule(now, Number(view.minSales));
      if (close - BigInt(Math.floor(now)) > view.maxSales) {
        throw new Error(`the schedule's next close (${new Date(Number(close) * 1000).toISOString()}) is beyond the contract's longest sales period`);
      }
      return close;
    };
    const keyReady = (): boolean => {
      if (view.oracleKeyReady) return true;
      const key = 'no oracle key';
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.logger.error('the oracle has not accepted its key yet, so no draw can open');
      }
      return false;
    };
    switch (step.kind) {
      case 'open': {
        if (!keyReady()) return false;
        const sealed = await seeds.create();
        const close = nextClose();
        await chain.openDraw(close, sealed.commitment);
        this.logger.info(`opened draw ${view.lastDraw + 1n}, selling until ${new Date(Number(close) * 1000).toISOString()}`);
        return true;
      }
      case 'reveal': {
        const d = view.draws.find((x) => x.id === step.draw)!;
        const seed = await seeds.find(d.seedCommitment);
        if (!seed) {
          const key = `no seed ${step.draw}`;
          if (!this.warned.has(key)) {
            this.warned.add(key);
            this.logger.error(
              `no seed for draw ${step.draw} in the seed store, so it can't be revealed; it will be voided and refunded after ` +
                `${new Date(Number(d.revealDeadline) * 1000).toISOString()}, and a new draw opened`,
            );
          }
          return false;
        }
        // Reveal regardless; open the next draw too only if a key is ready for it.
        if (step.openNext && keyReady()) {
          const sealed = await seeds.create();
          const close = nextClose();
          await chain.requestDraw(step.draw, seed, { salesClose: close, seedCommitment: sealed.commitment });
          this.logger.info(`opened draw ${view.lastDraw + 1n}, selling until ${new Date(Number(close) * 1000).toISOString()}`);
        } else {
          await chain.requestDraw(step.draw, seed);
        }
        return true;
      }
      case 'compute':
        await chain.computeNumbers(step.draw);
        return true;
      case 'settle':
        await chain.settleDraw(step.draw);
        return true;
      case 'pay':
        await chain.payWin(step.line);
        return true;
      case 'void':
        await chain.voidDraw(step.draw);
        return true;
    }
  }

  /** Keep ticking until {@link stop}. */
  start(): void {
    this.engine.start();
  }

  /**
   * Stop; resolves after any pass in progress finishes. Background proofs are
   * not waited for; the next keeper simply starts them again.
   */
  stop(): Promise<void> {
    return this.engine.stop();
  }

  /** Wait for background steps (for tests). */
  settled(): Promise<void> {
    return this.engine.settled();
  }
}
