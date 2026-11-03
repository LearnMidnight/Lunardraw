/**
 * polkadot-js (inside the Midnight wallet) prints a burst of errors whenever
 * the node's websocket drops, then reconnects by itself. Players see one
 * plain line instead; LUNARDRAW_AGENT_DEBUG=1 shows everything.
 */
const NOISE = /(^|\s)(API-WS|RPC-CORE|API\/INIT|API\/DECORATE|API\/SUBMIT|WS-PROVIDER):/;

/** Whether a console call is polkadot-js's connection chatter. */
export const isNodeNoise = (args: unknown[]): boolean => NOISE.test(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));

export const quietNodeNoise = (env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = (s) => process.stderr.write(s)): void => {
  if (env.LUNARDRAW_AGENT_DEBUG === '1') return;
  let told = 0;
  for (const level of ['error', 'warn', 'log'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (!isNodeNoise(args)) return original(...args);
      const now = Date.now();
      if (now - told > 60_000) {
        told = now;
        out("(the connection to the Midnight node dropped for a moment; it reconnects by itself)\n");
      }
    };
  }
};

quietNodeNoise();
