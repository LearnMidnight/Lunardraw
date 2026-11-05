#!/usr/bin/env node
/**
 * `./lunardraw relay`: the relay for AIs on the web or a phone (see relay.ts),
 * run as lunardraw-relay.service on the keeper VM, behind Caddy.
 *
 *   ./lunardraw relay --port 6340
 */
import { parseArgs } from 'node:util';
import { createRelay, serveRelay } from './relay.js';

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: 'string', default: '6340' },
      host: { type: 'string', default: '127.0.0.1' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write('./lunardraw relay [--port 6340] [--host 127.0.0.1]\n');
    return 0;
  }
  const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
  const relay = createRelay({ log });
  serveRelay(relay, Number(values.port), values.host, log);
  log(`relay on ${values.host}:${values.port}`);
  // a line an hour, so the journal shows it's alive (never a secret or a message)
  setInterval(() => log(`${relay.size()} link(s)`), 60 * 60_000);
  await new Promise(() => undefined);
  return 0;
};

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
