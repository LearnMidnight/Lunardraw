#!/usr/bin/env node
/**
 * Run Lunardraw on Midnight.
 *
 *   ./lunardraw keygen organiser --out <file>        (also for the backup organiser)
 *   ./lunardraw deploy     --network <n> --organiser <file> --backup <file> --oracle <file> --wallet <file> [--accept] [parameters]
 *   ./lunardraw accept-key --network <n> --oracle <file> --wallet <file>
 *   ./lunardraw proof-server [--port 6300] [--memory-limit <MiB>] [--memory-limit 3072]
 *   ./lunardraw keeper     --network <n> --organiser <file> --wallet <file> [--seeds <file>] [--every <seconds>] [--feed <file>] [--proof-server-port <port>] [--prove-lead <secs>]
 *   ./lunardraw oracle     --network <n> --oracle <file> --wallet <file> [--proof-server-port <port>]
 *   ./lunardraw status     --network <n>
 *   ./lunardraw verify     --network <n>
 *   ./lunardraw fingerprints
 *
 * Wallets, oracle keys and Blockfrost project ids are the same files as
 * Nightcast's (`nightcast/nightcast wallet new`, `keygen oracle`, `blockfrost
 * save`). The organiser secret is the keeper's; keep it, and the seeds file,
 * private and backed up.
 */
// First, so nothing can print a Blockfrost project id or an unreadable wallet error.
import '@nightcast/deploy/redact-output';
import '@nightcast/deploy/explain-errors';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildFeed, type ChainView, DrawOracle, every, FileSeedStore, Keeper, STARFALL_WEEKLY, writeFeed } from '@lunardraw/keeper';
import { compilerInfo, localFingerprints, NETWORKS, walletAddress, walletBalances } from '@nightcast/deploy';
import { openWallet } from './wallet-lock.js';
import {
  hex,
  iso,
  localFingerprintsOrNone,
  networkArg,
  oracleKeyFrom,
  organiserCommitmentFrom,
  organiserSecretFrom,
  proofServerPort,
  publicDataFor,
  RESTART,
  restartAfter,
  stallAfter,
  untilFailingFor,
  untilStopped,
  walletSeed,
  withSession,
} from './common.js';
import { joinLunardraw, lunardrawProviders, MidnightLunardrawChain, readView, zkConfigPath } from './contract.js';
import { PARAMS_VOLUME, ProofServer } from './proof-server.js';
import { starfall } from './starfall-commands.js';
import { watchSync } from './sync-watch.js';
import {
  acceptOracleKey,
  currentCommit,
  deployLunardraw,
  type DeployParams,
  formatChecks,
  organiserCommitmentOf,
  readRecord,
  recordParameters,
  verifyDeployment,
  WEEKLY_DEFAULTS,
  writeRecord,
} from './deployment.js';

