/**
 * Starfall (the private-settlement contract, docs/SETTLEMENT.md) on a live
 * network: the compiled contract, its providers, the chain adapter the keeper
 * and the oracle use, deploying, the deployment record
 * (`deployments/starfall-<network>.json`) and checking a deployment.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type ChargedState, encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { CompiledContract, type ProvableCircuitId } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js/types';
import { sampleSigningKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import { Starfall } from '@lunardraw/contract';
import {
  reasonOf,
  type DrawOracleChain,
  type StarfallChain,
  type StarfallView,
  starfallViewOf,
  type StoredTicket,
  storedTicketsOf,
} from '@lunardraw/keeper';
import { oraclePublicKey } from '@nightcast/contract';
import {
  compareFingerprints,
  type CompilerInfo,
  contractProviders,
  deployLocked,
  type Fingerprints,
  isLocked,
  onChainFingerprints,
  type Session,
} from '@nightcast/deploy';
import { type ContractStateView, deploymentsDir, type Check } from './deployment.js';

type PrivateState = Starfall.SettlementPrivateState;
type TicketPreimage = Starfall.TicketPreimage;
type NextDraw = Starfall.NextDraw;

export const STARFALL_PRIVATE_STATE_ID = 'starfall';

export type StarfallContract = Starfall.Contract.Contract<PrivateState>;
export type StarfallCircuits = ProvableCircuitId<StarfallContract>;
export type StarfallProviders = MidnightProviders<StarfallCircuits, typeof STARFALL_PRIVATE_STATE_ID, PrivateState>;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * The compiled Starfall contract with its proving keys (`npm run compact:starfall`):
 * the one in `@lunardraw/contract`, unless LUNARDRAW_STARFALL_ZK_CONFIG_PATH says otherwise.
 */
export const starfallZkConfigPath = (override = process.env.LUNARDRAW_STARFALL_ZK_CONFIG_PATH): string => {
  if (override) return override;
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve('@lunardraw/contract/package.json'));
  for (const candidate of [join(pkg, 'dist', 'managed', 'settlement'), join(pkg, 'src', 'managed', 'settlement')]) {
    if (existsSync(join(candidate, 'keys'))) return candidate;
  }
  throw new Error('No compiled Starfall contract with proving keys found. Run `npm run compact:starfall` then `npm run build`.');
};

export const compiledStarfall = (dir = starfallZkConfigPath()) =>
  CompiledContract.make('starfall', Starfall.Contract.Contract<PrivateState>).pipe(
    CompiledContract.withWitnesses(Starfall.settlementWitnesses),
    CompiledContract.withCompiledFileAssets(dir),
  );

export const starfallProviders = (session: Session, wallet: MidnightWalletProvider, dir = starfallZkConfigPath()): StarfallProviders =>
  contractProviders<StarfallCircuits, typeof STARFALL_PRIVATE_STATE_ID, PrivateState>(session, wallet, dir);

/** Join a deployment with a private state (organiser secret, oracle key, or nothing). */
export const joinStarfall = (providers: StarfallProviders, contractAddress: string, privateState: PrivateState) =>
  findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledStarfall(),
    privateStateId: STARFALL_PRIVATE_STATE_ID,
    initialPrivateState: privateState,
  });

/** The calls made on a joined contract. */
export interface StarfallCalls {
  callTx: {
    acceptOracleKey(): Promise<unknown>;
    requestDraw(n: bigint, seed: Uint8Array, next: { is_some: boolean; value: NextDraw }): Promise<unknown>;
    fulfilDraw(n: bigint): Promise<unknown>;
    computeNumbers(n: bigint, now: bigint): Promise<unknown>;
    settleBatch(n: bigint): Promise<unknown>;
    finaliseDraw(n: bigint): Promise<unknown>;
    payEntitlement(id: Uint8Array): Promise<unknown>;
    voidDraw(n: bigint): Promise<unknown>;
    refundTicket(n: bigint, index: bigint): Promise<unknown>;
    buyTickets(count: bigint, refundTo: { bytes: Uint8Array }): Promise<unknown>;
  };
}

