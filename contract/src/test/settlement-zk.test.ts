/**
 * Every circuit run the simulator makes, checked against the circuit's zkir
 * (the check a proof server does before proving). The JS simulator alone
 * can't catch a circuit that only fails in the prover: the first end-to-end
 * run found one (a purchase of fewer than maxTickets() tickets read the
 * settlement key inside a branch that wasn't taken, and the prover panicked
 * on the resulting non-point). This covers every branch of every circuit.
 *
 * A run the prover can't handle can make the checker hang rather than throw
 * (the purchase bug did), so each test has a short timeout: passing takes a
 * few seconds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { proofDataIntoSerializedPreimage } from '@midnight-ntwrk/compact-runtime';
import * as zkir from '@midnight-ntwrk/zkir-v2';
import { generateOperatorSecret, generateOracleSecretKey, oraclePublicKey, pureCircuits as nightcast } from '@nightcast/contract';
import { combineDrawSeed, drawStarfall, seedCommitment } from '@nightcast/sdk';
import { pureCircuits } from '../managed/settlement/contract/index.js';
import { type ProofData, SettlementSimulator } from '../settlement-simulator.js';
import { makeTicket, randomScalar } from '../settlement-tickets.js';
import { quickPick, type PlainLine } from '../tickets.js';

const ZKIR = fileURLToPath(new URL('../managed/settlement/zkir/', import.meta.url));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const randomAddress = () => webcrypto.getRandomValues(new Uint8Array(32));

type Run = { circuit: string; proofData: ProofData };

const irCache = new Map<string, Uint8Array>();
const provider = {
  async lookupKey(circuit: string) {
    if (!irCache.has(circuit)) irCache.set(circuit, zkir.jsonIrToBinary(readFileSync(`${ZKIR}${circuit}.zkir`, 'utf8')));
    return { ir: irCache.get(circuit)!, proverKey: new Uint8Array(), verifierKey: new Uint8Array() };
  },
  async getParams(): Promise<Uint8Array> {
    throw new Error('checking needs no parameters');
  },
};

/** The zkir check of one run: undefined if it passes, else why not. */
const check = async ({ circuit, proofData: p }: Run): Promise<string | undefined> => {
  const preimage = proofDataIntoSerializedPreimage(
    p.input as never,
    p.output as never,
    p.publicTranscript as never,
    p.privateTranscriptOutputs as never,
    circuit,
  );
  try {
    await zkir.check(preimage, provider);
    return undefined;
  } catch (err) {
    return `${circuit}: ${err instanceof Error ? err.message : String(err)}`;
  }
};

const lineHitting = (numbers: number[], moonball: number, match: number): PlainLine => {
  const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !numbers.includes(x));
  return { numbers: [...numbers.slice(0, match), ...misses.slice(0, 7 - match)], moonball };
};

const setup = (opts: { feePerGame?: bigint } = {}) => {
  const runs: Run[] = [];
  const oracleSecretKey = generateOracleSecretKey();
  const organiserSecret = generateOperatorSecret();
  const sim = new SettlementSimulator({
    oracleSecretKey,
    organiserSecret,
    settlementSecret: randomScalar(),
    operator: randomAddress(),
    feePerGame: opts.feePerGame,
    minSales: 600n,
    maxSales: 86_400n,
    revealWindow: 3_600n,
    drawWindow: 3_600n,
    settleWindow: 86_400n,
    onProof: (circuit, proofData) => runs.push({ circuit, proofData }),
  });
  let label = 0;
  const open = () => {
    const seed = new Uint8Array(32).fill(++label);
    const n = sim.openDraw(BigInt(sim.now + 3_600), Uint8Array.from(Buffer.from(seedCommitment(hex(seed)), 'hex')));
    const out = nightcast.evaluate(oracleSecretKey, sim.alphaOf(n, seed));
    const draw = drawStarfall(combineDrawSeed(hex(seed), out)) as { numbers: number[]; moonball: number };
    return { n, seed, draw };
  };
  return { sim, runs, open, oracleSecretKey, organiserSecret };
};

const allPass = async (runs: Run[]) => {
  const failures: string[] = [];
  for (const r of runs) {
    const f = await check(r);
    if (f) failures.push(f);
  }
  return failures;
};

