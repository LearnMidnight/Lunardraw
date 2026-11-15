#!/usr/bin/env node
/**
 * Deploy Starfall v2 and its Treasury on a ledger 9 network, locked, in the order the independent
 * review set (docs/ADAPTIVE.md, "Independent review"):
 *
 *   1. the Treasury, already locked (its maintenance authority is an empty committee from the
 *      deploy transaction itself: nobody ever holds a key for it);
 *   2. the game with its 12 game circuits and a single-use maintenance key that exists only in
 *      this process's memory (one deploy carries 12 circuits of this size);
 *   3. the 5 syndicate circuits' verifier keys, one maintenance transaction each;
 *   4. the game locked (its authority replaced by an empty committee);
 *   5. checks on the chain: exactly the game's 17 circuits and the Treasury's 3, each with the
 *      compiled verifier key; both authorities locked; the game's sealed settings and Treasury
 *      fields as intended;
 *   6. the Treasury bound to the game (its binder secret also only in memory), then checked;
 *   7. the opening deposit.
 * Opening draw 1 is left to the keeper (after the oracle accepts its key), except in a throwaway
 * deployment, which does both with keys it makes up, to prove the first cross-contract call on
 * the real network.
 *
 *   node deploy.mjs offline
 *       No network: runs both constructors with the launch settings, builds every deploy and the
 *       lock, and checks the settings and circuits (the constructor's own checks run too).
 *   node deploy.mjs throwaway --wallet <file> [--deposit 2]
 *       A throwaway deployment with made-up keys (nothing is saved), then accepts its oracle key
 *       and opens draw 1. Leaves the deposit in contracts nobody will use.
 *   node deploy.mjs deploy --wallet <file> --organiser <file> --backup <file|64 hex> --oracle <file>
 *                          --settlement <file> [--operator <mn_addr|hex>] [--deposit 10000]
 *       The real deployment. --oracle and --settlement may hold only public keys. The operator
 *       fee goes to --operator (default: the deploying wallet).
 *   Every mode: [--network preprod] [--proof-server-port 6301] [--record <file>]
 *
 * Runs from a folder at the top of a built Lunardraw checkout (deploy.sh puts it there; it uses the
 * repo's wallet, session and fee code), with out/settlement and out/treasury next to it: Compact
 * 0.36 builds with verifier keys for every circuit, and prover keys for the Treasury's circuits and
 * for the game's acceptOracleKey and requestDraw (a throwaway deployment proves those).
 */
import '@nightcast/deploy/explain-errors';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { encodeContractAddress, StateValue } from '@midnight-ntwrk/compact-runtime';
import {
  createUnprovenDeployTx,
  findDeployedContract,
  submitInsertVerifierKeyTx,
  submitTx,
  verifierKeysEqual,
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
  Intent,
  LedgerParameters,
  MaintenanceUpdate,
  ReplaceAuthority,
  Transaction,
  ZswapChainState,
  signData,
  unshieldedToken,
} from '@midnight-ntwrk/midnight-js-protocol/v9';
import { TX_TTL_SECONDS, walletAddress } from '@nightcast/deploy';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const cli = (m) => import(pathToFileURL(join(REPO, 'cli', 'dist', m)).href);
const OUT = join(HERE, 'out');
const STAR = 1_000_000n;
const say = (m) => process.stdout.write(`${m}\n`);
const hex = (b) => Buffer.from(b).toString('hex');
const tn = (star) => `${(Number(star) / 1e6).toLocaleString('en', { maximumFractionDigits: 6 })} tNIGHT`;
const ttl = () => new Date(Date.now() + TX_TTL_SECONDS * 1000);
const errorText = (e) => {
  const parts = [];
  for (let x = e, i = 0; x && i < 6; x = x.cause, i++) parts.push(x instanceof Error ? `${x.name}: ${x.message}` : String(x));
  return parts.join(' <- ').replace(/\s+/g, ' ').slice(0, 1500);
};
const randomBytes = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const randomScalar = () => BigInt('0x' + hex(randomBytes(31)));

