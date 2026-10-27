/**
 * `./lunardraw starfall ...`: run the Starfall settlement contract
 * (docs/SETTLEMENT.md) on Midnight. The same files as the v0 commands
 * (organiser, oracle, wallet), plus a settlement key that tickets are
 * encrypted to.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { quickPick, Starfall } from '@lunardraw/contract';
import { buildStarfallFeed, DerivedSeeds, DrawOracle, every, STARFALL_WEEKLY, StarfallKeeper, type StarfallView, writeFeed } from '@lunardraw/keeper';
import { compilerInfo, localFingerprints, NETWORKS, walletAddress, walletBalances } from '@nightcast/deploy';
import { openWallet } from './wallet-lock.js';
import {
  fromHex,
  hex,
  iso,
  networkArg,
  oracleKeyFrom,
  organiserSecretFrom,
  proofServerPort,
  publicDataFor,
  readKeyFile,
  RESTART,
  restartAfter,
  stallAfter,
  untilFailingFor,
  untilStopped,
  walletSeed,
  withSession,
} from './common.js';
import { type Check, currentCommit, formatChecks } from './deployment.js';
import {
  acceptStarfallOracleKey,
  buyGames,
  BuyStopped,
  deployStarfall,
  joinStarfall,
  MidnightStarfallChain,
  readStarfallLedger,
  readStarfallRecord,
  readStarfallView,
  STARFALL_WEEKLY_DEFAULTS,
  type StarfallDeployParams,
  starfallProviders,
  starfallRecordParameters,
  starfallZkConfigPath,
  verifyStarfall,
  writeStarfallRecord,
} from './starfall.js';
import { caughtUp, watchSync } from './sync-watch.js';

export const STARFALL_USAGE = `usage: ./lunardraw starfall <command>
  keygen settlement --out <file>
  commitment   --organiser <file>      (an organiser's Starfall commitment: public; for --backup)
  deploy       --network <${NETWORKS.join('|')}> --organiser <file> --backup <file> --oracle <file> --settlement <file> --wallet <file> [--accept]
               [--operator <address>] [--price <STAR>] [--fee <STAR>] [--min-sales <s>] [--max-sales <s>] [--reveal <s>] [--draw <s>] [--settle <s>]
  accept-key   --network <network> --oracle <file> --wallet <file>
  keeper       --network <network> --organiser <file> --settlement <file> --wallet <file> [--every <seconds>] [--feed <file>]
               [--proof-server-port <port>] [--prove-lead <secs>] [--restart-after <min>] [--stall-after <min>]
  oracle       --network <network> --oracle <file> --wallet <file> [--proof-server-port <port>] [--restart-after <min>] [--stall-after <min>]
  buy          --network <network> --wallet <file> [--games <n> | --package <${Object.keys(Starfall.QUICK_PICK_PACKAGES).join('|')}>] [--pay-to <address>]
               [--proof-server-port <port>]
  status       --network <network>
  verify       --network <network>
  fingerprints

Defaults are a weekly Starfall: a game costs 1.2 tNIGHT (1 to the prize pool, 0.2 to the operator),
draws close on Thursdays at 20:00 Brisbane, sales of 1 to 14 days, 1 hour to reveal, 2 hours for
the oracle, 2 days to settle once the numbers are in. --every <seconds> runs draws on a fixed period
instead (for test networks).

The settlement key (keygen settlement) decrypts every ticket so the keeper can settle the draw:
keep its file private, like the organiser's. Its public half goes into the contract at deploy.
--backup takes the backup organiser's secret file, or its Starfall commitment (64 hex characters, from
\`./lunardraw starfall commitment --organiser <file>\` run where the backup's secret is), so its secret can
stay offline. Starfall's commitments differ from v0's: a v0 deployment record's backupCommitment won't do. --operator is where the 0.2 tNIGHT fee per game goes (default:
the deploying wallet).
The keeper works out each draw's seed from the organiser secret, so there is no seeds file.
buy picks random games (QuickPick) for the draw on sale, paid to --pay-to (default: your wallet),
with refunds to your wallet if the draw is cancelled; it sends up to 2 games per transaction.`;

const SETTLEMENT = 'settlement';

/**
 * Starfall's organiser commitment for a secret. Not v0's: the two contracts
 * hash the secret with different domain tags ("starfall:organiser:v1" vs
 * v0's), so the same secret gives different commitments. (The first Starfall
 * deploy on Preprod used v0's by mistake, and its organiser couldn't open a
 * draw.)
 */
