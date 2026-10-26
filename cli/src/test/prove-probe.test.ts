/**
 * How much memory and time each Starfall circuit's proof takes on Midnight's
 * real proof server (Docker), one circuit at a time, with the server
 * restarted in between so each figure is that circuit's alone. The circuit
 * runs come from the in-memory simulator, so no network is needed.
 *
 * Run with LUNARDRAW_PROBE=1 (CI's prove-probe job does), after
 * `npm run compact:starfall`. Prints a table and a GitHub notice per circuit.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { proofDataIntoSerializedPreimage } from '@midnight-ntwrk/compact-runtime';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { quickPick, type PlainLine, Starfall } from '@lunardraw/contract';
import { generateOperatorSecret, generateOracleSecretKey, pureCircuits as nightcast } from '@nightcast/contract';
import { combineDrawSeed, drawStarfall, seedCommitment } from '@nightcast/sdk';
import { PARAMS_VOLUME, parseMemMiB, PROOF_SERVER_IMAGE } from '../proof-server.js';
import { starfallZkConfigPath } from '../starfall.js';

const enabled = process.env.LUNARDRAW_PROBE === '1';
const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const NAME = 'lunardraw-probe';
const PORT = 6399;

type Run = { circuit: string; proofData: Starfall.ProofData; note: string };

const lineHitting = (numbers: number[], moonball: number, match: number): PlainLine => {
  const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !numbers.includes(x));
  return { numbers: [...numbers.slice(0, match), ...misses.slice(0, 7 - match)], moonball };
};

/** One run of every circuit the keeper, the oracle and players use, the biggest variant of each. */
const circuitRuns = (): Run[] => {
  const runs: Run[] = [];
  let note = '';
  const oracleSecretKey = generateOracleSecretKey();
  const sim = new Starfall.SettlementSimulator({
    oracleSecretKey,
    organiserSecret: generateOperatorSecret(),
    settlementSecret: Starfall.randomScalar(),
    operator: webcrypto.getRandomValues(new Uint8Array(32)),
    onProof: (circuit, proofData) => runs.push({ circuit, proofData, note }),
  });
  const seed = new Uint8Array(32).fill(7);
  const n = sim.openDraw(BigInt(sim.now + 3_600), Uint8Array.from(Buffer.from(seedCommitment(hex(seed)), 'hex')));
  const draw = drawStarfall(combineDrawSeed(hex(seed), nightcast.evaluate(oracleSecretKey, sim.alphaOf(n, seed)))) as {
    numbers: number[];
    moonball: number;
  };
  const me = webcrypto.getRandomValues(new Uint8Array(32));
  const max = Number(Starfall.pureCircuits.maxGames());
  const batch = Number(Starfall.pureCircuits.batchSize());
  const games = [Starfall.makeTicket(n, lineHitting(draw.numbers, draw.moonball, 3), me)];
  while (games.length < batch + 1) games.push(Starfall.makeTicket(n, quickPick(), me));
  note = `${max} games`;
  sim.buyPackage(games, me);
  sim.advance(3_601);
  note = 'with next draw';
  sim.requestAndOpenNext(n, seed, { salesClose: BigInt(sim.now + 3_600), seedCommitment: new Uint8Array(32).fill(1) });
  note = '';
  sim.fulfilDraw(n);
  sim.computeNumbers(n);
  note = `${batch} tickets`;
  sim.settleAll(n);
  // Draw 2 was never revealed: void it.
  sim.advance(3 * 3_601);
  note = '';
  sim.voidDraw(2n);
  // Keep one run per circuit: the first (the biggest variant, as bought and settled above).
  const seen = new Set<string>();
  return runs.filter((r) => (seen.has(r.circuit) ? false : (seen.add(r.circuit), true)));
};

const startServer = async () => {
  await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
  await run('docker', [
    'run', '-d', '--rm', '--name', NAME, '-p', `127.0.0.1:${PORT}:6300`,
    '-v', `${PARAMS_VOLUME}:/params`, '-e', 'MIDNIGHT_PP=/params', PROOF_SERVER_IMAGE, 'midnight-proof-server',
  ]);
  for (let i = 0; i < 120; i++) {
    const up = await fetch(`http://127.0.0.1:${PORT}/`).then(
      () => true,
      () => false,
    );
    if (up) return;
    await sleep(500);
  }
  throw new Error('the proof server did not start');
};

/** Sample the container's memory about once a second until stopped; resolves to the peak MiB. */
const sampleMemory = () => {
  let peak = 0;
  const child = spawn('docker', ['stats', '--format', '{{.MemUsage}}', NAME], { stdio: ['ignore', 'pipe', 'ignore'] });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const mib = parseMemMiB(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim());
    if (mib !== undefined && mib > peak) peak = mib;
  });
  return {
    stop: async () => {
      child.kill();
      return peak;
    },
  };
};

const exited = async (): Promise<string | undefined> => {
  const out = await run('docker', ['inspect', '--format', '{{.State.Status}} exit {{.State.ExitCode}} oom {{.State.OOMKilled}}', NAME]).then(
    (r) => r.stdout.trim(),
    () => 'gone (container removed: it exited)',
  );
  return out.startsWith('running') ? undefined : out;
};

describe.runIf(enabled)('Starfall proofs on the real proof server', () => {
  afterAll(async () => {
    await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
  });

  it('proves each circuit once and reports its peak memory and time', async () => {
    const runs = circuitRuns();
    const zk = new NodeZkConfigProvider<string>(starfallZkConfigPath());
    const prover = httpClientProvingProvider(`http://127.0.0.1:${PORT}`, zk, { timeout: 60 * 60_000 });
    const rows: { circuit: string; note: string; ok: boolean; secs: number; peakMiB: number; error?: string }[] = [];
    for (const r of runs) {
      await startServer();
      const preimage = proofDataIntoSerializedPreimage(
        r.proofData.input as never,
        r.proofData.output as never,
        r.proofData.publicTranscript as never,
        r.proofData.privateTranscriptOutputs as never,
        r.circuit,
      );
      const mem = sampleMemory();
      const started = Date.now();
      let error: string | undefined;
      try {
        await prover.check(preimage, r.circuit);
        await prover.prove(preimage, r.circuit);
      } catch (err) {
        error = `${err instanceof Error ? err.message : String(err)}${(await exited()) ? ` (proof server ${await exited()})` : ''}`;
      }
      const secs = Math.round((Date.now() - started) / 1000);
      const peakMiB = Math.round(await mem.stop());
      rows.push({ circuit: r.circuit, note: r.note, ok: error === undefined, secs, peakMiB, error });
      const line = `${r.circuit}${r.note ? ` (${r.note})` : ''}: ${error ? `FAILED after ${secs} s, peak ${peakMiB} MiB: ${error.slice(0, 300)}` : `${secs} s, peak ${peakMiB} MiB`}`;
      process.stdout.write(`::notice title=proof ${r.circuit}::${line}\n`);
      await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
    }
    process.stdout.write(
      '\ncircuit                 secs   peak MiB\n' +
        rows.map((x) => `${(x.circuit + (x.note ? ` (${x.note})` : '')).padEnd(32)}${String(x.secs).padStart(5)}${String(x.peakMiB).padStart(10)}${x.ok ? '' : '  FAILED'}`).join('\n') +
        '\n',
    );
    expect(rows.filter((x) => !x.ok).map((x) => `${x.circuit}: ${x.error}`)).toEqual([]);
  }, 4 * 60 * 60_000);
});
