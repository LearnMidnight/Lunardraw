/**
 * `./lunardraw starfall-v2 ...`: the keeper and the draw oracle of a Starfall v2 deployment
 * (starfall-v2/, docs/ADAPTIVE.md), and its status. They are Starfall's keeper and oracle
 * (the same steps; v2 adds paying syndicate members and refunding syndicates) on the v2
 * chain adapter (starfall-v2.ts).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { DerivedSeeds, DrawOracle, every, STARFALL_DAILY, StarfallKeeper, type StarfallView, writeFeed, buildStarfallFeed, woundDown } from '@lunardraw/keeper';
import { BLOCKFROST, type Session } from '@nightcast/deploy';
import {
  forceExit,
  hex,
  iso,
  networkArg,
  oracleKeyFrom,
  organiserSecretFrom,
  proofServerPort,
  publicDataFor,
  RESTART,
  restartAfter,
  silentAfter,
  stallAfter,
  untilFailingFor,
  untilSilentFor,
  untilStopped,
  walletSeed,
  withSession,
} from './common.js';
import { DustMeter } from './dust-meter.js';
import { dustWait } from './dust-wait.js';
import { statusWriter } from './status-file.js';
import { freshFees, openServiceWallet, settlementFrom } from './starfall-commands.js';
import {
  joinStarfallV2,
  loadStarfallV2,
  MidnightStarfallV2Chain,
  readStarfallV2Record,
  readV2Ledger,
  type StarfallV2,
  type StarfallV2Record,
  starfallV2Out,
  starfallV2Providers,
  starfallV2ViewOf,
  v2Pure,
} from './starfall-v2.js';
import { watchSync } from './sync-watch.js';

export const STARFALL_V2_USAGE = `usage: ./lunardraw starfall-v2 <command>

  keeper  --network <network> --organiser <file> --settlement <file> [--wallet <file>]
          [--every <seconds>] [--feed <file>] [--status <file>] [--record <file>] [--proof-server-port <port>]
      Runs the draws: opens each, reveals its seed after sales close (opening the next), computes the
      numbers, settles, finalises (the Treasury tops up the next jackpot in the same transaction),
      pays every prize and syndicate member, voids a stuck draw and refunds it. Draws close daily at
      20:00 Brisbane, or every --every seconds (a rehearsal).
  oracle  --network <network> --oracle <file> [--wallet <file>] [--status <file>] [--record <file>] [--proof-server-port <port>]
      Answers each draw with Nightcast's VRF.
  status  --network <network> [--record <file>]

The deployment is deployments/starfall-v2-<network>.json (or --record), written by
starfall-v2/deploy/deploy.mjs. The compiled contracts with their keys are in
starfall-v2/deploy/out (or LUNARDRAW_STARFALL_V2_OUT).`;

const STAGE = ['open', 'requested', 'fulfilled', 'drawn', 'settled', 'void'];
const tn = (star: bigint) => `${(Number(star) / 1e6).toLocaleString('en', { maximumFractionDigits: 6 })} tNIGHT`;

/** A short account of a v2 deployment's draws and syndicates. */
export const describeV2 = (view: StarfallView, nowSecs: number, batchSize: bigint): string => {
  const lines: string[] = [];
  if (!view.oracleKeyReady) lines.push('The oracle key is not active yet; no draw can open.');
  if (view.draws.length === 0) lines.push('No draws yet.');
  for (const d of view.draws) {
    let stage = STAGE[d.status] ?? String(d.status);
    if (d.status === 0 && BigInt(Math.floor(nowSecs)) >= d.salesClose) stage = 'closed';
    const format = d.format ? `7 from ${d.format.range}${d.format.moonballs > 1 ? ` + Moonball 1-${d.format.moonballs}` : ''}` : '';
    let extra = '';
    if (d.status === 3) extra = `  settled ${d.settled}/${d.tickets} (batches of ${batchSize}), deadline ${iso(d.settleDeadline)}`;
    if (d.status === 4) {
      const unpaid = view.entitlements.filter((e) => e.drawId === d.id && !e.paid).length;
      extra = `  jackpot ${tn(d.carried)}; ${d.winners.reduce((a, b) => a + b, 0n)} winning game(s)${unpaid ? `, ${unpaid} not paid yet` : ''}`;
    }
    if (d.status === 5) extra = d.unrefunded.length ? `  ${d.unrefunded.length} ticket(s) still to refund` : '  refunded';
    const numbers = d.status === 3 || d.status === 4 ? `  ${d.numbers.join(' ')}${d.format && d.format.moonballs > 1 ? ` + ${d.moonball}` : ''}` : '';
    lines.push(`draw ${d.id}  ${stage}${d.final ? ' (final draw)' : ''}  ${format}  sales close ${iso(d.salesClose)}  ${d.games} game(s) in ${d.tickets} ticket(s)${numbers}${extra}`);
  }
  const owed = (view.memberPayments ?? []).filter((p) => p.amount > 0n).length;
  if (view.syndicates?.length) lines.push(`Syndicates: ${view.syndicates.length}${owed ? `; ${owed} member payment(s) to make` : ''}`);
  lines.push(view.ended ? 'The final draw has given everything out: the game has ended.' : `The next jackpot so far: ${tn(view.carry)}`);
  return lines.join('\n');
};

