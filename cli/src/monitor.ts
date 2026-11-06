/**
 * `./lunardraw monitor`: email the operator when Starfall needs a person.
 *
 * Run every 5 minutes by a systemd timer (deploy/systemd/lunardraw-monitor.*),
 * apart from the services it watches, so it still reports when they have
 * stopped. One run reads:
 *   - systemd: is each service running, and how often has it restarted;
 *   - the keeper's and the oracle's status files (`--status`, status-file.ts):
 *     are they alive, still finishing passes, failing transactions, synced,
 *     and how much DUST and tNIGHT their wallets hold;
 *   - the site feed: draws close to a deadline (the reveal, the oracle's
 *     answer, settlement) and draws that were voided;
 *   - free disk space.
 * It emails new problems once they've been seen on two runs in a row (so a
 * service restarting itself doesn't page anyone), reminds every few hours
 * while one lasts, says when each is resolved, and sends a short daily
 * summary, which is also the sign that the monitor itself is running.
 *
 * Everything here is pure: monitor-command.ts does the reading and sending.
 */
import type { StarfallFeed } from '@lunardraw/keeper';
import type { ServiceStatus } from './status-file.js';

export type Unit = { name: string; active: string; sub: string; restarts: number };

export type ServiceInput = {
  /** keeper or oracle */
  service: string;
  unit: string;
  path: string;
  status?: ServiceStatus;
  /** Why the file couldn't be read (missing, not JSON). */
  error?: string;
};

export type Inputs = {
  now: number;
  units: Unit[];
  services: ServiceInput[];
  feed?: StarfallFeed;
  feedPath?: string;
  feedError?: string;
  disk?: { path: string; free: number; total: number };
};

export type MonitorConfig = {
  /** A wallet below this much DUST (in DUST) is low. */
  minDust: number;
  /** Minutes without a status file update before a service counts as down or frozen. */
  statusStaleMins: number;
  /** Minutes without a finished pass before a service counts as stuck. */
  passStaleMins: number;
  /** Minutes of failing transactions (3 or more) before alerting. */
  failingMins: number;
  /** Minutes a wallet may report unsynced (after its first 20) before alerting. */
  unsyncedMins: number;
  /** Minutes without a new feed before alerting. */
  feedStaleMins: number;
  /** Warn when a draw is this many minutes from its reveal or oracle deadline. */
  deadlineMins: number;
  /** Warn when the oracle has left a request this many minutes. */
  oracleWaitMins: number;
  /** Warn when settlement is this many minutes from its deadline. */
  settleMins: number;
  /** Restarts within an hour that count as a restart loop. */
  restartsPerHour: number;
  /** Disk: alert below this fraction free, or this many bytes. */
  minDiskFraction: number;
  minDiskBytes: number;
  /** Runs in a row a problem must be seen on before it is emailed. */
  confirmRuns: number;
  /** Hours between reminders while a problem lasts. */
  remindHours: number;
  /** Local hour (in `tz`) of the daily summary; -1 for none. */
  digestHour: number;
  tz: string;
};

export const DEFAULT_CONFIG: MonitorConfig = {
  minDust: 1,
  statusStaleMins: 10,
  passStaleMins: 15,
  failingMins: 10,
  unsyncedMins: 20,
  feedStaleMins: 10,
  deadlineMins: 5,
  oracleWaitMins: 10,
  settleMins: 60,
  restartsPerHour: 3,
  minDiskFraction: 0.1,
  minDiskBytes: 5 * 2 ** 30,
  confirmRuns: 2,
  remindHours: 6,
  digestHour: 8,
  tz: 'Australia/Brisbane',
};

export type Alert = {
  key: string;
  /** problem: lasts until fixed (resolved email); notice: a one-off event, emailed once. */
  kind: 'problem' | 'notice';
  title: string;
  detail?: string;
  /** Commands to look into it on the server. */
  check?: string[];
};

export type MonitorState = {
  alerts: Record<string, { title: string; firstSeen: number; runs: number; sentAt?: number; lastSentAt?: number }>;
  /** NRestarts samples per unit, for restarts within the hour (kept a day). */
  restarts: Record<string, { at: number; n: number }[]>;
  /** The highest void draw already reported. */
  lastVoid?: number;
  /** Local date (YYYY-MM-DD) of the last daily summary. */
  digestDate?: string;
  lastRunAt?: number;
};

export const emptyState = (): MonitorState => ({ alerts: {}, restarts: {} });

