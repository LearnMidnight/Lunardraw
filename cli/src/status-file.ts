/**
 * A small health file that the Starfall keeper and oracle rewrite every
 * minute (`--status <file>`), for `./lunardraw monitor` to read.
 *
 * It's written on a timer of its own, not by the passes, so a process that is
 * alive but stuck inside a pass still writes it (with an old `last_pass_at`),
 * and a process that has stopped leaves it to go stale. Nothing in it is
 * secret: the wallet's balances and the failure streak.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ServiceStatus = {
  schema: 'lunardraw-status/1';
  service: string;
  pid: number;
  started_at: string;
  /** When this file was written. */
  at: string;
  /** When the last pass (a read of the chain and any steps due) finished. */
  last_pass_at?: string;
  /** Transactions failing in a row, and since when. */
  failures: number;
  failing_since?: string;
  last_success_at?: string;
  wallet?: {
    synced: boolean;
    /** tNIGHT held (the base unit, as a decimal string). */
    night: string;
    /** DUST available for fees now (the base unit, as a decimal string). */
    dust: string;
  };
};

type StateLike = {
  isSynced?: boolean;
  dust?: { balance?(at: Date): bigint };
  unshielded?: { balances?: Record<string, bigint> };
};
type Subscribable = { subscribe(next: (s: unknown) => void): { unsubscribe(): void } };

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

/** The status of one service at `now` (ms), from its latest wallet state and its passes. */
export const serviceStatus = (
  service: string,
  startedAt: number,
  now: number,
  pass: { lastTickAt?: number; streak: { since?: number; failures: number; lastSuccessAt?: number } },
  state: unknown,
  nightToken: string,
): ServiceStatus => {
  const s = state as StateLike | undefined;
  let wallet: ServiceStatus['wallet'];
  if (s) {
    let dust = 0n;
    try {
      dust = s.dust?.balance?.(new Date(now)) ?? 0n;
    } catch {
      /* a wallet still syncing its DUST part: report none */
    }
    wallet = { synced: s.isSynced === true, night: String(s.unshielded?.balances?.[nightToken] ?? 0n), dust: String(dust) };
  }
  return {
    schema: 'lunardraw-status/1',
    service,
    pid: process.pid,
    started_at: iso(startedAt)!,
    at: iso(now)!,
    last_pass_at: iso(pass.lastTickAt),
    failures: pass.streak.failures,
    failing_since: iso(pass.streak.since),
    last_success_at: iso(pass.streak.lastSuccessAt),
    wallet,
  };
};

/** Write `status` to `path` whole (a reader never sees half a file). */
export const writeStatus = (path: string, status: ServiceStatus): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
  renameSync(tmp, path);
};

/**
 * Keep `path` up to date every `everyMs` (default a minute) until stopped. A
 * failed write is logged once and retried on the next beat: the status file
 * must never stop the service it reports on.
 */
export const statusWriter = (
  path: string,
  opts: {
    service: string;
    wallet: { wallet: { state(): Subscribable } };
    pass: () => { lastTickAt?: number; streak: { since?: number; failures: number; lastSuccessAt?: number } };
    nightToken: string;
    logger: { warn(msg: string): void };
    everyMs?: number;
  },
): { stop(): void } => {
  const startedAt = Date.now();
  let latest: unknown;
  const sub = opts.wallet.wallet.state().subscribe((s) => (latest = s));
  let warned = false;
  const beat = () => {
    try {
      writeStatus(path, serviceStatus(opts.service, startedAt, Date.now(), opts.pass(), latest, opts.nightToken));
      warned = false;
    } catch (err) {
      if (!warned) opts.logger.warn(`could not write the status file ${path}: ${err instanceof Error ? err.message : String(err)}`);
      warned = true;
    }
  };
  beat();
  const timer = setInterval(beat, opts.everyMs ?? 60_000);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      sub.unsubscribe();
    },
  };
};
