#!/usr/bin/env node
/**
 * Builds the @lunardraw/agent npm package (the agent kit, `lunardraw-agent`)
 * from this checkout, after `npm run compact:starfall && npm run build`.
 *
 *   node scripts/pack-agent.mjs <stage dir> <out dir>
 *
 * Midnight's libraries only work together at the exact versions this repo
 * pins (package.json "overrides") and with the DUST wallet fix
 * (nightcast/deploy/scripts/patch-dust-fee-loop.mjs), and npm passes neither
 * on to someone installing a package. So the package carries its own,
 * already-patched dependencies (bundleDependencies): installing it installs
 * exactly what was tested here.
 *
 * Meant for CI (it deletes the proving keys from contract/dist): they aren't
 * needed, since purchases are proved by Lunardraw's player prover. An agent
 * with its own proof server (prover "local:<port>") runs the kit from a
 * checkout instead, which has buyTickets' key.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [stageArg, outArg] = process.argv.slice(2);
if (!stageArg || !outArg) {
  console.error('usage: node scripts/pack-agent.mjs <stage dir> <out dir>');
  process.exit(2);
}
const stage = resolve(stageArg);
const out = resolve(outArg);
const notice = (title, msg) => console.log(`::notice title=${title}::${msg}`);
const fail = (msg) => {
  console.log(`::error title=agent package::${msg}`);
  process.exit(1);
};
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
const mb = (n) => `${(n / 2 ** 20).toFixed(1)} MB`;
const sizeOf = (p) => {
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  return readdirSync(p).reduce((a, f) => a + sizeOf(join(p, f)), 0);
};

// 1. the contract's proving keys: none (the hosted prover has them)
for (const contract of ['settlement', 'lunardraw']) {
  const keys = join(root, 'contract', 'dist', 'managed', contract, 'keys');
  if (!existsSync(keys)) continue;
  for (const f of readdirSync(keys)) if (f.endsWith('.prover')) rmSync(join(keys, f));
}
if (!existsSync(join(root, 'contract', 'dist', 'managed', 'settlement', 'keys', 'buyTickets.verifier'))) {
  fail('no compiled Starfall contract with keys in contract/dist: run `npm run compact:starfall && npm run build` first');
}

// 2. the workspaces, packed
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'tgz'), { recursive: true });
const workspaces = ['@nightcast/contract', '@nightcast/sdk', '@nightcast/deploy', '@lunardraw/contract', '@lunardraw/keeper', '@lunardraw/cli'];
const packed = JSON.parse(run('npm', ['pack', ...workspaces.flatMap((w) => ['-w', w]), '--pack-destination', join(stage, 'tgz'), '--json'], root));
const local = Object.fromEntries(packed.map((p) => [p.name, `file:./tgz/${p.filename}`]));

// 3. the package
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'cli', 'package.json'), 'utf8')).version;
const pkg = {
  name: '@lunardraw/agent',
  version,
  description: "Play Starfall, Lunardraw's lottery on the Midnight Preprod test network, from your AI agent's own wallet: an MCP server it sets up in Claude, ChatGPT, Codex, Gemini CLI, Cursor, VS Code, OpenClaw, Hermes and more, a link for ChatGPT, Claude and Grok on the web or a phone, a local REST API and a command line. Test tokens only.",
  keywords: ['lunardraw', 'starfall', 'midnight', 'lottery', 'ai-agents', 'ai-agent', 'mcp', 'mcp-server', 'chatgpt', 'codex', 'claude', 'gemini-cli', 'grok', 'cursor', 'openclaw', 'hermes-agent', 'nightcast', 'zero-knowledge'],
  homepage: 'https://lunardraw.io',
  bugs: { url: 'https://github.com/LearnMidnight/Lunardraw/issues' },
  repository: { type: 'git', url: 'git+https://github.com/LearnMidnight/Lunardraw.git', directory: 'cli/src/kit' },
  license: 'MIT',
  author: 'LearnMidnight',
  type: 'module',
  bin: { 'lunardraw-agent': 'bin/lunardraw-agent.js' },
  files: ['bin', 'deployments', 'README.md', 'LICENSE'],
  engines: { node: '>=22' },
  dependencies: local,
  overrides: { ...rootPkg.overrides, ...local },
  bundleDependencies: true,
  publishConfig: { access: 'public' },
};
writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
mkdirSync(join(stage, 'bin'));
writeFileSync(
  join(stage, 'bin', 'lunardraw-agent.js'),
  `#!/usr/bin/env node
// lunardraw-agent: see README.md. Syncing a Preprod wallet needs more memory than Node's default,
// so this starts Node again with 3 GB unless NODE_OPTIONS already says how much.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const big = /--max-old-space-size/.test(process.env.NODE_OPTIONS ?? '') || process.execArgv.some((a) => a.startsWith('--max-old-space-size'));
if (!big) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=3072', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
await import('@lunardraw/cli/dist/kit-main.js');
`,
);
chmodSync(join(stage, 'bin', 'lunardraw-agent.js'), 0o755);
mkdirSync(join(stage, 'deployments'));
for (const f of readdirSync(join(root, 'deployments'))) if (/^starfall-.*\.json$/.test(f)) cpSync(join(root, 'deployments', f), join(stage, 'deployments', f));
cpSync(join(root, 'cli', 'src', 'kit', 'README.md'), join(stage, 'README.md'));
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

// 4. install, patch, check
run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], stage);
run(process.execPath, [join(root, 'nightcast', 'deploy', 'scripts', 'patch-dust-fee-loop.mjs'), '--root', stage], root);
run(process.execPath, [join(root, 'nightcast', 'deploy', 'scripts', 'patch-dust-fee-loop.mjs'), '--check', '--root', stage], root);
const versions = new Map();
const walk = (dir, depth) => {
  if (depth > 8 || !existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === 'ledger-v8' && dir.endsWith('@midnight-ntwrk')) {
      const v = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version;
      versions.set(p, v);
    }
    if (statSync(p).isDirectory() && !f.startsWith('.')) walk(p, depth + 1);
  }
};
walk(join(stage, 'node_modules'), 0);
const kinds = new Set(versions.values());
if (versions.size !== 1 || !kinds.has('8.1.0')) fail(`expected one @midnight-ntwrk/ledger-v8 8.1.0, found ${[...versions].map(([p, v]) => `${v} at ${p}`).join(', ')}`);
// Native add-ons that compile when installed would fail on a machine with no
// C compiler, and bundled ones fail the whole install. cpu-features is
// optional for ssh2 (it carries on without it), and the kit never uses ssh2.
const noBuild = ['cpu-features'];
const dropped = [];
const unbuild = (dir, depth) => {
  if (depth > 10 || !existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!statSync(p).isDirectory()) continue;
    if (noBuild.includes(f) && dir.endsWith('node_modules')) {
      rmSync(p, { recursive: true });
      dropped.push(p.slice(stage.length + 1));
      continue;
    }
    const pj = join(p, 'package.json');
    if (dir.endsWith('node_modules') || dir.split('/').at(-2) === 'node_modules') {
      if (existsSync(pj)) {
        const j = JSON.parse(readFileSync(pj, 'utf8'));
        let changed = false;
        for (const n of noBuild) if (j.optionalDependencies?.[n]) (delete j.optionalDependencies[n], (changed = true));
        if (changed) writeFileSync(pj, JSON.stringify(j, null, 2) + '\n');
      }
    }
    unbuild(p, depth + 1);
  }
};
unbuild(join(stage, 'node_modules'), 0);
if (dropped.length) notice('agent package', `left out ${dropped.join(', ')} (compiles on install; optional)`);
const before = sizeOf(join(stage, 'node_modules'));
// trim what never runs: source maps, type declarations, docs, @types packages
let trimmed = 0;
const trim = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (f === '@types' && dir.endsWith('node_modules')) {
        trimmed += sizeOf(p);
        rmSync(p, { recursive: true });
      } else trim(p);
    } else if (/\.(js|mjs|cjs)\.map$|\.d\.[mc]?ts(\.map)?$|\.tsbuildinfo$/.test(f) || (/^(changelog|history)(\.md)?$/i.test(f))) {
      trimmed += s.size;
      rmSync(p);
    }
  }
};
trim(join(stage, 'node_modules'));
// @polkadot/types-support is chain metadata for polkadot-js's own tests; only
// @polkadot/rpc-provider's mock (never loaded here) reads it. Drop the
// metadata if that's still so.
const support = join(stage, 'node_modules', '@polkadot', 'types-support');
if (existsSync(support)) {
  const readers = [];
  const scan = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (p === support) continue;
      if (statSync(p).isDirectory()) scan(p);
      else if (/\.[mc]?js$/.test(f) && readFileSync(p, 'utf8').includes('@polkadot/types-support')) readers.push(p.slice(stage.length + 1));
    }
  };
  scan(join(stage, 'node_modules'));
  const others = readers.filter((p) => !/@polkadot\/rpc-provider\/(cjs\/)?mock\//.test(p) && !/@polkadot\/types-support\//.test(p));
  if (others.length) notice('agent package', `kept @polkadot/types-support's metadata: read by ${others.slice(0, 5).join(', ')}`);
  else {
    for (const d of ['metadata', join('cjs', 'metadata')]) {
      const p = join(support, d);
      if (existsSync(p)) {
        trimmed += sizeOf(p);
        rmSync(p, { recursive: true });
      }
    }
    notice('agent package', `dropped @polkadot/types-support's metadata (only ${readers.length} mock file(s) read it)`);
  }
}
notice('agent package', `node_modules ${mb(before)}, ${mb(before - trimmed)} after trimming maps, type declarations and changelogs; one ledger-v8 (8.1.0); dust wallet fix applied`);
// what takes the room, for trimming
const pkgs = [];
const collect = (dir) => {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f.startsWith('@')) collect(p);
    else if (statSync(p).isDirectory()) pkgs.push([p.slice(stage.length + 1), sizeOf(p)]);
  }
};
collect(join(stage, 'node_modules'));
pkgs.sort((a, b) => b[1] - a[1]);
notice('agent package biggest', pkgs.slice(0, 25).map(([p, n]) => `${p.replace(/^node_modules\//, '')} ${mb(n)}`).join(', '));
// inside the two biggest, and who needs @polkadot/types-support
const files = (dir) => {
  const all = [];
  const go = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) go(p);
      else all.push([p.slice(dir.length + 1), statSync(p).size]);
    }
  };
  if (existsSync(dir)) go(dir);
  return all.sort((a, b) => b[1] - a[1]);
};
for (const name of ['@polkadot/types-support', '@lunardraw/contract']) {
  const dir = join(stage, 'node_modules', name);
  const top = new Map();
  for (const [p, n] of files(dir)) {
    const k = p.split('/').slice(0, 3).join('/');
    top.set(k, (top.get(k) ?? 0) + n);
  }
  notice(`inside ${name}`, [...top].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ${mb(n)}`).join(', '));
}
const needs = [];
for (const [p] of pkgs) {
  try {
    const j = JSON.parse(readFileSync(join(stage, p, 'package.json'), 'utf8'));
    if ({ ...j.dependencies, ...j.peerDependencies }['@polkadot/types-support']) needs.push(p.replace(/^node_modules\//, ''));
  } catch {}
}
notice('needs @polkadot/types-support', needs.join(', ') || 'nothing');
const scripted = [];
for (const [p] of pkgs) {
  try {
    const sc = JSON.parse(readFileSync(join(stage, p, 'package.json'), 'utf8')).scripts ?? {};
    const cmd = sc.preinstall ?? sc.install ?? sc.postinstall;
    if (cmd) scripted.push(`${p.replace(/^node_modules\//, '')} (${cmd.slice(0, 60)})`);
  } catch {}
}
notice('install scripts', scripted.join('; ') || 'none');

// 5. pack: the bundled dependencies are named by version (the file: paths only served the install)
const versionsOf = Object.fromEntries(packed.map((p) => [p.name, p.version]));
const final = { ...pkg, dependencies: Object.fromEntries(Object.keys(local).map((n) => [n, versionsOf[n]])) };
delete final.overrides;
writeFileSync(join(stage, 'package.json'), JSON.stringify(final, null, 2) + '\n');
mkdirSync(out, { recursive: true });
const [result] = JSON.parse(run('npm', ['pack', '--pack-destination', out, '--json'], stage));
notice('agent package', `${result.filename}: ${mb(result.size)} packed, ${mb(result.unpackedSize)} unpacked, ${result.entryCount} files`);
console.log(join(out, result.filename));
