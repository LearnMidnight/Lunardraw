/**
 * `lunardraw-agent connect`: find the AI apps on this computer and add
 * Lunardraw to each, so nobody edits settings files or copies paths:
 *
 *   Claude (the desktop app)    its claude_desktop_config.json (the Microsoft Store
 *                               install's own folder too)
 *   Claude Code                 `claude mcp add --scope user …`
 *   ChatGPT (desktop) and Codex ~/.codex/config.toml (they share it)
 *   Gemini CLI                  ~/.gemini/settings.json
 *   Cursor                      ~/.cursor/mcp.json
 *   VS Code (Copilot)           the user's mcp.json
 *   Windsurf                    ~/.codeium/windsurf/mcp_config.json
 *   LM Studio                   ~/.lmstudio/mcp.json
 *   OpenClaw                    `openclaw mcp add …`
 *   Hermes Agent                ~/.hermes/config.yaml
 *
 * Every settings file is backed up beside itself first (<file>.before-lunardraw),
 * and only Lunardraw's own entry is added or replaced. Anything else gets the
 * line to add (manualLines). Also what `lunardraw-agent doctor` uses to say
 * which apps are connected.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeDesktopConfigs, type McpEntry, withLunardraw } from './setup.js';

export type AppId =
  | 'claude-desktop'
  | 'claude-code'
  | 'chatgpt-codex'
  | 'gemini-cli'
  | 'cursor'
  | 'vscode'
  | 'windsurf'
  | 'lm-studio'
  | 'openclaw'
  | 'hermes';

export type FoundApp = {
  id: AppId;
  /** For people: "Claude (desktop app)". */
  name: string;
  /** The settings file, for the apps set up by file. */
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
export const codexConfig = (home = homedir(), env: NodeJS.ProcessEnv = process.env): string => join(env.CODEX_HOME || join(home, '.codex'), 'config.toml');
export const hermesConfig = (home = homedir()): string => join(home, '.hermes', 'config.yaml');

/** VS Code's user settings folder (where its mcp.json lives). */
export const vscodeUserDir = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  platform === 'win32'
    ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Code', 'User')
    : platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Code', 'User')
      : join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Code', 'User');

/** Whether the ChatGPT desktop app is installed (it keeps its MCP servers in Codex's config). */
const chatgptInstalled = (home: string, exists: (p: string) => boolean, env: NodeJS.ProcessEnv, list: (dir: string) => string[]): boolean => {
  if (process.platform === 'darwin') return exists('/Applications/ChatGPT.app') || exists(join(home, 'Applications', 'ChatGPT.app'));
  if (process.platform === 'win32') {
    const packages = join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Packages');
    return list(packages).some((d) => /^OpenAI\.ChatGPT/i.test(d)) || exists(join(env.LOCALAPPDATA ?? '', 'Programs', 'ChatGPT'));
  }
  return false;
};

const safeList = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The AI apps installed here that Lunardraw can be added to. */
export const findApps = (
  o: { home?: string; hasCommand?: (cmd: string) => boolean; exists?: (path: string) => boolean; env?: NodeJS.ProcessEnv; list?: (dir: string) => string[] } = {},
): FoundApp[] => {
  const home = o.home ?? homedir();
  const exists = o.exists ?? existsSync;
  const has = o.hasCommand ?? onPath;
  const env = o.env ?? process.env;
  const list = o.list ?? safeList;
  const out: FoundApp[] = [];
  // the file Claude reads is the one that's there; failing that, the first folder that is
  const where = claudeDesktopConfigs(process.platform, env, home);
  const desktop = where.find((f) => exists(f)) ?? where.find((f) => exists(dirname(f)));
  if (desktop) out.push({ id: 'claude-desktop', name: 'Claude (desktop app)', file: desktop });
  if (has('claude')) out.push({ id: 'claude-code', name: 'Claude Code' });
  const codex = codexConfig(home, env);
  if (exists(dirname(codex)) || has('codex') || chatgptInstalled(home, exists, env, list)) {
    out.push({ id: 'chatgpt-codex', name: 'ChatGPT (desktop app) and Codex', file: codex });
  }
  if (exists(join(home, '.gemini')) || has('gemini')) out.push({ id: 'gemini-cli', name: 'Gemini CLI', file: geminiSettings(home) });
  if (exists(join(home, '.cursor'))) out.push({ id: 'cursor', name: 'Cursor', file: join(home, '.cursor', 'mcp.json') });
  const vscode = vscodeUserDir(process.platform, env, home);
  if (exists(vscode)) out.push({ id: 'vscode', name: 'VS Code (Copilot)', file: join(vscode, 'mcp.json') });
  if (exists(join(home, '.codeium', 'windsurf'))) out.push({ id: 'windsurf', name: 'Windsurf', file: join(home, '.codeium', 'windsurf', 'mcp_config.json') });
  if (exists(join(home, '.lmstudio'))) out.push({ id: 'lm-studio', name: 'LM Studio', file: join(home, '.lmstudio', 'mcp.json') });
  if (has('openclaw')) out.push({ id: 'openclaw', name: 'OpenClaw' });
  if (exists(join(home, '.hermes')) || has('hermes')) out.push({ id: 'hermes', name: 'Hermes Agent', file: hermesConfig(home) });
  return out;
};

