import { describe, expect, it } from 'vitest';
import { nightcastAlerts, nightcastDigest, type OracleStatus, parseSoak } from '../monitor-nightcast.js';

const NOW = Date.UTC(2026, 10, 11, 6, 0, 0);
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const N = (night: number) => String(BigInt(Math.round(night * 1e6)));
const status = (over: Partial<OracleStatus> = {}): OracleStatus => ({
  at: iso(1),
  wallet: { night: N(5950), dust: '7000000000000000000' },
  bond: { free: '50', held: '0', target: '50' },
  served: { address: 'mn_addr_preprod1spin', night: N(9990) },
  fulfilled: 12,
  missed: 0,
  ...over,
});
const keys = (a: { key: string }[]) => a.map((x) => x.key);
const path = { statusPath: '/s/nightcast-oracle.json', soakPath: '/s/soak.log' };

describe('the soak log', () => {
  it('reads its SOAK lines and skips the rest', () => {
    const runs = parseSoak(
      ['05:14:11 3 requests, one every 45 s.', 'SOAK 2026-11-11T05:00:00Z requests=3 answered=3 refused=0 failed=0 slowest=120 restarts=0', 'SOAK bad line', 'SOAK 2026-11-11T04:00:00Z requests=3 answered=2 refused=1 restarts=1', ''].join('\n'),
    );
    expect(runs).toEqual([
      { at: Date.UTC(2026, 10, 11, 4), requests: 3, answered: 2, slowest: undefined, restarts: 1 },
      { at: Date.UTC(2026, 10, 11, 5), requests: 3, answered: 3, slowest: 120, restarts: 0 },
    ]);
  });
});

describe('Nightcast and LunaSpin alerts', () => {
  const good = [{ at: NOW - 10 * 60_000, requests: 3, answered: 3, slowest: 100, restarts: 0 }];

  it('is quiet when all is well', () => {
    expect(nightcastAlerts({ ...path, status: status(), soak: good, oracleActive: true }, NOW)).toEqual([]);
  });

  it("says when the oracle's status is missing or stale, unless its unit is down (that has its own alert)", () => {
    expect(keys(nightcastAlerts({ ...path, statusError: 'no such file', soak: good, oracleActive: true }, NOW))).toEqual(['nightcast:status']);
    expect(keys(nightcastAlerts({ ...path, status: status({ at: iso(11) }), soak: good, oracleActive: true }, NOW))).toEqual(['nightcast:status']);
    expect(nightcastAlerts({ ...path, status: status({ at: iso(11) }), soak: good, oracleActive: false }, NOW)).toEqual([]);
  });

  it('warns of a bond nearly gone, and of a deposit that failed', () => {
    const low = nightcastAlerts({ ...path, status: status({ bond: { free: '4', held: '1', target: '50' }, lastDeposit: { at: iso(5), slots: '45', ok: false, note: 'Custom error: 231' } }), soak: good }, NOW);
    expect(keys(low)).toEqual(['nightcast:bond']);
    expect(low[0].detail).toContain('Custom error: 231');
    // few free slots only because requests are holding them: the bond is whole
    expect(nightcastAlerts({ ...path, status: status({ bond: { free: '4', held: '46', target: '50' } }), soak: good }, NOW)).toEqual([]);
    expect(keys(nightcastAlerts({ ...path, status: status({ bond: { free: '48', held: '0', target: '50' }, lastDeposit: { at: iso(5), slots: '2', ok: false, note: 'x' } }), soak: good }, NOW))).toEqual(['nightcast:deposit']);
  });

  it('warns of low wallets, a failed top-up and a missed request', () => {
    const a = nightcastAlerts(
      {
        ...path,
        status: status({
          wallet: { night: N(2400), dust: '50000000000000000' },
          served: { address: 'mn_addr_preprod1spin', night: N(450) },
          lastTopUp: { at: iso(20), night: N(2000), ok: false, note: 'Insufficient funds' },
          missed: 1,
          lastMissedAt: iso(3),
        }),
        soak: good,
      },
      NOW,
    );
    expect(keys(a)).toEqual(['nightcast:topup', 'nightcast:wallet', 'nightcast:dust', 'lunaspin:wallet', `nightcast:missed:${iso(3)}`]);
    expect(a.at(-1)!.kind).toBe('notice');
  });

  it('warns when the test spins fail twice in 3 hours, or the last run got nothing, or the test stopped', () => {
    const run = (minsAgo: number, answered: number) => ({ at: NOW - minsAgo * 60_000, requests: 3, answered, restarts: 0 });
    const s = status();
    expect(nightcastAlerts({ ...path, status: s, soak: [run(130, 3), run(70, 2), run(10, 3)] }, NOW)).toEqual([]); // one blip
    const twice = nightcastAlerts({ ...path, status: s, soak: [run(130, 2), run(70, 3), run(10, 2)] }, NOW);
    expect(keys(twice)).toEqual(['lunaspin:soak']);
    expect(twice[0].title).toContain('7 of 9 answered');
    expect(keys(nightcastAlerts({ ...path, status: s, soak: [run(70, 3), run(10, 0)] }, NOW))).toEqual(['lunaspin:soak']);
    expect(keys(nightcastAlerts({ ...path, status: s, soak: [run(101, 3)] }, NOW))).toEqual(['lunaspin:soak-stopped']);
    expect(nightcastAlerts({ ...path, status: s, soak: [] }, NOW)).toEqual([]); // not run yet
  });

  it('adds its lines to the daily summary', () => {
    const lines = nightcastDigest({ status: status({ bond: { free: '47', held: '1', target: '50' }, missed: 2 }), soak: [{ at: NOW - 3_600_000, requests: 3, answered: 3, slowest: 111, restarts: 0 }] }, NOW);
    expect(lines).toEqual([
      '',
      'NIGHTCAST AND LUNASPIN',
      '  oracle wallet: 5950 tNIGHT, 7000 DUST; bond 48 of 50 slots',
      "  LunaSpin's wallet: 9990 tNIGHT",
      '  since the oracle last started: 12 answered, 2 missed',
      '  hourly test (24 h): 3 of 3 answered (100.0%), slowest 111 s, 0 self-restart(s) during runs',
    ]);
    expect(nightcastDigest({}, NOW)).toEqual([]);
  });
});