const MIN = 60_000;
const ms = (iso: string | undefined) => (iso === undefined ? undefined : Date.parse(iso));
const mins = (m: number) => {
  const r = Math.round(m);
  return r < 90 ? `${r} min` : `${Math.round((r / 60) * 10) / 10} h`;
};
/** DUST from its base unit (10^15 SPECK to a DUST). */
export const dustOf = (raw: string | bigint) => Number(BigInt(raw)) / 1e15;
/** tNIGHT from its base unit (10^6 STAR to a NIGHT). */
export const nightOf = (raw: string | bigint) => Number(BigInt(raw)) / 1e6;
const amount = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2));

/** DUST a NIGHT generates in a day at Midnight's rate (5 DUST per NIGHT, filled in 604,815 s). */
export const DUST_PER_NIGHT_DAY = (5 * 86_400) / 604_815;

/**
 * Whether fees outrun generation: DUST spent in a day against what the
 * wallet's NIGHT generates in a day, and the NIGHT that would cover the
 * spending (with `margin`, default 1.5).
 */
export const dustBudget = (night: number, spentPerDay: number, margin = 1.5) => {
  const generatedPerDay = night * DUST_PER_NIGHT_DAY;
  return {
    generatedPerDay,
    spentPerDay,
    outrunning: spentPerDay > generatedPerDay,
    nightNeeded: (spentPerDay * margin) / DUST_PER_NIGHT_DAY,
  };
};

const journal = (unit: string) => `journalctl -u ${unit} --since "30 min ago" --no-pager | tail -40`;

/** Restarts of `unit` within the last hour, from the samples plus the count now. */
export const restartsInHour = (samples: { at: number; n: number }[], now: number, n: number): number => {
  const old = samples.filter((s) => s.at <= now - 60 * MIN).at(-1) ?? samples.find((s) => s.at > now - 60 * MIN);
  if (!old) return 0;
  return Math.max(0, n - old.n); // NRestarts resets when the unit is restarted by hand: never negative
};

