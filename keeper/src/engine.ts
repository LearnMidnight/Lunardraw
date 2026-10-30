/**
 * The machinery shared by the keepers: read the contract, work out which
 * steps are due, send them, and remember what was sent and what failed.
 *
 * A step that succeeds isn't sent again for a grace period (the indexer lags
 * behind the chain); one that fails is retried with a doubling delay. Steps of
 * the `background` kinds are started and not waited for, so a slow proof
 * never holds up an urgent step. With two keepers on one deployment, each
 * sends its own steps (`mine`) straight away and the other keeper's only once
 * they have been due for `takeOverAfterMs`: the standby steps in when the
 * primary stops making progress.
 */

export type KeeperLogger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export type TickReport = { done: string[]; failed: { step: string; error: string }[]; skipped: { step: string; reason: string }[] };

/**
 * An error's message and its causes, one line, for logs. midnight-js wraps
 * the reason a circuit failed (an assertion, a missing witness) as a cause.
 */
/**
 * Node error 1010 custom 170, InvalidDustSpendProof: the wallet built the fee
 * proof a moment before it had synced the latest DUST events. Nothing is wrong
 * with the step; rebuilding a few seconds later lands. Backing off
 * exponentially on it turned seconds of lag into minutes (Preprod, 30 Oct 2026).
 */
export const isStaleDustProof = (error: string): boolean => /custom error: 170\b/i.test(error);
const QUICK_RETRY_MS = 15_000;

export const reasonOf = (err: unknown, max = 600): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current) && parts.length < 6) {
    seen.add(current);
    const obj = typeof current === 'object' ? (current as { message?: unknown; cause?: unknown }) : undefined;
    const message = obj && typeof obj.message === 'string' ? obj.message : typeof current === 'string' ? current : JSON.stringify(current);
    // one line: a pretty-printed JSON message would otherwise read as "{"
    const line = String(message).replace(/\s+/g, ' ').trim();
    if (line && !parts.includes(line)) parts.push(line);
    // follow `cause` whatever the class: effect's errors don't always pass instanceof Error
    current = obj?.cause;
  }
  const text = parts.join(': ') || 'unknown error';
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

/**
 * Transactions that keep failing with nothing succeeding in between: when the
 * streak began (local clock, ms) and how long it is. A wallet whose sync has
 * gone stale fails every fee proof (node error 1010 custom 170), so a long
 * streak is the cue to restart and resync.
 */
export type FailureStreak = { since?: number; failures: number; lastSuccessAt?: number };

export class StreakCounter {
  private since: number | undefined;
  private failures = 0;
  private lastSuccessAt: number | undefined;

  constructor(private readonly clock: () => number) {}

  ok(): void {
    this.since = undefined;
    this.failures = 0;
    this.lastSuccessAt = this.clock();
  }

  failed(): void {
    if (this.failures === 0) this.since = this.clock();
    this.failures += 1;
  }

  get(): FailureStreak {
    return { since: this.since, failures: this.failures, lastSuccessAt: this.lastSuccessAt };
  }
}

export type KeeperStatus = {
  /** When the last pass finished (ms), and whether it could read the chain. */
  lastTickAt?: number;
  lastTickOk: boolean;
  /** Transactions failing in a row. */
  streak: FailureStreak;
  /** Steps that keep failing, with their failure counts. */
  failing: { step: string; failures: number; error: string }[];
};

export type EngineTiming = {
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
  /** Local clock in ms (for grace, backoff and take-over). */
  clock?: () => number;
  logger?: KeeperLogger;
};

export type EngineOptions<V, S extends { kind: string }> = EngineTiming & {
  /** The contract's state and chain time (seconds). */
  read(): Promise<[V, number]>;
  /** Housekeeping before planning (warnings, tidying the seed store). Errors are the hook's to handle. */
  beforePlan?(view: V, now: number): Promise<void>;
  /** The steps due, most urgent first. */
  plan(view: V, now: number): S[];
  /** A step's identity: the same key means the same transaction. */
  key(step: S, view: V): string;
  describe(step: S): string;
  /** Send one step; false if it can't be sent (the runner says why). */
  run(step: S, view: V, now: number): Promise<boolean>;
  /** Called with the contract's state after every pass (used to publish the site feed). */
  onView?: (view: V, nowSecs: number) => void;
  /** Step kinds started in a pass but not waited for (slow proofs). */
  background?: string[];
  /**
   * At most this many background steps at once (default: no limit). Each big
   * proof takes about 7 GB on Midnight's proof server, so a keeper on one
   * small server proves them one at a time.
   */
  backgroundLimit?: number;
  /**
   * Wait this long (ms) after a background step ends before starting another
   * (default 0): the proof server keeps memory after a proof, and its
   * supervisor restarts it only once it has been idle for a few seconds.
   */
  backgroundGapMs?: number;
  /**
   * Whether a step is this keeper's to send straight away. Other steps wait
   * until they have been due for `takeOverAfterMs`. Default: every step.
   */
  mine?: (step: S) => boolean;
  takeOverAfterMs?: number;
  /**
   * Steps of these kinds (payments, refunds) can number hundreds: send at
   * most `perPass` of them in one pass, so urgent steps are looked at again
   * in between.
   */
  bulk?: { kinds: string[]; perPass: number };
};

