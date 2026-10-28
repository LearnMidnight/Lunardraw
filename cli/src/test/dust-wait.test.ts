import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deadline, dustWait } from '../dust-wait.js';

describe('the DUST wait limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads --dust-wait', () => {
    expect(dustWait(undefined)).toBe(20);
    expect(dustWait('5')).toBe(5);
    expect(dustWait('0')).toBe(0);
    expect(() => dustWait('soon')).toThrow(/--dust-wait/);
    expect(() => dustWait('-1')).toThrow(/--dust-wait/);
  });

  it("doesn't run before the wait starts (a long first sync isn't cut short)", async () => {
    const late = vi.fn();
    const d = deadline(20, late);
    let fired = false;
    void d.late.then(() => (fired = true));
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(late).not.toHaveBeenCalled();
    expect(fired).toBe(false);
  });

  it('fires once, the given minutes after the wait starts', async () => {
    const late = vi.fn();
    const d = deadline(20, late);
    let fired = false;
    void d.late.then(() => (fired = true));
    await vi.advanceTimersByTimeAsync(60 * 60_000); // syncing
    d.start();
    d.start(); // a second call doesn't restart the clock
    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
    expect(late).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect(fired).toBe(true);
    await expect(d.late).resolves.toBeUndefined();
  });

  it('wins the race against a wallet that never gets DUST', async () => {
    const late = vi.fn();
    const d = deadline(20, late);
    const opening = new Promise<string>(() => {
      setTimeout(() => d.start(), 3 * 60_000); // synced after 3 minutes, then waits for DUST forever
    });
    const result = Promise.race([opening, d.late]);
    await vi.advanceTimersByTimeAsync(23 * 60_000);
    await expect(result).resolves.toBeUndefined();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('is stopped by cancel once the wallet is open', async () => {
    const late = vi.fn();
    const d = deadline(20, late);
    d.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    d.cancel();
    d.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(late).not.toHaveBeenCalled();
  });

  it('never fires with 0', async () => {
    const late = vi.fn();
    const d = deadline(0, late);
    d.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(late).not.toHaveBeenCalled();
  });
});
