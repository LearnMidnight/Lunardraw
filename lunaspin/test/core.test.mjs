// Checks the LunaSpin core against the real Nightcast packages and the fixed test values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pureCircuits } from '@nightcast/contract';
import * as sdk from '@nightcast/sdk';
import * as core from '../src/core.js';

const VECTORS = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));

test('listCommitment matches Nightcast (including the published vector)', () => {
  const five = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella'];
  assert.equal(core.listCommitment(five), 'c3ebd384df5168f0c0f987dffed832806684c536ffd0316ec05748ae25d3ce42');
  for (const list of [five, [], ['é', 'é', '漢字', '🌙 moon'], Array.from({ length: 300 }, (_, i) => `name ${i}`)]) {
    assert.equal(core.listCommitment(list), sdk.listCommitment(list));
  }
});

test('randomWord matches the compiled Nightcast contract', () => {
  for (let k = 0; k < 200; k++) {
    const out = randomBytes(32);
    const i = k < 10 ? k : randomBytes(4).readUInt32LE() >>> 0;
    assert.equal(core.toHex(core.randomWord(out, i)), Buffer.from(pureCircuits.randomWord(out, BigInt(i))).toString('hex'));
  }
});

test('uniformInt matches the SDK, including the rejection path', () => {
  // A word of all 0xff is always rejected for n = 3 (it is at or above the limit), so the rehash path runs.
  const ff = new Uint8Array(32).fill(0xff);
  for (const n of [1n, 2n, 3n, 7n, 10000n, (1n << 255n) + 1n]) {
    assert.equal(core.uniformInt(ff, n), sdk.uniformInt(ff, n));
    for (let k = 0; k < 20; k++) {
      const w = randomBytes(32);
      assert.equal(core.uniformInt(w, n), sdk.uniformInt(w, n));
    }
  }
});

test('pick, pickMany and shuffle match the SDK for 1,000 outputs × every mode', () => {
  for (let k = 0; k < 1000; k++) {
    const out = randomBytes(32);
    const n = 2 + (k % 60);
    const items = Array.from({ length: n }, (_, i) => i);
    assert.deepEqual(core.resultIndexes(out, { mode: 'pick' }, n), [sdk.pick(out, items)]);
    const count = 2 + (k % Math.min(n - 1, 9));
    assert.deepEqual(core.resultIndexes(out, { mode: 'pick-many', count }, n), sdk.pickMany(out, items, count));
    assert.deepEqual(core.resultIndexes(out, { mode: 'shuffle' }, n), sdk.shuffle(out, items));
  }
});

test('names are tidied the same way everywhere', () => {
  assert.equal(core.tidy('  Ava \t  Smith  '), 'Ava Smith');
  assert.equal(core.tidy('é'), 'é');
  assert.equal(core.tidy(' Ben　 Lee﻿'), 'Ben Lee');
  assert.deepEqual(core.parseEntries('Ava\r\n\r\n  Ben \nAva\rChloe\n  \n'), ['Ava', 'Ben', 'Ava', 'Chloe']);
  assert.throws(() => core.checkEntries(['only one']), { code: 'too_few' });
  assert.throws(() => core.checkEntries(['a', ' b']), { code: 'bad_entry' });
  assert.throws(() => core.checkEntries(['a', 'x'.repeat(81)]), { code: 'entry_too_long' });
  assert.doesNotThrow(() => core.checkEntries(['a', '🌙'.repeat(80)]));
});

test('rules: fixed text, and the rules that are refused', () => {
  assert.deepEqual(core.rulesList({ mode: 'pick-many', count: 3, list: 'public', title: ' Nov  giveaway ' }),
    ['lunaspin:rules:v1', 'mode=pick-many', 'count=3', 'list=public', 'title=Nov giveaway']);
  assert.deepEqual(core.rulesList({ mode: 'pick' }), ['lunaspin:rules:v1', 'mode=pick', 'list=public', 'title=']);
  assert.throws(() => core.checkRules({ mode: 'shuffle', list: 'private' }), { code: 'private_shuffle' });
  assert.throws(() => core.checkRules({ mode: 'pick-many', count: 1 }), { code: 'bad_count' });
  assert.throws(() => core.checkRules({ mode: 'weighted' }), { code: 'bad_mode' });
  assert.deepEqual(core.rulesList({ mode: 'teams', teams: 3, title: 'Squads' }), ['lunaspin:rules:v1', 'mode=teams', 'teams=3', 'list=public', 'title=Squads']);
  assert.throws(() => core.checkRules({ mode: 'teams', teams: 3, list: 'private' }), { code: 'private_teams' });
  for (const t of [undefined, 1, 51, 2.5, '3']) assert.throws(() => core.checkRules({ mode: 'teams', teams: t }), { code: 'bad_teams' });
});

