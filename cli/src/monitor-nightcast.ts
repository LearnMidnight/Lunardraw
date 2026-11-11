/**
 * Monitor checks for Nightcast's oracle and LunaSpin (added 11 Nov 2026).
 *
 * Reads two things the Nightcast side writes on the VM:
 * - the oracle's status file (`NIGHTCAST_STATUS_FILE`, upkeep.ts in Nightcast):
 *   its wallet, the bond, answers, misses, the last bond deposit and top-up,
 *   and what LunaSpin's request server reports about its own wallet;
 * - the soak test's log (`/root/spin-test/soak.log`): one `SOAK ...` line per
 *   hourly run of three real requests.
 *
 * Pure: `nightcastAlerts` turns those into alerts, `nightcastDigest` into
 * lines for the daily summary.
 */
import type { Alert } from './monitor.js';

/** The oracle's status file (amounts are atoms as text: 1 NIGHT = 1e6, 1 DUST = 1e15). */
export type OracleStatus = {
  at: string;
  wallet: { night: string; dust: string };
  bond: { free: string; held: string; target?: string };
  served?: { address?: string; night?: string };
  fulfilled: number;
  missed: number;
  lastFulfilledAt?: string;
  lastMissedAt?: string;
  lastDeposit?: { at: string; slots: string; ok: boolean; note?: string };
  lastTopUp?: { at: string; night: string; ok: boolean; note?: string };
};

export type SoakRun = { at: number; requests: number; answered: number; slowest?: number; restarts: number };

export type NightcastInput = {
  statusPath?: string;
  status?: OracleStatus;
  statusError?: string;
  soakPath?: string;
  soak?: SoakRun[];
  soakError?: string;
  /** Whether the oracle's unit is running (a stopped unit has its own alert). */
  oracleActive?: boolean;
};

export type NightcastConfig = {
  /** Minutes without a status update before it counts as stale. */
  statusStaleMins: number;
  /** The oracle's wallet below this many tNIGHT is low (its upkeep floor is 2000). */
  minOracleNight: number;
  /** LunaSpin's wallet below this many tNIGHT is low (it is topped up below 1000). */
  minSpinNight: number;
  /** DUST below which the oracle's wallet is low. */
  minDust: number;
  /** Free bond slots below which requests are close to being refused. */
  minFreeSlots: number;
  /** Minutes without a soak run before it counts as stopped (it runs hourly). */
  soakStaleMins: number;
};

export const NIGHTCAST_DEFAULTS: NightcastConfig = { statusStaleMins: 10, minOracleNight: 2_500, minSpinNight: 500, minDust: 100, minFreeSlots: 10, soakStaleMins: 100 };

const MIN = 60_000;
const night = (atoms: string | undefined) => (atoms !== undefined && /^\d+$/.test(atoms) ? Number(BigInt(atoms)) / 1e6 : undefined);
const dust = (atoms: string) => Number(BigInt(atoms)) / 1e15;
const n0 = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
const ORACLE_LOG = 'journalctl -u nightcast-oracle --since "30 min ago" -o cat --no-pager | grep -vE "ZK artifact|RuntimeVersion" | tail -30';

/** The soak log's `SOAK <iso> requests=3 answered=3 ... slowest=120 restarts=0` lines, oldest first. */
export const parseSoak = (text: string): SoakRun[] => {
  const runs: SoakRun[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('SOAK ')) continue;
    const [, iso, ...pairs] = line.trim().split(/\s+/);
    const at = Date.parse(iso ?? '');
    const kv = Object.fromEntries(pairs.map((p) => p.split('=') as [string, string]));
    const requests = Number(kv.requests);
    const answered = Number(kv.answered);
    if (!Number.isFinite(at) || !Number.isFinite(requests) || !Number.isFinite(answered)) continue;
    runs.push({ at, requests, answered, slowest: kv.slowest === undefined ? undefined : Number(kv.slowest), restarts: Number(kv.restarts ?? 0) || 0 });
  }
  return runs.sort((a, b) => a.at - b.at);
};

