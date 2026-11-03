import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Starfall } from '@lunardraw/contract';
import type { StarfallView } from '@lunardraw/keeper';
import { buyWithRetry, isCollision } from '../buyer.js';
import { DEFAULT_CONFIG, ensureWallet, findDeployments, parseConfig, saveBlockfrost } from '../kit/home.js';
import { BUY_SCHEMA, buyArgs, handle, type Tool } from '../kit/mcp.js';
import { checkLimits, overviewOf, ticketsReport } from '../kit/player.js';
import { type AgentState, planPurchase } from '../starfall-agent.js';
import { buyEntries } from '../starfall-commands.js';

const { DrawStatus } = Starfall;
const NOW = Date.parse('2026-11-03T02:10:00Z');
const secs = (ms: number) => BigInt(Math.floor(ms / 1000));
const purchase = (draw: number, cost: number, minsAgo: number, entries: Starfall.PlainEntry[] = [{ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 1 }]) => ({
  draw: String(draw),
  at: new Date(NOW - minsAgo * 60_000).toISOString(),
  entries,
  games: entries.reduce((a, e) => a + Starfall.gamesOf(e), 0),
  cost: String(cost * 1e6),
  txs: 1,
});

const drawView = (over: Record<string, unknown>) => ({
  id: 1n,
  status: DrawStatus.open,
  salesClose: secs(NOW + 50 * 60_000),
  tickets: 0n,
  games: 0n,
  numbers: [],
  moonball: 0,
  winners: Array.from({ length: 9 }, () => 0n),
  ...over,
});
const view = (draws: Record<string, unknown>[], carry = 1000_000000n): StarfallView =>
  ({ draws: draws.map(drawView), ticketPrice: 1_200_000n, feePerGame: 200_000n, carry }) as unknown as StarfallView;

