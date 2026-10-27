/**
 * Watching the wallet's sync for a stall.
 *
 * On the Preprod soak (25–26 Oct 2026) the keeper's wallet stopped following
 * the chain every few hours, after one of Blockfrost's frequent WebSocket
 * drops: its fee proofs then referred to an old DUST state and every
 * transaction was refused (node error 1010, custom 170, InvalidDustSpendProof)
 * until a restart. This samples how far each part of the wallet has applied
 * the chain's events. On Preprod new DUST events arrive every minute or so, so
 * a wallet whose positions haven't moved for many minutes has stopped
 * following, and a restart (a fresh subscription) is due.
 */

type Progress = { appliedIndex?: bigint; appliedId?: bigint; highestIndex?: bigint; highestRelevantWalletIndex?: bigint; highestTransactionId?: bigint };
type StateLike = {
  isSynced?: boolean;
  shielded?: { state?: { progress?: Progress } };
  dust?: { state?: { progress?: Progress } };
  unshielded?: { progress?: Progress };
};
type Subscribable = { subscribe(next: (s: unknown) => void): { unsubscribe(): void } };

/** The wallet's applied positions, one per part ("shielded:123|unshielded:4|dust:567"). */
export const positionsOf = (state: unknown): string => {
  const s = state as StateLike;
  const pos = (p: Progress | undefined) => String(p?.appliedIndex ?? p?.appliedId ?? '?');
  return `shielded:${pos(s.shielded?.state?.progress)}|unshielded:${pos(s.unshielded?.progress)}|dust:${pos(s.dust?.state?.progress)}`;
};

/** Tracks when the wallet's positions last moved. */
export class SyncWatch {
  private last = '';
  private movedAt: number;
  private moves = 0;

  constructor(private readonly clock: () => number = Date.now) {
    this.movedAt = clock();
  }

  /** Feed a wallet state. */
  see(state: unknown): void {
    const p = positionsOf(state);
    if (p !== this.last) {
      if (this.last !== '') this.moves += 1;
      this.last = p;
      this.movedAt = this.clock();
    }
  }

  /** Minutes since the positions last moved. */
  stalledMinutes(): number {
    return (this.clock() - this.movedAt) / 60_000;
  }

  /** Positions now, and how many times they moved since the last call. */
  summary(): { positions: string; moves: number } {
    const out = { positions: this.last, moves: this.moves };
    this.moves = 0;
    return out;
  }
}

/**
 * Watch a wallet: log its positions every `reportMinutes`, and resolve when
 * they haven't moved for `stallMinutes` (0 = never).
 */
export const watchSync = (
  wallet: { wallet: { state(): Subscribable } },
  opts: { stallMinutes: number; reportMinutes?: number; logger: { info(m: string): void; error(m: string): void } },
): { stalled: Promise<boolean>; stop(): void } => {
  const watch = new SyncWatch();
  const sub = wallet.wallet.state().subscribe((s) => watch.see(s));
  let lastReport = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stalled = new Promise<boolean>((resolve) => {
    timer = setInterval(() => {
      if (Date.now() - lastReport >= (opts.reportMinutes ?? 30) * 60_000) {
        lastReport = Date.now();
        const s = watch.summary();
        opts.logger.info(`wallet sync: ${s.positions} (moved ${s.moves} times since the last report)`);
      }
      if (opts.stallMinutes > 0 && watch.stalledMinutes() >= opts.stallMinutes) {
        opts.logger.error(
          `the wallet's sync hasn't moved for ${Math.round(watch.stalledMinutes())} minutes (${watch.summary().positions}); restarting to resync it`,
        );
        resolve(true);
      }
    }, 30_000);
  });
  return {
    stalled,
    stop: () => {
      if (timer) clearInterval(timer);
      sub.unsubscribe();
    },
  };
};

/**
 * Resolves once the wallet has applied new chain events and says it's synced:
 * after a refusal for stale coins (Custom error 170), proof that it's
 * following the chain again. Rejects if that doesn't happen within `ms` (the
 * subscription has probably died; a restart fixes it).
 */
export const caughtUp = (states: Subscribable, ms = 180_000): Promise<void> =>
  new Promise((resolve, reject) => {
    let first: string | undefined;
    let sub: { unsubscribe(): void } | undefined;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // subscribe() may call back before it returns.
      queueMicrotask(() => sub?.unsubscribe());
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`the wallet didn't catch up with the chain within ${Math.round(ms / 60_000)} minutes`)), ms);
    sub = states.subscribe((state) => {
      const p = positionsOf(state);
      if (first === undefined) first = p;
      else if (p !== first && (state as StateLike).isSynced) finish();
    });
  });
