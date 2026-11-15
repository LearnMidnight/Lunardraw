#!/usr/bin/env node
/**
 * Ledger 9 probe for Starfall v2: can a contract be deployed with some of its circuits and get the
 * rest afterwards, then be locked? (Route B for syndicates, 15 Nov 2026.)
 *
 * The circuit probe found that one ledger 9 deploy carries 12 circuits of this size and refuses 15
 * ("Transaction would exhaust the block limits"). Starfall v2 with syndicates is about 18. Midnight
 * lets a contract's maintenance authority add verifier keys after the deploy, one maintenance
 * transaction at a time, so this probe:
 *
 *   1. deploys an 18-circuit contract (`wide-18`, each verifier key 2,121 bytes) with only its first
 *      12 circuits and a maintenance authority held by a fresh, single-use key;
 *   2. adds the other 6 verifier keys, one maintenance transaction each;
 *   3. calls one of the added circuits (c17), proved by the player proof server, to show it works;
 *   4. locks the contract: replaces the authority with an empty committee nobody can ever sign for,
 *      as Starfall's deploys do;
 *   5. reads the contract back: 18 circuits, authority locked.
 *
 *   node probe-upgrade.mjs run --wallet <agent>.secret [--proof-server-port 6301]
 *   node probe-upgrade.mjs offline     (no network: builds each step against a stand-in chain)
 *
 * Throwaway contract only; DUST for 1 deploy, 6 key insertions, 1 call and the lock; no tNIGHT.
 * The single-use key lives only in this process's memory and is useless once the lock lands.
 * Runs from a folder at the top of a built Lunardraw checkout (probe.sh puts it there), with
 * out/wide-18 next to it (verifier keys for all 18 circuits, the prover key for c17).
 */
import '@nightcast/deploy/explain-errors';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { webcrypto } from 'node:crypto';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import {
  createUnprovenDeployTx,
  createUnprovenCallTx,
  findDeployedContract,
  submitInsertVerifierKeyTx,
  submitTx,
} from '@midnight-ntwrk/midnight-js/contracts';
import { LedgerTransaction, SerializedContractState, SerializedZswapChainState, SerializedLedgerParameters } from '@midnight-ntwrk/midnight-js-types';
import { NodeZkConfigProvider, nodeZkConfigRegistry } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { inMemoryPrivateStateProvider } from '@midnight-ntwrk/testkit-js';
import {
  ContractState,
  ContractDeploy,
  ContractMaintenanceAuthority,
  ContractOperation,
  Intent,
  LedgerParameters,
  MaintenanceUpdate,
  ReplaceAuthority,
  Transaction,
  ZswapChainState,
  signData,
} from '@midnight-ntwrk/midnight-js-protocol/v9';
import { TX_TTL_SECONDS, walletAddress } from '@nightcast/deploy';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const cli = (m) => import(pathToFileURL(join(REPO, 'cli', 'dist', m)).href);
const OUT = join(HERE, 'out');
const NAME = 'wide-18';
const TOTAL = 18;
const FIRST = 12; // what one deploy carries (circuit probe, 14 Nov)
const CALL = 'c17'; // an added circuit, called after the insertions
const say = (m) => process.stdout.write(`${m}\n`);
const circuitName = (i) => `c${String(i).padStart(2, '0')}`;
const EARLY = Array.from({ length: FIRST }, (_, i) => circuitName(i));
const LATE = Array.from({ length: TOTAL - FIRST }, (_, i) => circuitName(FIRST + i));
const witnesses = { secret: ({ privateState }) => [privateState, new Uint8Array(32)] };

const errorText = (e) => {
  const parts = [];
  for (let x = e, i = 0; x && i < 6; x = x.cause, i++) parts.push(x instanceof Error ? `${x.name}: ${x.message}` : String(x));
  return parts.join(' <- ').replace(/\s+/g, ' ').slice(0, 1500);
};
const ttl = () => new Date(Date.now() + TX_TTL_SECONDS * 1000);
const opNames = (state) => state.operations().map((o) => (typeof o === 'string' ? o : Buffer.from(o).toString())).sort();

const compiled = async () => {
  const mod = await import(pathToFileURL(join(OUT, NAME, 'contract', 'index.js')).href);
  let c = CompiledContract.make(NAME, mod.Contract);
  c = CompiledContract.withWitnesses(c, witnesses);
  return CompiledContract.withCompiledFileAssets(c, join(OUT, NAME));
};

