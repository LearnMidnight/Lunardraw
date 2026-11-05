/**
 * Run from a folder the kit can write to. Midnight's testkit, loaded with the
 * wallet code, makes a ./logs/tests folder wherever it starts, and AI apps
 * start MCP servers in folders nobody can write to: Claude for Windows starts
 * them in C:\Windows\System32, where that failed with EPERM and the server
 * died before answering (5 Nov 2026). As an MCP server, or whenever the
 * current folder isn't writable, the kit moves to its own home first. Its
 * files all have full paths, so nothing else changes.
 *
 * Imported first by kit-main.ts, before anything that loads the testkit.
 */
import { accessSync, constants, mkdirSync } from 'node:fs';
import { kitHome } from './home.js';

const writable = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Where to run from: the kit's home for `mcp` or an unwritable folder, else where it was started. */
export const workingFolder = (command: string | undefined, cwd: string, home: string, canWrite: (dir: string) => boolean = writable): string =>
  command === 'mcp' || !canWrite(cwd) ? home : cwd;

try {
  const home = kitHome();
  const to = workingFolder(process.argv[2], process.cwd(), home);
  if (to !== process.cwd()) {
    mkdirSync(to, { recursive: true });
    process.chdir(to);
  }
} catch {
  /* stay where we are */
}
