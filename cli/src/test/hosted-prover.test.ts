import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVER, hostedProofProvider, hostedProvingProvider, proverHealth } from '../hosted-prover.js';

type Call = { url: string; body?: Uint8Array };

/** A fake prover: answers each request with the next response in `script`. */
const fakeFetch = (script: (() => Response)[]) => {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as Uint8Array | undefined });
    const next = script.shift();
    if (!next) throw new Error('no more responses');
    return next();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
};

describe("proving purchases with Lunardraw's player prover", () => {
  it('sends the preimage to /prove/<circuit>, with the binding when given, and returns the proof', async () => {
    const { fetcher, calls } = fakeFetch([() => new Response(new Uint8Array([9, 9])), () => new Response(new Uint8Array([7]))]);
    const p = hostedProvingProvider('https://prover.example/', { fetcher });
    expect(await p.prove(new Uint8Array([1, 2, 3]), 'buyTickets')).toEqual(new Uint8Array([9, 9]));
    expect(await p.prove(new Uint8Array([4]), 'buyTickets', 123n)).toEqual(new Uint8Array([7]));
    expect(calls.map((c) => c.url)).toEqual(['https://prover.example/prove/buyTickets', 'https://prover.example/prove/buyTickets?binding=123']);
    expect(calls[0].body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('waits while the prover is busy or limiting, then carries on', async () => {
    const busy = () => new Response('{"error":"The prover is busy."}', { status: 503, headers: { 'Retry-After': '0' } });
    const { fetcher, calls } = fakeFetch([busy, () => new Response('{}', { status: 429 }), () => new Response(new Uint8Array([5]))]);
    const waits: number[] = [];
    // Retry-After is at least 3 s: speed the test up by making setTimeout immediate
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => real(fn, 0)) as typeof setTimeout;
    try {
      const p = hostedProvingProvider(DEFAULT_PROVER, { fetcher, onWait: (status) => waits.push(status) });
      expect(await p.prove(new Uint8Array([1]), 'buyTickets')).toEqual(new Uint8Array([5]));
    } finally {
      globalThis.setTimeout = real;
    }
    expect(waits).toEqual([503, 429]);
    expect(calls).toHaveLength(3);
  });

  it("explains a refusal, and gives up waiting when the prover stays busy", async () => {
    const { fetcher } = fakeFetch([() => new Response('{"error":"This prover only proves buyTickets."}', { status: 404 })]);
    await expect(hostedProvingProvider('https://prover.example', { fetcher }).prove(new Uint8Array([1]), 'settleBatch')).rejects.toThrow(
      /HTTP 404\): This prover only proves buyTickets/,
    );
    const { fetcher: alwaysBusy } = fakeFetch([() => new Response('', { status: 503, headers: { 'Retry-After': '1' } })]);
    await expect(hostedProvingProvider('https://prover.example', { fetcher: alwaysBusy, waitMs: 0 }).prove(new Uint8Array([1]), 'buyTickets')).rejects.toThrow(/HTTP 503/);
    expect(() => hostedProvingProvider('prover.example')).toThrow(/not a prover address/);
  });

  it('proves a transaction by handing it the hosted provider', async () => {
    const { fetcher, calls } = fakeFetch([() => new Response(new Uint8Array([1]))]);
    let costModel: unknown;
    const tx = {
      async prove(provider: { prove(pre: Uint8Array, key: string): Promise<Uint8Array> }, cm: unknown) {
        costModel = cm;
        await provider.prove(new Uint8Array([8]), 'buyTickets');
        return 'proven';
      },
    };
    expect(await hostedProofProvider('https://prover.example', { fetcher }).proveTx(tx as never)).toBe('proven');
    expect(costModel).toBeDefined();
    expect(calls[0].url).toBe('https://prover.example/prove/buyTickets');
  });

  it("reads the prover's health", async () => {
    const { fetcher } = fakeFetch([() => Response.json({ ok: true, circuit: 'buyTickets', active: 1, queued: 0 }), () => new Response('', { status: 502 })]);
    expect(await proverHealth('https://prover.example', fetcher)).toEqual({ ok: true, detail: 'circuit buyTickets, 1 proving, 0 waiting' });
    expect((await proverHealth('https://prover.example', fetcher)).ok).toBe(false);
  });
});
