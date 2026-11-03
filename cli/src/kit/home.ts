/**
 * The agent kit's home folder (`~/.lunardraw-agent`, or LUNARDRAW_AGENT_HOME):
 *
 *   config.json                 network, prover, spending limits (the owner's to set)
 *   wallet.secret               the agent's wallet seed (mode 600; never leaves this machine)
 *   blockfrost-<network>.secret the Blockfrost project id for Preprod (mode 600)
 *   state.json                  what it bought, and which results it has reported
 *   wallet-state/               the wallet's saved sync, so a restart takes minutes, not hours
 *
 * The limits are in the owner's config file on purpose: an AI using the kit
 * (through the MCP server) can read them but never change them.
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
};

/** Lunardraw's agent registry (the agent directory on lunardraw.io reads it). */
export const DEFAULT_REGISTRY = 'https://207-180-249-120.sslip.io/agents';

export const DEFAULT_CONFIG: KitConfig = { network: 'preprod', prover: 'hosted', limits: { perDraw: 25, perDay: 100 } };

export const kitHome = (): string => process.env.LUNARDRAW_AGENT_HOME ?? join(homedir(), '.lunardraw-agent');

export const kitPaths = (home = kitHome(), network: KitNetwork = 'preprod') => ({
  home,
  config: join(home, 'config.json'),
  wallet: join(home, 'wallet.secret'),
  blockfrost: join(home, `blockfrost-${network}.secret`),
  state: join(home, 'state.json'),
  walletState: join(home, 'wallet-state'),
});

const writePrivate = (path: string, text: string) => {
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
    if (typeof v !== 'number' || !(v >= 0) || !Number.isFinite(v)) throw new Error(`config.json: limits.${k} must be a number of tNIGHT, 0 or more`);
  }
  const prover = c.prover ?? DEFAULT_CONFIG.prover;
  if (typeof prover !== 'string' || !(prover === 'hosted' || /^https?:\/\/\S+$/.test(prover) || /^local:\d+$/.test(prover))) {
    throw new Error('config.json: prover must be "hosted", a prover\'s https:// address, or "local:<port>"');
  }
  const listing = c.listing && typeof c.listing === 'object' ? { name: String(c.listing.name ?? ''), style: String(c.listing.style ?? ''), via: String(c.listing.via ?? 'other') } : undefined;
  if (c.registry !== undefined && (typeof c.registry !== 'string' || !/^https?:\/\/\S+$/.test(c.registry))) throw new Error('config.json: registry must be an https:// address');
  return { network, prover, limits, ...(c.payTo ? { payTo: String(c.payTo) } : {}), ...(listing ? { listing } : {}), ...(c.registry ? { registry: c.registry } : {}) };
};

export const loadConfig = (home = kitHome()): KitConfig => {
  const path = kitPaths(home).config;
  if (!existsSync(path)) throw new Error(`no agent set up in ${home} yet: run \`lunardraw-agent init\` first`);
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
};

export const saveConfig = (config: KitConfig, home = kitHome()): void => writePrivate(kitPaths(home).config, JSON.stringify(config, null, 2) + '\n');

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

/** tNIGHT to STAR (the base unit). */
export const star = (tNight: number): bigint => BigInt(Math.round(tNight * 1e6));
export const tNight = (s: bigint): string => `${Number(s) / 1e6} tNIGHT`;
