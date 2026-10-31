import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deadline, dustWait, quietWatch } from '../dust-wait.js';

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

describe('quietWatch', () => {
  const session = () => {
    const lines: string[] = [];
    return {
      lines,
      s: {
        name: 'session',
        logger: {
          prefix: '>',
          info(this: { prefix: string }, m: string) {
            lines.push(`${this.prefix} ${m}`);
          },
          warn(m: string) {
            lines.push(`warn ${m}`);
          },
          error(m: string) {
            lines.push(`error ${m}`);
          },
        },
        hello() {
          return (this as { name: string }).name;
        },
      },
    };
  };

  it('stays quiet while the wallet keeps logging, and fires after the silence', async () => {
    vi.useFakeTimers();
    try {
      const { s, lines } = session();
      const fired: number[] = [];
      const w = quietWatch(s, 15, (m) => fired.push(m));
      let resolved = false;
      void w.quiet.then(() => (resolved = true));
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        w.session.logger.info('Syncing: dust 99.9%');
      }
      expect(fired).toEqual([]);
      expect(lines[0]).toBe('> Syncing: dust 99.9%');
      expect(w.session.hello()).toBe('session');
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(fired).toEqual([15]);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing once cancelled', async () => {
    vi.useFakeTimers();
    try {
      const { s } = session();
      const fired: number[] = [];
      const w = quietWatch(s, 15, (m) => fired.push(m));
      w.cancel();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(fired).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