const USAGE = `usage:
  ./lunardraw keygen organiser --out <file>
  ./lunardraw wallet show  --network <network> --wallet <file>
  ./lunardraw deploy       --network <${NETWORKS.join('|')}> --organiser <file> --backup <file> --oracle <file> --wallet <file> [--accept]
                           [--price <STAR>] [--min-sales <s>] [--max-sales <s>] [--reveal <s>] [--draw <s>] [--claim <s>]
  ./lunardraw accept-key   --network <network> --oracle <oracle secret file> --wallet <file>
  ./lunardraw proof-server [--port 6300] [--memory-limit <MiB>]
  ./lunardraw keeper       --network <network> --organiser <file> --wallet <file> [--seeds <file>] [--every <seconds>] [--feed <file>] [--proof-server-port <port>] [--prove-lead <secs>]
  ./lunardraw oracle       --network <network> --oracle <oracle secret file> --wallet <file> [--proof-server-port <port>]
  ./lunardraw status       --network <network>
  ./lunardraw verify       --network <network>
  ./lunardraw fingerprints
  ./lunardraw starfall ...   (the Starfall settlement contract: ./lunardraw starfall help)

These commands run the v0 test contract. Defaults are a weekly Starfall: draws close on Thursdays at 20:00 Brisbane (10:00 UTC),
1 tNIGHT a line, sales of 1 to 14 days, 1 hour to reveal, 2 hours for the oracle, 2 days
to claim. --every <seconds> runs draws on a fixed period instead (for test networks).

--oracle and --wallet take Nightcast's files (nightcast/nightcast keygen oracle, wallet new).
The keeper keeps its sealed seeds in --seeds (default ~/lunardraw-secrets/seeds-<network>.json):
back it up, keep it private. Run the oracle on a different machine from the keeper.
On one PC, run \`./lunardraw proof-server\` once and give the keeper and the oracle --proof-server-port 6300,
so they share it (each would otherwise start its own). --prove-lead <secs> (default 240) is how far ahead
the keeper stamps the numbers proof's clock, since proving takes minutes and the contract allows 10 either way.
--restart-after <minutes> (default 3, 0 = off): if the keeper's or the oracle's transactions keep
failing for that long with nothing succeeding (a stale wallet sync does that), it exits with code 75
so its service manager starts it again with a fresh sync. --stall-after <minutes> (default 15, 0 = off):
the same when the wallet's sync positions haven't moved for that long. See deploy/systemd/.
--feed <file> makes the keeper write the site feed (lunardraw-feed/1 JSON) there after every pass.
--backup is a second organiser file (keygen organiser) whose holder can replace the organiser
if its secret is lost or leaked: keep it offline. Its file may hold only the public commitment.`;

const STATUS = ['open', 'requested', 'fulfilled', 'drawn', 'settled', 'voided'];

