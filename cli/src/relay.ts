/**
 * Lunardraw's relay: lets AIs on the web or a phone (ChatGPT, claude.ai and
 * any app that adds an MCP server by its web address) play with an agent
 * that runs on its owner's computer. Run as lunardraw-relay.service on the
 * keeper VM, behind Caddy (`handle /relay/*`).
 *
 *   POST /relay/mcp/<secret>   an AI app's MCP messages (Streamable HTTP, JSON answers)
 *   POST /relay/link/poll      the agent asks for work (Bearer <secret>), held up to 25 s
 *   POST /relay/link/answer    the agent's answer to one request (Bearer <secret>)
 *   GET  /relay/health
 *
 * It holds no wallet, no keys and nothing on disk: only, while an agent is
 * linked, a hash of its secret and the messages on their way. The agent
 * makes every decision (its own limits, its own wallet); the relay only
 * passes messages along. While an agent is away, the relay answers for it:
 * the tools are listed (so the app can still be set up) and calling one says
 * the agent isn't running.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { INSTRUCTIONS, type Rpc, SERVER_INFO } from './kit/mcp.js';
import { TOOL_DEFS } from './kit/tool-defs.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export type RelayOptions = {
  /** How long a poll is held when there's no work (ms). */
  pollMs?: number;
  /** How long an AI's request waits for the agent's answer (ms). */
  answerMs?: number;
  /** An agent that hasn't polled for this long is away (ms). */
  awayMs?: number;
  /** Requests a minute an AI app may send to one agent. */
  perMinute?: number;
  maxLinks?: number;
  now?: () => number;
  log?: (m: string) => void;
};

type Waiting = { resolve: (answer: object | null) => void; timer: NodeJS.Timeout };
type Link = {
  lastPoll: number;
  poll?: (requests: { id: string; body: Rpc }[]) => void;
  queue: { id: string; body: Rpc }[];
  waiting: Map<string, Waiting>;
  minute: { start: number; count: number };
};

export const linkId = (secret: string): string => createHash('sha256').update(secret).digest('hex');
const goodSecret = (s: string | undefined): s is string => !!s && /^[A-Za-z0-9_-]{32,128}$/.test(s);

export const AWAY_TEXT =
  "This Lunardraw agent isn't connected right now. It runs on its owner's computer: they need that computer on, " +
  'with the agent running (`lunardraw-agent remote` sets it to start when they sign in). Nothing was bought.';

export const createRelay = (o: RelayOptions = {}) => {
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 25_000;
  const answerMs = o.answerMs ?? 58_000;
  const awayMs = o.awayMs ?? 45_000;
  const perMinute = o.perMinute ?? 60;
  const maxLinks = o.maxLinks ?? 2_000;
  const links = new Map<string, Link>();

  const linkFor = (id: string, create: boolean): Link | undefined => {
    let link = links.get(id);
    if (!link && create) {
      if (links.size >= maxLinks) {
        // make room: forget agents that have been away longest
        const old = [...links].filter(([, l]) => !l.poll && now() - l.lastPoll > 10 * 60_000).sort((a, b) => a[1].lastPoll - b[1].lastPoll);
        for (const [k] of old.slice(0, Math.max(1, Math.floor(maxLinks / 10)))) links.delete(k);
        if (links.size >= maxLinks) return undefined;
      }
      link = { lastPoll: now(), queue: [], waiting: new Map(), minute: { start: now(), count: 0 } };
      links.set(id, link);
    }
    return link;
  };
  const online = (link: Link | undefined) => !!link && (!!link.poll || now() - link.lastPoll < awayMs);

  /** The answer for an agent that's away. */
  const answerAway = (msg: Rpc): object | undefined => {
    if (msg.id === undefined || msg.id === null) return undefined;
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
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
        return reply({ tools: TOOL_DEFS });
      case 'tools/call':
        return reply({ content: [{ type: 'text', text: AWAY_TEXT }], isError: true });
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
    }
  };

  /** One MCP message from an AI app, for the agent whose secret is in its address. */
  const fromApp = async (secret: string, msg: Rpc): Promise<object | undefined> => {
    const id = linkId(secret);
    const link = links.get(id);
    if (!online(link)) return answerAway(msg);
    if (msg.id === undefined || msg.id === null) return undefined; // notifications: the agent needs none of them
    const l = link!;
    if (now() - l.minute.start > 60_000) l.minute = { start: now(), count: 0 };
    if (++l.minute.count > perMinute) return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'too many requests: try again in a minute' } };
    if (l.queue.length + l.waiting.size > 20) return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'the agent is busy: try again shortly' } };
    const reqId = randomUUID();
    const answer = new Promise<object | null>((resolve) => {
      const timer = setTimeout(() => {
        l.waiting.delete(reqId);
        resolve(null);
      }, answerMs);
      l.waiting.set(reqId, { resolve, timer });
    });
    l.queue.push({ id: reqId, body: msg });
    if (l.poll) {
      const p = l.poll;
      l.poll = undefined;
      p(l.queue.splice(0, 10));
    }
    const got = await answer;
    if (got) return got;
    if (msg.method === 'tools/call') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: "The agent didn't answer in time. If this was a purchase it may still be on its way: check lunardraw_my_tickets before buying again." }], isError: true },
      };
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: "the agent didn't answer in time" } };
  };

  /** The agent asks for work: the queued requests, or wait for some (up to pollMs). */
  const poll = (secret: string): Promise<{ id: string; body: Rpc }[]> | undefined => {
    const fresh = !links.has(linkId(secret));
    const link = linkFor(linkId(secret), true);
    if (!link) return undefined;
    link.lastPoll = now();
    if (fresh) return Promise.resolve([]); // the first poll answers at once, so the agent knows it's linked
    if (link.poll) link.poll([]); // a newer poll for the same link replaces the old one
    link.poll = undefined;
    if (link.queue.length) return Promise.resolve(link.queue.splice(0, 10));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (link.poll === done) link.poll = undefined;
        link.lastPoll = now();
        resolve([]);
      }, pollMs);
      const done = (requests: { id: string; body: Rpc }[]) => {
        clearTimeout(timer);
        link.lastPoll = now();
        resolve(requests);
      };
      link.poll = done;
    });
  };

  /** The agent's answer to one request; false if nobody's waiting for it any more. */
  const answer = (secret: string, reqId: string, response: object | null): boolean => {
    const link = links.get(linkId(secret));
    const w = link?.waiting.get(reqId);
    if (!link || !w) return false;
    clearTimeout(w.timer);
    link.waiting.delete(reqId);
    w.resolve(response ?? { jsonrpc: '2.0', id: null, result: {} });
    return true;
  };

  /** Work a poll took but couldn't hand over (the agent's connection dropped): back to the front of the line. */
  const requeue = (secret: string, requests: { id: string; body: Rpc }[]): void => {
    const link = links.get(linkId(secret));
    if (link && requests.length) link.queue.unshift(...requests.filter((r) => link.waiting.has(r.id)));
  };

  return { fromApp, poll, answer, requeue, online: (secret: string) => online(links.get(linkId(secret))), size: () => links.size };
};

