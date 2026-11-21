/**
 * The agent's settings page: one page in the owner's browser, on this computer, for everything an
 * owner sets: the Blockfrost key, the wallet's address and the faucet, how the first sync is going,
 * the agent's name in lunardraw.io's agent directory (and whether it's listed at all), and the
 * spending limits.
 *
 * It's served by the agent's local web address (host.ts), at http://127.0.0.1:<port>/settings, or by
 * `lunardraw-agent settings` on its own when no agent is running. The page is reached by a link
 * with a key in its #fragment (never sent to a server or kept in a log): the lunardraw_setup tool
 * makes one for the AI to hand the owner, `lunardraw-agent settings` opens one. A key works for
 * two hours, in this process only.
 *
 * An AI using the kit still can't change the limits by itself: the tools have no way to, and the
 * page answers only on this computer (127.0.0.1), to a browser page from the same address.
 */
import { webcrypto } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NAME_RULE, VIAS } from '../listing.js';
import { ensureWallet, hasBlockfrost, type KitConfig, kitHome, kitPaths, loadConfig, MAX_LIMIT, saveBlockfrost, saveConfig, useHome } from './home.js';

// ------------------------------------------------------------------ keys and what the running agent knows

const KEY_MS = 2 * 3_600_000;
const keys = new Map<string, number>();

/** A new key for the settings page (two hours). */
export const newSettingsKey = (now = Date.now()): string => {
  for (const [k, until] of keys) if (until < now) keys.delete(k);
  const key = Buffer.from(webcrypto.getRandomValues(new Uint8Array(24))).toString('base64url');
  keys.set(key, now + KEY_MS);
  return key;
};

const keyOk = (key: string | undefined, now = Date.now()): boolean => {
  if (!key) return false;
  const until = keys.get(key);
  return until !== undefined && until >= now;
};

/** The settings page's link, for a key. */
export const settingsLink = (port: number, key = newSettingsKey()): string => `http://127.0.0.1:${port}/settings#k=${key}`;

/** Where this process serves the page (set when it becomes the agent's host, or serves the page alone). */
export const settingsServing: { port?: number } = {};

/** How the agent's wallet is doing, when this process has it open (tools.ts tells). */
export type Live = { phase: 'opening' | 'syncing' | 'waiting for tNIGHT' | 'waiting for DUST' | 'ready'; synced?: number; tNight?: number; dust?: number };
let live: (() => Promise<Live | undefined>) | undefined;
export const setLive = (f: () => Promise<Live | undefined>): void => {
  live = f;
};

/** What the running agent does once a Blockfrost key is saved here (tools.ts: start opening the wallet). */
let onKey: (() => void) | undefined;
export const setOnBlockfrost = (f: () => void): void => {
  onKey = f;
};

// ------------------------------------------------------------------ what the page shows, and saving it

export const FAUCETS: Record<string, string> = {
  preprod: 'https://midnight-tmnight-preprod.nethermind.dev/',
  preview: 'https://midnight-tmnight-preview.nethermind.dev/',
};
export const DIRECTORY = 'https://lunardraw.io/agents/';
/** The price of a Starfall game, for the "about N games" hint. */
const GAME_PRICE = 1.3;

export type SettingsState = {
  network: string;
  address: string;
  faucet: string;
  blockfrost: boolean;
  limits: KitConfig['limits'];
  listing: KitConfig['listing'] | null;
  vias: readonly string[];
  directory: string;
  gamePrice: number;
  maxLimit: number;
  wallet: Live | null;
  home: string;
};

export type SettingsDeps = {
  home: string;
  /** The wallet's address for a seed (from @nightcast/deploy; injected so tests needn't load Midnight's libraries). */
  addressOf?: (network: string, seed: string) => Promise<string>;
  /** Checks a Blockfrost key (setup.ts checkBlockfrost). */
  checkKey?: (id: string, network: string) => Promise<{ ok: boolean; why?: string }>;
  /** Lists or unlists the agent in the directory (directory.ts sendListing). */
  list?: (config: KitConfig, seed: string, action: 'list' | 'unlist', listing: KitConfig['listing']) => Promise<string>;
};