// ------------------------------------------------------------------ the launch settings
// docs/ADAPTIVE.md and starfall-v2-design (project notes), as decided 14-15 Nov 2026.
const comb = (n, k) => { let r = 1n; for (let i = 0n; i < BigInt(k); i++) r = (r * (BigInt(n) - i)) / (i + 1n); return r; };
const NO_MOONBALL = [5000, 0, 752, 0, 1241, 3007, 0, 0, 0];
const MOONBALL_TABLES = {
  '30/2': [5000, 30, 272, 227, 1101, 2452, 918, 0, 0],
  '30/5': [5000, 25, 110, 191, 445, 1189, 775, 2265, 0],
  '35/5': [5000, 19, 92, 160, 404, 1175, 703, 2447, 0],
  '35/10': [5000, 15, 51, 122, 223, 648, 536, 1348, 2057],
};
const POWERBALL_HALF = [5000, 139, 173, 150, 113, 707, 549, 1165, 2004];
const rung = (n, m) => ({
  numbers: BigInt(n), moonball: BigInt(m), q: BigInt(Math.floor(65536 / n)), qm: BigInt(Math.floor(65536 / m)),
  odds: comb(n, 7) * BigInt(m), pick5: comb(n - 5, 2),
  shares: (m === 1 ? NO_MOONBALL : MOONBALL_TABLES[`${n}/${m}`] ?? POWERBALL_HALF).map(BigInt),
});
export const LADDER = [[20, 1], [22, 1], [25, 1], [27, 1], [30, 1], [30, 2], [30, 5], [35, 5], [35, 10], [35, 20], [40, 20], [45, 20]].map(([n, m]) => rung(n, m));
export const LAUNCH = {
  price: 1_300_000n,           // a game: 1.3 tNIGHT
  fee: 200_000n,               // 0.20 to the operator
  treasuryFee: 100_000n,       // 0.10 to the Treasury (1.0 to the prize pool)
  ceiling: 710_000n,           // the next jackpot is at most 0.71 tNIGHT per combination
  floorPer: 200_000n,          // the floor: 0.20 a game of a target window's sales
  floor0: 1_840n * STAR,       // the first floor: 28 draws x about 330 games x 0.20
  startRung: 0n,               // 7 from 20, no Moonball
  target: 28n,                 // daily draws, a jackpot about monthly
  every: 7n,                   // the format checked weekly
  mustBeWonAfter: 0n,          // never forced
  minSales: 21_600n,           // a draw sells for 6 hours ...
  maxSales: 14n * 86_400n,     // ... to 14 days
  revealWindow: 3_600n,
  drawWindow: 7_200n,
  settleWindow: 86_400n,
  maxTicketsPerDraw: 10_000n,
  finalSales: 7n * 86_400n,    // a final draw sells for at least a week
  deposit: 10_000n * STAR,     // the treasury wallet's opening deposit
};
const GAME = 'settlement', TREASURY = 'treasury';
const SYNDICATE_CIRCUITS = ['createSyndicate', 'joinSyndicate', 'buySyndicateTickets', 'paySyndicateMember', 'refundSyndicate'];
const TREASURY_CIRCUITS = ['bind', 'deposit', 'release'];
const circuitsOf = (name) => readdirSync(join(OUT, name, 'keys')).filter((f) => f.endsWith('.verifier')).map((f) => f.slice(0, -'.verifier'.length)).sort();