// ------------------------------------------------------------------ settings files

/**
 * VS Code's mcp.json: Lunardraw under "servers" (with "type": "stdio"),
 * everything else kept.
 */
export const withLunardrawVscode = (configText: string | undefined, entry: McpEntry): string => {
  const config = configText?.trim() ? (JSON.parse(configText) as { servers?: Record<string, unknown> }) : {};
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error("the settings file isn't a JSON object");
  return JSON.stringify({ ...config, servers: { ...(config.servers ?? {}), lunardraw: { type: 'stdio', ...entry } } }, null, 2) + '\n';
};

/** Codex's settings (TOML): what a header names, e.g. [mcp_servers.lunardraw.env] → ['mcp_servers', 'lunardraw', 'env']. */
const tomlHeader = (line: string): string[] | undefined => {
  const m = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
  if (!m) return undefined;
  return m[1].split('.').map((k) => k.trim().replace(/^"(.*)"$|^'(.*)'$/, (_s, a, b) => a ?? b));
};

/**
 * Codex's config.toml (which the ChatGPT desktop app shares) with Lunardraw's
 * [mcp_servers.lunardraw] table replaced or added; every other line kept as
 * it was. Its timeouts give the kit time to start (it loads Midnight's
 * libraries) and a purchase time to answer (within 45 s; it then finishes on
 * its own).
 */
export const withLunardrawToml = (configText: string | undefined, entry: McpEntry): string => {
  const lines = (configText ?? '').split(/\r?\n/);
  const ours = (h: string[] | undefined) => !!h && h[0] === 'mcp_servers' && h[1] === 'lunardraw';
  if (lines.some((l) => /^\s*mcp_servers\s*\.\s*"?lunardraw"?\s*\./.test(l) || /^\s*mcp_servers\s*=/.test(l))) {
    throw new Error('its mcp_servers are written in a form this can\'t edit safely: add Lunardraw by hand (see below)');
  }
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const h = tomlHeader(line);
    if (h) skipping = ours(h);
    if (!skipping) kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const s = (v: string) => JSON.stringify(v); // a TOML basic string takes JSON's escapes
  const block = [
    '[mcp_servers.lunardraw]',
    `command = ${s(entry.command)}`,
    `args = [${entry.args.map(s).join(', ')}]`,
    'startup_timeout_sec = 60',
    'tool_timeout_sec = 120',
    ...(entry.env ? ['', '[mcp_servers.lunardraw.env]', ...Object.entries(entry.env).map(([k, v]) => `${k} = ${s(v)}`)] : []),
  ];
  return [...kept, ...(kept.length ? [''] : []), ...block, ''].join('\n');
};

/**
 * Hermes Agent's config.yaml with Lunardraw under mcp_servers (replaced if
 * it's there); every other line kept as it was.
 */
