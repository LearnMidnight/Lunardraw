/**
 * Deploying Lunardraw, activating its oracle key, the published deployment
 * record (`deployments/<network>.json`) and checking a live deployment
 * against it from public data.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleSigningKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { ledger, pureCircuits } from '@lunardraw/contract';
import { oraclePublicKey } from '@nightcast/contract';
import {
  type AuthorityView,
  compareFingerprints,
  type CompilerInfo,
  deployLocked,
  type Fingerprints,
  isLocked,
  onChainFingerprints,
  type OperationsSource,
} from '@nightcast/deploy';
import { compiledLunardraw, joinLunardraw, type LunardrawProviders } from './contract.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

export type DeployParams = {
  oraclePublicKey: { x: bigint; y: bigint };
  organiserCommitment: Uint8Array;
  /** Commitment to the backup organiser's secret (kept offline). */
  backupCommitment: Uint8Array;
  /** Price of one line, in STAR (1 tNIGHT = 1,000,000 STAR). */
  linePrice: bigint;
  minSales: bigint;
  maxSales: bigint;
  revealWindow: bigint;
  drawWindow: bigint;
  claimWindow: bigint;
};

/**
 * Weekly Starfall: about a week of sales (the next draw opens when the last
 * one closes), an hour to reveal, two hours for the oracle, two days to claim.
 */
export const WEEKLY_DEFAULTS = {
  linePrice: 1_000_000n,
  minSales: 86_400n,
  maxSales: 14n * 86_400n,
  revealWindow: 3_600n,
  drawWindow: 7_200n,
  claimWindow: 2n * 86_400n,
} as const;

/** The organiser commitment the contract stores for a secret. */
export const organiserCommitmentOf = (secret: Uint8Array): Uint8Array => pureCircuits.organiserCommitmentOf(secret);

/** Deploy locked from the first block: nobody can ever change its code. */
export const deployLunardraw = (providers: LunardrawProviders, p: DeployParams) =>
  deployLocked(providers, {
    compiledContract: compiledLunardraw(),
    initialPrivateState: {},
    signingKey: sampleSigningKey(), // never used: the authority is replaced before anything is sent
    args: [
      p.oraclePublicKey,
      p.organiserCommitment,
      p.backupCommitment,
      p.linePrice,
      p.minSales,
      p.maxSales,
      p.revealWindow,
      p.drawWindow,
      p.claimWindow,
    ],
  });

/** The oracle proves it holds the proposed key, activating it. */
export const acceptOracleKey = async (providers: LunardrawProviders, contractAddress: string, oracleSecretKey: bigint) => {
  const joined = await joinLunardraw(providers, contractAddress, { oracleSecretKey });
  const result = await joined.callTx.acceptOracleKey();
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  const expected = oraclePublicKey(oracleSecretKey);
  const l = state ? ledger(state.data) : undefined;
  if (!l?.oracleKeyReady || l.oracleKey.x !== expected.x || l.oracleKey.y !== expected.y) {
    throw new Error('acceptOracleKey was accepted but the contract does not show the key as active');
  }
  return { txId: result.public.txId };
};

// ------------------------------------------------------------------ record

/** What gets published for a deployment. Everything here is public. */
export type DeploymentRecord = {
  network: string;
  contractAddress: string;
  deployedAt: string;
  sourceCommit?: string;
  compiler: CompilerInfo;
  parameters: {
    oraclePublicKey: { x: string; y: string };
    organiserCommitment: string;
    backupCommitment: string;
    linePrice: string;
    minSales: string;
    maxSales: string;
    revealWindow: string;
    drawWindow: string;
    claimWindow: string;
  };
  transactions: { deploy?: string; acceptOracleKey?: string };
  /** SHA-256 of each circuit's verifier key. */
  verifierKeys: Fingerprints;
};

export const recordParameters = (p: DeployParams): DeploymentRecord['parameters'] => ({
  oraclePublicKey: { x: p.oraclePublicKey.x.toString(), y: p.oraclePublicKey.y.toString() },
  organiserCommitment: hex(p.organiserCommitment),
  backupCommitment: hex(p.backupCommitment),
  linePrice: p.linePrice.toString(),
  minSales: p.minSales.toString(),
  maxSales: p.maxSales.toString(),
  revealWindow: p.revealWindow.toString(),
  drawWindow: p.drawWindow.toString(),
  claimWindow: p.claimWindow.toString(),
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The repo's `deployments/` folder (LUNARDRAW_DEPLOYMENTS_DIR overrides it). */
export const deploymentsDir = (): string => process.env.LUNARDRAW_DEPLOYMENTS_DIR ?? join(repoRoot, 'deployments');
export const recordPath = (network: string): string => join(deploymentsDir(), `${network}.json`);

export const readRecord = (network: string): DeploymentRecord => {
  const path = recordPath(network);
  if (!existsSync(path)) throw new Error(`no Lunardraw deployment on ${network} yet (${path}): run \`./lunardraw deploy\` first`);
  return JSON.parse(readFileSync(path, 'utf8')) as DeploymentRecord;
};

export const writeRecord = (record: DeploymentRecord): string => {
  const path = recordPath(record.network);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return path;
};

export const currentCommit = (): string | undefined => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

// ------------------------------------------------------------------ verify

export type Check = { name: string; ok: boolean; detail: string };

export type ContractStateView = OperationsSource & {
  maintenanceAuthority: AuthorityView;
  data: Parameters<typeof ledger>[0];
};

/** Check a live deployment against its record, from public data only. */
export const verifyDeployment = (
  record: DeploymentRecord,
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
    checks.push({
      name: 'this checkout compiles to the deployed code',
      ok: vl.length === 0,
      detail: vl.length === 0 ? 'identical' : vl.join('; '),
    });
  }
  const l = ledger(state.data);
  const p = record.parameters;
  const keyMatches = l.oracleKey.x.toString() === p.oraclePublicKey.x && l.oracleKey.y.toString() === p.oraclePublicKey.y;
  checks.push({
    name: 'oracle key accepted',
    ok: l.oracleKeyReady && keyMatches,
    detail: l.oracleKeyReady ? (keyMatches ? 'active and matches the record' : 'active but differs from the record (rotated?)') : 'not accepted yet: run `./lunardraw accept-key`',
  });
  // A changed oracle key is visible, not an error: the on-chain key and the
  // delay rule are what players rely on. A pending change is worth knowing about.
  if (l.proposedOracleKey.is_some) {
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
  checks.push({
    name: 'backup organiser matches the record',
    ok: hex(l.backupOrganiser) === p.backupCommitment,
    detail: hex(l.backupOrganiser),
  });
  const actual = {
    linePrice: l.linePrice,
    minSales: l.minSales,
    maxSales: l.maxSales,
    revealWindow: l.revealWindow,
    drawWindow: l.drawWindow,
    claimWindow: l.claimWindow,
  };
  const differ = Object.entries(actual).filter(([k, v]) => v.toString() !== p[k as keyof typeof actual]);
  checks.push({
    name: 'price and windows match',
    ok: differ.length === 0,
    detail:
      differ.length === 0
        ? `${Number(l.linePrice) / 1e6} tNIGHT a line; sales ${l.minSales}-${l.maxSales} s; reveal ${l.revealWindow} s, draw ${l.drawWindow} s, claim ${l.claimWindow} s`
        : differ.map(([k, v]) => `${k} ${v} (record ${p[k as keyof typeof actual]})`).join('; '),
  });
  return checks;
};

export const formatChecks = (checks: Check[]): string => checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`).join('\n');
