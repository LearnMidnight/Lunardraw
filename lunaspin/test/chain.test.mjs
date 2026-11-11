// The chain check, against a real copy of the Nightcast contract's state on Preprod
// (test/fixtures/preprod-state.json) and one real LunaSpin spin answered in it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEPLOYMENTS, checkSpin, init, pad32, readRequest, requestIdFor, requestIds, toHex } from '../src/chain.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/preprod-state.json', import.meta.url), 'utf8'));
const wasm = readFileSync(new URL('../node_modules/@midnightntwrk/onchain-runtime-v4/midnight_onchain_runtime_wasm_bg.wasm', import.meta.url));
const dep = DEPLOYMENTS.preprod;
await init(wasm);

test('the fixture is the published Nightcast deployment', () => {
  assert.equal(fx.contract, dep.contract);
});

test('a real spin passes every check', async () => {
  const r = await checkSpin(fx.state, fx.spin, dep);
  assert.deepEqual(r.checks, { id: true, fulfilled: true, output: true, tag: true, oracleKey: true });
  assert.equal(r.ok, true);
  assert.equal(r.request.output, fx.spin.output);
  assert.equal(r.request.fee, '100000');
  assert.equal(r.request.collateral, '1000000');
  assert.ok(r.request.deadline > 1794000000 && r.request.deadline < 1800000000);
});

test('the request id recomputes from the seed and the requester on chain', async () => {
  const req = readRequest(fx.state, fx.spin.requestId);
  assert.equal(await requestIdFor({ contract: dep.contract, requester: req.requester, tag: fx.spin.tag, seed: fx.spin.seed }), fx.spin.requestId);
  assert.equal(req.tag, toHex(pad32('lunaspin|v1')));
});

test('a different output fails', async () => {
  const r = await checkSpin(fx.state, { ...fx.spin, output: fx.spin.output.replace(/^../, 'ff') }, dep);
  assert.equal(r.ok, false);
  assert.equal(r.checks.output, false);
  assert.equal(r.checks.id, true);
});

test('a different seed fails: the request is not the one for this list', async () => {
  const r = await checkSpin(fx.state, { ...fx.spin, seed: 'ab'.repeat(32) }, dep);
  assert.equal(r.ok, false);
  assert.equal(r.checks.id, false);
});

test('a request that is not on chain is reported missing', async () => {
  const r = await checkSpin(fx.state, { ...fx.spin, requestId: 'cd'.repeat(32) }, dep);
  assert.deepEqual({ ok: r.ok, found: r.found, status: r.status }, { ok: false, found: false, status: 'missing' });
});

test('a different oracle key or contract fails', async () => {
  const other = await checkSpin(fx.state, fx.spin, { ...dep, oracleKey: { x: '1', y: '2' } });
  assert.equal(other.checks.oracleKey, false);
  assert.equal(other.ok, false);
  const elsewhere = await checkSpin(fx.state, fx.spin, { ...dep, contract: 'ee'.repeat(32) });
  assert.equal(elsewhere.checks.id, false);
});

test('every request in the state reads as a v1 request', () => {
  const ids = requestIds(fx.state);
  assert.ok(ids.length >= 30);
  assert.ok(ids.includes(fx.spin.requestId));
  let fulfilled = 0;
  for (const id of ids) {
    const req = readRequest(fx.state, id);
    assert.ok(['pending', 'fulfilled', 'expired'].includes(req.status), id);
    assert.equal(/^0+$/.test(req.output), req.status !== 'fulfilled', id);
    assert.deepEqual(req.oracleKey, dep.oracleKey, id);
    if (req.status === 'fulfilled') fulfilled++;
  }
  assert.ok(fulfilled >= 20);
});
