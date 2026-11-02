#!/usr/bin/env node
/**
 * `./lunardraw monitor` without the rest of the command line: the monitor
 * reads files and systemd and calls Resend, so it skips loading Midnight's
 * libraries (about 13 s of CPU a run through main.js, under a second here).
 * The `lunardraw` script sends `monitor` here; main.js still accepts it too.
 */
import { monitor } from './monitor-command.js';

monitor(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
