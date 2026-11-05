/**
 * `lunardraw-agent connect`: find the AI apps on this computer and add
 * Lunardraw to each, so nobody edits settings files or copies paths:
 *
 *   Claude (the desktop app)  its claude_desktop_config.json (the Microsoft Store
 *                             install's own folder too), backed up first
 *   Claude Code               `claude mcp add --scope user …`
 *   Gemini CLI                ~/.gemini/settings.json, backed up first
 *
 * Other agents (OpenClaw, Hermes, Cursor…) get the line to add. Also what
 * `lunardraw-agent doctor` uses to say which apps are connected.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeDesktopConfig, claudeDesktopConfigs, type McpEntry, withLunardraw } from './setup.js';

export type AppId = 'claude-desktop' | 'claude-code' | 'gemini-cli';

export type FoundApp = {
  id: AppId;
  /** For people: "Claude (desktop app)". */
  name: string;
  /** The settings file (desktop app, Gemini CLI). */
  file?: string;
};

export type ConnectResult = FoundApp & { ok: boolean; note: string };

/** What it takes to run a program by name here (Windows needs the shell for npm's .cmd shims). */
const run = (cmd: string, args: string[]): { ok: boolean; out: string } => {
  const win = process.platform === 'win32';
  const r = win
    ? spawnSync([cmd, ...args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(' '), { shell: true, encoding: 'utf8', timeout: 60_000 })
    : spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });
  return { ok: !r.error && r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/** Whether a program is on the PATH. */
const onPath = (cmd: string): boolean => run(process.platform === 'win32' ? 'where' : 'which', [cmd]).ok;

export const geminiSettings = (home = homedir()): string => join(home, '.gemini', 'settings.json');

/** The AI apps installed here that Lunardraw can be added to. */
export const findApps = (o: { home?: string; hasCommand?: (cmd: string) => boolean; exists?: (path: string) => boolean } = {}): FoundApp[] => {
  const home = o.home ?? homedir();
  const exists = o.exists ?? existsSync;
  const has = o.hasCommand ?? onPath;
  const out: FoundApp[] = [];
  // the file Claude reads is the one that's there; failing that, the first folder that is
  const where = claudeDesktopConfigs(process.platform, process.env, home);
  const desktop = where.find((f) => exists(f)) ?? where.find((f) => exists(dirname(f)));
  if (desktop) out.push({ id: 'claude-desktop', name: 'Claude (desktop app)', file: desktop });
  if (has('claude')) out.push({ id: 'claude-code', name: 'Claude Code' });
  if (exists(join(home, '.gemini')) || has('gemini')) out.push({ id: 'gemini-cli', name: 'Gemini CLI', file: geminiSettings(home) });
  return out;
};

/** A JSON settings file with Lunardraw added under mcpServers, the old one kept beside it. */
const addToJson = (file: string, entry: McpEntry & { timeout?: number }): string => {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (before !== undefined && !existsSync(`${file}.before-lunardraw`)) copyFileSync(file, `${file}.before-lunardraw`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, withLunardraw(before, entry));
  return before !== undefined ? `your old settings are kept as ${file}.before-lunardraw` : 'new settings file';
};

/** Whether Lunardraw is already in an app's settings. */
export const isConnected = (app: FoundApp): boolean => {
  try {
    if (app.id === 'claude-code') return run('claude', ['mcp', 'get', 'lunardraw']).ok;
    const file = app.file ?? claudeDesktopConfig();
    if (!existsSync(file)) return false;
    const config = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return !!config.mcpServers?.lunardraw;
  } catch {
    return false;
  }
};

/** Add Lunardraw to each app (an app it's already in is updated, so a moved install is fixed too). */
export const connectApps = (apps: FoundApp[], entry: McpEntry): ConnectResult[] =>
  apps.map((app) => {
    try {
      if (app.id === 'claude-desktop') {
        const note = addToJson(app.file!, entry);
        return { ...app, ok: true, note: `added (${note}). Quit Claude completely and open it again to load it` };
      }
      if (app.id === 'gemini-cli') {
        const note = addToJson(app.file!, { ...entry, timeout: 900_000 });
        return { ...app, ok: true, note: `added (${note}). Restart Gemini CLI to load it` };
      }
      run('claude', ['mcp', 'remove', '--scope', 'user', 'lunardraw']); // nothing to remove the first time
      const r = run('claude', ['mcp', 'add', '--scope', 'user', 'lunardraw', '--', entry.command, ...entry.args]);
      return r.ok
        ? { ...app, ok: true, note: 'added for every folder (start a new `claude` session to load it)' }
        : { ...app, ok: false, note: `couldn't add it: ${r.out.trim().split('\n').pop() ?? 'no answer'}` };
    } catch (err) {
      return { ...app, ok: false, note: `couldn't add it: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

/** The lines for agents connect doesn't handle itself. */
export const manualLines = (entry: McpEntry): string[] => [
  `  OpenClaw:      openclaw mcp add lunardraw --command "${entry.command}" --arg "${entry.args[0]}" --arg mcp`,
  `  Hermes Agent:  in ~/.hermes/config.yaml, under mcp_servers:`,
  `                   lunardraw: { command: "${entry.command}", args: ["${entry.args[0]}", "mcp"], timeout: 900 }`,
  `  Anything else: command "${entry.command}", arguments "${entry.args[0]}" "mcp" (allow tool calls up to 15 minutes)`,
];

/** What to do next, by what got connected: the one step people missed was asking in the AI app, not the terminal. */
export const nextSteps = (connected: AppId[]): string[] => {
  if (connected.includes('claude-desktop')) {
    return [
      '1. Quit Claude completely' + (process.platform === 'win32' ? ' (right-click its icon by the clock, then Quit)' : process.platform === 'darwin' ? ' (Claude menu, then Quit)' : '') + ', then open it again.',
      '2. In Claude (not in this window), start a new chat and ask: "What\'s on in Starfall right now?"',
    ];
  }
  if (connected.includes('claude-code')) return ['Start `claude` in a terminal and ask: "What\'s on in Starfall right now?"'];
  if (connected.includes('gemini-cli')) return ['Start `gemini` in a terminal and ask: "What\'s on in Starfall right now?"'];
  return [
    'No AI app is connected yet. The easiest is the Claude desktop app: install it from https://claude.ai/download,',
    'sign in, then run `lunardraw-agent connect` here. (Claude in a web browser or on a phone can\'t reach your wallet.)',
    'Or play from this window: `lunardraw-agent status`, then `lunardraw-agent buy --games 2`.',
  ];
};
