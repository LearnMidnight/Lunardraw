// Where a network's DUST history reaches ledger 9, found the way the wallet SDK finds it
// (findDustTimelineStart: the indexer's dust event subscription, one probe per halving of the
// timeline), but printing every probe and every error the SDK keeps to itself. With --write it
// keeps the answer where Nightcast's wallet reads it (<state dir>/<network>-dust-ledger9-start.json),
// so a fresh wallet's DUST sync starts there instead of replaying the ledger 8 history.
//
//   node starfall-v2/deploy/dust-start.mjs [--network preprod] [--write]
//
// Prints no secret: the indexer address (with the Blockfrost project id) is never printed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createClient } from 'graphql-ws';
import WebSocket from 'ws';
import { DefaultForkSchedule } from '@midnightntwrk/wallet-sdk';
import { indexerUrlsFor } from '../../cli/dist/common.js';

const { values } = parseArgs({ options: { network: { type: 'string', default: 'preprod' }, write: { type: 'boolean', default: false } } });
const network = values.network;
const boundary = BigInt(DefaultForkSchedule.v9);
const redact = (s) => String(s).replace(/(preprod|mainnet|preview)[A-Za-z0-9]{32}/g, '<id>').replace(/project_id=[A-Za-z0-9]+/g, 'project_id=***');
const say = (m) => console.log(redact(m));

const { ws } = indexerUrlsFor(network);
const client = createClient({ url: ws, webSocketImpl: WebSocket, lazy: true, retryAttempts: 2 });
const QUERY = 'subscription DustLedgerEventTip($id: Int) { dustLedgerEvents(id: $id) { id maxId protocolVersion } }';

let probes = 0;
/** The first dust event at or after `id` (the start with null): the SDK's firstDustEventFrom. */
const firstFrom = (id) =>
  new Promise((resolve, reject) => {
    probes++;
    let done = false;
    let unsubscribe = () => {};
    const finish = (f) => { if (!done) { done = true; clearTimeout(timer); unsubscribe(); f(); } };
    const timer = setTimeout(() => finish(() => reject(new Error(`no dust event at ${id ?? 'the start'} within 30 s`))), 30_000);
    unsubscribe = client.subscribe({ query: QUERY, variables: { id } }, {
      next: (msg) => finish(() => {
        if (msg.errors?.length) return reject(new Error(`the indexer answered with errors: ${JSON.stringify(msg.errors)}`));
        const e = msg.data?.dustLedgerEvents;
        if (!e) return reject(new Error(`an answer without an event: ${JSON.stringify(msg)}`));
        resolve({ id: Number(e.id), maxId: Number(e.maxId), version: BigInt(e.protocolVersion) });
      }),
      error: (err) => finish(() => reject(new Error(`the subscription failed: ${err instanceof Error ? err.message : JSON.stringify(err?.reason ?? err?.message ?? err)}`))),
      complete: () => finish(() => reject(new Error(`the indexer closed the dust events at ${id ?? 'the start'}`))),
    });
  });

const started = Date.now();
try {
  const first = await firstFrom(null);
  say(`first dust event: id ${first.id}, protocol ${first.version}; the newest id is ${first.maxId}`);
  const last = await firstFrom(first.maxId);
  say(`newest dust event: id ${last.id}, protocol ${last.version}; ledger 9 begins at protocol ${boundary}`);
  if (first.version >= boundary) throw new Error('the timeline starts at or after ledger 9: nothing to skip');
  if (last.version < boundary) throw new Error('the timeline has not reached ledger 9 yet');
  // The SDK's narrowToBoundary: every event below `low` is below the boundary and low - 1 is one of them.
  let low = first.id + 1, high = last.id, atHigh = last;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const p = await firstFrom(middle);
    if (p.version >= boundary) { high = middle; atHigh = p; } else { low = p.id + 1; }
  }
  const cursor = low - 1;
  // Check it: the event at the cursor is below the boundary, the next one is at or past it.
  const at = await firstFrom(cursor);
  const next = await firstFrom(cursor + 1);
  if (at.id !== cursor || at.version >= boundary || next.version < boundary) {
    throw new Error(`the check failed: event ${at.id} protocol ${at.version}, next ${next.id} protocol ${next.version}`);
  }
  say(`FOUND: the DUST history reaches ledger 9 after event ${cursor} (the next, ${next.id}, is protocol ${next.version}); ${probes} probes in ${Math.round((Date.now() - started) / 1000)} s`);
  if (values.write) {
    const file = join(process.env.NIGHTCAST_STATE_DIR ?? join(homedir(), 'nightcast-secrets', 'wallet-state'), `${network}-dust-ledger9-start.json`);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ network, cursor: String(cursor), version: String(atHigh.version) }) + '\n');
    say(`kept in ${file}: a fresh wallet's DUST sync starts there`);
  }
  await client.dispose();
  process.exit(0);
} catch (err) {
  say(`STOPPED after ${probes} probes, ${Math.round((Date.now() - started) / 1000)} s: ${err instanceof Error ? err.message : String(err)}`);
  await client.dispose().catch(() => undefined);
  process.exit(1);
}
