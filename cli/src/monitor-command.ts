/**
 * `./lunardraw monitor`: one check, then exit (a systemd timer runs it every
 * 5 minutes; see monitor.ts for what it checks and deploy/systemd for the
 * timer). Reads systemd, the status files, the feed and the disk; emails
 * through Resend (https://resend.com) with the API key in --mail-key.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { StarfallFeed } from '@lunardraw/keeper';
import { DEFAULT_CONFIG, decide, digest, type Email, emptyState, evaluate, type HealthInput, type Inputs, type MonitorConfig, type MonitorState, noteRestarts, type Unit } from './monitor.js';
import type { ServiceStatus } from './status-file.js';
import { type OracleStatus, parseSoak, type SoakRun } from './monitor-nightcast.js';

export const MONITOR_USAGE = `usage: ./lunardraw monitor --feed <file> --status-dir <dir> --to <address> --from <address> --mail-key <file>
       [--units <unit,unit,...>] [--health <name=url,...>] [--nightcast-status <file>] [--soak-log <file>] [--state <file>] [--min-dust <DUST>] [--digest-hour <0-23|-1>] [--tz <zone>]
       [--dry-run] [--test]

Checks Starfall once and emails what needs a person: a service stopped or restarting over and over,
the keeper or the oracle not reporting, stuck, failing transactions, unsynced or low on DUST, a draw
close to its reveal, oracle or settlement deadline, a draw voided, the site feed stale, the disk
nearly full. A problem is emailed once seen on two runs in a row, reminded every 6 hours while it
lasts, and followed by a "resolved" email; a summary comes every day at --digest-hour (default 8).

--status-dir holds keeper.json and oracle.json, written by the keeper and the oracle started with
--status <dir>/keeper.json and --status <dir>/oracle.json. --units are the systemd units to watch
(default lunardraw-proof, lunardraw-starfall-keeper, lunardraw-starfall-oracle). --mail-key is a file
holding a Resend API key (sending access). --health are HTTP health endpoints to check, named after
their unit (e.g. nightcast-mcp=http://127.0.0.1:6350/health): an alert when one doesn't answer, isn't ok,
or reports canRequest false (Nightcast's MCP server, which LunaSpin's spins go through). --nightcast-status is
the Nightcast oracle's status file (NIGHTCAST_STATUS_FILE) and --soak-log LunaSpin's hourly test log: alerts for a
low bond or wallet, a missed request, a failed top-up and failing test spins. --dry-run prints the email instead of sending it and leaves
the state alone; --test sends a test email and exits.`;

const DEFAULT_UNITS = ['lunardraw-proof', 'lunardraw-starfall-keeper', 'lunardraw-starfall-oracle'];
const SERVICE_UNITS: Record<string, string> = { keeper: 'lunardraw-starfall-keeper', oracle: 'lunardraw-starfall-oracle' };

/** systemd's view of a unit (`systemctl show`). */
export const parseShow = (name: string, out: string): Unit => {
  const kv = Object.fromEntries(
    out
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { name, active: kv.ActiveState || 'unknown', sub: kv.SubState ?? '', restarts: Number(kv.NRestarts) || 0 };
};

const readUnit = (name: string): Unit => {
  try {
    return parseShow(name, execFileSync('systemctl', ['show', name, '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts'], { encoding: 'utf8' }));
  } catch (err) {
    return { name, active: 'unknown', sub: err instanceof Error ? err.message.split('\n')[0] : String(err), restarts: 0 };
  }
};

/** `--health name=url,name=url` → [{ name, url }]. */
export const parseHealth = (v: string | undefined): { name: string; url: string }[] =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf('=');
      if (i < 1 || !/^https?:\/\//.test(x.slice(i + 1))) throw new Error(`--health takes name=url, not "${x}"`);
      return { name: x.slice(0, i), url: x.slice(i + 1) };
    });

/** Fetch one health endpoint (10 s at most). */
export const readHealth = async (name: string, url: string, fetcher: typeof fetch = fetch): Promise<HealthInput> => {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { name, url, error: `HTTP ${res.status}, not JSON` };
    }
    return res.ok ? { name, url, body } : { name, url, body, error: `HTTP ${res.status}` };
  } catch (err) {
    return { name, url, error: err instanceof Error ? err.message : String(err) };
  }
};

const readJson = <T>(path: string): { value?: T; error?: string } => {
  if (!existsSync(path)) return { error: 'no such file' };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as T };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

