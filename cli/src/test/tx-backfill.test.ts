import { describe, expect, it } from 'vitest';
import { Starfall } from '@lunardraw/contract';
import type { StarfallView } from '@lunardraw/keeper';
import { type Action, backfillJson, contractActions, type Gql, named, namingLike, type Subscribe, txIdsByDraw } from '../tx-backfill.js';

const { DrawStatus } = Starfall;
const ADDR = 'f868fc99';

/** A view with just the draws' statuses (all txIdsByDraw reads). */
const view = (draws: Record<number, number>): StarfallView =>
  ({ draws: Object.entries(draws).map(([id, status]) => ({ id: BigInt(id), status })) }) as unknown as StarfallView;

describe('backfilling transaction ids', () => {
  it("reads the contract's actions from the indexer's stream, oldest first, until it has passed the latest and gone quiet", async () => {
    const raw = (h: number, kind: string, entryPoint: string | undefined, ids: string[] | undefined, hash: string, state: string) => ({
      contractActions: { __typename: kind, state, entryPoint, transaction: { hash, identifiers: ids, block: { height: h } } },
    });
    const stream = [
      raw(10, 'ContractDeploy', undefined, ['id0'], 'h0', 's0'),
      raw(20, 'ContractCall', 'requestDraw', ['id1'], 'h1', 's1'),
      raw(20, 'ContractCall', 'buyTickets', undefined, 'h2', 's2'), // no identifiers: the hash
      raw(30, 'ContractCall', 'computeNumbers', ['id4'], 'h4', 's4'),
    ];
    const gql: Gql = async (q, v) => {
      expect(q).toContain('contractAction(');
      expect(v).toEqual({ address: ADDR });
      return { contractAction: { transaction: { block: { height: 30 } } } };
    };
    let subscribed: Record<string, unknown> | undefined;
    let closed = false;
    const subscribe: Subscribe = (_q, v, on) => {
      subscribed = v;
      stream.forEach((d, i) => setTimeout(() => on.data(d), 5 * (i + 1)));
      return {
        close() {
          closed = true;
        },
      };
    };
    const seen: number[] = [];
    const acts = await contractActions(gql, subscribe, '0x' + ADDR.toUpperCase(), { fromHeight: 10, idleMs: 30, onAction: (_a, n) => seen.push(n) });
    expect(subscribed).toEqual({ address: ADDR, offset: { height: 10 } });
    // filed under the hash, with every name the indexer gave
    expect(acts.map((a) => [a.height, a.tx, a.ids, a.entryPoint ?? a.kind, a.state])).toEqual([
      [10, 'h0', ['id0'], 'ContractDeploy', 's0'],
      [20, 'h1', ['id1'], 'requestDraw', 's1'],
      [20, 'h2', [], 'buyTickets', 's2'],
      [30, 'h4', ['id4'], 'computeNumbers', 's4'],
    ]);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(closed).toBe(true);
  });

  it("stops with the indexer's error, and with nothing when the contract has no actions", async () => {
    const latest: Gql = async () => ({ contractAction: { transaction: { block: { height: 5 } } } });
    const refusing: Subscribe = (_q, _v, on) => {
      setTimeout(() => on.error(new Error('the indexer: unknown field')), 5);
      return { close() {} };
    };
    await expect(contractActions(latest, refusing, ADDR, { idleMs: 10 })).rejects.toThrow(/unknown field/);
    const none: Gql = async () => ({ contractAction: null });
    expect(await contractActions(none, refusing, ADDR)).toEqual([]);
  });

  it("names the transactions the way the keeper's own records do: by hash or by an identifier, whichever matches", () => {
    const act = (hash: string, ids: string[]): Action => ({ height: 1, tx: hash, hash, ids, kind: 'ContractCall', entryPoint: 'requestDraw', state: '' });
    const acts = [act('h1', ['a1', 'b1']), act('h2', ['a2', 'b2']), act('h3', ['a3'])];
    expect(namingLike(acts, new Set(['h2', 'h3'])).naming.label).toBe('hash');
    const byFirst = namingLike(acts, new Set(['0xA1', 'a3']));
    expect([byFirst.naming.label, byFirst.matched]).toEqual(['identifier 1', 2]);
    const bySecond = namingLike(acts, new Set(['b1', 'b2']));
    expect(bySecond.naming.label).toBe('identifier 2');
    expect(named(acts, bySecond.naming).map((a) => a.tx)).toEqual(['b1', 'b2', 'h3']); // no second identifier: its hash
    expect(namingLike(acts, new Set(['zz'])).matched).toBe(0); // none matches
    expect(namingLike(acts, new Set()).naming.label).toBe('hash'); // nothing to compare: the hash
  });

  it("names each draw's open, reveal, numbers, finalise and void transactions from the calls that moved it", () => {
    const { open, requested, fulfilled, drawn, settled, voided } = DrawStatus;
    const states: Record<string, StarfallView> = {
      deploy: view({}),
      open1: view({ 1: open }),
      buy: view({ 1: open }),
      reveal1: view({ 1: requested, 2: open }), // reveals 1 and opens 2
      fulfil1: view({ 1: fulfilled, 2: open }),
      numbers1: view({ 1: drawn, 2: open }),
      settle1: view({ 1: drawn, 2: open }),
      final1: view({ 1: settled, 2: open }),
      reveal2: view({ 1: settled, 2: requested, 3: open }),
      void2: view({ 1: settled, 2: voided, 3: open }),
    };
    const acts: Action[] = [
      { height: 1, tx: 'tx-deploy', hash: 'tx-deploy', ids: [], kind: 'ContractDeploy', state: 'deploy' },
      { height: 2, tx: 'tx-open1', hash: 'tx-open1', ids: [], kind: 'ContractCall', entryPoint: 'requestDraw', state: 'open1' },
      { height: 3, tx: 'tx-buy', hash: 'tx-buy', ids: [], kind: 'ContractCall', entryPoint: 'buyTickets', state: 'buy' },
      { height: 4, tx: 'tx-reveal1', hash: 'tx-reveal1', ids: [], kind: 'ContractCall', entryPoint: 'requestDraw', state: 'reveal1' },
      { height: 5, tx: 'tx-fulfil1', hash: 'tx-fulfil1', ids: [], kind: 'ContractCall', entryPoint: 'fulfilDraw', state: 'fulfil1' },
      { height: 6, tx: 'tx-numbers1', hash: 'tx-numbers1', ids: [], kind: 'ContractCall', entryPoint: 'computeNumbers', state: 'numbers1' },
      { height: 7, tx: 'tx-settle1', hash: 'tx-settle1', ids: [], kind: 'ContractCall', entryPoint: 'settleBatch', state: 'settle1' },
      { height: 8, tx: 'tx-final1', hash: 'tx-final1', ids: [], kind: 'ContractCall', entryPoint: 'finaliseDraw', state: 'final1' },
      { height: 9, tx: 'tx-reveal2', hash: 'tx-reveal2', ids: [], kind: 'ContractCall', entryPoint: 'requestDraw', state: 'reveal2' },
      { height: 10, tx: 'tx-void2', hash: 'tx-void2', ids: [], kind: 'ContractCall', entryPoint: 'voidDraw', state: 'void2' },
    ];
    const decoded: string[] = [];
    const ids = txIdsByDraw(acts, (s) => {
      decoded.push(s);
      return states[s];
    });
    expect(ids.get(1n)).toEqual({ open: 'tx-open1', reveal: 'tx-reveal1', numbers: 'tx-numbers1', finalise: 'tx-final1' });
    expect(ids.get(2n)).toEqual({ open: 'tx-reveal1', reveal: 'tx-reveal2', void: 'tx-void2' });
    expect(ids.get(3n)).toEqual({ open: 'tx-reveal2' });
    // only the calls that can move a draw are decoded
    expect(decoded).not.toContain('buy');
    expect(decoded).not.toContain('settle1');
    expect(JSON.parse(backfillJson(ids))['1']).toEqual({ tx: ids.get(1n) });
  });
});