export const starfallOrganiserCommitment = (secret: Uint8Array): Uint8Array => Starfall.pureCircuits.organiserCommitmentOf(secret);

/**
 * The backup organiser's Starfall commitment: from its file (which must hold
 * the secret: a public commitment in an organiser file is v0's), or given as
 * 64 hex characters as printed by `./lunardraw starfall commitment`.
 */
const backupCommitmentFrom = (value: string): Uint8Array => {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return fromHex(value);
  const f = readKeyFile(value, 'organiser');
  if (!f.secret) {
    throw new Error(
      `${value} holds only a public commitment, which is v0's. On the machine with the backup's secret file, run ` +
        '`./lunardraw starfall commitment --organiser <backup file>` and give the 64 characters it prints as --backup.',
    );
  }
  return starfallOrganiserCommitment(fromHex(f.secret));
};

/** The settlement key file: the secret scalar (decimal) and its public point. */
const settlementFrom = (path: string, needSecret: boolean): { pk: { x: bigint; y: bigint }; sk?: bigint } => {
  const f = readKeyFile(path, SETTLEMENT);
  if (f.secret) {
    const sk = BigInt(f.secret);
    return { pk: Starfall.pureCircuits.settlementPublicKey(sk), sk };
  }
  if (needSecret) throw new Error(`${path} has no secret`);
  const pub = f.public as { x: string; y: string };
  return { pk: { x: BigInt(pub.x), y: BigInt(pub.y) } };
};

/** Whether this organiser secret is the one the contract accepts (what `requestDraw` checks). */
export const organiserCheck = (l: Starfall.Ledger, secret: Uint8Array): Check => {
  const mine = hex(starfallOrganiserCommitment(secret));
  const ok = hex(l.organiser) === mine;
  return {
    name: 'the organiser secret can open draws',
    ok,
    detail: ok ? 'its Starfall commitment is the contract\'s organiser' : `the contract's organiser is ${hex(l.organiser)}, this secret's Starfall commitment is ${mine}`,
  };
};