// ------------------------------------------------------------------ over HTTP

const readBody = async (req: IncomingMessage, limit: number): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) return undefined;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-session-id',
};

export const serveRelay = (relay: ReturnType<typeof createRelay>, port: number, host = '127.0.0.1', log: (m: string) => void = () => undefined): Server => {
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { ...CORS, 'cache-control': 'no-store', ...(body === undefined ? {} : { 'content-type': 'application/json' }) });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.replace(/\/+$/, '');
      if (req.method === 'OPTIONS') return send(res, 204);
      if (req.method === 'GET' && path === '/relay/health') return send(res, 200, { ok: true, links: relay.size() });

      // an AI app
      const app = /^\/relay\/mcp\/([^/]+)$/.exec(path);
      if (app) {
        const secret = app[1];
        if (!goodSecret(secret)) return send(res, 404, { error: 'no such link' });
        if (req.method === 'DELETE') return send(res, 200, {});
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          return send(res, 405, { error: 'POST MCP messages here (answers are JSON; there is no event stream)' });
        }
        const text = await readBody(req, 256 * 1024);
        if (text === undefined) return send(res, 413, { error: 'too large' });
        let msg: Rpc | Rpc[];
        try {
          msg = JSON.parse(text) as Rpc | Rpc[];
        } catch {
          return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
        if (Array.isArray(msg)) {
          const answers = (await Promise.all(msg.map((m) => relay.fromApp(secret, m)))).filter(Boolean);
          return answers.length ? send(res, 200, answers) : send(res, 202);
        }
        const answer = await relay.fromApp(secret, msg);
        return answer ? send(res, 200, answer) : send(res, 202);
      }

      // the agent
      if (req.method === 'POST' && (path === '/relay/link/poll' || path === '/relay/link/answer')) {
        const secret = bearer(req);
        if (!goodSecret(secret)) return send(res, 401, { error: 'no link secret' });
        const text = await readBody(req, path.endsWith('answer') ? 2 * 1024 * 1024 : 4 * 1024);
        if (text === undefined) return send(res, 413, { error: 'too large' });
        if (path.endsWith('poll')) {
          const work = relay.poll(secret);
          if (!work) return send(res, 503, { error: 'the relay is full: try again later' });
          let gone = false;
          res.once('close', () => (gone = true));
          const requests = await work;
          if (gone) {
            // the agent's connection dropped before its work arrived: keep the work for its next poll
            relay.requeue(secret, requests);
            return;
          }
          return send(res, 200, { requests });
        }
        let body: { id?: string; response?: object | null };
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          return send(res, 400, { error: 'not JSON' });
        }
        return relay.answer(secret, String(body.id ?? ''), body.response ?? null) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'nobody is waiting for that answer' });
      }
      return send(res, 404, { error: 'not here' });
    } catch (err) {
      log(`error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, { error: 'relay error' });
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.listen(port, host);
  return server;
};
