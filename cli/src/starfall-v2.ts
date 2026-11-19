/**
 * Starfall v2 (starfall-v2/, docs/ADAPTIVE.md) on a live network, for the keeper and the oracle:
 * the compiled game and Treasury (Compact 0.36), their providers (a draw's opening and its
 * finalisation call the Treasury in the same transaction), the keeper's view of the ledger, the
 * chain adapter and the deployment record (`deployments/starfall-v2-<network>.json`, written by
 * starfall-v2/deploy/deploy.mjs).
 *
 * The contracts are compiled outside the npm build (they need Compact 0.36 and their keys are
 * too big for git): `starfall-v2/deploy/out/{settlement,treasury}` by default, or
 * LUNARDRAW_STARFALL_V2_OUT. Their generated code is loaded at run time and typed loosely here.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { StateValue } from '@midnight-ntwrk/compact-runtime';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider, nodeZkConfigRegistry } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { inMemoryPrivateStateProvider, type MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import type { Starfall } from '@lunardraw/contract';
import {
  type MemberPaymentView,
  type StarfallPure,
  type StarfallView,
  starfallViewOf,
  type StoredTicket,
  type SyndicateView,
} from '@lunardraw/keeper';
import { type Session, TX_TTL_SECONDS } from '@nightcast/deploy';
import { deploymentsDir } from './deployment.js';
import { MidnightStarfallChain, type PrivateStateStore, type StarfallCalls } from './starfall.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- the generated v2 modules are loaded at run time */
type Module = any;

export const V2_GAME = 'settlement';
export const V2_TREASURY = 'treasury';
export const STARFALL_V2_PRIVATE_STATE_ID = 'starfall-v2';

/** Where the compiled v2 contracts are: LUNARDRAW_STARFALL_V2_OUT, or starfall-v2/deploy/out in this checkout. */
export const starfallV2Out = (override = process.env.LUNARDRAW_STARFALL_V2_OUT): string =>
  override || fileURLToPath(new URL('../../starfall-v2/deploy/out', import.meta.url));

export type StarfallV2 = { out: string; G: Module; T: Module };

/**
 * The compiled game and Treasury. `keys`: also check the prover keys are there (the keeper and
 * the oracle prove; reading the ledger needs only the generated code).
 */
export const loadStarfallV2 = async (out = starfallV2Out(), { keys = false } = {}): Promise<StarfallV2> => {
  const index = (name: string) => join(out, name, 'contract', 'index.js');
  for (const name of [V2_GAME, V2_TREASURY]) {
    if (!existsSync(index(name))) {
      throw new Error(`no compiled Starfall v2 ${name} in ${out}: compile it with Compact 0.36 (compactc starfall-v2/src/${name}.compact ${join(out, name)})`);
    }
  }
  if (keys) {
    for (const [name, circuit] of [[V2_GAME, 'settleBatch'], [V2_GAME, 'fulfilDraw'], [V2_TREASURY, 'release']] as const) {
      if (!existsSync(join(out, name, 'keys', `${circuit}.prover`))) {
        throw new Error(`${join(out, name, 'keys')} has no prover key for ${circuit}: compile ${name} with its keys (without --skip-zk)`);
      }
    }
  }
  const G = await import(pathToFileURL(index(V2_GAME)).href);
  const T = await import(pathToFileURL(index(V2_TREASURY)).href);
  return { out, G, T };
};

/** The game's ticket functions, for the keeper (decrypting and checking tickets, the batch size). */
export const v2Pure = (G: Module): StarfallPure => G.pureCircuits as StarfallPure;

// ------------------------------------------------------------------ the ledger

/** A contract state of any era, decoded into the v2 game's own ledger. */
export const v2LedgerOf = (G: Module, state: { data: { state: { encode(): unknown } } }): any =>
  G.ledger(StateValue.decode(state.data.state.encode() as Parameters<typeof StateValue.decode>[0]));

/**
 * The keeper's view of a v2 ledger: Starfall's view (its draws, tickets and entitlements are
 * laid out as v1's), with each draw's format, the syndicates, and every member's part of a
 * syndicate's prize not paid yet.
 */
