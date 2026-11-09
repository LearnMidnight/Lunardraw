/**
 * Reading the Lunardraw and Starfall ledgers from a contract state of any
 * Midnight ledger era.
 *
 * Both contracts were compiled for ledger 8 (compact-runtime 0.16), and their
 * generated `ledger()` functions read that runtime's state values. After the
 * ledger 9 hard fork the chain hands out ledger 9 states, which Midnight.js 5
 * decodes with the current runtime. The one form both runtimes share is the
 * *encoded* state value (`EncodedStateValue` is pinned identical across
 * onchain-runtime v3, ledger-v8 and ledger-v9), so a state of either era is
 * read by encoding its data and decoding it here, in the contracts' own runtime.
 */
import { type EncodedStateValue, StateValue } from '@midnight-ntwrk/compact-runtime';
import { ledger as lunardrawLedger, type Ledger as LunardrawLedger } from './managed/lunardraw/contract/index.js';
import { ledger as starfallLedger, type Ledger as StarfallLedger } from './managed/settlement/contract/index.js';

/** A contract state as any ledger or runtime hands it out: its data's state value can encode itself. */
export type EncodableContractState = { readonly data: { readonly state: { encode(): EncodedStateValue } } };

const decode = (state: EncodableContractState): StateValue => StateValue.decode(state.data.state.encode());

/** The v0 Lunardraw ledger from a contract state of any era. */
export const ledgerOf = (state: EncodableContractState): LunardrawLedger => lunardrawLedger(decode(state));

/** The Starfall ledger from a contract state of any era. */
export const starfallLedgerOf = (state: EncodableContractState): StarfallLedger => starfallLedger(decode(state));

/** The Starfall ledger from an encoded state value (era-neutral). */
export const starfallLedgerFromEncoded = (encoded: EncodedStateValue): StarfallLedger => starfallLedger(StateValue.decode(encoded));