export const nightcastAlerts = (inp: NightcastInput, now: number, cfg: NightcastConfig = NIGHTCAST_DEFAULTS): Alert[] => {
  const out: Alert[] = [];
  const s = inp.status;

  if (inp.statusPath && inp.oracleActive !== false) {
    const age = s ? (now - Date.parse(s.at)) / MIN : undefined;
    if (!s) {
      out.push({ key: 'nightcast:status', kind: 'problem', title: "The Nightcast oracle's status file can't be read", detail: `${inp.statusPath}: ${inp.statusError ?? 'missing'}`, check: [ORACLE_LOG] });
    } else if (age !== undefined && age >= cfg.statusStaleMins) {
      out.push({
        key: 'nightcast:status',
        kind: 'problem',
        title: `The Nightcast oracle hasn't reported for ${Math.round(age)} minutes`,
        detail: 'It rewrites its status every minute while it runs; LunaSpin spins may be going unanswered.',
        check: [ORACLE_LOG],
      });
    }
  }

  if (s && (now - Date.parse(s.at)) / MIN < cfg.statusStaleMins) {
    const free = Number(s.bond.free);
    const held = Number(s.bond.held);
    const target = s.bond.target === undefined ? undefined : Number(s.bond.target);
    if (free < cfg.minFreeSlots && free + held < (target ?? Infinity)) {
      out.push({
        key: 'nightcast:bond',
        kind: 'problem',
        title: `The oracle's bond is down to ${free} free slot(s)`,
        detail:
          `Each missed request takes one for good; with none, every LunaSpin spin is refused.${target !== undefined ? ` The oracle should keep it at ${target}.` : ''}` +
          (s.lastDeposit && !s.lastDeposit.ok ? ` Its last deposit failed: ${s.lastDeposit.note ?? 'no reason given'}.` : ''),
        check: [ORACLE_LOG],
      });
    } else if (s.lastDeposit && !s.lastDeposit.ok && now - Date.parse(s.lastDeposit.at) < 60 * MIN) {
      out.push({ key: 'nightcast:deposit', kind: 'problem', title: "The oracle couldn't top up its bond", detail: s.lastDeposit.note, check: [ORACLE_LOG] });
    }

    if (s.lastTopUp && !s.lastTopUp.ok && now - Date.parse(s.lastTopUp.at) < 120 * MIN) {
      out.push({ key: 'nightcast:topup', kind: 'problem', title: "The oracle couldn't top up LunaSpin's wallet", detail: s.lastTopUp.note, check: [ORACLE_LOG] });
    }

    const ours = night(s.wallet.night);
    if (ours !== undefined && ours < cfg.minOracleNight) {
      out.push({
        key: 'nightcast:wallet',
        kind: 'problem',
        title: `The Nightcast oracle's wallet is down to ${n0(ours)} tNIGHT`,
        detail: 'It refills the bond and LunaSpin\'s wallet from this, and stops at 2000 so it keeps making DUST. Send it tNIGHT (from the treasury).',
      });
    }
    if (dust(s.wallet.dust) < cfg.minDust) {
      out.push({ key: 'nightcast:dust', kind: 'problem', title: `The Nightcast oracle's wallet is low on DUST: ${n0(dust(s.wallet.dust))}`, detail: 'DUST pays for its answers; it comes from the tNIGHT the wallet holds.' });
    }
    const theirs = night(s.served?.night);
    if (theirs !== undefined && theirs < cfg.minSpinNight) {
      out.push({
        key: 'lunaspin:wallet',
        kind: 'problem',
        title: `LunaSpin's wallet is down to ${n0(theirs)} tNIGHT`,
        detail: 'Each spin costs it 0.1. The oracle should have topped it up below 1000; see the oracle\'s log for why it didn\'t.',
        check: [ORACLE_LOG],
      });
    }
    if (s.lastMissedAt) {
      out.push({
        key: `nightcast:missed:${s.lastMissedAt}`,
        kind: 'notice',
        title: 'The Nightcast oracle missed a request',
        detail: `It was too close to its deadline to answer (at ${s.lastMissedAt}); the spin is void and the oracle hands back the fee and 1 tNIGHT from its bond. ${s.missed} missed and ${s.fulfilled} answered since the oracle last started.`,
        check: [ORACLE_LOG],
      });
    }
  }

  if (inp.soakPath) {
    const runs = inp.soak ?? [];
    const last = runs.at(-1);
    if (!last) {
      if (inp.soakError) out.push({ key: 'lunaspin:soak-stopped', kind: 'problem', title: "LunaSpin's hourly test can't be read", detail: `${inp.soakPath}: ${inp.soakError}` });
    } else if ((now - last.at) / MIN >= cfg.soakStaleMins) {
      out.push({
        key: 'lunaspin:soak-stopped',
        kind: 'problem',
        title: `LunaSpin's hourly test hasn't run for ${Math.round((now - last.at) / MIN)} minutes`,
        check: ['systemctl list-timers lunaspin-soak.timer --no-pager', 'tail -20 /root/spin-test/soak.log'],
      });
    } else {
      const recent = runs.filter((r) => now - r.at <= 3 * 60 * MIN);
      const bad = recent.filter((r) => r.answered < r.requests);
      // one bad run can be a blip (the services restart themselves); two, or a run with nothing answered, is a problem
      if (bad.length >= 2 || (last.requests > 0 && last.answered === 0)) {
        const req = recent.reduce((t, r) => t + r.requests, 0);
        const ans = recent.reduce((t, r) => t + r.answered, 0);
        out.push({
          key: 'lunaspin:soak',
          kind: 'problem',
          title: `LunaSpin's test spins are failing: ${ans} of ${req} answered in the last 3 hours`,
          detail: 'The hourly test sends three real requests through LunaSpin\'s own server. Visitors\' spins are likely failing too.',
          check: ['bash /root/spin-test/soak-install.sh report', 'tail -30 /root/spin-test/soak.log', ORACLE_LOG],
        });
      }
    }
  }
  return out;
};

/** Lines for the daily summary. */
export const nightcastDigest = (inp: NightcastInput, now: number): string[] => {
  const lines: string[] = [];
  const s = inp.status;
  if (s) {
    const target = s.bond.target ? ` of ${s.bond.target}` : '';
    lines.push(`  oracle wallet: ${n0(night(s.wallet.night) ?? 0)} tNIGHT, ${n0(dust(s.wallet.dust))} DUST; bond ${Number(s.bond.free) + Number(s.bond.held)}${target} slots`);
    const theirs = night(s.served?.night);
    if (theirs !== undefined) lines.push(`  LunaSpin's wallet: ${n0(theirs)} tNIGHT`);
    lines.push(`  since the oracle last started: ${s.fulfilled} answered, ${s.missed} missed`);
  }
  const day = (inp.soak ?? []).filter((r) => now - r.at <= 24 * 60 * MIN);
  if (day.length) {
    const req = day.reduce((t, r) => t + r.requests, 0);
    const ans = day.reduce((t, r) => t + r.answered, 0);
    const slow = Math.max(0, ...day.map((r) => r.slowest ?? 0));
    lines.push(`  hourly test (24 h): ${ans} of ${req} answered (${req ? ((100 * ans) / req).toFixed(1) : '0'}%), slowest ${slow} s, ${day.reduce((t, r) => t + r.restarts, 0)} self-restart(s) during runs`);
  }
  return lines.length ? ['', 'NIGHTCAST AND LUNASPIN', ...lines] : [];
};
