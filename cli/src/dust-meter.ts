/**
 * What each transaction costs in DUST, measured from the transactions
 * themselves.
 *
 * A balanced transaction declares its fee publicly: each intent's DUST spends
 * carry `vFee`, in Specks (10^15 a DUST). This reads that from every
 * transaction the keeper or oracle submits successfully, names it after the
 * circuit it calls, logs it, and keeps a week of them (in a small file beside
 * the status file, so restarts don't lose them). The status file then
 * reports each circuit's typical cost and the DUST spent in the last 24
 * hours. With the wallet's NIGHT and Midnight's generation rate, that tells
 * the monitor whether fees are outrunning generation, and how much NIGHT the
 * wallet needs.
 *
 * Nothing here is secret: fees and circuit names are public on chain.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Specks in a DUST. */
export const SPECKS_PER_DUST = 10n ** 15n;
/** DUST a NIGHT generates in a day at Midnight's rate (5 DUST per NIGHT, filled in 604,815 s). */
export const DUST_PER_NIGHT_DAY = (5 * 86_400) / 604_815;
const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

export type FeeRecord = { at: number; circuit: string; specks: string };

export type FeeSummary = {
  /** Per circuit: how many were measured, and the average and latest fee, in DUST. */
  circuits: Record<string, { count: number; avg_dust: number; last_dust: number }>;
  /** DUST spent on fees in the last 24 hours, and how many transactions that was. */
  last_24h_dust: number;
  last_24h_txs: number;
  /** Since when records go back (they're kept a week). */
  since?: string;
};

const dust = (specks: bigint): number => Number(specks) / 1e15;

/** The DUST fee a transaction declares, and the circuit it calls ('' if none). */
export const dustFeeOf = (tx: unknown): { circuit: string; specks: bigint } | undefined => {
  const intents = (tx as { intents?: Map<number, unknown> } | undefined)?.intents;
  if (!intents || typeof (intents as Map<number, unknown>).values !== 'function') return undefined;
  let specks = 0n;
  let circuit = '';
  let seen = false;
  for (const intent of (intents as Map<number, unknown>).values()) {
    const i = intent as { dustActions?: { spends?: { vFee?: bigint }[] }; actions?: { entryPoint?: Uint8Array | string }[] };
    for (const s of i.dustActions?.spends ?? []) {
      if (typeof s.vFee === 'bigint') {
        specks += s.vFee;
        seen = true;
      }
    }
    for (const a of i.actions ?? []) {
      if (circuit || a.entryPoint === undefined) continue;
      circuit = typeof a.entryPoint === 'string' ? a.entryPoint : new TextDecoder().decode(a.entryPoint);
    }
  }
  return seen ? { circuit, specks } : undefined;
};

export class DustMeter {
  private records: FeeRecord[] = [];

  constructor(
    private readonly file?: string,
    private readonly clock: () => number = Date.now,
  ) {
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { records?: FeeRecord[] };
        this.records = (saved.records ?? []).filter((r) => typeof r.at === 'number' && typeof r.specks === 'string');
      } catch {
        /* none yet */
      }
    }
  }

  record(circuit: string, specks: bigint): void {
    const now = this.clock();
    this.records = this.records.filter((r) => r.at > now - WEEK_MS);
    this.records.push({ at: now, circuit: circuit || 'other', specks: specks.toString() });
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify({ records: this.records }) + '\n');
        renameSync(`${this.file}.tmp`, this.file);
      } catch {
        /* measuring must never stop the service */
      }
    }
  }

  summary(): FeeSummary {
    const now = this.clock();
    const kept = this.records.filter((r) => r.at > now - WEEK_MS);
    const circuits: FeeSummary['circuits'] = {};
    const sums: Record<string, bigint> = {};
    for (const r of kept) {
      const s = BigInt(r.specks);
      sums[r.circuit] = (sums[r.circuit] ?? 0n) + s;
      const c = (circuits[r.circuit] ??= { count: 0, avg_dust: 0, last_dust: 0 });
      c.count += 1;
      c.last_dust = dust(s);
    }
    for (const [k, c] of Object.entries(circuits)) c.avg_dust = dust(sums[k]) / c.count;
    const day = kept.filter((r) => r.at > now - DAY_MS);
    return {
      circuits,
      last_24h_dust: day.reduce((a, r) => a + dust(BigInt(r.specks)), 0),
      last_24h_txs: day.length,
      since: kept.length ? new Date(kept[0].at).toISOString() : undefined,
    };
  }
}

type Logger = { info(msg: string): void };

/**
 * Measure every transaction `midnightProvider.submitTx` sends successfully.
 * Wrap the provider closest to the node (inside any re-balancing wrapper), so
 * the fee measured is the one that was paid.
 */
export const meterDustFees = <P extends { midnightProvider: unknown }>(providers: P, meter: DustMeter, logger?: Logger): P => {
  const inner = providers.midnightProvider as { submitTx(tx: unknown): Promise<unknown> };
  const submitTx = async (tx: unknown) => {
    const out = await inner.submitTx.call(inner, tx);
    try {
      const fee = dustFeeOf(tx);
      if (fee) {
        meter.record(fee.circuit, fee.specks);
        logger?.info(`fee for ${fee.circuit || 'a transaction'}: ${dust(fee.specks).toFixed(4)} DUST`);
      }
    } catch {
      /* measuring must never stop the service */
    }
    return out;
  };
  // A proxy, not a copy: the provider is a class instance whose other methods live on its prototype.
  const midnightProvider = new Proxy(inner as object, {
    get(t, p) {
      if (p === 'submitTx') return submitTx;
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { ...providers, midnightProvider };
};
