#!/usr/bin/env node
/**
 * Ledger 9 probes for Starfall v2, on Preprod. Throwaway contracts only: the live
 * game, the keeper, the oracle and their wallets are not touched.
 *
 *   node probe.mjs treasury --wallet <agent>.secret [--proof-server-port 6301]
 *   node probe.mjs circuits --wallet <agent>.secret [--proof-server-port 6301] [--sizes 12,15,18,21,24]
 *   node probe.mjs offline              (no network: builds the transactions only, for checking the code)
 *
 * treasury  Deploys Starfall v2's real Treasury contract and a stand-in game (probe-game),
 *           binds them, funds both, then asks the game to settle with the Treasury in ONE
 *           cross-contract call, with tNIGHT moving both ways (game -> Treasury and back), as
 *           Starfall's finaliseDraw will. Then a second settle asking for more than the
 *           Treasury holds (it must pay whole tNIGHT), and checks every balance against what
 *           it should be. Spends about 60 tNIGHT (it stays in the throwaway contracts) and DUST.
 * circuits  Deploys contracts with 12, 15, 18, 21 and 24 circuits (each with a 2,121-byte
 *           verifier key, more than Starfall v2's average of 1,877) until the network refuses
 *           one, to find how many circuits a ledger 9 deploy transaction can carry. DUST only.
 *
 * Run from a checkout of LearnMidnight/Lunardraw that is built (`npm run build`): it uses the
 * repo's wallet, session and fee code. Results are printed and written to results-<probe>.json.
 */
import '@nightcast/deploy/explain-errors';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { webcrypto } from 'node:crypto';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { deployContract, createUnprovenDeployTx } from '@midnight-ntwrk/midnight-js/contracts';
import { NodeZkConfigProvider, nodeZkConfigRegistry } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { inMemoryPrivateStateProvider } from '@midnight-ntwrk/testkit-js';
import { ContractState as Ledger9ContractState, unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { decodeContractState, TX_TTL_SECONDS, walletAddress } from '@nightcast/deploy';

const HERE = dirname(fileURLToPath(import.meta.url));
// The repo checkout this runs in: the probe folder sits at its top level (probe.sh puts it there).
const REPO = resolve(HERE, '..');
const cli = (m) => import(pathToFileURL(join(REPO, 'cli', 'dist', m)).href);

const STAR = 1_000_000n;
const OUT = join(HERE, 'out');
const tn = (star) => `${(Number(star) / 1e6).toLocaleString('en', { maximumFractionDigits: 6 })} tNIGHT`;
const say = (m) => process.stdout.write(`${m}\n`);
const hex = (b) => Buffer.from(b).toString('hex');

// ------------------------------------------------------------------ contracts
const moduleOf = (name) => import(pathToFileURL(join(OUT, name, 'contract', 'index.js')).href);
const compiledOf = async (name, witnesses) => {
  const mod = await moduleOf(name);
  let c = CompiledContract.make(name, mod.Contract);
  c = witnesses ? CompiledContract.withWitnesses(c, witnesses) : CompiledContract.withVacantWitnesses(c);
  return { mod, compiled: CompiledContract.withCompiledFileAssets(c, join(OUT, name)) };
};
const treasuryWitnesses = { binderSecret: ({ privateState }) => [privateState, privateState.binderSecret] };
const wideWitnesses = { secret: ({ privateState }) => [privateState, new Uint8Array(32)] };

// ------------------------------------------------------------------ providers
/**
 * Providers for one contract, plus what a cross-contract call needs: a proof provider that
 * finds every contract's keys (by verifier key, under out/), and a module provider that hands
 * midnight-js the compiled code of the contract being called.
 */
const providersFor = async (base, name, modules) => {
  const registry = await nodeZkConfigRegistry(OUT);
  return {
    ...base,
    zkConfigProvider: new NodeZkConfigProvider(join(OUT, name), { verify: 'require-if-present' }),
    proofProvider: base.proofUrl ? httpClientProofProvider(base.proofUrl, registry, { timeout: 60 * 60_000 }) : base.proofProvider,
    contractModuleProvider: { resolve: (address) => (modules[address] ? () => modules[address] : undefined) },
  };
};

/**
 * A contract's tNIGHT balance (STAR), as the indexer has it. Asked twice a few seconds apart
 * if the answers differ, since the indexer can be a block behind the transaction that just landed.
 */
const balanceOf = async (publicData, address) => {
  const once = async () => {
    const balances = await publicData.queryUnshieldedBalances(address).catch(() => null);
    if (balances) return balances.filter((b) => b.tokenType === unshieldedToken().raw).reduce((t, b) => t + BigInt(b.balance), 0n);
    const state = decodeContractState(await publicData.queryContractState(address));
    if (!state) throw new Error(`no contract at ${address}`);
    let total = 0n;
    for (const [token, amount] of state.balance ?? new Map()) if (token.tag === 'unshielded' && token.raw === unshieldedToken().raw) total += BigInt(amount);
    return total;
  };
  let last = await once();
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const now = await once();
    if (now === last) return now;
    last = now;
  }
  return last;
};

