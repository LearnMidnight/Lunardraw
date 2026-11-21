/**
 * `./lunardraw starfall-v2 ...`: the keeper and the draw oracle of a Starfall v2 deployment
 * (starfall-v2/, docs/ADAPTIVE.md), and its status. They are Starfall's keeper and oracle
 * (the same steps; v2 adds paying syndicate members and refunding syndicates) on the v2
 * chain adapter (starfall-v2.ts).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { DerivedSeeds, DrawOracle, every, PurchaseLog, STARFALL_DAILY, StarfallKeeper, type StarfallView, StepTimes, writeFeed, buildStarfallFeed, woundDown } from '@lunardraw/keeper';
import { BLOCKFROST, type Session } from '@nightcast/deploy';
import {
  forceExit,
  hex,
  indexerUrlsFor,
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
import { freshFees, openServiceWallet, parseUserAddress, settlementFrom } from './starfall-commands.js';
import { describeStep, loadPlayerState, nextStep, savePlayerState, stepDone, ticketsFor } from './starfall-v2-player.js';
import { loadV2AgentState, MAX_ROUNDS, parseV2Lines, planV2, savedTicketOf, type SavedV2Ticket, saveV2AgentState, ticketGames, type V2AgentOptions, type V2Draw, type V2Style, V2_STYLES } from './starfall-v2-agent.js';
import { proverArg } from './buyer.js';
import { fromHex } from './common.js';
import { walletBalances } from '@nightcast/deploy';
import {
  joinStarfallV2,
  loadStarfallV2,
  MidnightStarfallV2Chain,
  readStarfallV2Record,
  readV2Ledger,
  type StarfallV2,
  type StarfallV2Record,
  starfallV2Out,
  starfallV2HostedProviders,
  starfallV2Providers,
  starfallV2ViewOf,
  v2LedgerOf,
  v2Pure,
} from './starfall-v2.js';
import { watchSync } from './sync-watch.js';
import { backfillJson, contractActions, contractStateOf, indexerGql, indexerSubscribe, named, namingLike, txIdsByDraw } from './tx-backfill.js';

export const STARFALL_V2_USAGE = `usage: ./lunardraw starfall-v2 <command>

  keeper  --network <network> --organiser <file> --settlement <file> [--wallet <file>]
          [--every <seconds>] [--feed <file>] [--status <file>] [--record <file>] [--proof-server-port <port>]
      Runs the draws: opens each, reveals its seed after sales close (opening the next), computes the
      numbers, settles, finalises (the Treasury tops up the next jackpot in the same transaction),
      pays every prize and syndicate member, voids a stuck draw and refunds it. Draws close daily at
      20:00 Brisbane, or every --every seconds (a rehearsal).
  oracle  --network <network> --oracle <file> [--wallet <file>] [--status <file>] [--record <file>] [--proof-server-port <port>]
      Answers each draw with Nightcast's VRF.
  player  --network <network> --wallet <file> --name <name> [--games 4] [--members "<mn_addr...>,<mn_addr...>,..."]
          [--syndicate-games 3] [--record <file>] [--proof-server-port <port>]
      A rehearsal player: in each draw on sale, one ticket of --games QuickPick games for itself and,
      with --members, a syndicate of one share per member (paid to that address) and its games.
  agent   --network <network> --wallet <file> --name <name> [--style quickpick|lucky|moonhit|system|mix]
          [--games 2] [--lines "3,11,17,23,26,30,34+7;..."] [--rounds <n>] [--budget <tNIGHT>] [--max-draws <n>]
          [--record <file>] [--proof-server-port <port> | --prover hosted|<url>] [--state <file>]
      A house agent on v2: buys once a draw in its style, in the draw's own format (lucky sets that
      don't fit its range are folded into it), --rounds purchases' worth in one go, at most --budget
      (default 60) a draw; prizes and refunds come to its wallet by themselves. State in
      ~/lunardraw-agents/<name>.v2-agent.json (or --state). --prover proves its purchases with
      Lunardraw's player prover (or another), so it needs no proof server or proving keys.
  accept-key  --network <network> --oracle <file> [--wallet <file>] [--record <file>] [--proof-server-port <port>]
      The oracle accepts the key the deployment proposed (once, before the first draw): needs the oracle's secret.
  status  --network <network> [--record <file>]
  backfill-tx  --network <network> --feed <file> [--record <file>]
      The transaction ids of draws from before the keeper kept them, read back from the indexer into
      <file>.backfill.json, which the keeper's feed merges in (the site's verification links to them).

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
      name: { type: 'string' },
      games: { type: 'string' },
      members: { type: 'string' },
      'syndicate-games': { type: 'string' },
      style: { type: 'string' },
      lines: { type: 'string' },
      budget: { type: 'string' },
      rounds: { type: 'string' },
      'max-draws': { type: 'string' },
      prover: { type: 'string' },
      state: { type: 'string' },
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
          // As Starfall's keeper: when each draw's steps happened and their transactions (kept beside the
          // feed across restarts, with older draws' ids from `starfall-v2 backfill-tx`), so the site's
          // verification can link the draw's record and its settlement; and the recent purchases.
          const stepTimes = feedPath ? new StepTimes(`${feedPath}.steps.json`, 60, `${feedPath}.backfill.json`) : undefined;
          const purchases = feedPath ? new PurchaseLog(`${feedPath}.purchases.json`) : undefined;
          const onView = feedPath
            ? (view: StarfallView, nowSecs: number) => {
                stepTimes!.observe(view, nowSecs);
                purchases!.observe(view, nowSecs);
                writeFeed(feedPath, buildStarfallFeed(view, { network, contract: record.contractAddress, nowSecs, steps: stepTimes!.lookup(), purchases: purchases!.recent(20) }));
              }
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
            // each step's transaction id, for the feed's tx (the site's verification links to them)
            onTx: stepTimes ? (draw, step, txId) => stepTimes.noteTx(draw, step, txId) : undefined,
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
          return await serve(session, wallet, keeper, 'keeper', values, meter, stuck);
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, proofServerPort(values['proof-server-port']), undefined, { service: true });
    }

    case 'backfill-tx': {
      // As `starfall backfill-tx`, with the v2 ledger: every action on the game, oldest first, each
      // call that moved a draw matched to the draws whose status it changed.
      const network = networkArg(values.network);
      if (!values.feed) throw new Error(STARFALL_V2_USAGE);
      const { record, v2 } = await deployment(network, values.record, false);
      const urls = indexerUrlsFor(network);
      const gql = indexerGql(urls.http);
      process.stdout.write(`Reading every action on ${record.contractAddress} from the indexer, oldest first...\n`);
      const actions = await contractActions(gql, indexerSubscribe(urls.ws), record.contractAddress, {
        onResume: (height, attempt, why) => process.stdout.write(`  ${why}; reconnecting and carrying on from block ${height} (${attempt} of 8)\n`),
        onAction: (a, n) => {
          if (n % 200 === 0) process.stdout.write(`  ${n} actions so far, at block ${a.height}\n`);
        },
      });
      const own: Record<string, { tx?: Record<string, string> }> = existsSync(`${values.feed}.steps.json`)
        ? JSON.parse(readFileSync(`${values.feed}.steps.json`, 'utf8'))
        : {};
      const known = new Set(Object.values(own).flatMap((r) => Object.values(r.tx ?? {})));
      const { naming, matched } = namingLike(actions, known);
      if (known.size && !matched) {
        process.stdout.write(`None of the indexer's names for these transactions matches the keeper's own records, so nothing was written.\n`);
        return 1;
      }
      process.stdout.write(
        known.size
          ? `Naming transactions by their ${naming.label}, as the keeper does (${matched} of its ${known.size} records found).\n`
          : `The keeper has no records to compare yet: naming transactions by their ${naming.label}.\n`,
      );
      const decode = (state: string): StarfallView =>
        starfallV2ViewOf(v2.G, v2LedgerOf(v2.G, contractStateOf(Buffer.from(state.toLowerCase().replace(/^0x/, ''), 'hex')) as never));
      const ids = txIdsByDraw(named(actions, naming), decode);
      let agree = 0;
      const differ: string[] = [];
      for (const [d, r] of Object.entries(own)) {
        for (const [k, v] of Object.entries(r.tx ?? {})) {
          const b = (ids.get(BigInt(d)) as Record<string, string> | undefined)?.[k];
          if (!b) continue;
          if (b === v) agree++;
          else differ.push(`draw ${d} ${k}: keeper ${v.slice(0, 14)}…, indexer ${b.slice(0, 14)}…`);
        }
      }
      process.stdout.write(`Checked against the keeper's records: ${agree} agree, ${differ.length} differ${differ.length ? ` (${differ.slice(0, 5).join('; ')})` : ''}.\n`);
      if (differ.length) {
        process.stdout.write('Nothing was written: the two should name the same transactions.\n');
        return 1;
      }
      const out = `${values.feed}.backfill.json`;
      writeFileSync(out, backfillJson(ids));
      const steps = [...ids.values()].reduce((n, r) => n + Object.keys(r).length, 0);
      process.stdout.write(`${actions.length} actions; ${steps} step transactions for ${ids.size} draws written to ${out}\n`);
      for (const [id, r] of [...ids.entries()].slice(-3)) process.stdout.write(`  draw ${id}: ${JSON.stringify(r)}\n`);
      process.stdout.write('The keeper picks it up on its next pass (no restart needed).\n');
      return 0;
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
          return await serve(session, wallet, oracle, 'oracle', values, meter, stuck);
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, proofServerPort(values['proof-server-port']), undefined, { service: true });
    }

    case 'player': {
      const network = networkArg(values.network);
      const name = (values.name ?? '').replace(/[^A-Za-z0-9_-]/g, '');
      if (!name || !values.wallet) throw new Error(STARFALL_V2_USAGE);
      const { record, v2 } = await deployment(network, values.record, true);
      const opts = {
        games: values.games === undefined ? 4 : Number(values.games),
        members: values.members ? values.members.split(/[\s,]+/).filter((x) => x !== '').map(parseUserAddress) : [],
        syndicateGames: values['syndicate-games'] === undefined ? 3 : Number(values['syndicate-games']),
      };
      if (!(Number.isInteger(opts.games) && opts.games >= 1 && opts.games <= 12)) throw new Error('--games takes 1 to 12 (one ticket)');
      if (!(Number.isInteger(opts.syndicateGames) && opts.syndicateGames >= 1 && opts.syndicateGames <= 12)) throw new Error('--syndicate-games takes 1 to 12');
      const statePath = join(homedir(), 'lunardraw-agents', `${name}.v2-state.json`);
      const dustMinutes = dustWait(values['dust-wait']);
      return withSession(network, async (session) => {
        const wallet = await openServiceWallet(session, walletSeed(values.wallet), dustMinutes);
        if (!wallet) return RESTART;
        try {
          const meter = new DustMeter(undefined);
          const raw = await starfallV2Providers(session, wallet, v2, record.treasuryAddress);
          const { providers } = freshFees(raw, wallet, session.logger, meter);
          const state = loadPlayerState(statePath, record.contractAddress);
          savePlayerState(statePath, state);
          const secret = fromHex(state.syndicateSecret);
          const joined = await joinStarfallV2(providers, v2, record.contractAddress, { syndicateSecret: secret });
          const store = (providers.privateStateProvider as never as { forContract(a: string): { set(id: string, s: unknown): Promise<void> } }).forContract(record.contractAddress);
          const me = fromHex(wallet.unshieldedKeystore.getAddress());
          const log = (m: string) => session.logger.info(`[${name}] ${m}`);
          log(`playing Starfall v2 at ${record.contractAddress}: ${opts.games} game(s) a draw${opts.members.length ? `, and a syndicate of ${opts.members.length} share(s) for ${opts.syndicateGames} game(s)` : ''}; state in ${statePath}`);
          let stop = false;
          const stopped = untilStopped().then(() => { stop = true; });
          const sync = watchSync(wallet, { stallMinutes: stallAfter(values['stall-after']), logger: session.logger });
          let lastPassAt = Date.now();
          const silence = untilSilentFor(silentAfter(values['silent-after']), () => lastPassAt, session.logger);
          let restart = false;
          void Promise.race([sync.stalled, silence.done]).then((fired) => { if (fired && !stop) { restart = true; stop = true; forceExit(RESTART); } });
          let refusals = 0;
          let waitUntil = 0;
          // The wallet's NIGHT can read 0 after one of its own transactions, while the change it is
          // owed hasn't reached its live view (seen on the rehearsal after a sync hiccup, for hours).
          let spentThisRun = false;
          let lowReads = 0;
          while (!stop) {
            try {
              const view = starfallV2ViewOf(v2.G, await readV2Ledger(v2.G, providers.publicDataProvider, record.contractAddress));
              const step = Date.now() >= waitUntil ? nextStep(view, Date.now() / 1000, state, opts) : null;
              if (step) {
                const d = view.draws.find((x) => x.id === step.draw)!;
                const format = d.format ?? { range: 20, moonballs: 1 };
                const cost = step.kind === 'buy' ? view.ticketPrice * BigInt(step.games) : step.kind === 'join' ? (view.ticketPrice * BigInt(opts.syndicateGames)) / BigInt(opts.members.length) : 0n;
                const { night } = await walletBalances(wallet);
                if (night < cost) {
                  lowReads += 1;
                  if (spentThisRun && lowReads >= 3) {
                    session.logger.error(`[${name}] the wallet has shown ${tn(night)} 3 times since its last transaction: restarting to resync it`);
                    restart = true;
                    break;
                  }
                  log(`can't ${describeStep(step)}: it costs ${tn(cost)}, the wallet holds ${tn(night)}${spentThisRun ? ' (looking again in 2 minutes: change from its last transaction may not have arrived)' : ''}`);
                  waitUntil = Date.now() + (spentThisRun ? 2 : 30) * 60_000;
                } else {
                  lowReads = 0;
                  log(`${describeStep(step)}...`);
                  const started = Date.now();
                  const tickets = ticketsFor(v2.G, step, format, me);
                  await store.set('starfall-v2', { syndicateSecret: secret, pendingTickets: tickets });
                  let syndicateId: bigint | undefined;
                  if (step.kind === 'buy') await joined.callTx.buyTickets(BigInt(tickets.length), { bytes: me });
                  else if (step.kind === 'create') {
                    const r = await joined.callTx.createSyndicate(step.draw, v2.G.pureCircuits.syndicateCommitmentOf(secret), step.sharePrice, BigInt(step.shares), BigInt(step.games), step.joinDeadline);
                    const res = r.private?.result;
                    if (typeof res === 'bigint' || typeof res === 'number') syndicateId = BigInt(res);
                    else {
                      // the newest syndicate of this creator in the draw
                      const l = await readV2Ledger(v2.G, providers.publicDataProvider, record.contractAddress);
                      const mine = hex(v2.G.pureCircuits.syndicateCommitmentOf(secret));
                      for (const [id, sy] of l.syndicates as Iterable<[bigint, { drawId: bigint; creator: Uint8Array }]>) {
                        if (sy.drawId === step.draw && hex(sy.creator) === mine && (syndicateId === undefined || id > syndicateId)) syndicateId = id;
                      }
                      if (syndicateId === undefined) throw new Error('the syndicate was created but its id was not found');
                    }
                  } else if (step.kind === 'join') await joined.callTx.joinSyndicate(step.syndicate, 1n, { bytes: opts.members[step.member]! });
                  else await joined.callTx.buySyndicateTickets(step.syndicate, BigInt(tickets.length));
                  stepDone(state, step, syndicateId);
                  savePlayerState(statePath, state);
                  refusals = 0;
                  spentThisRun = true;
                  log(`done in ${Math.round((Date.now() - started) / 1000)} s${syndicateId !== undefined ? `: syndicate ${syndicateId}` : ''}${tickets.length ? `: ${tickets.map((t) => (t as { entry: { numbers: bigint[] } }).entry.numbers.slice(0, 7).join(' ')).join('; ')}${tickets.length && (tickets[0] as { lines: { moonball: bigint }[] }).lines[0]!.moonball ? ' (+ more lines)' : ''}` : ''}`);
                }
              }
            } catch (err) {
              refusals += 1;
              session.logger.warn(`[${name}] ${err instanceof Error ? err.message.slice(0, 600) : String(err)} (${refusals} in a row; trying again in 3 minutes)`);
              waitUntil = Date.now() + 3 * 60_000;
              if (refusals >= 3) {
                session.logger.error(`[${name}] 3 failures in a row: restarting to resync the wallet`);
                restart = true;
                break;
              }
            }
            lastPassAt = Date.now();
            await Promise.race([new Promise((r) => setTimeout(r, 60_000)), stopped]);
          }
          sync.stop();
          silence.cancel();
          if (restart) forceExit(RESTART);
          return restart ? RESTART : 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, proofServerPort(values['proof-server-port']), undefined, { service: true });
    }

    case 'agent': {
      const network = networkArg(values.network);
      const name = (values.name ?? '').replace(/[^A-Za-z0-9_-]/g, '');
      if (!name || !values.wallet) throw new Error(STARFALL_V2_USAGE);
      const style = (values.style ?? 'mix') as V2Style;
      if (!V2_STYLES.includes(style)) throw new Error(`--style must be one of ${V2_STYLES.join(', ')}`);
      const opts: V2AgentOptions = {
        name,
        style,
        games: values.games !== undefined ? Number(values.games) : undefined,
        lines: values.lines !== undefined ? parseV2Lines(values.lines) : undefined,
        rounds: values.rounds !== undefined ? Number(values.rounds) : undefined,
        budget: values.budget !== undefined ? BigInt(Math.round(Number(values.budget) * 1e6)) : undefined,
        maxDraws: values['max-draws'] !== undefined ? Number(values['max-draws']) : 0,
      };
      if (opts.rounds !== undefined && !(Number.isInteger(opts.rounds) && opts.rounds >= 1 && opts.rounds <= MAX_ROUNDS)) throw new Error(`--rounds takes 1 to ${MAX_ROUNDS}`);
      if (opts.games !== undefined && !(Number.isInteger(opts.games) && opts.games >= 1 && opts.games <= 18)) throw new Error('--games takes 1 to 18');
      if (style === 'lucky' && !opts.lines?.length) throw new Error('--style lucky needs --lines "3,11,17,23,26,30,34+7;..."');
      if (opts.lines && style !== 'lucky') throw new Error('--lines goes with --style lucky');
      const { record, v2 } = await deployment(network, values.record, false);
      const statePath = values.state ?? join(homedir(), 'lunardraw-agents', `${name}.v2-agent.json`);
      // --prover: prove through Lunardraw's player prover (`hosted`) or another, with no proof server or proving keys here
      const prover = proverArg(values.prover);
      const dustMinutes = dustWait(values['dust-wait']);
      return withSession(network, async (session) => {
        const wallet = await openServiceWallet(session, walletSeed(values.wallet), dustMinutes);
        if (!wallet) return RESTART;
        try {
          const meter = new DustMeter(undefined);
          const raw = prover
            ? starfallV2HostedProviders(session, wallet, v2, record.treasuryAddress, prover, {
                onWait: (status, secs) => session.logger.info(`[${name}] the prover is ${status === 429 ? 'limiting this address' : 'busy'}; trying again in ${secs} s`),
              })
            : await starfallV2Providers(session, wallet, v2, record.treasuryAddress);
          const { providers } = freshFees(raw, wallet, session.logger, meter);
          const joined = await joinStarfallV2(providers, v2, record.contractAddress, {});
          const store = (providers.privateStateProvider as never as { forContract(a: string): { set(id: string, s: unknown): Promise<void> } }).forContract(record.contractAddress);
          const me = fromHex(wallet.unshieldedKeystore.getAddress());
          const game = { bytes: fromHex(record.contractAddress) };
          const state = loadV2AgentState(statePath, record.contractAddress);
          saveV2AgentState(statePath, state);
          const log = (m: string) => session.logger.info(`[${name}] ${m}`);
          log(`playing Starfall v2 at ${record.contractAddress} in the ${style} style${opts.rounds ? `, ${opts.rounds} rounds a purchase` : ''}; ${new Set(state.purchases.map((p) => p.draw)).size} draw(s) played so far; state in ${statePath}`);
          let stop = false;
          const stopped = untilStopped().then(() => { stop = true; });
          const sync = watchSync(wallet, { stallMinutes: stallAfter(values['stall-after']), logger: session.logger });
          let lastPassAt = Date.now();
          const silence = untilSilentFor(silentAfter(values['silent-after']), () => lastPassAt, session.logger);
          let restart = false;
          void Promise.race([sync.stalled, silence.done]).then((fired) => { if (fired && !stop) { restart = true; stop = true; forceExit(RESTART); } });
          let refusals = 0;
          let waitUntil = 0;
          let sittingOut = '';
          while (!stop) {
            try {
              const l = await readV2Ledger(v2.G, providers.publicDataProvider, record.contractAddress);
              const view = starfallV2ViewOf(v2.G, l);
              // the draws this agent played that have been settled or cancelled since
              for (const d of view.draws) {
                const key = d.id.toString();
                if (!state.purchases.some((p) => p.draw === key) || state.reported.includes(key) || (d.status !== 4 && d.status !== 5)) continue;
                log(d.status === 4 ? `draw ${key}: ${d.numbers.join(' ')}${d.format && d.format.moonballs > 1 ? ` + ${d.moonball}` : ''}; any prize is paid to this wallet by itself` : `draw ${key} was cancelled: its games are refunded to this wallet`);
                state.reported.push(key);
                saveV2AgentState(statePath, state);
              }
              const draws: V2Draw[] = view.draws.map((d) => {
                const r = l.draws.lookup(d.id);
                return { id: d.id, status: d.status, salesClose: d.salesClose, format: { range: Number(r.format.range), moonballs: Number(r.format.moonballs), pick5: BigInt(r.format.pick5) } };
              });
              const plan = Date.now() >= waitUntil ? planV2(v2.G, draws, view.ticketPrice, Date.now() / 1000, state, opts, me) : null;
              if (plan && 'skipped' in plan) {
                if (plan.draw.toString() !== sittingOut) log(`sitting out draw ${plan.draw}: ${plan.skipped}`);
                sittingOut = plan.draw.toString();
                if (opts.maxDraws && new Set(state.purchases.map((p) => p.draw)).size >= opts.maxDraws) break;
              } else if (plan) {
                const { night } = await walletBalances(wallet);
                if (night < plan.cost) {
                  if (plan.draw.toString() !== sittingOut) log(`sitting out draw ${plan.draw} for now: ${plan.games} game(s) cost ${tn(plan.cost)}, the wallet holds ${tn(night)}`);
                  sittingOut = plan.draw.toString();
                  waitUntil = Date.now() + 10 * 60_000;
                } else {
                  const f = plan.format;
                  log(`draw ${plan.draw} (7 from ${f.range}${f.moonballs > 1 ? ` + Moonball 1-${f.moonballs}` : ''}, sales close ${iso(plan.salesClose)}): buying ${plan.games} game(s) for ${tn(plan.cost)} in ${plan.txs.length} transaction(s)`);
                  const landed = async (t: unknown): Promise<boolean> => {
                    const now = await readV2Ledger(v2.G, providers.publicDataProvider, record.contractAddress);
                    return now.ticketCommitments.member(v2.G.pureCircuits.ticketCommitment(game, t));
                  };
                  let done = 0;
                  let games = 0;
                  const numbers: number[][] = [];
                  const saved: SavedV2Ticket[] = [];
                  for (const tickets of plan.txs) {
                    if (Date.now() / 1000 > Number(plan.salesClose) - 120) { log('sales close too soon for the rest'); break; }
                    await store.set('starfall-v2', { pendingTickets: tickets });
                    try {
                      await joined.callTx.buyTickets(BigInt(tickets.length), { bytes: me });
                    } catch (err) {
                      // a purchase that timed out may still have landed: never buy the same games twice
                      if (!(await landed(tickets[0]).catch(() => false))) {
                        if (done === 0) throw err;
                        log(`stopped after ${done} of ${plan.txs.length} transaction(s): ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
                        break;
                      }
                    }
                    done += 1;
                    for (const t of tickets) {
                      games += ticketGames(v2.G, t, f);
                      const tt = t as { entry: { numbers: bigint[]; count: bigint } };
                      numbers.push(tt.entry.numbers.slice(0, Number(tt.entry.count)).map(Number));
                      saved.push(savedTicketOf(t));
                    }
                    if (plan.txs.length > 1) log(`transaction ${done} of ${plan.txs.length} landed`);
                  }
                  if (done > 0) {
                    state.purchases.push({ draw: plan.draw.toString(), at: new Date().toISOString(), games, cost: (view.ticketPrice * BigInt(games)).toString(), txs: done, numbers, tickets: saved });
                    saveV2AgentState(statePath, state);
                    log(`in draw ${plan.draw} with ${games} game(s) in ${done} transaction(s)`);
                  }
                  refusals = 0;
                }
              }
            } catch (err) {
              refusals += 1;
              session.logger.warn(`[${name}] ${err instanceof Error ? err.message.slice(0, 600) : String(err)} (${refusals} in a row; trying again in 3 minutes)`);
              waitUntil = Date.now() + 3 * 60_000;
              if (refusals >= 3) {
                session.logger.error(`[${name}] 3 failures in a row: restarting to resync the wallet`);
                restart = true;
                break;
              }
            }
            lastPassAt = Date.now();
            await Promise.race([new Promise((r) => setTimeout(r, 60_000)), stopped]);
          }
          sync.stop();
          silence.cancel();
          if (restart) forceExit(RESTART);
          return restart ? RESTART : 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, prover ? undefined : proofServerPort(values['proof-server-port']), prover, { service: true });
    }

    case 'accept-key': {
      const network = networkArg(values.network);
      if (!values.oracle) throw new Error(STARFALL_V2_USAGE);
      const { sk, pk } = oracleKeyFrom(values.oracle, true);
      const { record, v2 } = await deployment(network, values.record, true);
      if (pk.x.toString() !== record.parameters.oracleKey.x || pk.y.toString() !== record.parameters.oracleKey.y) {
        throw new Error(`${values.oracle} is not this deployment's oracle key`);
      }
      return withSession(network, async (session) => {
        const wallet = await openServiceWallet(session, walletSeed(values.wallet), dustWait(values['dust-wait']));
        if (!wallet) return RESTART;
        try {
          const raw = await starfallV2Providers(session, wallet, v2, record.treasuryAddress);
          const { providers } = freshFees(raw, wallet, session.logger, new DustMeter(undefined));
          const before = await readV2Ledger(v2.G, providers.publicDataProvider, record.contractAddress);
          if (before.oracleKeyReady && !before.proposedOracleKey.is_some) {
            process.stdout.write('The oracle key is already accepted: nothing to do.\n');
            return 0;
          }
          const p = before.proposedOracleKey;
          if (!p.is_some || p.value.x !== pk.x || p.value.y !== pk.y) throw new Error('the deployment has not proposed this oracle key');
          const joined = await joinStarfallV2(providers, v2, record.contractAddress, { oracleSecretKey: sk });
          const r = (await joined.callTx.acceptOracleKey()) as { public?: { txId?: string } };
          for (let i = 0; i < 36; i++) {
            const l = await readV2Ledger(v2.G, providers.publicDataProvider, record.contractAddress);
            if (l.oracleKeyReady && !l.proposedOracleKey.is_some) {
              process.stdout.write(`The oracle key is accepted (transaction ${r.public?.txId ?? '?'}): the keeper can open draw 1.\n`);
              return 0;
            }
            await new Promise((res) => setTimeout(res, 5_000));
          }
          throw new Error('acceptOracleKey was sent, but the chain did not show the key accepted within 3 minutes: check with status');
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, proofServerPort(values['proof-server-port']));
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
