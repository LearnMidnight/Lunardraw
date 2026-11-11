// LunaSpin: checking a spin against Midnight itself (the certificate's second tick).
//
// Ticks 1 and 3 need no network: they recompute hashes (core.js). Tick 2 asks
// the chain: "is there a Nightcast request for this seed, answered with this
// output, under the published oracle key?" This file does that in the
// visitor's browser, with no LunaSpin server in the answer:
//
//   1. read the Nightcast contract's state from Midnight's own public node
//      (`midnight_contractState`, at the latest finalized block), or from a
//      Midnight indexer (GraphQL);
//   2. decode it with Midnight's own on-chain runtime (WebAssembly, 1.6 MB);
//   3. look the request up by its id and compare what the chain holds.
//
// What the checks tie together:
//   - the request id is SHA-256(pad32("nightcast:alpha:v0") ‖ contract ‖
//     requester ‖ tag ‖ seed), the contract's own `requestId`. Recomputing it
//     from the certificate's seed (already tied to the list and rules by tick
//     1) and the requester stored on chain shows this is the request for this
//     list, not some other request with a nicer answer;
//   - the request on chain is fulfilled, with exactly the certificate's output.
//     The contract only stores an output whose VRF proof the network verified
//     against the oracle key the request was bound to when it was made;
//   - that key is the published Nightcast oracle key, and the contract is the
//     published Nightcast deployment (both pinned below, from Nightcast's
//     deployments/preprod.json).
//
// What it does not show: that the node or indexer told the truth about the
// chain (ask another one, or run `./nightcast check`), or who runs the oracle.

import * as rt from '../node_modules/@midnightntwrk/onchain-runtime-v4/midnight_onchain_runtime_wasm_bg.js';

/** Nightcast's published deployments (github.com/LearnMidnight/Nightcast, deployments/<network>.json). */
export const DEPLOYMENTS = {
  preprod: {
    contract: 'eaae909ead81a20f6a8873aec8bdcd0c428424672771991550c483b044a73adb',
    oracleKey: {
      x: '32993920963106060157182722391396204195876652346556573714871675241262963030490',
      y: '2970426460907353687275298249844606722016022192568680380589640846132638876538',
    },
    // Midnight's own public node for this network: no key, answers browsers.
    node: 'https://rpc.preprod.midnight.network',
    indexer: 'https://midnight-preprod.blockfrost.io/api/v0',
  },
};

export const ALPHA_DOMAIN = 'nightcast:alpha:v0';
export const STATUS = ['pending', 'fulfilled', 'expired'];

// ---------------------------------------------------------------- bytes

const HEX = /^[0-9a-f]*$/;

export function fromHex(hex) {
  const h = String(hex).toLowerCase();
  if (h.length % 2 || !HEX.test(h)) throw new Error('not hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

/** Text as 32 bytes, zero-padded on the right (Compact's `pad(32, "…")`). */
export function pad32(text) {
  const t = new TextEncoder().encode(text);
  if (t.length > 32) throw new Error('longer than 32 bytes');
  const out = new Uint8Array(32);
  out.set(t);
  return out;
}

/** A state atom (stored without its trailing zero bytes) back at its full width. */
function widen(atom, width) {
  const out = new Uint8Array(width);
  out.set(atom.subarray(0, width));
  return out;
}

/** A little-endian atom as a number (a field element, a Uint<64>…). */
function leBig(atom) {
  let n = 0n;
  for (let i = atom.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(atom[i]);
  return n;
}

async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/** The Nightcast request id for a seed (hex): the contract's `requestId`. */
export async function requestIdFor({ contract, requester, tag, seed }) {
  const buf = new Uint8Array(160);
  buf.set(pad32(ALPHA_DOMAIN), 0);
  buf.set(widen(fromHex(contract), 32), 32);
  buf.set(widen(fromHex(requester), 32), 64);
  buf.set(pad32(tag), 96);
  buf.set(widen(fromHex(seed), 32), 128);
  return toHex(await sha256(buf));
}

// ---------------------------------------------------------------- the runtime

let started = null;

/**
 * Start Midnight's on-chain runtime. `source` is the .wasm file's address, or its bytes.
 * Safe to call more than once.
 */
export function init(source) {
  if (!started) {
    started = (async () => {
      let bytes = source;
      if (typeof source === 'string' || (typeof URL !== 'undefined' && source instanceof URL)) {
        const res = await fetch(source);
        if (!res.ok) throw new Error('The Midnight runtime could not be downloaded (HTTP ' + res.status + ').');
        bytes = await res.arrayBuffer();
      }
      const { instance } = await WebAssembly.instantiate(bytes, { './midnight_onchain_runtime_wasm_bg.js': rt });
      rt.__wbg_set_wasm(instance.exports);
      instance.exports.__wbindgen_start();
    })().catch((e) => {
      started = null;
      throw e;
    });
  }
  return started;
}

// ---------------------------------------------------------------- the node

/**
 * Read a contract's state from a Midnight node (JSON-RPC over HTTPS), at the latest finalized block.
 * Returns { state (hex), block: { height, hash }, tx: null }.
 */
export async function fetchStateFromNode(rpc, contract, options) {
  let n = 0;
  const call = async (method, params) => {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      signal: options && options.signal,
    });
    if (!res.ok) throw new Error('The Midnight node answered HTTP ' + res.status + '.');
    const json = await res.json();
    if (!json || json.error || json.result == null) throw new Error(json && json.error && json.error.message ? String(json.error.message) : 'The Midnight node gave no answer.');
    return json.result;
  };
  const head = await call('chain_getFinalizedHead', []);
  const [state, header] = await Promise.all([call('midnight_contractState', [contract, head]), call('chain_getHeader', [head])]);
  if (typeof state !== 'string' || !/^[0-9a-f]+$/i.test(state)) throw new Error('The Midnight node gave no contract state.');
  return { state: state.toLowerCase(), block: { height: parseInt(header.number, 16), hash: head }, tx: null };
}

// ---------------------------------------------------------------- the indexer

const STATE_QUERY = 'query($a: HexEncoded!){ contractAction(address:$a){ state transaction { hash block { height timestamp } } } }';

/**
 * Read a contract's current state from a Midnight indexer.
 * Returns { state (hex), block: { height, timestamp (ms) } | null, tx (hash) | null }.
 */
export async function fetchState(endpoint, contract, options) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, (options && options.headers) || {}),
    body: JSON.stringify({ query: STATE_QUERY, variables: { a: contract } }),
    signal: options && options.signal,
  });
  if (!res.ok) throw new Error('The Midnight indexer answered HTTP ' + res.status + '.');
  const json = await res.json();
  const action = json && json.data && json.data.contractAction;
  if (!action || typeof action.state !== 'string') {
    throw new Error(json && json.errors && json.errors[0] && json.errors[0].message ? String(json.errors[0].message) : 'The Midnight indexer has no contract at that address.');
  }
  const tx = action.transaction || {};
  return { state: action.state, block: tx.block ? { height: Number(tx.block.height), timestamp: Number(tx.block.timestamp) } : null, tx: tx.hash || null };
}

