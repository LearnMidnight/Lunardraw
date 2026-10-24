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
 * An error's message and its causes, one line, for logs. midnight-js wraps
 * the reason a circuit failed (an assertion, a missing witness) as a cause.
 */
export const reasonOf = (err: unknown, max = 600): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current) && parts.length < 6) {
    seen.add(current);
    const message = current instanceof Error ? current.message : typeof current === 'string' ? current : JSON.stringify(current);
    const line = String(message).split('\n')[0].trim();
    if (line && !parts.includes(line)) parts.push(line);
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  const text = parts.join(': ') || 'unknown error';
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

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
  return steps;
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

export type KeeperLogger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export type KeeperOptions = {
  chain: LunardrawChain;
  seeds: SeedStore;
  schedule: Schedule;
  marginSecs?: number;
  openNew?: boolean;
  /** How often to look, in ms. Default 30 s. */
  pollMs?: number;
  /**
   * After a step succeeds, don't send it again for this long (ms) even if the
   * indexer still shows it as due: it lags behind the chain. Default 5 minutes.
   */
  doneGraceMs?: number;
  /** First retry delay after a failed step, doubling up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  logger?: KeeperLogger;
  /** Local clock in ms (for grace and backoff). */
  clock?: () => number;
  /** Called with the contract's state after every pass (used to publish the site feed). */
  onView?: (view: ChainView, nowSecs: number) => void;
};

export type TickReport = { done: string[]; failed: { step: string; error: string }[]; skipped: { step: string; reason: string }[] };

export type KeeperStatus = {
  /** When the last pass finished (ms), and whether it could read the chain. */
  lastTickAt?: number;
  lastTickOk: boolean;
  /** Steps that keep failing, with their failure counts. */
  failing: { step: string; failures: number; error: string }[];
};

const silent: KeeperLogger = { info() {}, warn() {}, error() {} };

export class Keeper {
  private readonly cfg: Required<Omit<KeeperOptions, 'logger' | 'chain' | 'seeds' | 'schedule'>>;
  private readonly logger: KeeperLogger;
  private readonly done = new Map<string, number>();
  private readonly failures = new Map<string, { failures: number; nextTryAt: number; error: string }>();
  private readonly warned = new Set<string>();
  private busy: Promise<TickReport> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastTickAt: number | undefined;
  private lastTickOk = false;

  constructor(private readonly options: KeeperOptions) {
    this.cfg = {
      onView: options.onView ?? (() => {}),
      marginSecs: options.marginSecs ?? 30,
      openNew: options.openNew ?? true,
      pollMs: options.pollMs ?? 30_000,
      doneGraceMs: options.doneGraceMs ?? 5 * 60_000,
      backoffMs: options.backoffMs ?? 10_000,
      maxBackoffMs: options.maxBackoffMs ?? 5 * 60_000,
      clock: options.clock ?? Date.now,
    };
    this.logger = options.logger ?? silent;
  }

  /** One pass: read the chain, send every due step. Never runs twice at once. */
  tick(): Promise<TickReport> {
    if (!this.busy) {
      this.busy = this.doTick().finally(() => {
        this.busy = undefined;
      });
    }
    return this.busy;
  }

  status(): KeeperStatus {
    return {
      lastTickAt: this.lastTickAt,
      lastTickOk: this.lastTickOk,
      failing: [...this.failures].map(([step, f]) => ({ step, failures: f.failures, error: f.error })),
    };
  }

  private async doTick(): Promise<TickReport> {
    const { chain } = this.options;
    const report: TickReport = { done: [], failed: [], skipped: [] };
    let view: ChainView;
    let now: number;
    try {
      [view, now] = await Promise.all([chain.view(), chain.now()]);
    } catch (err) {
      this.lastTickOk = false;
      this.lastTickAt = this.cfg.clock();
      throw err;
    }
    try {
      this.cfg.onView(view, now);
    } catch (err) {
      this.logger.error(`publishing the view failed: ${reasonOf(err)}`);
    }
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
    const steps = dueSteps(view, now, { marginSecs: this.cfg.marginSecs, openNew: this.cfg.openNew });
    const keys = new Set(steps.map((s) => stepKey(s, view.lastDraw)));
    // Forget steps that are no longer due.
    for (const k of this.done.keys()) if (!keys.has(k)) this.done.delete(k);
    for (const k of this.failures.keys()) if (!keys.has(k)) this.failures.delete(k);

    for (const step of steps) {
      const key = stepKey(step, view.lastDraw);
      const at = this.cfg.clock();
      const doneAt = this.done.get(key);
      if (doneAt !== undefined && at - doneAt < this.cfg.doneGraceMs) {
        report.skipped.push({ step: key, reason: 'sent; waiting for the indexer' });
        continue;
      }
      const failed = this.failures.get(key);
      if (failed && at < failed.nextTryAt) {
        report.skipped.push({ step: key, reason: 'backing off' });
        continue;
      }
      try {
        const startedAt = Date.now();
        const sent = await this.run(step, view, now);
        if (!sent) {
          report.skipped.push({ step: key, reason: 'cannot be sent' });
          continue;
        }
        this.done.set(key, this.cfg.clock());
        this.failures.delete(key);
        report.done.push(key);
        // How long the proof and the transaction took (wall clock), for capacity planning.
        this.logger.info(`done: ${describeStep(step)} (${Math.round((Date.now() - startedAt) / 1000)} s)`);
      } catch (err) {
        const error = reasonOf(err);
        const n = (failed?.failures ?? 0) + 1;
        const delay = Math.min(this.cfg.backoffMs * 2 ** (n - 1), this.cfg.maxBackoffMs);
        this.failures.set(key, { failures: n, nextTryAt: this.cfg.clock() + delay, error });
        report.failed.push({ step: key, error });
        this.logger.error(`could not ${describeStep(step)} (attempt ${n}, retrying in ${Math.round(delay / 1000)} s): ${error}`);
      }
    }
    this.lastTickOk = true;
    this.lastTickAt = this.cfg.clock();
    return report;
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
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.logger.error(`could not read the contract: ${reasonOf(err)}`);
      }
      if (this.running) this.timer = setTimeout(loop, this.cfg.pollMs);
    };
    void loop();
  }

  /** Stop; resolves after any pass in progress finishes. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.busy) await this.busy.catch(() => undefined);
  }
}
