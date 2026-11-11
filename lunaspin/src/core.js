/**
 * LunaSpin core rules (scheme "lunaspin:v1").
 *
 * Everything a spin's certificate depends on, in one small file that runs the
 * same in a browser and in Node: tidying names, the list and rules
 * fingerprints, the seed sent to Nightcast, private-list entry hashes, and
 * turning the oracle's output into a result.
 *
 * The picking rules are exactly Nightcast's (@nightcast/sdk `pick`,
 * `pickMany`, `shuffle`, `listCommitment`, and the contract's `randomWord`),
 * rebuilt without the compiled contract so the page stays small. The tests
 * check them against the real packages. SHA-256 throughout (decided 7 Nov
 * 2026; see claude/lunaspin.md).
 *
 * A PHP twin (../php/lunaspin-core.php) must give the same answers; both are
 * tested against test/vectors.json.
 */
import { sha256 } from '@noble/hashes/sha2.js';

export const SCHEME = 'lunaspin:v1';
/** The Nightcast request tag for every LunaSpin spin. */
export const TAG = 'lunaspin|v1';
export const CERTIFICATE_FORMAT = 'lunaspin-certificate/1';

export const MIN_ENTRIES = 2;
export const MAX_ENTRIES = 10000;
export const MAX_NAME = 80;
export const MAX_TITLE = 120;
export const MAX_WINNERS = 100;
export const MODES = ['pick', 'pick-many', 'shuffle'];
export const LISTS = ['public', 'private'];

const enc = new TextEncoder();

// ---------------------------------------------------------------- bytes

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export const fromHex = (h, len) => {
  const s = String(h).trim().replace(/^0x/i, '');
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new LunaSpinError('bad_hex', 'not hex');
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  if (len !== undefined && b.length !== len) throw new LunaSpinError('bad_hex', `expected ${len} bytes, got ${b.length}`);
  return b;
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const u32be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };

/** Compact's `pad(32, s)`: the UTF-8 bytes of s, then zeros to 32 bytes. */
export const pad32 = (s) => {
  const b = enc.encode(s);
  if (b.length > 32) throw new LunaSpinError('bad_domain', 'domain longer than 32 bytes');
  const out = new Uint8Array(32);
  out.set(b);
  return out;
};

export const sha256Hex = (...parts) => toHex(sha256(concat(...parts)));

export class LunaSpinError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------------------------------------------------------------- names

/**
 * The spaces that are trimmed and collapsed. Spelled out (not `\s`) so PHP's
 * PCRE and JS agree exactly.
 */
const SPACE = '\\t\\n\\u000B\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';
const RUNS = new RegExp(`[${SPACE}]+`, 'gu');
const EDGES = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, 'gu');

/** One name, tidied: Unicode NFC, trimmed, inner spaces collapsed to one. */
export const tidy = (s) => String(s).normalize('NFC').replace(EDGES, '').replace(RUNS, ' ');

/** Characters as people count them (code points). */
export const length = (s) => [...s].length;

/**
 * The entries from pasted text: one per line, tidied, empty lines dropped.
 * Duplicates are kept (they count as separate entries).
 */
export const parseEntries = (text) => String(text).split(/\r\n|\r|\n/).map(tidy).filter((s) => s !== '');

export const checkEntries = (names) => {
  if (!Array.isArray(names)) throw new LunaSpinError('bad_entries', 'entries must be a list');
  if (names.length < MIN_ENTRIES) throw new LunaSpinError('too_few', `at least ${MIN_ENTRIES} entries`);
  if (names.length > MAX_ENTRIES) throw new LunaSpinError('too_many', `at most ${MAX_ENTRIES.toLocaleString('en-AU')} entries`);
  names.forEach((n, i) => {
    if (typeof n !== 'string' || n === '' || tidy(n) !== n) throw new LunaSpinError('bad_entry', `entry ${i + 1} isn't tidied`);
    if (length(n) > MAX_NAME) throw new LunaSpinError('entry_too_long', `entry ${i + 1} is over ${MAX_NAME} characters`);
  });
  return names;
};