// ------------------------------------------------------------------ compiled contracts
const moduleOf = (name) => import(pathToFileURL(join(OUT, name, 'contract', 'index.js')).href);
const sortSeven = (v) => [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const gameWitnesses = {
  oracleSecretKey: ({ privateState }) => [privateState, need(privateState.oracleSecretKey, 'oracle secret')],
  organiserSecret: ({ privateState }) => [privateState, need(privateState.organiserSecret, 'organiser secret')],
  syndicateSecret: ({ privateState }) => [privateState, need(privateState.syndicateSecret, 'syndicate secret')],
  newTickets: () => { throw new Error('the deploy buys no tickets'); },
  sealingRandomnessFor: () => { throw new Error('the deploy buys no tickets'); },
  settlementBatch: () => { throw new Error('the deploy settles nothing'); },
  splitByte: ({ privateState }, x) => [privateState, [x >> 4n, x & 15n]],
  divMod16: ({ privateState }, v, m) => [privateState, [v / m, v % m]],
  sortSeven: ({ privateState }, v) => [privateState, sortSeven(v)],
  divModWide: ({ privateState }, n, d) => [privateState, [n / d, n % d]],
};
const treasuryWitnesses = { binderSecret: ({ privateState }) => [privateState, need(privateState.binderSecret, 'binder secret')] };
function need(v, what) { if (v === undefined) throw new Error(`no ${what} in private state`); return v; }
const compiled = async (name, witnesses) => {
  const mod = await moduleOf(name);
  const c = CompiledContract.withCompiledFileAssets(CompiledContract.withWitnesses(CompiledContract.make(name, mod.Contract), witnesses), join(OUT, name));
  return { mod, c };
};

const opNames = (state) => state.operations().map((o) => (typeof o === 'string' ? o : Buffer.from(o).toString())).sort();
const isLocked = (a) => a.committee.length === 0 && a.threshold > a.committee.length;
const ledgerOf = (mod, state) => mod.ledger(StateValue.decode(state.data.state.encode()));

/** The game's constructor arguments, in its order. */
const gameArgs = (p, tAddr) => [
  p.oracleKey, p.organiserCommitment, p.backupCommitment, p.settlementKey, { bytes: p.operator },
  LAUNCH.fee, LAUNCH.price, LAUNCH.minSales, LAUNCH.maxSales, LAUNCH.revealWindow, LAUNCH.drawWindow, LAUNCH.settleWindow,
  LAUNCH.maxTicketsPerDraw, LAUNCH.finalSales, LAUNCH.mustBeWonAfter,
  LADDER, BigInt(LADDER.length), LAUNCH.startRung, LAUNCH.target, LAUNCH.every, LAUNCH.floor0, LAUNCH.floorPer, LAUNCH.ceiling,
  { bytes: encodeContractAddress(tAddr) }, { bytes: encodeContractAddress(tAddr) }, LAUNCH.treasuryFee,
];

// ------------------------------------------------------------------ the transactions
/** The Treasury's deploy, locked from the start: nobody ever holds a key for it. */
const treasuryDeploy = async (providers, T, binderSecret, networkId) => {
  const built = await createUnprovenDeployTx(providers, {
    compiledContract: T.c, privateStateId: TREASURY, initialPrivateState: { binderSecret }, args: [T.mod.pureCircuits.binderCommitmentOf(binderSecret)],
  });
  const state = ContractState.deserialize(built.public.initialContractState.serialize());
  state.maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 0n);
  const deploy = new ContractDeploy(state);
  const tx = Transaction.fromParts(networkId, undefined, undefined, Intent.new(ttl()).addDeploy(deploy));
  return { deploy, address: String(deploy.address), unprovenTx: LedgerTransaction.seal('v9', 'Unproven', tx) };
};

/**
 * The game's deploy with its 12 game circuits: the constructor as midnight-js runs it (which also
 * samples the single-use maintenance key and puts it in the authority), rebuilt with the same
 * data, balance and authority and without the syndicate circuits.
 */
const gameDeploy = async (providers, G, args, networkId) => {
  const built = await createUnprovenDeployTx(providers, { compiledContract: G.c, privateStateId: GAME, initialPrivateState: {}, args });
  const full = ContractState.deserialize(built.public.initialContractState.serialize());
  const state = new ContractState();
  state.data = full.data;
  state.balance = full.balance;
  state.maintenanceAuthority = full.maintenanceAuthority;
  const base = opNames(full).filter((o) => !SYNDICATE_CIRCUITS.includes(o));
  for (const op of base) state.setOperation(op, full.operation(op));
  const deploy = new ContractDeploy(state);
  const tx = Transaction.fromParts(networkId, undefined, undefined, Intent.new(ttl()).addDeploy(deploy));
  return { deploy, address: String(deploy.address), full, base, signingKey: built.private.signingKey, unprovenTx: LedgerTransaction.seal('v9', 'Unproven', tx) };
};

