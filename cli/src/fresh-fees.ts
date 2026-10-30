/**
 * Pay transaction fees from the wallet's latest DUST, and pay again (without
 * proving the circuit again) when the node refuses the fee proof as stale.
 *
 * midnight-js sends a call in three steps: prove the circuit (the proof
 * server; about 170 s for Starfall's computeNumbers), balance it (the wallet
 * adds the DUST fee and proves that spend), submit. The node refuses a fee
 * proof built against an out-of-date DUST view with `1010 custom error 170`
 * (InvalidDustSpendProof). On Preprod that happened to almost every
 * transaction in the minutes after each hourly close, and each refusal cost
 * the whole circuit proof again.
 *
 * `withFreshFees` wraps the wallet and submission providers so that:
 * - balancing waits for the wallet to reach the tip (`beforeBalance`);
 * - a submission refused as stale is balanced again from the same proven
 *   transaction and resubmitted, up to `retries` times, a short pause apart.
 * Anything else (or a failed re-balance) is thrown as before, so the
 * keeper's own retry still applies.
 */

type Logger = { info(msg: string): void; warn?(msg: string): void };

export interface FreshFeeOptions {
  /** Resolves when the wallet's DUST view is current (waitForTip). */
  beforeBalance: () => Promise<unknown>;
  /** Whether a submission error is a stale fee proof (isStaleDustProof). */
  isStale: (err: unknown) => boolean;
  retries?: number;
  pauseMs?: number;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

interface Providers<W, M> {
  walletProvider: W;
  midnightProvider: M;
}

/** A proxy of `target` with one method replaced; other members stay bound to the original. */
const overriding = <T extends object>(target: T, name: string, fn: (...args: never[]) => unknown): T =>
  new Proxy(target, {
    get(t, p) {
      if (p === name) return fn;
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });

export const withFreshFees = <
  P extends Providers<W, M>,
  W extends { balanceTx(tx: never, ...rest: never[]): Promise<unknown> } = P['walletProvider'],
  M extends { submitTx(tx: never): Promise<unknown> } = P['midnightProvider'],
>(
  providers: P,
  opts: FreshFeeOptions,
): P => {
  const retries = opts.retries ?? 3;
  const pauseMs = opts.pauseMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const wallet = providers.walletProvider as unknown as { balanceTx(...a: unknown[]): Promise<unknown> };
  const midnight = providers.midnightProvider as unknown as { submitTx(tx: unknown): Promise<unknown> };
  /** Balanced transaction → what it was balanced from. */
  const sources = new WeakMap<object, unknown[]>();

  const balance = async (...args: unknown[]): Promise<unknown> => {
    await opts.beforeBalance();
    const balanced = await wallet.balanceTx(...args);
    if (balanced && typeof balanced === 'object') sources.set(balanced, args);
    return balanced;
  };

  const submit = async (tx: unknown): Promise<unknown> => {
    try {
      return await midnight.submitTx(tx);
    } catch (first) {
      const args = tx && typeof tx === 'object' ? sources.get(tx) : undefined;
      if (!args || !opts.isStale(first)) throw first;
      let err: unknown = first;
      for (let i = 1; i <= retries && opts.isStale(err); i++) {
        opts.logger?.info(`the node refused the fee proof as stale (custom error 170); paying the fee again from the latest DUST (try ${i} of ${retries})`);
        await sleep(pauseMs);
        let again: unknown;
        try {
          again = await balance(...args);
        } catch (e) {
          opts.logger?.warn?.(`could not pay the fee again: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
          throw first;
        }
        try {
          const result = await midnight.submitTx(again);
          opts.logger?.info(`fee paid again on try ${i}; transaction accepted`);
          return result;
        } catch (e) {
          err = e;
        }
      }
      throw err;
    }
  };

  return {
    ...providers,
    walletProvider: overriding(providers.walletProvider as object, 'balanceTx', balance as never) as W,
    midnightProvider: overriding(providers.midnightProvider as object, 'submitTx', submit as never) as M,
  } as P;
};
