/**
 * When each draw's steps happened, as this keeper saw them: the chain keeps no
 * clock for the reveal or the oracle's answer (only deadlines), so the keeper
 * notes the first pass on which it sees each status. The numbers' time is
 * exact (the contract stamps it). The site uses these to say how long each
 * step of a draw takes, from real draws rather than a fixed guess.
 *
 * Kept in a small JSON file next to the feed, so a restart doesn't lose them;
 * at most the last `keep` draws.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Starfall } from '@lunardraw/contract';
import type { StarfallTxStep, StarfallView } from './starfall.js';

const { DrawStatus } = Starfall;

/** Unix seconds of each step, once seen. */
export type StepRecord = {
  revealed?: number;
  answered?: number;
  drawn?: number;
  settled?: number;
  voided?: number;
  /** The transactions this keeper sent for the draw's steps, by step (the feed's `tx`). */
  tx?: Partial<Record<StarfallTxStep, string>>;
};

export class StepTimes {
  private readonly times = new Map<bigint, StepRecord>();
  private loaded = false;
  /** Transaction ids read back from the chain for older draws (`starfall backfill-tx`), reloaded when the file changes. */
  private backfill = new Map<bigint, Partial<Record<StarfallTxStep, string>>>();
  private backfillStamp = -1;

  constructor(
    private readonly path?: string,
    private readonly keep = 60,
    private readonly backfillPath?: string,
  ) {}

  private loadBackfill(): void {
    if (!this.backfillPath) return;
    let stamp = 0;
    try {
      stamp = existsSync(this.backfillPath) ? statSync(this.backfillPath).mtimeMs : 0;
    } catch {
      return;
    }
    if (stamp === this.backfillStamp) return;
    this.backfillStamp = stamp;
    this.backfill = new Map();
    if (!stamp) return;
    try {
      const raw = JSON.parse(readFileSync(this.backfillPath, 'utf8')) as Record<string, { tx?: Partial<Record<StarfallTxStep, string>> }>;
      for (const [id, rec] of Object.entries(raw)) if (rec?.tx) this.backfill.set(BigInt(id), rec.tx);
    } catch {
      /* a broken file adds nothing */
    }
  }

  /** Load the file, once (a missing or broken file is an empty record). */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, StepRecord>;
      for (const [id, rec] of Object.entries(raw)) this.times.set(BigInt(id), rec);
    } catch {
      /* start afresh */
    }
  }

  private save(): void {
    if (!this.path) return;
    const ids = [...this.times.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of ids.slice(0, Math.max(0, ids.length - this.keep))) this.times.delete(id);
    const out: Record<string, StepRecord> = {};
    for (const id of [...this.times.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[id.toString()] = this.times.get(id)!;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    renameSync(tmp, this.path);
  }

  /** Note the steps this view shows for the first time, at chain time `nowSecs`. */
  observe(view: StarfallView, nowSecs: number): void {
    this.load();
    const now = Math.floor(nowSecs);
    let changed = false;
    for (const d of view.draws) {
      const rec = this.times.get(d.id) ?? {};
      const was = { ...rec };
      const s = d.status;
      if (s >= DrawStatus.requested && s !== DrawStatus.voided && rec.revealed === undefined) rec.revealed = now;
      if (s >= DrawStatus.fulfilled && s !== DrawStatus.voided && rec.answered === undefined) rec.answered = now;
      if ((s === DrawStatus.drawn || s === DrawStatus.settled) && rec.drawn === undefined) {
        // computeNumbers sets the settlement deadline settleWindow after its clock: exact.
        rec.drawn = Number(d.settleDeadline - view.settleWindow);
      }
      if (s === DrawStatus.settled && rec.settled === undefined) rec.settled = now;
      if (s === DrawStatus.voided && rec.voided === undefined) rec.voided = now;
      if (JSON.stringify(was) !== JSON.stringify(rec)) {
        this.times.set(d.id, rec);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Note the transaction a step of draw `id` went in (the keeper's `onTx`). */
  noteTx(id: bigint, step: StarfallTxStep, txId: string): void {
    this.load();
    const rec = this.times.get(id) ?? {};
    if (rec.tx?.[step] === txId) return;
    this.times.set(id, { ...rec, tx: { ...rec.tx, [step]: txId } });
    this.save();
  }

  /** A draw's record, with any backfilled transaction ids under its own (its own win). */
  get(id: bigint): StepRecord | undefined {
    this.load();
    const own = this.times.get(id);
    const back = this.backfill.get(id);
    if (!back) return own;
    return { ...own, tx: { ...back, ...own?.tx } };
  }

  /** For the feed: a lookup by draw id (the backfill file is checked for changes once per call). */
  lookup(): (id: bigint) => StepRecord | undefined {
    this.loadBackfill();
    return (id) => this.get(id);
  }
}
