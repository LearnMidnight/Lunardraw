#!/usr/bin/env node
/**
 * lunardraw-agent: play Starfall (Lunardraw's lottery on Midnight Preprod)
 * from an AI agent's own machine and wallet. See README-agent.md.
 */
import { existsSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  agentPort,
  DEFAULT_CONFIG,
  DEFAULT_RELAY,
  ensureSecret,
  ensureWallet,
  hasBlockfrost,
  type KitConfig,
  kitHome,
  kitPaths,
  loadConfig,
  saveBlockfrost,
  saveConfig,
  useHome,
} from './home.js';
import type { Player } from './player.js';

export const KIT_USAGE = `lunardraw-agent: play Starfall, Lunardraw's lottery on the Midnight Preprod test network, from your own wallet.

  lunardraw-agent setup                              the guided setup: start here
  lunardraw-agent connect                            add Lunardraw to the AI apps on this computer (Claude, ChatGPT,
                                                     Codex, Gemini CLI, Cursor, VS Code, Windsurf, LM Studio, OpenClaw, Hermes)
  lunardraw-agent doctor                             check everything and say what to fix
  lunardraw-agent init [--blockfrost <project id>]   the same without questions: a wallet and a config
  lunardraw-agent address                            the wallet's address (to fund it from the faucet)
  lunardraw-agent status                             the draw on sale, the jackpot, recent results
  lunardraw-agent wallet                             tNIGHT and DUST (opens the wallet: see below)
  lunardraw-agent buy [--games <n> | --package <name> | --numbers "<7 numbers>" [--moonball <n>]
                      | --system <8-12> [--numbers ...] | --pick <5|6> [--numbers ...]] [--sweep] [--yes]
  lunardraw-agent tickets                            what this agent bought and how each draw went
  lunardraw-agent play [--style mix|quickpick|lucky|moonhit|system] [--games <n>] [--numbers ... --moonball <n>]
                                                     keep playing every draw, within the limits
  lunardraw-agent limits [--per-draw <tNIGHT>] [--per-day <tNIGHT>]
                                                     the owner's spending limits, or set them
  lunardraw-agent list --name <name> [--style "<few words>"] [--via claude|chatgpt|gemini|openclaw|hermes|mcp|cli|...]
                                                     show this agent in lunardraw.io's agent directory (its name, style
                                                     and totals, signed by its wallet; never its numbers)
  lunardraw-agent unlist                             take it out of the directory
  lunardraw-agent mcp                                run as an MCP server for your AI (what connect sets up)
  lunardraw-agent remote [off | new-link | address]  let ChatGPT, Claude or Grok on the web or a phone play too, through
                                                     Lunardraw's relay (keeps the agent running from sign-in)
  lunardraw-agent serve [--port <n>] [--host <ip>]   run the agent here: a local address for your own programs
                                                     (REST and MCP over HTTP; see /openapi.json) and the relay link
  lunardraw-agent stop                               stop the agent running in the background
  lunardraw-agent skill                              how an AI agent plays, as a skill file (SKILL.md) to give it

--json prints machine-readable output (status, wallet, buy, tickets).
One agent runs per computer: every AI app connected to it shares it (and its open wallet).

Everything lives in ${kitHome()} (LUNARDRAW_AGENT_HOME). Test tokens only: tNIGHT has no value.
A new wallet's first sync reads the whole Preprod chain, which takes hours; after that its saved state
opens in a few minutes. Prizes and refunds are paid to the wallet automatically: there is nothing to claim.`;

const say = (s = '') => process.stdout.write(s + '\n');
/** "14587.198418 tNIGHT" as "14,587 tNIGHT", for people. */
export const whole = (amount: string): string => {
  const n = Number.parseFloat(amount);
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString('en')} tNIGHT` : amount;
};
/** An ISO time as this machine's local clock time, e.g. "3:00 pm". */
export const clock = (iso: string): string => new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });

const setup = (): { config: KitConfig; seed: string } => {
  const config = loadConfig();
  useHome(config);
  if (!hasBlockfrost(kitHome(), config.network)) {
    throw new Error(`no Blockfrost project id yet: get a free one at https://blockfrost.io (a Midnight ${config.network} project), then run \`lunardraw-agent init --blockfrost <project id>\``);
  }
  return { config, seed: ensureWallet().seed };
};

