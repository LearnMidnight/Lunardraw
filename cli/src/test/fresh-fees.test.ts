import { describe, expect, it } from 'vitest';
import { withFreshFees } from '../fresh-fees.js';

const stale = () => new Error('Transaction submission failed: RpcError: 1010: Invalid Transaction: Custom error: 170');
const isStale = (e: unknown) => /custom error: 170\b/i.test(String(e));

const setup = (submits: Array<'ok' | 'stale' | 'other'>) => {
  const log: string[] = [];
  let n = 0;
  const wallet = {
    name: 'wallet',
    getCoinPublicKey: function () {
      return `${this.name}-key`;
    },
    balanceTx: async (tx: { id: string }) => ({ balanced: tx.id, n: ++n }),
    submitTx: async (tx: { balanced: string; n: number }) => {
      const r = submits.shift();
      log.push(`submit ${tx.balanced}#${tx.n}: ${r}`);
      if (r === 'stale') throw stale();
      if (r === 'other') throw new Error('Custom error: 138');
      return `tx-${tx.n}`;
    },
  };
  let waits = 0;
  const providers = withFreshFees(
    { walletProvider: wallet, midnightProvider: wallet, other: 1 },
    { beforeBalance: async () => void waits++, isStale, pauseMs: 0, sleep: async () => {}, logger: { info: (m) => log.push(m) } },
  );
  return { providers, log, waits: () => waits };
};

describe('withFreshFees', () => {
  it('waits for the tip before each balance and keeps the other members', async () => {
    const { providers, waits } = setup(['ok']);
    const balanced = await providers.walletProvider.balanceTx({ id: 'p' });
    expect(waits()).toBe(1);
    await expect(providers.midnightProvider.submitTx(balanced as never)).resolves.toBe('tx-1');
    expect(providers.walletProvider.getCoinPublicKey()).toBe('wallet-key');
    expect(providers.other).toBe(1);
  });

  it('pays the fee again from the same proven transaction when the node calls it stale', async () => {
    const { providers, log, waits } = setup(['stale', 'stale', 'ok']);
    const balanced = await providers.walletProvider.balanceTx({ id: 'p' });
    await expect(providers.midnightProvider.submitTx(balanced as never)).resolves.toBe('tx-3');
    expect(waits()).toBe(3);
    expect(log.filter((l) => l.startsWith('submit'))).toEqual(['submit p#1: stale', 'submit p#2: stale', 'submit p#3: ok']);
    expect(log.at(-1)).toBe('fee paid again on try 2; transaction accepted');
  });

  it('gives up after the retries with the last error, and passes other errors straight through', async () => {
    const a = setup(['stale', 'stale', 'stale', 'stale', 'ok']);
    const t = await a.providers.walletProvider.balanceTx({ id: 'p' });
    await expect(a.providers.midnightProvider.submitTx(t as never)).rejects.toThrow(/170/);
    expect(a.log.filter((l) => l.startsWith('submit'))).toHaveLength(4);

    const b = setup(['other']);
    const u = await b.providers.walletProvider.balanceTx({ id: 'q' });
    await expect(b.providers.midnightProvider.submitTx(u as never)).rejects.toThrow(/138/);
    expect(b.log.filter((l) => l.startsWith('submit'))).toHaveLength(1);
  });

  it('stops retrying when a resubmission fails for another reason', async () => {
    const { providers, log } = setup(['stale', 'other', 'ok']);
    const t = await providers.walletProvider.balanceTx({ id: 'p' });
    await expect(providers.midnightProvider.submitTx(t as never)).rejects.toThrow(/138/);
    expect(log.filter((l) => l.startsWith('submit'))).toHaveLength(2);
  });
});