const errorText = (e) => {
  const parts = [];
  for (let x = e, i = 0; x && i < 6; x = x.cause, i++) parts.push(x instanceof Error ? `${x.name}: ${x.message}` : String(x));
  return parts.join(' <- ').replace(/\s+/g, ' ').slice(0, 1500);
};

// ------------------------------------------------------------------ the treasury probe
const treasuryProbe = async ({ base, publicData, log, results }) => {
  const binderSecret = webcrypto.getRandomValues(new Uint8Array(32));
  const T = await compiledOf('treasury', treasuryWitnesses);
  const G = await compiledOf('probe-game');
  const step = async (name, f) => {
    const started = Date.now();
    say(`\n== ${name}`);
    try {
      const out = await f();
      const secs = Math.round((Date.now() - started) / 1000);
      results.steps.push({ step: name, ok: true, seconds: secs, ...(out && typeof out === 'object' ? out : {}) });
      say(`   ok (${secs} s)`);
      return out;
    } catch (e) {
      results.steps.push({ step: name, ok: false, error: errorText(e) });
      say(`   FAILED: ${errorText(e)}`);
      throw e;
    }
  };

  const tp = await providersFor(base, 'treasury', {});
  const treasury = await step('deploy the Treasury (Starfall v2 treasury.compact, unchanged)', async () => {
    const d = await deployContract(tp, {
      compiledContract: T.compiled,
      privateStateId: 'treasury',
      initialPrivateState: { binderSecret },
      args: [T.mod.pureCircuits.binderCommitmentOf(binderSecret)],
    });
    return { address: d.deployTxData.public.contractAddress, txId: d.deployTxData.public.txId, handle: d };
  });
  const tAddr = treasury.address;
  const tBytes = { bytes: encodeContractAddress(tAddr) };

  const gp = await providersFor(base, 'probe-game', { [tAddr]: T.mod });
  const game = await step('deploy the stand-in game, pointing at the Treasury', async () => {
    const d = await deployContract(gp, { compiledContract: G.compiled, args: [tBytes, tBytes] });
    return { address: d.deployTxData.public.contractAddress, txId: d.deployTxData.public.txId, handle: d };
  });
  const gAddr = game.address;
  results.contracts = { treasury: tAddr, game: gAddr };

  await step('bind the Treasury to the game (once)', async () => {
    const r = await treasury.handle.callTx.bind({ bytes: encodeContractAddress(gAddr) });
    return { txId: r.public.txId };
  });
  await step('deposit 50 tNIGHT into the Treasury', async () => ({ txId: (await treasury.handle.callTx.deposit(50n * STAR)).public.txId }));
  await step('fund the game with 20 tNIGHT', async () => ({ txId: (await game.handle.callTx.fund(20n * STAR)).public.txId }));
  const before = { treasury: await balanceOf(publicData, tAddr), game: await balanceOf(publicData, gAddr) };
  say(`   balances: Treasury ${tn(before.treasury)}, game ${tn(before.game)}`);

  // The real test: one transaction, two contracts, tNIGHT both ways.
  const first = await step('settle 1: the game pays the Treasury 5 and asks for 30 back, in one cross-contract call', async () => {
    const r = await game.handle.callTx.settle(1n, 5n * STAR, 30n * STAR, 0n, 0n);
    return { txId: r.public.txId, got: String(r.private.result) };
  });
  const mid = { treasury: await balanceOf(publicData, tAddr), game: await balanceOf(publicData, gAddr) };
  say(`   balances: Treasury ${tn(mid.treasury)}, game ${tn(mid.game)}`);
  const expectMid = { treasury: before.treasury + 5n * STAR - 30n * STAR, game: before.game - 5n * STAR + 30n * STAR };

  // Asking for more than it holds: it must pay whole tNIGHT and keep the rest.
  const second = await step('settle 2: the game asks for 1,000 (more than the Treasury holds) with a 2 tNIGHT reserve', async () => {
    const r = await game.handle.callTx.settle(2n, 0n, 1_000n * STAR, 0n, 0n);
    return { txId: r.public.txId, got: String(r.private.result) };
  });
  const after = { treasury: await balanceOf(publicData, tAddr), game: await balanceOf(publicData, gAddr) };
  say(`   balances: Treasury ${tn(after.treasury)}, game ${tn(after.game)}`);
  const paid2 = (mid.treasury / STAR) * STAR;
  const expectAfter = { treasury: mid.treasury - paid2, game: mid.game + paid2 };

  results.balances = { before, afterSettle1: mid, afterSettle2: after, expected: { afterSettle1: expectMid, afterSettle2: expectAfter } };
  const okMid = mid.treasury === expectMid.treasury && mid.game === expectMid.game && first.got === String(30n * STAR);
  const okAfter = after.treasury === expectAfter.treasury && after.game === expectAfter.game && second.got === String(paid2);
  results.verdict = okMid && okAfter
    ? 'PASS: a cross-contract call moved tNIGHT both ways in one transaction, and a short Treasury paid whole tNIGHT'
    : `CHECK: balances differ from what they should be (settle 1 ${okMid ? 'ok' : 'differs'}, settle 2 ${okAfter ? 'ok' : 'differs'})`;
};

