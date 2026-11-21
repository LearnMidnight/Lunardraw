/**
 * The agent kit's home folder (`~/.lunardraw-agent`, or LUNARDRAW_AGENT_HOME):
 *
 *   config.json                 network, prover, spending limits (the owner's to set)
 *   wallet.secret               the agent's wallet seed (mode 600; never leaves this machine)
 *   blockfrost-<network>.secret the Blockfrost project id for Preprod (mode 600)
 *   state.json                  what it bought, and which results it has reported
 *   wallet-state/               the wallet's saved sync, so a restart takes minutes, not hours
 *   agent-token.secret          the key for the agent's local web address (host.ts; mode 600)
 *   relay-link.secret           the private link for AIs on the web or a phone (relay-link.ts; mode 600)
 *   agent.log                   what the agent running in the background did
 *
 * The limits are in the owner's config file on purpose: an AI using the kit
 * (through the MCP server) can read them but never change them. The owner
 * changes them on the settings page (settings.ts), with `lunardraw-agent
 * limits`, in the Claude extension's settings, or in the file itself.
 */
import { webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type KitNetwork = 'preprod' | 'preview';

export type KitConfig = {
  network: KitNetwork;
  /** `hosted` (Lunardraw's player prover), a prover's address, or `local:<port>` for a proof server on this machine. */
  prover: string;
  /** Spending limits, in tNIGHT. */
  limits: { perDraw: number; perDay: number };
  /** Where winnings go (mn_addr_... or 64 hex); this wallet by default. */
  payTo?: string;
  /** Listed in lunardraw.io's agent directory (the owner opted in with `lunardraw-agent list`). */
  listing?: { name: string; style: string; via: string };
  /** The directory's registry (default: Lunardraw's). */
  registry?: string;
  /** The port of the agent's local web address on this computer (host.ts; default 6338). */
  port?: number;
  /** Whether AIs on the web or a phone can reach the agent through Lunardraw's relay (`lunardraw-agent remote`). */
  remote?: boolean;
  /** The relay (default: Lunardraw's). */
  relay?: string;
  /**
   * The Claude extension's limit settings as last seen (adoptSettingsLimits): when the owner
   * changes them there, they're copied into `limits` once, so the latest change wins wherever
   * it was made (the extension, the settings page, the command line or this file).
   */
  settingsSeen?: { perDraw?: number; perDay?: number };
};

/** The most a limit can be set to, in tNIGHT (a typo guard; Preprod tNIGHT has no value). */
export const MAX_LIMIT = 1_000_000;

/** Lunardraw's agent registry (the agent directory on lunardraw.io reads it). */
export const DEFAULT_REGISTRY = 'https://207-180-249-120.sslip.io/agents';

/** Lunardraw's relay, which passes AIs on the web or a phone through to an agent on its owner's computer. */
export const DEFAULT_RELAY = 'https://207-180-249-120.sslip.io/relay';

/** The agent's local web address's port, unless config.json or LUNARDRAW_AGENT_PORT say otherwise. */
export const DEFAULT_PORT = 6338;

export const DEFAULT_CONFIG: KitConfig = { network: 'preprod', prover: 'hosted', limits: { perDraw: 25, perDay: 100 } };

export const kitHome = (): string => process.env.LUNARDRAW_AGENT_HOME ?? join(homedir(), '.lunardraw-agent');

export const kitPaths = (home = kitHome(), network: KitNetwork = 'preprod') => ({
  home,
  config: join(home, 'config.json'),
  wallet: join(home, 'wallet.secret'),
  blockfrost: join(home, `blockfrost-${network}.secret`),
  state: join(home, 'state.json'),
  walletState: join(home, 'wallet-state'),
  token: join(home, 'agent-token.secret'),
  link: join(home, 'relay-link.secret'),
  log: join(home, 'agent.log'),
});

export const writePrivate = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  chmodSync(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
};

/** Check a config (from a file a person edits) and fill in defaults. */
export const parseConfig = (raw: unknown): KitConfig => {
  const c = (raw ?? {}) as Partial<KitConfig> & { limits?: Partial<KitConfig['limits']> };
  const network = c.network ?? DEFAULT_CONFIG.network;
  if (network !== 'preprod' && network !== 'preview') throw new Error(`config.json: network must be preprod or preview (Lunardraw is test tokens only), not ${String(network)}`);
  const limits = { ...DEFAULT_CONFIG.limits, ...(c.limits ?? {}) };
  for (const [k, v] of Object.entries(limits)) {
    if (typeof v !== 'number' || !(v >= 0) || !(v <= MAX_LIMIT)) throw new Error(`config.json: limits.${k} must be a number of tNIGHT from 0 to ${MAX_LIMIT.toLocaleString('en')} (it is ${JSON.stringify(v)})`);
  }
  const prover = c.prover ?? DEFAULT_CONFIG.prover;
  if (typeof prover !== 'string' || !(prover === 'hosted' || /^https?:\/\/\S+$/.test(prover) || /^local:\d+$/.test(prover))) {
    throw new Error('config.json: prover must be "hosted", a prover\'s https:// address, or "local:<port>"');
  }
  const listing = c.listing && typeof c.listing === 'object' ? { name: String(c.listing.name ?? ''), style: String(c.listing.style ?? ''), via: String(c.listing.via ?? 'other') } : undefined;
  if (c.registry !== undefined && (typeof c.registry !== 'string' || !/^https?:\/\/\S+$/.test(c.registry))) throw new Error('config.json: registry must be an https:// address');
  if (c.relay !== undefined && (typeof c.relay !== 'string' || !/^https?:\/\/\S+$/.test(c.relay))) throw new Error('config.json: relay must be an https:// address');
  if (c.port !== undefined && !(Number.isInteger(c.port) && c.port > 0 && c.port < 65536)) throw new Error('config.json: port must be a port number (1-65535)');
  return {
    network,
    prover,
    limits,
    ...(c.payTo ? { payTo: String(c.payTo) } : {}),
    ...(listing ? { listing } : {}),
    ...(c.registry ? { registry: c.registry } : {}),
    ...(c.port ? { port: c.port } : {}),
    ...(c.remote ? { remote: true } : {}),
    ...(c.relay ? { relay: c.relay.replace(/\/+$/, '') } : {}),
    ...(c.settingsSeen && typeof c.settingsSeen === 'object' ? { settingsSeen: { ...c.settingsSeen } } : {}),
  };
};

/**
 * config.json's text, however it was saved: UTF-8 with or without a byte-order mark, or UTF-16
 * (what Windows PowerShell 5.1 and some editors write when a person edits the file by hand).
 */
export const readConfigText = (bytes: Buffer): string => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  // UTF-16 without a mark: every other byte is zero in a file of plain JSON
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) return bytes.toString('utf16le');
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[2] === 0) {
    const swapped = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

/** Read and check config.json, saying exactly what's wrong (and where) if it can't be used. */
export const readConfigFile = (path: string): KitConfig => {
  const text = readConfigText(readFileSync(path));
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const at = /position (\d+)/.exec(err instanceof Error ? err.message : '')?.[1];
    const line = at === undefined ? undefined : text.slice(0, Number(at)).split('\n').length;
    throw new Error(`${path} isn't valid JSON${line ? ` (around line ${line})` : ''}: check for a missing comma or quote. Or set the limits with \`lunardraw-agent settings\` instead of editing the file.`);
  }
  return parseConfig(raw);
};

