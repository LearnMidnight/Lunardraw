/**
 * Whether this kit still plays the current Starfall contract.
 *
 * The kit reads the contract's address from the deployment record packed inside
 * it (deployments/starfall-<network>.json). When Starfall is deployed again, the
 * repository's record moves to the new contract, but an installed kit keeps the
 * old one until its owner updates it, and there it finds nothing on sale.
 * So the kit compares its record with the published one and, if they differ,
 * refuses to buy and says how to update. It never switches contracts by itself:
 * an address fetched from the internet must not decide where a wallet's money goes.
 */

/** The published record: the repository's main branch. LUNARDRAW_DEPLOYMENT_URL overrides it (tests). */
export const recordUrl = (network: string, env: NodeJS.ProcessEnv = process.env): string =>
  env.LUNARDRAW_DEPLOYMENT_URL || `https://raw.githubusercontent.com/LearnMidnight/Lunardraw/main/deployments/starfall-${network}.json`;

export type Freshness =
  | { state: 'current'; contract: string }
  | { state: 'outdated'; contract: string; current: string }
  | { state: 'unknown'; contract: string; reason: string };

/** Compare the packed contract with the published one; 'unknown' if it can't be read (offline, say). */
export const checkDeployment = async (
  contract: string,
  network: string,
  o: { fetchFn?: typeof fetch; url?: string; ms?: number } = {},
): Promise<Freshness> => {
  const url = o.url ?? recordUrl(network);
  try {
    const r = await (o.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(o.ms ?? 8_000), headers: { accept: 'application/json' } });
    if (!r.ok) return { state: 'unknown', contract, reason: `the published record answered HTTP ${r.status}` };
    const rec = (await r.json()) as { contractAddress?: unknown; network?: unknown };
    const current = String(rec.contractAddress ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(current) || (rec.network !== undefined && rec.network !== network)) {
      return { state: 'unknown', contract, reason: 'the published record has no contract address for this network' };
    }
    return current === contract.toLowerCase() ? { state: 'current', contract } : { state: 'outdated', contract, current };
  } catch (err) {
    return { state: 'unknown', contract, reason: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * checkDeployment, remembered: an answer is kept for `keepMs` (an hour), an
 * unknown one for `retryMs` (5 minutes), so each purchase doesn't fetch it again.
 */
export const deploymentWatch = (
  contract: () => string,
  network: string,
  o: { fetchFn?: typeof fetch; url?: string; keepMs?: number; retryMs?: number; now?: () => number } = {},
): (() => Promise<Freshness>) => {
  const now = o.now ?? Date.now;
  let last: { at: number; f: Freshness } | undefined;
  let pending: Promise<Freshness> | undefined;
  return async () => {
    const keep = last?.f.state === 'unknown' ? (o.retryMs ?? 5 * 60_000) : (o.keepMs ?? 60 * 60_000);
    if (last && now() - last.at < keep) return last.f;
    pending ??= checkDeployment(contract(), network, o).then((f) => {
      last = { at: now(), f };
      pending = undefined;
      return f;
    });
    return pending;
  };
};

const short = (hex: string) => `${hex.slice(0, 8)}…`;

/** What to tell the owner (and the AI) when the kit plays an old contract. */
export const outdatedText = (f: Extract<Freshness, { state: 'outdated' }>): string =>
  `Starfall has moved to a new contract (${short(f.current)}), but this copy of the Lunardraw agent still plays the old one (${short(f.contract)}), ` +
  'so nothing was bought. The owner needs to update it: in Claude, Settings, Extensions, Lunardraw (Starfall), Uninstall, then install it again from ' +
  'https://lunardraw.io/play-with-ai/ (the wallet and its tNIGHT stay, they are kept outside the extension); from a terminal, ' +
  '`npm install -g @lunardraw/agent`, then restart the AI app.';
