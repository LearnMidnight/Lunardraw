/**
 * The agent registry behind lunardraw.io's agent directory (`./lunardraw
 * registry`, run on the keeper VM behind Caddy).
 *
 * - Lunardraw's own agents (the `lunardraw-agent@<name>` services) are read
 *   from their state files and the feed: real purchases, real results.
 * - Anyone else's agent is listed when its owner opts in: the agent kit sends
 *   a report signed with the agent wallet's key (listing.ts). The registry
 *   checks the signature, that it is recent, and that the name isn't taken.
 *
 * GET  /agents/agents.json  the directory (what the website shows)
 * POST /agents/report       a signed listing report ({ payload, signature })
 * GET  /agents/health       ok
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type AgentStats, agentStats, type DrawOutcome, emptyStats, LISTING_PREFIX, type ListingPayload, listingProblem, type Via } from './listing.js';
import { loadAgentState } from './starfall-agent.js';

export type DirectoryAgent = {
  id: string;
  name: string;
  /** `lunardraw` for Lunardraw's own agents; how a listed agent plays otherwise. */
  via: Via | 'lunardraw';
  house: boolean;
  status: 'online' | 'idle' | 'offline';
  style: string;
  stats: AgentStats;
  /** First purchase or first listing (ISO). */
  joined?: string;
  last_seen?: string;
  /** mn_addr_... (listed agents). */
  address?: string;
};

export type DirectoryEvent = { at: string; agent: string; text: string };

export type Directory = {
  schema: 'lunardraw-agents/1';
  network: string;
  generated_at: string;
  agents: DirectoryAgent[];
  events: DirectoryEvent[];
};

type Listed = {
  address: string;
  key: string;
  name: string;
  style: string;
  via: Via;
  stats: AgentStats;
  joined: string;
  last_seen: string;
};

type Store = { listed: Record<string, Listed>; events: DirectoryEvent[]; hidden: string[] };

export type Verifier = {
  /** Whether `signature` over `data` is valid for `key`. */
  verify(key: string, data: Uint8Array, signature: string): boolean;
  /** The bech32 address for a verifying key on this network. */
  address(key: string): Promise<string>;
};

export type RegistryOptions = {
  network: string;
  /** Where listings are kept (listings.json). */
  dir: string;
  /** The site feed (feed.json): the draws' numbers and prizes. */
  feedPath: string;
  /** The house agents' folder: <name>.env and <name>.state.json. */
  houseDir: string;
  verifier: Verifier;
  /** Whether a systemd unit is active (house agents' online/offline). */
  isActive?: (unit: string) => Promise<boolean>;
  now?: () => number;
  maxListed?: number;
};

const STYLES: Record<string, string> = {
  mix: 'A bit of everything',
  quickpick: 'QuickPicks',
  lucky: 'Same numbers every draw',
  moonhit: 'Every Moonball',
  system: 'System entries',
};

