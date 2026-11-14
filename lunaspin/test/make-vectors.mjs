// Writes test/vectors.json: fixed inputs and the answers the JS and PHP rules must both give.
// Fingerprints and picks come from @nightcast/sdk where it has them, so the file isn't just core.js checking itself.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@nightcast/sdk';
import * as core from '../src/core.js';

const hex = (s) => createHash('sha256').update(s).digest('hex');

const tidy = [
  { in: '  Ava  ', out: 'Ava' },
  { in: 'Ava \t  Smith', out: 'Ava Smith' },
  { in: 'é', out: 'é' },
  { in: ' Ben　 Lee﻿', out: 'Ben Lee' },
  { in: '@quiet_fox  #817', out: '@quiet_fox #817' },
  { in: '0x3F9a…C21e', out: '0x3F9a…C21e' },
  { in: '漢字 　テスト', out: '漢字 テスト' }
].map((v) => ({ ...v, out: core.tidy(v.in) }));

const lists = [
  ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella'],
  ['é', '漢字', '🌙 moon', 'a b'],
  [],
  Array.from({ length: 40 }, (_, i) => `entry-${i}`)
];
const listCommitment = lists.map((items) => ({ items, hash: sdk.listCommitment(items) }));

const ruleSets = [
  { mode: 'pick', list: 'public', title: '' },
  { mode: 'pick', list: 'private', title: 'November community giveaway' },
  { mode: 'pick-many', count: 3, list: 'public', title: 'Top 3 🌙' },
  { mode: 'shuffle', list: 'public', title: 'Team order' },
  { mode: 'teams', teams: 4, list: 'public', title: 'Five-a-side 🌙' }
];
const rules = ruleSets.map((r) => ({ rules: r, list: core.rulesList(r), hash: sdk.listCommitment(core.rulesList(r)) }));

const entryHash = [
  { salt: '00'.repeat(16), name: 'Ava' },
  { salt: hex('salt-1').slice(0, 32), name: '漢字' },
  { salt: hex('salt-2').slice(0, 32), name: '@quiet_fox #817' }
].map((v) => ({ ...v, hash: core.entryHash(v.salt, v.name) }));

const names12 = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella', 'Finn', 'Grace', 'Hugo', 'Isla', 'Kai', 'Leo', 'Mia'];
const spinInputs = [
  { names: names12, rules: ruleSets[0], salt: hex('spin-1'), output: hex('output-1') },
  { names: names12, rules: ruleSets[1], salt: hex('spin-2'), output: hex('output-2'), entrySalts: names12.map((_, i) => hex(`entry-${i}`).slice(0, 32)) },
  { names: names12, rules: ruleSets[2], salt: hex('spin-3'), output: hex('output-3') },
  { names: names12.slice(0, 7), rules: ruleSets[3], salt: hex('spin-4'), output: hex('output-4') },
  { names: Array.from({ length: 1240 }, (_, i) => `@member${i}`), rules: ruleSets[0], salt: hex('spin-5'), output: 'ff'.repeat(32) },
  { names: names12.slice(0, 11), rules: ruleSets[4], salt: hex('spin-6'), output: hex('output-6') }
];
const spins = spinInputs.map((s) => {
  const lock = core.lockSpin(s);
  const items = Array.from({ length: s.names.length }, (_, i) => i);
  const r = s.rules;
  const result = r.mode === 'pick' ? [sdk.pick(s.output, items)] : r.mode === 'pick-many' ? sdk.pickMany(s.output, items, r.count) : sdk.shuffle(s.output, items); // teams: the SDK's shuffle, dealt out below
  return { ...s, listFp: lock.listFp, rulesFp: lock.rulesFp, seed: lock.seed, result };
});

const words = [0, 1, 7, 4294967295].map((i) => ({ output: hex('word-out'), index: i, word: core.toHex(core.randomWord(Buffer.from(hex('word-out'), 'hex'), i)) }));
const uniform = [3, 12, 10000, 9007199254740991].map((n) => ({ word: 'ff'.repeat(32), n: String(n), value: String(sdk.uniformInt(new Uint8Array(32).fill(0xff), BigInt(n))) }))
  .concat([12, 1240].map((n) => ({ word: hex(`u-${n}`), n: String(n), value: String(sdk.uniformInt(Buffer.from(hex(`u-${n}`), 'hex'), BigInt(n))) })));

// Teams: dealt round-robin from an order, written here without core.js so the two can be compared.
const deal = (order, t) => { const out = []; for (let k = 0; k < t; k++) out.push(order.filter((_, i) => i % t === k)); return out; };
const teams = [
  { order: [3, 0, 2, 1], teams: 2 },
  { order: [4, 1, 0, 3, 2], teams: 2 },
  { order: [6, 2, 9, 0, 4, 7, 1, 10, 5, 3, 8], teams: 4 },
  { order: [1, 0], teams: 2 },
  { order: Array.from({ length: 23 }, (_, i) => (i * 7) % 23), teams: 5 }
].map((v) => ({ ...v, out: deal(v.order, v.teams) }));

writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify({ scheme: core.SCHEME, tidy, listCommitment, rules, entryHash, words, uniform, spins, teams }, null, 1) + '\n');
console.log('wrote test/vectors.json');
