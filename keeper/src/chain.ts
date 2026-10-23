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
  /** The oracle key the draw was requested with (meaningful once requested). */
  oracleKey: { x: bigint; y: bigint };
};

export type WinView = { line: Uint8Array; drawId: bigint; paid: boolean };

/** The public state the keeper decides from. */
export type ChainView = {
  lastDraw: bigint;
  minSales: bigint;
  maxSales: bigint;
  oracleKeyReady: boolean;
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
  oracleKeyReady: l.oracleKeyReady,
  draws: Array.from(l.draws, ([id, d]) => ({
    id,
    status: d.status,
    salesClose: d.salesClose,
    revealDeadline: d.revealDeadline,
    drawDeadline: d.drawDeadline,
    claimDeadline: d.claimDeadline,
    seedCommitment: d.seedCommitment,
    oracleKey: { x: d.oracleKey.x, y: d.oracleKey.y },
  })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  wins: Array.from(l.wins, ([line, w]) => ({ line, drawId: w.drawId, paid: w.paid })),
});

/** What the draw oracle needs: the draws, the time, and `fulfilDraw`. */
export interface DrawOracleChain {
  view(): Promise<ChainView>;
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
