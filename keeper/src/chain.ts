/**
 * What the keeper needs from a Lunardraw deployment: a view of the draws and
 * the transactions it sends. Implemented for the in-memory simulator here, and
 * for a live deployment with midnight-js.
 */
import { DrawStatus, type Ledger, type LottoSimulator, type NextDraw } from '@lunardraw/contract';

export type DrawView = {
  id: bigint;
  status: DrawStatus;
  salesClose: bigint;
  revealDeadline: bigint;
  drawDeadline: bigint;
  claimDeadline: bigint;
  seedCommitment: Uint8Array;
  /** The oracle key the draw is bound to (fixed when it opened). */
  oracleKey: { x: bigint; y: bigint };
  /** The revealed seed and the VRF output (all zeros until known). */
  seed: Uint8Array;
  output: Uint8Array;
  /** The drawn numbers (zeros until computed). */
  numbers: number[];
  moonball: number;
  /** Lines sold, and registered winning lines per division (division 1 first). */
  lines: bigint;
  winners: bigint[];
  /** Rollover added to this draw's pool when it settled, and each division's prize per line. */
  carried: bigint;
  prizes: bigint[];
};

export type WinView = { line: Uint8Array; drawId: bigint; paid: boolean };

/** The public state the keeper decides from. */
export type ChainView = {
  lastDraw: bigint;
  minSales: bigint;
  maxSales: bigint;
  linePrice: bigint;
  claimWindow: bigint;
  /** Rollover waiting for the next draw to settle, in STAR. */
  carry: bigint;
  oracleKeyReady: boolean;
  /** A proposed oracle key, if any, and the earliest time it may take effect (seconds). */
  oracleKeyChange?: { key: { x: bigint; y: bigint }; at: bigint; approved: boolean };
  draws: DrawView[];
  wins: WinView[];
};

export interface LunardrawChain {
  /** The contract's current public state. */
  view(): Promise<ChainView>;
  /** Chain time in seconds (the latest block's time, or a clock kept in sync with it). */
  now(): Promise<number>;
  /** Organiser only. Each resolves once the transaction is on chain. */
  openDraw(salesClose: bigint, seedCommitment: Uint8Array): Promise<void>;
  requestDraw(n: bigint, seed: Uint8Array, next?: NextDraw): Promise<void>;
  /** Anyone. */
  computeNumbers(n: bigint): Promise<void>;
  settleDraw(n: bigint): Promise<void>;
  payWin(line: Uint8Array): Promise<void>;
  voidDraw(n: bigint): Promise<void>;
}

/** The keeper's view of a ledger. */
export const viewOf = (l: Ledger): ChainView => ({
  lastDraw: l.lastDraw,
  minSales: l.minSales,
  maxSales: l.maxSales,
  linePrice: l.linePrice,
  claimWindow: l.claimWindow,
  carry: l.carry,
  oracleKeyReady: l.oracleKeyReady,
  oracleKeyChange: l.proposedOracleKey.is_some
    ? { key: { x: l.proposedOracleKey.value.x, y: l.proposedOracleKey.value.y }, at: l.oracleKeyChangeAt, approved: l.oracleKeyApproved }
    : undefined,
  draws: Array.from(l.draws, ([id, d]) => ({
    id,
    status: d.status,
    salesClose: d.salesClose,
    revealDeadline: d.revealDeadline,
    drawDeadline: d.drawDeadline,
    claimDeadline: d.claimDeadline,
    seedCommitment: d.seedCommitment,
    oracleKey: { x: d.oracleKey.x, y: d.oracleKey.y },
    seed: d.seed,
    output: d.output,
    numbers: d.numbers.map(Number),
    moonball: Number(d.moonball),
    lines: l.drawLines.member(id) ? l.drawLines.lookup(id).read() : 0n,
    winners: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n].map((div) => {
      const key = id * 16n + div;
      return l.winnerCounts.member(key) ? l.winnerCounts.lookup(key).read() : 0n;
    }),
    carried: d.carried,
    prizes: d.prizes.map((p) => p),
  })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  wins: Array.from(l.wins, ([line, w]) => ({ line, drawId: w.drawId, paid: w.paid })),
});

/** What the draw oracle reads about each draw (v0 and Starfall alike). */
export type OracleDrawView = { id: bigint; status: number; drawDeadline: bigint; oracleKey: { x: bigint; y: bigint } };

/** What the draw oracle needs: the draws, the time, and `fulfilDraw`. */
export interface DrawOracleChain {
  view(): Promise<{ draws: OracleDrawView[] }>;
  now(): Promise<number>;
  /** Oracle only (its secret key answers the witness). Resolves once on chain. */
  fulfilDraw(n: bigint): Promise<void>;
}

/** A {@link LottoSimulator} as a chain: the keeper acts as its organiser, the oracle as its oracle. */
export class SimulatorChain implements LunardrawChain, DrawOracleChain {
  constructor(readonly sim: LottoSimulator) {}

  async view(): Promise<ChainView> {
    return viewOf(this.sim.getLedger());
  }

  async now(): Promise<number> {
    return this.sim.now;
  }

  async openDraw(salesClose: bigint, seedCommitment: Uint8Array): Promise<void> {
    this.sim.openDraw(salesClose, seedCommitment);
  }

  async requestDraw(n: bigint, seed: Uint8Array, next?: NextDraw): Promise<void> {
    if (next) this.sim.requestAndOpenNext(n, seed, next);
    else this.sim.requestDraw(n, seed);
  }

  async computeNumbers(n: bigint): Promise<void> {
    this.sim.computeNumbers(n);
  }

  async settleDraw(n: bigint): Promise<void> {
    this.sim.settleDraw(n);
  }

  async payWin(line: Uint8Array): Promise<void> {
    this.sim.payWin(line);
  }

  async voidDraw(n: bigint): Promise<void> {
    this.sim.voidDraw(n);
  }

  async fulfilDraw(n: bigint): Promise<void> {
    this.sim.fulfilDraw(n);
  }
}
