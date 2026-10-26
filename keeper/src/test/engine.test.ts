import { describe, it, expect } from 'vitest';
import { StepEngine } from '../engine.js';

type S = { kind: 'prove'; id: number };

describe('the step engine', () => {
  it('runs one background proof at a time, with a rest in between', async () => {
    let now = 0;
    const due = new Set([1, 2]);
    const finish = new Map<number, () => void>();
    const engine = new StepEngine<null, S>({
      read: async () => [null, 0],
      plan: () => [...due].map((id) => ({ kind: 'prove' as const, id })),
      key: (s) => `prove ${s.id}`,
      describe: (s) => `prove ${s.id}`,
      run: (s) =>
        new Promise<boolean>((res) =>
          finish.set(s.id, () => {
            due.delete(s.id);
            res(true);
          }),
        ),
      background: ['prove'],
      backgroundLimit: 1,
      backgroundGapMs: 20_000,
      clock: () => now,
    });
    let r = await engine.tick();
    expect(engine.inProgress()).toEqual(['prove 1']);
    expect(r.skipped).toContainEqual({ step: 'prove 2', reason: 'another proof is running' });
    finish.get(1)!();
    await engine.settled();
    now += 10_000;
    r = await engine.tick();
    expect(r.done).toEqual(['prove 1']);
    expect(r.skipped).toContainEqual({ step: 'prove 2', reason: 'letting the proof server rest' });
    expect(engine.inProgress()).toEqual([]);
    now += 10_000;
    await engine.tick();
    expect(engine.inProgress()).toEqual(['prove 2']);
    finish.get(2)!();
    await engine.settled();
  });
});