test('teams: the whole list shuffled (as the SDK), then dealt round-robin', () => {
  for (let k = 0; k < 300; k++) {
    const out = randomBytes(32);
    const n = 2 + (k % 60);
    const t = 2 + (k % Math.min(n - 1, 12));
    const items = Array.from({ length: n }, (_, i) => i);
    const order = core.resultIndexes(out, { mode: 'teams', teams: t }, n);
    assert.deepEqual(order, sdk.shuffle(out, items));
    const teams = core.teamsOf(order, t);
    assert.equal(teams.length, t);
    assert.deepEqual(teams.flat().sort((a, b) => a - b), items); // everyone, once
    const sizes = teams.map((x) => x.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1 && sizes.every((s, i) => i === 0 || s <= sizes[i - 1]));
  }
  assert.throws(() => core.resultIndexes(randomBytes(32), { mode: 'teams', teams: 5 }, 4), { code: 'bad_teams' });
  assert.throws(() => core.lockSpin({ names: ['a', 'b', 'c'], rules: { mode: 'teams', teams: 4 }, salt: '00'.repeat(32) }), { code: 'bad_teams' });
});

test('the seed is SHA-256 of the padded scheme and the three 32-byte values', () => {
  const a = '11'.repeat(32), b = '22'.repeat(32), c = '33'.repeat(32);
  const pad = Buffer.alloc(32); Buffer.from('lunaspin:v1').copy(pad);
  const want = createHash('sha256').update(pad).update(Buffer.from(a + b + c, 'hex')).digest('hex');
  assert.equal(core.spinSeed(a, b, c), want);
});

test('a public spin checks from its proof, and any change is caught', () => {
  const names = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella', 'Finn'];
  const rules = { mode: 'pick-many', count: 2, list: 'public', title: 'Test' };
  const salt = '44'.repeat(32);
  const { seed } = core.lockSpin({ names, rules, salt });
  const output = 'ab'.repeat(32);
  const result = core.resultIndexes(output, rules, names.length);
  const proof = { format: core.CERTIFICATE_FORMAT, tag: core.TAG, seed, salt, rules, names, output, result };
  const ok = core.checkProof(proof);
  assert.ok(ok.locked && ok.follows);
  assert.equal(core.checkProof({ ...proof, names: [...names.slice(0, 5), 'Mallory'] }).locked, false);
  assert.equal(core.checkProof({ ...proof, rules: { ...rules, count: 3 } }).locked, false);
  assert.equal(core.checkProof({ ...proof, result: [result[1], result[0]] }).follows, false);
});

test('a private spin checks without the other names, and entrants find themselves', () => {
  const names = ['Ava', 'Ben', 'Chloe', 'Dev'];
  const entrySalts = names.map((_, i) => String(i + 1).repeat(32).slice(0, 32));
  const rules = { mode: 'pick', list: 'private', title: '' };
  const salt = '55'.repeat(32);
  const lock = core.lockSpin({ names, rules, salt, entrySalts });
  const output = 'cd'.repeat(32);
  const result = core.resultIndexes(output, rules, names.length);
  const winners = result.map((i) => ({ index: i, name: names[i], salt: entrySalts[i] }));
  const proof = { tag: core.TAG, seed: lock.seed, salt, rules, entries: lock.items, output, result, winners };
  const ok = core.checkProof(proof);
  assert.ok(ok.locked && ok.follows);
  assert.equal(core.checkProof({ ...proof, winners: [{ ...winners[0], name: 'Mallory' }] }).follows, false);
  const code = core.receiptCode(entrySalts[2]);
  assert.equal(lock.items.indexOf(core.entryHash(core.saltFromReceipt(code), 'Chloe')), 2);
  assert.equal(lock.items.indexOf(core.entryHash(core.saltFromReceipt(code), 'Dev')), -1);
});

test('fixed test values (shared with the PHP twin)', () => {
  for (const v of VECTORS.tidy) assert.equal(core.tidy(v.in), v.out);
  for (const v of VECTORS.listCommitment) assert.equal(core.listCommitment(v.items), v.hash);
  for (const v of VECTORS.rules) assert.equal(core.rulesCommitment(v.rules), v.hash);
  for (const v of VECTORS.entryHash) assert.equal(core.entryHash(v.salt, v.name), v.hash);
  for (const v of VECTORS.spins) {
    const lock = core.lockSpin(v);
    assert.equal(lock.listFp, v.listFp);
    assert.equal(lock.rulesFp, v.rulesFp);
    assert.equal(lock.seed, v.seed);
    assert.deepEqual(core.resultIndexes(v.output, v.rules, v.names.length), v.result);
  }
  for (const v of VECTORS.teams) assert.deepEqual(core.teamsOf(v.order, v.teams), v.out);
});
