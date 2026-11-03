/**
 * Buying Starfall tickets: what `starfall buy`, `starfall agent` and the agent
 * kit (`lunardraw-agent`) share.
 *
 * Purchases take the draw's next ticket indexes, and the index is fixed when
 * the transaction is built: if another purchase lands first, the contract
 * refuses ours (the transaction is in a block, its fee paid, but its contract
 * part fails: "FailFallible"). That's not a fault, only a collision, so
 * `buyWithRetry` builds the rest again after a short random pause.
 */
import { Starfall } from '@lunardraw/contract';
import type { Session } from '@nightcast/deploy';
import { DEFAULT_PROVER, hostedProofProvider } from './hosted-prover.js';
import { BuyStopped, buyGames, onChainCheck, type StarfallCalls, starfallProviders } from './starfall.js';

/** `--prover <url>`, or `hosted` for Lunardraw's player prover: buy without a proof server. */
export const proverArg = (v: string | undefined): string | undefined => (v === undefined ? undefined : v === 'hosted' ? DEFAULT_PROVER : v);

/**
 * `target` with `method` timed: `say(seconds)` once it finishes. Every other
 * property passes through (methods bound to the original, so class instances
 * with private fields still work).
 */
export const timedMethod = <T extends object>(target: T, method: string, say: (secs: string, failed: boolean) => void, now: () => number = Date.now): T =>
  new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t) as unknown;
      if (typeof v !== 'function') return v;
      if (prop !== method) return v.bind(t);
      return async (...args: unknown[]) => {
        const start = now();
        const secs = () => ((now() - start) / 1000).toFixed(0);
        try {
          const r = await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
          say(secs(), false);
          return r;
        } catch (err) {
          say(secs(), true);
          throw err;
        }
      };
    },
  });

/** Each step of a purchase, timed, so a slow one shows which part was slow. */
export const timedSteps = <P extends { proofProvider: object; walletProvider: object; midnightProvider: object; publicDataProvider: object }>(providers: P, log: (m: string) => void): P => ({
  ...providers,
  proofProvider: timedMethod(providers.proofProvider, 'proveTx', (s, f) => log(`the ticket's proof ${f ? 'failed after' : 'took'} ${s} s`)),
  walletProvider: timedMethod(providers.walletProvider, 'balanceTx', (s, f) => log(`the wallet's fees ${f ? 'failed after' : 'took'} ${s} s`)),
  midnightProvider: timedMethod(providers.midnightProvider, 'submitTx', (s, f) => log(f ? `submitting failed after ${s} s` : `submitted in ${s} s; waiting for it on the chain`)),
  publicDataProvider: timedMethod(providers.publicDataProvider, 'watchForTxData', (s, f) => log(`${f ? 'watching for it failed after' : 'on the chain after'} ${s} s`)),
});

/** A buyer's providers: proofs from the proof server, or from the remote prover when one is given. */
export const buyerProviders = (session: Session, wallet: Parameters<typeof starfallProviders>[1], prover: string | undefined) => {
  const providers = starfallProviders(session, wallet);
  const log = (m: string) => session.logger.info(m);
  if (!prover) return timedSteps(providers, log);
  const proofProvider = hostedProofProvider(prover, {
    onWait: (status, secs) => session.logger.info(`the prover is ${status === 429 ? 'limiting this address' : 'busy'}; trying again in ${secs} s`),
  });
  return timedSteps({ ...providers, proofProvider: proofProvider as unknown as typeof providers.proofProvider }, log);
};

/** A refusal worth building again: the contract refused the purchase (another one took its ticket index), nothing more. */
export const isCollision = (message: string): boolean => /FailFallible|SegmentFail|custom error: 104\b/i.test(message);

/**
 * The node never took the purchase (every try to send it failed on the
 * connection), so the wallet gave its coins back and it can be built again.
 * Not a purchase that was sent and then not seen in time: that one may still land.
 */
export const isNotSent = (message: string): boolean =>
  !/didn't land within/.test(message) && /no answer from the node|disconnected from|Abnormal Closure|WebSocket is not connected|ConnectionError/i.test(message);

export type RetryOptions = {
  /** Most attempts in all (default 3). */
  attempts?: number;
  /** Stop sending this many seconds before sales close (default 60). */
  closeMarginSecs?: number;
  /** Pause before a retry (ms), random up to this (default 45 s, at least 10 s). */
  pauseMs?: number;
  /** How long one purchase may take, proof to landing (ms; buyGames' default, 5 minutes, if left out). */
  timeoutMs?: number;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Buy `tickets` (built for one draw), building again what a collision
 * refused. Resolves to how many went in and in how many transactions; throws
 * BuyStopped (with `bought` so far) when it gives up.
 */
export const buyWithRetry = async (
  contract: StarfallCalls,
  providers: { privateStateProvider: Parameters<typeof buyGames>[1]; publicDataProvider: Parameters<typeof onChainCheck>[0] },
  contractAddress: string,
  tickets: readonly Starfall.TicketPreimage[],
  refundTo: Uint8Array,
  salesClose: bigint,
  o: RetryOptions = {},
): Promise<{ bought: number; txs: number; attempts: number }> => {
  const attempts = o.attempts ?? 3;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const stopAt = Number(salesClose) - (o.closeMarginSecs ?? 60);
  let bought = 0;
  let txs = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      txs += await buyGames(contract, providers.privateStateProvider, contractAddress, tickets.slice(bought), refundTo, {
        onEach: (done, of) => o.log?.(`bought ${bought + done} of ${bought + of} ticket(s)`),
        stopAt,
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        onChain: onChainCheck(providers.publicDataProvider, contractAddress),
      });
      return { bought: tickets.length, txs, attempts: attempt };
    } catch (err) {
      if (!(err instanceof BuyStopped)) throw err;
      txs += Math.ceil(err.bought / Number(Starfall.pureCircuits.maxTickets()));
      bought += err.bought;
      const timeLeft = stopAt - now() / 1000 > 120;
      const collision = isCollision(err.message);
      if (attempt >= attempts || !(collision || isNotSent(err.message)) || !timeLeft) throw new BuyStopped(bought, tickets.length, err.message);
      const pause = Math.max(10_000, Math.floor(Math.random() * (o.pauseMs ?? 45_000)));
      const why = collision ? 'another purchase took that ticket number first' : "the node couldn't be reached to send it";
      o.log?.(`${why}; building the rest again in ${Math.round(pause / 1000)} s (attempt ${attempt + 1} of ${attempts})`);
      await sleep(pause);
    }
  }
};