const run = promisify(execFile);
export const systemdActive = async (unit: string): Promise<boolean> => {
  try {
    const { stdout } = await run('systemctl', ['is-active', unit]);
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
};

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const HOUR = 3_600_000;

/** online: played or reported in the last 2 hours; idle: in the last 2 days; else offline. */
const statusOf = (lastSeenMs: number | undefined, now: number): DirectoryAgent['status'] =>
  lastSeenMs === undefined ? 'offline' : now - lastSeenMs < 2 * HOUR ? 'online' : now - lastSeenMs < 48 * HOUR ? 'idle' : 'offline';

export const createRegistry = (o: RegistryOptions) => {
  const now = o.now ?? Date.now;
  const isActive = o.isActive ?? systemdActive;
  const storePath = join(o.dir, 'listings.json');
  const maxListed = o.maxListed ?? 500;
  const lastReport = new Map<string, number>();

  const load = (): Store => {
    try {
      const s = JSON.parse(readFileSync(storePath, 'utf8')) as Partial<Store>;
      return { listed: s.listed ?? {}, events: s.events ?? [], hidden: s.hidden ?? [] };
    } catch {
      return { listed: {}, events: [], hidden: [] };
    }
  };
  const save = (s: Store) => {
    mkdirSync(o.dir, { recursive: true });
    writeFileSync(`${storePath}.tmp`, JSON.stringify(s, null, 2) + '\n');
    renameSync(`${storePath}.tmp`, storePath);
  };

  const draws = (): DrawOutcome[] => {
    try {
      const feed = JSON.parse(readFileSync(o.feedPath, 'utf8')) as { games?: { starfall?: { draws?: DrawOutcome[] } } };
      return feed.games?.starfall?.draws ?? [];
    } catch {
      return [];
    }
  };

  const house = async (outcomes: DrawOutcome[]): Promise<{ agents: DirectoryAgent[]; events: DirectoryEvent[] }> => {
    if (!existsSync(o.houseDir)) return { agents: [], events: [] };
    const names = readdirSync(o.houseDir)
      .filter((f) => f.endsWith('.env'))
      .map((f) => f.slice(0, -4))
      .filter((n) => /^[a-z0-9-]+$/.test(n));
    const agents: DirectoryAgent[] = [];
    const events: DirectoryEvent[] = [];
    for (const n of names) {
      const statePath = join(o.houseDir, `${n}.state.json`);
      const state = loadAgentState(statePath);
      const env = readFileSync(join(o.houseDir, `${n}.env`), 'utf8');
      const style = /--style\s+(\w+)/.exec(env)?.[1] ?? 'mix';
      const stats = agentStats(state, outcomes);
      const active = await isActive(`lunardraw-agent@${n}`);
      const seen = existsSync(statePath) ? statSync(statePath).mtimeMs : undefined;
      const name = n.toUpperCase();
      agents.push({
        id: slug(n),
        name,
        via: 'lunardraw',
        house: true,
        status: active ? 'online' : statusOf(seen, now()) === 'online' ? 'idle' : 'offline',
        style: STYLES[style] ?? style,
        stats,
        joined: stats.first_played,
        last_seen: seen ? new Date(seen).toISOString() : undefined,
      });
      for (const p of state.purchases.slice(-10)) {
        events.push({ at: p.at, agent: name, text: `bought ${p.games} game${p.games === 1 ? '' : 's'} in draw ${p.draw}` });
      }
    }
    return { agents, events };
  };

  /** The directory: house agents first in ties, then by tNIGHT won, winning games, games. */
  const directory = async (): Promise<Directory> => {
    const outcomes = draws();
    const h = await house(outcomes);
    const s = load();
    const t = now();
    const listed: DirectoryAgent[] = Object.values(s.listed)
      .filter((l) => !s.hidden.includes(l.address) && !s.hidden.includes(slug(l.name)))
      .map((l) => ({
        id: slug(l.name),
        name: l.name,
        via: l.via,
        house: false,
        status: statusOf(Date.parse(l.last_seen), t),
        style: l.style,
        stats: l.stats,
        joined: l.joined,
        last_seen: l.last_seen,
        address: l.address,
      }));
    const agents = [...h.agents, ...listed].sort(
      (a, b) => b.stats.won_star - a.stats.won_star || b.stats.winning_games - a.stats.winning_games || b.stats.games - a.stats.games || Number(b.house) - Number(a.house),
    );
    const shown = new Set(listed.map((a) => a.name));
    const events = [...h.events, ...s.events.filter((e) => shown.has(e.agent))].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 30);
    return { schema: 'lunardraw-agents/1', network: o.network, generated_at: new Date(t).toISOString(), agents, events };
  };

  /** Check and apply a signed report; returns a message, or throws with the reason it was refused. */
  const report = async (body: unknown): Promise<string> => {
    const b = body as { payload?: unknown; signature?: unknown };
    if (typeof b?.payload !== 'string' || typeof b.signature !== 'string' || b.payload.length > 4000) throw new Refused('expected { payload, signature }');
    let p: ListingPayload;
    try {
      p = JSON.parse(b.payload) as ListingPayload;
    } catch {
      throw new Refused('the payload is not JSON');
    }
    if (p.v !== 1 || typeof p.key !== 'string' || !/^[0-9a-f]{40,200}$/i.test(p.key)) throw new Refused('unknown payload version or key');
    if (p.network !== o.network) throw new Refused(`this registry is for ${o.network}`);
    const at = Date.parse(p.at);
    if (!Number.isFinite(at) || Math.abs(now() - at) > 10 * 60_000) throw new Refused('the report is more than 10 minutes old (or from the future): check the clock');
    if (!o.verifier.verify(p.key, new TextEncoder().encode(LISTING_PREFIX + b.payload), b.signature)) throw new Refused("the signature doesn't match the key");
    const address = await o.verifier.address(p.key);
    const last = lastReport.get(address);
    if (last !== undefined && now() - last < 30_000) throw new Refused('too many reports: one every 30 seconds');
    lastReport.set(address, now());

    const s = load();
    if (p.action === 'unlist') {
      delete s.listed[address];
      save(s);
      return 'unlisted';
    }
    if (p.action !== 'list') throw new Refused('action must be list or unlist');
    const problem = listingProblem(p);
    if (problem) throw new Refused(problem);
    const stats = cleanStats(p.stats);
    const houseNames = existsSync(o.houseDir) ? readdirSync(o.houseDir).filter((f) => f.endsWith('.env')).map((f) => slug(f.slice(0, -4))) : [];
    const taken = Object.values(s.listed).find((l) => slug(l.name) === slug(p.name) && l.address !== address);
    if (taken || houseNames.includes(slug(p.name))) throw new Refused(`the name ${p.name} is taken: choose another`);
    const before = s.listed[address];
    if (!before && Object.keys(s.listed).length >= maxListed) throw new Refused('the directory is full for now');
    const iso = new Date(now()).toISOString();
    s.listed[address] = { address, key: p.key, name: p.name, style: p.style, via: p.via, stats, joined: before?.joined ?? iso, last_seen: iso };
    // what changed, for the activity panel
    if (!before) s.events.push({ at: iso, agent: p.name, text: 'joined the directory' });
    else {
      if (stats.games > before.stats.games && stats.last_draw) s.events.push({ at: iso, agent: p.name, text: `bought ${stats.games - before.stats.games} game${stats.games - before.stats.games === 1 ? '' : 's'} in draw ${stats.last_draw}` });
      if (stats.won_star > before.stats.won_star) s.events.push({ at: iso, agent: p.name, text: `won ${(stats.won_star - before.stats.won_star) / 1e6} tNIGHT` });
    }
    s.events = s.events.slice(-200);
    save(s);
    return before ? 'updated' : 'listed';
  };

  return { directory, report };
};

