/**
 * `lunardraw-agent setup`: the guided first run. One question at a time:
 * a Blockfrost key (checked before going on), test tNIGHT from the faucet,
 * connecting an AI (Claude Desktop's settings are written for
 * them), then the wallet's first sync with a progress bar. Run it again any
 * time: done steps are skipped, and the sync carries on where it stopped.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_CONFIG, ensureWallet, hasBlockfrost, type KitConfig, kitHome, kitPaths, loadConfig, saveBlockfrost, saveConfig, useHome } from './home.js';

const BLOCKFROST_SIGNUP = 'https://blockfrost.io/';
const BLOCKFROST_INDEXER: Record<string, string> = { preprod: 'https://midnight-preprod.blockfrost.io/api/v0' };
const FAUCET: Record<string, string> = {
  preprod: 'https://midnight-tmnight-preprod.nethermind.dev/',
  preview: 'https://midnight-tmnight-preview.nethermind.dev/',
};

// ------------------------------------------------------------------ pure helpers (tested)

type Progress = { appliedIndex?: bigint; appliedId?: bigint; highestIndex?: bigint; highestRelevantWalletIndex?: bigint; highestTransactionId?: bigint; isStrictlyComplete?: () => boolean };

/** How far a wallet has synced, 0 to 1: the slower of its shielded and DUST parts (the unshielded part is quick). */
export const syncFraction = (state: unknown): number => {
  const s = state as { isSynced?: boolean; shielded?: { state?: { progress?: Progress } }; dust?: { state?: { progress?: Progress } } };
  if (s?.isSynced) return 1;
  const part = (p: Progress | undefined): number => {
    if (!p) return 0;
    if (p.isStrictlyComplete?.()) return 1;
    const applied = p.appliedIndex ?? p.appliedId;
    const target = p.highestRelevantWalletIndex ?? p.highestTransactionId ?? p.highestIndex;
    if (applied === undefined || target === undefined || target === 0n) return 0;
    return Math.min(1, Number((applied * 10_000n) / target) / 10_000);
  };
  return Math.min(part(s?.shielded?.state?.progress), part(s?.dust?.state?.progress));
};

/** "about 2 h 10 min left", from the progress made since `start`. */
export const eta = (start: { at: number; f: number }, now: { at: number; f: number }): string => {
  const rate = (now.f - start.f) / (now.at - start.at);
  if (!(rate > 0) || now.at - start.at < 60_000) return 'working out how long';
  const mins = Math.ceil((1 - now.f) / rate / 60_000);
  if (mins <= 1) return 'about a minute left';
  if (mins < 60) return `about ${mins} min left`;
  return `about ${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''} left`;
};

/** A one-line progress bar: "[########------------]  40%". */
export const bar = (f: number, width = 30): string => {
  const n = Math.round(Math.max(0, Math.min(1, f)) * width);
  return `[${'#'.repeat(n)}${'-'.repeat(width - n)}] ${String(Math.floor(f * 100)).padStart(3)}%`;
};

/** Where Claude Desktop keeps its settings on this computer. */
export const claudeDesktopConfig = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : platform === 'win32'
      ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json');

export type McpEntry = { command: string; args: string[]; env?: Record<string, string> };

/** How an MCP client starts this kit: Node and the kit's own path (GUI apps often can't find global commands). */
export const mcpEntry = (node = process.execPath, script = process.argv[1], env: NodeJS.ProcessEnv = process.env): McpEntry => ({
  command: node,
  args: [script, 'mcp'],
  ...(env.LUNARDRAW_AGENT_HOME ? { env: { LUNARDRAW_AGENT_HOME: env.LUNARDRAW_AGENT_HOME } } : {}),
});

/** Claude Desktop's settings with Lunardraw added (other servers and settings kept). */
export const withLunardraw = (configText: string | undefined, entry: McpEntry): string => {
  const config = configText?.trim() ? (JSON.parse(configText) as { mcpServers?: Record<string, unknown> }) : {};
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('Claude Desktop\'s settings file isn\'t a JSON object');
  return JSON.stringify({ ...config, mcpServers: { ...(config.mcpServers ?? {}), lunardraw: entry } }, null, 2) + '\n';
};

// ------------------------------------------------------------------ the wizard

const openUrl = (url: string): void => {
  try {
    const [cmd, args] =
      process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    /* no browser here: the link is printed anyway */
  }
};