/** A 32-byte unshielded address from `mn_addr...` or 64 hex characters. */
export const parseUserAddress = (s: string): Uint8Array => {
  const h = s.replace(/^0x/, '');
  if (/^[0-9a-fA-F]{64}$/.test(h)) return fromHex(h);
  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(s);
  } catch (err) {
    throw new Error(`${s} is not an address (mn_addr_... or 64 hex characters): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.type !== 'addr' || parsed.data.length !== 32) throw new Error(`${s} is not an unshielded wallet address (mn_addr_...)`);
  return Uint8Array.from(parsed.data);
};

const walletBytes = (wallet: { unshieldedKeystore: { getAddress(): string } }): Uint8Array => fromHex(wallet.unshieldedKeystore.getAddress());

const STAGE = ['open', 'requested', 'fulfilled', 'drawn', 'settled', 'void'];
const tn = (star: bigint) => `${Number(star) / 1e6} tNIGHT`;

const describeView = (view: StarfallView, nowSecs: number): string => {
  const lines: string[] = [];
  if (!view.oracleKeyReady) lines.push('The oracle key is not active yet; no draw can open.');
  if (view.oracleKeyChange) {
    const c = view.oracleKeyChange;
    lines.push(`An oracle key change is pending: it can take effect ${c.approved ? 'now (approved by the current oracle)' : `from ${iso(c.at)}`}.`);
  }
  if (view.draws.length === 0) lines.push('No draws yet.');
  const batch = Starfall.pureCircuits.batchSize();
  for (const d of view.draws) {
    let stage = STAGE[d.status] ?? String(d.status);
    if (d.status === Starfall.DrawStatus.open && BigInt(Math.floor(nowSecs)) >= d.salesClose) stage = 'closed';
    let extra = '';
    if (d.status === Starfall.DrawStatus.drawn) {
      extra = `  settled ${d.settled}/${d.tickets} (batch ${d.settled / batch + (d.settled < d.tickets ? 1n : 0n)} of ${(d.tickets + batch - 1n) / batch}), deadline ${iso(d.settleDeadline)}`;
    } else if (d.status === Starfall.DrawStatus.settled) {
      const unpaid = view.entitlements.filter((e) => e.drawId === d.id && !e.paid).length;
      const won = d.winners.reduce((a, b) => a + b, 0n);
      extra = `  ${won} winning game(s)${unpaid > 0 ? `, ${unpaid} not paid yet` : ''}; fee ${tn(d.fee)}`;
    } else if (d.status === Starfall.DrawStatus.voided) {
      extra = d.unrefunded.length > 0 ? `  ${d.unrefunded.length} game(s) still to refund` : '  refunded';
    }
    const numbers = d.status === Starfall.DrawStatus.drawn || d.status === Starfall.DrawStatus.settled ? `  ${d.numbers.join(' ')} + ${d.moonball}` : '';
    lines.push(`draw ${d.id}  ${stage}  sales close ${iso(d.salesClose)}  ${d.tickets} game(s)${numbers}${extra}`);
  }
  lines.push(`Rollover into the next draw: ${tn(view.carry)}`);
  return lines.join('\n');
};

export const starfall = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      network: { type: 'string' },
      wallet: { type: 'string' },
      organiser: { type: 'string' },
      backup: { type: 'string' },
      oracle: { type: 'string' },
      settlement: { type: 'string' },
      out: { type: 'string' },
      every: { type: 'string' },
      feed: { type: 'string' },
      'proof-server-port': { type: 'string' },
      'restart-after': { type: 'string' },
      'stall-after': { type: 'string' },
      'prove-lead': { type: 'string' },
      accept: { type: 'boolean', default: false },
      operator: { type: 'string' },
      price: { type: 'string' },
      fee: { type: 'string' },
      'min-sales': { type: 'string' },
      'max-sales': { type: 'string' },
      reveal: { type: 'string' },
      draw: { type: 'string' },
      settle: { type: 'string' },
      games: { type: 'string' },
      package: { type: 'string' },
      'pay-to': { type: 'string' },
    },
  });

  switch (command) {
    case 'keygen': {
      if (positionals[0] !== SETTLEMENT || !values.out) throw new Error('usage: ./lunardraw starfall keygen settlement --out <file>');
      const sk = Starfall.randomScalar();
      const pk = Starfall.pureCircuits.settlementPublicKey(sk);
      const file = { role: SETTLEMENT, secret: sk.toString(), public: { x: pk.x.toString(), y: pk.y.toString() } };
      writeFileSync(values.out, JSON.stringify(file, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      process.stdout.write(`Settlement key written to ${values.out} (keep it private: it decrypts every ticket).\n`);
      return 0;
    }

    case 'commitment': {
      if (!values.organiser) throw new Error('usage: ./lunardraw starfall commitment --organiser <file>');
      const c = hex(starfallOrganiserCommitment(organiserSecretFrom(values.organiser)));
      process.stdout.write(`Starfall organiser commitment (public): ${c}\n`);
      return 0;
    }

    case 'fingerprints': {
      const dir = starfallZkConfigPath();
      process.stdout.write(JSON.stringify({ compiler: compilerInfo(dir), verifierKeys: localFingerprints(dir) }, null, 2) + '\n');
      return 0;
    }

    case 'deploy': {
      const network = networkArg(values.network);
      if (!values.organiser || !values.backup || !values.oracle || !values.settlement) throw new Error(STARFALL_USAGE);
      const oracle = oracleKeyFrom(values.oracle, values.accept);
      const num = (v: string | undefined, d: bigint) => (v === undefined ? d : BigInt(v));
      const organiserSecret = organiserSecretFrom(values.organiser);
      const organiserCommitment = starfallOrganiserCommitment(organiserSecret);
      const backupCommitment = backupCommitmentFrom(values.backup);
      if (hex(organiserCommitment) === hex(backupCommitment)) throw new Error('--backup must be a different organiser from --organiser');
      const settlement = settlementFrom(values.settlement, false);
      const dir = starfallZkConfigPath();
      const fingerprints = localFingerprints(dir);
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const params: StarfallDeployParams = {
            oraclePublicKey: oracle.pk,
            organiserCommitment,
            backupCommitment,
            settlementKey: settlement.pk,
            operator: values.operator ? parseUserAddress(values.operator) : walletBytes(wallet),
            feePerGame: num(values.fee, STARFALL_WEEKLY_DEFAULTS.feePerGame),
            ticketPrice: num(values.price, STARFALL_WEEKLY_DEFAULTS.ticketPrice),
            minSales: num(values['min-sales'], STARFALL_WEEKLY_DEFAULTS.minSales),
            maxSales: num(values['max-sales'], STARFALL_WEEKLY_DEFAULTS.maxSales),
            revealWindow: num(values.reveal, STARFALL_WEEKLY_DEFAULTS.revealWindow),
            drawWindow: num(values.draw, STARFALL_WEEKLY_DEFAULTS.drawWindow),
            settleWindow: num(values.settle, STARFALL_WEEKLY_DEFAULTS.settleWindow),
          };
          const providers = starfallProviders(session, wallet);
          session.logger.info('Deploying Starfall, locked from the start (nobody can ever change its code)...');
          const deployed = await deployStarfall(providers, params);
          session.logger.info(`Deployed at ${deployed.contractAddress} (tx ${deployed.txId})`);
          let acceptTx: string | undefined;
          if (values.accept && oracle.sk !== undefined) {
            session.logger.info('Activating the oracle key...');
            acceptTx = (await acceptStarfallOracleKey(providers, deployed.contractAddress, oracle.sk)).txId;
          }
          const path = writeStarfallRecord({
            contract: 'starfall',
            network,
            contractAddress: deployed.contractAddress,
            deployedAt: new Date().toISOString(),
            sourceCommit: currentCommit(),
            compiler: compilerInfo(dir),
            parameters: starfallRecordParameters(params),
            transactions: { deploy: deployed.txId, acceptOracleKey: acceptTx },
            verifierKeys: fingerprints,
          });
          process.stdout.write(`\nDeployment record written to ${path}\n`);
          const state = await providers.publicDataProvider.queryContractState(deployed.contractAddress);
          const checks = [...verifyStarfall(readStarfallRecord(network), state, fingerprints), organiserCheck(Starfall.ledger(state!.data), organiserSecret)];
          process.stdout.write(`${formatChecks(checks)}\n`);
          if (!acceptTx) process.stdout.write(`\nNext, the oracle activates its key: ./lunardraw starfall accept-key --network ${network} --oracle <file> --wallet <file>\n`);
          return checks.every((c) => c.ok || c.name === 'oracle key accepted') ? 0 : 1;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'accept-key': {
      const network = networkArg(values.network);
      if (!values.oracle) throw new Error(STARFALL_USAGE);
      const { sk } = oracleKeyFrom(values.oracle, true);
      const record = readStarfallRecord(network);
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const { txId } = await acceptStarfallOracleKey(starfallProviders(session, wallet), record.contractAddress, sk!);
          session.logger.info(`Oracle key active (tx ${txId})`);
          writeStarfallRecord({ ...record, transactions: { ...record.transactions, acceptOracleKey: txId } });
          return 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'keeper': {
      const network = networkArg(values.network);
      if (!values.organiser || !values.settlement) throw new Error(STARFALL_USAGE);
      const organiserSecret = organiserSecretFrom(values.organiser);
      const settlement = settlementFrom(values.settlement, true);
      const record = readStarfallRecord(network);
      if (hex(starfallOrganiserCommitment(organiserSecret)) !== record.parameters.organiserCommitment) {
        throw new Error(`${values.organiser} is not this deployment's organiser`);
      }
      if (settlement.pk.x.toString() !== record.parameters.settlementKey.x || settlement.pk.y.toString() !== record.parameters.settlementKey.y) {
        throw new Error(`${values.settlement} is not this deployment's settlement key`);
      }
      const schedule = values.every ? every(Number(values.every)) : STARFALL_WEEKLY;
      const seeds = new DerivedSeeds(organiserSecret, encodeContractAddress(record.contractAddress));
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const providers = starfallProviders(session, wallet);
          // The contract is the judge: its stored organiser must be this secret's Starfall commitment.
          const opens = organiserCheck(await readStarfallLedger(providers.publicDataProvider, record.contractAddress), organiserSecret);
          if (!opens.ok) throw new Error(`${values.organiser} can't run this deployment: ${opens.detail}`);
          const base = { organiserSecret };
          const joined = await joinStarfall(providers, record.contractAddress, base);
          const lead = values['prove-lead'] === undefined ? undefined : Number(values['prove-lead']);
          const chain = new MidnightStarfallChain(joined, providers.publicDataProvider, providers.privateStateProvider, record.contractAddress, base, lead);
          const feedPath = values.feed;
          const onView = feedPath
            ? (view: StarfallView, nowSecs: number) => writeFeed(feedPath, buildStarfallFeed(view, { network, contract: record.contractAddress, nowSecs }))
            : undefined;
          // The numbers and the settlement batches are the big proofs (about
          // 7 GB each on the proof server): run them in the background so
          // reveals and new draws never wait for them, one at a time, with a
          // pause after each so the proof server can be restarted to free its
          // memory (see proof-server.ts).
          const keeper = new StarfallKeeper({
            chain,
            seeds,
            settlementSecret: settlement.sk,
            schedule,
            logger: session.logger,
            onView,
            background: ['compute', 'settle'],
            backgroundLimit: 1,
            backgroundGapMs: 30_000,
          });
          keeper.start();
          session.logger.info(
            `Starfall keeper running for ${record.contractAddress} (${values.every ? `draws every ${values.every} s` : 'weekly Starfall'}` +
              `${feedPath ? `; site feed written to ${feedPath}` : ''}). Press Ctrl+C to stop.`,
          );
          const watchdog = untilFailingFor(restartAfter(values['restart-after']), () => keeper.status().streak, session.logger);
          const sync = watchSync(wallet, { stallMinutes: stallAfter(values['stall-after']), logger: session.logger });
          const restart = await Promise.race([untilStopped().then(() => false), watchdog.done, sync.stalled]);
          watchdog.cancel();
          sync.stop();
          session.logger.info('Stopping the keeper...');
          await keeper.stop();
          return restart ? RESTART : 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, proofServerPort(values['proof-server-port']));
    }

    case 'oracle': {
      const network = networkArg(values.network);
      if (!values.oracle) throw new Error(STARFALL_USAGE);
      const { sk, pk } = oracleKeyFrom(values.oracle, true);
      const record = readStarfallRecord(network);
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const providers = starfallProviders(session, wallet);
          const view = await readStarfallView(providers.publicDataProvider, record.contractAddress);
          if (!view.oracleKeyReady) throw new Error('the oracle key is not active yet: run `./lunardraw starfall accept-key` first');
          const joined = await joinStarfall(providers, record.contractAddress, { oracleSecretKey: sk });
          const chain = new MidnightStarfallChain(joined, providers.publicDataProvider, providers.privateStateProvider, record.contractAddress);
          const oracle = new DrawOracle({ chain, publicKey: pk, logger: session.logger });
          oracle.start();
          session.logger.info(`Starfall draw oracle running for ${record.contractAddress}. Press Ctrl+C to stop.`);
          const watchdog = untilFailingFor(restartAfter(values['restart-after']), () => oracle.status().streak, session.logger);
          const sync = watchSync(wallet, { stallMinutes: stallAfter(values['stall-after']), logger: session.logger });
          const restart = await Promise.race([untilStopped().then(() => false), watchdog.done, sync.stalled]);
          watchdog.cancel();
          sync.stop();
          session.logger.info('Stopping the oracle...');
          await oracle.stop();
          return restart ? RESTART : 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, proofServerPort(values['proof-server-port']));
    }

    case 'buy': {
      const network = networkArg(values.network);
      const record = readStarfallRecord(network);
      const packages = Starfall.QUICK_PICK_PACKAGES as Record<string, number>;
      if (values.package !== undefined && values.games !== undefined) throw new Error('give --games or --package, not both');
      const count = values.package !== undefined ? packages[values.package] : Number(values.games ?? '1');
      if (count === undefined) throw new Error(`--package must be one of ${Object.keys(packages).join(', ')}`);
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('--games must be 1 to 1000');
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const providers = starfallProviders(session, wallet);
          const view = await readStarfallView(providers.publicDataProvider, record.contractAddress);
          const now = BigInt(Math.floor(Date.now() / 1000));
          const selling = view.draws.find((d) => d.status === Starfall.DrawStatus.open && d.salesClose > now + 120n);
          if (!selling) throw new Error('no draw is on sale right now (or sales close in under 2 minutes): try again when the next one opens');
          const cost = view.ticketPrice * BigInt(count);
          const { night } = await walletBalances(wallet);
          if (night < cost) throw new Error(`${count} game(s) cost ${tn(cost)} but the wallet holds ${tn(night)}`);
          const mine = walletBytes(wallet);
          const payTo = values['pay-to'] ? parseUserAddress(values['pay-to']) : mine;
          const games = Array.from({ length: count }, () => Starfall.makeTicket(selling.id, quickPick(), payTo));
          const joined = await joinStarfall(providers, record.contractAddress, {});
          session.logger.info(
            `Buying ${count} QuickPick game(s) for draw ${selling.id} (sales close ${iso(selling.salesClose)}) for ${tn(cost)}, ` +
              `${Math.ceil(count / Number(Starfall.pureCircuits.maxGames()))} transaction(s), from ${walletAddress(wallet)}...`,
          );
          const listing = (n: number) =>
            games
              .slice(0, n)
              .map((g, i) => `  game ${i + 1}: ${g.line.numbers.join(' ')} + ${g.line.moonball}`)
              .join('\n');
          try {
            await buyGames(joined, providers.privateStateProvider, record.contractAddress, games, mine, {
              onEach: (done, of) => session.logger.info(`bought ${done} of ${of}`),
              stopAt: Number(selling.salesClose) - 60,
              catchUp: () => caughtUp(wallet.wallet.state()),
              onRetry: (done, of) =>
                session.logger.warn(
                  `The node refused purchase ${done / Number(Starfall.pureCircuits.maxGames()) + 1} (Custom error 170: the wallet's coins were out of date). ` +
                    `Waiting for the wallet to catch up, then trying it once more (${done} of ${of} bought so far)...`,
                ),
              onChain: async (part) => {
                const ledger = await readStarfallLedger(providers.publicDataProvider, record.contractAddress);
                const deployment = { bytes: encodeContractAddress(record.contractAddress) };
                return part.map((g) => ledger.ticketCommitments.member(Starfall.pureCircuits.ticketCommitment(deployment, g)));
              },
            });
          } catch (err) {
            if (!(err instanceof BuyStopped)) throw err;
            process.stdout.write(
              `Stopped after ${err.bought} of ${err.of} game(s): ${err.message}.\n` +
                (err.bought > 0 ? `These ${err.bought} are bought for draw ${selling.id} (paid to ${hex(payTo)}):\n${listing(err.bought)}\n` : '') +
                `Check with \`./lunardraw starfall status --network ${network}\`, then run buy again with --games ${err.of - err.bought} for the rest.\n`,
            );
            return 1;
          }
          process.stdout.write(
            `Bought ${count} game(s) for draw ${selling.id}. Winnings are paid automatically to ${hex(payTo)}; ` +
              `if the draw is cancelled, refunds go to this wallet.\n${listing(count)}\n`,
          );
          return 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      }, proofServerPort(values['proof-server-port']));
    }

    case 'status': {
      const network = networkArg(values.network);
      const record = readStarfallRecord(network);
      const view = await readStarfallView(publicDataFor(network), record.contractAddress);
      process.stdout.write(`Starfall on ${network} at ${record.contractAddress}\n${describeView(view, Date.now() / 1000)}\n`);
      return 0;
    }

    case 'verify': {
      const network = networkArg(values.network);
      const record = readStarfallRecord(network);
      const state = await publicDataFor(network).queryContractState(record.contractAddress);
      let local;
      try {
        local = localFingerprints(starfallZkConfigPath());
      } catch {
        local = undefined;
      }
      const checks = verifyStarfall(record, state, local);
      process.stdout.write(`Starfall on ${network} at ${record.contractAddress}\n${formatChecks(checks)}\n`);
      return checks.every((c) => c.ok) ? 0 : 1;
    }

    default:
      process.stdout.write(STARFALL_USAGE + '\n');
      return command && command !== 'help' ? 1 : 0;
  }
};