/** The lock: the authority replaced by an empty committee (threshold 1: nobody can ever sign). */
const lockUpdate = (address, current, signingKey) => {
  const update = new MaintenanceUpdate(address, [new ReplaceAuthority(new ContractMaintenanceAuthority([], 1, current.counter + 1n))], current.counter);
  return update.addSignature(0n, signData(signingKey, update.dataToSign));
};

// ------------------------------------------------------------------ checks
/** Exactly these circuits, each with the compiled verifier key. */
const checkCircuits = (state, name) => {
  const want = circuitsOf(name);
  const have = opNames(state);
  const extra = have.filter((o) => !want.includes(o));
  const missing = want.filter((o) => !have.includes(o));
  const wrong = want.filter((o) => have.includes(o) && !verifierKeysEqual(state.operation(o).verifierKey, readFileSync(join(OUT, name, 'keys', `${o}.verifier`))));
  return { ok: extra.length === 0 && missing.length === 0 && wrong.length === 0, detail: `${have.length} circuits${extra.length ? `; extra: ${extra.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}${wrong.length ? `; keys differ: ${wrong.join(', ')}` : ''}` };
};

/** The game's sealed settings, as intended. */
const checkSettings = (l, p, tAddr) => {
  const same = (a, b) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v)) === JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v));
  const checks = [
    ['price 1.3, operator 0.20, Treasury 0.10', l.ticketPrice === LAUNCH.price && l.feePerGame === LAUNCH.fee && l.treasuryPerGame === LAUNCH.treasuryFee],
    ['ceiling 0.71 a combination, floor 0.20 a game, first floor 1,840', l.ceilingPerCombination === LAUNCH.ceiling && l.floorPerGame === LAUNCH.floorPer && l.floor === LAUNCH.floor0],
    ['the 12-rung ladder with its prize tables, starting on 7 from 20', same(l.ladder, LADDER) && l.rungCount === 12n && l.rung === LAUNCH.startRung && l.aim === LAUNCH.startRung],
    ['daily: target 28 draws, retarget every 7, never forced', l.targetDraws === LAUNCH.target && l.retargetEvery === LAUNCH.every && l.mustBeWonAfter === LAUNCH.mustBeWonAfter],
    ['sales 6 h to 14 days, final draw at least 7 days, 10,000 tickets a draw', l.minSales === LAUNCH.minSales && l.maxSales === LAUNCH.maxSales && l.finalSales === LAUNCH.finalSales && l.maxTicketsPerDraw === LAUNCH.maxTicketsPerDraw],
    ['windows: reveal 1 h, draw 2 h, settle 1 day', l.revealWindow === LAUNCH.revealWindow && l.drawWindow === LAUNCH.drawWindow && l.settleWindow === LAUNCH.settleWindow],
    ['the organiser, backup, settlement key and operator given', hex(l.organiser) === hex(p.organiserCommitment) && hex(l.backupOrganiser) === hex(p.backupCommitment) && l.settlementKey.x === p.settlementKey.x && l.settlementKey.y === p.settlementKey.y && hex(l.operator.bytes) === hex(p.operator)],
    ['the oracle key proposed, no draw yet, no syndicate yet', l.proposedOracleKey.is_some && l.proposedOracleKey.value.x === p.oracleKey.x && l.lastDraw === 0n && l.lastSyndicate === 0n],
    ['the Treasury it calls and pays is the deployed Treasury', hex(l.treasuryAddress.bytes) === hex(encodeContractAddress(tAddr)) && hex(l.treasury.bytes ?? l.treasury) === hex(encodeContractAddress(tAddr))],
  ];
  return checks.map(([name, ok]) => ({ name, ok: !!ok }));
};

// ------------------------------------------------------------------ offline
const standInChain = () => {
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
  return {
    states,
    chain: {
      queryBlock: async () => ({ hash: '11'.repeat(32), height: 1, timestamp: Date.now() }),
      queryZSwapAndContractState: async (a) => read(a),
      queryContractState: async (a) => read(a),
      queryDeployContractState: async (a) => read(a),
    },
  };
};

const offline = async () => {
  let failed = 0;
  const check = (name, cond, detail = '') => { if (!cond) failed++; say(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `  ${detail}`}`); };
  const { states, chain } = standInChain();
  const providers = (name) => ({
    privateStateProvider: inMemoryPrivateStateProvider(), publicDataProvider: chain,
    walletProvider: { getCoinPublicKey: () => '0'.repeat(64), getEncryptionPublicKey: () => '0'.repeat(64) },
    config: { networkId: 'preprod', ttlSeconds: TX_TTL_SECONDS }, zkConfigProvider: new NodeZkConfigProvider(join(OUT, name), { verify: 'require-if-present' }),
  });
  const T = await compiled(TREASURY, treasuryWitnesses);
  const G = await compiled(GAME, gameWitnesses);
  check(`the compiled game has 17 circuits (12 + the 5 syndicate ones) and the Treasury 3`, circuitsOf(GAME).length === 17 && SYNDICATE_CIRCUITS.every((c) => circuitsOf(GAME).includes(c)) && circuitsOf(TREASURY).join() === TREASURY_CIRCUITS.join(), circuitsOf(GAME).join());
  const t = await treasuryDeploy(providers(TREASURY), T, randomBytes(32), 'preprod');
  states.set(t.address, ContractState.deserialize(t.deploy.initialState.serialize()));
  check('the Treasury deploy builds, locked from the start', isLocked(t.deploy.initialState.maintenanceAuthority) && checkCircuits(t.deploy.initialState, TREASURY).ok);
  const p = madeUp(G).p;
  p.operator = randomBytes(32);
  const g = await gameDeploy(providers(GAME), G, gameArgs(p, t.address), 'preprod');
  check(`the game deploy builds with its 12 game circuits (the constructor's own checks passed): ${g.base.join(', ')}`, g.base.length === 12 && opNames(g.deploy.initialState).length === 12);
  check('its authority is the single-use key alone, counter 0', g.full.maintenanceAuthority.committee.length === 1 && g.full.maintenanceAuthority.threshold === 1 && g.full.maintenanceAuthority.counter === 0n);
  check('the full contract (what the chain will hold after the 5 additions) has exactly the compiled circuits and keys', checkCircuits(g.full, GAME).ok, checkCircuits(g.full, GAME).detail);
  for (const c of checkSettings(ledgerOf(G.mod, g.deploy.initialState), p, t.address)) check(`settings: ${c.name}`, c.ok);
  const lock = lockUpdate(g.address, { counter: 5n }, g.signingKey);
  check('the lock, after the 5 additions, replaces the authority with an empty committee at counter 6', lock.counter === 5n && isLocked(lock.updates[0].authority) && lock.updates[0].authority.counter === 6n && lock.signatures.length === 1);
  check(`the deploy transactions are ledger 9 (Treasury and game)`, t.unprovenTx.era === 'v9' && g.unprovenTx.era === 'v9');
  const vk = SYNDICATE_CIRCUITS.map((c) => readFileSync(join(OUT, GAME, 'keys', `${c}.verifier`)).length);
  check(`the 5 added verifier keys: ${vk.join(' + ')} = ${vk.reduce((a, b) => a + b, 0).toLocaleString('en')} bytes`, vk.every((n) => n > 1000));
  say(failed ? `\n${failed} FAILED` : '\nall offline checks passed');
  if (failed) process.exitCode = 1;
};