const defaultAddressOf = async (network: string, seed: string) => (await import('@nightcast/deploy')).walletAddressOf(network as KitConfig['network'], seed);
const defaultCheckKey = async (id: string, network: string) => (await import('./setup.js')).checkBlockfrost(id, network);
const defaultList = async (config: KitConfig, seed: string, action: 'list' | 'unlist', listing: KitConfig['listing']) => {
  const { sendListing } = await import('./directory.js');
  return sendListing(config, seed, action, { home: kitHome(), listing });
};

export const settingsState = async (d: SettingsDeps): Promise<SettingsState> => {
  const config = loadConfig(d.home);
  const { seed } = ensureWallet(d.home);
  const wallet = live ? await Promise.race([live().catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 3_000).unref?.())]) : undefined;
  return {
    network: config.network,
    address: await (d.addressOf ?? defaultAddressOf)(config.network, seed),
    faucet: FAUCETS[config.network] ?? '',
    blockfrost: hasBlockfrost(d.home, config.network),
    limits: config.limits,
    listing: config.listing ?? null,
    vias: VIAS,
    directory: DIRECTORY,
    gamePrice: GAME_PRICE,
    maxLimit: MAX_LIMIT,
    wallet: wallet ?? null,
    home: d.home,
  };
};

export type SettingsChange = {
  blockfrost?: string;
  limits?: { perDraw?: unknown; perDay?: unknown };
  /** Listed in the directory, with this name, style and AI; or false to take it out. */
  listing?: { name?: unknown; style?: unknown; via?: unknown } | false;
};

const amount = (v: unknown, what: string): number => {
  const n = typeof v === 'string' ? Number(v.trim().replace(/,/g, '')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_LIMIT) throw new Error(`${what} must be a number of tNIGHT from 0 to ${MAX_LIMIT.toLocaleString('en')}`);
  return Math.round(n * 1e6) / 1e6;
};

