import { describe, it, expect } from 'vitest';
import { positionsOf, SyncWatch } from '../sync-watch.js';

const state = (shielded: bigint, unshielded: bigint, dust: bigint) => ({
  shielded: { state: { progress: { appliedIndex: shielded } } },
  unshielded: { progress: { appliedId: unshielded } },
  dust: { state: { progress: { appliedIndex: dust } } },
});

describe('the sync watch', () => {
  it('reads each part of the wallet', () => {
    expect(positionsOf(state(1n, 2n, 3n))).toBe('shielded:1|unshielded:2|dust:3');
    expect(positionsOf({})).toBe('shielded:?|unshielded:?|dust:?');
  });

  it("reads wallet SDK 2's state too (progress on the part itself), so a DUST sync counts as moving", () => {
    // SDK 2 (ledger 9): with SDK 1's paths only the unshielded part showed, and a long DUST sync looked stalled.
    const sdk2 = (shielded: bigint, unshielded: bigint, dust: bigint) => ({
      shielded: { progress: { appliedIndex: shielded } },
      unshielded: { progress: { appliedId: unshielded } },
      dust: { progress: { appliedIndex: dust } },
    });
    expect(positionsOf(sdk2(1n, 2n, 3n))).toBe('shielded:1|unshielded:2|dust:3');
    let now = 0;
    const w = new SyncWatch(() => now);
    w.see(sdk2(5n, 7n, 100n));
    now = 20 * 60_000;
    w.see(sdk2(5n, 7n, 90_000n)); // only DUST moves
    expect(w.stalledMinutes()).toBe(0);
    // a getter that throws before its part has started reads as unknown, not a crash
    const early = { shielded: { get progress(): never { throw new Error('not started'); } }, unshielded: { progress: { appliedId: 1n } }, dust: {} };
    expect(positionsOf(early)).toBe('shielded:?|unshielded:1|dust:?');
  });

  it('notices when the positions stop moving', () => {
    let now = 0;
    const w = new SyncWatch(() => now);
    w.see(state(1n, 1n, 10n));
    now = 60_000;
    w.see(state(1n, 1n, 11n));
    expect(w.stalledMinutes()).toBe(0);
    now = 16 * 60_000;
    w.see(state(1n, 1n, 11n)); // the same positions again: no movement
    expect(w.stalledMinutes()).toBe(15);
    expect(w.summary()).toEqual({ positions: 'shielded:1|unshielded:1|dust:11', moves: 1 });
    w.see(state(1n, 1n, 12n));
    expect(w.stalledMinutes()).toBe(0);
  });
});
