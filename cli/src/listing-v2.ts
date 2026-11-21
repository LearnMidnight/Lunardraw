/**
 * The agent directory on Starfall v2: what an agent played and won in v2, from the v2 keeper's feed
 * (feed-v2.json: each draw's buyers by refund address and its prizes by payee, as the chain records
 * them) and, for Lunardraw's own agents, their own purchase record. Added to their Classic totals
 * (listing.ts), so a card shows everything an agent did.
 */
import { existsSync, readFileSync } from 'node:fs';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import { type AgentDraw, type AgentReport, type AgentStats, type AgentWin, emptyStats, periodStart } from './listing.js';

export type V2FeedDraw = {
  num: number;
  status: string;
  sales_close?: string;
  drawn_at?: string;
  prizes_star?: number[];
  format?: { numbers: number; moonball: number };
  buyers?: { address: string; games: number }[];
  payouts?: { address: string; division: number; games: number; star: number }[];
};

/** The v2 feed as the directory reads it: the price of a game and every draw, the one on sale included (status "open"). */
export type V2Directory = { contract?: string; price: number; draws: V2FeedDraw[]; current: number };

/** The v2 feed at `path` (feed-v2.json), or undefined. */
export const readV2Feed = (path: string): V2Directory | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    const feed = JSON.parse(readFileSync(path, 'utf8')) as {
      contracts?: { starfall?: string };
      games?: { starfall?: { price_star?: number; open?: V2FeedDraw & { num?: number }; draws?: V2FeedDraw[] } };
    };
    const g = feed.games?.starfall;
    if (!g) return undefined;
    const draws = [...(g.draws ?? [])];
    if (g.open?.num) draws.push({ ...g.open, num: Number(g.open.num), status: 'open' });
    const current = g.open?.num ? Number(g.open.num) : draws.reduce((m, d) => Math.max(m, d.num), 0) + 1;
    return { contract: feed.contracts?.starfall?.toLowerCase(), price: Number(g.price_star ?? 0), draws, current };
  } catch {
    return undefined;
  }
};

/** A wallet's 32 bytes in hex, from mn_addr_... (or hex); undefined if it isn't one. */
export const addressHexOf = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  const h = s.replace(/^0x/, '');
  if (/^[0-9a-fA-F]{64}$/.test(h)) return h.toLowerCase();
  try {
    const p = MidnightBech32m.parse(s);
    return p.type === 'addr' && p.data.length === 32 ? Buffer.from(p.data).toString('hex') : undefined;
  } catch {
    return undefined;
  }
};

const choose = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

/**
 * The chance one game wins any prize in a v2 draw's format: with a Moonball, 7, 6 and 5 right
 * (with or without it) and 4, 3 or 2 with it; with none, 7, 6, 5 and 4 right.
 */
export const v2PrizeChance = (f: { numbers: number; moonball: number }): number => {
  const all = choose(f.numbers, 7);
  const match = (k: number) => (choose(7, k) * choose(f.numbers - 7, 7 - k)) / all;
  if (f.moonball <= 1) return match(7) + match(6) + match(5) + match(4);
  return match(7) + match(6) + match(5) + (match(4) + match(3) + match(2)) / f.moonball;
};

/** One v2 draw an agent played: games and cost (STAR), when. */
export type V2Played = { draw: number; games: number; spent: number; at: string };

/** From a house agent's own record (<name>.v2-agent.json): its purchases, by draw. */
export const v2PlayedFromState = (s: { purchases?: { draw: string; at: string; games: number; cost: string }[] }): V2Played[] => {
  const by = new Map<number, V2Played>();
  for (const p of s.purchases ?? []) {
    const n = Number(p.draw);
    const r = by.get(n) ?? { draw: n, games: 0, spent: 0, at: p.at };
    r.games += p.games;
    r.spent += Number(p.cost);
    if (p.at < r.at) r.at = p.at;
    by.set(n, r);
  }
  return [...by.values()];
};