// ------------------------------------------------------------------ the circuit-count probe
const circuitsProbe = async ({ base, sizes, results }) => {
  results.sizes = [];
  for (const n of sizes) {
    const name = `wide-${n}`;
    if (!existsSync(join(OUT, name))) throw new Error(`out/${name} is missing`);
    const keysDir = join(OUT, name, 'keys');
    const keyBytes = (await import('node:fs')).readdirSync(keysDir).filter((f) => f.endsWith('.verifier')).reduce((t, f) => t + readFileSync(join(keysDir, f)).length, 0);
    say(`\n== deploy a contract with ${n} circuits (${keyBytes.toLocaleString('en')} bytes of verifier keys)`);
    const W = await compiledOf(name, wideWitnesses);
    const p = await providersFor(base, name, {});
    const started = Date.now();
    try {
      const d = await deployContract(p, { compiledContract: W.compiled, privateStateId: name, initialPrivateState: {}, args: [] });
      const secs = Math.round((Date.now() - started) / 1000);
      results.sizes.push({ circuits: n, verifierKeyBytes: keyBytes, ok: true, seconds: secs, address: d.deployTxData.public.contractAddress, txId: d.deployTxData.public.txId });
      say(`   accepted (${secs} s): ${d.deployTxData.public.contractAddress}`);
    } catch (e) {
      results.sizes.push({ circuits: n, verifierKeyBytes: keyBytes, ok: false, error: errorText(e) });
      say(`   REFUSED: ${errorText(e)}`);
      break; // bigger ones would be refused too
    }
  }
  const okd = results.sizes.filter((s) => s.ok).map((s) => s.circuits);
  const refused = results.sizes.find((s) => !s.ok);
  results.verdict = okd.length === 0
    ? 'CHECK: even 12 circuits were refused; see the error'
    : `largest accepted: ${Math.max(...okd)} circuits${refused ? `; ${refused.circuits} refused` : ` (the largest tried)`}. Starfall v2 is 12; with syndicates about 18.`;
};

// ------------------------------------------------------------------ offline check
/**
 * No network. Builds each deploy, then runs bind, deposit, fund and the cross-contract settle
 * through midnight-js's real call builder against an in-memory stand-in for the chain (states
 * kept here, balances set by hand), so the wiring is checked: the compiled artifacts, the
 * ledger 9 deploy and call paths, the module provider, the callee's verifier-key check, and the
 * token effects each call declares. Nothing is proved, balanced or sent.
 */
