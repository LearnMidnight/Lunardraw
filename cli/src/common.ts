/**
 * Helpers shared by the v0 and Starfall commands: key files, wallets,
 * sessions, and the watchdogs that restart a keeper or oracle.
 */
import { readFileSync } from 'node:fs';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { oraclePublicKey, parseOracleSecretKey } from '@nightcast/contract';
import {
  BLOCKFROST,
  blockfrostProjectId,
  connect,
  createLogger,
  isNetwork,
  localFingerprints,
  type Network,
  NETWORKS,
  publicEndpoints,
  type Session,
} from '@nightcast/deploy';
import { zkConfigPath } from './contract.js';
import { organiserCommitmentOf } from './deployment.js';

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
export const iso = (secs: bigint) => new Date(Number(secs) * 1000).toISOString();

export type KeyFile = { role: string; secret?: string; public?: unknown; seed?: string };
export const readKeyFile = (path: string, role: string): KeyFile => {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
  if (parsed.role !== role) throw new Error(`${path} is a ${parsed.role} file, expected ${role}`);
  return parsed;
};

export const organiserSecretFrom = (path: string): Uint8Array => {
  const f = readKeyFile(path, 'organiser');
  if (!f.secret) throw new Error(`${path} has no secret`);
  return fromHex(f.secret);
};

/**
 * The backup organiser's commitment. Its file may hold only the `public`
 * commitment (the secret stays offline); with a secret, the commitment is
 * recomputed from it.
 */
export const organiserCommitmentFrom = (path: string): Uint8Array => {
  const f = readKeyFile(path, 'organiser');
  if (f.secret) return organiserCommitmentOf(fromHex(f.secret));
  if (typeof f.public !== 'string') throw new Error(`${path} has neither a secret nor a public commitment`);
  return fromHex(f.public);
};

export const oracleKeyFrom = (path: string, needSecret: boolean): { pk: { x: bigint; y: bigint }; sk?: bigint } => {
  const f = readKeyFile(path, 'oracle');
  if (f.secret) {
    const sk = parseOracleSecretKey(f.secret);
    return { pk: oraclePublicKey(sk), sk };
  }
  if (needSecret) throw new Error(`${path} has no secret`);
  const pub = f.public as { x: string; y: string };
  return { pk: { x: BigInt(pub.x), y: BigInt(pub.y) } };
};

export const walletSeed = (path: string | undefined): string | undefined => {
  if (!path) return process.env.NIGHTCAST_WALLET_SEED;
  const f = readKeyFile(path, 'wallet');
  if (!f.seed) throw new Error(`${path} has no seed`);
  return f.seed;
};

/** A proof server already running (`./lunardraw proof-server`), instead of starting one. */
export const proofServerPort = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) throw new Error('--proof-server-port must be a port number');
  return port;
};

export const networkArg = (value: string | undefined): Network => {
  if (!value || !isNetwork(value)) throw new Error(`--network must be one of ${NETWORKS.join(', ')}`);
  return value;
};

export const withSession = async <T>(network: Network, run: (s: Session) => Promise<T>, proofServerPort?: number): Promise<T> => {
  const projectId = BLOCKFROST[network] ? blockfrostProjectId(network) : undefined;
  const session = await connect(network, { projectId, proofServerPort });
  try {
    return await run(session);
  } finally {
    await session.shutdown().catch((e) => session.logger.warn(`shutdown: ${e}`));
  }
};

export const publicDataFor = (network: Network) => {
  if (network === 'local') throw new Error('this command on `local` must run in the same session as the deploy');
  const config = publicEndpoints(network, createLogger('warn'), BLOCKFROST[network] ? blockfrostProjectId(network) : undefined);
  setNetworkId(config.networkId);
  return indexerPublicDataProvider(config.indexer, config.indexerWS);
};