/**
 * The deploy, with only the first `FIRST` circuits. Runs the constructor as midnight-js does
 * (which also samples the single-use maintenance key and puts it in the authority), then rebuilds
 * the state with the same data, balance and authority and only the early operations.
 */
const trimmedDeploy = async (providers, contract, networkId) => {
  const built = await createUnprovenDeployTx(providers, { compiledContract: contract, privateStateId: NAME, initialPrivateState: {}, args: [] });
  if (built.public.initialContractState.era !== 'v9') throw new Error(`expected a ledger 9 deploy, got ${built.public.initialContractState.era}`);
  const full = ContractState.deserialize(built.public.initialContractState.serialize());
  const all = opNames(full);
  if (all.length !== TOTAL) throw new Error(`the compiled contract has ${all.length} circuits, expected ${TOTAL}`);
  const state = new ContractState();
  state.data = full.data;
  state.balance = full.balance;
  state.maintenanceAuthority = full.maintenanceAuthority;
  for (const op of EARLY) state.setOperation(op, full.operation(op));
  const deploy = new ContractDeploy(state);
  const tx = Transaction.fromParts(networkId, undefined, undefined, Intent.new(ttl()).addDeploy(deploy));
  return {
    deploy,
    address: String(deploy.address),
    signingKey: built.private.signingKey,
    unprovenTx: LedgerTransaction.seal('v9', 'Unproven', tx),
    authority: full.maintenanceAuthority,
  };
};

/** The lock: replace the authority with an empty committee (threshold 1: nobody can ever sign). */
const lockUpdate = (address, current, signingKey) => {
  const counter = current.counter;
  const locked = new ContractMaintenanceAuthority([], 1, counter + 1n);
  const update = new MaintenanceUpdate(address, [new ReplaceAuthority(locked)], counter);
  return update.addSignature(0n, signData(signingKey, update.dataToSign));
};
const isLocked = (a) => a.committee.length === 0 && a.threshold > a.committee.length;

