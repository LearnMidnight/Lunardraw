import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StarfallFeed, StarfallFeedDraw } from '@lunardraw/keeper';
import { DEFAULT_CONFIG, decide, digest, emptyState, evaluate, type Inputs, noteRestarts, restartsInHour, type Unit } from '../monitor.js';
import { parseHealth, parseShow, readHealth, sendEmail } from '../monitor-command.js';
import { serviceStatus, type ServiceStatus } from '../status-file.js';

const MIN = 60_000;
// 09:00 in Brisbane (UTC+10) on 2 Nov 2026
const NOW = Date.parse('2026-11-01T23:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const DUST = 10n ** 15n;

const unit = (name: string, active = 'active', restarts = 0): Unit => ({ name, active, sub: active === 'active' ? 'running' : 'dead', restarts });
const UNITS = [unit('lunardraw-proof'), unit('lunardraw-starfall-keeper'), unit('lunardraw-starfall-oracle')];

const status = (service: string, over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  schema: 'lunardraw-status/1',
  service,
  pid: 1,
  started_at: iso(NOW - 120 * MIN),
  at: iso(NOW - MIN),
  last_pass_at: iso(NOW - MIN),
  failures: 0,
  wallet: { synced: true, night: String(500_000_000n), dust: String(50n * DUST) },
  ...over,
});

/** null: that service's status file is missing. */
const services = (keeper: Partial<ServiceStatus> | null = {}, oracle: Partial<ServiceStatus> | null = {}) => [
  { service: 'keeper', unit: 'lunardraw-starfall-keeper', path: '/s/keeper.json', status: keeper ? status('keeper', keeper) : undefined },
  { service: 'oracle', unit: 'lunardraw-starfall-oracle', path: '/s/oracle.json', status: oracle ? status('oracle', oracle) : undefined },
];

const draw = (num: number, over: Partial<StarfallFeedDraw>): StarfallFeedDraw => ({
  num,
  status: 'settled',
  sales_close: iso(NOW - 3 * 60 * MIN),
  seed_commitment: 'c',
  games_sold: 4,
  ...over,
});

const feed = (draws: StarfallFeedDraw[], open?: StarfallFeed['games']['starfall']['open'], generated = NOW - MIN): StarfallFeed => ({
  schema: 'lunardraw-feed/1',
  network: 'preprod',
  generated_at: iso(generated),
  sample: false,
  contracts: { starfall: 'f868' },
  games: { starfall: { price_star: 1_200_000, fee_star: 200_000, allocation_bp: [], carry_star: 0, open, draws } },
});

const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  now: NOW,
  units: UNITS,
  services: services(),
  feed: feed([draw(10, {})]),
  feedPath: '/f/feed.json',
  disk: { path: '/', free: 100 * 2 ** 30, total: 200 * 2 ** 30 },
  ...over,
});

const keys = (inp: Inputs, state = { ...emptyState(), lastVoid: 0 }) => evaluate(inp, state).map((a) => a.key);

