import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Starfall } from '@lunardraw/contract';
import type { StarfallView } from '@lunardraw/keeper';
import { buyWithRetry, isCollision, isNotSent, timedMethod } from '../buyer.js';
import { DEFAULT_CONFIG, ensureWallet, findDeployments, parseConfig, saveBlockfrost } from '../kit/home.js';
import { BUY_SCHEMA, buyArgs, handle, type Tool } from '../kit/mcp.js';
import { checkLimits, overviewOf, requireLocalProvingKey, ticketsReport } from '../kit/player.js';
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

describe('a purchase the node never took', () => {
  it('is built again; one that was sent but not seen in time is not', () => {
    expect(isNotSent('Transaction submission error: no answer from the node within 75 s')).toBe(true);
    expect(isNotSent('disconnected from wss://rpc.midnight-preprod.blockfrost.io: 1006:: Abnormal Closure')).toBe(true);
    expect(isNotSent("a purchase didn't land within 8 minutes (the wallet's connection may have dropped)")).toBe(false);
    expect(isNotSent('custom error: 104')).toBe(false);
  });
});

describe('timing a purchase\'s steps', () => {
  it('times one method and passes the rest through, bound to the original', async () => {
    class Wallet {
      #fee = 7;
      async balanceTx(x: number) {
        return x + this.#fee;
      }
      address() {
        return `addr-${this.#fee}`;
      }
    }
    const said: string[] = [];
    let t = 0;
    const w = timedMethod(new Wallet(), 'balanceTx', (s, f) => said.push(`${s}${f ? '!' : ''}`), () => (t += 2500));
    expect(await w.balanceTx(1)).toBe(8);
    expect(w.address()).toBe('addr-7');
    expect(said).toEqual(['3']);
    const bad = timedMethod({ async balanceTx() { throw new Error('no'); } }, 'balanceTx', (s, f) => said.push(`${s}${f ? '!' : ''}`), () => (t += 1000));
    await expect(bad.balanceTx()).rejects.toThrow('no');
    expect(said.at(-1)).toBe('1!');
  });
});

describe('the node\'s connection chatter', () => {
  it('is recognised (polkadot-js prints it as date, source, message), and nothing else is', async () => {
    const { isNodeNoise } = await import('../kit/quiet.js');
    expect(isNodeNoise(['2026-11-03 06:36:29', '       API-WS:', 'disconnected from wss://rpc: 1006:: Abnormal Closure'])).toBe(true);
    expect(isNodeNoise(['2026-11-03 06:36:29        RPC-CORE: getBlockHash(): disconnected'])).toBe(true);
    expect(isNodeNoise(['2026-11-03 06:36:29', 'API/INIT:', new Error('FATAL: Unable to initialize the API')])).toBe(true);
    expect(isNodeNoise(['not buying: over the limit'])).toBe(false);
    expect(isNodeNoise([new Error('a purchase didn\'t land')])).toBe(false);
    // the node refusing a transaction is never hidden
    expect(isNodeNoise(['2026-11-03 10:32:25', 'RPC-CORE:', 'submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 170'])).toBe(false);
  });
});

describe('status for people', () => {
  it('rounds amounts to whole tNIGHT and shows local clock times', async () => {
    const { whole, clock } = await import('../kit/main.js');
    expect(whole('14587.198418 tNIGHT')).toBe('14,587 tNIGHT');
    expect(whole('1.2 tNIGHT')).toBe('1 tNIGHT');
    expect(clock('2026-11-03T05:00:00.000Z')).toMatch(/^\d{1,2}:00\s?(am|pm)$/i);
  });
});

