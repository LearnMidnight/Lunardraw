/**
 * The draw oracle: answers Lunardraw's draws with Nightcast's VRF.
 *
 * Once the keeper reveals a draw's seed, the draw waits for the oracle to
 * prove `gamma = H·sk` in `fulfilDraw` before its draw deadline. This watches
 * for requested draws bound to its key and answers each once. It allows for
 * an indexer that is a little ahead of the node (a new request) or behind
 * the chain (a draw it has just answered), as Nightcast's oracle does.
 *
 * Run it on a different machine, by a different person, with a different key
 * from the keeper: the organiser and the oracle together could know a draw's
 * numbers before sales close.
 */
import { DrawStatus } from '@lunardraw/contract';
import type { ChainView, DrawOracleChain } from './chain.js';
import { type FailureStreak, type KeeperLogger, reasonOf, StreakCounter } from './keeper.js';

export type DrawOracleOptions = {
  chain: DrawOracleChain;
  /** The oracle's public key; only draws requested with this key are answered. */
  publicKey: { x: bigint; y: bigint };
  /** Don't start a fulfil with less than this many seconds to the draw deadline. Default 120. */
  safetyMarginSecs?: number;
  /** Wait this long (ms) after first seeing a requested draw. Default 20 s. */
  newRequestDelayMs?: number;
  /** Don't answer the same draw again within this long (ms) of answering it. Default 10 minutes. */
  answeredGraceMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  pollMs?: number;
  logger?: KeeperLogger;
  clock?: () => number;
};

export type OracleReport = { fulfilled: bigint[]; failed: { draw: bigint; error: string }[]; skipped: { draw: bigint; reason: string }[] };

const silent: KeeperLogger = { info() {}, warn() {}, error() {} };

/** Requested draws this oracle should answer at chain time `now`. */
export const drawsToAnswer = (view: ChainView, key: { x: bigint; y: bigint }, now: number, safetyMarginSecs: number) =>
  view.draws.filter(
    (d) =>
      d.status === DrawStatus.requested &&
      d.oracleKey.x === key.x &&
      d.oracleKey.y === key.y &&
      d.drawDeadline > BigInt(Math.floor(now) + safetyMarginSecs),
  );

export class DrawOracle {
  private readonly cfg: Required<Omit<DrawOracleOptions, 'chain' | 'publicKey' | 'logger'>>;
  private readonly logger: KeeperLogger;
  private readonly firstSeen = new Map<bigint, number>();
  private readonly answered = new Map<bigint, number>();
  private readonly failures = new Map<bigint, { failures: number; nextTryAt: number }>();
  private busy: Promise<OracleReport> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly streak: StreakCounter;

  constructor(private readonly options: DrawOracleOptions) {
    this.cfg = {
      safetyMarginSecs: options.safetyMarginSecs ?? 120,
      newRequestDelayMs: options.newRequestDelayMs ?? 20_000,
      answeredGraceMs: options.answeredGraceMs ?? 10 * 60_000,
      backoffMs: options.backoffMs ?? 5_000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      pollMs: options.pollMs ?? 5_000,
      clock: options.clock ?? Date.now,
    };
    this.logger = options.logger ?? silent;
    this.streak = new StreakCounter(this.cfg.clock);
  }

  /** Answers failing in a row (see {@link FailureStreak}). */
  status(): { streak: FailureStreak } {
    return { streak: this.streak.get() };
  }

  tick(): Promise<OracleReport> {
    if (!this.busy) {
      this.busy = this.doTick().finally(() => {
        this.busy = undefined;
      });
    }
    return this.busy;
  }

  private async doTick(): Promise<OracleReport> {
    const { chain, publicKey } = this.options;
    const report: OracleReport = { fulfilled: [], failed: [], skipped: [] };
    const [view, now] = await Promise.all([chain.view(), chain.now()]);
    const todo = drawsToAnswer(view, publicKey, now, this.cfg.safetyMarginSecs);
    const live = new Set(todo.map((d) => d.id));
    for (const m of [this.firstSeen, this.answered, this.failures]) for (const id of m.keys()) if (!live.has(id)) m.delete(id);

    for (const d of todo) {
      const at = this.cfg.clock();
      if (!this.firstSeen.has(d.id)) this.firstSeen.set(d.id, at);
      if (at - this.firstSeen.get(d.id)! < this.cfg.newRequestDelayMs) {
        report.skipped.push({ draw: d.id, reason: 'new; letting the node catch up' });
        continue;
      }
      const answeredAt = this.answered.get(d.id);
      if (answeredAt !== undefined && at - answeredAt < this.cfg.answeredGraceMs) {
        report.skipped.push({ draw: d.id, reason: 'answered; waiting for the indexer' });
        continue;
      }
      const failed = this.failures.get(d.id);
      if (failed && at < failed.nextTryAt) {
        report.skipped.push({ draw: d.id, reason: 'backing off' });
        continue;
      }
      // Proving takes time: check the deadline again right before.
      if (d.drawDeadline <= BigInt(Math.floor(await chain.now()) + this.cfg.safetyMarginSecs)) {
        report.skipped.push({ draw: d.id, reason: 'too close to its deadline' });
        continue;
      }
      try {
        const startedAt = Date.now();
        await chain.fulfilDraw(d.id);
        this.answered.set(d.id, this.cfg.clock());
        this.failures.delete(d.id);
        this.streak.ok();
        report.fulfilled.push(d.id);
        this.logger.info(`answered draw ${d.id} (${Math.round((Date.now() - startedAt) / 1000)} s)`);
      } catch (err) {
        const error = reasonOf(err);
        const n = (failed?.failures ?? 0) + 1;
        const delay = Math.min(this.cfg.backoffMs * 2 ** (n - 1), this.cfg.maxBackoffMs);
        this.failures.set(d.id, { failures: n, nextTryAt: this.cfg.clock() + delay });
        this.streak.failed();
        report.failed.push({ draw: d.id, error });
        this.logger.error(`could not answer draw ${d.id} (attempt ${n}, retrying in ${Math.round(delay / 1000)} s): ${error}`);
      }
    }
    return report;
  }

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

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.busy) await this.busy.catch(() => undefined);
  }
}
