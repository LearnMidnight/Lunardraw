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