export const starfallV2ViewOf = (G: Module, l: any): StarfallView => {
  const view = starfallViewOf(l as Starfall.Ledger);
  view.draws = view.draws.map((d) => {
    const r = l.draws.lookup(d.id);
    return { ...d, format: { range: Number(r.format.range), moonballs: Number(r.format.moonballs) }, rung: Number(r.rung) };
  });
  const ladder = [...(l.ladder as Iterable<any>)].slice(0, Number(l.rungCount)).map((g) => ({
    numbers: Number(g.numbers), moonball: Number(g.moonball), odds: BigInt(g.odds), shares: [...(g.shares as Iterable<bigint>)].map(Number),
  }));
  const adaptive = {
    ladder, rung: Number(l.rung), aim: Number(l.aim), floor: BigInt(l.floor), ceilingPerCombination: BigInt(l.ceilingPerCombination),
    targetDraws: Number(l.targetDraws), retargetEvery: Number(l.retargetEvery), treasuryPerGame: BigInt(l.treasuryPerGame),
    treasury: Buffer.from(l.treasuryAddress.bytes ?? l.treasuryAddress).toString('hex'),
  };
  const funded = G.SyndicateStatus?.funded ?? 1;
  const syndicates: SyndicateView[] = [];
  const raw = new Map<bigint, any>();
  for (const [id, sy] of l.syndicates as Iterable<[bigint, any]>) {
    raw.set(id, sy);
    const members: SyndicateView['members'] = [];
    for (let i = 0n; i < sy.members; i++) {
      const m = l.members.lookup(G.pureCircuits.memberKey(id, i));
      members.push({ index: i, shares: m.shares, refunded: m.refunded });
    }
    syndicates.push({
      id, drawId: sy.drawId, funded: sy.status === funded, sharePrice: sy.sharePrice, sold: sy.sold, bought: sy.bought,
      joinDeadline: sy.joinDeadline, members,
    });
  }
  const memberPayments: MemberPaymentView[] = [];
  for (const [eid, pots] of l.syndicatePots as Iterable<[Uint8Array, bigint[]]>) {
    const e = l.entitlements.lookup(eid);
    pots.forEach((owed, payee) => {
      if (owed === 0n) return;
      const sid = e.payees[payee].lo as bigint;
      const sy = raw.get(sid);
      if (!sy || sy.status !== funded) return;
      for (let i = 0n; i < sy.members; i++) {
        if (l.memberPayments.member(G.pureCircuits.memberPaymentId(eid, BigInt(payee), i))) continue;
        const m = l.members.lookup(G.pureCircuits.memberKey(sid, i));
        memberPayments.push({ draw: e.drawId, id: eid, payee, member: i, amount: (owed * m.shares) / sy.sold });
      }
    });
  }
  return { ...view, syndicates, memberPayments, adaptive };
};

/** Draw `n`'s stored tickets, in index order. */
export const v2StoredTickets = (G: Module, l: any, n: bigint): StoredTicket[] => {
  const count: bigint = l.ticketCount.member(n) ? l.ticketCount.lookup(n) : 0n;
  const out: StoredTicket[] = [];
  for (let i = 0n; i < count; i++) {
    const rec = l.tickets.lookup(G.pureCircuits.ticketKey(n, i));
    out.push({ commitment: rec.commitment, cipher: rec.cipher });
  }
  return out;
};

/** Where the v2 ledger is read from: a Midnight.js public data provider. */
export type V2StateSource = { queryContractState(address: string): Promise<any> };

/** The v2 game's ledger at `address`, from a public data provider's read (or a state already decoded). */
export const readV2Ledger = async (G: Module, publicData: V2StateSource, address: string): Promise<any> => {
  const read = await publicData.queryContractState(address);
  if (!read) throw new Error(`no Starfall v2 contract at ${address}`);
  const state = read.contractState ? read.contractState.deserialize({ v9: ContractState }) : read;
  return v2LedgerOf(G, state);
};

// ------------------------------------------------------------------ the contracts and providers