// ------------------------------------------------------------------ offline
const offline = async () => {
  const states = new Map();
  const read = (address) => {
    const st = states.get(String(address));
    if (!st) return null;
    return {
      protocolVersion: 9,
      contractState: SerializedContractState.fromBytes('v9', st.serialize()),
      zswapChainState: SerializedZswapChainState.fromBytes('v9', new ZswapChainState().serialize()),
      ledgerParameters: SerializedLedgerParameters.fromBytes('v9', LedgerParameters.initialParameters().serialize()),
    };
  };
  const chain = {
    queryBlock: async () => ({ hash: '11'.repeat(32), height: 1, timestamp: Date.now() }),
    queryZSwapAndContractState: async (a) => read(a),
    queryContractState: async (a) => read(a),
    queryDeployContractState: async (a) => read(a),
  };
  const providers = {
    privateStateProvider: inMemoryPrivateStateProvider(),
    publicDataProvider: chain,
    walletProvider: { getCoinPublicKey: () => '0'.repeat(64), getEncryptionPublicKey: () => '0'.repeat(64) },
    config: { networkId: 'preprod', ttlSeconds: TX_TTL_SECONDS },
    zkConfigProvider: new NodeZkConfigProvider(join(OUT, NAME), { verify: 'require-if-present' }),
  };
  let failed = 0;
  const check = (name, cond, detail = '') => { if (!cond) failed++; say(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `  ${detail}`}`); };
  const W = await compiled();

  const d = await trimmedDeploy(providers, W, 'preprod');
  const deployed = d.deploy.initialState;
  check(`the deploy builds with ${FIRST} of ${TOTAL} circuits`, opNames(deployed).length === FIRST && opNames(deployed).join() === EARLY.join(), opNames(deployed).join());
  check('its authority is the single-use key, one signer, counter 0',
        d.authority.committee.length === 1 && d.authority.threshold === 1 && d.authority.counter === 0n, d.authority.toString());
  check('the deploy is a ledger 9 transaction', d.unprovenTx.era === 'v9');
  states.set(d.address, ContractState.deserialize(deployed.serialize()));

  let callRefused = '';
  try { await createUnprovenCallTx(providers, { compiledContract: W, contractAddress: d.address, circuitId: CALL, args: [new Uint8Array(32).fill(1)], privateStateId: NAME }); }
  catch (e) { callRefused = errorText(e); }
  check(`${CALL} can't be called before its key is added`, callRefused !== '', 'the call built');

  // Stand in for the insertions: put the late operations in the stand-in chain's state.
  const full = ContractState.deserialize((await createUnprovenDeployTx(providers, { compiledContract: W, privateStateId: NAME, initialPrivateState: {}, args: [] })).public.initialContractState.serialize());
  const st = states.get(d.address);
  for (const op of LATE) st.setOperation(op, full.operation(op));
  check(`after the insertions the contract has all ${TOTAL} circuits`, opNames(st).length === TOTAL);
  await providers.privateStateProvider.forContract?.(d.address)?.set?.(NAME, {});
  const call = await createUnprovenCallTx(providers, { compiledContract: W, contractAddress: d.address, circuitId: CALL, args: [new Uint8Array(32).fill(1)], privateStateId: NAME });
  check(`then ${CALL} builds as a ledger 9 call`, call.private?.unprovenTx?.era === 'v9');

  const vk = readFileSync(join(OUT, NAME, 'keys', `${LATE[0]}.verifier`));
  check(`each added verifier key is ${vk.length.toLocaleString('en')} bytes`, vk.length > 1000);

  const lock = lockUpdate(d.address, d.authority, d.signingKey);
  check('the lock update is signed once, against counter 0',
        lock.signatures.length === 1 && lock.counter === 0n && lock.updates.length === 1, lock.toString());
  const lockedAuthority = lock.updates[0].authority;
  check('it replaces the authority with an empty committee at counter 1 (nobody can sign)',
        isLocked(lockedAuthority) && lockedAuthority.counter === 1n, lockedAuthority.toString());
  const tx = Transaction.fromParts('preprod', undefined, undefined, Intent.new(ttl()).addMaintenanceUpdate(lock));
  check('the lock builds as a ledger 9 transaction', LedgerTransaction.seal('v9', 'Unproven', tx).era === 'v9');
  check('the single-use key never leaves this process', typeof d.signingKey?.value === 'string' && !JSON.stringify(d.address).includes(d.signingKey.value));

  say(failed ? `\n${failed} FAILED` : '\nall offline checks passed');
  if (failed) process.exitCode = 1;
};

// ------------------------------------------------------------------ on Preprod
const run = async (values) => {
  const network = values.network ?? 'preprod';
  const port = values['proof-server-port'] ? Number(values['proof-server-port']) : 6301;
  const { withSession, walletSeed } = await cli('common.js');
  const { openWallet } = await cli('wallet-lock.js');
  const { withFreshFees } = await cli('fresh-fees.js');
  const { waitForTip } = await cli('sync-watch.js');
  const { isStaleDustProof } = await import('@lunardraw/keeper');
  const results = { probe: 'upgrade', network, started: new Date().toISOString(), circuits: TOTAL, deployedWith: FIRST, steps: [] };
  const file = join(HERE, 'results-upgrade.json');
  const save = () => writeFileSync(file, JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  const step = async (name, f) => {
    const started = Date.now();
    say(`\n== ${name}`);
    try {
      const out = await f();
      const seconds = Math.round((Date.now() - started) / 1000);
      results.steps.push({ step: name, ok: true, seconds, ...(out && typeof out === 'object' ? out : {}) });
      say(`   ok (${seconds} s)${out?.note ? `: ${out.note}` : ''}`);
      save();
      return out;
    } catch (e) {
      results.steps.push({ step: name, ok: false, error: errorText(e) });
      say(`   FAILED: ${errorText(e)}`);
      save();
      throw e;
    }
  };
  try {
    await withSession(network, async (session) => {
      const wallet = await openWallet(session, { seed: walletSeed(values.wallet) });
      try {
        results.wallet = walletAddress(wallet);
        say(`wallet ${results.wallet}`);
        const publicData = indexerPublicDataProvider(session.config.indexer, session.config.indexerWS);
        const raw = {
          privateStateProvider: inMemoryPrivateStateProvider(),
          publicDataProvider: publicData,
          walletProvider: wallet,
          midnightProvider: wallet,
          config: { networkId: session.config.networkId, ttlSeconds: TX_TTL_SECONDS },
        };
        const fresh = withFreshFees(raw, { beforeBalance: () => waitForTip(wallet, { logger: session.logger, timeoutMs: 60_000 }), isStale: isStaleDustProof, logger: session.logger });
        const registry = await nodeZkConfigRegistry(OUT);
        const providers = {
          ...fresh,
          zkConfigProvider: new NodeZkConfigProvider(join(OUT, NAME), { verify: 'require-if-present' }),
          proofProvider: httpClientProofProvider(session.config.proofServer, registry, { timeout: 60 * 60_000 }),
        };
        const W = await compiled();
        const onChain = async (address) => {
          const read = await publicData.queryContractState(address);
          if (!read) throw new Error(`no contract at ${address}`);
          return (read.contractState ?? read).deserialize({ v9: ContractState });
        };

        const d = await step(`deploy an ${TOTAL}-circuit contract with only its first ${FIRST} circuits and a single-use maintenance key`, async () => {
          const built = await trimmedDeploy(providers, W, session.config.networkId);
          const r = await submitTx(providers, { unprovenTx: built.unprovenTx });
          await providers.privateStateProvider.setSigningKey(built.address, built.signingKey);
          const s = await onChain(built.address);
          results.contract = built.address;
          return { address: built.address, txId: r.txId, onChainCircuits: opNames(s).length, note: `${built.address}, ${opNames(s).length} circuits on chain`, built };
        });
        const address = d.address;
        delete d.built.unprovenTx;

        for (const op of LATE) {
          await step(`add ${op}'s verifier key (a maintenance transaction signed by the single-use key)`, async () => {
            const vk = readFileSync(join(OUT, NAME, 'keys', `${op}.verifier`));
            const r = await submitInsertVerifierKeyTx(providers, W, address, op, vk);
            return { txId: r.public?.txId, bytes: vk.length };
          });
        }
        const before = await step('read the contract back', async () => {
          const s = await onChain(address);
          const names = opNames(s);
          if (names.length !== TOTAL) throw new Error(`the chain shows ${names.length} circuits: ${names.join(', ')}`);
          return { circuits: names.length, authorityCounter: s.maintenanceAuthority.counter, note: `${names.length} circuits, authority counter ${s.maintenanceAuthority.counter}` };
        });

        await step(`call ${CALL}, one of the added circuits (proved by the proof server)`, async () => {
          await providers.privateStateProvider.forContract?.(address)?.set?.(NAME, {});
          const handle = await findDeployedContract(providers, { contractAddress: address, compiledContract: W, privateStateId: NAME, initialPrivateState: {} });
          const r = await handle.callTx[CALL](webcrypto.getRandomValues(new Uint8Array(32)));
          return { txId: r.public.txId };
        });

        await step('lock the contract: replace the authority with an empty committee', async () => {
          const s = await onChain(address);
          const signingKey = await providers.privateStateProvider.getSigningKey(address);
          const lock = lockUpdate(address, s.maintenanceAuthority, signingKey);
          const tx = Transaction.fromParts(session.config.networkId, undefined, undefined, Intent.new(ttl()).addMaintenanceUpdate(lock));
          const r = await submitTx(providers, { unprovenTx: LedgerTransaction.seal('v9', 'Unproven', tx) });
          await providers.privateStateProvider.removeSigningKey?.(address);
          return { txId: r.txId, counterBefore: before.authorityCounter };
        });

        await step('read it back: all circuits there, nobody can change it', async () => {
          const s = await onChain(address);
          const names = opNames(s);
          const a = s.maintenanceAuthority;
          if (names.length !== TOTAL) throw new Error(`${names.length} circuits after the lock`);
          if (!isLocked(a)) throw new Error(`the authority is not locked: ${a.toString()}`);
          return { circuits: names.length, committee: a.committee.length, threshold: a.threshold, counter: a.counter, note: `${names.length} circuits, committee of ${a.committee.length}, threshold ${a.threshold}` };
        });
        results.verdict = `PASS: deployed with ${FIRST} circuits, added ${TOTAL - FIRST} more afterwards, called one of them, then locked: ${TOTAL} circuits and nobody can change them`;
      } finally {
        await wallet.stop();
      }
    }, port);
  } catch (e) {
    results.verdict ??= `FAILED at "${results.steps.find((s) => !s.ok)?.step ?? 'setup'}": ${errorText(e)}`;
  } finally {
    results.finished = new Date().toISOString();
    save();
    say(`\n${results.verdict}\nresults written to ${file}`);
  }
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { wallet: { type: 'string' }, 'proof-server-port': { type: 'string' }, network: { type: 'string' } },
  });
  if (positionals[0] === 'offline') return offline();
  if (positionals[0] !== 'run') throw new Error('usage: node probe-upgrade.mjs run --wallet <file> [--proof-server-port 6301] | offline');
  if (!values.wallet) throw new Error('--wallet <file> is required (an idle agent wallet: see probe-upgrade.sh)');
  return run(values);
};

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    process.stderr.write(`${errorText(e)}\n`);
    process.exit(1);
  },
);
