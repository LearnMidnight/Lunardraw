/**
 * The keeper's sealed seeds.
 *
 * Each draw is opened with `SHA-256(seedHex)` and the seed is revealed after
 * sales close. The seed must survive restarts: if it's lost, that draw can't
 * be revealed, so it is voided and refunded. A seed is saved before the
 * transaction that publishes its commitment is sent, so a crash in between
 * loses nothing (an unused seed is harmless).
 *
 * Nobody may see a seed before its draw's sales close: whoever knew it, and
 * the oracle's key, would know the numbers. Keep the file private.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { seedCommitment } from '@nightcast/sdk';

export type SealedSeed = { seed: Uint8Array; commitment: Uint8Array };

export interface SeedStore {
  /** A fresh random seed, saved before it is returned. */
  create(): Promise<SealedSeed>;
  /** The seed for a commitment, if this store has it. */
  find(commitment: Uint8Array): Promise<Uint8Array | undefined>;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

/** The commitment the contract checks: SHA-256 of the seed's 64 hex characters. */
export const commitmentOf = (seed: Uint8Array): Uint8Array => fromHex(seedCommitment(hex(seed)));

const fresh = (): SealedSeed => {
  const seed = Uint8Array.from(randomBytes(32));
  return { seed, commitment: commitmentOf(seed) };
};

/** In memory only, for tests. */
export class MemorySeedStore implements SeedStore {
  private readonly seeds = new Map<string, Uint8Array>();

  async create(): Promise<SealedSeed> {
    const s = fresh();
    this.seeds.set(hex(s.commitment), s.seed);
    return s;
  }

  async find(commitment: Uint8Array): Promise<Uint8Array | undefined> {
    return this.seeds.get(hex(commitment));
  }
}

type SeedFile = { version: 1; seeds: Record<string, { seed: string; createdAt: string }> };

/**
 * Seeds in a JSON file (mode 600), written atomically on every change. Back
 * the file up somewhere private: losing it voids the open draw.
 */
export class FileSeedStore implements SeedStore {
  constructor(readonly path: string) {}

  private read(): SeedFile {
    if (!existsSync(this.path)) return { version: 1, seeds: {} };
    const data = JSON.parse(readFileSync(this.path, 'utf8')) as SeedFile;
    if (data.version !== 1 || typeof data.seeds !== 'object') throw new Error(`${this.path} is not a Lunardraw seed file`);
    return data;
  }

  private write(data: SeedFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  async create(): Promise<SealedSeed> {
    const data = this.read();
    const s = fresh();
    data.seeds[hex(s.commitment)] = { seed: hex(s.seed), createdAt: new Date().toISOString() };
    this.write(data);
    return s;
  }

  async find(commitment: Uint8Array): Promise<Uint8Array | undefined> {
    const entry = this.read().seeds[hex(commitment)];
    if (!entry) return undefined;
    const seed = fromHex(entry.seed);
    // Never reveal a seed that doesn't match what was published.
    if (hex(commitmentOf(seed)) !== hex(commitment)) throw new Error(`${this.path}: the seed for ${hex(commitment)} is corrupt`);
    return seed;
  }
}
