/**
 * One program per wallet. Two programs using the same wallet at once (two
 * `buy` windows, say) try to spend the same coins: the chain takes one
 * transaction and refuses the other, and the wallet of the refused one waits
 * for it for ever. So every command that opens a wallet holds a lock file
 * beside the wallet's saved state while it runs, and a second one stops
 * straight away with a clear message.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { type Network, openWallet as openNightcastWallet, type Session, walletStateFile } from '@nightcast/deploy';

type Holder = { pid: number; host: string; since: string; command: string };

export class WalletInUse extends Error {
  constructor(
    readonly holder: Holder,
    readonly lockFile: string,
  ) {
    super(
      `this wallet is already open in another program (process ${holder.pid}, since ${holder.since}: ${holder.command}). ` +
        'Two programs using one wallet try to spend the same coins, and one of them gets stuck. ' +
        `Stop the other one first. If it's not running any more, delete ${lockFile}`,
    );
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readHolder = (file: string): Holder | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Holder;
  } catch {
    return undefined;
  }
};

export const walletLockFile = (network: Network | string, seed: string): string => `${walletStateFile(network, seed)}.lock`;

/**
 * Take the wallet's lock, or throw WalletInUse if a live program on this
 * machine holds it. A lock left by a program that has gone (killed, crashed,
 * the server restarted) is taken over. Returns the release function.
 */
export const lockWallet = (network: Network | string, seed: string, command = process.argv.slice(2).join(' ')): (() => void) => {
  const file = walletLockFile(network, seed);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const me: Holder = { pid: process.pid, host: hostname(), since: new Date().toISOString(), command: command || 'lunardraw' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, JSON.stringify(me));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', release);
        if (readHolder(file)?.pid === process.pid) {
          try {
            unlinkSync(file);
          } catch {
            /* already gone */
          }
        }
      };
      process.on('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readHolder(file);
      // Someone else on this machine, still running: refuse.
      if (holder && holder.pid !== process.pid && holder.host === me.host && alive(holder.pid)) throw new WalletInUse(holder, file);
      // Ours from earlier, a dead program's, unreadable, or another machine's
      // copy of the folder: take it over.
      try {
        unlinkSync(file);
      } catch {
        /* someone else just took it over; try again */
      }
    }
  }
  throw new Error(`could not take the wallet lock ${file}`);
};

/**
 * nightcast's openWallet, holding the wallet's lock from before it opens until
 * it stops. `local` wallets are throwaway (and tests open the same genesis
 * wallet more than once), so they aren't locked.
 */
export const openWallet: typeof openNightcastWallet = async (session: Session, opts = {}) => {
  if (session.network === 'local' || !opts.seed) return openNightcastWallet(session, opts);
  const release = lockWallet(session.network, opts.seed);
  let wallet;
  try {
    wallet = await openNightcastWallet(session, opts);
  } catch (err) {
    release();
    throw err;
  }
  const stop = wallet.stop.bind(wallet);
  wallet.stop = async () => {
    try {
      return await stop();
    } finally {
      release();
    }
  };
  return wallet;
};
