/**
 * The site feed (`lunardraw-feed/1`) for the Starfall settlement contract:
 * the format the Lunardraw site was designed around, with settlement
 * progress (`batches_done` of `batches`), the settlement deadline and refunds
 * of void draws. Unlike v0's feed it has no `contract` tag on the game, so
 * the site runs every check, the prize and rollover checks included.
 */
import { Starfall } from '@lunardraw/contract';
import type { FeedDraw } from './feed.js';
import type { StarfallDrawView, StarfallView } from './starfall.js';
import type { StepRecord } from './step-times.js';

const { DrawStatus } = Starfall;

export type StarfallFeedDraw = Omit<FeedDraw, 'status' | 'claim_deadline'> & {
  status: FeedDraw['status'] | 'settling';
  /** Settlement batches in all (ceil(tickets / batch size, 22)) and proven so far. */
  batches?: number;
  batches_done?: number;
  /** After this the draw voids and refunds (numbers, then settlement). */
  settle_deadline?: string;
  /** Void draws: games refunded so far. */
  refunded?: number;
  /** Tickets sold: entries, each a standard game, a System or a Pick (games_sold counts their games). */
  tickets?: number;
  /**
   * When each step happened, as the keeper saw it (its pass after the step
   * landed, so up to its poll interval late; `drawn_at` is exact). For the
   * site's "how long does a draw take" per step.
   */
  timeline?: { revealed_at?: string; answered_at?: string; drawn_at?: string; settled_at?: string; voided_at?: string };
  /**
   * The transactions of the draw's steps that this keeper sent (`open`,
   * `reveal`, `numbers`, `finalise`, `void`), by step: the site links its
   * record check to `numbers` and its settlement check to `finalise`.
   */
  tx?: Partial<Record<'open' | 'reveal' | 'numbers' | 'finalise' | 'void', string>>;
};

export type StarfallFeed = {
  schema: 'lunardraw-feed/1';
  network: string;
  generated_at: string;
  sample: false;
  contracts: { starfall: string };
  games: {
    starfall: {
      price_star: number;
      fee_star: number;
      allocation_bp: number[];
      carry_star: number;
      open?: { num: number; sales_close: string; seed_commitment: string; games_sold: number; tickets: number };
      draws: StarfallFeedDraw[];
    };
  };
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);
const iso = (secs: bigint): string => new Date(Number(secs) * 1000).toISOString();
const star = (v: bigint): number => Number(v);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** The feed's status for a draw, given the chain time. */
export const starfallFeedStatus = (d: StarfallDrawView, nowSecs: number): StarfallFeedDraw['status'] => {
  switch (d.status) {
    case DrawStatus.open:
      return BigInt(Math.floor(nowSecs)) >= d.salesClose ? 'closed' : 'open';
    case DrawStatus.requested:
    case DrawStatus.fulfilled:
      return 'requested';
    case DrawStatus.drawn:
      return d.settled > 0n ? 'settling' : 'drawn';
    case DrawStatus.settled:
      return 'settled';
    default:
      return 'void';
  }
};

/** Build the feed from a view of the Starfall contract at chain time `nowSecs`. */
export const buildStarfallFeed = (
  view: StarfallView,
  opts: { network: string; contract: string; nowSecs: number; generatedAt?: Date; steps?: (id: bigint) => StepRecord | undefined },
): StarfallFeed => {
  const batch = Starfall.pureCircuits.batchSize();
  const draws = [...view.draws].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
  // A settled draw's carry out is what the next settled draw carried in (void
  // draws pass it on), or the current carry for the latest one.
  const settled = draws.filter((d) => d.status === DrawStatus.settled);
  const carryOut = new Map<bigint, bigint>();
  settled.forEach((d, i) => carryOut.set(d.id, i === 0 ? view.carry : settled[i - 1].carried));

  const toFeed = (d: StarfallDrawView): StarfallFeedDraw => {
    const out: StarfallFeedDraw = {
      num: Number(d.id),
      status: starfallFeedStatus(d, opts.nowSecs),
      sales_close: iso(d.salesClose),
      seed_commitment: hex(d.seedCommitment),
      games_sold: Number(d.games),
      tickets: Number(d.tickets),
      reveal_deadline: iso(d.revealDeadline),
      draw_deadline: iso(d.drawDeadline),
    };
    if (!isZero(d.seed)) out.seed = hex(d.seed);
    if (!isZero(d.output)) out.vrf_output = hex(d.output);
    if (d.status === DrawStatus.fulfilled || d.status === DrawStatus.drawn) out.settle_deadline = iso(d.settleDeadline);
    if (d.status === DrawStatus.drawn || d.status === DrawStatus.settled) {
      out.numbers = d.numbers;
      out.moonball = d.moonball;
      // computeNumbers sets the settlement deadline settleWindow after its clock.
      out.drawn_at = iso(d.settleDeadline - view.settleWindow);
      out.batches = Number(ceilDiv(d.tickets, batch));
      out.batches_done = d.settled >= d.tickets ? out.batches : Number(d.settled / batch);
      out.winners = d.winners.map(Number);
    }
    if (d.status === DrawStatus.settled) {
      out.carried_in_star = star(d.carried);
      out.prizes_star = d.prizes.map(star);
      out.carry_out_star = star(carryOut.get(d.id) ?? 0n);
    }
    if (d.status === DrawStatus.voided) out.refunded = Number(d.refundedGames);
    const t = opts.steps?.(d.id);
    if (t) {
      const at = (s: number | undefined) => (s === undefined ? undefined : iso(BigInt(s)));
      const timeline = { revealed_at: at(t.revealed), answered_at: at(t.answered), drawn_at: at(t.drawn), settled_at: at(t.settled), voided_at: at(t.voided) };
      const seen = Object.entries(timeline).filter(([, v]) => v !== undefined);
      if (seen.length) out.timeline = Object.fromEntries(seen); // a draw known only from the backfill has ids but no times
      if (t.tx && Object.keys(t.tx).length) out.tx = { ...t.tx };
    }
    return out;
  };

  // As in v0's feed (which the site is tested against): the newest open draw
  // is `open`, even once its sales have closed and until its seed is revealed.
  const selling = draws.find((d) => d.status === DrawStatus.open);
  return {
    schema: 'lunardraw-feed/1',
    network: opts.network,
    generated_at: (opts.generatedAt ?? new Date()).toISOString(),
    sample: false,
    contracts: { starfall: opts.contract },
    games: {
      starfall: {
        price_star: star(view.ticketPrice),
        fee_star: star(view.feePerGame),
        allocation_bp: [...Starfall.POWERBALL_SHARES_BP],
        carry_star: star(view.carry),
        open: selling
          ? {
              num: Number(selling.id),
              sales_close: iso(selling.salesClose),
              seed_commitment: hex(selling.seedCommitment),
              games_sold: Number(selling.games),
              tickets: Number(selling.tickets),
            }
          : undefined,
        draws: draws.filter((d) => d !== selling).map(toFeed),
      },
    },
  };
};
