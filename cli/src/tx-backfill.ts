/**
 * The transaction ids of draws settled before the keeper kept them (#64):
 * read back from the indexer, which has every action on the contract with
 * its state after the action.
 *
 * The walk goes back from the latest action a block at a time (the latest
 * action at or before a height, then every action of the contract in that
 * block, in order), down to the deployment. Then, oldest first, each call
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

const LATEST_AT = `query Q($address: HexEncoded!, $offset: ContractActionOffset) {
  contractAction(address: $address, offset: $offset) { __typename transaction { block { height } } }
}`;
const BLOCK = `query B($height: Int!) {
  block(offset: { height: $height }) {
    height
    transactions {
      hash
      ... on RegularTransaction { identifiers }
      contractActions { __typename address state ... on ContractCall { entryPoint } }
    }
  }
}`;

const bare = (h: string): string => h.toLowerCase().replace(/^0x/, '');

type BlockData = {
  height: number;
  transactions: { hash: string; identifiers?: string[]; contractActions?: { __typename: string; address: string; state: string; entryPoint?: string }[] }[];
};

/** Every action on the contract, oldest first. */
export const contractActions = async (
  gql: Gql,
  address: string,
  opts: { onBlock?: (height: number, blocks: number) => void } = {},
): Promise<Action[]> => {
  const blocks: Action[][] = [];
  let offset: unknown = undefined;
  for (;;) {
    const a = (await gql(LATEST_AT, offset === undefined ? { address } : { address, offset })).contractAction as
      | { __typename: string; transaction: { block: { height: number } } }
      | null;
    if (!a) break;
    const height = a.transaction.block.height;
    const b = (await gql(BLOCK, { height })).block as BlockData | null;
    if (!b) throw new Error(`the indexer has no block ${height}`);
    const acts: Action[] = [];
    for (const t of b.transactions) {
      for (const c of t.contractActions ?? []) {
        if (bare(c.address) !== bare(address)) continue;
        // midnight-js reports a transaction by its first identifier (the keeper's own records do too)
        acts.push({ height, tx: t.identifiers?.[0] ?? t.hash, kind: c.__typename, entryPoint: c.entryPoint, state: c.state });
      }
    }
    blocks.push(acts);
    opts.onBlock?.(height, blocks.length);
    if (a.__typename === 'ContractDeploy' || acts.some((x) => x.kind === 'ContractDeploy') || height <= 0) break;
    offset = { blockOffset: { height: height - 1 } };
  }
  return blocks.reverse().flat();
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