/** Everything wrong right now. */
export const evaluate = (inp: Inputs, state: MonitorState, cfg: MonitorConfig = DEFAULT_CONFIG): Alert[] => {
  const { now } = inp;
  const out: Alert[] = [];
  const down = new Set<string>();

  for (const u of inp.units) {
    const running = u.active === 'active' || u.active === 'activating' || u.active === 'reloading';
    if (!running) {
      down.add(u.name);
      out.push({
        key: `unit:${u.name}`,
        kind: 'problem',
        title: `${u.name} is not running (${u.active}${u.sub ? `, ${u.sub}` : ''})`,
        check: [`systemctl status ${u.name} --no-pager`, journal(u.name), `systemctl restart ${u.name}   (keeper and oracle: between :30 and :55)`],
      });
      continue;
    }
    const n = restartsInHour(state.restarts[u.name] ?? [], now, u.restarts);
    if (n >= cfg.restartsPerHour) {
      out.push({
        key: `restarts:${u.name}`,
        kind: 'problem',
        title: `${u.name} has restarted ${n} times in the last hour`,
        detail: 'Its watchdogs restart it when transactions keep failing, its wallet stops syncing or a pass hangs. Restarting this often means the restart isn\'t fixing the cause.',
        check: [journal(u.name)],
      });
    }
  }

  for (const s of inp.services) {
    if (down.has(s.unit)) continue; // already reported as not running
    const name = s.service === 'oracle' ? 'The oracle' : s.service === 'keeper' ? 'The keeper' : s.service;
    const st = s.status;
    if (!st) {
      out.push({
        key: `status:${s.service}`,
        kind: 'problem',
        title: `${name} isn't reporting its health`,
        detail: `${s.path}: ${s.error ?? 'missing'}. It is written every minute by a service started with --status ${s.path}.`,
        check: [`systemctl cat ${s.unit} | grep -- --status`, journal(s.unit)],
      });
      continue;
    }
    const at = ms(st.at)!;
    if (now - at >= cfg.statusStaleMins * MIN) {
      out.push({
        key: `status:${s.service}`,
        kind: 'problem',
        title: `${name} hasn't reported for ${mins((now - at) / MIN)}`,
        detail: 'Its process has stopped or frozen (it writes its status every minute).',
        check: [`systemctl status ${s.unit} --no-pager`, journal(s.unit)],
      });
      continue;
    }
    const started = ms(st.started_at)!;
    const pass = ms(st.last_pass_at) ?? started;
    if (now - pass >= cfg.passStaleMins * MIN) {
      out.push({
        key: `pass:${s.service}`,
        kind: 'problem',
        title: `${name} hasn't checked the chain for ${mins((now - pass) / MIN)}`,
        detail: st.last_pass_at
          ? 'It is running but stuck inside a pass (a chain read that never returns, say). Its silence watchdog restarts it after 10 minutes; this means that hasn\'t helped.'
          : 'It is running but hasn\'t finished a first pass since it started.',
        check: [journal(s.unit), `systemctl restart ${s.unit}   (between :30 and :55)`],
      });
    }
    const since = ms(st.failing_since);
    if (st.failures >= 3 && since !== undefined && now - since >= cfg.failingMins * MIN) {
      out.push({
        key: `failing:${s.service}`,
        kind: 'problem',
        title: `${name}'s transactions have failed ${st.failures} times in a row (${mins((now - since) / MIN)})`,
        check: [`${journal(s.unit)} | grep -iE "could not|failed|error"`],
      });
    }
    const w = st.wallet;
    if (w) {
      if (!w.synced && now - started >= cfg.unsyncedMins * MIN) {
        out.push({
          key: `unsynced:${s.service}`,
          kind: 'problem',
          title: `${name}'s wallet isn't synced with the chain`,
          detail: 'A wallet behind the chain has its fee proofs refused. Its sync watchdog restarts it after 15 minutes without progress.',
          check: [`${journal(s.unit)} | grep -i "wallet"`],
        });
      }
      const dust = dustOf(w.dust);
      const night = nightOf(w.night);
      if (night === 0) {
        out.push({
          key: `night:${s.service}`,
          kind: 'problem',
          title: `${name}'s wallet holds no tNIGHT`,
          detail: 'DUST (the fees) is generated from tNIGHT held: without it the wallet will run out of fees.',
        });
      } else if (w.synced && dust < cfg.minDust) {
        out.push({
          key: `dust:${s.service}`,
          kind: 'problem',
          title: `${name}'s wallet is low on DUST: ${amount(dust)} left`,
          detail: `Alert threshold ${cfg.minDust} DUST. It holds ${amount(night)} tNIGHT, which generates more DUST over time; if fees keep outrunning it, send the wallet more tNIGHT from the faucet.`,
        });
      }
      // Spending faster than the wallet's NIGHT generates: it will run dry, sooner or later.
      const f = st.fees;
      if (f && f.last_24h_txs >= 5 && night > 0) {
        const b = dustBudget(night, f.last_24h_dust);
        if (b.outrunning) {
          const daysLeft = dust / (b.spentPerDay - b.generatedPerDay);
          out.push({
            key: `dustrate:${s.service}`,
            kind: 'problem',
            title: `${name} spends DUST faster than its tNIGHT makes it: ${amount(b.spentPerDay)} a day against ${amount(b.generatedPerDay)}`,
            detail:
              `At this rate its ${amount(dust)} DUST lasts about ${daysLeft < 1 ? mins(daysLeft * 24 * 60) : `${amount(daysLeft)} days`}. ` +
              `It holds ${amount(night)} tNIGHT; about ${Math.ceil(b.nightNeeded)} would cover this spending with room to spare. Send it the difference (from the treasury).`,
          });
        }
      }
    }
  }

  if (inp.feedPath) {
    const keeperTrouble = out.some((a) => /:(keeper|lunardraw-starfall-keeper)$/.test(a.key));
    if (!inp.feed) {
      if (!keeperTrouble) out.push({ key: 'feed', kind: 'problem', title: "The site feed can't be read", detail: `${inp.feedPath}: ${inp.feedError ?? 'missing'}` });
    } else {
      const gen = ms(inp.feed.generated_at)!;
      if (now - gen >= cfg.feedStaleMins * MIN && !keeperTrouble) {
        out.push({
          key: 'feed',
          kind: 'problem',
          title: `The site feed hasn't updated for ${mins((now - gen) / MIN)}`,
          detail: 'The keeper writes it after every pass; the website shows the draws from it.',
          check: [journal('lunardraw-starfall-keeper')],
        });
      }
      out.push(...drawAlerts(inp.feed, now, state, cfg));
    }
  }

  if (inp.disk) {
    const { free, total, path } = inp.disk;
    if (free < cfg.minDiskBytes || free / total < cfg.minDiskFraction) {
      out.push({
        key: 'disk',
        kind: 'problem',
        title: `Disk space is low: ${(free / 2 ** 30).toFixed(1)} GB free (${Math.round((free / total) * 100)}%) on ${path}`,
        check: ['df -h /', 'du -xsh /root/* /var/log/journal 2>/dev/null | sort -h | tail'],
      });
    }
  }
  return out;
};