describe('every circuit run passes the zkir check', () => {
  it('purchases of 1 and 2 games, a settled draw with winners, payments to 1 and 3 payees', async () => {
    const { sim, runs, open } = setup();
    const { n, seed, draw } = open();
    const me = randomAddress();
    sim.buyTickets([makeTicket(n, quickPick(), me)], me);
    sim.buyTickets([makeTicket(n, quickPick(), me), makeTicket(n, quickPick(), me)], me);
    // A sure winner paid to one address, and one split between three payees.
    sim.buyTickets(
      [
        makeTicket(n, lineHitting(draw.numbers, draw.moonball, 3), randomAddress()),
        makeTicket(n, lineHitting(draw.numbers, draw.moonball, 4), [
          { address: randomAddress(), share: 5_000 },
          { address: randomAddress(), share: 3_000 },
          { address: randomAddress(), share: 2_000 },
        ]),
      ],
      me,
    );
    sim.advance(3_601);
    // Reveal and open the next draw in one go.
    sim.requestAndOpenNext(n, seed, { salesClose: BigInt(sim.now + 3_600), seedCommitment: new Uint8Array(32).fill(99) });
    sim.fulfilDraw(n);
    sim.computeNumbers(n);
    expect(sim.settleAll(n)).toBe(1); // 5 games: one partial batch
    expect(sim.entitlementsOf(n).length).toBeGreaterThanOrEqual(2);
    const circuits = new Set(runs.map((r) => r.circuit));
    for (const c of ['buyTickets', 'requestDraw', 'fulfilDraw', 'computeNumbers', 'settleBatch', 'finaliseDraw', 'payEntitlement']) {
      expect(circuits.has(c), c).toBe(true);
    }
    expect(await allPass(runs)).toEqual([]);
  }, 60_000);

  it('a reveal without a next draw, a second draw finalised after the first, no operator fee', async () => {
    const { sim, runs, open } = setup({ feePerGame: 0n });
    const first = open();
    sim.advance(3_601);
    sim.requestDraw(first.n, first.seed);
    sim.fulfilDraw(first.n);
    sim.computeNumbers(first.n);
    sim.settleAll(first.n);
    const second = open();
    sim.buyTickets([makeTicket(second.n, quickPick(), randomAddress())], randomAddress());
    sim.advance(3_601);
    sim.requestDraw(second.n, second.seed);
    sim.fulfilDraw(second.n);
    sim.computeNumbers(second.n);
    sim.settleAll(second.n);
    expect(await allPass(runs)).toEqual([]);
  }, 60_000);

  it('a void draw and its refunds', async () => {
    const { sim, runs, open } = setup();
    const { n } = open();
    const me = randomAddress();
    sim.buyTickets([makeTicket(n, quickPick(), me), makeTicket(n, quickPick(), me)], me);
    sim.advance(3_601 + 3_600);
    sim.voidDraw(n);
    sim.refundTicket(n, 0n);
    sim.refundTicket(n, 1n);
    expect(await allPass(runs)).toEqual([]);
  }, 60_000);

  it('System, Pick and Moonball Sweep entries: bought, settled through every Moonball branch, paid and refunded', async () => {
    const { sim, runs, open } = setup();
    const { n, seed, draw } = open();
    const me = randomAddress();
    const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !draw.numbers.includes(x));
    const other = (draw.moonball % 20) + 1;
    sim.buyTickets(
      [
        // A System 12 holding 5 drawn numbers, Moonball Sweep: winners with and without the Moonball.
        makeTicket(n, { numbers: [...draw.numbers.slice(0, 5), ...misses.slice(0, 7)], sweep: true }, me),
        // A Pick 6 holding 6 drawn numbers and the Moonball: a jackpot game among its 29.
        makeTicket(n, { numbers: draw.numbers.slice(0, 6), moonball: draw.moonball, pick: true }, me),
      ],
      me,
    );
    sim.buyTickets(
      [
        // A System 9 with the wrong Moonball: only Moonball-less divisions.
        makeTicket(n, { numbers: [...draw.numbers.slice(0, 6), ...misses.slice(0, 3)], moonball: other }, [
          { address: randomAddress(), share: 6_000 },
          { address: randomAddress(), share: 4_000 },
        ]),
        // A Pick 5 that wins nothing.
        makeTicket(n, { numbers: misses.slice(0, 5), moonball: other, pick: true }, me),
      ],
      me,
    );
    sim.advance(3_601);
    sim.requestAndOpenNext(n, seed, { salesClose: BigInt(sim.now + 3_600), seedCommitment: new Uint8Array(32).fill(98) });
    sim.fulfilDraw(n);
    sim.computeNumbers(n);
    expect(sim.settleAll(n)).toBe(1);
    expect(sim.entitlementsOf(n).length).toBe(3);
    // Draw 2: a big entry, voided and refunded.
    sim.buyTickets([makeTicket(2n, { numbers: misses.slice(0, 10), sweep: true }, me)], me);
    sim.advance(3_601 + 3_600);
    sim.voidDraw(2n);
    sim.refundTicket(2n, 0n);
    expect(await allPass(runs)).toEqual([]);
  }, 60_000);

  it('oracle key changes and organiser hand-overs', async () => {
    const { sim, runs, open } = setup();
    open();
    const next = generateOracleSecretKey();
    sim.proposeOracleKey(oraclePublicKey(next));
    sim.approveOracleKey(); // the current oracle agrees: the approving branch
    sim.acceptOracleKey({ oracleSecretKey: next }); // the new key's holder accepts
    const successor = generateOperatorSecret();
    sim.proposeOrganiser(pureCircuits.organiserCommitmentOf(successor));
    sim.acceptOrganiser({ organiserSecret: successor });
    sim.recoverOrganiser(pureCircuits.organiserCommitmentOf(generateOperatorSecret()));
    expect(new Set(runs.map((r) => r.circuit))).toEqual(new Set(['acceptOracleKey', 'requestDraw', 'proposeOracleKey', 'changeOrganiser']));
    expect(await allPass(runs)).toEqual([]);
  }, 60_000);
});
