import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { lockWallet, WalletInUse, walletLockFile } from '../wallet-lock.js';

const SEED = 'ab'.repeat(32);

describe('one program per wallet', () => {
  beforeEach(() => {
    process.env.NIGHTCAST_STATE_DIR = mkdtempSync(join(tmpdir(), 'wallet-lock-'));
  });

  it('refuses a wallet a live program holds, and frees it on release', () => {
    const file = walletLockFile('preprod', SEED);
    // The test runner's parent process is alive: pretend it holds the wallet.
    writeFileSync(file, JSON.stringify({ pid: process.ppid, host: hostname(), since: '2026-10-27T09:30:00Z', command: 'starfall buy --package mini' }));
    let err: unknown;
    try {
      lockWallet('preprod', SEED);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WalletInUse);
    expect((err as Error).message).toMatch(/already open in another program \(process \d+, since 2026-10-27T09:30:00Z: starfall buy --package mini\)/);
    // A different wallet, or the same one on another network, is free.
    lockWallet('preprod', 'cd'.repeat(32))();
    lockWallet('preview', SEED)();
  });

  it("takes over a lock left by a program that has gone, and releases it", () => {
    const file = walletLockFile('preprod', SEED);
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), since: 'x', command: 'killed' }));
    const release = lockWallet('preprod', SEED);
    expect(existsSync(file)).toBe(true);
    release();
    expect(existsSync(file)).toBe(false);
    release(); // twice is harmless
  });

  it("takes over an unreadable lock or one from another machine's copy of the folder", () => {
    const file = walletLockFile('preprod', SEED);
    writeFileSync(file, 'not json');
    lockWallet('preprod', SEED)();
    writeFileSync(file, JSON.stringify({ pid: process.ppid, host: 'some-other-machine', since: 'x', command: 'buy' }));
    lockWallet('preprod', SEED)();
  });
});

describe('caughtUp', () => {
  it('waits for new events and a synced wallet, and gives up after a while', async () => {
    const { Subject } = await import('rxjs');
    const { caughtUp } = await import('../sync-watch.js');
    const states = new Subject<unknown>();
    const at = (dust: number, isSynced = true) => ({ isSynced, dust: { state: { progress: { appliedIndex: BigInt(dust) } } } });
    let resolved = false;
    const p = caughtUp(states, 1_000).then(() => (resolved = true));
    states.next(at(5));
    states.next(at(5));
    states.next(at(6, false));
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    states.next(at(7));
    await p;
    expect(resolved).toBe(true);
    await expect(caughtUp(new Subject<unknown>(), 20)).rejects.toThrow(/didn't catch up/);
  });
});