// ---------------------------------------------------------------- the request on chain

// The Request struct's fields, in the order the contract stores them (contract/src/nightcast.compact, v1).
const FIELDS = 14;

/** The contract's `requests` map (ledger field 0: `requests: Map<Bytes<32>, Request>`). */
function requestsOf(stateHex) {
  return rt.ContractState.deserialize(fromHex(stateHex)).data.state.asArray()[0].asArray()[0].asMap();
}

/** Every request id in the contract's state (hex). init() must have finished. */
export function requestIds(stateHex) {
  return requestsOf(stateHex).keys().map((k) => toHex(widen(k.value[0], 32)));
}

/**
 * One Nightcast request, read from the contract's state (hex). init() must have finished.
 * Returns null when the contract has no request with that id.
 */
export function readRequest(stateHex, requestId) {
  const cell = requestsOf(stateHex).get({ value: [fromHex(requestId)], alignment: [{ tag: 'atom', value: { tag: 'bytes', length: 32 } }] });
  if (!cell) return null;
  const a = cell.asCell().value;
  if (a.length !== FIELDS) throw new Error('This is not a Nightcast v1 request (' + a.length + ' fields).');
  const status = Number(leBig(a[0]));
  return {
    status: STATUS[status] || 'unknown',
    requester: toHex(widen(a[1], 32)),
    tag: toHex(widen(a[2], 32)),
    oracleKey: { x: leBig(a[5]).toString(), y: leBig(a[6]).toString() },
    deadline: Number(leBig(a[7])),
    output: toHex(widen(a[8], 32)),
    fee: leBig(a[9]).toString(),
    collateral: leBig(a[10]).toString(),
  };
}

/**
 * The second tick. `spin` is { requestId, seed, tag, output } from the certificate;
 * `deployment` is { contract, oracleKey } (one of DEPLOYMENTS).
 *
 * Returns { ok, found, checks: { id, fulfilled, output, tag, oracleKey }, request, status }.
 * `ok` is true only when every check passes.
 */
export async function checkSpin(stateHex, spin, deployment) {
  const request = readRequest(stateHex, spin.requestId);
  if (!request) return { ok: false, found: false, checks: {}, request: null, status: 'missing' };
  const id = await requestIdFor({ contract: deployment.contract, requester: request.requester, tag: spin.tag, seed: spin.seed });
  const checks = {
    id: id === String(spin.requestId).toLowerCase(),
    fulfilled: request.status === 'fulfilled',
    output: request.output === String(spin.output || '').toLowerCase() && !/^0+$/.test(request.output),
    tag: request.tag === toHex(pad32(spin.tag)),
    oracleKey: request.oracleKey.x === deployment.oracleKey.x && request.oracleKey.y === deployment.oracleKey.y,
  };
  const ok = checks.id && checks.fulfilled && checks.output && checks.tag && checks.oracleKey;
  return { ok, found: true, checks, request, status: request.status };
}