describe('the monitor', () => {
  it('finds nothing wrong when everything runs', () => {
    expect(keys(inputs())).toEqual([]);
  });

  it("reports a stopped service once, not again as a missing status", () => {
    const inp = inputs({ units: [UNITS[0], UNITS[1], unit('lunardraw-starfall-oracle', 'failed')], services: services({}, null) });
    const alerts = evaluate(inp, { ...emptyState(), lastVoid: 0 });
    expect(alerts.map((a) => a.key)).toEqual(['unit:lunardraw-starfall-oracle']);
    expect(alerts[0].title).toBe('lunardraw-starfall-oracle is not running (failed, dead)');
    expect(alerts[0].check?.[0]).toContain('systemctl status lunardraw-starfall-oracle');
  });

  it('counts restarts within the hour from the samples it keeps', () => {
    const samples = [
      { at: NOW - 70 * MIN, n: 2 },
      { at: NOW - 30 * MIN, n: 4 },
    ];
    expect(restartsInHour(samples, NOW, 6)).toBe(4); // since the last sample over an hour old
    expect(restartsInHour([{ at: NOW - 20 * MIN, n: 1 }], NOW, 3)).toBe(2); // only recent samples: the oldest
    expect(restartsInHour([], NOW, 9)).toBe(0); // nothing to compare
    expect(restartsInHour([{ at: NOW - 70 * MIN, n: 5 }], NOW, 0)).toBe(0); // reset by a manual restart
    const state = emptyState();
    noteRestarts(state, [unit('k', 'active', 1)], NOW - 61 * MIN);
    expect(keys(inputs({ units: [unit('k', 'active', 4)] }), { ...state, lastVoid: 0 })).toEqual(['restarts:k']);
  });

  it('notices a service that stopped reporting, got stuck, keeps failing, lost its sync or runs low', () => {
    expect(keys(inputs({ services: services({ at: iso(NOW - 12 * MIN) }) }))).toEqual(['status:keeper']);
    expect(keys(inputs({ services: services(null) }))).toEqual(['status:keeper']);
    expect(keys(inputs({ services: services({}, { last_pass_at: iso(NOW - 20 * MIN) }) }))).toEqual(['pass:oracle']);
    expect(keys(inputs({ services: services({}, { failures: 5, failing_since: iso(NOW - 11 * MIN) }) }))).toEqual(['failing:oracle']);
    expect(keys(inputs({ services: services({}, { failures: 5, failing_since: iso(NOW - 4 * MIN) }) }))).toEqual([]); // not long enough
    expect(keys(inputs({ services: services({ wallet: { synced: false, night: '5', dust: '0' } }) }))).toEqual(['unsynced:keeper']);
    // a wallet just started is allowed its first sync
    expect(keys(inputs({ services: services({ started_at: iso(NOW - 5 * MIN), wallet: { synced: false, night: '5', dust: '0' } }) }))).toEqual([]);
    const low = evaluate(inputs({ services: services({}, { wallet: { synced: true, night: '7000000', dust: String(DUST / 4n) } }) }), { ...emptyState(), lastVoid: 0 });
    expect(low.map((a) => [a.key, a.title])).toEqual([['dust:oracle', "The oracle's wallet is low on DUST: 0.25 left"]]);
    expect(keys(inputs({ services: services({ wallet: { synced: true, night: '0', dust: '0' } }) }))).toEqual(['night:keeper']);
    // Fees outrunning what the wallet's tNIGHT generates: 7 tNIGHT makes 5 DUST a day; 24 DUST spent in 24 hours.
    const fees = { circuits: { settleBatch: { count: 20, avg_dust: 1.2, last_dust: 1.2 } }, last_24h_dust: 24, last_24h_txs: 20 };
    const hot = evaluate(inputs({ services: services({ wallet: { synced: true, night: '7000000', dust: String(38n * DUST) }, fees }) }), { ...emptyState(), lastVoid: 0 });
    expect(hot.map((a) => a.key)).toEqual(['dustrate:keeper']);
    expect(hot[0].title).toMatch(/spends DUST faster than its tNIGHT makes it: 24.00 a day against 5.00/);
    expect(hot[0].detail).toMatch(/lasts about 2.00 days.*about 51 would cover/);
    // Enough tNIGHT: no alert. Too few transactions to judge: no alert.
    expect(keys(inputs({ services: services({ fees }) }))).toEqual([]);
    expect(keys(inputs({ services: services({ wallet: { synced: true, night: '7000000', dust: String(19n * DUST) }, fees: { ...fees, last_24h_txs: 3 } }) }))).toEqual([]);
  });

  it('warns before a draw misses its reveal, its oracle answer or its settlement', () => {
    const open = { num: 12, sales_close: iso(NOW - 6 * MIN), reveal_deadline: iso(NOW + 4 * MIN), seed_commitment: 'c', games_sold: 3, tickets: 3 };
    expect(keys(inputs({ feed: feed([], open) }))).toEqual(['reveal:12']);
    expect(keys(inputs({ feed: feed([], { ...open, reveal_deadline: iso(NOW + 9 * MIN) }) }))).toEqual([]);
    const asked = draw(11, { status: 'requested', seed: 'ab', draw_deadline: iso(NOW + 20 * MIN), timeline: { revealed_at: iso(NOW - 3 * MIN) } });
    expect(keys(inputs({ feed: feed([asked]) }))).toEqual([]); // the oracle usually takes a few minutes
    expect(keys(inputs({ feed: feed([{ ...asked, timeline: { revealed_at: iso(NOW - 11 * MIN) } }]) }))).toEqual(['oracle:11']);
    expect(keys(inputs({ feed: feed([{ ...asked, draw_deadline: iso(NOW + 4 * MIN) }]) }))).toEqual(['oracle:11']);
    expect(keys(inputs({ feed: feed([{ ...asked, vrf_output: 'ff' }]) }))).toEqual([]); // answered
    const settling = draw(9, { status: 'settling', settle_deadline: iso(NOW + 40 * MIN), batches: 3, batches_done: 1 });
    const alerts = evaluate(inputs({ feed: feed([settling]) }), { ...emptyState(), lastVoid: 0 });
    expect(alerts.map((a) => [a.key, a.title])).toEqual([['settle:9', "Draw 9 isn't settled yet: 40 min before it's cancelled"]]);
    expect(alerts[0].detail).toMatch(/^1 of 3 settlement batches done\. It usually settles within about 10 minutes; 40 min are left/);
  });

  it('warns when a draw is still unsettled 30 minutes after its numbers, long before its deadline', () => {
    const drawn = (m: number, extra = {}) =>
      draw(20, { status: 'settling', settle_deadline: iso(NOW + 20 * 60 * MIN), batches: 2, batches_done: 1, timeline: { drawn_at: iso(NOW - m * MIN) }, ...extra });
    expect(keys(inputs({ feed: feed([drawn(12)]) }))).toEqual([]); // still within the usual time
    const late = evaluate(inputs({ feed: feed([drawn(31)]) }), { ...emptyState(), lastVoid: 0 });
    expect(late.map((a) => [a.key, a.title])).toEqual([['settle:20', "Draw 20 isn't settled 31 min after its numbers"]]);
    expect(late[0].detail).toMatch(/20 h are left before it is cancelled/);
    // every batch done but not finalised: the draw before it is holding it up
    const held = evaluate(inputs({ feed: feed([drawn(45, { batches_done: 2 })]) }), { ...emptyState(), lastVoid: 0 });
    expect(held[0].detail).toMatch(/finalising waits for the draw before it/);
    expect(keys(inputs({ feed: feed([drawn(45, { status: 'settled' })]) }))).toEqual([]);
  });

  it('reports each void draw once, with why, but not the ones there before it started', () => {
    const state = emptyState();
    const voided = draw(7, { status: 'void', seed: 'ab', refunded: 2 });
    expect(evaluate(inputs({ feed: feed([voided]) }), state)).toEqual([]);
    expect(state.lastVoid).toBe(7);
    const next = draw(8, { status: 'void', refunded: 0 });
    const alerts = evaluate(inputs({ feed: feed([next, voided]) }), state);
    expect(alerts.map((a) => [a.key, a.kind, a.title])).toEqual([['void:8', 'notice', "Draw 8 was cancelled: it wasn't revealed in time"]]);
    expect(evaluate(inputs({ feed: feed([next, voided]) }), state)).toEqual([]);
  });

  it('notices a stale feed, unless the keeper is already reported, and a nearly full disk', () => {
    expect(keys(inputs({ feed: feed([], undefined, NOW - 15 * MIN) }))).toEqual(['feed']);
    expect(keys(inputs({ feed: feed([], undefined, NOW - 15 * MIN), services: services({ at: iso(NOW - 15 * MIN) }) }))).toEqual(['status:keeper']);
    expect(keys(inputs({ feed: undefined, feedError: 'no such file' }))).toEqual(['feed']);
    expect(keys(inputs({ disk: { path: '/', free: 3 * 2 ** 30, total: 200 * 2 ** 30 } }))).toEqual(['disk']);
  });

  it('emails a problem seen twice, reminds every 6 hours, and says when it is resolved', () => {
    const state = emptyState();
    const a = { key: 'unit:x', kind: 'problem' as const, title: 'x is not running (failed)', check: ['systemctl status x'] };
    expect(decide([a], state, NOW)).toBeUndefined(); // once: maybe a restart in progress
    const first = decide([a], state, NOW + 5 * MIN)!;
    expect(first.subject).toBe('🔴 Lunardraw: x is not running (failed)');
    expect(first.text).toContain('NEW\n\n• x is not running (failed)\n  $ systemctl status x');
    expect(decide([a], state, NOW + 60 * MIN)).toBeUndefined();
    const reminder = decide([a], state, NOW + 6 * 60 * MIN + 5 * MIN)!;
    expect(reminder.subject).toBe('🔴 Lunardraw: still x is not running (failed)');
    expect(reminder.text).toMatch(/STILL GOING\n\n• x is not running \(failed\) \(since \d\d:\d\d, 6\.1 h\)/);
    const done = decide([], state, NOW + 7 * 60 * MIN)!;
    expect(done.subject).toBe('✅ Lunardraw: resolved: x is not running (failed)');
    expect(state.alerts).toEqual({});
    // a blip seen once and gone is never emailed
    expect(decide([a], state, NOW)).toBeUndefined();
    expect(decide([], state, NOW + 5 * MIN)).toBeUndefined();
  });

  it('emails a notice at once and only once', () => {
    const state = emptyState();
    const n = { key: 'void:8', kind: 'notice' as const, title: 'Draw 8 was cancelled' };
    expect(decide([n], state, NOW)!.subject).toBe('🟡 Lunardraw: Draw 8 was cancelled');
    expect(decide([n], state, NOW + 5 * MIN)).toBeUndefined();
    expect(decide([], state, NOW + 10 * MIN)).toBeUndefined(); // no "resolved" for a notice
  });

  it('sends the daily summary once a day from 8 in the morning, Brisbane time', () => {
    const state = emptyState();
    const early = inputs({ now: Date.parse('2026-11-01T21:30:00Z') }); // 07:30 Brisbane
    expect(digest(early, state, DEFAULT_CONFIG)).toBeUndefined();
    const d = digest(inputs({ feed: feed([draw(10, { sales_close: iso(NOW - 60 * MIN), timeline: { revealed_at: iso(NOW - 50 * MIN), answered_at: iso(NOW - 47 * MIN) } })]) }), state, DEFAULT_CONFIG)!;
    expect(d.subject).toBe('✅ Lunardraw daily: all good');
    expect(d.text).toContain('✓ lunardraw-starfall-oracle: active');
    expect(d.text).toContain('oracle: 50.00 DUST, 500 tNIGHT');
    expect(d.text).toContain('1 settled, 0 voided, 0 in progress');
    expect(d.text).toContain('Oracle: answered 1, typical 3 min, slowest 3 min');
    expect(state.digestDate).toBe('2026-11-02');
    expect(digest(inputs({ now: NOW + 60 * MIN }), state, DEFAULT_CONFIG)).toBeUndefined();
  });

  it('checks health endpoints: an answer that is ok, one that cannot request, one that is down, and its stopped unit', () => {
    const url = 'http://127.0.0.1:6350/health';
    const at = (body?: Record<string, unknown>, error?: string) => inputs({ health: [{ name: 'nightcast-mcp', url, body, error }] });
    expect(keys(at({ ok: true, canRequest: true }))).toEqual([]);
    expect(keys(at({ ok: true, network: 'preprod' }))).toEqual([]); // read-only servers don't say canRequest
    const cant = evaluate(at({ ok: true, canRequest: false }), { ...emptyState(), lastVoid: 0 });
    expect(cant.map((a) => a.key)).toEqual(['health:nightcast-mcp']);
    expect(cant[0].title).toMatch(/can't make requests yet/);
    const down = evaluate(at(undefined, 'fetch failed'), { ...emptyState(), lastVoid: 0 });
    expect(down[0].title).toBe("nightcast-mcp doesn't answer (fetch failed)");
    expect(down[0].check).toContain(`curl -s ${url}`);
    expect(keys(at({ ok: false }))).toEqual(['health:nightcast-mcp']);
    // a stopped unit is reported once, as the unit
    const stopped = inputs({ units: [...UNITS, unit('nightcast-mcp', 'failed')], health: [{ name: 'nightcast-mcp', url, error: 'fetch failed' }] });
    expect(keys(stopped)).toEqual(['unit:nightcast-mcp']);
  });

  it('reads --health and fetches an endpoint', async () => {
    expect(parseHealth('nightcast-mcp=http://127.0.0.1:6350/health, x=https://a.b/h')).toEqual([
      { name: 'nightcast-mcp', url: 'http://127.0.0.1:6350/health' },
      { name: 'x', url: 'https://a.b/h' },
    ]);
    expect(parseHealth(undefined)).toEqual([]);
    expect(() => parseHealth('nightcast-mcp')).toThrow(/name=url/);
    const answer = (status: number, text: string) => (async () => new Response(text, { status })) as unknown as typeof fetch;
    expect(await readHealth('m', 'http://h', answer(200, '{"ok":true,"canRequest":true}'))).toEqual({ name: 'm', url: 'http://h', body: { ok: true, canRequest: true } });
    expect((await readHealth('m', 'http://h', answer(502, 'Bad gateway'))).error).toBe('HTTP 502, not JSON');
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6350');
    }) as unknown as typeof fetch;
    expect((await readHealth('m', 'http://h', failing)).error).toMatch(/ECONNREFUSED/);
  });

  it("reads systemd's view of a unit and sends through Resend", async () => {
    expect(parseShow('k', 'ActiveState=activating\nSubState=auto-restart\nNRestarts=3\n')).toEqual({ name: 'k', active: 'activating', sub: 'auto-restart', restarts: 3 });
    let sent: { url: string; init: RequestInit } | undefined;
    const ok = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response('{"id":"abc"}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendEmail({ subject: 's', text: 't' }, { key: 're_x', from: 'a@l.io', to: ['o@l.io'] }, ok)).toBe('abc');
    expect(sent!.url).toBe('https://api.resend.com/emails');
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe('Bearer re_x');
    expect(JSON.parse(String(sent!.init.body))).toEqual({ from: 'a@l.io', to: ['o@l.io'], subject: 's', text: 't' });
    const refused = (async () => new Response('{"message":"domain not verified"}', { status: 403 })) as unknown as typeof fetch;
    await expect(sendEmail({ subject: 's', text: 't' }, { key: 'k', from: 'a', to: ['b'] }, refused)).rejects.toThrow(/403.*not verified/);
  });

  it("loads nothing but Node's own modules (it runs every 5 minutes, apart from main.js)", () => {
    const loads = (file: string) =>
      [...readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').matchAll(/^import (?!type )[^;]*? from '([^']+)'/gm)].map((m) => m[1]);
    const files = ['monitor-main.ts', 'monitor-command.ts', 'monitor.ts', 'status-file.ts', 'monitor-nightcast.ts'];
    for (const f of files) for (const m of loads(f)) expect(m.startsWith('node:') || files.includes(m.replace(/^\.\//, '').replace(/\.js$/, '.ts')), `${f} loads ${m}`).toBe(true);
  });

  it("writes the service's health from its wallet state and passes", () => {
    const s = serviceStatus(
      'oracle',
      NOW - 10 * MIN,
      NOW,
      { lastTickAt: NOW - 5_000, streak: { failures: 2, since: NOW - 60_000 } },
      { isSynced: true, dust: { balance: () => 3n * DUST }, unshielded: { balances: { night: 9_000_000n } } },
      'night',
    );
    expect(s).toMatchObject({ service: 'oracle', at: iso(NOW), last_pass_at: iso(NOW - 5_000), failures: 2, failing_since: iso(NOW - 60_000), wallet: { synced: true, night: '9000000', dust: String(3n * DUST) } });
    expect(serviceStatus('keeper', NOW, NOW, { streak: { failures: 0 } }, undefined, 'night').wallet).toBeUndefined();
  });
});
