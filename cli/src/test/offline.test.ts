import { describe, it, expect } from 'vitest';
import { LottoSimulator, pureCircuits } from '@lunardraw/contract';
import { generateOperatorSecret, generateOracleSecretKey, oraclePublicKey } from '@nightcast/contract';
import { onChainFingerprints } from '@nightcast/deploy';
import { type ContractStateView, type DeploymentRecord, recordParameters, verifyDeployment } from '../deployment.js';

const vk = (s: string) => new TextEncoder().encode(s);
const keys = { computeNumbers: 'kc', openDraw: 'ko' };
const fps = onChainFingerprints({ operations: () => Object.keys(keys), operation: (n) => ({ verifierKey: vk(keys[n as 'openDraw']) }) });

const setup = (authority = { committee: [] as string[], threshold: 1, counter: 1n }) => {
  const sk = generateOracleSecretKey();
  const organiserSecret = generateOperatorSecret();
  const sim = new LottoSimulator({ oracleSecretKey: sk, organiserSecret, linePrice: 2_000_000n, claimWindow: 7_200n });
  const state: ContractStateView = {
    maintenanceAuthority: authority,
    operations: () => Object.keys(keys),
    operation: (name) => ({ verifierKey: vk(keys[name as 'openDraw']) }),
    data: sim.publicState(),
  };
  const record: DeploymentRecord = {
    network: 'local',
    contractAddress: sim.address,
    deployedAt: '2026-10-24T00:00:00Z',
    compiler: { compiler: '0.31.1', language: '0.23.0', runtime: '0.16.0' },
    parameters: recordParameters({
      oraclePublicKey: oraclePublicKey(sk),
      organiserCommitment: pureCircuits.organiserCommitmentOf(organiserSecret),
      linePrice: 2_000_000n,
      minSales: 600n,
      maxSales: 2_592_000n,
      revealWindow: 3_600n,
      drawWindow: 3_600n,
      claimWindow: 7_200n,
    }),
    transactions: {},
    verifierKeys: fps,
  };
  return { sim, state, record };
};

const failing = (checks: { name: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.name);

describe('verifyDeployment', () => {
  it('passes a locked deployment that matches its record', () => {
    const { state, record } = setup();
    expect(failing(verifyDeployment(record, state, fps))).toEqual([]);
  });

  it('fails when the authority can sign, the keys differ or a parameter differs', () => {
    const unlocked = setup({ committee: ['k'], threshold: 1, counter: 0n });
    expect(failing(verifyDeployment(unlocked.record, unlocked.state))).toEqual(['maintenance authority locked']);

    const { state, record } = setup();
    expect(failing(verifyDeployment({ ...record, verifierKeys: { ...fps, openDraw: '00' } }, state))).toEqual([
      'verifier keys match the published fingerprints',
    ]);
    const cheaper = { ...record, parameters: { ...record.parameters, linePrice: '1000000' } };
    const checks = verifyDeployment(cheaper, state);
    expect(failing(checks)).toEqual(['price and windows match']);
    expect(checks.find((c) => c.name === 'price and windows match')?.detail).toMatch(/linePrice 2000000 \(record 1000000\)/);
    const stranger = { ...record, parameters: { ...record.parameters, organiserCommitment: '00'.repeat(32) } };
    expect(failing(verifyDeployment(stranger, state))).toEqual(['organiser matches the record']);
  });

  it('reports a missing contract', () => {
    const { record } = setup();
    expect(verifyDeployment(record, undefined)).toEqual([{ name: 'contract exists', ok: false, detail: `nothing at ${record.contractAddress}` }]);
  });
});