/** The v2 game's witnesses: the private state holds the organiser secret, the oracle key, or a draw being settled. */
export const v2Witnesses = (G: Module) => {
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`no ${what} in the private state`);
    return v;
  };
  const empty = (drawId: bigint) => {
    const noLine = { numbers: Array(7).fill(0n), moonball: 0n };
    const noPayee = { lo: 0n, hi: 0n, share: 0n };
    return { drawId, entry: { kind: 0n, count: 0n, numbers: Array(12).fill(0n), moonball: 0n, sweep: false }, lines: Array(11).fill(noLine), payees: [noPayee, noPayee, noPayee], salt: 0n };
  };
  return {
    oracleSecretKey: ({ privateState }: any) => [privateState, need(privateState.oracleSecretKey, 'oracle secret key')],
    organiserSecret: ({ privateState }: any) => [privateState, need(privateState.organiserSecret, 'organiser secret')],
    syndicateSecret: ({ privateState }: any) => [privateState, need(privateState.syndicateSecret, 'syndicate secret')],
    // A purchase: the tickets the buyer put in the private state, the other slots unused, each sealed with fresh randomness.
    newTickets: ({ privateState }: any) => {
      const ts = [...(need(privateState.pendingTickets, 'tickets to buy') as unknown[])];
      const max = Number(G.pureCircuits.maxTickets());
      if (ts.length < 1 || ts.length > max) throw new Error(`1 to ${max} tickets a purchase, not ${ts.length}`);
      const drawId = (ts[0] as { drawId: bigint }).drawId;
      while (ts.length < max) ts.push(empty(drawId));
      return [privateState, ts];
    },
    sealingRandomnessFor: ({ privateState }: any) => [
      privateState,
      Array.from({ length: Number(G.pureCircuits.maxTickets()) }, () => BigInt('0x' + randomBytes(31).toString('hex'))),
    ],
    // The batch starting at `first`: the decrypted tickets the keeper put in the private state.
    settlementBatch: ({ privateState }: any, drawId: bigint, first: bigint) => {
      const s = need(privateState.settling, 'draw being settled') as { drawId: bigint; tickets: unknown[] };
      if (s.drawId !== drawId) throw new Error(`settling draw ${s.drawId}, asked for draw ${drawId}`);
      const size = Number(G.pureCircuits.batchSize());
      const out: unknown[] = [];
      for (let i = 0; i < size; i++) out.push(s.tickets[Number(first) + i] ?? empty(drawId));
      return [privateState, out];
    },
    splitByte: ({ privateState }: any, x: bigint) => [privateState, [x >> 4n, x & 15n]],
    divMod16: ({ privateState }: any, v: bigint, m: bigint) => [privateState, [v / m, v % m]],
    sortSeven: ({ privateState }: any, v: bigint[]) => [privateState, [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))],
    divModWide: ({ privateState }: any, n: bigint, d: bigint) => [privateState, [n / d, n % d]],
  };
};

/** The game as Midnight.js 5 takes a contract compiled by Compact 0.36: with its witnesses and its compiled files. */
export const compiledV2Game = (v2: StarfallV2): unknown => {
  const C = CompiledContract as Module;
  return C.withCompiledFileAssets(C.withWitnesses(C.make(V2_GAME, v2.G.Contract), v2Witnesses(v2.G)), join(v2.out, V2_GAME));
};

/** How long a proof may take on the proof server (settleBatch is k=17, computeNumbers k=18). */
const PROVE_TIMEOUT_MS = 60 * 60_000;

/**
 * The game's providers. The proof provider proves with both contracts' keys and the module
 * provider resolves the Treasury: requestDraw (opening a draw) and finaliseDraw call it.
 */
export const starfallV2Providers = async (session: Session, wallet: MidnightWalletProvider, v2: StarfallV2, treasuryAddress: string) => {
  const registry = await nodeZkConfigRegistry(v2.out);
  return {
    privateStateProvider: inMemoryPrivateStateProvider(),
    publicDataProvider: indexerPublicDataProvider(session.config.indexer, session.config.indexerWS),
    zkConfigProvider: new NodeZkConfigProvider(join(v2.out, V2_GAME), { verify: 'require-if-present' }),
    proofProvider: httpClientProofProvider(session.config.proofServer, registry, { timeout: PROVE_TIMEOUT_MS }),
    walletProvider: wallet,
    midnightProvider: wallet,
    config: { networkId: session.config.networkId, ttlSeconds: TX_TTL_SECONDS },
    contractModuleProvider: { resolve: (a: unknown) => (String(a) === treasuryAddress ? () => v2.T : undefined) },
  };
};