/** Apply what the owner saved on the page. Each part is kept even if a later one fails. */
export const applySettings = async (d: SettingsDeps, change: SettingsChange): Promise<{ saved: string[]; errors: string[] }> => {
  const saved: string[] = [];
  const errors: string[] = [];
  let config = loadConfig(d.home);
  const { seed } = ensureWallet(d.home);

  if (typeof change.blockfrost === 'string' && change.blockfrost.trim()) {
    const id = change.blockfrost.trim();
    try {
      const check = await (d.checkKey ?? defaultCheckKey)(id, config.network);
      if (!check.ok) throw new Error((check.why ?? 'Blockfrost refused it').replace(/\*\*/g, ''));
      saveBlockfrost(id, d.home, config.network);
      useHome(config, d.home);
      onKey?.();
      saved.push(onKey ? 'Blockfrost key: checked and saved. Your agent has started syncing.' : 'Blockfrost key: checked and saved.');
    } catch (err) {
      errors.push(`Blockfrost key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (change.limits) {
    try {
      const perDraw = change.limits.perDraw === undefined ? config.limits.perDraw : amount(change.limits.perDraw, 'The limit a draw');
      const perDay = change.limits.perDay === undefined ? config.limits.perDay : amount(change.limits.perDay, 'The limit a day');
      if (perDraw !== config.limits.perDraw || perDay !== config.limits.perDay) {
        config = { ...config, limits: { perDraw, perDay } };
        saveConfig(config, d.home);
        saved.push(`Spending limits: ${perDraw} tNIGHT a draw, ${perDay} tNIGHT a day. In use from the next purchase.`);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (change.listing === false) {
    if (config.listing) {
      try {
        await (d.list ?? defaultList)(config, seed, 'unlist', config.listing);
        const { listing: _gone, ...rest } = config;
        config = rest;
        saveConfig(config, d.home);
        saved.push('Taken out of the agent directory on lunardraw.io.');
      } catch (err) {
        errors.push(`The directory: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (change.listing) {
    const name = String(change.listing.name ?? '').trim();
    const style = String(change.listing.style ?? '').trim().slice(0, 40);
    const via = String(change.listing.via ?? 'other').toLowerCase();
    if (!NAME_RULE.test(name)) errors.push('The name must be 2 to 20 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.');
    else if (!(VIAS as readonly string[]).includes(via)) errors.push(`Which AI: one of ${VIAS.join(', ')}.`);
    else {
      const listing = { name, style, via };
      const same = config.listing && config.listing.name === name && config.listing.style === style && config.listing.via === via;
      if (!same) {
        try {
          const result = await (d.list ?? defaultList)(config, seed, 'list', listing);
          config = { ...config, listing };
          saveConfig(config, d.home);
          saved.push(`${result === 'listed' ? 'Listed' : 'Updated'} on lunardraw.io as ${name}. It shows there within a minute.`);
        } catch (err) {
          errors.push(`The directory: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return { saved, errors };
};

// ------------------------------------------------------------------ the web side

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body, null, 2));
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

/**
 * Answer /settings (the page) and /settings/api (what it reads and saves). Returns false for any
 * other path. The caller has already turned away other hosts and other web pages' origins.
 */
export const handleSettings = async (req: IncomingMessage, res: ServerResponse, url: URL, d: SettingsDeps): Promise<boolean> => {
  if (url.pathname === '/settings' || url.pathname === '/settings/') {
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' }), true;
    const nonce = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(settingsPage(nonce));
    return true;
  }
  if (url.pathname !== '/settings/api') return false;
  if (!keyOk(req.headers['x-settings-key'] as string | undefined)) {
    send(res, 401, { error: 'This link has expired or is wrong. Ask your AI for a new one ("open my Lunardraw settings"), or run `lunardraw-agent settings`.' });
    return true;
  }
  try {
    if (req.method === 'GET') return send(res, 200, await settingsState(d)), true;
    if (req.method === 'POST') {
      if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'send JSON' }), true;
      const change = (await readJson(req)) as SettingsChange;
      const out = await applySettings(d, change ?? {});
      return send(res, 200, { ...out, state: await settingsState(d) }), true;
    }
    send(res, 405, { error: 'use GET or POST' });
  } catch (err) {
    send(res, (err as { status?: number }).status ?? 400, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
};

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** `lunardraw-agent settings` with no agent running: the page alone, on a free port. */
export const serveSettingsOnly = async (o: { home?: string; port?: number } & Omit<Partial<SettingsDeps>, 'home'> = {}): Promise<{ link: string; port: number; close: () => Promise<void> }> => {
  const d: SettingsDeps = { ...o, home: o.home ?? kitHome() };
  try {
    useHome(loadConfig(d.home), d.home);
  } catch {
    /* the page says what's missing */
  }
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!LOOPBACK.test(req.headers.host ?? '')) return send(res, 403, { error: 'wrong host' });
    if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return send(res, 403, { error: 'not from a web page' });
    if (!(await handleSettings(req, res, url, d))) send(res, 404, { error: 'not here' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  settingsServing.port = port;
  return {
    link: settingsLink(port),
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/** The paths kept by kitPaths, for the page's small print. */
export const configPath = (home = kitHome()): string => kitPaths(home).config;

// ------------------------------------------------------------------ the page

const settingsPage = (nonce: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Your Lunardraw agent</title>
<style nonce="${nonce}">
:root { color-scheme: dark; --night: #0a0c22; --panel: #12153a; --line: #2a2f66; --ink: #ece9ff; --muted: #a7a3cc; --violet: #8a5cf9; --violet-hi: #b49bff; --gold: #f2c75c; --ok: #5ee0a0; --bad: #ff7a8a; }
* { box-sizing: border-box; }
html { background: var(--night); }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: radial-gradient(1200px 500px at 80% -10%, #2b1f6b 0%, transparent 60%), var(--night); min-height: 100vh; }
main { max-width: 720px; margin: 0 auto; padding: 32px 20px 120px; }
.brand { font: 700 14px/1 ui-monospace, "Cascadia Mono", Menlo, monospace; letter-spacing: 0.22em; color: var(--violet-hi); text-shadow: 2px 2px 0 #1b1046; }
h1 { margin: 10px 0 4px; font-size: clamp(28px, 5vw, 38px); line-height: 1.15; }
.lede { margin: 0 0 8px; color: var(--muted); max-width: 56ch; }
.state { display: inline-flex; align-items: center; gap: 8px; margin: 14px 0 0; padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 14px; color: var(--muted); }
.state i { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
.state.ok i { background: var(--ok); box-shadow: 0 0 10px var(--ok); } .state.wait i { background: var(--gold); }
section { margin-top: 34px; padding-top: 26px; border-top: 1px solid var(--line); }
h2 { margin: 0 0 4px; font-size: 20px; }
h2 + p { margin: 0 0 16px; color: var(--muted); font-size: 15px; }
.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
.steps li { display: grid; grid-template-columns: 28px 1fr; gap: 12px; align-items: start; }
.tick { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; border: 2px solid var(--line); color: var(--muted); font-weight: 700; font-size: 14px; }
.done .tick { border-color: var(--ok); color: var(--ok); }
.steps .t { display: block; font-weight: 700; }
.steps p { margin: 2px 0 0; color: var(--muted); font-size: 15px; }
label { display: block; font-weight: 600; margin: 16px 0 6px; }
label small { font-weight: 400; color: var(--muted); }
input, select { width: 100%; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 10px; background: #070920; color: var(--ink); font: inherit; }
input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--violet-hi); outline-offset: 2px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.hint { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
.addr { display: flex; gap: 8px; margin-top: 8px; }
.addr code { flex: 1; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: #070920; font: 13px/1.4 ui-monospace, Menlo, monospace; overflow-wrap: anywhere; }
button, .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 18px; border: 1px solid var(--violet); border-radius: 10px; background: transparent; color: var(--ink); font: 600 15px system-ui, sans-serif; cursor: pointer; text-decoration: none; white-space: nowrap; }
.primary { background: linear-gradient(180deg, #9b74ff, #6a3df0); border-color: transparent; box-shadow: 0 8px 24px rgba(106, 61, 240, 0.35); }
.primary:disabled { opacity: 0.5; cursor: progress; }
.bar { height: 10px; margin-top: 8px; border-radius: 6px; background: #070920; border: 1px solid var(--line); overflow: hidden; }
.bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--violet), var(--violet-hi)); }
.switch { display: flex; align-items: center; gap: 12px; margin: 4px 0 0; font-weight: 600; cursor: pointer; }
.switch input { width: 22px; height: 22px; min-height: 0; accent-color: var(--violet); }
.listed[hidden] { display: none; }
.foot { position: fixed; left: 0; right: 0; bottom: 0; padding: 14px 20px; background: rgba(8, 9, 28, 0.94); border-top: 1px solid var(--line); backdrop-filter: blur(6px); }
.foot div { max-width: 720px; margin: 0 auto; display: flex; align-items: center; gap: 16px; }
.msg { flex: 1; font-size: 14px; color: var(--muted); }
.msg.ok { color: var(--ok); } .msg.bad { color: var(--bad); }
.small { margin-top: 40px; color: var(--muted); font-size: 13px; }
.gone { padding: 18px; border: 1px solid var(--bad); border-radius: 12px; color: var(--ink); }
@media (max-width: 560px) { .row { grid-template-columns: 1fr; } .addr { flex-direction: column; } main { padding-top: 22px; } }
</style>
</head>
<body>
<main>
  <div class="brand" aria-hidden="true">LUNARDRAW</div>
  <h1 id="title">Your agent</h1>
  <p class="lede">Everything your AI agent needs to play Starfall, in one place. Your wallet stays on this computer. Starfall runs on Midnight's test network with tNIGHT, a free test token with no value.</p>
  <div class="state" id="state" role="status"><i></i><span>Loading…</span></div>
  <div id="app" hidden>
    <section aria-labelledby="h-start">
      <h2 id="h-start">Getting started</h2>
      <p>Three things, once. Your AI can't play until they're done.</p>
      <ol class="steps">
        <li id="s-key"><span class="tick" aria-hidden="true">1</span><div><span class="t">A free Blockfrost key</span>
          <p id="key-done" hidden>Saved. Your agent can reach Midnight.</p>
          <div id="key-form"><p>It lets your agent read Midnight's test network. At <a href="https://blockfrost.io/" target="_blank" rel="noopener">blockfrost.io</a>: sign up (free), Add project, choose <b>Midnight Preprod</b>, copy the Project ID.</p>
          <label for="blockfrost">Project ID</label><input id="blockfrost" autocomplete="off" spellcheck="false" placeholder="preprod…"></div></div></li>
        <li id="s-fund"><span class="tick" aria-hidden="true">2</span><div><span class="t">Free test tNIGHT</span>
          <p>Copy your agent's address, paste it into the faucet and ask for tNIGHT.</p>
          <div class="addr"><code id="address">…</code><button type="button" id="copy">Copy</button><a class="btn" id="faucet" target="_blank" rel="noopener" href="#">Open the faucet</a></div></div></li>
        <li id="s-sync"><span class="tick" aria-hidden="true">3</span><div><span class="t">The wallet's first sync</span>
          <p id="sync-text">…</p><div class="bar" id="sync-bar" hidden><span></span></div></div></li>
      </ol>
    </section>

    <section aria-labelledby="h-site">
      <h2 id="h-site">On lunardraw.io</h2>
      <p>Show your agent in the <a id="dir" href="#" target="_blank" rel="noopener">agent directory</a> with a name you choose and its totals: draws, games, tNIGHT spent and won. Never its numbers.</p>
      <label class="switch"><input type="checkbox" id="listed"> Show my agent on lunardraw.io</label>
      <div class="listed" id="listed-box">
        <label for="name">Name <small>2 to 20 letters, digits, spaces, . _ -</small></label><input id="name" maxlength="20" autocomplete="off">
        <div class="row">
          <div><label for="style">Style <small>optional, a few words</small></label><input id="style" maxlength="40" placeholder="Plays every night"></div>
          <div><label for="via">Which AI plays it</label><select id="via"></select></div>
        </div>
      </div>
    </section>

    <section aria-labelledby="h-limits">
      <h2 id="h-limits">Spending limits</h2>
      <p>The most your agent may spend. Your AI can read these but never change them.</p>
      <div class="row">
        <div><label for="perDraw">tNIGHT a draw</label><input id="perDraw" inputmode="decimal"><p class="hint" id="perDraw-hint"></p></div>
        <div><label for="perDay">tNIGHT in any 24 hours</label><input id="perDay" inputmode="decimal"><p class="hint" id="perDay-hint"></p></div>
      </div>
    </section>
    <p class="small" id="where"></p>
  </div>
</main>
<div class="foot" id="foot" hidden><div><span class="msg" id="msg" role="status" aria-live="polite">Changes are saved when you press Save.</span><button type="button" class="primary" id="save">Save</button></div></div>
<script nonce="${nonce}">
(function () {
  var key = new URLSearchParams(location.hash.slice(1)).get('k') || '';
  try { if (key) sessionStorage.setItem('lunardraw-settings', key); else key = sessionStorage.getItem('lunardraw-settings') || ''; } catch (e) {}
  if (location.hash) history.replaceState(null, '', location.pathname);
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var api = function (body) {
    var o = { headers: { 'X-Settings-Key': key } };
    if (body) { o.method = 'POST'; o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch('/settings/api', o).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('error ' + r.status)); return j; }); });
  };
  var games = function (n) { var g = Math.floor(Number(n) / state.gamePrice); return isFinite(g) && g >= 0 ? 'About ' + g.toLocaleString('en') + ' game' + (g === 1 ? '' : 's') + '.' : ''; };
  var setState = function (cls, text) { var s = $('state'); s.className = 'state ' + (cls || ''); s.lastChild.textContent = text; };
  var paint = function (s, keepForm) {
    state = s;
    $('title').textContent = s.listing ? s.listing.name : 'Your agent';
    $('s-key').classList.toggle('done', s.blockfrost); $('key-done').hidden = !s.blockfrost; $('key-form').hidden = s.blockfrost;
    $('address').textContent = s.address; $('faucet').href = s.faucet; $('dir').href = s.directory;
    var w = s.wallet, text, pct = null, cls = 'wait', head;
    if (!s.blockfrost) { text = 'Starts once the Blockfrost key is saved.'; head = 'Needs a Blockfrost key'; cls = ''; }
    else if (!w) { text = 'Your agent isn\\'t running right now. Open your AI app (Claude, say) and it starts syncing; it saves its progress.'; head = 'Not running'; cls = ''; }
    else if (w.phase === 'ready') { text = 'Done. Your agent has ' + (w.tNight != null ? w.tNight.toLocaleString('en') + ' tNIGHT' : 'tNIGHT') + ' and can buy.'; head = 'Ready to play'; cls = 'ok'; pct = 1; }
    else if (w.phase === 'syncing') { pct = w.synced || 0; text = 'Reading the test network: ' + Math.floor(pct * 100) + '%. The first time takes a few hours; keep your AI app open. You can fund the wallet meanwhile.'; head = 'Syncing ' + Math.floor(pct * 100) + '%'; }
    else if (w.phase === 'waiting for tNIGHT') { pct = 1; text = 'Synced. Waiting for tNIGHT from the faucet (step 2).'; head = 'Waiting for tNIGHT'; }
    else if (w.phase === 'waiting for DUST') { pct = 1; text = 'Got the tNIGHT. Waiting for its first DUST, the fee token: usually a few minutes.'; head = 'Almost ready'; }
    else { text = 'Opening the wallet: a few minutes.'; head = 'Opening the wallet'; }
    $('sync-text').textContent = text; $('s-sync').classList.toggle('done', !!w && w.phase === 'ready');
    $('s-fund').classList.toggle('done', !!w && (w.phase === 'ready' || w.phase === 'waiting for DUST'));
    $('sync-bar').hidden = pct === null; if (pct !== null) $('sync-bar').firstChild.style.width = Math.round(pct * 100) + '%';
    setState(cls, head);
    if (!keepForm) {
      $('listed').checked = !!s.listing; $('listed-box').hidden = !s.listing;
      $('name').value = s.listing ? s.listing.name : ''; $('style').value = s.listing ? s.listing.style : '';
      var via = $('via'); if (!via.options.length) s.vias.forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v === 'chatgpt' ? 'ChatGPT' : v === 'mcp' ? 'Another MCP app' : v === 'cli' ? 'Command line' : v === 'api' ? 'My own program' : v.charAt(0).toUpperCase() + v.slice(1); via.appendChild(o); });
      via.value = s.listing ? s.listing.via : 'claude';
      $('perDraw').value = s.limits.perDraw; $('perDay').value = s.limits.perDay;
    }
    $('perDraw-hint').textContent = games($('perDraw').value); $('perDay-hint').textContent = games($('perDay').value);
    $('where').textContent = 'Kept in ' + s.home + ' on this computer. This page answers only on this computer; its link stops working after two hours.';
    $('app').hidden = false; $('foot').hidden = false;
  };
  var fail = function (e) {
    setState('', 'Can\\'t load');
    var m = document.createElement('p'); m.className = 'gone'; m.textContent = e.message; $('app').replaceWith(m);
  };
  $('listed').addEventListener('change', function () { $('listed-box').hidden = !this.checked; if (this.checked && !$('name').value) $('name').focus(); });
  ['perDraw', 'perDay'].forEach(function (id) { $(id).addEventListener('input', function () { $(id + '-hint').textContent = games(this.value); }); });
  $('copy').addEventListener('click', function () { var b = this; navigator.clipboard.writeText(state.address).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1600); }); });
  $('save').addEventListener('click', function () {
    var b = this, msg = $('msg');
    var body = { limits: { perDraw: $('perDraw').value, perDay: $('perDay').value } };
    if ($('blockfrost').value.trim()) body.blockfrost = $('blockfrost').value.trim();
    body.listing = $('listed').checked ? { name: $('name').value, style: $('style').value, via: $('via').value } : false;
    b.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
    api(body).then(function (j) {
      paint(j.state, j.errors.length > 0);
      if (!j.errors.length) $('blockfrost').value = '';
      msg.className = 'msg ' + (j.errors.length ? 'bad' : 'ok');
      msg.textContent = j.errors.length ? j.errors.join(' ') : (j.saved.length ? j.saved.join(' ') : 'Nothing to change.');
    }).catch(function (e) { msg.className = 'msg bad'; msg.textContent = e.message; }).then(function () { b.disabled = false; });
  });
  if (!key) return fail(new Error('This page needs its link. Ask your AI: "Open my Lunardraw settings", or run lunardraw-agent settings in a terminal.'));
  api().then(function (s) { paint(s); }).catch(fail);
  setInterval(function () { if (state && document.visibilityState === 'visible') api().then(function (s) { paint(s, true); }).catch(function () {}); }, 15000);
})();
</script>
</body>
</html>
`;