describe('proving on your own proof server', () => {
  it('needs buyTickets\' proving key, and says how to get it when the package left it out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-keys-'));
    mkdirSync(join(dir, 'keys'));
    expect(() => requireLocalProvingKey(dir)).toThrow(/"prover": "hosted"/);
    writeFileSync(join(dir, 'keys', 'buyTickets.prover'), 'key');
    expect(() => requireLocalProvingKey(dir)).not.toThrow();
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
    // the Microsoft Store install keeps its settings in its own package folder
    const { claudeDesktopConfigs } = await import('../kit/setup.js');
    const listing = (dir: string) => (/Claude-Data$/.test(dir) ? ['claude_pzs8sxrjxfjjc'] : /Packages$/.test(dir) ? ['Microsoft.Photos_8wekyb', 'Claude_pzs8sxrjxfjjc'] : []);
    const found = claudeDesktopConfigs('win32', { APPDATA: 'C:\\a\\Roaming', LOCALAPPDATA: 'C:\\a\\Local' }, 'C:\\a', listing);
    expect(found).toHaveLength(3);
    // where the Store install keeps them now comes first
    expect(found[0]).toMatch(/Claude-Data.claude_pzs8sxrjxfjjc.claude_desktop_config\.json$/);
    expect(found[1]).toMatch(/Roaming.Claude.claude_desktop_config\.json$/);
    expect(found[2]).toMatch(/Claude_pzs8sxrjxfjjc.LocalCache.Roaming.Claude.claude_desktop_config\.json$/);
    expect(claudeDesktopConfigs('darwin', {}, '/Users/ann', () => ['Claude'])).toHaveLength(1);
    const entry = mcpEntry('/usr/bin/node', '/opt/kit/bin/lunardraw-agent.js', {});
    expect(entry).toEqual({ command: '/usr/bin/node', args: ['/opt/kit/bin/lunardraw-agent.js', 'mcp'] });
    expect(mcpEntry('n', 's', { LUNARDRAW_AGENT_HOME: '/h' }).env).toEqual({ LUNARDRAW_AGENT_HOME: '/h' });
    const merged = JSON.parse(withLunardraw('{"theme":"dark","mcpServers":{"files":{"command":"x"}}}', entry));
    expect(merged).toEqual({ theme: 'dark', mcpServers: { files: { command: 'x' }, lunardraw: entry } });
    expect(JSON.parse(withLunardraw(undefined, entry))).toEqual({ mcpServers: { lunardraw: entry } });
    expect(() => withLunardraw('[1]', entry)).toThrow(/isn't a JSON object/);
  });

  it('finds the AI apps here and adds Lunardraw to each, keeping their settings', async () => {
    const { connectApps, findApps, nextSteps } = await import('../kit/connect.js');
    const home = mkdtempSync(join(tmpdir(), 'connect-'));
    const desktopDir = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude') : join(home, '.config', 'Claude');
    const xdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      // nothing installed: nothing found
      expect(findApps({ home, hasCommand: () => false })).toEqual([]);
      mkdirSync(desktopDir, { recursive: true });
      writeFileSync(join(desktopDir, 'claude_desktop_config.json'), '{"mcpServers":{"files":{"command":"x"}}}');
      mkdirSync(join(home, '.gemini'));
      const apps = findApps({ home, hasCommand: () => false });
      expect(apps.map((a) => a.id)).toEqual(['claude-desktop', 'gemini-cli']);
      const entry = { command: '/usr/bin/node', args: ['/opt/kit/bin/lunardraw-agent.js', 'mcp'] };
      const results = connectApps(apps, entry);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(JSON.parse(readFileSync(join(desktopDir, 'claude_desktop_config.json'), 'utf8')).mcpServers).toEqual({ files: { command: 'x' }, lunardraw: entry });
      expect(readFileSync(join(desktopDir, 'claude_desktop_config.json.before-lunardraw'), 'utf8')).toContain('"files"');
      expect(JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8')).mcpServers.lunardraw).toEqual({ ...entry, timeout: 900_000 });
      // what to do next says where to ask (people typed the question into the terminal)
      expect(nextSteps(['claude-desktop']).join(' ')).toMatch(/Quit Claude completely.*In Claude \(not in this window\)/);
      expect(nextSteps([]).join(' ')).toMatch(/claude\.ai\/download.*lunardraw-agent connect/);
    } finally {
      if (xdg !== undefined) process.env.XDG_CONFIG_HOME = xdg;
    }
  });

  it('adds Lunardraw to ChatGPT and Codex (TOML), Hermes (YAML), VS Code and the other apps, keeping the rest', async () => {
    const { connectApps, findApps, isConnected, withLunardrawToml, withLunardrawVscode, withLunardrawYaml } = await import('../kit/connect.js');
    const entry = { command: '/usr/bin/node', args: ['/opt/kit/bin/lunardraw-agent.js', 'mcp'] };
    // Codex's config.toml (the ChatGPT desktop app shares it): only our table changes
    const toml = withLunardrawToml('model = "o3"\n\n[mcp_servers.files]\ncommand = "x"\n\n[mcp_servers.lunardraw]\ncommand = "old"\n\n[mcp_servers.lunardraw.env]\nA = "1"\n\n[profiles.fast]\nmodel = "x"\n', entry);
    expect(toml).toContain('[mcp_servers.files]\ncommand = "x"');
    expect(toml).toContain('[profiles.fast]\nmodel = "x"');
    expect(toml).not.toMatch(/old|A = "1"/);
    expect(toml.match(/\[mcp_servers\.lunardraw\]/g)).toHaveLength(1);
    expect(toml).toContain('args = ["/opt/kit/bin/lunardraw-agent.js", "mcp"]\nstartup_timeout_sec = 60\ntool_timeout_sec = 120');
    expect(withLunardrawToml(toml, entry)).toBe(toml);
    expect(withLunardrawToml('', { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['a', 'mcp'] })).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(() => withLunardrawToml('mcp_servers.lunardraw.command = "x"\n', entry)).toThrow(/by hand/);
    // Hermes's config.yaml: its own indent kept, the old entry replaced
    const yaml = withLunardrawYaml('model: hermes\nmcp_servers:\n    files:\n        command: "x"\n    lunardraw:\n        command: "old"\n\n    other:\n        command: "y"\nterminal:\n  backend: local\n', entry);
    expect(yaml).not.toContain('old');
    expect(yaml).toContain('    lunardraw:\n        command: "/usr/bin/node"\n        args: ["/opt/kit/bin/lunardraw-agent.js", "mcp"]');
    expect(yaml).toContain('    files:\n        command: "x"');
    expect(yaml).toContain('    other:\n        command: "y"\nterminal:\n  backend: local');
    expect(withLunardrawYaml(yaml, entry)).toBe(yaml);
    expect(withLunardrawYaml('model: x\n', entry)).toBe('model: x\n\nmcp_servers:\n  lunardraw:\n    command: "/usr/bin/node"\n    args: ["/opt/kit/bin/lunardraw-agent.js", "mcp"]\n');
    expect(withLunardrawYaml('mcp_servers: {}\n', entry)).toMatch(/^mcp_servers:\n  lunardraw:/);
    expect(() => withLunardrawYaml('mcp_servers: { a: 1 }\n', entry)).toThrow(/by hand/);
    // VS Code: under "servers", as stdio
    expect(JSON.parse(withLunardrawVscode('{"servers":{"a":{"command":"x"}},"inputs":[]}', entry))).toEqual({ servers: { a: { command: 'x' }, lunardraw: { type: 'stdio', ...entry } }, inputs: [] });
    // a home with them all: each found and set up; a file with comments is left alone
    const home = mkdtempSync(join(tmpdir(), 'connect-all-'));
    const env = { HOME: home };
    for (const d of ['.codex', '.cursor', '.codeium/windsurf', '.lmstudio', '.hermes', '.config/Code/User']) mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), '// mine\n{"mcpServers":{}}');
    writeFileSync(join(home, '.hermes', 'config.yaml'), 'model: x\n');
    const apps = findApps({ home, env, hasCommand: () => false });
    expect(apps.map((a) => a.id)).toEqual(['chatgpt-codex', 'cursor', 'vscode', 'windsurf', 'lm-studio', 'hermes']);
    const results = connectApps(apps, entry);
    expect(results.filter((r) => !r.ok).map((r) => r.id)).toEqual(['cursor']);
    expect(results.find((r) => r.id === 'cursor')!.note).toMatch(/comments.*by hand/);
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('// mine\n{"mcpServers":{}}');
    expect(readFileSync(join(home, '.hermes', 'config.yaml.before-lunardraw'), 'utf8')).toBe('model: x\n');
    for (const a of apps) expect(isConnected(a)).toBe(a.id !== 'cursor');
  });

  it('keeps the agent running from sign-in, and gives AIs on the web or a phone a private address', async () => {
    const { autostartText } = await import('../kit/autostart.js');
    const launch = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm\\lunardraw-agent.js', 'serve', '--log', 'C:\\h\\agent.log'] };
    // Windows: a hidden start, every part quoted (VBScript doubles the quotes)
    expect(autostartText(launch, 'C:\\h\\agent.log', 'win32')).toContain('sh.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\npm\\lunardraw-agent.js"" ""serve"" ""--log"" ""C:\\h\\agent.log""", 0, False');
    const mac = autostartText({ command: '/usr/local/bin/node', args: ['/opt/a & b/x.js', 'serve'], env: { LUNARDRAW_AGENT_HOME: '/h' } }, '/h/agent.log', 'darwin');
    expect(mac).toContain('<string>/opt/a &amp; b/x.js</string>');
    expect(mac).toContain('<key>LUNARDRAW_AGENT_HOME</key><string>/h</string>');
    expect(autostartText({ command: '/usr/bin/node', args: ['/opt/a b/x.js', 'serve'] }, '/h/agent.log', 'linux')).toContain('ExecStart=/usr/bin/node "/opt/a b/x.js" serve');
    const { linkAddress } = await import('../kit/relay-link.js');
    expect(linkAddress('https://relay.example/relay/', 'abc')).toBe('https://relay.example/relay/mcp/abc');
    const { remoteSteps } = await import('../kit/remote.js');
    expect(remoteSteps().join('\n')).toMatch(/ChatGPT[\s\S]*No authentication[\s\S]*Claude[\s\S]*Add custom connector[\s\S]*Grok[\s\S]*new-link/);
    // the owner's config keeps the link's settings
    expect(parseConfig({ remote: true, relay: 'https://r.example/relay/', port: 7000 })).toMatchObject({ remote: true, relay: 'https://r.example/relay', port: 7000 });
    expect(() => parseConfig({ port: 70000 })).toThrow(/port/);
    // `buy`'s options, for the agent already running here
    const { buyToolArgs } = await import('../kit/mcp.js');
    expect(buyToolArgs({ games: '2', sweep: false })).toEqual({ games: 2 });
    expect(buyToolArgs({ numbers: '3 9,14 21 27 33 35', moonball: '8' })).toEqual({ numbers: [3, 9, 14, 21, 27, 33, 35], moonball: 8 });
    expect(buyArgs(buyToolArgs({ system: '9', numbers: '1 2 3 4 5 6 7 8 9', sweep: true }))).toMatchObject({ system: '9', numbers: '1 2 3 4 5 6 7 8 9', sweep: true });
    // a skill file for agents that use the command line
    const { SKILL } = await import('../kit/skill.js');
    expect(SKILL).toMatch(/^---\nname: lunardraw-starfall\ndescription: /);
    expect(SKILL).toContain('lunardraw-agent buy --games 2 --json');
  });

  it('leaves Claude alone when it has the Lunardraw extension', async () => {
    const { claudeExtension, connectApps, findApps, isConnected } = await import('../kit/connect.js');
    const home = mkdtempSync(join(tmpdir(), 'connect-ext-'));
    const xdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const dir = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude') : join(home, '.config', 'Claude');
      mkdirSync(join(dir, 'Claude Extensions', 'local.mcpb.learnmidnight.lunardraw'), { recursive: true });
      writeFileSync(join(dir, 'claude_desktop_config.json'), '{"mcpServers":{}}');
      expect(claudeExtension(join(dir, 'claude_desktop_config.json'))).toMatch(/lunardraw$/);
      const [claude] = findApps({ home, hasCommand: () => false });
      expect(claude.extension).toBeDefined();
      expect(isConnected(claude)).toBe(true);
      expect(connectApps([claude], { command: 'node', args: ['x', 'mcp'] })[0].note).toMatch(/extension already/);
      expect(readFileSync(join(dir, 'claude_desktop_config.json'), 'utf8')).toBe('{"mcpServers":{}}');
    } finally {
      if (xdg !== undefined) process.env.XDG_CONFIG_HOME = xdg;
    }
  });

  it('runs an MCP server, or from an unwritable folder, in its own home', async () => {
    const { workingFolder } = await import('../kit/cwd.js');
    expect(workingFolder('mcp', 'C:\\Windows\\System32', '/h', () => false)).toBe('/h');
    expect(workingFolder('mcp', '/work', '/h', () => true)).toBe('/h');
    expect(workingFolder('status', '/work', '/h', () => true)).toBe('/work');
    expect(workingFolder('status', 'C:\\Windows\\System32', '/h', () => false)).toBe('/h');
  });

  it('checks a Blockfrost key before keeping it', async () => {
    const { checkBlockfrost } = await import('../kit/setup.js');
    const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    expect(await checkBlockfrost('good', 'preprod', answer(200))).toEqual({ ok: true });
    expect((await checkBlockfrost('bad', 'preprod', answer(403))).why).toMatch(/doesn't accept that key/);
    expect((await checkBlockfrost('x', 'preprod', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).why).toMatch(/couldn't reach Blockfrost \(offline\)/);
  });
});
