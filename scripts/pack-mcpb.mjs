#!/usr/bin/env node
/**
 * Builds Lunardraw's Claude desktop extension (lunardraw-<version>.mcpb) from
 * the staged @lunardraw/agent package that scripts/pack-agent.mjs made:
 * the same kit and the same pinned, patched dependencies, as an MCP Bundle
 * (https://github.com/modelcontextprotocol/mcpb). Claude runs it with its
 * own Node.js, so players need no Node install and no terminal: they open
 * the file, paste a Blockfrost key, and ask Claude.
 *
 *   node scripts/pack-mcpb.mjs <stage dir> <out dir>
 *
 * The bundle's layout keeps the kit's paths working: server/node_modules
 * holds the dependencies and server/deployments the deployment records,
 * exactly as node_modules and deployments sit in the npm package.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [stageArg, outArg] = process.argv.slice(2);
if (!stageArg || !outArg) {
  console.error('usage: node scripts/pack-mcpb.mjs <stage dir> <out dir>');
  process.exit(2);
}
const stage = resolve(stageArg);
const out = resolve(outArg);
const fail = (msg) => {
  console.log(`::error title=claude extension::${msg}`);
  process.exit(1);
};
if (!existsSync(join(stage, 'node_modules', '@lunardraw', 'cli', 'dist', 'kit-main.js'))) fail(`no staged agent package in ${stage}: run scripts/pack-agent.mjs first`);

const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
const { version } = pkg;
const ext = join(dirname(stage), 'lunardraw-extension');
rmSync(ext, { recursive: true, force: true });
mkdirSync(join(ext, 'server'), { recursive: true });
cpSync(join(stage, 'node_modules'), join(ext, 'server', 'node_modules'), { recursive: true, verbatimSymlinks: true });
cpSync(join(stage, 'deployments'), join(ext, 'server', 'deployments'), { recursive: true });
cpSync(join(root, 'cli', 'src', 'kit', 'extension', 'icon.png'), join(ext, 'icon.png'));
cpSync(join(stage, 'LICENSE'), join(ext, 'LICENSE'));
writeFileSync(join(ext, 'server', 'package.json'), JSON.stringify({ name: 'lunardraw-extension', version, private: true, type: 'module' }, null, 2) + '\n');
writeFileSync(
  join(ext, 'server', 'index.mjs'),
  `// Lunardraw's Claude extension: the agent kit's MCP server (lunardraw-agent mcp).
// Syncing a Preprod wallet needs more memory than Node may give by default, so
// unless it already has about 3 GB, this starts Node again with that much.
// Claude may run extensions with its own Node, built into the app: its
// executable is then Claude itself, which runs as plain Node with
// ELECTRON_RUN_AS_NODE.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
if (getHeapStatistics().heap_size_limit < 2.5 * 2 ** 30 && !process.env.LUNARDRAW_RESTARTED) {
  const env = { ...process.env, LUNARDRAW_RESTARTED: '1', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
  const r = spawnSync(process.execPath, ['--max-old-space-size=3072', fileURLToPath(import.meta.url)], { stdio: 'inherit', env, windowsHide: true });
  process.exit(r.status ?? 1);
}
process.argv.splice(2, Infinity, 'mcp');
await import('@lunardraw/cli/dist/kit-main.js');
`,
);
chmodSync(join(ext, 'server', 'index.mjs'), 0o755);

const tools = [
  ['lunardraw_how_to_play', 'How Starfall works: rules, prices, prize divisions, odds and your spending limits'],
  ['lunardraw_draw_on_sale', 'The draw on sale, the jackpot estimate and the latest results'],
  ['lunardraw_wallet', "Your agent's wallet: address, tNIGHT and DUST, and how far it is from ready"],
  ['lunardraw_buy_tickets', 'Buy games, a package or chosen numbers for the draw on sale, within your limits'],
  ['lunardraw_my_tickets', 'Every ticket bought, with each draw\'s result'],
];
const manifest = {
  manifest_version: '0.3',
  name: 'lunardraw',
  display_name: 'Lunardraw (Starfall)', // no colon: Claude names its log file after it, and Windows can't
  version,
  description: "Let Claude play Starfall, Lunardraw's lottery on Midnight's Preprod test network, from a wallet on your computer. Test tokens only.",
  long_description: [
    "Claude gets tools to see what's on in **Starfall** and to buy games for you from your agent's own wallet, which stays on this computer. Starfall runs on Midnight's Preprod **test** network with tNIGHT, a free test token with no value.",
    '',
    '**Getting started**',
    '1. Get a free Blockfrost key at blockfrost.io: Add project, network **Midnight Preprod**, copy the Project ID, and paste it into this extension\'s settings.',
    '2. Ask Claude: *"Set me up for Starfall."* It shows your wallet\'s address and the faucet that sends free tNIGHT.',
    "3. The first sync of a new wallet takes a few hours; Claude tells you how far along it is. Then ask: *\"What's on in Starfall? Buy me two QuickPick games.\"*",
    '',
    "Your AI can spend at most 25 tNIGHT a draw and 100 a day unless you change the limits in this extension's settings; it can read them but never change them. Prizes are paid to the wallet automatically.",
    '',
    'Also on ChatGPT, Gemini, Cursor, VS Code and more, and on the web or your phone: see lunardraw.io/play-with-ai.',
  ].join('\n'),
  author: { name: 'LearnMidnight', url: 'https://lunardraw.io' },
  repository: { type: 'git', url: 'https://github.com/LearnMidnight/Lunardraw' },
  homepage: 'https://lunardraw.io/play-with-ai/',
  documentation: 'https://www.npmjs.com/package/@lunardraw/agent',
  support: 'https://github.com/LearnMidnight/Lunardraw/issues',
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server/index.mjs',
    mcp_config: {
      command: 'node',
      // the script first: Claude may start it with its own Node, which takes the first argument as the script
      args: ['${__dirname}/server/index.mjs'],
      env: {
        LUNARDRAW_BLOCKFROST: '${user_config.blockfrost}',
        // empty unless the owner sets them: then config.json's limits apply (home.ts settingsLimits)
        LUNARDRAW_LIMIT_PER_DRAW: '${user_config.per_draw}',
        LUNARDRAW_LIMIT_PER_DAY: '${user_config.per_day}',
      },
    },
  },
  tools: tools.map(([name, description]) => ({ name, description })),
  keywords: ['lunardraw', 'starfall', 'midnight', 'lottery', 'agent', 'testnet'],
  license: 'MIT',
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=22.0.0' } },
  user_config: {
    blockfrost: {
      type: 'string',
      title: 'Blockfrost project ID (Midnight Preprod)',
      description: 'Free at blockfrost.io: Add project, choose the network "Midnight Preprod", and copy the Project ID. Leave it empty if you already set up the Lunardraw kit in a terminal.',
      sensitive: true,
      required: false,
    },
    // Only the owner can change these (an AI using the tools can't): the extension's settings are theirs.
    per_draw: {
      type: 'number',
      title: 'Spending limit: tNIGHT a draw',
      description: 'The most the agent may spend on one draw. Leave it empty to keep the limit in .lunardraw-agent/config.json (25 unless you changed it).',
      required: false,
      min: 0,
    },
    per_day: {
      type: 'number',
      title: 'Spending limit: tNIGHT a day',
      description: 'The most the agent may spend in any 24 hours. Leave it empty to keep the limit in .lunardraw-agent/config.json (100 unless you changed it).',
      required: false,
      min: 0,
    },
  },
};
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// the official tool checks the manifest and packs it
mkdirSync(out, { recursive: true });
const file = join(out, `lunardraw-${version}.mcpb`);
const mcpb = (args) => execFileSync('npx', ['--yes', '@anthropic-ai/mcpb@2', ...args], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
console.log(mcpb(['validate', join(ext, 'manifest.json')]).trim().split('\n').slice(-3).join('\n'));
mcpb(['pack', ext, file]);
const mb = (statSync(file).size / 2 ** 20).toFixed(1);
console.log(`::notice title=claude extension::${file} (${mb} MB)`);
console.log(file);