// ---------------------------------------------------------------- fingerprints

/**
 * Nightcast's list fingerprint (@nightcast/sdk `listCommitment`): SHA-256 of
 * "nightcast:list:v1", the item count, then each item's length and UTF-8
 * bytes (lengths 4-byte big-endian).
 */
export const listCommitment = (items) => {
  const parts = [enc.encode('nightcast:list:v1'), u32be(items.length)];
  for (const item of items) {
    if (typeof item !== 'string') throw new LunaSpinError('bad_entry', 'listCommitment takes strings');
    const b = enc.encode(item);
    parts.push(u32be(b.length), b);
  }
  return sha256Hex(...parts);
};

/**
 * The rules as text, in a fixed order, so their fingerprint is the same
 * everywhere. `{ mode, count, list, title }`; count only for pick-many.
 */
export const rulesList = (rules) => {
  const r = checkRules(rules);
  const out = ['lunaspin:rules:v1', `mode=${r.mode}`];
  if (r.mode === 'pick-many') out.push(`count=${r.count}`);
  out.push(`list=${r.list}`, `title=${r.title}`);
  return out;
};

export const checkRules = (rules) => {
  const mode = rules?.mode;
  const list = rules?.list ?? 'public';
  const title = tidy(rules?.title ?? '');
  if (!MODES.includes(mode)) throw new LunaSpinError('bad_mode', `mode must be one of ${MODES.join(', ')}`);
  if (!LISTS.includes(list)) throw new LunaSpinError('bad_list', 'list must be public or private');
  if (list === 'private' && mode === 'shuffle') throw new LunaSpinError('private_shuffle', 'a private list can only use pick modes: a shuffle reveals every name');
  if (length(title) > MAX_TITLE) throw new LunaSpinError('title_too_long', `the title is over ${MAX_TITLE} characters`);
  const r = { mode, list, title };
  if (mode === 'pick-many') {
    const c = rules.count;
    if (!Number.isSafeInteger(c) || c < 2 || c > MAX_WINNERS) throw new LunaSpinError('bad_count', `winners must be 2 to ${MAX_WINNERS}`);
    r.count = c;
  }
  return r;
};

export const rulesCommitment = (rules) => listCommitment(rulesList(rules));

/**
 * A private list's entry hash: SHA-256 of pad32("lunaspin:entry:v1"), the
 * entry's own 16-byte salt, the name's length (4-byte big-endian) and its
 * UTF-8 bytes.
 */
export const entryHash = (saltHex, name) => {
  const b = enc.encode(name);
  return sha256Hex(pad32('lunaspin:entry:v1'), fromHex(saltHex, 16), u32be(b.length), b);
};

/**
 * The list as fingerprinted: the names themselves for a public list, their
 * entry hashes (hex) for a private one.
 */
export const listItems = (names, list, entrySalts) => {
  if (list !== 'private') return names;
  if (!Array.isArray(entrySalts) || entrySalts.length !== names.length) throw new LunaSpinError('bad_salts', 'one salt per entry');
  return names.map((n, i) => entryHash(entrySalts[i], n));
};

/**
 * The 32-byte seed for the Nightcast request: SHA-256 of pad32("lunaspin:v1"),
 * the list fingerprint, the rules fingerprint and the spin's 32-byte salt.
 */
export const spinSeed = (listFp, rulesFp, saltHex) =>
  sha256Hex(pad32(SCHEME), fromHex(listFp, 32), fromHex(rulesFp, 32), fromHex(saltHex, 32));

/** Everything that goes into a spin's seed, worked out at once. */
export const lockSpin = ({ names, rules, salt, entrySalts }) => {
  checkEntries(names);
  const r = checkRules(rules);
  const items = listItems(names, r.list, entrySalts);
  const listFp = listCommitment(items);
  const rulesFp = rulesCommitment(r);
  return { rules: r, items, listFp, rulesFp, seed: spinSeed(listFp, rulesFp, salt) };
};

// ---------------------------------------------------------------- randomness

