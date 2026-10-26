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
 *
 * Once a draw is revealed its seed is public on chain, so the keeper drops it
 * (`forget`); the store only ever holds the seeds of draws still selling, and
 * any created for a draw whose opening transaction hasn't shown up yet.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { seedCommitment } from '@nightcast/sdk';

export type SealedSeed = { seed: Uint8Array; commitment: Uint8Array };

export interface SeedStore {
  /** A fresh random seed, saved before it is returned. */
  create(): Promise<SealedSeed>;
  /** The seed for a commitment, if this store has it. */
  find(commitment: Uint8Array): Promise<Uint8Array | undefined>;
  /**
   * Drop the seeds for these commitments (draws that are no longer selling:
   * revealed, so the seed is public on chain, or void). Returns how many were
   * dropped. Optional: a store that doesn't prune keeps everything.
   */
  forget?(commitments: Uint8Array[]): Promise<number>;
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

  async forget(commitments: Uint8Array[]): Promise<number> {
    let n = 0;
    for (const c of commitments) if (this.seeds.delete(hex(c))) n += 1;
    return n;
  }

  get size(): number {
    return this.seeds.size;
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

  async forget(commitments: Uint8Array[]): Promise<number> {
    const data = this.read();
    let n = 0;
    for (const c of commitments) {
      if (data.seeds[hex(c)]) {
        delete data.seeds[hex(c)];
        n += 1;
      }
    }
    if (n > 0) this.write(data);
    return n;
  }
}

// ------------------------------------------------------------ derived seeds

/**
 * Seeds for Starfall draws, worked out from the organiser secret instead of
 * stored: draw `id`'s seed is SHA-256("starfall:seed:v1" ‖ secret ‖
 * deployment ‖ id). Any keeper holding the organiser secret (the primary and
 * its standby) knows every draw's seed with nothing to copy or back up, and
 * nobody without the secret can work one out before it's revealed.
 *
 * The contract refuses a seed commitment it has seen before, so a seed is
 * only ever revealed for one draw.
 */
export interface DrawSeeds {
  /** The sealed seed for the draw that will be number `id`. */
  forDraw(id: bigint): Promise<SealedSeed>;
  /**
   * The seed behind `commitment`, for draw `id`. Nearby ids are tried too, in
   * case the draw got a different number than expected when it was opened
   * (another opening landed first).
   */
  find(commitment: Uint8Array, id: bigint): Promise<Uint8Array | undefined>;
}

const SEED_DOMAIN = new TextEncoder().encode('starfall:seed:v1');

export class DerivedSeeds implements DrawSeeds {
  /**
   * @param secret the organiser secret (32 bytes)
   * @param deployment the contract's address (32 bytes), so two deployments never share seeds
   */
  constructor(
    private readonly secret: Uint8Array,
    private readonly deployment: Uint8Array,
  ) {
    if (secret.length !== 32) throw new Error('the organiser secret is 32 bytes');
  }

  seedFor(id: bigint): Uint8Array {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(Number(id));
    return Uint8Array.from(createHash('sha256').update(SEED_DOMAIN).update(this.secret).update(this.deployment).update(n).digest());
  }

  async forDraw(id: bigint): Promise<SealedSeed> {
    const seed = this.seedFor(id);
    return { seed, commitment: commitmentOf(seed) };
  }

  async find(commitment: Uint8Array, id: bigint): Promise<Uint8Array | undefined> {
    const want = hex(commitment);
    for (let d = 0n; d <= 4n; d++) {
      for (const candidate of d === 0n ? [id] : [id - d, id + d]) {
        if (candidate < 1n || candidate > 0xffffffffn) continue;
        const seed = this.seedFor(candidate);
        if (hex(commitmentOf(seed)) === want) return seed;
      }
    }
    return undefined;
  }
}
