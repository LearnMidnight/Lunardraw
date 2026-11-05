/**
 * One agent per computer. Every AI app connected to Lunardraw starts its own
 * `lunardraw-agent mcp`, but a wallet can only be open in one program at a
 * time (wallet-lock.ts). So the first one to start becomes the agent's
 * **host**: it opens the wallet and answers on a local web address,
 * http://127.0.0.1:6338 (the port is config.json's "port"). The others pass
 * their AI's requests to it, and if it stops (its app was closed), the next
 * one to need it takes over.
 *
 * The local address speaks:
 *
 *   POST /mcp        MCP over HTTP (Streamable HTTP, JSON answers), for apps and agents that use that
 *   /api/...         a small REST API (/openapi.json describes it), for your own programs
 *   GET  /health     whether it's running, and for which home (no key needed)
 *
 * Everything but /health and /openapi.json needs the key in
 * ~/.lunardraw-agent/agent-token.secret, as `Authorization: Bearer <key>`:
 * another program on the computer, or a web page, can't spend from the
 * wallet without it. It only answers on 127.0.0.1 unless `serve --host` says
 * otherwise (for an agent in a container, say).
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BUY_SCHEMA, handle, type Rpc, SERVER_INFO, type Tool } from './mcp.js';

export type { Rpc };

/** Which agent a host serves (a hash of its home folder, so two agents on one computer don't mix). */
export const homeId = (home: string): string => createHash('sha256').update(home).digest('hex').slice(0, 16);

export type Health = { lunardraw: 'agent'; version: string; home: string; pid: number; since: string };

/** The REST API: route → tool. */
const ROUTES: { method: 'GET' | 'POST'; path: string; tool: string; summary: string }[] = [
  { method: 'GET', path: '/api/rules', tool: 'lunardraw_how_to_play', summary: 'The rules, prices, prize divisions, odds and the owner\'s limits' },
  { method: 'GET', path: '/api/draw', tool: 'lunardraw_draw_on_sale', summary: 'The draw on sale, the jackpot estimate and the latest results' },
  { method: 'GET', path: '/api/wallet', tool: 'lunardraw_wallet', summary: 'The wallet\'s address, tNIGHT and DUST' },
  { method: 'GET', path: '/api/tickets', tool: 'lunardraw_my_tickets', summary: 'Every ticket bought, each draw\'s result, and a purchase on its way' },
  { method: 'POST', path: '/api/buy', tool: 'lunardraw_buy_tickets', summary: 'Buy for the draw on sale (answers within 45 s; a purchase still on its way says "buying")' },
];

export const openApi = (port: number) => ({
  openapi: '3.1.0',
  info: { title: 'Lunardraw agent', version: SERVER_INFO.version, description: "Play Starfall, Lunardraw's lottery on the Midnight Preprod test network (tNIGHT test tokens, no value), from this computer's agent wallet. Send the key in agent-token.secret as a Bearer token." },
  servers: [{ url: `http://127.0.0.1:${port}` }],
  components: { securitySchemes: { key: { type: 'http', scheme: 'bearer' } } },
  security: [{ key: [] }],
  paths: Object.fromEntries(
    ROUTES.map((r) => [
      r.path,
      {
        [r.method.toLowerCase()]: {
          operationId: r.tool.replace(/^lunardraw_/, ''),
          summary: r.summary,
          ...(r.method === 'POST' ? { requestBody: { required: true, content: { 'application/json': { schema: BUY_SCHEMA } } } } : {}),
          responses: { 200: { description: 'The answer (JSON)' }, 400: { description: 'Refused: { error }' }, 401: { description: 'No key, or the wrong one' } },
        },
      },
    ]),
  ),
});

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const readBody = async (req: IncomingMessage, limit = 256 * 1024): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};

/** A tool's text answer as JSON (it's JSON for every tool but the rules). */
const asJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

/** Answer MCP JSON-RPC over HTTP with the agent's tools (or, for a passer-on, whatever `call` does). */
export const mcpOverHttp = async (body: string, call: (msg: Rpc) => Promise<object | undefined>): Promise<{ status: number; body?: unknown }> => {
  let msg: Rpc | Rpc[];
  try {
    msg = JSON.parse(body) as Rpc | Rpc[];
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } } };
  }
  if (Array.isArray(msg)) {
    const answers = (await Promise.all(msg.map(call))).filter((a): a is object => !!a);
    return answers.length ? { status: 200, body: answers } : { status: 202 };
  }
  const answer = await call(msg);
  return answer ? { status: 200, body: answer } : { status: 202 };
};