/** The network's indexer GraphQL address (with the Blockfrost project id where needed). */
export const indexerUrlFor = (network: Network): string => {
  if (network === 'local') throw new Error('this command needs a public network');
  return publicEndpoints(network, createLogger('warn'), BLOCKFROST[network] ? blockfrostProjectId(network) : undefined).indexer;
};

export const localFingerprintsOrNone = () => {
  try {
    return localFingerprints(zkConfigPath());
  } catch {
    return undefined;
  }
};

/** Run until Ctrl+C (or SIGTERM, as Docker sends). */
export const untilStopped = () =>
  new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

/** Exit code that asks the service manager (systemd, or the tmux loop) to start the program again. */
export const RESTART = 75;

/**
 * Resolves when a program's transactions have kept failing, with nothing
 * succeeding, for `minutes` (and at least 3 attempts). The wallet's sync can go
 * stale (every fee proof then fails, node error 1010 custom 170); restarting
 * resyncs it. 0 turns this off.
 */
export const untilFailingFor = (
  minutes: number,
  streak: () => { since?: number; failures: number },
  logger: { error(msg: string): void },
): { done: Promise<boolean>; cancel(): void } => {
  let timer: ReturnType<typeof setInterval> | undefined;
  const done = new Promise<boolean>((resolve) => {
    if (!(minutes > 0)) return;
    timer = setInterval(() => {
      const s = streak();
      if (s.since !== undefined && s.failures >= 3 && Date.now() - s.since >= minutes * 60_000) {
        logger.error(
          `${s.failures} transactions in a row have failed over ${Math.round((Date.now() - s.since) / 60_000)} minutes; restarting to resync the wallet`,
        );
        resolve(true);
      }
    }, 30_000);
  });
  return {
    done,
    cancel: () => {
      if (timer) clearInterval(timer);
    },
  };
};

/**
 * Resolves (true) when no pass has finished for `minutes`: the process is
 * hung inside a pass (a chain read that never returns, say), which the
 * failing-transactions and sync watchdogs can't see. The caller exits so the
 * service manager restarts it. 0 turns it off. Because the hung pass may never
 * let a graceful stop finish, `forceExit` arms a hard exit after `graceMs`.
 */
export const untilSilentFor = (
  minutes: number,
  lastPassAt: () => number | undefined,
  logger: { error(msg: string): void },
): { done: Promise<boolean>; cancel(): void } => {
  let timer: ReturnType<typeof setInterval> | undefined;
  const started = Date.now();
  const done = new Promise<boolean>((resolve) => {
    if (!(minutes > 0)) return;
    timer = setInterval(() => {
      const last = lastPassAt() ?? started;
      if (Date.now() - last >= minutes * 60_000) {
        logger.error(`no pass has finished for ${Math.round((Date.now() - last) / 60_000)} minutes: the process is stuck; restarting`);
        resolve(true);
      }
    }, 30_000);
  });
  return {
    done,
    cancel: () => {
      if (timer) clearInterval(timer);
    },
  };
};

/** Exit with `code` after `ms` whatever is still running (a stuck pass can block a graceful stop forever). */
export const forceExit = (code: number, ms = 30_000): void => {
  setTimeout(() => process.exit(code), ms).unref();
};

export const silentAfter = (value: string | undefined): number => {
  const m = value === undefined ? 10 : Number(value);
  if (!(m >= 0)) throw new Error('--silent-after must be a number of minutes (0 to turn it off)');
  return m;
};

export const stallAfter = (value: string | undefined): number => {
  const m = value === undefined ? 15 : Number(value);
  if (!(m >= 0)) throw new Error('--stall-after must be a number of minutes (0 to turn it off)');
  return m;
};

export const restartAfter = (value: string | undefined): number => {
  // 3 minutes: well inside the shortest reveal window (10 minutes on the soak).
  const m = value === undefined ? 3 : Number(value);
  if (!(m >= 0)) throw new Error('--restart-after must be a number of minutes (0 to turn it off)');
  return m;
};