/** Checks a Blockfrost project id against Midnight's Preprod indexer. */
export const checkBlockfrost = async (id: string, network: string, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; why?: string }> => {
  const base = BLOCKFROST_INDEXER[network];
  if (!base) return { ok: true };
  try {
    const r = await fetcher(`${base}?project_id=${encodeURIComponent(id.trim())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"query":"{ __typename }"}',
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, why: 'Blockfrost doesn\'t accept that key. Check it\'s the project id of a **Midnight Preprod** project.' };
    return { ok: false, why: `Blockfrost answered HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, why: `couldn't reach Blockfrost (${err instanceof Error ? err.message : String(err)})` };
  }
};

export const setup = async (): Promise<number> => {
  if (!process.stdin.isTTY) {
    process.stdout.write('Run `lunardraw-agent setup` in a terminal window: it asks a few questions.\n');
    return 1;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const say = (s = '') => process.stdout.write(s + '\n');
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const yes = async (q: string) => !/^n/i.test((await rl.question(`${q} [Y/n] `)).trim());
  const step = (n: number, title: string) => say(`\n${bold(`Step ${n} of 4: ${title}`)}`);
  const home = kitHome();

  try {
    say(bold('\nLunardraw agent setup'));
    say('This sets up a wallet for your AI agent to play Starfall, a lottery on the Midnight Preprod test network.');
    say('It uses test tokens (tNIGHT) with no real value. Your wallet stays on this computer; Lunardraw never sees it.');
    say('About 10 minutes of your time, then the wallet syncs by itself (hours, the first time only).');

    let config: KitConfig;
    try {
      config = loadConfig(home);
    } catch {
      config = { ...DEFAULT_CONFIG };
      saveConfig(config, home);
    }
    const { seed, created } = ensureWallet(home);
    const paths = kitPaths(home, config.network);
    if (created) say(`\nCreated a new wallet in ${paths.wallet}. Back this file up and keep it private: anyone with it can spend from the wallet.`);

    // 1. Blockfrost
    step(1, 'a free Blockfrost key');
    if (hasBlockfrost(home, config.network)) {
      say('✓ Already set.');
    } else {
      say('Midnight Preprod is served by Blockfrost, and your agent needs its own free key to reach it.');
      say(`  1. Sign up at ${BLOCKFROST_SIGNUP} (the free plan is plenty).`);
      say('  2. In the dashboard, click "Add project", give it any name, and choose the network "Midnight Preprod".');
      say('  3. Copy the project\'s "project ID".');
      if (await yes('Open blockfrost.io in your browser now?')) openUrl(BLOCKFROST_SIGNUP);
      for (;;) {
        const id = (await rl.question('Paste the project ID here (or press Enter to stop for now): ')).trim();
        if (!id) {
          say('No problem: run `lunardraw-agent setup` again when you have it.');
          return 1;
        }
        process.stdout.write('Checking it with Blockfrost… ');
        const check = await checkBlockfrost(id, config.network);
        if (check.ok) {
          saveBlockfrost(id, home, config.network);
          say('✓ It works. Saved.');
          break;
        }
        say(`✗ ${check.why?.replace(/\*\*/g, '')}`);
      }
    }
    useHome(config, home);

    // 2. test tNIGHT
    step(2, 'test tNIGHT from the faucet');
    const { walletAddressOf } = await import('@nightcast/deploy');
    const address = walletAddressOf(config.network, seed);
    const faucet = FAUCET[config.network];
    say('Your wallet\'s address:');
    say(`\n  ${bold(address)}\n`);
    say(`Paste it into the faucet (${faucet}), tick the captcha and ask for tNIGHT. It's free.`);
    if (await yes('Open the faucet in your browser now?')) openUrl(faucet);
    await rl.question('Press Enter once you\'ve asked the faucet (the tokens arrive while the wallet syncs). ');

    // 3. the AI assistant
    step(3, 'connect your AI');
    const entry = mcpEntry();
    const desktop = claudeDesktopConfig();
    if (existsSync(dirname(desktop))) {
      if (await yes('Claude Desktop is installed. Add Lunardraw to it?')) {
        const before = existsSync(desktop) ? readFileSync(desktop, 'utf8') : undefined;
        if (before !== undefined) copyFileSync(desktop, `${desktop}.before-lunardraw`);
        mkdirSync(dirname(desktop), { recursive: true });
        writeFileSync(desktop, withLunardraw(before, entry));
        say(`✓ Added. Quit and reopen Claude Desktop to load it.${before !== undefined ? ` (Your old settings are saved as ${desktop}.before-lunardraw.)` : ''}`);
      }
    } else {
      say('Claude Desktop isn\'t installed here (that\'s fine).');
    }
    say('\nOther AI apps and agents (any that can run a local MCP server; pick the one you use):');
    say(`  Claude Code:   claude mcp add lunardraw -- "${entry.command}" "${entry.args[0]}" mcp`);
    say(`  Gemini CLI:    gemini mcp add lunardraw "${entry.command}" "${entry.args[0]}" mcp`);
    say(`  OpenClaw:      openclaw mcp add lunardraw --command "${entry.command}" --arg "${entry.args[0]}" --arg mcp`);
    say(`  Hermes Agent:  in ~/.hermes/config.yaml, under mcp_servers:`);
    say(`                   lunardraw: { command: "${entry.command}", args: ["${entry.args[0]}", "mcp"], timeout: 900 }`);
    say(`  Anything else: command "${entry.command}", arguments "${entry.args[0]}" "mcp"`);
    say('  (Allow tool calls up to 15 minutes: the first purchase opens the wallet, then buys.)');
    say('ChatGPT and Grok can use any of these agents as the brain (OpenClaw and Hermes run GPT, Grok and Gemini models);');
    say("their own apps only reach MCP servers on the internet, which this one (holding your wallet) deliberately isn't.");

    // the agent directory (opt in)
    if (!config.listing && (await yes('\nShow your agent in the agent directory on lunardraw.io? It shows a name you choose and its totals, never its numbers.'))) {
      const { NAME_RULE, VIAS } = await import('../listing.js');
      let name = '';
      while (!NAME_RULE.test(name)) {
        name = (await rl.question('Its name (2-20 letters, digits, spaces, . _ -; Enter to skip): ')).trim();
        if (!name) break;
      }
      if (name) {
        const via = (await rl.question(`Which AI plays it? (${VIAS.join(', ')}) [other]: `)).trim().toLowerCase() || 'other';
        const style = (await rl.question('Its style in a few words (optional, e.g. "Plays every night"): ')).trim().slice(0, 40);
        try {
          const { sendListing, viaOf } = await import('./directory.js');
          const listing = { name, style, via: viaOf(via) };
          await sendListing(config, seed, 'list', { home, listing });
          config = { ...config, listing };
          saveConfig(config, home);
          say(`✓ ${name} is in the directory: https://lunardraw.io/agents/ (\`lunardraw-agent unlist\` takes it out).`);
        } catch (err) {
          say(`Couldn't list it now (${err instanceof Error ? err.message : String(err)}); try later with: lunardraw-agent list --name "${name}"`);
        }
      }
    }

    // 4. sync
    step(4, 'sync the wallet');
    say('The wallet now reads the Preprod chain. The first time takes hours; leave this window open.');
    say('If you need to stop, press Ctrl+C and run `lunardraw-agent setup` later: it carries on where it stopped.\n');
    rl.close();
    process.env.NIGHTCAST_LOG_LEVEL ??= 'warn'; // the progress bar instead of the log
    const { syncWallet } = await import('./player.js');
    const tty = process.stdout.isTTY;
    let shown = '';
    const show = (line: string) => {
      if (line === shown) return;
      shown = line;
      process.stdout.write(tty ? `\r\x1b[2K${line}` : `${line}\n`);
    };
    let first: { at: number; f: number } | undefined;
    const result = await syncWallet(config, seed, {
      onProgress: (f) => {
        const now = { at: Date.now(), f };
        first ??= now;
        show(`${bar(f)}  ${f >= 1 ? 'synced' : eta(first, now)}`);
      },
      onPhase: (phase) => {
        if (tty) process.stdout.write('\n');
        shown = '';
        say(
          phase === 'no-funds'
            ? `Synced. Waiting for your tNIGHT to arrive (from the faucet, to ${address})…`
            : 'Got the tNIGHT. Registering it for DUST (the fee token) and waiting for the first DUST, usually a few minutes…',
        );
      },
    });
    if (tty) process.stdout.write('\n');
    say(`\n${bold('All set!')} The wallet holds ${Number(result.night) / 1e6} tNIGHT and has DUST for fees.`);
    say('\nAsk your AI assistant something like:');
    say(bold('  "What\'s on in Starfall? Buy me two QuickPick games."'));
    say('\nOr from here: `lunardraw-agent status`, `lunardraw-agent buy --games 2`, `lunardraw-agent tickets`.');
    say(`Spending limits: ${config.limits.perDraw} tNIGHT a draw, ${config.limits.perDay} a day (change them in ${paths.config}).`);
    return 0;
  } finally {
    rl.close();
  }
};