export const withLunardrawYaml = (configText: string | undefined, entry: McpEntry): string => {
  const lines = (configText ?? '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indentOf = (l: string) => /^ */.exec(l)![0].length;
  const content = (l: string) => l.trim() !== '' && !l.trim().startsWith('#');
  const q = (v: string) => JSON.stringify(v); // a YAML double-quoted string takes JSON's escapes
  const at = lines.findIndex((l) => /^mcp_servers\s*:/.test(l));
  const entryLines = (pad: string) => [
    `${pad}lunardraw:`,
    `${pad}${pad}command: ${q(entry.command)}`,
    `${pad}${pad}args: [${entry.args.map(q).join(', ')}]`,
    ...(entry.env ? [`${pad}${pad}env:`, ...Object.entries(entry.env).map(([k, v]) => `${pad}${pad}${pad}${k}: ${q(v)}`)] : []),
  ];
  if (at < 0) return [...lines, ...(lines.length ? [''] : []), 'mcp_servers:', ...entryLines('  '), ''].join('\n');
  const rest = lines[at].replace(/^mcp_servers\s*:/, '').trim();
  if (rest && !rest.startsWith('#')) {
    if (!/^\{\s*\}$/.test(rest)) throw new Error('its mcp_servers are written on one line, which this can\'t edit safely: add Lunardraw by hand (see below)');
    lines[at] = 'mcp_servers:';
  }
  // the servers under it, up to the next top-level key
  let end = at + 1;
  while (end < lines.length && (!content(lines[end]) || indentOf(lines[end]) > 0)) end++;
  const first = lines.slice(at + 1, end).find(content);
  const pad = ' '.repeat(first ? indentOf(first) : 2);
  const body = lines.slice(at + 1, end);
  const kept: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (new RegExp(`^${pad}["']?lunardraw["']?\\s*:`).test(body[i])) {
      i++;
      while (i < body.length && (!content(body[i]) || indentOf(body[i]) > pad.length)) i++;
      i--;
      continue;
    }
    kept.push(body[i]);
  }
  return [...lines.slice(0, at + 1), ...entryLines(pad), ...kept, ...lines.slice(end), ''].join('\n');
};

/** A settings file with Lunardraw added, the old one kept beside it. */
const addToFile = (file: string, update: (before: string | undefined) => string): string => {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  let after: string;
  try {
    after = update(before);
  } catch (err) {
    const why = err instanceof SyntaxError ? 'the settings file has comments or isn\'t plain JSON, so it was left alone: add Lunardraw by hand (see below)' : err instanceof Error ? err.message : String(err);
    throw new Error(why);
  }
  if (before !== undefined && !existsSync(`${file}.before-lunardraw`)) copyFileSync(file, `${file}.before-lunardraw`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after);
  return before !== undefined ? `your old settings are kept as ${file}.before-lunardraw` : 'new settings file';
};