/**
 * Limits set in the app's settings for the kit: Claude's extension passes its "tNIGHT a draw"
 * and "tNIGHT a day" settings as LUNARDRAW_LIMIT_PER_DRAW and LUNARDRAW_LIMIT_PER_DAY. Only the
 * owner can change them there; an AI using the kit can't. An empty or unset value (or one that
 * isn't a number of tNIGHT) leaves config.json's limit in force.
 */
export const settingsLimits = (env: NodeJS.ProcessEnv = process.env): Partial<KitConfig['limits']> => {
  const read = (v: string | undefined): number | undefined => {
    const t = (v ?? '').trim();
    return /^\d+(\.\d+)?$/.test(t) && Number.isFinite(Number(t)) ? Number(t) : undefined;
  };
  const perDraw = read(env.LUNARDRAW_LIMIT_PER_DRAW);
  const perDay = read(env.LUNARDRAW_LIMIT_PER_DAY);
  return { ...(perDraw !== undefined ? { perDraw } : {}), ...(perDay !== undefined ? { perDay } : {}) };
};

/** The config in the home (config.json). */
export const loadConfig = (home = kitHome()): KitConfig => {
  const path = kitPaths(home).config;
  if (!existsSync(path)) throw new Error(`no agent set up in ${home} yet: run \`lunardraw-agent setup\` first`);
  return readConfigFile(path);
};

/**
 * The Claude extension's limit settings into config.json, when the owner has changed them there
 * since they were last seen. Called when the extension starts the agent. So the latest change
 * wins: a change in the extension's settings is used once Claude restarts the extension, and a
 * later change on the settings page or the command line isn't undone by the extension's old values.
 * Returns the new limits when it changed them.
 */
