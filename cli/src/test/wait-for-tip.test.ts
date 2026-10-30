import { describe, expect, it, vi } from 'vitest';
import { atTip, waitForTip } from '../sync-watch.js';

type Listener = (s: unknown) => void;
const fakeWallet = () => {
  const listeners = new Set<Listener>();
  return {
    emit: (s: unknown) => listeners.forEach((l) => l(s)),
    wallet: {
      state: () => ({
        subscribe: (l: Listener) => {
          listeners.add(l);
          return { unsubscribe: () => listeners.delete(l) };
        },
      }),
    },
  };
};

const progress = (applied: number, target: number) => ({ appliedIndex: applied, highestRelevantWalletIndex: target });

describe('atTip', () => {
  it('needs isSynced and every known part caught up', () => {
    expect(atTip({ isSynced: false, dust: { state: { progress: progress(5, 5) } } })).toBe(false);
    expect(atTip({ isSynced: true, dust: { state: { progress: progress(4, 5) } } })).toBe(false);
    expect(atTip({ isSynced: true, dust: { state: { progress: progress(5, 5) } }, shielded: { state: { progress: progress(9, 9) } } })).toBe(true);
    expect(atTip({ isSynced: true, dust: { state: { progress: progress(5, 5) } }, shielded: { state: { progress: progress(8, 9) } } })).toBe(false);
  });
  it('prefers the SDK own completeness check when it is there', () => {
    expect(atTip({ isSynced: true, dust: { state: { progress: { ...progress(5, 5), isStrictlyComplete: () => false } } } })).toBe(false);
    expect(atTip({ isSynced: true, dust: { state: { progress: { ...progress(3, 5), isStrictlyComplete: () => true } } } })).toBe(true);
  });
  it('does not hold on parts the wallet reports nothing about', () => {
    expect(atTip({ isSynced: true })).toBe(true);
  });
});

describe('waitForTip', () => {
  it('resolves at once when the wallet is already at the tip, without logging', async () => {
    const w = fakeWallet();
    const logger = { info: vi.fn() };
    const p = waitForTip(w, { logger, timeoutMs: 1000 });
    w.emit({ isSynced: true, dust: { state: { progress: progress(5, 5) } } });
    await expect(p).resolves.toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('waits while the DUST part lags and reports how long it waited', async () => {
    vi.useFakeTimers();
    try {
      const w = fakeWallet();
      const logger = { info: vi.fn() };
      const p = waitForTip(w, { logger, timeoutMs: 60_000 });
      w.emit({ isSynced: true, dust: { state: { progress: progress(3, 5) } } });
      await vi.advanceTimersByTimeAsync(12_000);
      w.emit({ isSynced: true, dust: { state: { progress: progress(5, 5) } } });
      await expect(p).resolves.toBe(true);
      expect(logger.info.mock.calls.map((c) => c[0])).toEqual([
        'waiting for the wallet to reach the tip before building the transaction',
        'wallet at the tip after 12 s',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the timeout and says so', async () => {
    vi.useFakeTimers();
    try {
      const w = fakeWallet();
      const logger = { info: vi.fn() };
      const p = waitForTip(w, { logger, timeoutMs: 30_000 });
      w.emit({ isSynced: false });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toBe(false);
      expect(logger.info).toHaveBeenLastCalledWith('wallet still behind after 30 s; sending anyway');
    } finally {
      vi.useRealTimers();
    }
  });
});
