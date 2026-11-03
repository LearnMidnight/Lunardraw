/**
 * Agent listings for lunardraw.io's agent directory.
 *
 * An agent's owner can list it (opt in): the agent then reports its name,
 * style and totals, signed with its wallet's unshielded key, so a listing can
 * only come from the wallet it names. The totals are the agent's own record
 * of what it bought (tickets are private on chain, so no one else can count
 * them); prizes are counted from the drawn numbers and each division's
 * published prize. The agent's numbers are never sent.
 *
 * Lunardraw's own agents (Nova, Orbit, Pixel on the keeper VM) are read by the
 * registry from their state files directly, with the same `agentStats`.
 */
import { Starfall } from '@lunardraw/contract';
import type { AgentState } from './starfall-agent.js';

/** A drawn or settled draw, as the feed or the chain view gives it. */
export type DrawOutcome = {
  num: number;
  status: string;
  numbers?: number[];
  moonball?: number;
  /** Each division's prize per game in STAR (division 1 first), once the draw is settled. */
  prizes_star?: number[];
  drawn_at?: string;
};

export type AgentStats = {
  /** Draws played (void ones not counted). */
  draws: number;
  games: number;
  spent_star: number;
  /** Games that won a prize. */
  winning_games: number;
  /** Prizes won, in STAR, for settled draws. */
  won_star: number;
  last_draw?: number;
  first_played?: string;
  last_played?: string;
};

export const emptyStats = (): AgentStats => ({ draws: 0, games: 0, spent_star: 0, winning_games: 0, won_star: 0 });

/**
 * The start of this week (Monday 00:00) or month (the 1st) on Brisbane time,
 * UTC+10 all year: the leaderboard's periods.
 */
export const periodStart = (period: 'week' | 'month', nowMs: number): string => {
  const OFFSET = 10 * 3_600_000;
  const local = new Date(nowMs + OFFSET);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const startLocal = period === 'month' ? Date.UTC(y, m, 1) : Date.UTC(y, m, d) - ((local.getUTCDay() + 6) % 7) * 86_400_000;
  return new Date(startLocal - OFFSET).toISOString();
};

/** A win, for the biggest-wins list: one draw, the best division won, and the total won in it. */
export type AgentWin = { draw: number; division: number; games: number; won_star: number };

/** An agent's totals from its own purchase record and the draws' outcomes (purchases from `since` on, if given). */
export const agentStats = (state: AgentState, draws: DrawOutcome[], since?: string): AgentStats => {
  const byNum = new Map(draws.map((d) => [d.num, d]));
  const s = emptyStats();
  const played = new Set<number>();
  for (const p of state.purchases) {
    if (since && p.at < since) continue;
    const num = Number(p.draw);
    const d = byNum.get(num);
    if (d?.status === 'void') continue; // refunded
    played.add(num);
    s.games += p.games;
    s.spent_star += Number(p.cost);
    s.last_draw = Math.max(s.last_draw ?? 0, num);
    if (!s.first_played || p.at < s.first_played) s.first_played = p.at;
    if (!s.last_played || p.at > s.last_played) s.last_played = p.at;
    if (!d?.numbers || d.moonball === undefined || !d.numbers.some((n) => n > 0)) continue;
    for (const e of p.entries) {
      const won = Starfall.gamesByDivisionFor(e, d.numbers, d.moonball);
      won.forEach((games, i) => {
        if (!games) return;
        s.winning_games += Number(games);
        if (d.prizes_star?.[i]) s.won_star += Number(games) * d.prizes_star[i]!;
      });
    }
  }
  s.draws = played.size;
  return s;
};

/** Every draw the agent won something in (settled draws), newest first. */
export const agentWins = (state: AgentState, draws: DrawOutcome[]): AgentWin[] => {
  const byNum = new Map(draws.map((d) => [d.num, d]));
  const perDraw = new Map<number, AgentWin>();
  for (const p of state.purchases) {
    const num = Number(p.draw);
    const d = byNum.get(num);
    if (!d?.numbers || d.moonball === undefined || !d.prizes_star || d.status === 'void') continue;
    for (const e of p.entries) {
      Starfall.gamesByDivisionFor(e, d.numbers, d.moonball).forEach((g, i) => {
        if (!g) return;
        const w = perDraw.get(num) ?? { draw: num, division: i + 1, games: 0, won_star: 0 };
        w.division = Math.min(w.division, i + 1);
        w.games += Number(g);
        w.won_star += Number(g) * (d.prizes_star![i] ?? 0);
        perDraw.set(num, w);
      });
    }
  }
  return [...perDraw.values()].sort((a, b) => b.draw - a.draw);
};