/** Whether Lunardraw is already in an app's settings. */
export const isConnected = (app: FoundApp): boolean => {
  try {
    if (app.id === 'claude-code') return run('claude', ['mcp', 'get', 'lunardraw']).ok;
    if (app.id === 'openclaw') {
      const r = run('openclaw', ['mcp', 'status']);
      return r.ok && /\blunardraw\b/.test(r.out);
    }
    if (!app.file || !existsSync(app.file)) return false;
    const text = readFileSync(app.file, 'utf8');
    if (app.id === 'chatgpt-codex') return text.split(/\r?\n/).some((l) => (tomlHeader(l) ?? []).join('.') === 'mcp_servers.lunardraw');
    if (app.id === 'hermes') return /^\s+["']?lunardraw["']?\s*:/m.test(text) && /^mcp_servers\s*:/m.test(text);
    const config = JSON.parse(text) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
    return !!(app.id === 'vscode' ? config.servers?.lunardraw : config.mcpServers?.lunardraw);
  } catch {
    return false;
  }
};

const RELOAD: Record<AppId, string> = {
  'claude-desktop': 'Quit Claude completely and open it again to load it',
  'claude-code': 'start a new `claude` session to load it',
  'chatgpt-codex': 'quit ChatGPT and open it again (or Settings, MCP servers, Restart); for Codex, start a new session',
  'gemini-cli': 'restart Gemini CLI to load it',
  cursor: 'restart Cursor, then turn Lunardraw on in Settings, MCP',
  vscode: 'in VS Code, open Copilot Chat in Agent mode; start Lunardraw from the Extensions view (MCP Servers) if it asks',
  windsurf: 'restart Windsurf (or refresh its MCP servers in Cascade)',
  'lm-studio': 'restart LM Studio, then turn Lunardraw on in a chat\'s tools (Program)',
  openclaw: 'run `openclaw mcp reload`, or restart OpenClaw',
  hermes: 'type /reload-mcp in Hermes, or start it again',
};

/** Add Lunardraw to each app (an app it's already in is updated, so a moved install is fixed too). */
export const connectApps = (apps: FoundApp[], entry: McpEntry): ConnectResult[] =>
  apps.map((app) => {
    try {
      const done = (note: string): ConnectResult => ({ ...app, ok: true, note: `added (${note}). ${RELOAD[app.id][0].toUpperCase()}${RELOAD[app.id].slice(1)}` });
      switch (app.id) {
        case 'claude-desktop':
        case 'cursor':
        case 'windsurf':
        case 'lm-studio':
          return done(addToFile(app.file!, (t) => withLunardraw(t, entry)));
        case 'gemini-cli':
          return done(addToFile(app.file!, (t) => withLunardraw(t, { ...entry, timeout: 900_000 } as McpEntry)));
        case 'vscode':
          return done(addToFile(app.file!, (t) => withLunardrawVscode(t, entry)));
        case 'chatgpt-codex':
          return done(addToFile(app.file!, (t) => withLunardrawToml(t, entry)));
        case 'hermes':
          return done(addToFile(app.file!, (t) => withLunardrawYaml(t, entry)));
        case 'openclaw': {
          run('openclaw', ['mcp', 'remove', 'lunardraw']); // nothing to remove the first time
          const r = run('openclaw', ['mcp', 'add', 'lunardraw', '--command', entry.command, ...entry.args.flatMap((a) => ['--arg', a])]);
          return r.ok ? done('with `openclaw mcp add`') : { ...app, ok: false, note: `couldn't add it: ${r.out.trim().split('\n').pop() || 'no answer'}` };
        }
        case 'claude-code': {
          run('claude', ['mcp', 'remove', '--scope', 'user', 'lunardraw']); // nothing to remove the first time
          const r = run('claude', ['mcp', 'add', '--scope', 'user', 'lunardraw', '--', entry.command, ...entry.args]);
          return r.ok
            ? { ...app, ok: true, note: 'added for every folder (start a new `claude` session to load it)' }
            : { ...app, ok: false, note: `couldn't add it: ${r.out.trim().split('\n').pop() || 'no answer'}` };
        }
      }
    } catch (err) {
      return { ...app, ok: false, note: `couldn't add it: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

/** The lines for apps and agents connect doesn't set up itself. */
export const manualLines = (entry: McpEntry): string[] => {
  const json = JSON.stringify({ command: entry.command, args: entry.args });
  return [
    `  Most apps (Cline, Zed, Goose, Continue, Msty, AnythingLLM…): add an MCP server ("stdio" / "command") named lunardraw:`,
    `                   ${json}`,
    `                 Allow tool calls at least 60 seconds (a purchase answers within 45 and then finishes by itself).`,
    `  Your own agent:  run that command and speak MCP over stdin/stdout, or use the command line with --json`,
    '                 (`lunardraw-agent status --json`, `buy --games 2 --json`, `tickets --json`).',
    '  ChatGPT, Claude or Grok on the web or a phone: `lunardraw-agent remote` gives them a private address (through Lunardraw\'s relay).',
  ];
};

/** What to do next, by what got connected: the one step people missed was asking in the AI app, not the terminal. */
export const nextSteps = (connected: AppId[]): string[] => {
  const ask = '"What\'s on in Starfall right now?"';
  if (connected.includes('claude-desktop')) {
    return [
      '1. Quit Claude completely' + (process.platform === 'win32' ? ' (right-click its icon by the clock, then Quit)' : process.platform === 'darwin' ? ' (Claude menu, then Quit)' : '') + ', then open it again.',
      `2. In Claude (not in this window), start a new chat and ask: ${ask}`,
    ];
  }
  if (connected.includes('chatgpt-codex')) {
    return [
      '1. Quit ChatGPT completely and open it again (or Settings, MCP servers, Restart). In Codex, start a new session.',
      `2. In ChatGPT (not in this window), start a new chat and ask: ${ask}`,
    ];
  }
  if (connected.includes('claude-code')) return [`Start \`claude\` in a terminal and ask: ${ask}`];
  if (connected.includes('cursor') || connected.includes('vscode') || connected.includes('windsurf')) {
    return [`Restart your editor, open its AI chat (Agent mode) and ask: ${ask}`];
  }
  if (connected.includes('gemini-cli')) return [`Start \`gemini\` in a terminal and ask: ${ask}`];
  if (connected.includes('lm-studio')) return [`Restart LM Studio, turn on Lunardraw in a chat's tools and ask: ${ask}`];
  if (connected.includes('openclaw') || connected.includes('hermes')) return [`Reload your agent's MCP servers (see above) and ask it: ${ask}`];
  return [
    'No AI app is connected yet. The easiest is the Claude desktop app (https://claude.ai/download) or the ChatGPT',
    'desktop app (https://openai.com/chatgpt/download): install one, sign in, then run `lunardraw-agent connect` here.',
    'Or play from this window: `lunardraw-agent status`, then `lunardraw-agent buy --games 2`.',
  ];
};
