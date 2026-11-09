/**
 * The compiled Lunardraw contract, as midnight-js expects it, and the
 * providers and adapters to run it on a live network.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { findDeployedContract, type Ledger8CircuitId } from '@midnight-ntwrk/midnight-js/contracts';
import type { ContractStateRead, MidnightProviders } from '@midnight-ntwrk/midnight-js/types';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import { type EncodableContractState, ledgerOf, Lunardraw, type LottoPrivateState, type NextDraw, witnesses } from '@lunardraw/contract';
import { type ChainView, type DrawOracleChain, type LunardrawChain, viewOf } from '@lunardraw/keeper';
import { contractProviders, decodeContractState, type Session } from '@nightcast/deploy';

export const LUNARDRAW_PRIVATE_STATE_ID = 'lunardraw';

export type LunardrawContract = Lunardraw.Contract<LottoPrivateState>;
export type LunardrawCircuits = Ledger8CircuitId<LunardrawContract>;
export type LunardrawProviders = MidnightProviders<LunardrawCircuits, typeof LUNARDRAW_PRIVATE_STATE_ID, LottoPrivateState>;

/**
 * The compiled contract with its proving keys (`npm run compact:keys`): the
 * one in `@lunardraw/contract`, unless LUNARDRAW_ZK_CONFIG_PATH says otherwise.
 */
export const zkConfigPath = (override = process.env.LUNARDRAW_ZK_CONFIG_PATH): string => {
  if (override) return override;
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve('@lunardraw/contract/package.json'));
  for (const candidate of [join(pkg, 'dist', 'managed', 'lunardraw'), join(pkg, 'src', 'managed', 'lunardraw')]) {
    if (existsSync(join(candidate, 'keys'))) return candidate;
  }
  throw new Error('No compiled Lunardraw contract with proving keys found. Run `npm run compact:keys` then `npm run build`.');
};

/**
 * The contract with its witnesses, as Midnight.js 5 takes a contract compiled
 * by the previous toolchain (Compact 0.31): the generated instance itself. Its
 * proving keys come from the providers' ZK config provider (`zkConfigPath`).
 */
export const compiledLunardraw = (): LunardrawContract => new Lunardraw.Contract<LottoPrivateState>(witnesses);

export const lunardrawProviders = (session: Session, wallet: MidnightWalletProvider, dir = zkConfigPath()): LunardrawProviders =>
  contractProviders<LunardrawCircuits, typeof LUNARDRAW_PRIVATE_STATE_ID, LottoPrivateState>(session, wallet, dir);

/** Join a deployment with a private state (the organiser's secret, the oracle's key, or nothing). */
export const joinLunardraw = (providers: LunardrawProviders, contractAddress: string, privateState: LottoPrivateState) =>
  findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledLunardraw(),
    privateStateId: LUNARDRAW_PRIVATE_STATE_ID,
    initialPrivateState: privateState,
  });

/** The calls the keeper and the oracle make on a joined contract. */
export interface LunardrawCalls {
  callTx: {
    requestDraw(n: bigint, seed: Uint8Array, next: { is_some: boolean; value: NextDraw }): Promise<unknown>;
    fulfilDraw(n: bigint): Promise<unknown>;
    computeNumbers(n: bigint, now: bigint): Promise<unknown>;
    settleDraw(n: bigint): Promise<unknown>;
    payWin(line: Uint8Array): Promise<unknown>;
    voidDraw(n: bigint): Promise<unknown>;
  };
}

/** Where the contract's state is read from: a Midnight.js public data provider, or an adapter answering decoded ledger states. */
export interface ContractStateSource {
  queryContractState(address: string): Promise<EncodableContractState | ContractStateRead | null | undefined>;
}

const NO_NEXT = { is_some: false, value: { salesClose: 0n, seedCommitment: new Uint8Array(32) } };

/** Read the contract's public state. */
export const readView = async (publicData: ContractStateSource, contractAddress: string): Promise<ChainView> => {
  const read = await publicData.queryContractState(contractAddress);
  const state = read ? ('contractState' in read ? decodeContractState(read) : read) : null;
  if (!state) throw new Error(`no Lunardraw contract at ${contractAddress}`);
  return viewOf(ledgerOf(state));
};

/**
 * A live deployment for the keeper and the oracle. Time is the local clock:
 * keep it in sync (NTP). The contract allows `computeNumbers` 10 minutes of
 * difference from block time, and the keeper waits a margin after each
 * boundary.
 */
export class MidnightLunardrawChain implements LunardrawChain, DrawOracleChain {
  /**
   * @param proveLeadSecs computeNumbers stamps the caller's clock, and the
   * contract accepts the transaction only within 10 minutes of that stamp
   * (either way). Proving the numbers takes minutes, so the stamp is set this
   * far ahead: with 240 s the proof may land from 6 minutes before to 14
   * minutes after it was started.
   */
  constructor(
    private readonly contract: LunardrawCalls,
    private readonly publicData: ContractStateSource,
    readonly contractAddress: string,
    private readonly proveLeadSecs = 240,
  ) {}

  view(): Promise<ChainView> {
    return readView(this.publicData, this.contractAddress);
  }

  async now(): Promise<number> {
    return Date.now() / 1000;
  }

  async openDraw(salesClose: bigint, seedCommitment: Uint8Array): Promise<void> {
    // requestDraw with n = 0 reveals nothing and just opens the next draw.
    await this.contract.callTx.requestDraw(0n, new Uint8Array(32), { is_some: true, value: { salesClose, seedCommitment } });
  }

  async requestDraw(n: bigint, seed: Uint8Array, next?: NextDraw): Promise<void> {
    await this.contract.callTx.requestDraw(n, seed, next ? { is_some: true, value: next } : NO_NEXT);
  }

  async fulfilDraw(n: bigint): Promise<void> {
    await this.contract.callTx.fulfilDraw(n);
  }

  async computeNumbers(n: bigint): Promise<void> {
    await this.contract.callTx.computeNumbers(n, BigInt(Math.floor(Date.now() / 1000) + this.proveLeadSecs));
  }

  async settleDraw(n: bigint): Promise<void> {
    await this.contract.callTx.settleDraw(n);
  }

  async payWin(line: Uint8Array): Promise<void> {
    await this.contract.callTx.payWin(line);
  }

  async voidDraw(n: bigint): Promise<void> {
    await this.contract.callTx.voidDraw(n);
  }
}