export interface ContractStateSource {
  queryContractState(address: string): Promise<{ data: ChargedState } | null | undefined>;
}

/** The private state store the witnesses read (midnight-js's). */
export interface PrivateStateStore {
  setContractAddress(address: string): void;
  set(id: typeof STARFALL_PRIVATE_STATE_ID, state: PrivateState): Promise<void>;
}

const NO_NEXT = { is_some: false, value: { salesClose: 0n, seedCommitment: new Uint8Array(32) } };

export const readStarfallLedger = async (publicData: ContractStateSource, contractAddress: string): Promise<Starfall.Ledger> => {
  const state = await publicData.queryContractState(contractAddress);
  if (!state) throw new Error(`no Starfall contract at ${contractAddress}`);
  return Starfall.ledger(state.data);
};

export const readStarfallView = async (publicData: ContractStateSource, contractAddress: string): Promise<StarfallView> =>
  starfallViewOf(await readStarfallLedger(publicData, contractAddress));

/**
 * A live Starfall deployment for the keeper and the oracle. Time is the
 * local clock (keep it in sync with NTP).
 */
export class MidnightStarfallChain implements StarfallChain, DrawOracleChain {
  readonly addressBytes: Uint8Array;

  /**
   * @param base the private state the keeper joined with (organiser secret), kept under the settling tickets
   * @param proveLeadSecs how far ahead computeNumbers stamps its clock: the contract allows 30 minutes either way
   */
  constructor(
    private readonly contract: StarfallCalls,
    private readonly publicData: ContractStateSource,
    private readonly privateState: PrivateStateStore,
    readonly contractAddress: string,
    private readonly base: PrivateState = {},
    private readonly proveLeadSecs = 300,
    /** Local clock in ms (the simulator's in tests). */
    private readonly clock: () => number = Date.now,
  ) {
    this.addressBytes = encodeContractAddress(contractAddress);
  }

  view(): Promise<StarfallView> {
    return readStarfallView(this.publicData, this.contractAddress);
  }

  async now(): Promise<number> {
    return this.clock() / 1000;
  }

  async storedTickets(n: bigint): Promise<StoredTicket[]> {
    return storedTicketsOf(await readStarfallLedger(this.publicData, this.contractAddress), n);
  }

  async openDraw(salesClose: bigint, seedCommitment: Uint8Array): Promise<void> {
    await this.contract.callTx.requestDraw(0n, new Uint8Array(32), { is_some: true, value: { salesClose, seedCommitment } });
  }

  async requestDraw(n: bigint, seed: Uint8Array, next?: NextDraw): Promise<void> {
    await this.contract.callTx.requestDraw(n, seed, next ? { is_some: true, value: next } : NO_NEXT);
  }

  async fulfilDraw(n: bigint): Promise<void> {
    await this.contract.callTx.fulfilDraw(n);
  }

  async computeNumbers(n: bigint): Promise<void> {
    await this.contract.callTx.computeNumbers(n, BigInt(Math.floor(this.clock() / 1000) + this.proveLeadSecs));
  }

  /** The settlement witness reads the decrypted tickets from the private state, so put them there first. */
  async settleBatch(n: bigint, tickets: readonly TicketPreimage[]): Promise<void> {
    this.privateState.setContractAddress(this.contractAddress);
    await this.privateState.set(STARFALL_PRIVATE_STATE_ID, { ...this.base, settling: { drawId: n, tickets } });
    try {
      await this.contract.callTx.settleBatch(n);
    } finally {
      // Don't keep a draw's decrypted tickets around any longer than needed.
      this.privateState.setContractAddress(this.contractAddress);
      await this.privateState.set(STARFALL_PRIVATE_STATE_ID, { ...this.base });
    }
  }

  async finaliseDraw(n: bigint): Promise<void> {
    await this.contract.callTx.finaliseDraw(n);
  }

  async payEntitlement(id: Uint8Array): Promise<void> {
    await this.contract.callTx.payEntitlement(id);
  }