/**
 * For an AI app that starts the kit before anyone ran setup (the Claude
 * extension, say): a config with the default limits and a new wallet if
 * there are none yet, and the Blockfrost key the app was given
 * (LUNARDRAW_BLOCKFROST, from the extension's settings) kept in the home.
 */
const firstRun = (home: string): KitConfig => {
  let config: KitConfig;
  try {
    config = loadConfig(home);
  } catch (err) {
    if (existsSync(kitPaths(home).config)) throw err; // there, but broken: say so
    config = DEFAULT_CONFIG;
    saveConfig(config, home);
  }
  ensureWallet(home);
  const key = process.env.LUNARDRAW_BLOCKFROST?.trim();
  if (key) {
    const file = kitPaths(home, config.network).blockfrost;
    const had = existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
    if (had !== key) {
      try {
        saveBlockfrost(key, home, config.network);
      } catch (err) {
        process.stderr.write(`lunardraw: the Blockfrost project id from the app's settings wasn't kept: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  return config;
};

/** Send everything this process prints to a log file (the agent in the background). */
const logTo = (file: string): void => {
  try {
    if (statSync(file).size > 5 * 2 ** 20) renameSync(file, `${file}.old`);
  } catch {
    /* new log */
  }
  const fd = openSync(file, 'a');
  const write = (chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string') writeSync(fd, chunk);
    else writeSync(fd, chunk as Uint8Array);
    const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
    cb?.();
    return true;
  };
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
};

/** The agent running on this computer (an AI app's, or `serve`), to ask instead of opening the wallet again. */
const runningAgent = async (config: KitConfig) => {
  const { findHost } = await import('./host.js');
  const home = kitHome();
  const port = agentPort(config);
  if (!(await findHost(port, home))) return undefined;
  const token = ensureSecret(kitPaths(home, config.network).token);
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    const out = (await r.json()) as { error?: string };
    if (!r.ok) throw new Error(out.error ?? `the agent answered ${r.status}`);
    return out;
  };
  return { get: (path: string) => call('GET', path), post: (path: string, body: unknown) => call('POST', path, body) };
};

export const kit = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: true,
    options: {
      blockfrost: { type: 'string' },
      network: { type: 'string' },
      json: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      games: { type: 'string' },
      package: { type: 'string' },
      numbers: { type: 'string' },
      moonball: { type: 'string' },
      system: { type: 'string' },
      pick: { type: 'string' },
      sweep: { type: 'boolean', default: false },
      style: { type: 'string' },
      name: { type: 'string' },
      via: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      log: { type: 'string' },
      'no-autostart': { type: 'boolean', default: false },
      'stop-at-login': { type: 'boolean', default: false },
      'per-draw': { type: 'string' },
      'per-day': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (!command || command === 'help' || values.help) {
    say(KIT_USAGE);
    return command ? 0 : 1;
  }
  // With --json, stdout carries only the JSON answer (for programs calling the kit); the log goes to stderr.
  if (values.json) process.env.NIGHTCAST_LOG_FD = '2';
  const json = (o: unknown) => say(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  switch (command) {
    case 'init': {
      const home = kitHome();
      const paths = kitPaths(home);
      let config: KitConfig;
      try {
        config = loadConfig(home);
      } catch {
        config = { ...DEFAULT_CONFIG, ...(values.network ? { network: values.network as KitConfig['network'] } : {}) };
        saveConfig(config, home);
      }
      const { seed, created } = ensureWallet(home);
      if (values.blockfrost) saveBlockfrost(values.blockfrost, home, config.network);
      const { walletAddressOf, FAUCETS } = await import('@nightcast/deploy');
      const address = walletAddressOf(config.network, seed);
      say(`${created ? 'Created a new wallet' : 'Using the wallet'} in ${paths.wallet} (keep it private: anyone with it can spend from the wallet).`);
      say(`Config: ${paths.config} (network ${config.network}, prover ${config.prover}, limits ${config.limits.perDraw} tNIGHT a draw, ${config.limits.perDay} a day).`);
      say(`\nThe wallet's address:\n  ${address}\n`);
      say('Next:');
      let n = 1;
      if (!hasBlockfrost(home, config.network)) {
        say(`  ${n++}. Get a free Blockfrost project id at https://blockfrost.io (create a Midnight ${config.network} project), then:`);
        say(`     lunardraw-agent init --blockfrost <project id>`);
      }
      say(`  ${n++}. Send the address some test tNIGHT from the faucet: ${FAUCETS[config.network] ?? 'the network faucet'}`);
      say(`  ${n++}. Run \`lunardraw-agent wallet\`: the first sync reads the whole chain (hours on Preprod), then the wallet registers its tNIGHT for DUST, the fee token.`);
      say(`  ${n++}. Buy: \`lunardraw-agent buy --games 1\`, or let an AI assistant play: \`lunardraw-agent mcp\` (see the README).`);
      return 0;
    }

    case 'setup': {
      const { setup } = await import('./setup.js');
      return setup();
    }

    case 'connect': {
      const { mcpEntry } = await import('./setup.js');
      const { connectApps, findApps, manualLines, nextSteps } = await import('./connect.js');
      const entry = mcpEntry();
      const found = findApps();
      const results = connectApps(found, entry);
      for (const r of results) say(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.note}`);
      say(found.length ? '' : 'No AI app found on this computer (Claude, ChatGPT, Codex, Gemini CLI, Cursor, VS Code, Windsurf, LM Studio, OpenClaw, Hermes).');
      say('Something else? Add it there:');
      for (const line of manualLines(entry)) say(line);
      say('\nWhat now:');
      for (const line of nextSteps(results.filter((r) => r.ok).map((r) => r.id))) say(`  ${line}`);
      return results.some((r) => !r.ok) ? 1 : 0;
    }

    case 'doctor': {
      const { checkBlockfrost } = await import('./setup.js');
      const { findApps, isConnected } = await import('./connect.js');
      const { existsSync, readFileSync } = await import('node:fs');
      const fix: string[] = [];
      const line = (ok: boolean, what: string) => say(`${ok ? '✓' : '✗'} ${what}`);
      const major = Number(process.versions.node.split('.')[0]);
      line(major >= 22, `Node.js ${process.versions.node}${major >= 22 ? '' : ' (22 or newer is needed)'}`);
      if (major < 22) fix.push('Install Node.js 22 or newer from https://nodejs.org, then open a new terminal.');
      let config: KitConfig | undefined;
      try {
        config = loadConfig();
      } catch {
        /* not set up */
      }
      const p = kitPaths(kitHome(), config?.network ?? 'preprod');
      const hasWallet = existsSync(p.wallet);
      line(hasWallet, hasWallet ? `wallet: ${p.wallet}` : 'no wallet yet');
      if (!config || !hasWallet) fix.push('Run `lunardraw-agent setup`.');
      if (config) {
        if (hasBlockfrost(kitHome(), config.network)) {
          const id = process.env.NIGHTCAST_BLOCKFROST_PROJECT_ID?.trim() || readFileSync(p.blockfrost, 'utf8').trim();
          const check = await checkBlockfrost(id, config.network);
          line(check.ok, check.ok ? 'Blockfrost key works' : `Blockfrost key: ${check.why?.replace(/\*\*/g, '')}`);
          if (!check.ok) fix.push(`Make a new key on blockfrost.io (a Midnight Preprod project), rename ${p.blockfrost} and run \`lunardraw-agent setup\` again.`);
        } else {
          line(false, 'no Blockfrost key yet');
          fix.push('Run `lunardraw-agent setup`: it asks for the key.');
        }
        line(true, config.listing ? `in the agent directory as ${config.listing.name}` : 'not in the agent directory (optional: `lunardraw-agent list --name <name>`)');
        line(true, `spending limits: ${config.limits.perDraw} tNIGHT a draw, ${config.limits.perDay} a day${config.fileLimits ? " (from the extension's settings)" : ''}`);
        // still the current Starfall contract? (freshness.ts)
        try {
          const { checkDeployment, outdatedText } = await import('./freshness.js');
          const { readStarfallRecord } = await import('../starfall.js');
          useHome(config);
          const f = await checkDeployment(readStarfallRecord(config.network).contractAddress, config.network);
          if (f.state === 'outdated') {
            line(false, 'this kit plays an old Starfall contract');
            fix.push(outdatedText(f).replace(/^.*?so nothing was bought\. /, ''));
          } else {
            line(true, f.state === 'current' ? `plays the current Starfall contract (${f.contract.slice(0, 8)}…)` : `couldn't check for a newer Starfall contract (${f.reason})`);
          }
        } catch (err) {
          line(true, `couldn't check for a newer Starfall contract (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      if (config) {
        const { findHost } = await import('./host.js');
        const { serving } = await import('./remote.js');
        const { startsAtLogin } = await import('./autostart.js');
        const host = await findHost(agentPort(config), kitHome());
        line(true, host ? `the agent is running (process ${host.pid}, on port ${agentPort(config)})` : 'the agent isn\'t running now (an AI app starts it when it needs it)');
        if (config.remote) {
          const bg = serving(kitHome());
          line(!!bg, bg ? 'web and phone link: on, and the agent is running in the background' : 'web and phone link: on, but the agent isn\'t running in the background');
          if (!bg) fix.push('Run `lunardraw-agent remote` to start it (AIs on the web or a phone can\'t reach it until then).');
          line(startsAtLogin(), startsAtLogin() ? 'it starts when you sign in' : 'it doesn\'t start when you sign in (`lunardraw-agent remote` sets that up)');
        } else line(true, 'web and phone link: off (optional: `lunardraw-agent remote`)');
      }
      const apps = findApps();
      const connected = apps.filter((a) => isConnected(a));
      if (!apps.length) {
        line(false, 'no AI app found (Claude, ChatGPT, Codex, Gemini CLI, Cursor, VS Code, Windsurf, LM Studio, OpenClaw, Hermes)');
        fix.push('Install the Claude desktop app (https://claude.ai/download) or the ChatGPT desktop app, sign in, then run `lunardraw-agent connect`.');
      }
      for (const a of apps) line(connected.includes(a), `${a.name}: ${connected.includes(a) ? 'Lunardraw is added' : 'Lunardraw isn\'t added yet'}`);
      if (apps.length && !connected.length) fix.push('Run `lunardraw-agent connect`.');
      if (!fix.length && connected.some((a) => a.id === 'claude-desktop' || a.id === 'chatgpt-codex')) {
        fix.push('All good. If your AI app doesn\'t show the Lunardraw tools, quit it completely and open it again, then ask in a new chat: "What\'s on in Starfall right now?"');
      }
      say(`\n${fix.length ? 'Next' : 'All good'}:`);
      for (const f of fix.length ? fix : ['Ask your AI: "What\'s on in Starfall right now?" For tNIGHT and DUST: `lunardraw-agent wallet`.']) say(`  ${f}`);
      return fix.some((f) => !f.startsWith('All good')) ? 1 : 0;
    }

    case 'address': {
      const config = loadConfig();
      const { walletAddressOf } = await import('@nightcast/deploy');
      say(walletAddressOf(config.network, ensureWallet().seed));
      return 0;
    }

    case 'limits': {
      let config = loadConfig();
      const amount = (v: string | undefined, what: string): number | undefined => {
        if (v === undefined) return undefined;
        const n = Number(v.trim());
        if (!/^\d+(\.\d+)?$/.test(v.trim()) || !Number.isFinite(n)) throw new Error(`--${what} takes a number of tNIGHT, 0 or more (not ${v})`);
        return n;
      };
      const perDraw = amount(values['per-draw'], 'per-draw');
      const perDay = amount(values['per-day'], 'per-day');
      if (perDraw !== undefined || perDay !== undefined) {
        const file = config.fileLimits ?? config.limits;
        saveConfig({ ...config, fileLimits: undefined, limits: { perDraw: perDraw ?? file.perDraw, perDay: perDay ?? file.perDay } });
        config = loadConfig();
        say(`Saved in ${kitPaths().config}. A running agent uses them from its next purchase.`);
      }
      say(`${config.limits.perDraw} tNIGHT a draw, ${config.limits.perDay} tNIGHT in any 24 hours.`);
      if (config.fileLimits) {
        say(
          `These come from the Lunardraw extension's settings in Claude, which win over config.json's (${config.fileLimits.perDraw} a draw, ${config.fileLimits.perDay} a day): ` +
            'change them there (Settings, Extensions, Lunardraw (Starfall), Configure).',
        );
      } else {
        say(`Change them with \`lunardraw-agent limits --per-draw <tNIGHT> --per-day <tNIGHT>\` (kept in ${kitPaths().config}). An AI using the MCP server can't change them.`);
      }
      return 0;
    }

    case 'status': {
      const { config } = setup();
      const { readOverview } = await import('./player.js');
      const { overview } = await readOverview(config);
      if (values.json) return json(overview), 0;
      const s = overview.onSale;
      const left = s ? (s.minutesLeft < 1 ? 'closing now' : `in ${s.minutesLeft} min`) : '';
      say(s ? `Draw ${s.draw} is on sale: closes at ${clock(s.salesClose)} (${left}), ${s.tickets} ticket(s) so far, jackpot about ${whole(s.jackpotEstimate)}.` : 'No draw is on sale right now; the next opens on the hour.');
      say(`A game costs ${overview.gamePrice}. Rollover into the next Division 1: ${whole(overview.rollover)}.`);
      for (const r of overview.recent) say(r.status === 'void' ? `  draw ${r.draw}: cancelled, refunded` : `  draw ${r.draw}: ${r.numbers!.join(' ')} + ${r.moonball}, ${r.winningGames} winning game(s) of ${r.games}`);
      return 0;
    }

    case 'wallet': {
      const { config, seed } = setup();
      const running = await runningAgent(config);
      if (running) {
        // the agent running here has the wallet open: ask it (opening it again would clash)
        const w = (await running.get('/api/wallet')) as { address: string; tNight?: number; dust?: string; status?: string; note?: string };
        if (values.json) return json(w), 0;
        if (w.status === 'opening') say(`Wallet ${w.address}\n${w.note}`);
        else say(`Wallet ${w.address}\ntNIGHT: ${w.tNight}\nDUST:   ${w.dust} (pays the fees; it builds up from the tNIGHT held)`);
        return 0;
      }
      const { withPlayer } = await import('./player.js');
      return withPlayer(config, seed, async (p) => {
        const { night, dust } = await p.balances();
        if (values.json) return json({ address: p.address, tNight: Number(night) / 1e6, dust: dust.toString() }), 0;
        say(`Wallet ${p.address}\ntNIGHT: ${Number(night) / 1e6}\nDUST:   ${(Number(dust) / 1e15).toFixed(2)} (pays the fees; it builds up from the tNIGHT held)`);
        return 0;
      });
    }

    case 'buy': {
      const { config, seed } = setup();
      const { buyEntries } = await import('../starfall-commands.js');
      const entries = buyEntries(values);
      const { readOverview, withPlayer } = await import('./player.js');
      const { overview } = await readOverview(config);
      if (!overview.onSale) throw new Error('no draw is on sale right now; the next opens on the hour');
      const running = await runningAgent(config);
      if (running) {
        // the agent running here has the wallet open: it buys (opening the wallet again would clash)
        process.stderr.write('Buying through the agent running on this computer…\n');
        const { buyToolArgs } = await import('./mcp.js');
        let answer = (await running.post('/api/buy', buyToolArgs(values))) as { status?: string; bought?: number; of?: number };
        while (answer.status === 'buying' || answer.status === 'a purchase is already on its way') {
          await new Promise((r) => setTimeout(r, 10_000));
          const t = (await running.get('/api/tickets')) as { purchase?: { state: string; outcome?: { bought: number; of: number }; error?: string } };
          if (t.purchase && t.purchase.state !== 'buying') {
            if (t.purchase.error) throw new Error(t.purchase.error);
            answer = t.purchase.outcome ?? { bought: 0, of: 0 };
          }
        }
        const done = answer as Awaited<ReturnType<Player['buy']>>;
        if (values.json) return json(done), done.bought === done.of ? 0 : 1;
        if (done.bought) {
          say(`Bought ${done.bought} ticket(s), ${done.games} game(s), for draw ${done.draw} (${done.cost}). Winnings are paid automatically to ${done.payTo}.`);
          done.tickets.forEach((t, i) => say(`  ticket ${i + 1}: ${t}`));
        }
        if (done.message) say(`Stopped after ${done.bought} of ${done.of} ticket(s): ${done.message}`);
        return done.bought === done.of ? 0 : 1;
      }
      return withPlayer(config, seed, async (p) => {
        const outcome = await p.buy(entries, (m) => p.session.logger.info(m));
        if (outcome.bought && config.listing) {
          const { refreshListing } = await import('./directory.js');
          await refreshListing(config, seed, { view: (await readOverview(config).catch(() => undefined))?.view, log: (m) => process.stderr.write(m + '\n') });
        }
        if (values.json) return json(outcome), outcome.bought === outcome.of ? 0 : 1;
        if (outcome.bought) {
          say(`Bought ${outcome.bought} ticket(s), ${outcome.games} game(s), for draw ${outcome.draw} (${outcome.cost}). Winnings are paid automatically to ${outcome.payTo}.`);
          outcome.tickets.forEach((t, i) => say(`  ticket ${i + 1}: ${t}`));
        }
        if (outcome.message) say(`Stopped after ${outcome.bought} of ${outcome.of} ticket(s): ${outcome.message}`);
        return outcome.bought === outcome.of ? 0 : 1;
      });
    }

    case 'tickets': {
      const { config } = setup();
      const { loadAgentState } = await import('../starfall-agent.js');
      const { readOverview, ticketsReport } = await import('./player.js');
      const state = loadAgentState(kitPaths(kitHome(), config.network).state);
      const view = state.purchases.length ? (await readOverview(config)).view : undefined;
      const report = ticketsReport(state, view, Date.now());
      if (values.json) return json(report), 0;
      if (!report.purchases.length) say('No tickets yet.');
      for (const p of report.purchases) {
        say(`draw ${p.draw} (${p.at}): ${p.games} game(s), ${p.cost}: ${p.result ?? '?'}`);
        p.tickets.forEach((t) => say(`    ${t}`));
      }
      say(`Spent in the last 24 hours: ${report.spentLast24h}.`);
      if (config.listing && view) {
        const { refreshListing } = await import('./directory.js');
        await refreshListing(config, ensureWallet().seed, { view, log: (m) => process.stderr.write(m + '\n') });
      }
      return 0;
    }

    case 'play': {
      const { config } = setup();
      // `play` opens the wallet itself, every draw: not while the agent is running here with it open
      const running = await runningAgent(config);
      if (running) {
        throw new Error(
          'the agent is already running on this computer (for your AI apps, or `serve` / `remote` in the background) and has the wallet open. ' +
            'Ask your AI to buy instead, or stop the agent first: `lunardraw-agent stop` for the one in the background, and quit the AI apps using it.',
        );
      }
      const { starfall } = await import('../starfall-commands.js');
      const p = kitPaths(kitHome(), config.network);
      const local = /^local:(\d+)$/.exec(config.prover);
      if (local) (await import('./player.js')).requireLocalProvingKey();
      const args = [
        'agent',
        '--network', config.network,
        '--wallet', p.wallet,
        '--name', 'agent',
        '--state', p.state,
        '--style', values.style ?? 'mix',
        '--budget', String(config.limits.perDraw),
        '--daily-limit', String(config.limits.perDay),
        ...(local ? ['--proof-server-port', local[1]] : ['--prover', config.prover]),
        ...(values.games ? ['--games', values.games] : []),
        ...(values.numbers ? ['--numbers', values.numbers] : []),
        ...(values.moonball ? ['--moonball', values.moonball] : []),
      ];
      if (config.listing) {
        const { refreshListing } = await import('./directory.js');
        const { readOverview } = await import('./player.js');
        const seed = ensureWallet().seed;
        const tick = async () => refreshListing(config, seed, { view: (await readOverview(config).catch(() => undefined))?.view });
        void tick();
        setInterval(() => void tick(), 30 * 60_000).unref();
      }
      return starfall(args);
    }

    case 'list': {
      const { config, seed } = setup();
      const name = values.name ?? config.listing?.name;
      if (!name) throw new Error('give the agent a name: lunardraw-agent list --name <name> (2-20 letters, digits, spaces, . _ -)');
      const { sendListing, viaOf } = await import('./directory.js');
      const { readOverview } = await import('./player.js');
      const listing = { name, style: values.style ?? config.listing?.style ?? '', via: viaOf(values.via ?? config.listing?.via) };
      const view = (await readOverview(config).catch(() => undefined))?.view;
      const result = await sendListing(config, seed, 'list', { listing, view });
      saveConfig({ ...config, listing }, kitHome());
      say(`${result === 'listed' ? 'Listed' : 'Updated'}: ${name} is in the agent directory on https://lunardraw.io/agents/ (it updates after each purchase).`);
      say('It shows the name, style and totals (draws, games, tNIGHT spent and won), never the numbers. `lunardraw-agent unlist` takes it out.');
      return 0;
    }

    case 'unlist': {
      const { config, seed } = setup();
      if (!config.listing) {
        say('This agent isn\'t listed.');
        return 0;
      }
      const { sendListing } = await import('./directory.js');
      await sendListing(config, seed, 'unlist');
      const rest: KitConfig = { ...config };
      delete rest.listing;
      saveConfig(rest, kitHome());
      say(`${config.listing.name} is out of the agent directory.`);
      return 0;
    }

    case 'mcp': {
      process.env.NIGHTCAST_LOG_FD = '2';
      const { serveStdio, takeStdout } = await import('./mcp.js');
      const out = takeStdout(); // from here on, stdout carries the protocol only
      const { answerWithoutTools } = await import('./tool-defs.js');
      const home = kitHome();
      const config = firstRun(home);
      const log = (m: string) => process.stderr.write(`lunardraw: ${m}\n`);
      // Answer the app straight away (it may give a server only a few seconds to start) and
      // load Midnight's libraries, which take a while, alongside: the tools wait for them.
      // One agent per computer: the first app's server opens the wallet, the others pass their requests to it.
      const backend = (async () => {
        const { mcpTools } = await import('./tools.js');
        const { agentBackend } = await import('./host.js');
        return agentBackend({ home, port: agentPort(config), token: ensureSecret(kitPaths(home, config.network).token), makeTools: () => mcpTools(), log });
      })();
      backend.catch((err: unknown) => log(`couldn't start the agent: ${err instanceof Error ? err.message : String(err)}`));
      await serveStdio(async (msg, notify) => {
        if (msg.id === undefined || msg.id === null) return undefined; // notifications need no answer
        return (await answerWithoutTools(msg)) ?? (await backend).call(msg, notify);
      }, out);
      return 0;
    }

    case 'serve': {
      if (values.log) logTo(values.log);
      const config = loadConfig();
      useHome(config);
      const home = kitHome();
      const paths = kitPaths(home, config.network);
      const { serving, markServing } = await import('./remote.js');
      const other = serving(home);
      if (other && other !== process.pid) {
        say(`The agent is already running in the background (process ${other}).`);
        return 0;
      }
      markServing(home);
      const port = values.port ? Number(values.port) : agentPort(config);
      const token = ensureSecret(paths.token);
      const { mcpTools } = await import('./tools.js');
      const { agentBackend } = await import('./host.js');
      const { linkToRelay } = await import('./relay-link.js');
      const { SERVER_INFO } = await import('./mcp.js');
      const log = (m: string) => say(`${new Date().toISOString()} ${m}`);
      const backend = await agentBackend({ home, port, token, bind: values.host, makeTools: () => mcpTools(), log });
      if (backend.mode() === 'host') {
        log(`local address: http://${values.host && values.host !== '0.0.0.0' ? values.host : '127.0.0.1'}:${port} (MCP at /mcp, REST at /api, described at /openapi.json; the key is in ${paths.token})`);
      }
      // the link for AIs on the web or a phone, while config.json says "remote": true
      const current = () => {
        try {
          return loadConfig(home);
        } catch {
          return config;
        }
      };
      linkToRelay({
        settings: () => {
          const c = current();
          return { on: !!c.remote, relay: c.relay ?? DEFAULT_RELAY, secret: c.remote ? ensureSecret(paths.link) : '' };
        },
        answer: (msg) => backend.call(msg),
        version: SERVER_INFO.version,
        log,
      });
      // if the agent this passes requests to stops (its app closed), take over straight away
      setInterval(() => void backend.ensure().catch((err: unknown) => log(err instanceof Error ? err.message : String(err))), 30_000);
      await new Promise(() => undefined);
      return 0;
    }

    case 'remote': {
      const { config } = setup();
      const home = kitHome();
      const what = positionals[0] ?? 'on';
      const { remoteAddress, remoteSteps, turnOnRemote } = await import('./remote.js');
      if (what === 'off') {
        saveConfig({ ...config, remote: false }, home);
        say('The link for AIs on the web or a phone is off (the running agent stops linking within a minute).');
        if (values['stop-at-login']) {
          const { stopAtLogin } = await import('./autostart.js');
          const removed = stopAtLogin();
          say(removed ? `It won't start when you sign in any more (removed ${removed}).` : 'It wasn\'t set to start when you sign in.');
        } else say('The agent still starts when you sign in, for your AI apps here (`remote off --stop-at-login` stops that too).');
        return 0;
      }
      if (what === 'address' || what === 'link') {
        if (!config.remote) {
          say('The link is off: `lunardraw-agent remote` turns it on.');
          return 1;
        }
        say(remoteAddress(config, home));
        return 0;
      }
      if (what === 'new-link') {
        const address = remoteAddress({ ...config, remote: true }, home, true);
        say('A new private address (the old one has stopped working). Replace it in your AI apps:\n');
        say(`  ${address}\n`);
        return 0;
      }
      if (what !== 'on') throw new Error(`lunardraw-agent remote [on | off | new-link | address], not "${what}"`);
      const r = turnOnRemote(config, home, { atLogin: !values['no-autostart'] });
      say('AIs on the web or a phone can now play with this agent, through Lunardraw\'s relay. Your wallet stays here.\n');
      say(r.started === 'already' ? '✓ the agent is running in the background' : r.started === 'by the system' ? '✓ the agent is starting in the background' : '✓ the agent is starting in the background (it opens the wallet: a few minutes)');
      if (r.atLogin) say(`✓ it starts when you sign in to this computer (${r.atLogin})`);
      say('\nYour private address for AI apps:\n');
      say(`  ${r.address}\n`);
      for (const line of remoteSteps()) say(line);
      return 0;
    }

    case 'stop': {
      const { serving } = await import('./remote.js');
      const pid = serving(kitHome());
      if (!pid || pid < 0) {
        say(pid ? 'The agent in the background belongs to another user: it can\'t be stopped from here.' : 'The agent isn\'t running in the background.');
        return 0;
      }
      process.kill(pid);
      say(`Stopped the agent running in the background (process ${pid}). It starts again when you sign in, if \`remote\` set that up (\`lunardraw-agent remote off --stop-at-login\` stops that).`);
      return 0;
    }

    case 'skill': {
      const { SKILL } = await import('./skill.js');
      say(SKILL);
      return 0;
    }

    default:
      say(KIT_USAGE);
      return 1;
  }
};
