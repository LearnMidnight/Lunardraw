import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger, TicketPreimage } from './managed/settlement/contract/index.js';
import { pureCircuits } from './managed/settlement/contract/index.js';
import { emptyTicket, randomScalar } from './settlement-tickets.js';

/**
 * Private state of whoever runs a Starfall settlement circuit.
 *
 * - The oracle sets `oracleSecretKey` (for `acceptOracleKey` and `fulfilDraw`).
 * - The organiser sets `organiserSecret` (for `requestDraw`, `proposeOracleKey`
 *   and `changeOrganiser`); so do a proposed successor and the backup
 *   organiser, with their own secrets, for `changeOrganiser`.
 * - A player buying sets `pendingTickets` (1 to `maxGames()` games in one
 *   transaction); fresh sealing randomness is drawn for each.
 * - The settler sets `settling`: a draw's tickets, decrypted from the chain
 *   with the settlement secret, in index order (see `decryptDrawTickets`).
 * - Anyone else (finalising, paying, voiding, refunding) needs nothing.
 *
 * The arithmetic witnesses (`splitByte`, `divMod16`, `sortSeven`, `divModWide`)
 * only offer answers the circuits check; a wrong answer makes the proof fail.
 */
export type SettlementPrivateState = {
  readonly oracleSecretKey?: bigint;
  readonly organiserSecret?: Uint8Array;
  readonly pendingTickets?: readonly TicketPreimage[];
  readonly settling?: { readonly drawId: bigint; readonly tickets: readonly TicketPreimage[] };
};

type Ctx = WitnessContext<Ledger, SettlementPrivateState>;

export const settlementWitnesses = {
  oracleSecretKey({ privateState }: Ctx): [SettlementPrivateState, bigint] {
    if (privateState.oracleSecretKey === undefined) throw new Error('Starfall: no oracle secret key in private state');
    return [privateState, privateState.oracleSecretKey];
  },

  organiserSecret({ privateState }: Ctx): [SettlementPrivateState, Uint8Array] {
    if (privateState.organiserSecret === undefined) throw new Error('Starfall: no organiser secret in private state');
    return [privateState, privateState.organiserSecret];
  },

  newTickets({ privateState }: Ctx): [SettlementPrivateState, TicketPreimage[]] {
    const ts = privateState.pendingTickets;
    if (ts === undefined || ts.length === 0) throw new Error('Starfall: no tickets to buy in private state');
    const max = Number(pureCircuits.maxGames());
    if (ts.length > max) throw new Error(`Starfall: at most ${max} games per purchase`);
    const out = [...ts];
    while (out.length < max) out.push(emptyTicket(ts[0].drawId));
    return [privateState, out];
  },

  sealingRandomnessFor({ privateState }: Ctx): [SettlementPrivateState, bigint[]] {
    return [privateState, Array.from({ length: Number(pureCircuits.maxGames()) }, () => randomScalar())];
  },

  settlementBatch({ privateState }: Ctx, drawId: bigint, first: bigint): [SettlementPrivateState, TicketPreimage[]] {
    const s = privateState.settling;
    if (s === undefined || s.drawId !== drawId) throw new Error(`Starfall: no decrypted tickets for draw ${drawId} in private state`);
    const size = Number(pureCircuits.batchSize());
    const out: TicketPreimage[] = [];
    for (let i = 0; i < size; i++) out.push(s.tickets[Number(first) + i] ?? emptyTicket(drawId));
    return [privateState, out];
  },

  splitByte({ privateState }: Ctx, x: bigint): [SettlementPrivateState, [bigint, bigint]] {
    return [privateState, [x >> 4n, x & 15n]];
  },

  divMod16({ privateState }: Ctx, v: bigint, m: bigint): [SettlementPrivateState, [bigint, bigint]] {
    return [privateState, [v / m, v % m]];
  },

  sortSeven({ privateState }: Ctx, v: bigint[]): [SettlementPrivateState, bigint[]] {
    return [privateState, [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
  },

  divModWide({ privateState }: Ctx, n: bigint, d: bigint): [SettlementPrivateState, [bigint, bigint]] {
    return [privateState, [n / d, n % d]];
  },
};
