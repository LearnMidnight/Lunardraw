/**
 * `lunardraw-agent remote`: let AIs on the web or a phone play with this
 * computer's agent, through Lunardraw's relay (relay-link.ts). It turns the
 * link on, keeps the agent running in the background from sign-in
 * (autostart.ts), starts it now, and gives the private address to add to
 * ChatGPT, claude.ai, Grok or any app that adds an MCP server by its address.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Launch, startAtLogin, startInBackground } from './autostart.js';
import { DEFAULT_RELAY, ensureSecret, type KitConfig, kitHome, kitPaths, saveConfig } from './home.js';
import { linkAddress } from './relay-link.js';

/** How the agent is started in the background: this Node and this kit, `serve --log <its log>`. */
export const agentLaunch = (home = kitHome(), node = process.execPath, script = process.argv[1], env: NodeJS.ProcessEnv = process.env): Launch => ({
  command: node,
  args: [script, 'serve', '--log', kitPaths(home).log],
  ...(env.LUNARDRAW_AGENT_HOME ? { env: { LUNARDRAW_AGENT_HOME: env.LUNARDRAW_AGENT_HOME } } : {}),
});

const servingFile = (home: string) => join(home, 'serve.pid');

/** Whether `lunardraw-agent serve` is running for this home (its pid), or undefined. */
export const serving = (home = kitHome()): number | undefined => {
  try {
    const { pid } = JSON.parse(readFileSync(servingFile(home), 'utf8')) as { pid: number };
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? -1 : undefined;
  }
};

/** Mark this process as the home's `serve` (removed when it exits). */
export const markServing = (home = kitHome()): void => {
  writeFileSync(servingFile(home), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }) + '\n');
  process.once('exit', () => {
    try {
      const { pid } = JSON.parse(readFileSync(servingFile(home), 'utf8')) as { pid: number };
      if (pid === process.pid) rmSync(servingFile(home));
    } catch {
      /* gone already */
    }
  });
};

/** The private address for AI apps (made the first time). */
export const remoteAddress = (config: KitConfig, home = kitHome(), fresh = false): string =>
  linkAddress(config.relay ?? DEFAULT_RELAY, ensureSecret(kitPaths(home, config.network).link, fresh));

/**
 * Turn the link on: config.json's "remote", the agent at sign-in (unless
 * `atLogin` is false), and the agent running now. Returns the address and what was done.
 */
export const turnOnRemote = (config: KitConfig, home = kitHome(), o: { atLogin?: boolean } = {}): { address: string; config: KitConfig; atLogin?: string; started: 'already' | 'now' | 'by the system' } => {
  const on: KitConfig = { ...config, remote: true };
  saveConfig(on, home);
  const address = remoteAddress(on, home);
  const launch = agentLaunch(home);
  let atLogin: string | undefined;
  let byTheSystem = false;
  if (o.atLogin !== false) {
    const r = startAtLogin(launch, kitPaths(home).log);
    atLogin = r.file;
    byTheSystem = r.startsNow;
  }
  if (serving(home)) return { address, config: on, atLogin, started: 'already' };
  if (byTheSystem) return { address, config: on, atLogin, started: 'by the system' };
  startInBackground(launch, kitPaths(home).log);
  return { address, config: on, atLogin, started: 'now' };
};

/** How to add the address to each AI app. */
export const remoteSteps = (): string[] => [
  'ChatGPT (web; Plus or Pro):',
  '  Settings, Security and login (or Apps): turn on Developer mode. Then Settings, Plugins (or Apps and connectors),',
  '  "+" / Create: name it Lunardraw, paste the address as its MCP server URL, choose No authentication, and save.',
  '  In a chat, pick Lunardraw from the + menu (Developer mode) and ask.',
  'Claude (claude.ai, then on your phone too):',
  '  Customize (or Settings), Connectors, Add custom connector: name it Lunardraw, paste the address,',
  '  choose No sign-in if it asks, and Add. Then ask in any chat, on the web or in the Claude phone app.',
  'Grok (grok.com):',
  '  grok.com/connectors, New Connector, Custom: paste the address.',
  'Anything else that adds an MCP server by its address (Streamable HTTP): paste the address; no sign-in.',
  '',
  'Then ask: "What\'s on in Starfall right now?"',
  '',
  `Keep the address private: anyone with it can ask your agent to buy (within your limits in config.json).`,
  '`lunardraw-agent remote new-link` makes a new one and the old one stops working. Your computer needs to be on.',
];

/** The link is on in config.json and its secret is there. */
export const remoteOn = (config: KitConfig, home = kitHome()): boolean => !!config.remote && existsSync(kitPaths(home, config.network).link);
