import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { lockWallet, startedAt, WalletInUse, walletLockFile } from '../wallet-lock.js';

const SEED = 'ab'.repeat(32);

describe('one program per wallet', () => {
  beforeEach(() => {
    process.env.NIGHTCAST_STATE_DIR = mkdtempSync(join(tmpdir(), 'wallet-lock-'));
  });

  it('refuses a wallet a live program holds, and frees it on release', () => {
    const file = walletLockFile('preprod', SEED);
    // The test runner's parent process is alive: pretend it holds the wallet.
    const since = new Date().toISOString();
    writeFileSync(file, JSON.stringify({ pid: process.ppid, host: hostname(), since, command: 'starfall buy --package mini' }));
    let err: unknown;
    try {
      lockWallet('preprod', SEED);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WalletInUse);
    expect((err as Error).message).toContain(`already open in another program (process ${process.ppid}, since ${since}: starfall buy --package mini)`);
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

  it.runIf(process.platform === 'linux')('takes over a lock whose process id now belongs to a newer program (the id was reused)', () => {
    const file = walletLockFile('preprod', SEED);
    // the parent is alive, but it started long after this lock was taken
    writeFileSync(file, JSON.stringify({ pid: process.ppid, host: hostname(), since: '2020-01-01T00:00:00Z', command: 'starfall keeper' }));
    expect(startedAt(process.ppid)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));
    lockWallet('preprod', SEED)();
  });

  it("takes over an unreadable lock or one from another machine's copy of the folder", () => {
    const file = walletLockFile('preprod', SEED);
    writeFileSync(file, 'not json');
    lockWallet('preprod', SEED)();
    writeFileSync(file, JSON.stringify({ pid: process.ppid, host: 'some-other-machine', since: 'x', command: 'buy' }));
    lockWallet('preprod', SEED)();
  });
});