/** Made-up keys for offline and throwaway runs: kept only in memory, never written down. */
function madeUp(G) {
  const oracleSk = randomScalar();
  const organiserSecret = randomBytes(32);
  return {
    oracleSk,
    organiserSecret,
    p: {
      oracleKey: G.mod.pureCircuits.settlementPublicKey(oracleSk),
      organiserCommitment: G.mod.pureCircuits.organiserCommitmentOf(organiserSecret),
      backupCommitment: G.mod.pureCircuits.organiserCommitmentOf(randomBytes(32)),
      settlementKey: G.mod.pureCircuits.settlementPublicKey(randomScalar()),
    },
  };
}

// ------------------------------------------------------------------ on the network
const run = async (mode, values) => {
  const network = values.network ?? 'preprod';
  const port = values['proof-server-port'] ? Number(values['proof-server-port']) : 6301;
  const common = await cli('common.js');
  const { openWallet } = await cli('wallet-lock.js');
  const { withFreshFees } = await cli('fresh-fees.js');
  const { waitForTip } = await cli('sync-watch.js');
  const { isStaleDustProof } = await import('@lunardraw/keeper');
  const T = await compiled(TREASURY, treasuryWitnesses);
  const G = await compiled(GAME, gameWitnesses);
  const throwaway = mode === 'throwaway';
  const deposit = values.deposit !== undefined ? BigInt(Math.round(Number(values.deposit) * 1e6)) : throwaway ? 2n * STAR : LAUNCH.deposit;
  const record = { mode, network, started: new Date().toISOString(), settings: LAUNCH, steps: [] };
  const file = values.record ?? join(HERE, `deployment-${mode}-${network}.json`);
  const save = () => writeFileSync(file, JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v), 2) + '\n');
  const step = async (name, f) => {
    const started = Date.now();
    say(`\n== ${name}`);
    try {
      const out = (await f()) ?? {};
      const seconds = Math.round((Date.now() - started) / 1000);
      const { note, ...kept } = out;
      record.steps.push({ step: name, ok: true, seconds, ...kept });
      say(`   ok (${seconds} s)${note ? `: ${note}` : ''}`);
      save();
      return out;
    } catch (e) {
      record.steps.push({ step: name, ok: false, error: errorText(e) });
      say(`   FAILED: ${errorText(e)}`);
      save();
      throw e;
    }
  };
  // The keys: from files for a real deployment; made up (and never written down) for a throwaway one.
  const made = throwaway ? madeUp(G) : undefined;
  const oracleSk = made?.oracleSk;
  const organiserSecret = made?.organiserSecret;
  let p;
  if (throwaway) {
    p = made.p;
  } else {
    for (const k of ['organiser', 'backup', 'oracle', 'settlement']) if (!values[k]) throw new Error(`--${k} is required`);
    p = {
      oracleKey: common.oracleKeyFrom(values.oracle, false).pk,
      organiserCommitment: G.mod.pureCircuits.organiserCommitmentOf(common.organiserSecretFrom(values.organiser)),
      backupCommitment: backupCommitmentFrom(common, G, values.backup),
      settlementKey: settlementPublicFrom(common, G, values.settlement),
    };
  }
  try {
    await common.withSession(network, async (session) => {
      const wallet = await openWallet(session, { seed: common.walletSeed(values.wallet) });
      try {
        record.deployer = walletAddress(wallet);
        p.operator = values.operator ? (await cli('starfall-commands.js')).parseUserAddress(values.operator) : common.fromHex(wallet.unshieldedKeystore.getAddress());
        record.operator = hex(p.operator);
        say(`wallet ${record.deployer}; the operator fee goes to ${record.operator}`);
        const publicData = indexerPublicDataProvider(session.config.indexer, session.config.indexerWS);
        const raw = {
          privateStateProvider: inMemoryPrivateStateProvider(), publicDataProvider: publicData, walletProvider: wallet, midnightProvider: wallet,
          config: { networkId: session.config.networkId, ttlSeconds: TX_TTL_SECONDS },
        };
        const fresh = withFreshFees(raw, { beforeBalance: () => waitForTip(wallet, { logger: session.logger, timeoutMs: 60_000 }), isStale: isStaleDustProof, logger: session.logger });
        const registry = await nodeZkConfigRegistry(OUT);
        const proofProvider = httpClientProofProvider(session.config.proofServer, registry, { timeout: 60 * 60_000 });
        const modules = {};
        const providers = (name) => ({
          ...fresh, proofProvider, zkConfigProvider: new NodeZkConfigProvider(join(OUT, name), { verify: 'require-if-present' }),
          contractModuleProvider: { resolve: (a) => (modules[String(a)] ? () => modules[String(a)] : undefined) },
        });
        const onChain = async (address) => {
          const read = await publicData.queryContractState(address);
          if (!read) throw new Error(`no contract at ${address}`);
          return (read.contractState ?? read).deserialize({ v9: ContractState });
        };
        const networkId = session.config.networkId;
        const binderSecret = randomBytes(32);

        const t = await step('1. deploy the Treasury, locked from the start', async () => {
          const built = await treasuryDeploy(providers(TREASURY), T, binderSecret, networkId);
          const r = await submitTx(providers(TREASURY), { unprovenTx: built.unprovenTx });
          await providers(TREASURY).privateStateProvider.forContract?.(built.address)?.set?.(TREASURY, { binderSecret });
          return { address: built.address, txId: r.txId, note: built.address };
        });
        record.treasury = t.address;
        modules[t.address] = T.mod;

        const g = await step('2. deploy the game with its 12 game circuits and a single-use maintenance key', async () => {
          const built = await gameDeploy(providers(GAME), G, gameArgs(p, t.address), networkId);
          const r = await submitTx(providers(GAME), { unprovenTx: built.unprovenTx });
          await fresh.privateStateProvider.setSigningKey(built.address, built.signingKey);
          const s = await onChain(built.address);
          return { address: built.address, txId: r.txId, circuits: opNames(s).length, note: `${built.address}, ${opNames(s).length} circuits on chain` };
        });
        record.game = g.address;

        for (const op of SYNDICATE_CIRCUITS) {
          await step(`3. add ${op}`, async () => {
            const vk = readFileSync(join(OUT, GAME, 'keys', `${op}.verifier`));
            const r = await submitInsertVerifierKeyTx(providers(GAME), G.c, g.address, op, vk);
            return { txId: r.public?.txId, bytes: vk.length };
          });
        }

        await step('4. lock the game: its authority replaced by an empty committee', async () => {
          const s = await onChain(g.address);
          const signingKey = await fresh.privateStateProvider.getSigningKey(g.address);
          const tx = Transaction.fromParts(networkId, undefined, undefined, Intent.new(ttl()).addMaintenanceUpdate(lockUpdate(g.address, s.maintenanceAuthority, signingKey)));
          const r = await submitTx(providers(GAME), { unprovenTx: LedgerTransaction.seal('v9', 'Unproven', tx) });
          await fresh.privateStateProvider.removeSigningKey?.(g.address);
          return { txId: r.txId };
        });

        await step('5. check both contracts on the chain', async () => {
          const gs = await onChain(g.address);
          const ts = await onChain(t.address);
          const results = [
            { name: 'the game: exactly its 17 circuits, each with the compiled verifier key', ...checkCircuits(gs, GAME) },
            { name: 'the game is locked (an empty committee nobody can sign for)', ok: isLocked(gs.maintenanceAuthority), detail: gs.maintenanceAuthority.toString() },
            { name: 'the Treasury: exactly its 3 circuits, each with the compiled verifier key', ...checkCircuits(ts, TREASURY) },
            { name: 'the Treasury is locked', ok: isLocked(ts.maintenanceAuthority), detail: ts.maintenanceAuthority.toString() },
            ...checkSettings(ledgerOf(G.mod, gs), p, t.address),
            { name: 'the Treasury is not bound yet', ok: ledgerOf(T.mod, ts).bound === false },
          ];
          record.checks = results;
          for (const c of results) say(`   ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : `  ${c.detail ?? ''}`}`);
          if (results.some((c) => !c.ok)) throw new Error('a check failed: nothing more is done (the contracts hold nothing yet)');
          return { passed: results.length };
        });

        const treasuryHandle = await findDeployedContract(providers(TREASURY), { contractAddress: t.address, compiledContract: T.c, privateStateId: TREASURY, initialPrivateState: { binderSecret } });
        await step('6. bind the Treasury to the game, and check it', async () => {
          const r = await treasuryHandle.callTx.bind({ bytes: encodeContractAddress(g.address) });
          const l = ledgerOf(T.mod, await onChain(t.address));
          if (!l.bound || hex(l.game.bytes ?? l.game) !== hex(encodeContractAddress(g.address))) throw new Error('the Treasury does not show the game as bound');
          return { txId: r.public.txId };
        });

        await step(`7. deposit ${tn(deposit)} into the Treasury`, async () => {
          const r = await treasuryHandle.callTx.deposit(deposit);
          const balances = await publicData.queryUnshieldedBalances(t.address).catch(() => null);
          const held = balances ? balances.filter((b) => b.tokenType === unshieldedToken().raw).reduce((s, b) => s + BigInt(b.balance), 0n) : undefined;
          return { txId: r.public.txId, held, note: held !== undefined ? `the Treasury holds ${tn(held)}` : undefined };
        });

        if (throwaway) {
          const gameHandle = await findDeployedContract(providers(GAME), { contractAddress: g.address, compiledContract: G.c, privateStateId: GAME, initialPrivateState: { oracleSecretKey: oracleSk, organiserSecret } });
          await step('8. (throwaway) the oracle accepts its key', async () => ({ txId: (await gameHandle.callTx.acceptOracleKey()).public.txId }));
          await step('9. (throwaway) open draw 1: the Treasury pays its opening jackpot across contracts', async () => {
            const close = BigInt(Math.floor(Date.now() / 1000) + 7 * 3600);
            const r = await gameHandle.callTx.requestDraw(0n, new Uint8Array(32), { is_some: true, value: { salesClose: close, seedCommitment: createHash('sha256').update(hex(randomBytes(32))).digest(), final: false } });
            const l = ledgerOf(G.mod, await onChain(g.address));
            return { txId: r.public.txId, carry: l.carry, note: `draw ${l.lastDraw} is open on 7 from ${l.draws.lookup(1n).format.range}, its jackpot ${tn(l.carry)}` };
          });
        }
        record.verdict = throwaway
          ? 'PASS: a throwaway Starfall v2 deployed, locked, checked, bound, funded, and its first draw opened with the Treasury paying across contracts'
          : `DEPLOYED: Starfall v2 ${g.address} and its Treasury ${t.address}, locked and checked; the Treasury bound and holding ${tn(deposit)}. Next: the oracle accepts its key, then the keeper opens draw 1.`;
      } finally {
        await wallet.stop();
      }
    }, port);
  } catch (e) {
    record.verdict ??= `FAILED at "${record.steps.find((s) => !s.ok)?.step ?? 'setup'}": ${errorText(e)}`;
  } finally {
    record.finished = new Date().toISOString();
    save();
    say(`\n${record.verdict}\nrecord written to ${file}`);
  }
};