/** Draws close to a deadline, and new void draws. */
export const drawAlerts = (feed: StarfallFeed, now: number, state: MonitorState, cfg: MonitorConfig): Alert[] => {
  const out: Alert[] = [];
  const g = feed.games.starfall;
  const left = (iso: string | undefined) => (iso === undefined ? undefined : (Date.parse(iso) - now) / MIN);

  // Not revealed: sales have closed and the reveal deadline is near.
  const unrevealed = [
    ...(g.open ? [{ num: g.open.num, sales_close: g.open.sales_close, reveal_deadline: g.open.reveal_deadline }] : []),
    ...g.draws.filter((d) => d.status === 'open' || d.status === 'closed'),
  ];
  for (const d of unrevealed) {
    const l = left(d.reveal_deadline);
    if (Date.parse(d.sales_close) <= now && l !== undefined && l > 0 && l <= cfg.deadlineMins) {
      out.push({
        key: `reveal:${d.num}`,
        kind: 'problem',
        title: `Draw ${d.num} isn't revealed yet: ${mins(l)} before it's cancelled`,
        detail: 'The keeper reveals each draw\'s seed after sales close. If it misses the reveal deadline the draw is voided and every ticket refunded.',
        check: [journal('lunardraw-starfall-keeper')],
      });
    }
  }

  for (const d of g.draws) {
    if (d.status === 'requested' && !d.vrf_output) {
      const l = left(d.draw_deadline);
      const revealed = ms(d.timeline?.revealed_at);
      const waited = revealed === undefined ? undefined : (now - revealed) / MIN;
      if (l !== undefined && l > 0 && (l <= cfg.deadlineMins || (waited !== undefined && waited >= cfg.oracleWaitMins))) {
        out.push({
          key: `oracle:${d.num}`,
          kind: 'problem',
          title: `The oracle hasn't answered draw ${d.num}: ${mins(l)} before it's cancelled`,
          detail: `${waited !== undefined ? `Revealed ${mins(waited)} ago. ` : ''}It usually answers within a few minutes. If it misses the deadline the draw is voided and refunded.`,
          check: [journal('lunardraw-starfall-oracle')],
        });
      }
    }
    if ((d.status === 'drawn' || d.status === 'settling' || (d.status === 'requested' && d.vrf_output)) && d.settle_deadline) {
      const l = left(d.settle_deadline);
      if (l !== undefined && l > 0 && l <= cfg.settleMins) {
        out.push({
          key: `settle:${d.num}`,
          kind: 'problem',
          title: `Draw ${d.num} isn't settled yet: ${mins(l)} before it's cancelled`,
          detail: d.batches !== undefined ? `${d.batches_done ?? 0} of ${d.batches} settlement batches done.` : 'Its numbers aren\'t computed yet.',
          check: [journal('lunardraw-starfall-keeper')],
        });
      }
    }
  }

  const voids = g.draws.filter((d) => d.status === 'void').map((d) => d.num);
  if (state.lastVoid !== undefined) {
    for (const d of g.draws.filter((x) => x.status === 'void' && x.num > state.lastVoid!).sort((a, b) => a.num - b.num)) {
      const why = d.vrf_output ? 'it wasn\'t settled in time' : d.seed ? 'the oracle didn\'t answer in time' : 'it wasn\'t revealed in time';
      out.push({
        key: `void:${d.num}`,
        kind: 'notice',
        title: `Draw ${d.num} was cancelled: ${why}`,
        detail: `Its ${d.games_sold} game(s) are refunded to the buyers (${d.refunded ?? 0} so far). The keeper opens the next draw by itself.`,
      });
    }
  }
  if (voids.length) state.lastVoid = Math.max(state.lastVoid ?? 0, ...voids);
  else state.lastVoid ??= 0;
  return out;
};

export type Email = { subject: string; text: string };

/** Problems already emailed and not yet resolved (not one-off notices). */
const openProblems = (state: MonitorState) =>
  Object.entries(state.alerts)
    .filter(([k, r]) => r.sentAt !== undefined && !k.startsWith('void:'))
    .map(([, r]) => r);