/** What an agent reports: all-time totals, this week's and month's, and its recent wins. */
export type AgentReport = { stats: AgentStats; week: AgentStats & { since: string }; month: AgentStats & { since: string }; wins: AgentWin[] };

export const agentReport = (state: AgentState, draws: DrawOutcome[], nowMs: number): AgentReport => {
  const week = periodStart('week', nowMs);
  const month = periodStart('month', nowMs);
  return {
    stats: agentStats(state, draws),
    week: { ...agentStats(state, draws, week), since: week },
    month: { ...agentStats(state, draws, month), since: month },
    wins: agentWins(state, draws).slice(0, 20),
  };
};

// ------------------------------------------------------------------ the signed listing

export const LISTING_PREFIX = 'lunardraw-agent-listing\n';

/** How an agent plays (for the directory's "via"). */
export const VIAS = ['claude', 'gemini', 'openclaw', 'hermes', 'mcp', 'cli', 'other'] as const;
export type Via = (typeof VIAS)[number];

export type ListingPayload = {
  v: 1;
  network: string;
  /** The wallet's unshielded signature verifying key (hex). */
  key: string;
  action: 'list' | 'unlist';
  name: string;
  style: string;
  via: Via;
  stats: AgentStats;
  week?: AgentStats & { since: string };
  month?: AgentStats & { since: string };
  wins?: AgentWin[];
  /** When it was signed (ISO); a report more than 10 minutes off is refused. */
  at: string;
};

export const NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,19}$/;

/** Why a name, style or via can't be listed, or undefined. */
export const listingProblem = (p: { name: string; style: string; via: string }): string | undefined => {
  if (!NAME_RULE.test(p.name)) return 'the name must be 2 to 20 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit';
  if (p.style.length > 40 || /[\u0000-\u001f<>]/.test(p.style)) return 'the style must be up to 40 characters, with no < or >';
  if (!(VIAS as readonly string[]).includes(p.via)) return `via must be one of ${VIAS.join(', ')}`;
  return undefined;
};

/** The bytes that are signed: a fixed prefix and the payload exactly as sent. */
export const listingMessage = (payload: string): Uint8Array => new TextEncoder().encode(LISTING_PREFIX + payload);

export type Signer = { key: string; address: string; sign(data: Uint8Array): string };

/** A signed listing report, ready to POST to the registry. */
export const signedListing = (signer: Signer, p: Omit<ListingPayload, 'v' | 'key' | 'at'>, now: Date = new Date()): { payload: string; signature: string } => {
  const problem = listingProblem(p);
  if (problem) throw new Error(problem);
  const payload = JSON.stringify({
    v: 1,
    network: p.network,
    key: signer.key,
    action: p.action,
    name: p.name,
    style: p.style,
    via: p.via,
    stats: p.stats,
    ...(p.week ? { week: p.week } : {}),
    ...(p.month ? { month: p.month } : {}),
    ...(p.wins ? { wins: p.wins } : {}),
    at: now.toISOString(),
  } satisfies ListingPayload);
  return { payload, signature: signer.sign(listingMessage(payload)) };
};

/**
 * The agent's signer, from its wallet seed: the same key its unshielded
 * address comes from (wallet-sdk's createKeystore: the unshielded seed is the
 * signing key).
 */
export const walletSigner = async (seed: string, network: string): Promise<Signer> => {
  const { WalletSeeds } = await import('@midnight-ntwrk/testkit-js');
  const ledger = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const sk = Buffer.from(WalletSeeds.fromMasterSeed(seed).unshielded).toString('hex');
  const key = ledger.signatureVerifyingKey(sk) as unknown as string;
  return {
    key,
    address: await bech32Address(ledger.addressFromKey(key as never) as unknown as string, network),
    sign: (data) => ledger.signData(sk, data) as unknown as string,
  };
};

/** mn_addr_... for a 32-byte address in hex. */
export const bech32Address = async (hex: string, network: string): Promise<string> => {
  const { UnshieldedAddress } = await import('@midnight-ntwrk/wallet-sdk-address-format');
  return UnshieldedAddress.codec.encode(network as never, new UnshieldedAddress(Buffer.from(hex, 'hex'))).asString();
};