export type StarfallV2Providers = Awaited<ReturnType<typeof starfallV2Providers>>;

/** Join the deployed game with a private state (organiser secret, oracle key, or nothing). */
export const joinStarfallV2 = (providers: StarfallV2Providers, v2: StarfallV2, contractAddress: string, privateState: Record<string, unknown>) =>
  findDeployedContract(providers as never, {
    contractAddress,
    compiledContract: compiledV2Game(v2) as never,
    privateStateId: STARFALL_V2_PRIVATE_STATE_ID,
    initialPrivateState: privateState as never,
  }) as unknown as Promise<StarfallV2Calls>;

type CallResult = { public?: { txId?: string }; private?: { result?: unknown } };

export interface StarfallV2Calls extends StarfallCalls {
  callTx: StarfallCalls['callTx'] & {
    paySyndicateMember(id: Uint8Array, payee: bigint, member: bigint): Promise<unknown>;
    refundSyndicate(syndicate: bigint, member: bigint): Promise<unknown>;
    buyTickets(count: bigint, refundTo: { bytes: Uint8Array }): Promise<CallResult>;
    createSyndicate(drawId: bigint, creatorCommitment: Uint8Array, sharePrice: bigint, totalShares: bigint, games: bigint, joinDeadline: bigint): Promise<CallResult>;
    joinSyndicate(syndicate: bigint, shares: bigint, payTo: { bytes: Uint8Array }): Promise<CallResult>;
    buySyndicateTickets(syndicate: bigint, count: bigint): Promise<CallResult>;
  };
}

/**
 * A live v2 deployment for the keeper and the oracle: Starfall's adapter (its calls are the
 * same) reading the v2 ledger, with the syndicate payments.
 */
export class MidnightStarfallV2Chain extends MidnightStarfallChain {
  constructor(
    private readonly v2: StarfallV2,
    private readonly v2Contract: StarfallV2Calls,
    private readonly source: V2StateSource,
    privateState: PrivateStateStore,
    contractAddress: string,
    base: Record<string, unknown> = {},
    proveLeadSecs = 300,
    clock: () => number = Date.now,
    beforeTx?: () => Promise<unknown>,
  ) {
    super(v2Contract, source as never, privateState, contractAddress, base as never, proveLeadSecs, clock, beforeTx, STARFALL_V2_PRIVATE_STATE_ID);
  }

  ledger(): Promise<any> {
    return readV2Ledger(this.v2.G, this.source, this.contractAddress);
  }

  override async view(): Promise<StarfallView> {
    return starfallV2ViewOf(this.v2.G, await this.ledger());
  }

  override async storedTickets(n: bigint): Promise<StoredTicket[]> {
    return v2StoredTickets(this.v2.G, await this.ledger(), n);
  }

  async paySyndicateMember(id: Uint8Array, payee: number, member: bigint): Promise<void> {
    await this.send(() => this.v2Contract.callTx.paySyndicateMember(id, BigInt(payee), member));
  }

  async refundSyndicate(syndicate: bigint, member: bigint): Promise<void> {
    await this.send(() => this.v2Contract.callTx.refundSyndicate(syndicate, member));
  }
}

// ------------------------------------------------------------------ the deployment record

export type StarfallV2Record = {
  network: string;
  /** The game. */
  contractAddress: string;
  treasuryAddress: string;
  deployedAt: string;
  /** "rehearsal" (test keys, kept on this machine) or "deploy" (the real one). */
  mode: string;
  parameters: {
    organiserCommitment: string;
    settlementKey: { x: string; y: string };
    oracleKey: { x: string; y: string };
  };
};

export const starfallV2RecordPath = (network: string): string => join(deploymentsDir(), `starfall-v2-${network}.json`);

export const readStarfallV2Record = (network: string, path = starfallV2RecordPath(network)): StarfallV2Record => {
  if (!existsSync(path)) throw new Error(`no Starfall v2 deployment record at ${path} (starfall-v2/deploy/deploy.mjs writes it)`);
  return JSON.parse(readFileSync(path, 'utf8')) as StarfallV2Record;
};
