/**
 * `./lunardraw proof-server`: one Midnight proof server in Docker for the
 * keeper and the oracle to share, kept healthy for days:
 *
 * - listens on 127.0.0.1 only (the organiser secret and the oracle key pass
 *   through it);
 * - keeps the downloaded zk parameters (100 MB for the numbers proof) in a
 *   Docker volume, so a restart doesn't download them again;
 * - restarts the container when it's idle (no proof running) and using more
 *   than a memory limit, and whenever it stops on its own.
 *
 * On the first Preprod soak a long-running proof server grew slower every
 * hour and then failed proofs with 500s; restarting it between proofs keeps
 * every proof starting from a clean slate.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The image Nightcast's compose files use (Midnight's support matrix, October 2026). */
export const PROOF_SERVER_IMAGE = 'midnightntwrk/proof-server:8.1.3';
/** Docker volume holding the downloaded zk parameters. */
export const PARAMS_VOLUME = 'lunardraw-zk-params';

/** "1.2GiB / 23.4GiB" (docker stats MemUsage) -> MiB used, or undefined. */
export const parseMemMiB = (usage: string): number | undefined => {
  const m = /^\s*([\d.]+)\s*([KMGT]i?B|B)/.exec(usage);
  if (!m) return undefined;
  const v = Number(m[1]);
  const unit = m[2].replace('i', '');
  const factor = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1024 * 1024 }[unit];
  return factor === undefined ? undefined : v * factor;
};

/**
 * Counts proofs in progress from the proof server's log: a request starts
 * with "Starting to process request for /prove" and ends with the access
 * log line "POST /prove ... took".
 */
export class ProofTracker {
  private running = 0;
  private lastEndAt = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  line(text: string): void {
    if (/Starting to process request for \/prove/.test(text)) this.running += 1;
    else if (/POST \/prove\b.*took/.test(text)) {
      this.running = Math.max(0, this.running - 1);
      this.lastEndAt = this.clock();
    }
  }

  /** No proof running, and none finished in the last `quietMs` (a transaction often proves in several parts). */
  idle(quietMs: number): boolean {
    return this.running === 0 && this.clock() - this.lastEndAt >= quietMs;
  }

  inProgress(): number {
    return this.running;
  }

  reset(): void {
    this.running = 0;
  }
}

export type ProofServerOptions = {
  port: number;
  /** Restart when idle and above this many MiB. */
  memoryLimitMiB: number;
  log: (msg: string) => void;
  /** Print the proof server's own log lines. */
  echo?: boolean;
};

/** Run and supervise the proof server until `stop()`. */
export class ProofServer {
  private child: ChildProcess | undefined;
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private restarting = false;
  readonly tracker = new ProofTracker();
  readonly name: string;

  constructor(private readonly opts: ProofServerOptions) {
    this.name = `lunardraw-proof-server-${opts.port}`;
  }

  /** Resolves when stopped. */
  async run(): Promise<void> {
    await run('docker', ['rm', '-f', this.name]).catch(() => undefined);
    this.timer = setInterval(() => void this.check(), 60_000);
    while (!this.stopping) {
      await this.once();
      if (!this.stopping) {
        this.opts.log('The proof server stopped; starting it again in 5 s.');
        await new Promise((res) => setTimeout(res, 5_000));
      }
    }
    if (this.timer) clearInterval(this.timer);
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill('SIGINT');
    void run('docker', ['stop', this.name]).catch(() => undefined);
  }

  private once(): Promise<void> {
    this.tracker.reset();
    const child = spawn(
      'docker',
      [
        'run', '--rm', '--name', this.name,
        '-p', `127.0.0.1:${this.opts.port}:6300`,
        '-v', `${PARAMS_VOLUME}:/params`, '-e', 'MIDNIGHT_PP=/params',
        PROOF_SERVER_IMAGE, 'midnight-proof-server',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (text) => {
        this.tracker.line(text);
        if (this.opts.echo !== false) process.stdout.write(`${text}\n`);
      });
    }
    return new Promise((res) => child.on('exit', () => res()));
  }

  /** Every minute: restart if idle and too big. */
  private async check(): Promise<void> {
    if (this.stopping || this.restarting) return;
    const mem = await run('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', this.name]).then(
      (r) => parseMemMiB(r.stdout),
      () => undefined,
    );
    if (mem === undefined || mem <= this.opts.memoryLimitMiB || !this.tracker.idle(30_000)) return;
    this.restarting = true;
    this.opts.log(`Proof server idle at ${Math.round(mem)} MiB (limit ${this.opts.memoryLimitMiB}); restarting it to free memory.`);
    // Stopping it ends `once`, and `run` starts a fresh one.
    await run('docker', ['stop', this.name]).catch(() => undefined);
    this.restarting = false;
  }
}