const offline = async () => {
  const { SerializedContractState, SerializedZswapChainState, SerializedLedgerParameters } = await import('@midnight-ntwrk/midnight-js-types');
  const { ZswapChainState, LedgerParameters } = await import('@midnight-ntwrk/midnight-js-protocol/v9');
  const { createUnprovenCallTx } = await import('@midnight-ntwrk/midnight-js/contracts');
  const states = new Map(); // address -> ledger 9 ContractState
  const balances = new Map(); // address -> STAR
  const read = (address) => {
    const st = states.get(String(address));
    if (!st) return null;
    st.balance = new Map([[{ tag: 'unshielded', raw: unshieldedToken().raw }, balances.get(String(address)) ?? 0n]]);
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
  const fakeWallet = { getCoinPublicKey: () => '0'.repeat(64), getEncryptionPublicKey: () => '0'.repeat(64) };
  const base = {
    privateStateProvider: inMemoryPrivateStateProvider(),
    publicDataProvider: chain,
    walletProvider: fakeWallet,
    config: { networkId: 'preprod', ttlSeconds: TX_TTL_SECONDS },
  };
  const T = await compiledOf('treasury', treasuryWitnesses);
  const G = await compiledOf('probe-game');
  const zk = (name) => new NodeZkConfigProvider(join(OUT, name), { verify: 'require-if-present' });
  const asState = (serialized) => serialized.deserialize({ v9: Ledger9ContractState });
  let failed = 0;
  const check = (name, cond, detail = '') => { if (!cond) failed++; say(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `  ${detail}`}`); };

  const binderSecret = new Uint8Array(32).fill(7);
  const t = await createUnprovenDeployTx({ ...base, zkConfigProvider: zk('treasury') }, { compiledContract: T.compiled, privateStateId: 'treasury', initialPrivateState: { binderSecret }, args: [T.mod.pureCircuits.binderCommitmentOf(binderSecret)] });
  const tAddr = String(t.public.contractAddress);
  states.set(tAddr, asState(t.public.initialContractState));
  check(`the Treasury deploy builds (ledger 9, ${states.get(tAddr).operations().length} verifier keys)`, t.private.unprovenTx?.era === 'v9' && states.get(tAddr).operations().length === 3);
  const tBytes = { bytes: encodeContractAddress(tAddr) };
  const g = await createUnprovenDeployTx({ ...base, zkConfigProvider: zk('probe-game') }, { compiledContract: G.compiled, args: [tBytes, tBytes] });
  const gAddr = String(g.public.contractAddress);
  states.set(gAddr, asState(g.public.initialContractState));
  check('the game deploy builds', states.get(gAddr).operations().length === 2);
  for (const n of [12, 24]) {
    const W = await compiledOf(`wide-${n}`, wideWitnesses);
    const w = await createUnprovenDeployTx({ ...base, zkConfigProvider: zk(`wide-${n}`) }, { compiledContract: W.compiled, privateStateId: `wide-${n}`, initialPrivateState: {}, args: [] });
    check(`a ${n}-circuit deploy builds with ${n} verifier keys`, asState(w.public.initialContractState).operations().length === n);
  }

  // Calls, each applied to the stand-in chain.
  const modules = { [tAddr]: T.mod };
  const fx = (call) => {
    const e = call.public?.effects ?? call.public;
    return e;
  };
  const call = async (name, compiled, address, circuitId, args, privateState) => {
    const providers = { ...base, zkConfigProvider: zk(name), contractModuleProvider: { resolve: (a) => (modules[String(a)] ? async () => modules[String(a)] : undefined) } };
    if (privateState) await providers.privateStateProvider.forContract(address).set(name, privateState);
    const built = await createUnprovenCallTx(providers, { compiledContract: compiled, contractAddress: address, circuitId, args, ...(privateState ? { privateStateId: name } : {}) });
    // Apply each call's final state to the stand-in chain (callees first, the root last). The
    // runtime's state values cross into the ledger's own copy as their era-neutral encoding.
    const V9 = await import('@midnight-ntwrk/midnight-js-protocol/v9');
    const toLedger = (sv) => new V9.ChargedState(V9.StateValue.decode(sv.encode()));
    for (const c of built.calls ?? []) {
      const st = states.get(String(c.contractAddress));
      if (st && String(c.contractAddress) !== String(address)) st.data = toLedger(c.public.contractState);
    }
    states.get(String(address)).data = toLedger(built.public.nextContractState);
    return built;
  };

  const bound = await call('treasury', T.compiled, tAddr, 'bind', [{ bytes: encodeContractAddress(gAddr) }], { binderSecret });
  const tl = T.mod.ledger((await import('@midnight-ntwrk/compact-runtime')).StateValue.decode(states.get(tAddr).data.state.encode()));
  check('bind builds, and binds the Treasury to the game', tl.bound === true && Buffer.from(tl.game.bytes).toString('hex') === gAddr, `bound ${tl.bound}`);
  balances.set(tAddr, 50n * STAR);
  balances.set(gAddr, 20n * STAR);
  const settled = await call('probe-game', G.compiled, gAddr, 'settle', [1n, 5n * STAR, 30n * STAR, 0n, 0n]);
  const calls = settled.calls ?? [];
  check(`settle builds as one transaction with two calls: ${calls.map((c) => `${String(c.contractAddress) === tAddr ? 'treasury' : 'game'}.${c.circuitId}`).join(' > ')}`,
        calls.length === 2 && String(calls[0].contractAddress) === tAddr && calls[0].circuitId === 'release' && String(calls[1].contractAddress) === gAddr);
  check(`the Treasury answers 30 tNIGHT (it holds 50)`, String(settled.private?.result ?? settled.public?.result) === String(30n * STAR), `${settled.private?.result}`);
  const sums = (m) => { let t2 = 0n; for (const [, v] of m ?? []) t2 += BigInt(v); return t2; };
  // A call's effects are in its transcripts (guaranteed and fallible parts).
  const effectsOf = (c) => {
    const out = { unshieldedInputs: new Map(), unshieldedOutputs: new Map() };
    for (const part of c?.public?.partitionedTranscript ?? []) {
      if (!part?.effects) continue;
      for (const k of Object.keys(out)) for (const [tok, v] of part.effects[k] ?? []) out[k].set(tok, (out[k].get(tok) ?? 0n) + BigInt(v));
    }
    return out;
  };
  const tfx = effectsOf(calls[0]), gfx = effectsOf(calls[1]);
  check('the Treasury takes in 5 and pays out 30', sums(tfx?.unshieldedInputs) === 5n * STAR && sums(tfx?.unshieldedOutputs) === 30n * STAR, `in ${sums(tfx?.unshieldedInputs)} out ${sums(tfx?.unshieldedOutputs)}`);
  check('the game takes in 30 and pays out 5', sums(gfx?.unshieldedInputs) === 30n * STAR && sums(gfx?.unshieldedOutputs) === 5n * STAR, `in ${sums(gfx?.unshieldedInputs)} out ${sums(gfx?.unshieldedOutputs)}`);
  check('the unproven transaction is ledger 9', settled.private?.unprovenTx?.era === 'v9');
  balances.set(tAddr, 25n * STAR + 400_000n);
  const short = await call('probe-game', G.compiled, gAddr, 'settle', [2n, 0n, 1_000n * STAR, 0n, 0n]);
  check('a Treasury holding 25.4 tNIGHT asked for 1,000 answers 25 (whole tNIGHT)', String(short.private?.result) === String(25n * STAR), `${short.private?.result}`);
  let refused = '';
  try { await call('probe-game', G.compiled, gAddr, 'settle', [2n, 0n, 1n, 0n, 0n]); } catch (e) { refused = errorText(e); }
  check('asking again for an answered request is refused', /already answered/.test(refused), refused.slice(0, 200));
  const registry = await nodeZkConfigRegistry(OUT);
  check('the proving registry finds every bundle under out/', registry !== undefined);
  say(failed ? `\n${failed} FAILED` : '\nall offline checks passed');
  if (failed) process.exitCode = 1;
};

// ------------------------------------------------------------------ main
const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { wallet: { type: 'string' }, 'proof-server-port': { type: 'string' }, sizes: { type: 'string' }, network: { type: 'string' } },
  });
  const probe = positionals[0];
  if (probe === 'offline') return offline();
  if (probe !== 'treasury' && probe !== 'circuits') throw new Error('usage: node probe.mjs treasury|circuits|offline --wallet <file> [--proof-server-port 6301]');
  if (!values.wallet) throw new Error('--wallet <file> is required (an idle agent wallet: see probe.sh)');
  const network = values.network ?? 'preprod';
  const port = values['proof-server-port'] ? Number(values['proof-server-port']) : 6301;
  const { withSession, walletSeed } = await cli('common.js');
  const { openWallet } = await cli('wallet-lock.js');
  const { withFreshFees } = await cli('fresh-fees.js');
  const { waitForTip } = await cli('sync-watch.js');
  const { isStaleDustProof } = await import('@lunardraw/keeper');
  const results = { probe, network, started: new Date().toISOString(), steps: [] };
  const file = join(HERE, `results-${probe}.json`);
  const save = () => writeFileSync(file, JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
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
          proofUrl: session.config.proofServer,
        };
        const base = withFreshFees(raw, { beforeBalance: () => waitForTip(wallet, { logger: session.logger, timeoutMs: 60_000 }), isStale: isStaleDustProof, logger: session.logger });
        if (probe === 'treasury') await treasuryProbe({ base, publicData, log: session.logger, results });
        else await circuitsProbe({ base, sizes: (values.sizes ?? '12,15,18,21,24').split(',').map(Number), results });
      } finally {
        await wallet.stop();
      }
    }, port);
  } catch (e) {
    results.verdict ??= `FAILED: ${errorText(e)}`;
  } finally {
    results.finished = new Date().toISOString();
    save();
    say(`\n${results.verdict}\nresults written to ${file}`);
  }
};

main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`${errorText(e)}\n`);
    process.exit(1);
  },
);