  async voidDraw(n: bigint): Promise<void> {
    await this.contract.callTx.voidDraw(n);
  }

  async refundTicket(n: bigint, index: bigint): Promise<void> {
    await this.contract.callTx.refundTicket(n, index);
  }
}

/** A purchase run that stopped before buying everything: how many tickets were bought, and why it stopped. */
export class BuyStopped extends Error {
  constructor(
    readonly bought: number,
    readonly of: number,
    reason: string,
  ) {
    super(reason);
  }
}

export type BuyOptions = {
  /** Called after each transaction with the tickets bought so far. */
  onEach?: (done: number, of: number) => void;
  /**
   * Give up on a transaction that hasn't landed after this long (ms). A
   * wallet whose sync has dropped can wait for ever otherwise. Default 5 minutes.
   */
  timeoutMs?: number;
  /** Don't start a transaction after this time (seconds): sales close soon. */
  stopAt?: number;
};

/**
 * Buy tickets for an open draw, `maxTickets()` per transaction, refundable to
 * `refundTo`. A ticket is one entry: a standard game, a System or a Pick, with
 * or without Moonball Sweep; each transaction pays for every game in it.
 * Returns the number of transactions. If one fails, times out or sales are
 * about to close, throws {@link BuyStopped} with the tickets bought so far
 * (those stay bought).
 */
export const buyGames = async (
  contract: StarfallCalls,
  privateState: PrivateStateStore,
  contractAddress: string,
  games: readonly TicketPreimage[],
  refundTo: Uint8Array,
  opts: BuyOptions | ((done: number, of: number) => void) = {},
): Promise<number> => {
  const o: BuyOptions = typeof opts === 'function' ? { onEach: opts } : opts;
  const timeoutMs = o.timeoutMs ?? 5 * 60_000;
  const max = Number(Starfall.pureCircuits.maxTickets());
  let txs = 0;
  for (let i = 0; i < games.length; i += max) {
    if (o.stopAt !== undefined && Date.now() / 1000 >= o.stopAt) {
      throw new BuyStopped(i, games.length, 'sales close in under a minute, so no more purchases were sent');
    }
    const part = games.slice(i, i + max);
    privateState.setContractAddress(contractAddress);
    await privateState.set(STARFALL_PRIVATE_STATE_ID, { pendingTickets: part });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`a purchase didn't land within ${Math.round(timeoutMs / 60_000)} minutes (the wallet's connection may have dropped)`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([contract.callTx.buyTickets(BigInt(part.length), { bytes: refundTo }), timedOut]);
    } catch (err) {
      throw new BuyStopped(i, games.length, reasonOf(err)); // the cause chain carries the node's reason (1010 custom codes)
    } finally {
      clearTimeout(timer);
    }
    txs += 1;
    o.onEach?.(i + part.length, games.length);
  }
  return txs;
};

// ------------------------------------------------------------------ deploy

export type StarfallDeployParams = {
  oraclePublicKey: { x: bigint; y: bigint };
  organiserCommitment: Uint8Array;
  backupCommitment: Uint8Array;
  /** The key tickets are encrypted to (the settler's public key). */
  settlementKey: { x: bigint; y: bigint };
  /** Where the operator fee goes: a 32-byte unshielded address. */
  operator: Uint8Array;
  /** Operator fee per game and price of a game, in STAR. */
  feePerGame: bigint;
  ticketPrice: bigint;
  minSales: bigint;
  maxSales: bigint;
  revealWindow: bigint;
  drawWindow: bigint;
  settleWindow: bigint;
};

/**
 * Weekly Starfall: a game costs 1.2 tNIGHT (1 to the pool, 0.2 to the
 * operator); about a week of sales; an hour to reveal; two hours for the
 * oracle; two days to settle once the numbers are in.
 */
export const STARFALL_WEEKLY_DEFAULTS = {
  ticketPrice: 1_200_000n,
  feePerGame: 200_000n,
  minSales: 86_400n,
  maxSales: 14n * 86_400n,
  revealWindow: 3_600n,
  drawWindow: 7_200n,
  settleWindow: 2n * 86_400n,
} as const;