/** The backup organiser's commitment: 64 hex characters, or a file holding its secret. */
function backupCommitmentFrom(common, G, value) {
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) return common.fromHex(value);
  const f = common.readKeyFile(value, 'organiser');
  if (!f.secret) throw new Error(`${value} holds no secret: give the backup's Starfall commitment as 64 hex characters instead`);
  return G.mod.pureCircuits.organiserCommitmentOf(common.fromHex(f.secret));
}

/** The settlement key's public point, from its file (the secret's point, or the public one alone). */
function settlementPublicFrom(common, G, path) {
  const f = common.readKeyFile(path, 'settlement');
  if (f.secret) return G.mod.pureCircuits.settlementPublicKey(BigInt(f.secret));
  const pub = f.public;
  if (!pub) throw new Error(`${path} has neither a secret nor a public key`);
  return { x: BigInt(pub.x), y: BigInt(pub.y) };
}

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      wallet: { type: 'string' }, network: { type: 'string' }, 'proof-server-port': { type: 'string' }, record: { type: 'string' },
      organiser: { type: 'string' }, backup: { type: 'string' }, oracle: { type: 'string' }, settlement: { type: 'string' },
      operator: { type: 'string' }, deposit: { type: 'string' },
    },
  });
  const mode = positionals[0];
  if (mode === 'offline') return offline();
  if (mode !== 'throwaway' && mode !== 'deploy') throw new Error('usage: node deploy.mjs offline | throwaway --wallet <file> | deploy --wallet <file> --organiser <file> --backup <file|hex> --oracle <file> --settlement <file>');
  if (!values.wallet) throw new Error('--wallet <file> is required');
  if (!existsSync(join(OUT, GAME, 'keys')) || !existsSync(join(OUT, TREASURY, 'keys'))) throw new Error(`${OUT} must hold the compiled game and Treasury`);
  return run(mode, values);
};

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => { process.stderr.write(`${errorText(e)}\n`); process.exit(1); },
);