export class Refused extends Error {}

const cleanStats = (x: unknown): AgentStats => {
  const s = (x ?? {}) as Record<string, unknown>;
  const n = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0);
  const iso = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined);
  const out: AgentStats = {
    ...emptyStats(),
    draws: n(s.draws, 1e6),
    games: n(s.games, 1e9),
    spent_star: n(s.spent_star, 1e15),
    winning_games: n(s.winning_games, 1e9),
    won_star: n(s.won_star, 1e15),
  };
  const last = n(s.last_draw, 1e9);
  if (last) out.last_draw = last;
  const first = iso(s.first_played);
  const lastPlayed = iso(s.last_played);
  if (first) out.first_played = first;
  if (lastPlayed) out.last_played = lastPlayed;
  return out;
};

/** Midnight's signature check (ledger-v8): the key, the signature, and the address it makes. */
export const ledgerVerifier = async (network: string): Promise<Verifier> => {
  const ledger = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const { bech32Address } = await import('./listing.js');
  return {
    verify: (key, data, signature) => {
      try {
        return ledger.verifySignature(key as never, data, signature as never);
      } catch {
        return false;
      }
    },
    address: (key) => bech32Address(ledger.addressFromKey(key as never) as unknown as string, network),
  };
};

/** Serve the registry over HTTP (behind Caddy, on 127.0.0.1). */
export const serveRegistry = (registry: ReturnType<typeof createRegistry>, port: number, host = '127.0.0.1', log: (m: string) => void = () => undefined) => {
  let cached: { at: number; body: string } | undefined;
  const send = (res: ServerResponse, code: number, body: string, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': code === 200 ? 'public, max-age=30' : 'no-store', 'access-control-allow-origin': '*' });
    res.end(body);
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/agents/health') return send(res, 200, '{"ok":true}');
      if (req.method === 'GET' && url.pathname === '/agents/agents.json') {
        if (!cached || Date.now() - cached.at > 30_000) cached = { at: Date.now(), body: JSON.stringify(await registry.directory(), null, 1) };
        return send(res, 200, cached.body);
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/agents/report') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > 8192) return send(res, 413, '{"error":"too large"}');
          chunks.push(c as Buffer);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(res, 400, '{"error":"not JSON"}');
        }
        try {
          const result = await registry.report(body);
          cached = undefined;
          log(`report: ${result}`);
          return send(res, 200, JSON.stringify({ ok: true, result }));
        } catch (err) {
          if (err instanceof Refused) return send(res, 400, JSON.stringify({ error: err.message }));
          throw err;
        }
      }
      return send(res, 404, '{"error":"not found"}');
    } catch (err) {
      log(`error: ${err instanceof Error ? err.message : String(err)}`);
      return send(res, 500, '{"error":"internal"}');
    }
  });
  server.listen(port, host);
  return server;
};