/** The record, with the compiled contracts it was deployed from (checked against the record's game). */
const deployment = async (network: string, path: string | undefined, keys: boolean): Promise<{ record: StarfallV2Record; v2: StarfallV2 }> => {
  const record = readStarfallV2Record(network, path);
  const v2 = await loadStarfallV2(starfallV2Out(), { keys });
  return { record, v2 };
};

/** Runs a service until it is stopped, or until a watchdog asks for a restart. */
const serve = async (
  session: Session,
  wallet: Parameters<typeof watchSync>[0] & Parameters<typeof statusWriter>[1]['wallet'],
  service: { status(): { streak: { failures: number; since?: number; lastSuccessAt?: number }; lastTickAt?: number }; stop(): Promise<void> },
  name: string,
  values: Record<string, string | boolean | undefined>,
  meter: DustMeter,
  stuck: Promise<boolean>,
): Promise<number> => {
  const watchdog = untilFailingFor(restartAfter(values['restart-after'] as string | undefined), () => service.status().streak, session.logger);
  const sync = watchSync(wallet, { stallMinutes: stallAfter(values['stall-after'] as string | undefined), logger: session.logger });
  const silence = untilSilentFor(silentAfter(values['silent-after'] as string | undefined), () => service.status().lastTickAt, session.logger);
  const health =
    typeof values.status === 'string'
      ? statusWriter(values.status, { service: name, wallet, pass: () => service.status(), nightToken: unshieldedToken().raw, logger: session.logger, fees: () => meter.summary() })
      : undefined;
  const restart = await Promise.race([untilStopped().then(() => false), watchdog.done, sync.stalled, silence.done, stuck]);
  watchdog.cancel();
  sync.stop();
  silence.cancel();
  health?.stop();
  if (restart) forceExit(RESTART);
  session.logger.info(`Stopping the ${name}...`);
  await service.stop();
  return restart ? RESTART : 0;
};

