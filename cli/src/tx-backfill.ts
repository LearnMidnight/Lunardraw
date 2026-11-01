/**
 * The transaction ids of draws settled before the keeper kept them (#64):
 * read back from the indexer, which has every action on the contract with
 * its state after the action.
 *
 * The indexer streams the contract's actions, oldest first, from the
 * deployment's block (its WebSocket subscription), up to the latest action.
 * Then each call
 * that moves a draw (requestDraw, computeNumbers, finaliseDraw, voidDraw) is
 * matched to the draws whose status it changed, by decoding the contract's
 * state after it. The result is written beside the feed
 * (`<feed>.backfill.json`), which the keeper's feed merges in (its own
 * records win).
 */
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { Starfall } from '@lunardraw/contract';
import { starfallViewOf, type StarfallTxStep, type StarfallView } from '@lunardraw/keeper';

const { DrawStatus } = Starfall;

/** A GraphQL query against the indexer: resolves with `data`, throws on errors. */
export type Gql = (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The indexer over HTTP, a short pause between requests, and retries when it's busy (429, 5xx). */
export const indexerGql =
  (url: string, opts: { pauseMs?: number; fetchFn?: typeof fetch } = {}): Gql =>
  async (query, variables) => {
    const fetchFn = opts.fetchFn ?? fetch;
    for (let attempt = 1; ; attempt++) {
      if (opts.pauseMs) await sleep(opts.pauseMs);
      let r: Response;
      try {
        r = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        if (attempt < 6) {
          await sleep(2_000 * attempt);
          continue;
        }
        throw err;
      }
      if ((r.status === 429 || r.status >= 500) && attempt < 6) {
        await sleep(2_000 * attempt);
        continue;
      }
      if (!r.ok) throw new Error(`the indexer answered ${r.status}`);
      const body = (await r.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] };
      if (body.errors?.length) throw new Error(`the indexer: ${body.errors.map((e) => e.message).join('; ')}`);
      return body.data ?? {};
    }
  };

/** One action on the contract: its block, its transaction's id, the circuit it called, the state after. */
export type Action = { height: number; tx: string; kind: string; entryPoint?: string; state: string };

/** A GraphQL subscription: calls `onData` with each result's `data`; `close` ends it. */
export type Subscribe = (
  query: string,
  variables: Record<string, unknown>,
  on: { data: (data: Record<string, unknown>) => void; error: (err: Error) => void },
) => { close(): void };

/** The parts of a WebSocket used here (Node 22's global, typed without the DOM library). */
type Socket = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
};

/**
 * The indexer's WebSocket (the graphql-transport-ws protocol midnight-js
 * uses), with Node's built-in WebSocket.
 */