describe('the agent kit', () => {
  it("reads the owner's config, with defaults, and refuses a bad one", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(parseConfig({ limits: { perDraw: 5 } }).limits).toEqual({ perDraw: 5, perDay: 100 });
    expect(parseConfig({ prover: 'local:6300' }).prover).toBe('local:6300');
    expect(() => parseConfig({ network: 'mainnet' })).toThrow(/test tokens only/);
    expect(() => parseConfig({ limits: { perDay: -1 } })).toThrow(/limits.perDay/);
    expect(() => parseConfig({ prover: 'http//nope' })).toThrow(/prover/);
  });

  it('makes a wallet once, private to the owner, and keeps the Blockfrost id the same way', () => {
    const home = mkdtempSync(join(tmpdir(), 'kit-'));
    const a = ensureWallet(home);
    expect(a.created).toBe(true);
    expect(a.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureWallet(home)).toEqual({ seed: a.seed, created: false });
    expect(statSync(join(home, 'wallet.secret')).mode & 0o777).toBe(0o600);
    saveBlockfrost(' preprodAbc123XYZ ', home);
    expect(readFileSync(join(home, 'blockfrost-preprod.secret'), 'utf8')).toBe('preprodAbc123XYZ\n');
    expect(() => saveBlockfrost('not an id!', home)).toThrow(/Blockfrost project id/);
    writeFileSync(join(home, 'wallet.secret'), '{"role":"wallet"}');
    expect(() => ensureWallet(home)).toThrow(/no wallet seed/);
  });

  it('finds the published deployment record next to the kit', () => {
    expect(findDeployments('preprod')).toMatch(/deployments$/);
    expect(() => findDeployments('preview', tmpdir())).toThrow(/wasn't found/);
  });

  it("keeps purchases inside the owner's limits, per draw and per 24 hours", () => {
    const config = { ...DEFAULT_CONFIG, limits: { perDraw: 25, perDay: 30 } };
    const state: AgentState = { purchases: [purchase(7, 20, 30), purchase(6, 6, 60 * 25)], reported: [] };
    expect(checkLimits(state, config, 8n, 6_000_000n, NOW)).toBeUndefined();
    expect(checkLimits(state, config, 7n, 6_000_000n, NOW)).toMatch(/26 tNIGHT in draw 7, over the owner's limit of 25 tNIGHT a draw \(20 tNIGHT already/);
    expect(checkLimits(state, config, 8n, 12_000_000n, NOW)).toMatch(/32 tNIGHT in 24 hours, over the owner's limit of 30 tNIGHT a day \(20 tNIGHT spent/);
    // the agent loop's daily limit
    const v = view([{ id: 9n }]);
    const plan = planPurchase(v, NOW / 1000, state, { name: 'a', style: 'quickpick', dailyLimit: 21_000_000n }, [{ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 2 }]);
    expect(plan).toEqual({ skipped: expect.stringMatching(/daily limit of 21 \(20 spent/) });
    expect(planPurchase(v, NOW / 1000, state, { name: 'a', style: 'quickpick', dailyLimit: 22_000_000n }, [{ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 2 }])).toMatchObject({ draw: 9n, games: 1 });
  });

  it("describes the draw on sale and the latest results", () => {
    const v = view([
      { id: 12n, tickets: 3n, games: 10n },
      { id: 11n, status: DrawStatus.settled, numbers: [3, 5, 9, 14, 21, 27, 33], moonball: 7, games: 20n, winners: [0n, 0n, 0n, 0n, 0n, 0n, 1n, 0n, 2n] },
      { id: 10n, status: DrawStatus.voided, games: 4n },
    ]);
    const o = overviewOf(v, 'preprod', 'f868', NOW / 1000);
    // jackpot: rollover 1000 + 33.5% of 10 games x 1 tNIGHT
    expect(o.onSale).toEqual({ draw: 12, salesClose: '2026-11-03T03:00:00.000Z', minutesLeft: 50, tickets: 3, games: 10, jackpotEstimate: '1003.35 tNIGHT' });
    expect(o.gamePrice).toBe('1.2 tNIGHT');
    expect(o.recent).toEqual([
      { draw: 11, status: 'settled', numbers: [3, 5, 9, 14, 21, 27, 33], moonball: 7, games: 20, winningGames: 3 },
      { draw: 10, status: 'void', games: 4 },
    ]);
    expect(overviewOf(view([{ salesClose: secs(NOW - 60_000) }]), 'preprod', 'f868', NOW / 1000).onSale).toBeNull();
  });

  it("reports the agent's tickets with each draw's result", () => {
    const won: Starfall.PlainEntry = { numbers: [3, 5, 9, 14, 30, 31, 32], moonball: 7 }; // 4 + Moonball: Division 6
    const state: AgentState = { purchases: [purchase(11, 1.2, 70, [won]), purchase(10, 1.2, 130), purchase(12, 1.2, 5)], reported: [] };
    const v = view([
      { id: 12n },
      { id: 11n, status: DrawStatus.settled, numbers: [3, 5, 9, 14, 21, 27, 33], moonball: 7 },
      { id: 10n, status: DrawStatus.voided },
    ]);
    const r = ticketsReport(state, v, NOW);
    expect(r.purchases.map((p) => [p.draw, p.result])).toEqual([
      [12, 'waiting for the draw'],
      [11, '3 5 9 14 21 27 33 + 7: Division 6 on 1 game (1 game); the prize is paid to the payout address automatically'],
      [10, 'cancelled: the games are refunded to this wallet'],
    ]);
    expect(r.purchases[1].tickets[0]).toMatch(/3 5 9 14 30 31 32 \+ 7 \(1 game\)/);
    expect(r.spentLast24h).toBe('3.6 tNIGHT');
  });

  it("builds a purchase again when another one took its ticket number, and gives up on anything else", async () => {
    const tickets = Array.from({ length: 2 }, (_, i) => Starfall.makeTicket(5n, { numbers: [1, 2, 3, 4, 5, 6, 7], moonball: i + 1 }, new Uint8Array(32)));
    const calls: number[] = [];
    let fail: string | undefined = 'Unexpected error submitting scoped transaction: { "status": "FailFallible" }';
    const contract = {
      callTx: {
        async buyTickets(n: bigint) {
          calls.push(Number(n));
          if (fail) {
            const m = fail;
            fail = undefined;
            throw new Error(m);
          }
          return {};
        },
      },
    } as never;
    const providers = {
      privateStateProvider: { setContractAddress() {}, async set() {} },
      publicDataProvider: {
        async queryContractState() {
          throw new Error('offline');
        },
      },
    } as never;
    const logs: string[] = [];
    const out = await buyWithRetry(contract, providers, 'f868', tickets, new Uint8Array(32), BigInt(Math.floor(Date.now() / 1000) + 7200), {
      log: (m) => logs.push(m),
      sleep: async () => undefined,
    });
    expect(out).toEqual({ bought: 2, txs: 1, attempts: 2 });
    expect(calls).toEqual([2, 2]);
    expect(logs.some((l) => /another purchase took that ticket number first/.test(l))).toBe(true);
    // a refusal for another reason isn't retried
    fail = 'Insufficient funds';
    calls.length = 0;
    await expect(
      buyWithRetry(contract, providers, 'f868', tickets, new Uint8Array(32), BigInt(Math.floor(Date.now() / 1000) + 7200), { sleep: async () => undefined }),
    ).rejects.toThrow(/Insufficient funds/);
    expect(calls).toEqual([2]);
    expect(isCollision('… SegmentFail …')).toBe(true);
    expect(isCollision('1010: Invalid Transaction: Custom error: 170')).toBe(false);
  });

  it('turns MCP tool arguments into entries', () => {
    expect(buyEntries(buyArgs({ games: 3 }))).toHaveLength(3);
    const [e] = buyEntries(buyArgs({ numbers: [3, 9, 14, 21, 27, 33, 35], moonball: 8 }));
    expect(e).toMatchObject({ numbers: [3, 9, 14, 21, 27, 33, 35], moonball: 8 });
    expect(Starfall.gamesOf(buyEntries(buyArgs({ system: 9 }))[0])).toBe(36);
    expect(Starfall.gamesOf(buyEntries(buyArgs({ games: 1, sweep: true }))[0])).toBe(20);
    expect(() => buyEntries(buyArgs({ games: 2, numbers: [1, 2, 3, 4, 5, 6, 7] }))).toThrow(/not both/);
    expect(Object.keys((BUY_SCHEMA as { properties: object }).properties)).toEqual(['games', 'package', 'numbers', 'moonball', 'system', 'pick', 'sweep']);
  });

  it('speaks MCP: initialize, list and call tools, report progress, refuse what it does not know', async () => {
    const tools: Tool[] = [
      {
        name: 'echo',
        title: 'Echo',
        description: 'echo',
        inputSchema: { type: 'object' },
        run: async (a, progress) => {
          progress('working');
          if (a.fail) throw new Error('it failed');
          return { text: `got ${String(a.x)}` };
        },
      },
    ];
    const sent: unknown[] = [];
    const notify = (method: string, params: Record<string, unknown>) => sent.push({ method, params });
    const init = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, tools, notify)) as {
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: object; instructions: string };
    };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.serverInfo.name).toBe('lunardraw');
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.result.instructions).toMatch(/test network/);
    expect(((await handle({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, tools, notify)) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-06-18');
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, notify)).toBeUndefined();
    expect(await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools, notify)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'echo', title: 'Echo', description: 'echo', inputSchema: { type: 'object' }, annotations: undefined }] },
    });
    expect(await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 5 }, _meta: { progressToken: 'p1' } } }, tools, notify)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'got 5' }], isError: false },
    });
    expect(sent).toEqual([{ method: 'notifications/progress', params: { progressToken: 'p1', progress: 1, message: 'working' } }]);
    expect(await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { fail: true } } }, tools, notify)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: 'it failed' }], isError: true },
    });
    expect(await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, tools, notify)).toMatchObject({ error: { code: -32602 } });
    expect(await handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, tools, notify)).toMatchObject({ error: { code: -32601 } });
  });
});

