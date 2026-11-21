/**
 * Purchases as the keeper sees them, for the site's live feed: each time a
 * selling draw's games go up, that's a purchase (or a few, if they landed
 * between two passes), timed by the keeper's pass. The draw, the games, the
 * tickets and, where the chain records it (Starfall v2's refund address, already
 * public in each draw's buyers), the wallet that bought; the numbers stay private.
 * The site names a purchase only when that wallet is a listed agent.
 *
 * Kept beside the feed (`feed.json.purchases.json`) so a restart neither
 * forgets them nor reports the games already sold as one big purchase.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Starfall } from '@lunardraw/contract';
import type { StarfallDrawView } from './starfall.js';

const { DrawStatus } = Starfall;

/** One purchase (or several by one wallet landing between two passes of the keeper); `buyer` is its wallet in hex, where known. */
export type Purchase = { draw: number; games: number; tickets: number; at: string; buyer?: string };

type Counts = { games: number; tickets: number };
type Seen = Record<string, Counts & { buyers?: Record<string, Counts> }>;
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
  observe(view: { draws: (Pick<StarfallDrawView, 'id' | 'status' | 'games' | 'tickets'> & Partial<Pick<StarfallDrawView, 'buyers'>>)[] }, nowSecs: number): void {
    this.load();
    const at = new Date(Math.floor(nowSecs) * 1000).toISOString();
    const next: Seen = {};
    let changed = false;
    for (const d of view.draws) {
      if (d.status !== DrawStatus.open) continue;
      const id = d.id.toString();
      const buyers = buyersOf(d.buyers);
      const now = { games: Number(d.games), tickets: Number(d.tickets), ...(buyers ? { buyers } : {}) };
      next[id] = now;
      const was = this.seen[id];
      // a draw first seen on the very first pass may already have sales: not news
      const before = was ?? (this.primed ? { games: 0, tickets: 0, buyers: {} } : now);
      if (now.games > before.games) {
        const games = now.games - before.games;
        const tickets = Math.max(0, now.tickets - before.tickets);
        const by = byBuyer(before.buyers, buyers, games);
        if (by) for (const [buyer, c] of by) this.purchases.unshift({ draw: Number(d.id), games: c.games, tickets: c.tickets, at, buyer });
        else this.purchases.unshift({ draw: Number(d.id), games, tickets, at });
        changed = true;
      }
      if (!was || was.games !== now.games || was.tickets !== now.tickets || JSON.stringify(was.buyers) !== JSON.stringify(now.buyers)) changed = true;
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

/** A draw's buyers by wallet, or undefined if the view doesn't say who bought. */
const buyersOf = (b: StarfallDrawView['buyers']): Record<string, Counts> | undefined => {
  if (!b) return undefined;
  const out: Record<string, Counts> = {};
  for (const x of b) out[x.address.toLowerCase()] = { games: Number(x.games), tickets: x.tickets ?? 0 };
  return out;
};

/**
 * What each wallet bought between two passes, biggest first, or undefined if it can't be told
 * (no buyers on one side, or the wallets' gains don't add up to the draw's).
 */
const byBuyer = (before: Record<string, Counts> | undefined, now: Record<string, Counts> | undefined, games: number): [string, Counts][] | undefined => {
  if (!before || !now) return undefined;
  const gained: [string, Counts][] = [];
  for (const [a, c] of Object.entries(now)) {
    const b = before[a] ?? { games: 0, tickets: 0 };
    if (c.games > b.games) gained.push([a, { games: c.games - b.games, tickets: Math.max(0, c.tickets - b.tickets) }]);
  }
  if (!gained.length || gained.reduce((n, [, c]) => n + c.games, 0) !== games) return undefined;
  // unshifted in turn, so the smallest goes in first and the biggest ends up newest
  return gained.sort((x, y) => x[1].games - y[1].games);
};
