/**
 * End-to-end on a throwaway local Midnight network in Docker: deploy locked,
 * activate the oracle key, then the keeper and the draw oracle run a real
 * draw with real proofs, including computeNumbers (the biggest circuit).
 * Run with LUNARDRAW_E2E=1 (CI does); skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import { DrawStatus, ledger } from '@lunardraw/contract';
import { DrawOracle, Keeper, MemorySeedStore, type Schedule } from '@lunardraw/keeper';
import { generateOperatorSecret, generateOracleSecretKey, oraclePublicKey, pureCircuits as nightcast } from '@nightcast/contract';
import { combineDrawSeed, drawStarfall } from '@nightcast/sdk';
import { connect, localFingerprints, openWallet, type Session } from '@nightcast/deploy';
import { compiledLunardraw, joinLunardraw, lunardrawProviders, type LunardrawProviders, MidnightLunardrawChain, zkConfigPath } from '../contract.js';
import { acceptOracleKey, deployLunardraw, type DeploymentRecord, organiserCommitmentOf, recordParameters, verifyDeployment } from '../deployment.js';

const enabled = process.env.LUNARDRAW_E2E === '1';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe.runIf(enabled)('Lunardraw on a local Midnight network', () => {
  let session: Session;
  let wallet: MidnightWalletProvider;
  let providers: LunardrawProviders;
  let address: string;
  const oracleSecretKey = generateOracleSecretKey();
  const organiserSecret = generateOperatorSecret();
  const seeds = new MemorySeedStore();
  const params = {
    oraclePublicKey: oraclePublicKey(oracleSecretKey),
    organiserCommitment: organiserCommitmentOf(organiserSecret),
    linePrice: 1_000_000n,
    minSales: 60n,
    maxSales: 86_400n,
    revealWindow: 600n,
    drawWindow: 900n,
    claimWindow: 3_600n,
  };
  // Draws close about two and a half minutes after they open.
  const soon: Schedule = (now, minSales) => BigInt(Math.floor(now) + minSales + 90);

  // After a failure, leave the containers for CI's logs step.
  let failed = false;
  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') failed = true;
  });

  beforeAll(async () => {
    process.env.LUNARDRAW_DEPLOYMENTS_DIR = mkdtempSync(join(tmpdir(), 'lunardraw-deployments-'));
    session = await connect('local');
    wallet = await openWallet(session);
    providers = lunardrawProviders(session, wallet);
    // Fail early, with a clear message, if the proving keys weren't built.
    compiledLunardraw();
  }, 20 * 60_000);

  afterAll(async () => {
    await wallet?.stop().catch(() => undefined);
    if (failed && process.env.CI) return;
    await session?.shutdown().catch(() => undefined);
  }, 5 * 60_000);

  it('deploys locked and activates the oracle key', async () => {
    const deployed = await deployLunardraw(providers, params);
    address = deployed.contractAddress;
    await acceptOracleKey(providers, address, oracleSecretKey);
    const fps = localFingerprints(zkConfigPath());
    const record: DeploymentRecord = {
      network: 'local',
      contractAddress: address,
      deployedAt: new Date().toISOString(),
      compiler: { compiler: '', language: '', runtime: '' },
      parameters: recordParameters(params),
      transactions: {},
      verifierKeys: fps,
    };
    const state = await providers.publicDataProvider.queryContractState(address);
    expect(verifyDeployment(record, state, fps).filter((c) => !c.ok)).toEqual([]);
  }, 15 * 60_000);

  it('runs a draw: the keeper opens and reveals it, the oracle answers, the keeper computes the numbers', async () => {
    const organiser = await joinLunardraw(providers, address, { organiserSecret });
    const keeperChain = new MidnightLunardrawChain(organiser, providers.publicDataProvider, address);
    const keeper = new Keeper({ chain: keeperChain, seeds, schedule: soon, marginSecs: 20, logger: session.logger });
    const oracleJoined = await joinLunardraw(providers, address, { oracleSecretKey });
    const oracleChain = new MidnightLunardrawChain(oracleJoined, providers.publicDataProvider, address);
    const oracle = new DrawOracle({ chain: oracleChain, publicKey: params.oraclePublicKey, newRequestDelayMs: 0, logger: session.logger });

    // Open draw 1.
    expect((await keeper.tick()).done).toEqual(['open after 0']);
    const view = await keeperChain.view();
    const first = view.draws.find((d) => d.id === 1n)!;
    expect(first.status).toBe(DrawStatus.open);

    // After sales close: reveal draw 1 and open draw 2 in one transaction.
    while (Date.now() / 1000 < Number(first.salesClose) + 25) await sleep(5_000);
    expect((await keeper.tick()).done).toContain('reveal 1');

    // The oracle answers, and the keeper computes the numbers.
    for (let i = 0; i < 10 && (await oracle.tick()).fulfilled.length === 0; i++) await sleep(5_000);
    let d1 = (await keeperChain.view()).draws.find((d) => d.id === 1n)!;
    expect(d1.status).toBe(DrawStatus.fulfilled);
    for (let i = 0; i < 10 && d1.status !== DrawStatus.drawn; i++) {
      await keeper.tick();
      d1 = (await keeperChain.view()).draws.find((d) => d.id === 1n)!;
      if (d1.status !== DrawStatus.drawn) await sleep(5_000);
    }
    expect(d1.status).toBe(DrawStatus.drawn);

    // The numbers are the published rule applied to the revealed seed and the VRF output.
    const state = await providers.publicDataProvider.queryContractState(address);
    const draw = ledger(state!.data).draws.lookup(1n);
    const seed = (await seeds.find(draw.seedCommitment))!;
    expect(hex(draw.seed)).toBe(hex(seed));
    expect(hex(draw.output)).toBe(hex(nightcast.evaluateAt(oracleSecretKey, draw.point)));
    const expected = drawStarfall(combineDrawSeed(hex(seed), draw.output));
    expect(draw.numbers.map(Number)).toEqual(expected.numbers);
    expect(Number(draw.moonball)).toBe(expected.moonball);
    expect(ledger(state!.data).lastDraw).toBe(2n);
  }, 40 * 60_000);
});
