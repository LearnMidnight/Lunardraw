#!/usr/bin/env node
/**
 * `./lunardraw registry`: the agent directory's registry (see registry.ts),
 * run as lunardraw-registry.service on the keeper VM, behind Caddy.
 *
 *   ./lunardraw registry --network preprod --port 6320 \
 *     --dir /root/lunardraw-registry --feed /root/lunardraw-feed/feed.json --house /root/lunardraw-agents
 */
import { parseArgs } from 'node:util';
import { createRegistry, ledgerVerifier, serveRegistry } from './registry.js';

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      network: { type: 'string', default: 'preprod' },
      port: { type: 'string', default: '6320' },
      host: { type: 'string', default: '127.0.0.1' },
      dir: { type: 'string', default: '/root/lunardraw-registry' },
      feed: { type: 'string', default: '/root/lunardraw-feed/feed.json' },
      house: { type: 'string', default: '/root/lunardraw-agents' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write('./lunardraw registry [--network preprod] [--port 6320] [--dir <listings>] [--feed <feed.json>] [--house <agents folder>]\n');
    return 0;
  }
  const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
  const registry = createRegistry({ network: values.network!, dir: values.dir!, feedPath: values.feed!, houseDir: values.house!, verifier: await ledgerVerifier(values.network!) });
  serveRegistry(registry, Number(values.port), values.host, log);
  log(`agent registry for ${values.network} on ${values.host}:${values.port}`);
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
