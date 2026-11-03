#!/usr/bin/env node
/**
 * lunardraw-agent: play Starfall (Lunardraw's lottery on Midnight Preprod)
 * from an AI agent's own machine and wallet. See README-agent.md.
 */
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG, ensureWallet, hasBlockfrost, type KitConfig, kitHome, kitPaths, loadConfig, saveBlockfrost, saveConfig, useHome } from './home.js';

export const KIT_USAGE = `lunardraw-agent: play Starfall, Lunardraw's lottery on the Midnight Preprod test network, from your own wallet.

  lunardraw-agent setup                              the guided setup: start here
  lunardraw-agent init [--blockfrost <project id>]   the same without questions: a wallet and a config
  lunardraw-agent address                            the wallet's address (to fund it from the faucet)
  lunardraw-agent status                             the draw on sale, the jackpot, recent results
  lunardraw-agent wallet                             tNIGHT and DUST (opens the wallet: see below)
  lunardraw-agent buy [--games <n> | --package <name> | --numbers "<7 numbers>" [--moonball <n>]
                      | --system <8-12> [--numbers ...] | --pick <5|6> [--numbers ...]] [--sweep] [--yes]
  lunardraw-agent tickets                            what this agent bought and how each draw went
  lunardraw-agent play [--style mix|quickpick|lucky|moonhit|system] [--games <n>] [--numbers ... --moonball <n>]
                                                     keep playing every draw, within the limits
  lunardraw-agent limits                             the owner's spending limits (edit config.json to change)
  lunardraw-agent mcp                                run as an MCP server for Claude and other AI assistants

--json prints machine-readable output (status, wallet, buy, tickets).

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

export const kit = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    strict: true,
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
      help: { type: 'boolean', default: false },
    },
  });
  if (!command || command === 'help' || values.help) {
    say(KIT_USAGE);
    return command ? 0 : 1;
  }
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

    case 'address': {
      const config = loadConfig();
      const { walletAddressOf } = await import('@nightcast/deploy');
      say(walletAddressOf(config.network, ensureWallet().seed));
      return 0;
    }

    case 'limits': {
      const config = loadConfig();
      say(`${config.limits.perDraw} tNIGHT a draw, ${config.limits.perDay} tNIGHT in any 24 hours.`);
      say(`Change them in ${kitPaths().config} ("limits": { "perDraw": ..., "perDay": ... }). An AI using the MCP server can't change them.`);
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
      return withPlayer(config, seed, async (p) => {
        const outcome = await p.buy(entries, (m) => p.session.logger.info(m));
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
      return 0;
    }

    case 'play': {
      const { config } = setup();
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
      return starfall(args);
    }

    case 'mcp': {
      process.env.NIGHTCAST_LOG_FD = '2';
      const { mcpTools } = await import('./tools.js');
      const { serveStdio } = await import('./mcp.js');
      await serveStdio(mcpTools());
      return 0;
    }

    default:
      say(KIT_USAGE);
      return 1;
  }
};
