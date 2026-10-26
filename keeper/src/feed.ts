/**
 * The site feed (`lunardraw-feed/1`): one JSON document describing the
 * deployment and every draw, built from the contract's public state and
 * written to a file after each keeper pass. The website fetches it from a
 * public URL (or loads the file by hand) and shows the draws.
 *
 * The format is the one the Lunardraw site reads for the Starfall settlement
 * contract. This keeper runs the v0 contract (1 tNIGHT a line, no fee, v0's
 * division shares, claims instead of settlement batches), so the feed says
 * `"contract": "lunardraw-v0"` and the site is expected to skip the prize
 * checks that only hold for the settlement contract; seed, VRF output and
 * numbers check out the same way for both.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DrawStatus } from '@lunardraw/contract';
import type { ChainView, DrawView } from './chain.js';

/** v0's division shares in basis points (division 1 first), as in the contract. */
export const V0_SHARES_BP = [3000, 700, 560, 560, 630, 700, 700, 1400, 1750] as const;

export type FeedDraw = {
  num: number;
  status: 'open' | 'closed' | 'requested' | 'drawn' | 'settled' | 'void';
  sales_close: string;
  drawn_at?: string;
  seed_commitment: string;
  seed?: string;
  vrf_output?: string;
  numbers?: number[];
  moonball?: number;
  games_sold: number;
  carried_in_star?: number;
  winners?: number[];
  prizes_star?: number[];
  carry_out_star?: number;
  claim_deadline?: string;
  reveal_deadline?: string;
  draw_deadline?: string;
};

export type Feed = {
  schema: 'lunardraw-feed/1';
  network: string;
  generated_at: string;
  sample: false;
  contracts: { starfall: string };
  games: {
    starfall: {
      contract: 'lunardraw-v0';
      price_star: number;
      fee_star: 0;
      allocation_bp: number[];
      carry_star: number;
      open?: { num: number; sales_close: string; seed_commitment: string; games_sold: number };
      draws: FeedDraw[];
    };
  };
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);
const iso = (secs: bigint): string => new Date(Number(secs) * 1000).toISOString();
const star = (v: bigint): number => Number(v);

/** The feed's status for a draw, given the chain time. */
export const feedStatus = (d: DrawView, nowSecs: number): FeedDraw['status'] => {
  switch (d.status) {
    case DrawStatus.open:
      return BigInt(Math.floor(nowSecs)) >= d.salesClose ? 'closed' : 'open';
    case DrawStatus.requested:
    case DrawStatus.fulfilled:
      return 'requested';
    case DrawStatus.drawn:
      return 'drawn';
    case DrawStatus.settled:
      return 'settled';
    case DrawStatus.voided:
      return 'void';
    default:
      return 'void';
  }
};

/** Build the feed from a view of the contract at chain time `nowSecs`. */
export const buildFeed = (
  view: ChainView,
  opts: { network: string; contract: string; nowSecs: number; generatedAt?: Date },
): Feed => {
  const draws = [...view.draws].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
  // carry_out of a settled draw = carried_in of the next settled draw, or the
  // current carry for the latest one.
  const settled = draws.filter((d) => d.status === DrawStatus.settled);
  const carryOut = new Map<bigint, bigint>();
  settled.forEach((d, i) => carryOut.set(d.id, i === 0 ? view.carry : settled[i - 1].carried));

  const toFeed = (d: DrawView): FeedDraw => {
    const status = feedStatus(d, opts.nowSecs);
    const out: FeedDraw = {
      num: Number(d.id),
      status,
      sales_close: iso(d.salesClose),
      seed_commitment: hex(d.seedCommitment),
      games_sold: Number(d.lines),
      reveal_deadline: iso(d.revealDeadline),
      draw_deadline: iso(d.drawDeadline),
    };
    if (!isZero(d.seed)) out.seed = hex(d.seed);
    if (!isZero(d.output)) out.vrf_output = hex(d.output);
    if (d.status === DrawStatus.drawn || d.status === DrawStatus.settled) {
      out.numbers = d.numbers;
      out.moonball = d.moonball;
      // computeNumbers starts the claim window from its clock, so the draw was computed claimWindow before the deadline.
      out.drawn_at = iso(d.claimDeadline - view.claimWindow);
      out.claim_deadline = iso(d.claimDeadline);
      out.winners = d.winners.map(Number);
    }
    if (d.status === DrawStatus.settled) {
      out.carried_in_star = star(d.carried);
      out.prizes_star = d.prizes.map(star);
      out.carry_out_star = star(carryOut.get(d.id) ?? 0n);
    }
    return out;
  };

  const selling = draws.find((d) => d.status === DrawStatus.open);
  return {
    schema: 'lunardraw-feed/1',
    network: opts.network,
    generated_at: (opts.generatedAt ?? new Date()).toISOString(),
    sample: false,
    contracts: { starfall: opts.contract },
    games: {
      starfall: {
        contract: 'lunardraw-v0',
        price_star: star(view.linePrice),
        fee_star: 0,
        allocation_bp: [...V0_SHARES_BP],
        carry_star: star(view.carry),
        open: selling
          ? { num: Number(selling.id), sales_close: iso(selling.salesClose), seed_commitment: hex(selling.seedCommitment), games_sold: Number(selling.lines) }
          : undefined,
        draws: draws.filter((d) => d !== selling).map(toFeed),
      },
    },
  };
};

/** Write the feed to `path` atomically (write beside it, then rename). */
export const writeFeed = (path: string, feed: object): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(feed, null, 2) + '\n');
  renameSync(tmp, path);
};