describe('the guided setup', () => {
  it('measures the sync by its slower part, and says how long is left', async () => {
    const { bar, eta, syncFraction } = await import('../kit/setup.js');
    const part = (applied: bigint, target: bigint) => ({ state: { progress: { appliedIndex: applied, highestIndex: target } } });
    expect(syncFraction({ shielded: part(90n, 100n), dust: part(400_000n, 1_600_000n) })).toBe(0.25);
    expect(syncFraction({ isSynced: true })).toBe(1);
    expect(syncFraction({ shielded: { state: { progress: { isStrictlyComplete: () => true } } }, dust: part(5n, 10n) })).toBe(0.5);
    expect(syncFraction({})).toBe(0);
    expect(bar(0.4, 10)).toBe('[####------]  40%');
    expect(eta({ at: 0, f: 0.1 }, { at: 30_000, f: 0.2 })).toBe('working out how long');
    expect(eta({ at: 0, f: 0.1 }, { at: 10 * 60_000, f: 0.2 })).toBe('about 1 h 20 min left');
    expect(eta({ at: 0, f: 0.5 }, { at: 10 * 60_000, f: 0.9 })).toBe('about 3 min left');
  });

  it("adds Lunardraw to Claude Desktop's settings, keeping what's there", async () => {
    const { claudeDesktopConfig, mcpEntry, withLunardraw } = await import('../kit/setup.js');
    expect(claudeDesktopConfig('darwin', {}, '/Users/ann')).toBe('/Users/ann/Library/Application Support/Claude/claude_desktop_config.json');
    expect(claudeDesktopConfig('linux', {}, '/home/ann')).toBe('/home/ann/.config/Claude/claude_desktop_config.json');
    expect(claudeDesktopConfig('win32', { APPDATA: 'C:\\Users\\ann\\AppData\\Roaming' }, 'C:\\Users\\ann')).toMatch(/Roaming.Claude.claude_desktop_config\.json$/);
    const entry = mcpEntry('/usr/bin/node', '/opt/kit/bin/lunardraw-agent.js', {});
    expect(entry).toEqual({ command: '/usr/bin/node', args: ['/opt/kit/bin/lunardraw-agent.js', 'mcp'] });
    expect(mcpEntry('n', 's', { LUNARDRAW_AGENT_HOME: '/h' }).env).toEqual({ LUNARDRAW_AGENT_HOME: '/h' });
    const merged = JSON.parse(withLunardraw('{"theme":"dark","mcpServers":{"files":{"command":"x"}}}', entry));
    expect(merged).toEqual({ theme: 'dark', mcpServers: { files: { command: 'x' }, lunardraw: entry } });
    expect(JSON.parse(withLunardraw(undefined, entry))).toEqual({ mcpServers: { lunardraw: entry } });
    expect(() => withLunardraw('[1]', entry)).toThrow(/isn't a JSON object/);
  });

  it('checks a Blockfrost key before keeping it', async () => {
    const { checkBlockfrost } = await import('../kit/setup.js');
    const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    expect(await checkBlockfrost('good', 'preprod', answer(200))).toEqual({ ok: true });
    expect((await checkBlockfrost('bad', 'preprod', answer(403))).why).toMatch(/doesn't accept that key/);
    expect((await checkBlockfrost('x', 'preprod', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).why).toMatch(/couldn't reach Blockfrost \(offline\)/);
  });
});