const silent: KeeperLogger = { info() {}, warn() {}, error() {} };

export class StepEngine<V, S extends { kind: string }> {
  private readonly clock: () => number;
  private readonly logger: KeeperLogger;
  private readonly pollMs: number;
  private readonly doneGraceMs: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly done = new Map<string, number>();
  private readonly failures = new Map<string, { failures: number; nextTryAt: number; error: string }>();
  /** When each due step was first seen due (local clock), for take-over. */
  private readonly firstSeen = new Map<string, number>();
  private readonly tookOver = new Set<string>();
  /** When this keeper last sent (or tried) a step that wasn't its own. */
  private lastTakeOverAt: number | undefined;
  private busy: Promise<TickReport> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastTickAt: number | undefined;
  private lastTickOk = false;
  /** Background steps still running, by step key. */
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly streak: StreakCounter;
  /** Background steps that finished since the last pass, for its report. */
  private readonly finished: { key: string; error?: string }[] = [];
  /** When the last background step ended (local clock). */
  private lastBackgroundEndAt: number | undefined;

  constructor(private readonly options: EngineOptions<V, S>) {
    this.clock = options.clock ?? Date.now;
    this.logger = options.logger ?? silent;
    this.pollMs = options.pollMs ?? 30_000;
    this.doneGraceMs = options.doneGraceMs ?? 5 * 60_000;
    this.backoffMs = options.backoffMs ?? 10_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
    this.streak = new StreakCounter(this.clock);
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
      streak: this.streak.get(),
      failing: [...this.failures].map(([step, f]) => ({ step, failures: f.failures, error: f.error })),
    };
  }

  /** Background steps still running (their step keys). */
  inProgress(): string[] {
    return [...this.inFlight.keys()];
  }

  private async doTick(): Promise<TickReport> {
    const o = this.options;
    const report: TickReport = { done: [], failed: [], skipped: [] };
    for (const f of this.finished.splice(0)) {
      if (f.error === undefined) report.done.push(f.key);
      else report.failed.push({ step: f.key, error: f.error });
    }
    let view: V;
    let now: number;
    try {
      [view, now] = await o.read();
    } catch (err) {
      this.lastTickOk = false;
      this.lastTickAt = this.clock();
      throw err;
    }
    try {
      o.onView?.(view, now);
    } catch (err) {
      this.logger.error(`publishing the view failed: ${reasonOf(err)}`);
    }
    if (o.beforePlan) await o.beforePlan(view, now);
    const steps = o.plan(view, now);
    const keys = new Set(steps.map((s) => o.key(s, view)));
    // Forget steps that are no longer due.
    for (const k of this.done.keys()) if (!keys.has(k)) this.done.delete(k);
    for (const k of this.failures.keys()) if (!keys.has(k)) this.failures.delete(k);
    for (const k of this.firstSeen.keys()) if (!keys.has(k)) this.firstSeen.delete(k);
    for (const k of this.tookOver) if (!keys.has(k)) this.tookOver.delete(k);
    const seenAt = this.clock();
    for (const k of keys) if (!this.firstSeen.has(k)) this.firstSeen.set(k, seenAt);

    const background = o.background ?? [];
    let bulkSent = 0;
    for (const step of steps) {
      const key = o.key(step, view);
      const at = this.clock();
      if (this.inFlight.has(key)) {
        report.skipped.push({ step: key, reason: 'proving in the background' });
        continue;
      }
      const doneAt = this.done.get(key);
      if (doneAt !== undefined && at - doneAt < this.doneGraceMs) {
        report.skipped.push({ step: key, reason: 'sent; waiting for the indexer' });
        continue;
      }
      if (o.mine && !o.mine(step)) {
        const dueFor = at - (this.firstSeen.get(key) ?? at);
        const after = o.takeOverAfterMs ?? Number.POSITIVE_INFINITY;
        // Once this keeper has had to step in, it keeps going (the next
        // batch, the finalise, the payments) until there's been nothing to
        // take over for a while, rather than waiting again at every step.
        const covering = this.lastTakeOverAt !== undefined && at - this.lastTakeOverAt < after;
        if (dueFor < after && !covering) {
          report.skipped.push({ step: key, reason: "the other keeper's step" });
          continue;
        }
        if (!covering && !this.tookOver.has(key)) {
          this.logger.warn(
            `taking over: ${o.describe(step)} has been due for ${Math.round(dueFor / 60_000)} min and the other keeper hasn't sent it; ` +
              `sending its steps until there's been nothing to take over for ${Math.round(after / 60_000)} min`,
          );
        }
        this.tookOver.add(key);
        this.lastTakeOverAt = at;
      }
      const failed = this.failures.get(key);
      if (failed && at < failed.nextTryAt) {
        report.skipped.push({ step: key, reason: 'backing off' });
        continue;
      }
      const isBulk = o.bulk !== undefined && o.bulk.kinds.includes(step.kind);
      if (isBulk && bulkSent >= o.bulk!.perPass) {
        report.skipped.push({ step: key, reason: 'next pass' });
        continue;
      }
      if (background.includes(step.kind)) {
        if (o.backgroundLimit !== undefined && this.inFlight.size >= o.backgroundLimit) {
          report.skipped.push({ step: key, reason: 'another proof is running' });
          continue;
        }
        if (o.backgroundGapMs && this.lastBackgroundEndAt !== undefined && at - this.lastBackgroundEndAt < o.backgroundGapMs) {
          report.skipped.push({ step: key, reason: 'letting the proof server rest' });
          continue;
        }
        this.startInBackground(step, key, view, now, failed?.failures ?? 0);
        report.skipped.push({ step: key, reason: 'started in the background' });
        continue;
      }
      if (isBulk) bulkSent += 1;
      try {
        const startedAt = Date.now();
        const sent = await o.run(step, view, now);
        if (!sent) {
          report.skipped.push({ step: key, reason: 'cannot be sent' });
          continue;
        }
        this.done.set(key, this.clock());
        this.failures.delete(key);
        this.streak.ok();
        report.done.push(key);
        // How long the proof and the transaction took (wall clock), for capacity planning.
        this.logger.info(`done: ${o.describe(step)} (${Math.round((Date.now() - startedAt) / 1000)} s)`);
      } catch (err) {
        const error = reasonOf(err);
        const n = (failed?.failures ?? 0) + 1;
        const delay = isStaleDustProof(error) ? QUICK_RETRY_MS : Math.min(this.backoffMs * 2 ** (n - 1), this.maxBackoffMs);
        this.failures.set(key, { failures: n, nextTryAt: this.clock() + delay, error });
        this.streak.failed();
        report.failed.push({ step: key, error });
        this.logger.error(`could not ${o.describe(step)} (attempt ${n}, retrying in ${Math.round(delay / 1000)} s): ${error}`);
      }
    }
    this.lastTickOk = true;
    this.lastTickAt = this.clock();
    // Something changed: publish the new state now rather than next pass.
    if (report.done.length > 0) await this.publish();
    return report;
  }

  /** Start a step without waiting for it; its outcome is recorded when it ends. */
  private startInBackground(step: S, key: string, view: V, now: number, failuresSoFar: number): void {
    const o = this.options;
    const startedAt = Date.now();
    this.logger.info(`started: ${o.describe(step)} (in the background)`);
    const job = o.run(step, view, now).then(
      (sent) => {
        if (!sent) return;
        this.done.set(key, this.clock());
        this.failures.delete(key);
        this.streak.ok();
        this.finished.push({ key });
        this.logger.info(`done: ${o.describe(step)} (${Math.round((Date.now() - startedAt) / 1000)} s)`);
        void this.publish();
      },
      (err: unknown) => {
        const error = reasonOf(err);
        const n = failuresSoFar + 1;
        const delay = isStaleDustProof(error) ? QUICK_RETRY_MS : Math.min(this.backoffMs * 2 ** (n - 1), this.maxBackoffMs);
        this.failures.set(key, { failures: n, nextTryAt: this.clock() + delay, error });
        this.streak.failed();
        this.finished.push({ key, error });
        this.logger.error(
          `could not ${o.describe(step)} after ${Math.round((Date.now() - startedAt) / 1000)} s (attempt ${n}, retrying in ${Math.round(delay / 1000)} s): ${error}`,
        );
      },
    );
    this.inFlight.set(
      key,
      job.finally(() => {
        this.inFlight.delete(key);
        this.lastBackgroundEndAt = this.clock();
      }),
    );
  }

  /** Publish the current state through onView (errors logged, never thrown). */
  private async publish(): Promise<void> {
    if (!this.options.onView) return;
    try {
      const [view, now] = await this.options.read();
      this.options.onView(view, now);
    } catch (err) {
      this.logger.error(`publishing the view failed: ${reasonOf(err)}`);
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
      if (this.running) this.timer = setTimeout(loop, this.pollMs);
    };
    void loop();
  }

  /**
   * Stop; resolves after any pass in progress finishes. Background proofs are
   * not waited for (they can take many minutes); stopping the process
   * abandons them, and the next keeper simply starts them again.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.busy) await this.busy.catch(() => undefined);
    if (this.inFlight.size > 0) this.logger.info(`leaving ${[...this.inFlight.keys()].join(', ')} unfinished; the next run starts it again`);
  }

  /** Wait for background steps (for tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }
}
