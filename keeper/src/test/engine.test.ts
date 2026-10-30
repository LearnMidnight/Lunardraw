import { describe, it, expect } from 'vitest';
import { isStaleDustProof, reasonOf, StepEngine } from '../engine.js';

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

  it('retries a stale DUST proof (1010 custom 170) after 15 s, other failures with doubling backoff', async () => {
    let now = 0;
    let fail: string | undefined = 'stale';
    let attempts = 0;
    const engine = new StepEngine<null, S>({
      read: async () => [null, 0],
      plan: () => [{ kind: 'prove' as const, id: 1 }],
      key: (s) => `prove ${s.id}`,
      describe: (s) => `prove ${s.id}`,
      run: async () => {
        attempts++;
        if (fail === 'stale') throw new Error('submit', { cause: new Error('Transaction submission error', { cause: { message: 'RpcError: 1010: Invalid Transaction: Custom error: 170' } }) });
        if (fail) throw new Error('submit', { cause: new Error(fail) });
        return true;
      },
      backoffMs: 10_000,
      clock: () => now,
    });
    let r = await engine.tick();
    expect(r.failed[0].error).toMatch(/Custom error: 170/);
    // a stale DUST proof: tried again 15 s later, not 10 then 20 then 40
    now += 14_000;
    await engine.tick();
    expect(attempts).toBe(1);
    now += 2_000;
    await engine.tick();
    expect(attempts).toBe(2);
    now += 16_000;
    await engine.tick();
    expect(attempts).toBe(3);
    // the same step failing for another reason backs off: 10, 20, 40 s
    fail = 'something else';
    now += 16_000;
    r = await engine.tick();
    expect(attempts).toBe(4);
    expect(r.failed[0].error).toBe('submit: something else');
    fail = undefined;
    now += 5_000;
    await engine.tick();
    expect(attempts).toBe(4); // still backing off (the 4th failure waits 80 s)
    now += 80_000;
    r = await engine.tick();
    expect(r.done).toEqual(['prove 1']);
  });

  it('reasonOf drops stack frames from a message that carries its own stack, and finds the code in it', () => {
    const raw =
      "Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) SubmissionError: Transaction submission error\n" +
      '    at file:///root/Lunardraw/node_modules/@midnight-ntwrk/wallet-sdk-capabilities/dist/submission/submissionService.js:31:279\n' +
      '    at file:///root/Lunardraw/node_modules/effect/dist/esm/internal/fiberRuntime.js:945:41 {\n' +
      '  [cause]: SubmissionError: Transaction submission failed\n' +
      '      at process.processTicksAndRejections (node:internal/process/task_queues:103:5) {\n' +
      '    [cause]: RpcError: 1010: Invalid Transaction: Custom error: 170\n' +
      '        at checkError (file:///root/Lunardraw/node_modules/@polkadot/rpc-provider/coder/index.js:19:15)\n' +
      '  }\n}';
    expect(reasonOf(new Error(raw))).toBe(
      "Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) SubmissionError: Transaction submission error: SubmissionError: Transaction submission failed: RpcError: 1010: Invalid Transaction: Custom error: 170",
    );
    // the code is found even when the readable form would be cut at 600 characters
    const long = new Error(`${'x'.repeat(700)}\n    at file:///a.js:1:1 {\n  [cause]: RpcError: 1010: Invalid Transaction: Custom error: 170\n}`);
    expect(reasonOf(long)).toHaveLength(603);
    expect(isStaleDustProof(long)).toBe(true);
    expect(isStaleDustProof(new Error('Custom error: 138'))).toBe(false);
  });

  it('reasonOf follows cause chains whose links are not Error instances', () => {
    const err = { message: 'outer', cause: { message: 'middle', cause: 'RpcError: 1010: Invalid Transaction: Custom error: 170' } };
    expect(reasonOf(err)).toBe('outer: middle: RpcError: 1010: Invalid Transaction: Custom error: 170');
    expect(reasonOf(new Error('{\n  "a": 1\n}'))).toBe('{ "a": 1 }');
  });
});
