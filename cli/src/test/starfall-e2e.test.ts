/**
 * Starfall end to end on a throwaway local Midnight network in Docker, with
 * real proofs: deploy locked with a settlement key, activate the oracle key,
 * buy games (one sure winner), and the keeper and the oracle run the draw to
 * the end: reveal, answer, numbers, settlement batch, finalise (operator fee),
 * pay the winners. Then a draw the oracle never answers is voided and its
 * game refunded. Run with LUNARDRAW_E2E=1 (CI does); skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import { quickPick, type PlainLine, Starfall } from '@lunardraw/contract';
import { commitmentOf, DerivedSeeds, DrawOracle, type Schedule, StarfallKeeper, type StarfallView } from '@lunardraw/keeper';
import { generateOperatorSecret, generateOracleSecretKey, oraclePublicKey, pureCircuits as nightcast } from '@nightcast/contract';
import { combineDrawSeed, drawStarfall } from '@nightcast/sdk';
import { connect, localFingerprints, openWallet, type Session } from '@nightcast/deploy';
import { ProofServer } from '../proof-server.js';
import {
  acceptStarfallOracleKey,
  buyGames,
  compiledStarfall,
  deployStarfall,
  joinStarfall,
  MidnightStarfallChain,
  type StarfallDeployParams,
  type StarfallDeploymentRecord,
  type StarfallProviders,
  starfallProviders,
  starfallRecordParameters,
  starfallZkConfigPath,
  verifyStarfall,
} from '../starfall.js';

const enabled = process.env.LUNARDRAW_E2E === '1';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const explain = (err: unknown): string => {
  const text = inspect(err, { depth: 12, breakLength: Infinity, showHidden: true });
  return text
    .split('\n')
    .filter((l) => !/^\s+at /.test(l))
    .join('\n')
    .slice(0, 6000);
};
const { DrawStatus } = Starfall;

/** A line with exactly `match` main numbers and the Moonball. */
const lineHitting = (numbers: number[], moonball: number, match: number): PlainLine => {
  const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !numbers.includes(x));
  return { numbers: [...numbers.slice(0, match), ...misses.slice(0, 7 - match)], moonball };
};

