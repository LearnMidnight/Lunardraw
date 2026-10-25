import { describe, it, expect } from 'vitest';
import { parseMemMiB, ProofTracker } from '../proof-server.js';

describe('the proof server supervisor', () => {
  it('reads docker stats memory figures', () => {
    expect(parseMemMiB('1.5GiB / 23.4GiB')).toBe(1536);
    expect(parseMemMiB('968MiB / 15.6GiB')).toBe(968);
    expect(parseMemMiB('512KiB / 1GiB')).toBe(0.5);
    expect(parseMemMiB('--')).toBeUndefined();
  });

  it('tracks proofs in progress from the log, with a quiet period after each', () => {
    let now = 0;
    const t = new ProofTracker(() => now);
    expect(t.idle(30_000)).toBe(false); // nothing finished 30 s ago yet: just started
    now = 60_000;
    expect(t.idle(30_000)).toBe(true);
    t.line('2026-10-24T15:03:14Z  INFO midnight_proof_server::endpoints: Starting to process request for /prove...');
    t.line('2026-10-24T15:03:15Z  INFO midnight_proof_server::endpoints: Starting to process request for /check...');
    expect(t.inProgress()).toBe(1);
    expect(t.idle(30_000)).toBe(false);
    now = 600_000;
    t.line('2026-10-24T15:12:28Z  INFO actix_web::middleware::logger: 172.17.0.1 POST /prove HTTP/1.1; took 554.135415s');
    t.line('2026-10-24T15:12:28Z  INFO actix_web::middleware::logger: 172.17.0.1 POST /check HTTP/1.1; took 0.08s');
    expect(t.inProgress()).toBe(0);
    expect(t.idle(30_000)).toBe(false);
    now = 640_000;
    expect(t.idle(30_000)).toBe(true);
  });
});