export const deployStarfall = (providers: StarfallProviders, p: StarfallDeployParams) =>
  deployLocked(providers, {
    compiledContract: compiledStarfall(),
    initialPrivateState: {},
    signingKey: sampleSigningKey(), // never used: the authority is replaced before anything is sent
    args: [
      p.oraclePublicKey,
      p.organiserCommitment,
      p.backupCommitment,
      p.settlementKey,
      { bytes: p.operator },
      p.feePerGame,
      p.ticketPrice,
      p.minSales,
      p.maxSales,
      p.revealWindow,
      p.drawWindow,
      p.settleWindow,
    ],
  });

/** The oracle proves it holds the proposed key, activating it. */
export const acceptStarfallOracleKey = async (providers: StarfallProviders, contractAddress: string, oracleSecretKey: bigint) => {
  const joined = await joinStarfall(providers, contractAddress, { oracleSecretKey });
  const result = await joined.callTx.acceptOracleKey();
  const l = await readStarfallLedger(providers.publicDataProvider, contractAddress);
  const expected = oraclePublicKey(oracleSecretKey);
  if (!l.oracleKeyReady || l.oracleKey.x !== expected.x || l.oracleKey.y !== expected.y) {
    throw new Error('acceptOracleKey was accepted but the contract does not show the key as active');
  }
  return { txId: result.public.txId };
};

// ------------------------------------------------------------------ record

export type StarfallDeploymentRecord = {
  contract: 'starfall';
  network: string;
  contractAddress: string;
  deployedAt: string;
  sourceCommit?: string;
  compiler: CompilerInfo;
  parameters: {
    oraclePublicKey: { x: string; y: string };
    organiserCommitment: string;
    backupCommitment: string;
    settlementKey: { x: string; y: string };
    operator: string;
    feePerGame: string;
    ticketPrice: string;
    minSales: string;
    maxSales: string;
    revealWindow: string;
    drawWindow: string;
    settleWindow: string;
  };
  transactions: { deploy?: string; acceptOracleKey?: string };
  verifierKeys: Fingerprints;
};

export const starfallRecordParameters = (p: StarfallDeployParams): StarfallDeploymentRecord['parameters'] => ({
  oraclePublicKey: { x: p.oraclePublicKey.x.toString(), y: p.oraclePublicKey.y.toString() },
  organiserCommitment: hex(p.organiserCommitment),
  backupCommitment: hex(p.backupCommitment),
  settlementKey: { x: p.settlementKey.x.toString(), y: p.settlementKey.y.toString() },
  operator: hex(p.operator),
  feePerGame: p.feePerGame.toString(),
  ticketPrice: p.ticketPrice.toString(),
  minSales: p.minSales.toString(),
  maxSales: p.maxSales.toString(),
  revealWindow: p.revealWindow.toString(),
  drawWindow: p.drawWindow.toString(),
  settleWindow: p.settleWindow.toString(),
});

export const starfallRecordPath = (network: string): string => join(deploymentsDir(), `starfall-${network}.json`);

export const readStarfallRecord = (network: string): StarfallDeploymentRecord => {
  const path = starfallRecordPath(network);
  if (!existsSync(path)) throw new Error(`no Starfall deployment on ${network} yet (${path}): run \`./lunardraw starfall deploy\` first`);
  return JSON.parse(readFileSync(path, 'utf8')) as StarfallDeploymentRecord;
};

export const writeStarfallRecord = (record: StarfallDeploymentRecord): string => {
  const path = starfallRecordPath(record.network);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return path;
};

// ------------------------------------------------------------------ verify