describe.runIf(enabled)('Starfall on a local Midnight network', () => {
  let session: Session;
  // Our own supervised proof server rather than the network's: each big proof
  // takes about 7 GB and the server keeps much of it, so it's restarted (when
  // idle above 3 GB) before every step, as the VM's supervisor does.
  const PROOF_PORT = 6311;
  const proofServer = new ProofServer({ port: PROOF_PORT, memoryLimitMiB: 3_072, log: (m) => process.stdout.write(`[proof server] ${m}\n`), echo: false });
  let wallet: MidnightWalletProvider;
  let providers: StarfallProviders;
  let address: string;
  let keeper: StarfallKeeper;
  let oracle: DrawOracle;
  let keeperChain: MidnightStarfallChain;
  let seeds: DerivedSeeds;
  let mine: Uint8Array;
  const oracleSecretKey = generateOracleSecretKey();
  const organiserSecret = generateOperatorSecret();
  const backupSecret = generateOperatorSecret();
  const settlementSecret = Starfall.randomScalar();
  const operator = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const params: StarfallDeployParams = {
    oraclePublicKey: oraclePublicKey(oracleSecretKey),
    organiserCommitment: Starfall.pureCircuits.organiserCommitmentOf(organiserSecret),
    backupCommitment: Starfall.pureCircuits.organiserCommitmentOf(backupSecret),
    settlementKey: Starfall.pureCircuits.settlementPublicKey(settlementSecret),
    operator,
    feePerGame: 200_000n,
    ticketPrice: 1_200_000n,
    minSales: 60n,
    maxSales: 86_400n,
    revealWindow: 600n,
    drawWindow: 300n,
    settleWindow: 3_600n,
  };
  // Draw 1 closes 15 minutes after it opens (time for two purchases); later
  // draws 20 minutes after, so draw 2 is still selling once draw 1 is drawn.
  let opened = 0;
  const sales: Schedule = (now) => BigInt(Math.floor(now) + (opened++ === 0 ? 900 : 1_200));

  let failed = false;
  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') failed = true;
  });

  beforeAll(async () => {
    process.env.LUNARDRAW_DEPLOYMENTS_DIR = mkdtempSync(join(tmpdir(), 'starfall-deployments-'));
    void proofServer.run();
    if (!(await proofServer.ready(120_000))) throw new Error('the supervised proof server did not start');
    const network = await connect('local');
    session = { ...network, config: { ...network.config, proofServer: `http://127.0.0.1:${PROOF_PORT}` } };
    wallet = await openWallet(session);
    providers = starfallProviders(session, wallet);
    mine = Uint8Array.from(Buffer.from(wallet.unshieldedKeystore.getAddress(), 'hex'));
    compiledStarfall(); // fail early if the proving keys weren't built
  }, 20 * 60_000);

  afterAll(async () => {
    await keeper?.stop().catch(() => undefined);
    await wallet?.stop().catch(() => undefined);
    proofServer.stop();
    if (failed && process.env.CI) return;
    await session?.shutdown().catch(() => undefined);
  }, 5 * 60_000);

  const view = (): Promise<StarfallView> => keeperChain.view();
  const drawOf = async (n: bigint) => (await view()).draws.find((d) => d.id === n);
  /** Tick the keeper (and the oracle, if asked) until `done` holds. */
  const until = async (what: string, done: (v: StarfallView) => boolean, opts: { oracle?: boolean; tries?: number } = {}) => {
    for (let i = 0; i < (opts.tries ?? 60); i++) {
      const v = await view();
      if (done(v)) return v;
      await proofServer.freshen();
      const r = await keeper.tick();
      for (const f of r.failed) session.logger.warn(`keeper: ${f.step} failed: ${f.error}`);
      if (opts.oracle) {
        await proofServer.freshen();
        await oracle.tick();
      }
      await sleep(5_000);
    }
    throw new Error(`timed out waiting until ${what}`);
  };

  it('deploys locked with a settlement key and activates the oracle key', async () => {
    const deployed = await deployStarfall(providers, params).catch((err: unknown) => {
      throw new Error(`deploy rejected: ${explain(err)}`);
    });
    address = deployed.contractAddress;
    await acceptStarfallOracleKey(providers, address, oracleSecretKey);
    const fps = localFingerprints(starfallZkConfigPath());
    expect(Object.keys(fps)).toHaveLength(12);
    const record: StarfallDeploymentRecord = {
      contract: 'starfall',
      network: 'local',
      contractAddress: address,
      deployedAt: new Date().toISOString(),
      compiler: { compiler: '', language: '', runtime: '' },
      parameters: starfallRecordParameters(params),
      transactions: {},
      verifierKeys: fps,
    };
    const state = await providers.publicDataProvider.queryContractState(address);
    expect(verifyStarfall(record, state, fps).filter((c) => !c.ok)).toEqual([]);
  }, 20 * 60_000);

  it('runs a draw with games in it, from purchase to paying the winner', async () => {
    // Separate providers (and private state) per role, as in real use.
    const keeperProviders = starfallProviders(session, wallet);
    const oracleProviders = starfallProviders(session, wallet);
    const buyerProviders = starfallProviders(session, wallet);
    const base = { organiserSecret };
    const organiser = await joinStarfall(keeperProviders, address, base);
    keeperChain = new MidnightStarfallChain(organiser, keeperProviders.publicDataProvider, keeperProviders.privateStateProvider, address, base);
    seeds = new DerivedSeeds(organiserSecret, keeperChain.addressBytes);
    keeper = new StarfallKeeper({ chain: keeperChain, seeds, settlementSecret, schedule: sales, marginSecs: 20, logger: session.logger });
    const oracleJoined = await joinStarfall(oracleProviders, address, { oracleSecretKey });
    const oracleChain = new MidnightStarfallChain(oracleJoined, oracleProviders.publicDataProvider, oracleProviders.privateStateProvider, address);
    oracle = new DrawOracle({ chain: oracleChain, publicKey: params.oraclePublicKey, newRequestDelayMs: 0, logger: session.logger });

    expect((await keeper.tick()).done).toEqual(['open after 0']);
    const first = (await drawOf(1n))!;
    expect(first.status).toBe(DrawStatus.open);
    expect(hex(first.seedCommitment)).toBe(hex(commitmentOf(seeds.seedFor(1n))));

    // The test knows the seed and the oracle key, so it can buy a sure winner (3 + Moonball, division 8).
    const seed = seeds.seedFor(1n);
    const alpha = Starfall.pureCircuits.drawAlpha({ bytes: keeperChain.addressBytes }, 1n, seed);
    const expected = drawStarfall(combineDrawSeed(hex(seed), nightcast.evaluate(oracleSecretKey, alpha))) as { numbers: number[]; moonball: number };
    const games = [Starfall.makeTicket(1n, lineHitting(expected.numbers, expected.moonball, 3), mine)];
    for (let i = 0; i < 4; i++) games.push(Starfall.makeTicket(1n, quickPick(), mine));
    const buyer = await joinStarfall(buyerProviders, address, {});
    const started = Date.now();
    await proofServer.freshen();
    const txs = await buyGames(buyer, buyerProviders.privateStateProvider, address, games, mine, (done, of) =>
      session.logger.info(`bought ${done} of ${of} (${Math.round((Date.now() - started) / 1000)} s)`),
    ).catch((err: unknown) => {
      throw new Error(`purchase rejected: ${explain(err)}`);
    });
    expect(txs).toBe(3); // 2 games, 2, then 1
    expect((await drawOf(1n))!.tickets).toBe(5n);

    // Sales close: reveal (and open draw 2), the oracle answers, the numbers come out.
    while (Date.now() / 1000 < Number(first.salesClose) + 25) await sleep(5_000);
    await until('draw 1 is drawn', (v) => v.draws.find((d) => d.id === 1n)!.status === DrawStatus.drawn, { oracle: true });
    const drawn = (await drawOf(1n))!;
    expect(drawn.numbers).toEqual(expected.numbers);
    expect(drawn.moonball).toBe(expected.moonball);

    // A game in draw 2, which the oracle will never answer (it isn't ticked again).
    const d2 = (await drawOf(2n))!;
    expect(d2.status).toBe(DrawStatus.open);
    await proofServer.freshen();
    await buyGames(buyer, buyerProviders.privateStateProvider, address, [Starfall.makeTicket(2n, quickPick(), mine)], mine);
    expect((await drawOf(2n))!.tickets).toBe(1n);

    // Settle the one batch, finalise, pay.
    await until('draw 1 is settled', (v) => v.draws.find((d) => d.id === 1n)!.status === DrawStatus.settled);
    const settled = (await drawOf(1n))!;
    expect(settled.settled).toBe(5n);
    expect(settled.fee).toBe(5n * params.feePerGame);
    expect(settled.winners[7]).toBeGreaterThanOrEqual(1n);
    const v = await until('every winner is paid', (x) => x.entitlements.filter((e) => e.drawId === 1n).every((e) => e.paid));
    expect(v.entitlements.filter((e) => e.drawId === 1n).length).toBeGreaterThanOrEqual(1);
  }, 60 * 60_000);

  it('voids a draw the oracle never answers, and refunds its game', async () => {
    const d2 = (await drawOf(2n))!;
    // The keeper reveals draw 2; the oracle stays quiet; after the draw window it voids and refunds.
    while (Date.now() / 1000 < Number(d2.salesClose) + 25) await sleep(5_000);
    await until('draw 2 is revealed', (v) => v.draws.find((d) => d.id === 2n)!.status === DrawStatus.requested);
    while (Date.now() / 1000 < Number(d2.drawDeadline) + 25) await sleep(5_000);
    await until('draw 2 is void', (v) => v.draws.find((d) => d.id === 2n)!.status === DrawStatus.voided);
    await until('draw 2 is refunded', (v) => v.draws.find((d) => d.id === 2n)!.unrefunded.length === 0);
  }, 60 * 60_000);
});
