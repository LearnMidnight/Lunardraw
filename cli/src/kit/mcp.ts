/**
 * `lunardraw-agent mcp`: the kit as an MCP server (stdio), so AI apps and
 * agents can play Starfall with the agent's wallet.
 *
 * A small implementation of MCP's JSON-RPC over stdio (initialize, ping,
 * tools/list, tools/call, progress notifications), with no SDK dependency.
 * stdout carries the protocol only: everything else the kit prints goes to
 * stderr (see `serveStdio`).
 *
 * The tools never change the owner's spending limits: they live in the
 * owner's config file, and a purchase over them is refused.
 */
import { createInterface } from 'node:readline';
import { Starfall } from '@lunardraw/contract';

export type ToolText = { text: string; isError?: boolean };

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  /** `progress` reports what a slow call is doing (keeps clients from timing out). */
  run(args: Record<string, unknown>, progress: (message: string) => void): Promise<ToolText>;
};

export const SERVER_INFO = { name: 'lunardraw', title: 'Lunardraw', version: '0.1.3' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS =
  'Lunardraw runs Starfall, a lottery on the Midnight Preprod test network (tNIGHT test tokens with no value). ' +
  'Draws close on the hour on Preprod. A game is 7 numbers from 1-35 plus a Moonball from 1-20 and costs 1.2 tNIGHT; prizes and refunds ' +
  "are paid to the agent's wallet automatically (no claiming). Check lunardraw_draw_on_sale before buying. Purchases are limited by the owner's " +
  'spending limits, which you cannot change. Opening the wallet takes a few minutes the first time in a session; a purchase takes 2-3 minutes.';

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/**
 * Handle one JSON-RPC message; returns the response, or undefined for a
 * notification. `notify` sends a server notification (progress).
 */
export const handle = async (msg: Rpc, tools: Tool[], notify: (method: string, params: Record<string, unknown>) => void): Promise<object | undefined> => {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return undefined; // notifications (initialized, cancelled) need no answer
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool ${name}`);
      const token = (msg.params?._meta as { progressToken?: string | number } | undefined)?.progressToken;
      let step = 0;
      const progress = (message: string) => {
        if (token !== undefined) notify('notifications/progress', { progressToken: token, progress: ++step, message });
      };
      try {
        const out = await tool.run((msg.params?.arguments as Record<string, unknown>) ?? {}, progress);
        return reply({ content: [{ type: 'text', text: out.text }], isError: out.isError ?? false });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
};

/**
 * Serve over stdin/stdout until stdin closes. Everything else written to
 * stdout (console.log, process.stdout.write) is sent to stderr instead.
 */
export const serveStdio = async (tools: Tool[]): Promise<void> => {
  const out = process.stdout.write.bind(process.stdout) as (s: string) => boolean;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  console.log = console.error;
  const send = (obj: object) => out(JSON.stringify(obj) + '\n');
  const notify = (method: string, params: Record<string, unknown>) => send({ jsonrpc: '2.0', method, params });
  const rl = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    // calls run side by side (a purchase takes minutes; a status check shouldn't wait for it)
    const p = handle(msg, tools, notify).then((r) => {
      if (r) send(r);
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
};

// ------------------------------------------------------------------ tool inputs

/** The buy tool's input schema: the same choices as `lunardraw-agent buy`. */
export const BUY_SCHEMA = {
  type: 'object',
  properties: {
    games: { type: 'integer', minimum: 1, maximum: 50, description: 'QuickPick: this many random games (one ticket each).' },
    package: { type: 'string', enum: Object.keys(Starfall.QUICK_PICK_PACKAGES), description: 'A QuickPick package instead of games.' },
    numbers: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 35 }, description: 'Your own numbers: 7 for a standard game, 8-12 with system, 5-6 with pick.' },
    moonball: { type: 'integer', minimum: 1, maximum: 20, description: 'Your own Moonball (random if left out).' },
    system: { type: 'integer', minimum: 8, maximum: 12, description: 'A System entry: every 7 of these 8-12 numbers.' },
    pick: { type: 'integer', enum: [5, 6], description: 'A Pick entry: your 5 or 6 numbers completed every way.' },
    sweep: { type: 'boolean', description: 'Moonball Sweep: play every Moonball (20 times the games).' },
  },
  additionalProperties: false,
};

/** Tool arguments to `buyEntries`' string options. */
export const buyArgs = (a: Record<string, unknown>) => {
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  const numbers = Array.isArray(a.numbers) ? a.numbers.map(Number).join(' ') : str(a.numbers);
  return {
    games: str(a.games),
    package: str(a.package),
    numbers,
    moonball: str(a.moonball),
    system: str(a.system),
    pick: str(a.pick),
    sweep: a.sweep === true,
  };
};
