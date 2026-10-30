import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { untilSilentFor } from '../common.js';

const logger = { error: vi.fn() };

describe('the silence watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks for a restart when no pass has finished for the given minutes', async () => {
    let last: number | undefined;
    const w = untilSilentFor(10, () => last, logger);
    let fired = false;
    void w.done.then(() => (fired = true));
    // passes keep finishing: quiet
    for (let m = 0; m < 30; m++) {
      last = Date.now();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(fired).toBe(false);
    // then the process hangs: nothing finishes for 10 minutes
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    expect(fired).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/no pass has finished for 10 minutes/));
    w.cancel();
  });

  it('counts from start-up when no pass has finished yet, and 0 turns it off', async () => {
    const w = untilSilentFor(5, () => undefined, logger);
    let fired = false;
    void w.done.then(() => (fired = true));
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    expect(fired).toBe(true);
    w.cancel();
    const off = untilSilentFor(0, () => undefined, logger);
    let firedOff = false;
    void off.done.then(() => (firedOff = true));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(firedOff).toBe(false);
    off.cancel();
  });
});