const localDate = (now: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const localHour = (now: number, tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now));
const localTime = (ms: number, tz: string) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);

const block = (a: Alert, extra?: string) =>
  [`• ${a.title}${extra ? ` (${extra})` : ''}`, ...(a.detail ? [`  ${a.detail}`] : []), ...(a.check ?? []).map((c) => `  $ ${c}`)].join('\n');

/**
 * Fold this run's alerts into the state (mutated) and say what to email:
 * confirmed new problems and notices, reminders, and resolutions.
 */
export const decide = (alerts: Alert[], state: MonitorState, now: number, cfg: MonitorConfig = DEFAULT_CONFIG): Email | undefined => {
  const fresh: Alert[] = [];
  const still: { a: Alert; since: number }[] = [];
  const resolved: { title: string; since: number }[] = [];
  const seen = new Set<string>();

  for (const a of alerts) {
    seen.add(a.key);
    const prev = state.alerts[a.key];
    const rec: MonitorState['alerts'][string] = prev ? { ...prev, title: a.title, runs: prev.runs + 1 } : { title: a.title, firstSeen: now, runs: 1 };
    state.alerts[a.key] = rec;
    if (a.kind === 'notice') {
      if (rec.sentAt === undefined) {
        fresh.push(a);
        rec.sentAt = rec.lastSentAt = now;
      }
      continue;
    }
    if (rec.sentAt === undefined) {
      if (rec.runs >= cfg.confirmRuns) {
        fresh.push(a);
        rec.sentAt = rec.lastSentAt = now;
      }
    } else if (now - (rec.lastSentAt ?? rec.sentAt) >= cfg.remindHours * 60 * MIN) {
      still.push({ a, since: rec.firstSeen });
      rec.lastSentAt = now;
    }
  }
  for (const [key, rec] of Object.entries(state.alerts)) {
    if (seen.has(key)) continue;
    // notices are kept a day so the same event isn't sent twice
    if (key.startsWith('void:')) {
      if (now - rec.firstSeen > 24 * 60 * MIN) delete state.alerts[key];
      continue;
    }
    if (rec.sentAt !== undefined) resolved.push({ title: rec.title, since: rec.firstSeen });
    delete state.alerts[key];
  }
  if (!fresh.length && !still.length && !resolved.length) return undefined;

  const problems = fresh.filter((a) => a.kind === 'problem');
  const subject = fresh.length
    ? `${problems.length ? '🔴' : '🟡'} Lunardraw: ${fresh[0].title}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`
    : still.length
      ? `🔴 Lunardraw: still ${still[0].a.title.charAt(0).toLowerCase()}${still[0].a.title.slice(1)}${still.length > 1 ? ` (+${still.length - 1} more)` : ''}`
      : `✅ Lunardraw: resolved: ${resolved[0].title}${resolved.length > 1 ? ` (+${resolved.length - 1} more)` : ''}`;
  const parts: string[] = [];
  if (fresh.length) parts.push(`NEW\n\n${fresh.map((a) => block(a)).join('\n\n')}`);
  if (still.length) parts.push(`STILL GOING\n\n${still.map(({ a, since }) => block(a, `since ${localTime(since, cfg.tz)}, ${mins((now - since) / MIN)}`)).join('\n\n')}`);
  if (resolved.length) parts.push(`RESOLVED\n\n${resolved.map((r) => `• ${r.title} (lasted ${mins((now - r.since) / MIN)})`).join('\n')}`);
  const open = openProblems(state).filter((r) => !fresh.some((a) => a.title === r.title) && !still.some((s) => s.a.title === r.title));
  if (open.length && !fresh.length && !still.length) parts.push(`STILL OPEN\n\n${open.map((r) => `• ${r.title}`).join('\n')}`);
  return { subject, text: `${parts.join('\n\n')}\n\n${footer(now, cfg)}` };
};

const footer = (now: number, cfg: MonitorConfig) =>
  `-- \nSent by ./lunardraw monitor on the keeper VM at ${localTime(now, cfg.tz)} (${cfg.tz}). It checks every 5 minutes.\nEverything at once: systemctl is-active lunardraw-proof lunardraw-starfall-keeper lunardraw-starfall-oracle`;

