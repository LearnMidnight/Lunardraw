#!/usr/bin/env node
/**
 * Run Lunardraw on Midnight.
 *
 *   ./lunardraw keygen organiser --out <file>        (also for the backup organiser)
 *   ./lunardraw deploy     --network <n> --organiser <file> --backup <file> --oracle <file> --wallet <file> [--accept] [parameters]
 *   ./lunardraw accept-key --network <n> --oracle <file> --wallet <file>
 *   ./lunardraw proof-server [--port 6300]
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
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { buildFeed, type ChainView, DrawOracle, every, FileSeedStore, Keeper, STARFALL_WEEKLY, writeFeed } from '@lunardraw/keeper';
import { oraclePublicKey, parseOracleSecretKey } from '@nightcast/contract';
import {
  BLOCKFROST,
  blockfrostProjectId,
  compilerInfo,
  connect,
  createLogger,
  isNetwork,
  localFingerprints,
  type Network,
  NETWORKS,
  openWallet,
  publicEndpoints,
  type Session,
  walletAddress,
  walletBalances,
} from '@nightcast/deploy';
import { joinLunardraw, lunardrawProviders, MidnightLunardrawChain, readView, zkConfigPath } from './contract.js';
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
  ./lunardraw proof-server [--port 6300]
  ./lunardraw keeper       --network <network> --organiser <file> --wallet <file> [--seeds <file>] [--every <seconds>] [--feed <file>] [--proof-server-port <port>] [--prove-lead <secs>]
  ./lunardraw oracle       --network <network> --oracle <oracle secret file> --wallet <file> [--proof-server-port <port>]
  ./lunardraw status       --network <network>
  ./lunardraw verify       --network <network>
  ./lunardraw fingerprints

Defaults are a weekly Starfall: draws close on Thursdays at 20:00 Brisbane (10:00 UTC),
1 tNIGHT a line, sales of 1 to 14 days, 1 hour to reveal, 2 hours for the oracle, 2 days
to claim. --every <seconds> runs draws on a fixed period instead (for test networks).

--oracle and --wallet take Nightcast's files (nightcast/nightcast keygen oracle, wallet new).
The keeper keeps its sealed seeds in --seeds (default ~/lunardraw-secrets/seeds-<network>.json):
back it up, keep it private. Run the oracle on a different machine from the keeper.
On one PC, run \`./lunardraw proof-server\` once and give the keeper and the oracle --proof-server-port 6300,
so they share it (each would otherwise start its own). --prove-lead <secs> (default 240) is how far ahead
the keeper stamps the numbers proof's clock, since proving takes minutes and the contract allows 10 either way.
--feed <file> makes the keeper write the site feed (lunardraw-feed/1 JSON) there after every pass.
--backup is a second organiser file (keygen organiser) whose holder can replace the organiser
if its secret is lost or leaked: keep it offline. Its file may hold only the public commitment.`;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
/** The same image Nightcast's compose files use (Midnight's support matrix, October 2026). */
const PROOF_SERVER_IMAGE = 'midnightntwrk/proof-server:8.1.3';
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const iso = (secs: bigint) => new Date(Number(secs) * 1000).toISOString();

type KeyFile = { role: string; secret?: string; public?: unknown; seed?: string };
const readKeyFile = (path: string, role: string): KeyFile => {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
  if (parsed.role !== role) throw new Error(`${path} is a ${parsed.role} file, expected ${role}`);
  return parsed;
};

const organiserSecretFrom = (path: string): Uint8Array => {
  const f = readKeyFile(path, 'organiser');
  if (!f.secret) throw new Error(`${path} has no secret`);
  return fromHex(f.secret);
};

/**
 * The backup organiser's commitment. Its file may hold only the `public`
 * commitment (the secret stays offline); with a secret, the commitment is
 * recomputed from it.
 */
const organiserCommitmentFrom = (path: string): Uint8Array => {
  const f = readKeyFile(path, 'organiser');
  if (f.secret) return organiserCommitmentOf(fromHex(f.secret));
  if (typeof f.public !== 'string') throw new Error(`${path} has neither a secret nor a public commitment`);
  return fromHex(f.public);
};