export const indexerSubscribe =
  (wsUrl: string): Subscribe =>
  (query, variables, on) => {
    const WS = (globalThis as { WebSocket?: new (url: string, protocols?: string | string[]) => Socket }).WebSocket;
    if (!WS) throw new Error('this Node has no WebSocket (Node 22 or later is needed)');
    const ws = new WS(wsUrl, 'graphql-transport-ws');
    let closed = false;
    const fail = (err: Error) => {
      if (closed) return;
      closed = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      on.error(err);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    ws.onerror = () => fail(new Error(`couldn't reach the indexer's WebSocket (${wsUrl.replace(/project_id=[^&]+/, 'project_id=***')})`));
    ws.onclose = (e: { code?: number; reason?: string }) => {
      if (!closed) fail(new Error(`the indexer closed the WebSocket (${e.code ?? ''} ${e.reason ?? ''})`.trim()));
    };
    ws.onmessage = (e: { data: unknown }) => {
      let m: { type?: string; id?: string; payload?: { data?: Record<string, unknown>; errors?: { message: string }[] } | { message: string }[] };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === 'connection_ack') ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables } }));
      else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      else if (m.type === 'next') {
        const p = m.payload as { data?: Record<string, unknown>; errors?: { message: string }[] };
        if (p?.errors?.length) fail(new Error(`the indexer: ${p.errors.map((x) => x.message).join('; ')}`));
        else if (p?.data) on.data(p.data);
      } else if (m.type === 'error') {
        const errs = (Array.isArray(m.payload) ? m.payload : []) as { message: string }[];
        fail(new Error(`the indexer: ${errs.map((x) => x.message).join('; ') || 'subscription refused'}`));
      } else if (m.type === 'complete') fail(new Error('the indexer ended the subscription early'));
    };
    return {
      close() {
        closed = true;
        try {
          ws.send(JSON.stringify({ id: '1', type: 'complete' }));
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
  };

const LATEST = `query Q($address: HexEncoded!) { contractAction(address: $address) { transaction { block { height } } } }`;
const TX_HEIGHT = `query T($id: HexEncoded!) { transactions(offset: { identifier: $id }) { block { height } } }`;
const ACTIONS = `subscription S($address: HexEncoded!, $offset: BlockOffset) {
  contractActions(address: $address, offset: $offset) {
    __typename
    state
    ... on ContractCall { entryPoint }
    transaction { hash ... on RegularTransaction { identifiers } block { height } }
  }
}`;

const bare = (h: string): string => h.toLowerCase().replace(/^0x/, '');

type RawAction = {
  __typename: string;
  state: string;
  entryPoint?: string;
  transaction: { hash: string; identifiers?: string[]; block: { height: number } };
};

/** The block a transaction is in (the deployment's, to start from), or undefined if the indexer can't say. */
export const heightOfTx = async (gql: Gql, id: string | undefined): Promise<number | undefined> => {
  if (!id) return undefined;
  try {
    const t = (await gql(TX_HEIGHT, { id: bare(id) })).transactions as { block: { height: number } }[] | null;
    return t?.[0]?.block.height;
  } catch {
    return undefined;
  }
};

/**
 * Every action on the contract, oldest first: the indexer's stream of the
 * contract's actions from `fromHeight` (default the first block), until it
 * has passed the latest action (found first) and gone quiet for `idleMs`.
 */
export const contractActions = async (
  gql: Gql,
  subscribe: Subscribe,
  address: string,
  opts: { fromHeight?: number; idleMs?: number; timeoutMs?: number; onAction?: (a: Action, count: number) => void } = {},
): Promise<Action[]> => {
  const latest = (await gql(LATEST, { address: bare(address) })).contractAction as { transaction: { block: { height: number } } } | null;
  if (!latest) return [];
  const top = latest.transaction.block.height;
  const idleMs = opts.idleMs ?? 5_000;
  const out: Action[] = [];
  return new Promise<Action[]>((resolve, reject) => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(overall);
      sub.close();
      if (err) reject(err);
      else resolve(out);
    };
    const overall = setTimeout(
      () => finish(new Error(`the indexer hadn't sent the contract's history up to block ${top} after ${Math.round((opts.timeoutMs ?? 30 * 60_000) / 60_000)} minutes (${out.length} actions so far)`)),
      opts.timeoutMs ?? 30 * 60_000,
    );
    const sub = subscribe(
      ACTIONS,
      { address: bare(address), offset: { height: opts.fromHeight ?? 0 } },
      {
        data: (data) => {
          const a = data.contractActions as RawAction | undefined;
          if (!a) return;
          const t = a.transaction;
          // midnight-js reports a transaction by its first identifier (the keeper's own records do too)
          const action: Action = { height: t.block.height, tx: t.identifiers?.[0] ?? t.hash, kind: a.__typename, entryPoint: a.entryPoint, state: a.state };
          out.push(action);
          opts.onAction?.(action, out.length);
          if (action.height >= top) {
            // caught up: wait for the rest of that block (and anything newer), then stop
            clearTimeout(idle);
            idle = setTimeout(() => finish(), idleMs);
          }
        },
        error: (err) => finish(err),
      },
    );
  });
};

/** The view of the contract from an action's state (hex). */
export const viewOfState = (hex: string): StarfallView =>
  starfallViewOf(Starfall.ledger(ContractState.deserialize(Buffer.from(bare(hex), 'hex')).data));

const MOVES: Record<string, true> = { requestDraw: true, fulfilDraw: true, computeNumbers: true, finaliseDraw: true, voidDraw: true };

/**
 * Each draw's step transactions, from the contract's actions (oldest first):
 * `open` (the call that created the draw), `reveal` (requestDraw moving it
 * past open), `numbers` (computeNumbers drawing it), `finalise`
 * (finaliseDraw settling it), `void`.
 */
export const txIdsByDraw = (
  actions: readonly Action[],
  decode: (state: string) => StarfallView = viewOfState,
): Map<bigint, Partial<Record<StarfallTxStep, string>>> => {
  const out = new Map<bigint, Partial<Record<StarfallTxStep, string>>>();
  const note = (id: bigint, step: StarfallTxStep, tx: string) => {
    const r = out.get(id) ?? {};
    if (!r[step]) r[step] = tx;
    out.set(id, r);
  };
  let before = new Map<bigint, number>();
  for (const a of actions) {
    if (a.kind !== 'ContractDeploy' && !(a.entryPoint && MOVES[a.entryPoint])) continue;
    const after = new Map(decode(a.state).draws.map((d) => [d.id, Number(d.status)] as const));
    for (const [id, s] of after) {
      const was = before.get(id);
      if (was === s) continue;
      if (was === undefined) note(id, 'open', a.tx);
      if (a.entryPoint === 'requestDraw' && (was === undefined ? false : was === DrawStatus.open) && s !== DrawStatus.open) note(id, 'reveal', a.tx);
      if (a.entryPoint === 'computeNumbers' && s === DrawStatus.drawn) note(id, 'numbers', a.tx);
      if (a.entryPoint === 'finaliseDraw' && s === DrawStatus.settled) note(id, 'finalise', a.tx);
      if (a.entryPoint === 'voidDraw' && s === DrawStatus.voided) note(id, 'void', a.tx);
    }
    before = after;
  }
  return out;
};

/** The backfill file's content: draw number → { tx }. */
export const backfillJson = (ids: Map<bigint, Partial<Record<StarfallTxStep, string>>>): string => {
  const out: Record<string, { tx: Partial<Record<StarfallTxStep, string>> }> = {};
  for (const id of [...ids.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[id.toString()] = { tx: ids.get(id)! };
  return JSON.stringify(out, null, 2) + '\n';
};
