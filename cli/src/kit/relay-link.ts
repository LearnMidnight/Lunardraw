/**
 * The agent's link to Lunardraw's relay (relay.ts), so AIs on the web or a
 * phone (ChatGPT, claude.ai, anything that adds an MCP server by its web
 * address) can play with the wallet on this computer.
 *
 * The agent calls the relay; nothing calls in, so it works from behind any
 * home router. It asks for work with a long poll (POST <relay>/link/poll,
 * held up to 25 s) and sends each answer back (POST <relay>/link/answer).
 * Both carry the link's secret (relay-link.secret) as a Bearer token; the
 * AI's private address is <relay>/mcp/<secret>, and the relay keeps only a
 * hash of it. The wallet, the limits and every decision stay here: the relay
 * only passes messages along. Turn it off with `lunardraw-agent remote off`;
 * `remote new-link` makes a new secret, and the old address stops working.
 */
import type { Rpc } from './mcp.js';

export type LinkState = 'linking' | 'linked' | 'relay unreachable' | 'off';

export type RelayRequest = { id: string; body: Rpc };

/** The private address an AI app is given. */
export const linkAddress = (relay: string, secret: string): string => `${relay.replace(/\/+$/, '')}/mcp/${secret}`;

/**
 * Keep the link up until `stop()`. `settings()` is read before each poll, so
 * turning remote off or making a new link takes effect without a restart.
 */
export const linkToRelay = (o: {
  settings: () => { on: boolean; relay: string; secret: string };
  answer: (msg: Rpc) => Promise<object | undefined>;
  version: string;
  log?: (m: string) => void;
  onState?: (s: LinkState) => void;
  fetchFn?: typeof fetch;
  /** Between tries when the relay can't be reached (ms), and how long a poll may take. */
  retryMs?: number;
  pollMs?: number;
}): { stop: () => void; state: () => LinkState } => {
  const fetchFn = o.fetchFn ?? fetch;
  let state: LinkState = 'linking';
  let stopped = false;
  const set = (s: LinkState) => {
    if (s === state) return;
    state = s;
    o.onState?.(s);
    o.log?.(
      s === 'linked'
        ? 'linked to Lunardraw\'s relay: AIs on the web or a phone can reach this agent'
        : s === 'relay unreachable'
          ? "can't reach Lunardraw's relay; trying again"
          : s === 'off'
            ? 'the link for AIs on the web or a phone is off'
            : 'linking to Lunardraw\'s relay',
    );
  };
  const post = (url: string, secret: string, body: unknown, ms: number) =>
    fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const run = async () => {
    let wait = o.retryMs ?? 5_000;
    while (!stopped) {
      const { on, relay, secret } = o.settings();
      if (!on) {
        set('off');
        await sleep(10_000);
        continue;
      }
      const base = relay.replace(/\/+$/, '');
      try {
        const r = await post(`${base}/link/poll`, secret, { version: o.version }, o.pollMs ?? 40_000);
        if (r.status === 401 || r.status === 403) throw new Error(`the relay refused this link (${r.status})`);
        if (!r.ok) throw new Error(`the relay answered ${r.status}`);
        const { requests } = (await r.json()) as { requests?: RelayRequest[] };
        set('linked');
        wait = o.retryMs ?? 5_000;
        for (const req of requests ?? []) {
          // each request is answered as soon as it's done (a purchase shouldn't hold up a status check)
          void o
            .answer(req.body)
            .catch((err: unknown) => ({ jsonrpc: '2.0', id: req.body.id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }))
            .then((response) => post(`${base}/link/answer`, secret, { id: req.id, response: response ?? null }, 15_000))
            .catch((err: unknown) => o.log?.(`couldn't send an answer to the relay: ${err instanceof Error ? err.message : String(err)}`));
        }
      } catch (err) {
        if (stopped) break;
        const first = state !== 'relay unreachable';
        set('relay unreachable');
        if (first) o.log?.(`relay: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(wait);
        wait = Math.min(wait * 2, 60_000);
      }
    }
  };
  void run();
  return {
    stop: () => {
      stopped = true;
    },
    state: () => state,
  };
};
