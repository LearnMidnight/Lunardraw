#!/usr/bin/env node
/**
 * The `lunardraw-agent` command (the agent kit): see kit/main.ts.
 */
// First, so nothing can print a Blockfrost project id or an unreadable wallet error.
import '@nightcast/deploy/redact-output';
import '@nightcast/deploy/explain-errors';
import './kit/quiet.js';
import { kit } from './kit/main.js';

kit(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
