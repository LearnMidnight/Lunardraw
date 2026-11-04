/**
 * Purchases as the keeper sees them, for the site's live feed: each time a
 * selling draw's games go up, that's a purchase (or a few, if they landed
 * between two passes), timed by the keeper's pass. Only the draw, the games
 * and the tickets: who bought and which numbers stay private.
 *
 * Kept beside the feed (`feed.json.purchases.json`) so a restart neither
 * forgets them nor reports the games already sold as one big purchase.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Starfall } from '@lunardraw/contract';
import type { StarfallDrawView } from './starfall.js';

const { DrawStatus } = Starfall;

/** One purchase (or several landing between two passes of the keeper). */
export type Purchase = { draw: number; games: number; tickets: number; at: string };

type Seen = Record<string, { games: number; tickets: number }>;
type Saved = { seen: Seen; purchases: Purchase[] };

export class PurchaseLog {
  private seen: Seen = {};
  private purchases: Purchase[] = [];
  private loaded = false;
  /** False until the first pass: games sold before it aren't news. */
  private primed = false;

  constructor(
    private readonly path?: string,
    private readonly keep = 50,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Saved>;
      this.seen = raw.seen && typeof raw.seen === 'object' ? raw.seen : {};
      this.purchases = Array.isArray(raw.purchases) ? raw.purchases.slice(0, this.keep) : [];
      this.primed = Object.keys(this.seen).length > 0;
    } catch {
      /* start afresh */
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ seen: this.seen, purchases: this.purchases } satisfies Saved, null, 2) + '\n');
    renameSync(tmp, this.path);
  }

  /** Note the games each selling draw gained since the last pass, at chain time `nowSecs`. */
  observe(view: { draws: Pick<StarfallDrawView, 'id' | 'status' | 'games' | 'tickets'>[] }, nowSecs: number): void {
    this.load();
    const at = new Date(Math.floor(nowSecs) * 1000).toISOString();
    const next: Seen = {};
    let changed = false;
    for (const d of view.draws) {
      if (d.status !== DrawStatus.open) continue;
      const id = d.id.toString();
      const now = { games: Number(d.games), tickets: Number(d.tickets) };
      next[id] = now;
      const was = this.seen[id];
      // a draw first seen on the very first pass may already have sales: not news
      const before = was ?? (this.primed ? { games: 0, tickets: 0 } : now);
      if (now.games > before.games) {
        this.purchases.unshift({ draw: Number(d.id), games: now.games - before.games, tickets: Math.max(0, now.tickets - before.tickets), at });
        changed = true;
      }
      if (!was || was.games !== now.games || was.tickets !== now.tickets) changed = true;
    }
    if (Object.keys(this.seen).some((id) => !(id in next))) changed = true;
    this.seen = next;
    this.primed = true;
    if (this.purchases.length > this.keep) this.purchases.length = this.keep;
    if (changed) this.save();
  }

  /** The newest purchases first, at most `n`. */
  recent(n = 20): Purchase[] {
    this.load();
    return this.purchases.slice(0, n);
  }
}