export const adoptSettingsLimits = (home = kitHome(), env: NodeJS.ProcessEnv = process.env): KitConfig['limits'] | undefined => {
  const set = settingsLimits(env);
  let config: KitConfig;
  try {
    config = loadConfig(home);
  } catch {
    return undefined;
  }
  const seen = config.settingsSeen ?? {};
  if (set.perDraw === seen.perDraw && set.perDay === seen.perDay) return undefined;
  const limits = { perDraw: set.perDraw ?? config.limits.perDraw, perDay: set.perDay ?? config.limits.perDay };
  const changed = limits.perDraw !== config.limits.perDraw || limits.perDay !== config.limits.perDay;
  saveConfig({ ...config, limits, settingsSeen: set }, home);
  return changed ? limits : undefined;
};

/** The limits in force now: re-read, so a change takes effect without restarting the agent. */
export const limitsNow = (fallback: KitConfig, home = kitHome()): KitConfig['limits'] => {
  try {
    return loadConfig(home).limits;
  } catch (err) {
    process.stderr.write(`lunardraw: config.json can't be read, so the limits stay at ${fallback.limits.perDraw} / ${fallback.limits.perDay}: ${err instanceof Error ? err.message : String(err)}\n`);
    return fallback.limits;
  }
};

/** Where the owner changes the limits, for messages. */
export const limitsWhere = (): string =>
  "on the agent's settings page (lunardraw_setup gives its link; in a terminal, `lunardraw-agent settings`), or with `lunardraw-agent limits --per-draw <tNIGHT> --per-day <tNIGHT>`";

export const saveConfig = (config: KitConfig, home = kitHome()): void => {
  writePrivate(kitPaths(home).config, JSON.stringify(config, null, 2) + '\n');
};

/** Create the wallet seed if there isn't one; returns the seed and whether it was new. */
export const ensureWallet = (home = kitHome()): { seed: string; created: boolean } => {
  const path = kitPaths(home).wallet;
  if (existsSync(path)) {
    const f = JSON.parse(readFileSync(path, 'utf8')) as { seed?: string };
    if (!f.seed || !/^[0-9a-f]{64}$/i.test(f.seed)) throw new Error(`${path} has no wallet seed`);
    return { seed: f.seed, created: false };
  }
  const seed = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex');
  writePrivate(path, JSON.stringify({ role: 'wallet', seed }, null, 2) + '\n');
  return { seed, created: true };
};

export const saveBlockfrost = (projectId: string, home = kitHome(), network: KitNetwork = 'preprod'): void => {
  const id = projectId.trim();
  if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw new Error('that doesn\'t look like a Blockfrost project id (letters and digits, from your project page on blockfrost.io)');
  writePrivate(kitPaths(home, network).blockfrost, id + '\n');
};

export const hasBlockfrost = (home = kitHome(), network: KitNetwork = 'preprod'): boolean =>
  !!process.env.NIGHTCAST_BLOCKFROST_PROJECT_ID?.trim() || existsSync(kitPaths(home, network).blockfrost);

/**
 * The folder with the published deployment records (deployments/starfall-<network>.json):
 * next to the kit in the npm package, or the repository's when run from a checkout.
 */
export const findDeployments = (network: KitNetwork, from = dirname(fileURLToPath(import.meta.url))): string => {
  let dir = resolve(from);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'deployments');
    if (existsSync(join(candidate, `starfall-${network}.json`))) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`the Starfall deployment record for ${network} wasn't found next to the kit`);
};

/**
 * Point the shared Lunardraw and Nightcast code at this home: its Blockfrost
 * id, its wallet-state folder, the deployment records. Call once, first.
 */
export const useHome = (config: KitConfig, home = kitHome()): void => {
  const p = kitPaths(home, config.network);
  if (!process.env.NIGHTCAST_BLOCKFROST_PROJECT_ID && existsSync(p.blockfrost)) process.env.NIGHTCAST_BLOCKFROST_PROJECT_ID = readFileSync(p.blockfrost, 'utf8').trim();
  process.env.NIGHTCAST_STATE_DIR ??= p.walletState;
  process.env.LUNARDRAW_DEPLOYMENTS_DIR ??= findDeployments(config.network);
};

/** A random secret kept in a private file (made the first time; `fresh` makes a new one). */
export const ensureSecret = (path: string, fresh = false): string => {
  if (!fresh && existsSync(path)) {
    const s = readFileSync(path, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(s)) return s;
  }
  const s = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  writePrivate(path, s + '\n');
  return s;
};

/** The port of the agent's local web address. */
export const agentPort = (config?: Pick<KitConfig, 'port'>): number => Number(process.env.LUNARDRAW_AGENT_PORT) || config?.port || DEFAULT_PORT;

/** tNIGHT to STAR (the base unit). */
export const star = (tNight: number): bigint => BigInt(Math.round(tNight * 1e6));
export const tNight = (s: bigint): string => `${Number(s) / 1e6} tNIGHT`;