const oracleKeyFrom = (path: string, needSecret: boolean): { pk: { x: bigint; y: bigint }; sk?: bigint } => {
  const f = readKeyFile(path, 'oracle');
  if (f.secret) {
    const sk = parseOracleSecretKey(f.secret);
    return { pk: oraclePublicKey(sk), sk };
  }
  if (needSecret) throw new Error(`${path} has no secret`);
  const pub = f.public as { x: string; y: string };
  return { pk: { x: BigInt(pub.x), y: BigInt(pub.y) } };
};

const walletSeed = (path: string | undefined): string | undefined => {
  if (!path) return process.env.NIGHTCAST_WALLET_SEED;
  const f = readKeyFile(path, 'wallet');
  if (!f.seed) throw new Error(`${path} has no seed`);
  return f.seed;
};

/** A proof server already running (`./lunardraw proof-server`), instead of starting one. */
const proofServerPort = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) throw new Error('--proof-server-port must be a port number');
  return port;
};

const networkArg = (value: string | undefined): Network => {
  if (!value || !isNetwork(value)) throw new Error(`--network must be one of ${NETWORKS.join(', ')}`);
  return value;
};

const withSession = async <T>(network: Network, run: (s: Session) => Promise<T>, proofServerPort?: number): Promise<T> => {
  const projectId = BLOCKFROST[network] ? blockfrostProjectId(network) : undefined;
  const session = await connect(network, { projectId, proofServerPort });
  try {
    return await run(session);
  } finally {
    await session.shutdown().catch((e) => session.logger.warn(`shutdown: ${e}`));
  }
};

const publicDataFor = (network: Network) => {
  if (network === 'local') throw new Error('this command on `local` must run in the same session as the deploy');
  const config = publicEndpoints(network, createLogger('warn'), BLOCKFROST[network] ? blockfrostProjectId(network) : undefined);
  setNetworkId(config.networkId);
  return indexerPublicDataProvider(config.indexer, config.indexerWS);
};

const localFingerprintsOrNone = () => {
  try {
    return localFingerprints(zkConfigPath());
  } catch {
    return undefined;
  }
};

/** Run until Ctrl+C (or SIGTERM, as Docker sends). */
const untilStopped = () =>
  new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

const STATUS = ['open', 'requested', 'fulfilled', 'drawn', 'settled', 'voided'];

const main = async (argv: string[]): Promise<number> => {
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
      out: { type: 'string' },
      seeds: { type: 'string' },
      every: { type: 'string' },
      feed: { type: 'string' },
      'proof-server-port': { type: 'string' },
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
      // One proof server for the keeper and the oracle to share (each would
      // otherwise start its own, about 1 GB each at peak). Listens on this
      // machine only. Runs until Ctrl+C.
      const port = values.port ?? '6300';
      if (!/^\d+$/.test(port)) throw new Error('--port must be a number');
      process.stdout.write(`Proof server on 127.0.0.1:${port}. Give the keeper and the oracle --proof-server-port ${port}. Press Ctrl+C to stop.\n`);
      const { spawn } = await import('node:child_process');
      const child = spawn(
        'docker',
        ['run', '--rm', '--name', `lunardraw-proof-server-${port}`, '-p', `127.0.0.1:${port}:6300`, PROOF_SERVER_IMAGE, 'midnight-proof-server'],
        { stdio: 'inherit' },
      );
      const stop = () => child.kill('SIGINT');
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return new Promise<number>((res) => child.on('exit', (code) => res(code ?? 0)));
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
          const keeper = new Keeper({ chain, seeds, schedule, logger: session.logger, onView });
          keeper.start();
          session.logger.info(
            `Keeper running for ${record.contractAddress} (${values.every ? `draws every ${values.every} s` : 'weekly Starfall'}; seeds in ${seeds.path}` +
              `${feedPath ? `; site feed written to ${feedPath}` : ''}). Press Ctrl+C to stop.`,
          );
          await untilStopped();
          session.logger.info('Stopping the keeper...');
          await keeper.stop();
          return 0;
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
          await untilStopped();
          session.logger.info('Stopping the oracle...');
          await oracle.stop();
          return 0;
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

