import { describe, expect, it } from 'vitest';
import { Starfall } from '@lunardraw/contract';
import type { StarfallView } from '@lunardraw/keeper';
import { type Action, backfillJson, contractActions, type Gql, txIdsByDraw } from '../tx-backfill.js';

const { DrawStatus } = Starfall;
const ADDR = 'f868fc99';

/** A view with just the draws' statuses (all txIdsByDraw reads). */
const view = (draws: Record<number, number>): StarfallView =>
  ({ draws: Object.entries(draws).map(([id, status]) => ({ id: BigInt(id), status })) }) as unknown as StarfallView;

describe('backfilling transaction ids', () => {
  it("walks the contract's actions back a block at a time to the deployment, and returns them oldest first", async () => {
    // blocks 10 (deploy), 20 (two actions), 30 (one, beside another contract's)
    const blocks: Record<number, { hash: string; identifiers?: string[]; contractActions: { __typename: string; address: string; state: string; entryPoint?: string }[] }[]> = {
      10: [{ hash: 'h0', identifiers: ['id0'], contractActions: [{ __typename: 'ContractDeploy', address: ADDR, state: 's0' }] }],
      20: [
        { hash: 'h1', identifiers: ['id1'], contractActions: [{ __typename: 'ContractCall', address: ADDR, state: 's1', entryPoint: 'requestDraw' }] },
        { hash: 'h2', contractActions: [{ __typename: 'ContractCall', address: '0x' + ADDR.toUpperCase(), state: 's2', entryPoint: 'buyTickets' }] },
      ],
      30: [
        { hash: 'h3', identifiers: ['id3'], contractActions: [{ __typename: 'ContractCall', address: 'other', state: 'x', entryPoint: 'f' }] },
        { hash: 'h4', identifiers: ['id4'], contractActions: [{ __typename: 'ContractCall', address: ADDR, state: 's4', entryPoint: 'computeNumbers' }] },
      ],
    };
    const latestAt = (h: number) => {
      const hs = Object.keys(blocks).map(Number).filter((x) => x <= h);
      if (!hs.length) return null;
      const top = Math.max(...hs);
      const acts = blocks[top].flatMap((t) => t.contractActions).filter((c) => c.address.toLowerCase().endsWith(ADDR));
      return { __typename: acts[acts.length - 1].__typename, transaction: { block: { height: top } } };
    };
    const asked: unknown[] = [];
    const gql: Gql = async (query, v) => {
      asked.push(v);
      if (query.includes('contractAction(')) {
        const off = v.offset as { blockOffset: { height: number } } | undefined;
        return { contractAction: latestAt(off ? off.blockOffset.height : Infinity) };
      }
      return { block: { height: v.height, transactions: blocks[v.height as number] } };
    };
    const acts = await contractActions(gql, ADDR);
    expect(acts.map((a) => [a.height, a.tx, a.entryPoint ?? a.kind, a.state])).toEqual([
      [10, 'id0', 'ContractDeploy', 's0'],
      [20, 'id1', 'requestDraw', 's1'],
      [20, 'h2', 'buyTickets', 's2'], // no identifiers: the hash
      [30, 'id4', 'computeNumbers', 's4'],
    ]);
    expect(asked[0]).toEqual({ address: ADDR }); // the latest first, then each block below the last
    expect(asked).toContainEqual({ address: ADDR, offset: { blockOffset: { height: 29 } } });
    expect(asked).toContainEqual({ address: ADDR, offset: { blockOffset: { height: 19 } } });
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
      { height: 1, tx: 'tx-deploy', kind: 'ContractDeploy', state: 'deploy' },
      { height: 2, tx: 'tx-open1', kind: 'ContractCall', entryPoint: 'requestDraw', state: 'open1' },
      { height: 3, tx: 'tx-buy', kind: 'ContractCall', entryPoint: 'buyTickets', state: 'buy' },
      { height: 4, tx: 'tx-reveal1', kind: 'ContractCall', entryPoint: 'requestDraw', state: 'reveal1' },
      { height: 5, tx: 'tx-fulfil1', kind: 'ContractCall', entryPoint: 'fulfilDraw', state: 'fulfil1' },
      { height: 6, tx: 'tx-numbers1', kind: 'ContractCall', entryPoint: 'computeNumbers', state: 'numbers1' },
      { height: 7, tx: 'tx-settle1', kind: 'ContractCall', entryPoint: 'settleBatch', state: 'settle1' },
      { height: 8, tx: 'tx-final1', kind: 'ContractCall', entryPoint: 'finaliseDraw', state: 'final1' },
      { height: 9, tx: 'tx-reveal2', kind: 'ContractCall', entryPoint: 'requestDraw', state: 'reveal2' },
      { height: 10, tx: 'tx-void2', kind: 'ContractCall', entryPoint: 'voidDraw', state: 'void2' },
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