/** Send through Resend's API. */
export const sendEmail = async (email: Email, opts: { key: string; from: string; to: string[] }, fetcher: typeof fetch = fetch): Promise<string> => {
  const res = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: opts.from, to: opts.to, subject: email.subject, text: email.text }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${body.slice(0, 300)}`);
  return (JSON.parse(body) as { id?: string }).id ?? '?';
};

const numberOpt = (v: string | undefined, name: string, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};

export const monitor = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      feed: { type: 'string' },
      'status-dir': { type: 'string' },
      to: { type: 'string' },
      from: { type: 'string' },
      'mail-key': { type: 'string' },
      units: { type: 'string' },
      health: { type: 'string' },
      'nightcast-status': { type: 'string' },
      'soak-log': { type: 'string' },
      state: { type: 'string' },
      'min-dust': { type: 'string' },
      'digest-hour': { type: 'string' },
      tz: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      test: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(MONITOR_USAGE + '\n');
    return 0;
  }
  const dry = values['dry-run'];
  if ((!values['status-dir'] && !values.test) || (!dry && (!values.to || !values.from || !values['mail-key']))) throw new Error(MONITOR_USAGE);
  const cfg: MonitorConfig = {
    ...DEFAULT_CONFIG,
    minDust: numberOpt(values['min-dust'], 'min-dust', DEFAULT_CONFIG.minDust),
    digestHour: numberOpt(values['digest-hour'], 'digest-hour', DEFAULT_CONFIG.digestHour),
    tz: values.tz ?? DEFAULT_CONFIG.tz,
  };
  const mail = dry
    ? undefined
    : { key: readFileSync(values['mail-key']!, 'utf8').trim(), from: values.from!, to: values.to!.split(',').map((s) => s.trim()) };
  const send = async (email: Email) => {
    if (!mail) {
      process.stdout.write(`--- would send ---\nSubject: ${email.subject}\n\n${email.text}\n`);
      return;
    }
    const id = await sendEmail(email, mail);
    process.stdout.write(`sent "${email.subject}" (${id})\n`);
  };

  if (values.test) {
    await send({ subject: '✅ Lunardraw monitor: test', text: 'The monitor can send to this address. Alerts and the daily summary will come from here.' });
    return 0;
  }

  const dir = values['status-dir']!;
  const statePath = values.state ?? join(dir, 'monitor-state.json');
  const now = Date.now();
  const units = (values.units ? values.units.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_UNITS).map(readUnit);
  const services = Object.entries(SERVICE_UNITS).map(([service, unit]) => {
    const path = join(dir, `${service}.json`);
    const r = readJson<ServiceStatus>(path);
    return { service, unit, path, status: r.value, error: r.error };
  });
  const feed = values.feed ? readJson<StarfallFeed>(values.feed) : undefined;
  let disk: Inputs['disk'];
  try {
    const s = statfsSync('/');
    disk = { path: '/', free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    disk = undefined;
  }
  const health = await Promise.all(parseHealth(values.health).map((h) => readHealth(h.name, h.url)));
  const ncStatus = values['nightcast-status'] ? readJson<OracleStatus>(values['nightcast-status']) : undefined;
  let soak: SoakRun[] | undefined;
  let soakError: string | undefined;
  if (values['soak-log']) {
    try {
      soak = parseSoak(readFileSync(values['soak-log'], 'utf8'));
    } catch (err) {
      soakError = existsSync(values['soak-log']) ? (err instanceof Error ? err.message : String(err)) : undefined; // not there yet: no runs so far
    }
  }
  const nightcast =
    values['nightcast-status'] || values['soak-log']
      ? { statusPath: values['nightcast-status'], status: ncStatus?.value, statusError: ncStatus?.error, soakPath: values['soak-log'], soak, soakError }
      : undefined;
  const inputs: Inputs = { now, units, services, feed: feed?.value, feedPath: values.feed, feedError: feed?.error, disk, health, nightcast };

  const loaded = readJson<MonitorState>(statePath);
  const state: MonitorState = loaded.value ?? emptyState();
  const alerts = evaluate(inputs, state, cfg);
  const email = decide(alerts, state, now, cfg);
  const daily = digest(inputs, state, cfg);
  noteRestarts(state, units, now);
  state.lastRunAt = now;

  process.stdout.write(alerts.length ? `${alerts.length} alert(s): ${alerts.map((a) => a.key).join(', ')}\n` : 'all good\n');
  if (dry) {
    if (email) await send(email);
    if (daily) await send(daily);
    if (!email && !daily) process.stdout.write('(nothing to send this run)\n');
    return 0;
  }
  // A send that fails is marked unsent, so the next run (5 minutes on) tries it again.
  let failed = false;
  for (const e of [email, daily]) {
    if (!e) continue;
    try {
      await send(e);
    } catch (err) {
      failed = true;
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      // unsend, so the next run tries again
      if (e === daily) state.digestDate = undefined;
      else
        for (const rec of Object.values(state.alerts)) {
          if (rec.lastSentAt !== now) continue;
          if (rec.sentAt === now) rec.sentAt = rec.lastSentAt = undefined;
          else rec.lastSentAt = now - cfg.remindHours * 3_600_000;
        }
    }
  }
  writeJson(statePath, state);
  return failed ? 1 : 0;
};