/** Check a live Starfall deployment against its record, from public data only. */
export const verifyStarfall = (
  record: StarfallDeploymentRecord,
  state: ContractStateView | null | undefined,
  local?: Fingerprints,
): Check[] => {
  if (!state) return [{ name: 'contract exists', ok: false, detail: `nothing at ${record.contractAddress}` }];
  const checks: Check[] = [{ name: 'contract exists', ok: true, detail: record.contractAddress }];
  const cma = state.maintenanceAuthority;
  checks.push({
    name: 'maintenance authority locked',
    ok: isLocked(cma),
    detail: `committee of ${cma.committee.length}, threshold ${cma.threshold}, ${cma.counter} update(s) since deploy`,
  });
  const onChain = onChainFingerprints(state);
  const vs = compareFingerprints(record.verifierKeys, onChain);
  checks.push({
    name: 'verifier keys match the published fingerprints',
    ok: vs.length === 0,
    detail: vs.length === 0 ? `${Object.keys(onChain).length} circuits` : vs.join('; '),
  });
  if (local) {
    const vl = compareFingerprints(record.verifierKeys, local);
    checks.push({ name: 'this checkout compiles to the deployed code', ok: vl.length === 0, detail: vl.length === 0 ? 'identical' : vl.join('; ') });
  }
  const l = Starfall.ledger(state.data as ChargedState);
  const p = record.parameters;
  const keyMatches = l.oracleKey.x.toString() === p.oraclePublicKey.x && l.oracleKey.y.toString() === p.oraclePublicKey.y;
  checks.push({
    name: 'oracle key accepted',
    ok: l.oracleKeyReady && keyMatches,
    detail: l.oracleKeyReady
      ? keyMatches
        ? 'active and matches the record'
        : 'active but differs from the record (rotated?)'
      : 'not accepted yet: run `./lunardraw starfall accept-key`',
  });
  if (l.oracleKeyReady && l.proposedOracleKey.is_some) {
    const at = new Date(Number(l.oracleKeyChangeAt) * 1000).toISOString();
    checks.push({
      name: 'no oracle key change pending',
      ok: false,
      detail: `a new key is proposed; it can take effect ${l.oracleKeyApproved ? 'now (approved by the current oracle)' : `from ${at}`}`,
    });
  } else {
    checks.push({ name: 'no oracle key change pending', ok: true, detail: `a change would wait ${l.oracleKeyDelay} s` });
  }
  const organiserOk = hex(l.organiser) === p.organiserCommitment;
  checks.push({
    name: 'organiser matches the record',
    ok: organiserOk,
    detail: organiserOk ? hex(l.organiser) : `${hex(l.organiser)} (record ${p.organiserCommitment}; handed over or recovered?)`,
  });
  checks.push({ name: 'backup organiser matches the record', ok: hex(l.backupOrganiser) === p.backupCommitment, detail: hex(l.backupOrganiser) });
  const settleKeyOk = l.settlementKey.x.toString() === p.settlementKey.x && l.settlementKey.y.toString() === p.settlementKey.y;
  checks.push({ name: 'settlement key matches the record', ok: settleKeyOk, detail: settleKeyOk ? 'tickets are encrypted to the recorded key' : 'differs' });
  const actual: Record<string, bigint | string> = {
    operator: hex(l.operator.bytes),
    feePerGame: l.feePerGame,
    ticketPrice: l.ticketPrice,
    minSales: l.minSales,
    maxSales: l.maxSales,
    revealWindow: l.revealWindow,
    drawWindow: l.drawWindow,
    settleWindow: l.settleWindow,
  };
  const differ = Object.entries(actual).filter(([k, v]) => v.toString() !== p[k as keyof typeof p]);
  checks.push({
    name: 'price, fee and windows match',
    ok: differ.length === 0,
    detail:
      differ.length === 0
        ? `${Number(l.ticketPrice) / 1e6} tNIGHT a game (${Number(l.feePerGame) / 1e6} to the operator); sales ${l.minSales}-${l.maxSales} s; reveal ${l.revealWindow} s, draw ${l.drawWindow} s, settle ${l.settleWindow} s`
        : differ.map(([k, v]) => `${k} ${v} (record ${String(p[k as keyof typeof p])})`).join('; '),
  });
  return checks;
};
