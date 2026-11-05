import { createServer, request } from 'node:http';
import { describe, it } from 'vitest';
import { agentBackend, findHost, homeId, portOf, serveHost } from '../kit/host.js';
import type { Rpc, Tool } from '../kit/mcp.js';
import { linkAddress, linkToRelay } from '../kit/relay-link.js';
import { AWAY_TEXT, createRelay, serveRelay } from '../relay.js';
import assert from 'node:assert/strict';

const fakeTools = (tag: string): Tool[] => {
  return [
    { name: 'lunardraw_draw_on_sale', title: 'd', description: 'd', inputSchema: {}, run: async () => ({ text: JSON.stringify({ onSale: { draw: 7 }, tag }) }) },
    { name: 'lunardraw_how_to_play', title: 'r', description: 'r', inputSchema: {}, run: async () => ({ text: 'rules text' }) },
    { name: 'lunardraw_wallet', title: 'w', description: 'w', inputSchema: {}, run: async () => ({ text: '{"address":"mn_addr"}' }) },
    { name: 'lunardraw_my_tickets', title: 't', description: 't', inputSchema: {}, run: async () => ({ text: '{"purchases":[]}' }) },
    { name: 'lunardraw_buy_tickets', title: 'b', description: 'b', inputSchema: {}, run: async (a) => (a.games === 99 ? { text: 'over the limit', isError: true } : { text: JSON.stringify({ status: 'buying', games: a.games }) }) },
  ];
};
const json = async (r: Promise<Response>): Promise<any> => (await r).json();
const token = 'T'.repeat(43);
const rpc = (id: number, method: string, params: Record<string, unknown> = {}): Rpc => ({ jsonrpc: '2.0', id, method, params });
// raw request (to set Host and Origin, which fetch won't)
const raw = (port: number, path: string, headers: Record<string, string>, body?: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });


describe('one agent per computer, and the relay for AIs on the web or a phone', () => {
  it('answers on its local address only with the key, and never to a web page', async () => {
    // 1. the local address
    const server = await serveHost({ tools: fakeTools('a'), token, home: '/h', port: 0 });
    const port = portOf(server);
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    assert.equal((await json(fetch(`${base}/health`))).home, homeId('/h'));
    assert.equal((await fetch(`${base}/api/draw`)).status, 401);
    assert.equal((await fetch(`${base}/api/draw`, { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.deepEqual(await json(fetch(`${base}/api/draw`, { headers: auth })), { onSale: { draw: 7 }, tag: 'a' });
    assert.deepEqual(await json(fetch(`${base}/api/rules`, { headers: auth })), { text: 'rules text' });
    assert.deepEqual(await json(fetch(`${base}/api/buy`, { method: 'POST', headers: auth, body: '{"games":2}' })), { status: 'buying', games: 2 });
    const refused = await fetch(`${base}/api/buy`, { method: 'POST', headers: auth, body: '{"games":99}' });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'over the limit' });
    assert.equal((await fetch(`${base}/api/buy`, { headers: auth })).status, 405);
    const init = await json(fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2025-03-26' })) }));
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status, 202);
    const call = await json(fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify(rpc(2, 'tools/call', { name: 'lunardraw_draw_on_sale', arguments: {} })) }));
    assert.match(call.result.content[0].text, /"draw": ?7/);
    assert.equal((await fetch(`${base}/mcp`, { headers: auth })).status, 405);
    assert.equal((await fetch(`${base}/openapi.json`)).status, 200);
    // a web page can't use it: another Host (DNS rebinding) or an Origin
    assert.equal((await raw(port, '/health', { host: 'evil.example' })).status, 403);
    assert.equal((await raw(port, '/api/draw', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', ...auth })).status, 403);
    assert.equal((await raw(port, '/api/draw', { host: `localhost:${port}`, ...auth })).status, 200);
    server.close();
  });

  it('lets the first app\'s server be the host; the others pass on, and take over when it stops', async () => {
    // 2. one agent per computer: the first is the host, the second passes on, and takes over when the first stops
    const P = 40000 + Math.floor(Math.random() * 20000);
    const logs: string[] = [];
    const first = await agentBackend({ home: '/h1', port: P, token, makeTools: () => fakeTools('first'), log: (m) => logs.push(`1 ${m}`) });
    assert.equal(first.mode(), 'host');
    const second = await agentBackend({ home: '/h1', port: P, token, makeTools: () => fakeTools('second'), log: (m) => logs.push(`2 ${m}`) });
    assert.equal(second.mode(), 'passing on');
    const via = (await second.call(rpc(3, 'tools/call', { name: 'lunardraw_draw_on_sale', arguments: {} }))) as { result: { content: { text: string }[] } };
    assert.match(via.result.content[0].text, /first/);
    assert.equal(await second.call({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    // another home on the same port isn't mixed up with it
    const otherHome = await agentBackend({ home: '/h2', port: P, token, makeTools: () => fakeTools('other'), log: (m) => logs.push(`3 ${m}`) });
    assert.equal(otherHome.mode(), 'alone');
    await first.close();
    assert.equal(await findHost(P, '/h1'), undefined);
    const after = (await second.call(rpc(4, 'tools/call', { name: 'lunardraw_draw_on_sale', arguments: {} }))) as { result: { content: { text: string }[] } };
    assert.match(after.result.content[0].text, /second/);
    assert.equal(second.mode(), 'host');
    const third = await agentBackend({ home: '/h1', port: P, token, makeTools: () => fakeTools('third') });
    assert.equal(third.mode(), 'passing on');
    await third.ensure();
    assert.equal(third.mode(), 'passing on');
    await second.close();
    await third.ensure();
    assert.equal(third.mode(), 'host');
    await third.close();
  });

  it('never opens the wallet a second time while the port\'s holder is too busy to answer', async () => {
    // an app can start two servers at once; the first is busy opening the wallet and slow to answer /health
    const P = 40000 + Math.floor(Math.random() * 20000);
    const busy = createServer((_req, res) => setTimeout(() => res.end(JSON.stringify({ lunardraw: 'agent', home: homeId('/race'), pid: 1, version: 'x', since: '' })), 3_000));
    await new Promise<void>((r) => busy.listen(P, '127.0.0.1', () => r()));
    let made = 0;
    const second = await agentBackend({ home: '/race', port: P, token, makeTools: () => (made++, fakeTools('second')) });
    assert.equal(second.mode(), 'passing on');
    assert.equal(made, 0);
    // one that never answers: still passes on (after settleMs) rather than open the wallet
    const silent = createServer(() => undefined);
    const Q = P + 1;
    await new Promise<void>((r) => silent.listen(Q, '127.0.0.1', () => r()));
    const third = await agentBackend({ home: '/race', port: Q, token, makeTools: () => (made++, fakeTools('third')), settleMs: 1_000 });
    assert.equal(third.mode(), 'passing on');
    assert.equal(made, 0);
    for (const s of [busy, silent]) {
      s.closeAllConnections();
      s.close();
    }
  }, 30_000);

  it('passes an AI app\'s messages to the linked agent, and answers for it while it\'s away', async () => {
    // 3. the relay, end to end
    const relay = createRelay({ pollMs: 300, awayMs: 1_000, answerMs: 2_000 });
    const rs = serveRelay(relay, 0);
    await new Promise((r) => rs.once('listening', r));
    const rbase = `http://127.0.0.1:${portOf(rs)}/relay`;
    const secret = 'S'.repeat(43);
    const app = (msg: object) => fetch(linkAddress(rbase, secret), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(msg) });
    // before the agent links: the app can be set up, and calling a tool says it's away
    const awayInit = await json(app(rpc(1, 'initialize', { protocolVersion: '2025-06-18' })));
    assert.equal(awayInit.result.serverInfo.name, 'lunardraw');
    const awayList = await json(app(rpc(2, 'tools/list')));
    assert.ok(awayList.result.tools.some((t: { name: string }) => t.name === 'lunardraw_buy_tickets'));
    const awayCall = await json(app(rpc(3, 'tools/call', { name: 'lunardraw_draw_on_sale', arguments: {} })));
    assert.equal(awayCall.result.content[0].text, AWAY_TEXT);
    assert.equal((await fetch(`${rbase}/mcp/short`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${rbase}/link/poll`, { method: 'POST', body: '{}' })).status, 401);
    // the agent links (an agent backend behind it)
    const P2 = 40000 + Math.floor(Math.random() * 20000);
    const agent = await agentBackend({ home: '/h3', port: P2, token, makeTools: () => fakeTools('linked') });
    const states: string[] = [];
    const link = linkToRelay({ settings: () => ({ on: true, relay: rbase, secret }), answer: (m) => agent.call(m), version: 't', onState: (s) => states.push(s), retryMs: 100, pollMs: 5_000 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(link.state(), 'linked');
    const linked = await json(app(rpc(4, 'tools/call', { name: 'lunardraw_draw_on_sale', arguments: {} })));
    assert.equal(linked.id, 4);
    assert.match(linked.result.content[0].text, /linked/);
    // several at once
    const many = await Promise.all([5, 6, 7].map((i) => json(app(rpc(i, 'tools/call', { name: 'lunardraw_buy_tickets', arguments: { games: i } })))));
    assert.deepEqual(many.map((m) => JSON.parse(m.result.content[0].text).games), [5, 6, 7]);
    assert.equal((await app({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    // a wrong secret reaches nobody
    const wrong = await json(fetch(linkAddress(rbase, 'W'.repeat(43)), { method: 'POST', body: JSON.stringify(rpc(8, 'tools/call', { name: 'x' })) }));
    assert.equal(wrong.result.content[0].text, AWAY_TEXT);
    // the agent stops: after awayMs the relay answers for it again
    link.stop();
    await new Promise((r) => setTimeout(r, 1_600));
    const gone = await json(app(rpc(9, 'tools/call', { name: 'lunardraw_draw_on_sale', arguments: {} })));
    assert.equal(gone.result.content[0].text, AWAY_TEXT);
    // turned off: no polling
    const offLink = linkToRelay({ settings: () => ({ on: false, relay: rbase, secret }), answer: (m) => agent.call(m), version: 't' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(offLink.state(), 'off');
    offLink.stop();
    await agent.close();
    rs.close();
  }, 20_000);
});