const main = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  if (command === 'starfall') return starfall(rest);
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
      out: { type: 'string' },
      seeds: { type: 'string' },
      every: { type: 'string' },
      feed: { type: 'string' },
      'proof-server-port': { type: 'string' },
      'memory-limit': { type: 'string' },
      'restart-after': { type: 'string' },
      'stall-after': { type: 'string' },
      'prove-lead': { type: 'string' },
      port: { type: 'string' },
      accept: { type: 'boolean', default: false },
      price: { type: 'string' },
      'min-sales': { type: 'string' },
      'max-sales': { type: 'string' },
      reveal: { type: 'string' },
      draw: { type: 'string' },
      claim: { type: 'string' },
    },
  });

  switch (command) {
    case 'keygen': {
      if (positionals[0] !== 'organiser' || !values.out) throw new Error('usage: ./lunardraw keygen organiser --out <file>');
      const secret = Uint8Array.from(randomBytes(32));
      const file = { role: 'organiser', secret: hex(secret), public: hex(organiserCommitmentOf(secret)) };
      writeFileSync(values.out, JSON.stringify(file, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      process.stdout.write(`Organiser secret written to ${values.out} (keep it private; it runs the draws).\nOrganiser commitment: ${file.public}\n`);
      return 0;
    }

    case 'proof-server': {
      const port = Number(values.port ?? '6300');
      if (!Number.isInteger(port) || port <= 0) throw new Error('--port must be a port number');
      const limit = Number(values['memory-limit'] ?? '3072');
      if (!(limit > 0)) throw new Error('--memory-limit must be a number of MiB');
      process.stdout.write(
        `Proof server on 127.0.0.1:${port}. Give the keeper and the oracle --proof-server-port ${port}.\n` +
          `It restarts itself when idle above ${limit} MiB, keeps its zk parameters in the Docker volume ${PARAMS_VOLUME}. Press Ctrl+C to stop.\n`,
      );
      const server = new ProofServer({ port, memoryLimitMiB: limit, log: (m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`) });
      process.on('SIGINT', () => server.stop());
      process.on('SIGTERM', () => server.stop());
      await server.run();
      return 0;
    }

    case 'fingerprints': {
      const dir = zkConfigPath();
      process.stdout.write(JSON.stringify({ compiler: compilerInfo(dir), verifierKeys: localFingerprints(dir) }, null, 2) + '\n');
      return 0;
    }

    case 'wallet': {
      if (positionals[0] !== 'show') throw new Error(USAGE);
      const network = networkArg(values.network);
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const { night, dust } = await walletBalances(wallet);
          process.stdout.write(`Wallet ${walletAddress(wallet)}\nNIGHT: ${Number(night) / 1e6}\nDUST:  ${dust}\n`);
          return 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'deploy': {
      const network = networkArg(values.network);
      if (!values.organiser || !values.backup || !values.oracle) throw new Error(USAGE);
      const oracle = oracleKeyFrom(values.oracle, values.accept);
      const num = (v: string | undefined, d: bigint) => (v === undefined ? d : BigInt(v));
      const organiserCommitment = organiserCommitmentOf(organiserSecretFrom(values.organiser));
      const backupCommitment = organiserCommitmentFrom(values.backup);
      if (hex(organiserCommitment) === hex(backupCommitment)) throw new Error('--backup must be a different organiser file from --organiser');
      const params: DeployParams = {
        oraclePublicKey: oracle.pk,
        organiserCommitment,
        backupCommitment,
        linePrice: num(values.price, WEEKLY_DEFAULTS.linePrice),
        minSales: num(values['min-sales'], WEEKLY_DEFAULTS.minSales),
        maxSales: num(values['max-sales'], WEEKLY_DEFAULTS.maxSales),
        revealWindow: num(values.reveal, WEEKLY_DEFAULTS.revealWindow),
        drawWindow: num(values.draw, WEEKLY_DEFAULTS.drawWindow),
        claimWindow: num(values.claim, WEEKLY_DEFAULTS.claimWindow),
      };
      const dir = zkConfigPath();
      const fingerprints = localFingerprints(dir);
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const providers = lunardrawProviders(session, wallet);
          session.logger.info('Deploying Lunardraw, locked from the start (nobody can ever change its code)...');
          const deployed = await deployLunardraw(providers, params);
          session.logger.info(`Deployed at ${deployed.contractAddress} (tx ${deployed.txId})`);
          let acceptTx: string | undefined;
          if (values.accept && oracle.sk !== undefined) {
            session.logger.info('Activating the oracle key...');
            acceptTx = (await acceptOracleKey(providers, deployed.contractAddress, oracle.sk)).txId;
          }
          const path = writeRecord({
            network,
            contractAddress: deployed.contractAddress,
            deployedAt: new Date().toISOString(),
            sourceCommit: currentCommit(),
            compiler: compilerInfo(dir),
            parameters: recordParameters(params),
            transactions: { deploy: deployed.txId, acceptOracleKey: acceptTx },
            verifierKeys: fingerprints,
          });
          process.stdout.write(`\nDeployment record written to ${path}\n`);
          const state = await providers.publicDataProvider.queryContractState(deployed.contractAddress);
          const checks = verifyDeployment(readRecord(network), state, fingerprints);
          process.stdout.write(`${formatChecks(checks)}\n`);
          if (!acceptTx) process.stdout.write(`\nNext, the oracle activates its key: ./lunardraw accept-key --network ${network} --oracle <oracle secret file> --wallet <file>\n`);
          return checks.every((c) => c.ok || c.name === 'oracle key accepted') ? 0 : 1;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'accept-key': {
      const network = networkArg(values.network);
      if (!values.oracle) throw new Error(USAGE);
      const { sk } = oracleKeyFrom(values.oracle, true);
      const record = readRecord(network);
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const providers = lunardrawProviders(session, wallet);
          const { txId } = await acceptOracleKey(providers, record.contractAddress, sk!);
          session.logger.info(`Oracle key active (tx ${txId})`);
          writeRecord({ ...record, transactions: { ...record.transactions, acceptOracleKey: txId } });
          return 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'keeper': {
      const network = networkArg(values.network);
      if (!values.organiser) throw new Error(USAGE);
      const organiserSecret = organiserSecretFrom(values.organiser);
      const record = readRecord(network);
      if (hex(organiserCommitmentOf(organiserSecret)) !== record.parameters.organiserCommitment) {
        throw new Error(`${values.organiser} is not this deployment's organiser`);
      }
      const seeds = new FileSeedStore(values.seeds ?? join(homedir(), 'lunardraw-secrets', `seeds-${network}.json`));
      const schedule = values.every ? every(Number(values.every)) : STARFALL_WEEKLY;
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const providers = lunardrawProviders(session, wallet);
          const joined = await joinLunardraw(providers, record.contractAddress, { organiserSecret });
          const lead = values['prove-lead'] === undefined ? undefined : Number(values['prove-lead']);
          const chain = new MidnightLunardrawChain(joined, providers.publicDataProvider, record.contractAddress, lead);
          const feedPath = values.feed;
          const onView = feedPath
            ? (view: ChainView, nowSecs: number) => writeFeed(feedPath, buildFeed(view, { network, contract: record.contractAddress, nowSecs }))
            : undefined;
          // The numbers proof takes minutes on a small machine: run it in the
          // background so reveals and new draws never wait for it.
          const keeper = new Keeper({ chain, seeds, schedule, logger: session.logger, onView, background: ['compute'] });
          keeper.start();
          session.logger.info(
            `Keeper running for ${record.contractAddress} (${values.every ? `draws every ${values.every} s` : 'weekly Starfall'}; seeds in ${seeds.path}` +
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
      if (!values.oracle) throw new Error(USAGE);
      const { sk, pk } = oracleKeyFrom(values.oracle, true);
      const record = readRecord(network);
      return withSession(network, async (session) => {
        const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
        try {
          const providers = lunardrawProviders(session, wallet);
          const view = await readView(providers.publicDataProvider, record.contractAddress);
          if (!view.oracleKeyReady) throw new Error('the oracle key is not active yet: run `./lunardraw accept-key` first');
          const joined = await joinLunardraw(providers, record.contractAddress, { oracleSecretKey: sk });
          const chain = new MidnightLunardrawChain(joined, providers.publicDataProvider, record.contractAddress);
          const oracle = new DrawOracle({ chain, publicKey: pk, logger: session.logger });
          oracle.start();
          session.logger.info(`Draw oracle running for ${record.contractAddress}. Press Ctrl+C to stop.`);
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

    case 'status': {
      const network = networkArg(values.network);
      const record = readRecord(network);
      const view = await readView(publicDataFor(network), record.contractAddress);
      process.stdout.write(`Lunardraw on ${network} at ${record.contractAddress}\n`);
      if (!view.oracleKeyReady) process.stdout.write('The oracle key is not active yet; no draw can open.\n');
      if (view.oracleKeyChange) {
        const c = view.oracleKeyChange;
        process.stdout.write(`An oracle key change is pending: it can take effect ${c.approved ? 'now (approved by the current oracle)' : `from ${iso(c.at)}`}.\n`);
      }
      if (view.draws.length === 0) process.stdout.write('No draws yet.\n');
      for (const d of view.draws) {
        process.stdout.write(`draw ${d.id}  ${STATUS[d.status] ?? d.status}  sales close ${iso(d.salesClose)}\n`);
      }
      const unpaid = view.wins.filter((w) => !w.paid).length;
      if (unpaid > 0) process.stdout.write(`${unpaid} registered win(s) not paid yet\n`);
      return 0;
    }

    case 'verify': {
      const network = networkArg(values.network);
      const record = readRecord(network);
      const state = await publicDataFor(network).queryContractState(record.contractAddress);
      const checks = verifyDeployment(record, state, localFingerprintsOrNone());
      process.stdout.write(`Lunardraw on ${network} at ${record.contractAddress}\n${formatChecks(checks)}\n`);
      return checks.every((c) => c.ok) ? 0 : 1;
    }

    default:
      process.stdout.write(USAGE + '\n');
      return command ? 1 : 0;
  }
};

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);