/**
 * The agent's local web address. `call` answers MCP messages (the tools
 * here, or the host's when passing on); `tools` runs the REST API.
 */
export const serveHost = (o: {
  tools: Tool[];
  token: string;
  home: string;
  port: number;
  host?: string;
  log?: (m: string) => void;
}): Promise<Server> => {
  const since = new Date().toISOString();
  const call = (msg: Rpc) => handle(msg, o.tools, () => undefined);
  const local = !o.host || o.host === '127.0.0.1' || o.host === 'localhost' || o.host === '::1';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      // a web page that tricks a browser into calling this address (DNS rebinding) is turned away
      if (local && !LOOPBACK.test(req.headers.host ?? '')) return send(res, 403, { error: 'wrong host' });
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return send(res, 403, { error: 'not from a web page' });
      if (req.method === 'GET' && url.pathname === '/health') {
        const health: Health = { lunardraw: 'agent', version: SERVER_INFO.version, home: homeId(o.home), pid: process.pid, since };
        return send(res, 200, health);
      }
      if (req.method === 'GET' && url.pathname === '/openapi.json') return send(res, 200, openApi(o.port));
      if (req.headers.authorization !== `Bearer ${o.token}`) {
        res.setHeader('www-authenticate', 'Bearer');
        return send(res, 401, { error: 'the key is missing or wrong: send the one in agent-token.secret as "Authorization: Bearer <key>"' });
      }
      if (url.pathname === '/mcp') {
        if (req.method === 'POST') {
          const out = await mcpOverHttp(await readBody(req), call);
          if (out.body === undefined) {
            res.writeHead(out.status);
            return res.end();
          }
          return send(res, out.status, out.body);
        }
        res.setHeader('allow', 'POST');
        return send(res, 405, { error: 'POST MCP messages here (this server answers with JSON; it has no event stream)' });
      }
      const route = ROUTES.find((r) => r.path === url.pathname);
      if (route) {
        if (req.method !== route.method) {
          res.setHeader('allow', route.method);
          return send(res, 405, { error: `use ${route.method}` });
        }
        const tool = o.tools.find((t) => t.name === route.tool)!;
        let args: Record<string, unknown> = {};
        if (route.method === 'POST') {
          const text = await readBody(req);
          try {
            args = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            return send(res, 400, { error: 'the body must be JSON' });
          }
        }
        try {
          const out = await tool.run(args, () => undefined);
          return send(res, out.isError ? 400 : 200, out.isError ? { error: out.text } : asJson(out.text));
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return send(res, 404, { error: 'not here: see /openapi.json' });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      o.log?.(`local address: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 10 * 60_000; // a REST purchase may wait for a slow answer
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
};

export const portOf = (server: Server): number => (server.address() as AddressInfo).port;

/**
 * Who answers on the port: this home's agent ('ours', with its health),
 * something else ('other': another program, or another home's agent), or
 * nothing in time ('none': no server, or one too busy to answer, such as an
 * agent opening its wallet).
 */
export const probeHost = async (
  port: number,
  home: string,
  fetchFn: typeof fetch = fetch,
  ms = 2_000,
): Promise<{ kind: 'ours'; health: Health } | { kind: 'other' } | { kind: 'none' }> => {
  let r: Response;
  try {
    r = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(ms) });
  } catch {
    return { kind: 'none' };
  }
  try {
    const h = (await r.json()) as Health;
    return r.ok && h.lunardraw === 'agent' && h.home === homeId(home) ? { kind: 'ours', health: h } : { kind: 'other' };
  } catch {
    return { kind: 'other' };
  }
};

/** The agent running on this computer for this home, if there is one (and it answers within 2 s). */
export const findHost = async (port: number, home: string, fetchFn: typeof fetch = fetch): Promise<Health | undefined> => {
  const p = await probeHost(port, home, fetchFn);
  return p.kind === 'ours' ? p.health : undefined;
};

/** Pass an MCP message to the host; undefined for a notification. Throws if the host can't be reached. */
export const callHost = async (port: number, token: string, msg: Rpc, fetchFn: typeof fetch = fetch): Promise<object | undefined> => {
  const r = await fetchFn(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (r.status === 202) return undefined;
  if (r.status === 401) throw new Error('the agent running on this computer refused the key in agent-token.secret');
  return (await r.json()) as object;
};

type Notify = (method: string, params: Record<string, unknown>) => void;

export type Backend = {
  /** Answer one MCP message (`notify` gets progress, when this process is the host). */
  call(msg: Rpc, notify?: Notify): Promise<object | undefined>;
  /** 'host' (this process has the wallet) or 'passing on' (to the host). */
  mode(): 'host' | 'passing on' | 'alone';
  /** Passing on to a host that has stopped? Take over now. */
  ensure(): Promise<void>;
  /** Stop answering on the local address (this process stops being the host). */
  close(): Promise<void>;
};

/**
 * The agent for this process: the host if one is running for this home,
 * else this process becomes the host (opening the wallet). A passer-on whose
 * host stops takes over on the next message. `makeTools` is called only once
 * this process is the host, so two processes never open the wallet at once.
 */
export const agentBackend = async (o: {
  home: string;
  port: number;
  token: string;
  makeTools: () => Tool[];
  /** Where the local address answers (127.0.0.1 unless asked: 0.0.0.0 for an agent in a container, say). */
  bind?: string;
  /** How long to keep asking a port's holder who it is, when it's too busy to answer (ms). */
  settleMs?: number;
  log?: (m: string) => void;
  /** For tests. */
  fetchFn?: typeof fetch;
}): Promise<Backend> => {
  let tools: Tool[] | undefined;
  let server: Server | undefined;
  let mode: 'host' | 'passing on' | 'alone' = 'passing on';
  const become = async (): Promise<void> => {
    if (tools) return;
    // the port first: whoever gets it is the host (and opens the wallet); the rest pass on
    try {
      const placeholder: Tool[] = [];
      server = await serveHost({ tools: placeholder, token: o.token, home: o.home, port: o.port, host: o.bind, log: o.log });
      tools = o.makeTools();
      placeholder.push(...tools);
      server.unref();
      mode = 'host';
      o.log?.(`the agent is running here, on http://127.0.0.1:${o.port}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      // Someone has the port. Very likely our own agent that started a moment earlier (an app
      // can start two servers at once) and is busy opening the wallet, so slow to answer: keep
      // asking. Opening the wallet here too would clash with it ("wallet in use").
      const until = Date.now() + (o.settleMs ?? 30_000);
      for (;;) {
        const who = await probeHost(o.port, o.home, o.fetchFn, 5_000);
        if (who.kind === 'ours') {
          mode = 'passing on';
          return;
        }
        if (who.kind === 'other') {
          // another program (or another home's agent) has the port: work on our own, as before
          tools = o.makeTools();
          mode = 'alone';
          o.log?.(`port ${o.port} is taken by another program, so this agent runs on its own (set "port" in config.json to use another)`);
          return;
        }
        if (Date.now() > until) {
          // still no answer: pass on anyway; calls retry, and take over if it has gone
          mode = 'passing on';
          o.log?.(`port ${o.port} is taken but its holder doesn't answer yet; passing requests to it`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  };
  if (!(await findHost(o.port, o.home, o.fetchFn))) await become();
  else o.log?.(`passing requests to the agent already running on this computer (port ${o.port})`);
  return {
    mode: () => mode,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    ensure: async () => {
      if (!tools && !(await findHost(o.port, o.home, o.fetchFn))) {
        o.log?.('the agent this was passing requests to has stopped; taking over');
        await become();
      }
    },
    call: async (msg, notify = () => undefined) => {
      if (tools) return handle(msg, tools, notify);
      try {
        return await callHost(o.port, o.token, msg, o.fetchFn);
      } catch (err) {
        if (err instanceof Error && /refused the key/.test(err.message)) throw err;
        // the host stopped (its app closed): take over
        o.log?.('the agent this was passing requests to has stopped; taking over');
        await become();
        return tools ? handle(msg, tools, notify) : callHost(o.port, o.token, msg, o.fetchFn);
      }
    },
  };
};
