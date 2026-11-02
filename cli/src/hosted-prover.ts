/**
 * Proving ticket purchases with Lunardraw's player prover, so an agent needs
 * no proof server and no proving keys of its own.
 *
 * The player prover (player-prover/gateway.mjs on the keeper VM) holds the
 * buyTickets proving key and takes only a proof's preimage: the ticket being
 * bought. It never sees the draw seed, the oracle key or the settlement key,
 * so it can't learn or steer a result. It proves `buyTickets` only, and answers
 * 503 (busy) or 429 (too many from one address) with Retry-After, which this
 * waits out for up to `waitMs`.
 *
 * Same protocol as the website's purchase engine (siteProvingProvider).
 */
import { CostModel, parseCheckResult } from '@midnight-ntwrk/midnight-js-protocol/ledger';

/** Lunardraw's player prover. */
export const DEFAULT_PROVER = 'https://prover.207-180-249-120.sslip.io';

export type HostedProverOptions = {
  /** How long to keep waiting while the prover is busy (ms). Default 3 minutes. */
  waitMs?: number;
  /** Called each time the prover says it's busy. */
  onWait?: (status: number, retryInSecs: number) => void;
  fetcher?: typeof fetch;
  /** One request's time limit (ms): proving takes 15-40 s, plus a queue. Default 6 minutes. */
  timeoutMs?: number;
};

const baseOf = (url: string): string => {
  const base = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(base)) throw new Error(`not a prover address: ${url}`);
  return base;
};

/** POST a preimage, waiting out "busy" answers. */
const poster = (base: string, opts: HostedProverOptions) => async (path: string, body: Uint8Array): Promise<Uint8Array> => {
  const fetcher = opts.fetcher ?? fetch;
  const until = Date.now() + (opts.waitMs ?? 3 * 60_000);
  for (;;) {
    const r = await fetcher(`${base}${path}`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6 * 60_000),
    });
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
    const text = await r.text().catch(() => '');
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error || text;
    } catch {
      /* not JSON */
    }
    if ((r.status === 503 || r.status === 429) && Date.now() < until) {
      const wait = Math.min(30, Math.max(3, Number(r.headers.get('Retry-After')) || 5));
      opts.onWait?.(r.status, wait);
      await new Promise((res) => setTimeout(res, wait * 1000));
      continue;
    }
    throw new Error(`Lunardraw's prover couldn't prove this purchase (HTTP ${r.status}): ${msg.slice(0, 300)}`);
  }
};

/** The ledger's ProvingProvider (check and prove a preimage), backed by the player prover. */
export const hostedProvingProvider = (url: string, opts: HostedProverOptions = {}) => {
  const base = baseOf(url);
  const post = poster(base, opts);
  return {
    async check(preimage: Uint8Array, keyLocation: string) {
      return parseCheckResult(await post(`/check/${encodeURIComponent(keyLocation)}`, preimage));
    },
    async prove(preimage: Uint8Array, keyLocation: string, overwriteBindingInput?: bigint) {
      const q = overwriteBindingInput === undefined ? '' : `?binding=${overwriteBindingInput.toString()}`;
      return post(`/prove/${encodeURIComponent(keyLocation)}${q}`, preimage);
    },
  };
};

type Provable = { prove(provider: ReturnType<typeof hostedProvingProvider>, costModel: unknown): Promise<unknown> };

/**
 * midnight-js's ProofProvider, proving through the player prover: use it in
 * place of `httpClientProofProvider` for buying tickets (the only circuit the
 * player prover proves).
 */
export const hostedProofProvider = (url: string, opts: HostedProverOptions = {}) => {
  const provider = hostedProvingProvider(url, opts);
  return {
    async proveTx(unproven: Provable) {
      return unproven.prove(provider, CostModel.initialCostModel());
    },
  };
};

/** Whether the prover is up (its /health says ok). */
export const proverHealth = async (url: string, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> => {
  try {
    const r = await fetcher(`${baseOf(url)}/health`, { signal: AbortSignal.timeout(10_000) });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; circuit?: string; active?: number; queued?: number };
    return { ok: r.ok && body.ok === true, detail: r.ok ? `circuit ${body.circuit ?? '?'}, ${body.active ?? 0} proving, ${body.queued ?? 0} waiting` : `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
};