/** From the feed: the games a wallet bought in each draw (its tickets' refund address), at the draw's price. */
export const v2PlayedFromFeed = (f: V2Directory, address: string): V2Played[] =>
  f.draws.flatMap((d) => {
    const games = (d.buyers ?? []).filter((b) => b.address.toLowerCase() === address).reduce((a, b) => a + b.games, 0);
    return games ? [{ draw: d.num, games, spent: games * f.price, at: d.sales_close ?? '' }] : [];
  });

export type V2Win = AgentWin & { game: 'starfall' };

/**
 * An agent's v2 report: totals (all time, this week, this month), wins and history, from what it
 * played and the prizes the feed says were paid to `address` (none known without one).
 */
export const v2Report = (played: V2Played[], f: V2Directory, address: string | undefined, nowMs: number): AgentReport & { history: AgentDraw[]; wins: V2Win[] } => {
  const byNum = new Map(f.draws.map((d) => [d.num, d]));
  const prizesOf = (n: number) => (address ? (byNum.get(n)?.payouts ?? []).filter((p) => p.address.toLowerCase() === address) : []);
  const stats = (since?: string): AgentStats => {
    const s = emptyStats();
    for (const p of played) {
      const d = byNum.get(p.draw);
      if (d?.status === 'void') continue; // refunded
      if (since && p.at < since) continue;
      s.draws += 1;
      s.games += p.games;
      s.spent_star += p.spent;
      s.last_draw = Math.max(s.last_draw ?? 0, p.draw);
      if (!s.first_played || p.at < s.first_played) s.first_played = p.at;
      if (!s.last_played || p.at > s.last_played) s.last_played = p.at;
      for (const w of prizesOf(p.draw)) {
        s.winning_games += w.games;
        s.won_star += w.star;
      }
    }
    return s;
  };
  const week = periodStart('week', nowMs);
  const month = periodStart('month', nowMs);
  const wins: V2Win[] = played
    .flatMap((p) => {
      const w = prizesOf(p.draw);
      if (!w.length) return [];
      return [{ game: 'starfall' as const, draw: p.draw, division: Math.min(...w.map((x) => x.division)), games: w.reduce((a, x) => a + x.games, 0), won_star: w.reduce((a, x) => a + x.star, 0) }];
    })
    .sort((a, b) => b.draw - a.draw);
  const history = played
    .filter((p) => byNum.get(p.draw)?.status !== 'void')
    .sort((a, b) => a.draw - b.draw)
    .map((p) => {
      const d = byNum.get(p.draw);
      const w = prizesOf(p.draw);
      return {
        game: 'starfall' as const,
        draw: p.draw,
        games: p.games,
        spent_star: p.spent,
        winning_games: w.reduce((a, x) => a + x.games, 0),
        won_star: w.reduce((a, x) => a + x.star, 0),
        at: p.at,
        ...(d?.status === 'settled' ? {} : { pending: true }),
        ...(d?.format ? { chance: v2PrizeChance(d.format) } : {}),
      };
    });
  return { stats: stats(), week: { ...stats(week), since: week }, month: { ...stats(month), since: month }, wins, history };
};

/** Two sets of totals added up (Classic and v2). */
export const addStats = (a: AgentStats, b: AgentStats): AgentStats => {
  const min = (x?: string, y?: string) => (x && y ? (x < y ? x : y) : (x ?? y));
  const max = (x?: string, y?: string) => (x && y ? (x > y ? x : y) : (x ?? y));
  const out: AgentStats = {
    draws: a.draws + b.draws,
    games: a.games + b.games,
    spent_star: a.spent_star + b.spent_star,
    winning_games: a.winning_games + b.winning_games,
    won_star: a.won_star + b.won_star,
  };
  // the game it played most recently decides last_draw (each game numbers its own draws)
  const last = (b.last_played ?? '') > (a.last_played ?? '') ? b : a;
  if (last.last_draw !== undefined) out.last_draw = last.last_draw;
  const first = min(a.first_played, b.first_played);
  const lastAt = max(a.last_played, b.last_played);
  if (first) out.first_played = first;
  if (lastAt) out.last_played = lastAt;
  return out;
};

/** Whether an agent has bought in one of the last 3 draws of v2 (for "online" versus "idle"). */
export const v2Recent = (played: V2Played[], f: V2Directory | undefined): boolean =>
  !!f && played.some((p) => p.draw >= f.current - 3);