/** The contract's `randomWord(output, i)`: SHA-256 of pad32("nightcast:word:v0"), the output and i (4-byte little-endian). */
export const randomWord = (output, i) => sha256(concat(pad32('nightcast:word:v0'), output, u32le(i)));

const bigOf = (b) => BigInt('0x' + (toHex(b) || '0'));

/**
 * @nightcast/sdk `uniformInt`: a whole number in [0, n) from a word, with no
 * modulo bias (rejection over SHA-256(word ‖ ":i")).
 */
export const uniformInt = (word, n) => {
  n = BigInt(n);
  if (n < 1n || n > 1n << 256n) throw new RangeError('n must be 1 to 2^256');
  if (n === 1n) return 0n;
  const space = 1n << 256n;
  const limit = space - (space % n);
  for (let i = 0; ; i++) {
    const block = i === 0 ? word : sha256(concat(word, enc.encode(`:${i}`)));
    const v = bigOf(block);
    if (v < limit) return v % n;
  }
};

const outputOf = (o) => (typeof o === 'string' ? fromHex(o, 32) : o);

/** @nightcast/sdk `pickMany` on positions 0…n−1: `count` different positions, in draw order. */
export const pickManyIndexes = (output, n, count) => {
  const out = outputOf(output);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = i + Number(uniformInt(randomWord(out, i), BigInt(n - i)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
};

/** @nightcast/sdk `pick` on positions 0…n−1. */
export const pickIndex = (output, n) => Number(uniformInt(randomWord(outputOf(output), 0), BigInt(n)));

/**
 * The result of a spin: positions in the list (0-based), in order.
 * pick → [winner]; pick-many → the winners in draw order; shuffle → the whole order.
 */
export const resultIndexes = (output, rules, n) => {
  const r = checkRules(rules);
  if (r.mode === 'pick') return [pickIndex(output, n)];
  if (r.mode === 'pick-many') {
    if (r.count > n) throw new LunaSpinError('bad_count', 'more winners than entries');
    return pickManyIndexes(output, n, r.count);
  }
  return pickManyIndexes(output, n, n);
};

// ---------------------------------------------------------------- salts

const randomBytes = (n) => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
};

export const newSalt = () => toHex(randomBytes(32));
export const newEntrySalt = () => toHex(randomBytes(16));

/** A receipt code for a private-list entry: its 16-byte salt as 32 hex, grouped in fours. */
export const receiptCode = (saltHex) => saltHex.toUpperCase().match(/.{4}/g).join('-');
export const saltFromReceipt = (code) => {
  const h = String(code).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (h.length !== 32) throw new LunaSpinError('bad_receipt', 'a receipt code has 32 letters and digits (0–9, A–F)');
  return h;
};

// ---------------------------------------------------------------- checking a certificate

/**
 * Re-checks ticks 1 and 3 of a certificate from its proof file (tick 2, that
 * Nightcast answered this request with this output, needs the chain).
 *
 * proof: { format, tag, seed, salt, rules, names | entries, output, result }
 *   public list: names (all of them);
 *   private list: entries (the hashes) and winners [{ index, name, salt }].
 */
export const checkProof = (proof) => {
  const r = checkRules(proof.rules);
  const items = r.list === 'private' ? proof.entries : proof.names;
  if (!Array.isArray(items)) throw new LunaSpinError('bad_proof', 'the proof has no list');
  const listFp = listCommitment(items);
  const rulesFp = rulesCommitment(r);
  const seed = spinSeed(listFp, rulesFp, proof.salt);
  const locked = seed === String(proof.seed).toLowerCase() && proof.tag === TAG;
  const indexes = resultIndexes(proof.output, r, items.length);
  const claimed = (proof.result ?? []).map(Number);
  let follows = indexes.length === claimed.length && indexes.every((v, i) => v === claimed[i]);
  if (r.list === 'private') {
    const byIndex = new Map((proof.winners ?? []).map((w) => [Number(w.index), w]));
    follows = follows && indexes.every((i) => {
      const w = byIndex.get(i);
      return w && entryHash(w.salt, w.name) === items[i];
    });
  }
  return { locked, follows, listFp, rulesFp, seed, indexes };
};