export const starfallV2 = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    strict: true,
    options: {
      network: { type: 'string' },
      wallet: { type: 'string' },
      organiser: { type: 'string' },
      oracle: { type: 'string' },
      settlement: { type: 'string' },
      record: { type: 'string' },
      every: { type: 'string' },
      feed: { type: 'string' },
      status: { type: 'string' },
      'proof-server-port': { type: 'string' },
      'restart-after': { type: 'string' },
      'stall-after': { type: 'string' },
      'silent-after': { type: 'string' },
      'dust-wait': { type: 'string' },
      'prove-lead': { type: 'string' },
    },
  });

  switch (command) {
    case 'keeper': {
      const network = networkArg(values.network);
      if (!values.organiser || !values.settlement) throw new Error(STARFALL_V2_USAGE);
      const { record, v2 } = await deployment(network, values.record, true);
      const organiserSecret = organiserSecretFrom(values.organiser);
      const settlement = settlementFrom(values.settlement, true);
      if (hex(v2.G.pureCircuits.organiserCommitmentOf(organiserSecret)) !== record.parameters.organiserCommitment) {
        throw new Error(`${values.organiser} is not this deployment's organiser`);
      }
      if (settlement.pk.x.toString() !== record.parameters.settlementKey.x || settlement.pk.y.toString() !== record.parameters.settlementKey.y) {
        throw new Error(`${values.settlement} is not this deployment's settlement key`);
      }
      const schedule = values.every ? every(Number(values.every)) : STARFALL_DAILY;
      const seeds = new DerivedSeeds(organiserSecret, encodeContractAddress(record.contractAddress));
      const dustMinutes = dustWait(values['dust-wait']);
      return withSession(network, async (session) => {
        const wallet = await openServiceWallet(session, walletSeed(values.wallet), dustMinutes);
        if (!wallet) return RESTART;
        try {
          const meter = new DustMeter(values.status ? `${values.status}.fees.json` : undefined);
          const raw = await starfallV2Providers(session, wallet, v2, record.treasuryAddress);
          const { providers, stuck } = freshFees(raw, wallet, session.logger, meter);
          // The contract is the judge: its stored organiser must be this secret's commitment.
          const l = await readV2Ledger(v2.G, providers.publicDataProvider, record.contractAddress);
          if (hex(l.organiser) !== record.parameters.organiserCommitment) throw new Error(`the contract's organiser is ${hex(l.organiser)}, not this secret's`);
          const base = { organiserSecret };
          const joined = await joinStarfallV2(providers, v2, record.contractAddress, base);
          const lead = values['prove-lead'] === undefined ? 300 : Number(values['prove-lead']);
          const chain = new MidnightStarfallV2Chain(v2, joined, providers.publicDataProvider, providers.privateStateProvider as never, record.contractAddress, base, lead);
          const feedPath = values.feed;
          const onView = feedPath
            ? (view: StarfallView, nowSecs: number) => writeFeed(feedPath, buildStarfallFeed(view, { network, contract: record.contractAddress, nowSecs }))
            : undefined;
          const lastDraw = join(homedir(), 'lunardraw-secrets', `starfall-v2-last-draw-${record.contractAddress.slice(0, 16)}`);
          const keeper = new StarfallKeeper({
            chain,
            seeds,
            // Every look is a Blockfrost request on Preprod: once a minute there (a step is due at most every few hours).
            pollMs: BLOCKFROST[network] ? 60_000 : undefined,
            settlementSecret: settlement.sk,
            pure: v2Pure(v2.G),
            schedule,
            finalDraw: () => existsSync(lastDraw),
            logger: session.logger,
            onView,
            // The big proofs (the numbers, settlement batches) run in the background, one at a time.
            background: ['compute', 'settle'],
            backgroundLimit: 1,
            backgroundGapMs: 30_000,
          });
          keeper.start();
          session.logger.info(
            `Starfall v2 keeper running for ${record.contractAddress} (Treasury ${record.treasuryAddress}; ` +
              `${values.every ? `draws every ${values.every} s` : 'daily draws, 20:00 Brisbane'}${feedPath ? `; feed ${feedPath}` : ''}). ` +
              `To wind it down, create ${lastDraw}.`,
          );
          return serve(session, wallet, keeper, 'keeper', values, meter, stuck);
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, proofServerPort(values['proof-server-port']), undefined, { service: true });
    }

    case 'oracle': {
      const network = networkArg(values.network);
      if (!values.oracle) throw new Error(STARFALL_V2_USAGE);
      const { sk, pk } = oracleKeyFrom(values.oracle, true);
      const { record, v2 } = await deployment(network, values.record, true);
      if (pk.x.toString() !== record.parameters.oracleKey.x || pk.y.toString() !== record.parameters.oracleKey.y) {
        throw new Error(`${values.oracle} is not this deployment's oracle key`);
      }
      const dustMinutes = dustWait(values['dust-wait']);
      return withSession(network, async (session) => {
        const wallet = await openServiceWallet(session, walletSeed(values.wallet), dustMinutes);
        if (!wallet) return RESTART;
        try {
          const meter = new DustMeter(values.status ? `${values.status}.fees.json` : undefined);
          const raw = await starfallV2Providers(session, wallet, v2, record.treasuryAddress);
          const { providers, stuck } = freshFees(raw, wallet, session.logger, meter);
          const view = starfallV2ViewOf(v2.G, await readV2Ledger(v2.G, providers.publicDataProvider, record.contractAddress));
          if (!view.oracleKeyReady) throw new Error('the oracle key is not active yet (the deployment accepts it)');
          const base = { oracleSecretKey: sk };
          const joined = await joinStarfallV2(providers, v2, record.contractAddress, base);
          const chain = new MidnightStarfallV2Chain(v2, joined, providers.publicDataProvider, providers.privateStateProvider as never, record.contractAddress, base);
          // A draw needs its answer once a day: look once a minute where reads are metered (Blockfrost), every 5 s while one waits.
          const pollMs = BLOCKFROST[network] ? 60_000 : 5_000;
          const oracle = new DrawOracle({ chain, publicKey: pk, logger: session.logger, pollMs, busyPollMs: 5_000 });
          oracle.start();
          session.logger.info(`Starfall v2 draw oracle running for ${record.contractAddress}; looking every ${pollMs / 1000} s.`);
          return serve(session, wallet, oracle, 'oracle', values, meter, stuck);
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, proofServerPort(values['proof-server-port']), undefined, { service: true });
    }

    case 'status': {
      const network = networkArg(values.network);
      const { record, v2 } = await deployment(network, values.record, false);
      const view = starfallV2ViewOf(v2.G, await readV2Ledger(v2.G, publicDataFor(network) as never, record.contractAddress));
      process.stdout.write(`Starfall v2 (${record.mode}) on ${network} at ${record.contractAddress}, Treasury ${record.treasuryAddress}\n`);
      process.stdout.write(describeV2(view, Date.now() / 1000, v2.G.pureCircuits.batchSize()) + '\n');
      if (woundDown(view) && view.ended) process.stdout.write('Wound down: nothing is left to do on this deployment.\n');
      return 0;
    }

    default:
      process.stdout.write(STARFALL_V2_USAGE + '\n');
      return command === 'help' || command === undefined ? 0 : 1;
  }
};