/** The daily summary, once a day from `digestHour` local time (mutates the state's digestDate). */
export const digest = (inp: Inputs, state: MonitorState, cfg: MonitorConfig = DEFAULT_CONFIG): Email | undefined => {
  if (cfg.digestHour < 0) return undefined;
  const today = localDate(inp.now, cfg.tz);
  if (state.digestDate === today || localHour(inp.now, cfg.tz) < cfg.digestHour) return undefined;
  state.digestDate = today;

  const lines: string[] = [];
  const restarts = (u: Unit) => {
    const day = (state.restarts[u.name] ?? []).find((s) => s.at >= inp.now - 24 * 60 * MIN);
    return day ? Math.max(0, u.restarts - day.n) : 0;
  };
  lines.push('SERVICES');
  for (const u of inp.units) lines.push(`  ${u.active === 'active' ? '✓' : '✗'} ${u.name}: ${u.active}${restarts(u) ? `, ${restarts(u)} restart(s) in 24 h` : ''}`);
  const wallets = inp.services.filter((s) => s.status?.wallet);
  if (wallets.length) {
    lines.push('', 'WALLETS');
    for (const s of wallets) {
      const w = s.status!.wallet!;
      lines.push(`  ${s.service}: ${amount(dustOf(w.dust))} DUST, ${amount(nightOf(w.night))} tNIGHT${w.synced ? '' : ' (not synced)'}`);
      const f = s.status!.fees;
      if (f && f.last_24h_txs > 0) {
        const b = dustBudget(nightOf(w.night), f.last_24h_dust);
        lines.push(
          `    fees in 24 h: ${amount(f.last_24h_dust)} DUST over ${f.last_24h_txs} transaction(s); its tNIGHT makes ${amount(b.generatedPerDay)} a day` +
            `${b.outrunning ? ' (not enough)' : ''}; ${Math.ceil(b.nightNeeded)} tNIGHT would cover it`,
        );
        const each = Object.entries(f.circuits)
          .sort((a, b2) => b2[1].count - a[1].count)
          .map(([c, v]) => `${c} ${v.avg_dust.toPrecision(2)}`)
          .join(', ');
        if (each) lines.push(`    typical fee per transaction (DUST): ${each}`);
      }
    }
  }
  if (inp.feed) {
    const g = inp.feed.games.starfall;
    const dayAgo = inp.now - 24 * 60 * MIN;
    const recent = g.draws.filter((d) => Date.parse(d.sales_close) >= dayAgo);
    const count = (st: string) => recent.filter((d) => d.status === st).length;
    lines.push('', 'DRAWS (last 24 h)');
    lines.push(`  ${count('settled')} settled, ${count('void')} voided, ${recent.length - count('settled') - count('void')} in progress`);
    if (g.open) lines.push(`  On sale: draw ${g.open.num}, ${g.open.tickets} ticket(s), closes ${localTime(Date.parse(g.open.sales_close), cfg.tz)}`);
    const answered = recent.filter((d) => d.timeline?.revealed_at && d.timeline.answered_at);
    if (answered.length) {
      const secs = answered.map((d) => (Date.parse(d.timeline!.answered_at!) - Date.parse(d.timeline!.revealed_at!)) / 1000).sort((a, b) => a - b);
      lines.push(`  Oracle: answered ${answered.length}, typical ${Math.round(secs[Math.floor(secs.length / 2)] / 60)} min, slowest ${Math.round(secs.at(-1)! / 60)} min`);
    }
  }
  if (inp.disk) lines.push('', `DISK  ${(inp.disk.free / 2 ** 30).toFixed(0)} GB free of ${(inp.disk.total / 2 ** 30).toFixed(0)} GB`);
  const open = openProblems(state);
  lines.push('', open.length ? `OPEN PROBLEMS\n${open.map((r) => `  • ${r.title}`).join('\n')}` : 'No open problems.');
  const ok = !open.length && inp.units.every((u) => u.active === 'active');
  return { subject: `${ok ? '✅' : '🔴'} Lunardraw daily: ${ok ? 'all good' : `${open.length || 'some'} problem(s)`}`, text: `${lines.join('\n')}\n\n${footer(inp.now, cfg)}\nIf this daily email stops arriving, the monitor itself (or the VM) is down.` };
};

/** Record this run's restart counts (kept a day). */
export const noteRestarts = (state: MonitorState, units: Unit[], now: number): void => {
  for (const u of units) {
    const s = (state.restarts[u.name] ??= []);
    s.push({ at: now, n: u.restarts });
    state.restarts[u.name] = s.filter((x) => x.at >= now - 25 * 60 * MIN);
  }
};
