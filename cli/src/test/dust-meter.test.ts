import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { DustAddress, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { walletAddressOf } from '@nightcast/deploy';
import { DUST_PER_NIGHT_DAY as METER_RATE, DustMeter, dustFeeOf, meterDustFees } from '../dust-meter.js';
import { DUST_PER_NIGHT_DAY, dustBudget } from '../monitor.js';
import { walletAddressesOf } from '../wallet-address.js';

const D = 10n ** 15n; // Specks in a DUST
const tx = (fees: bigint[], entryPoint?: string | Uint8Array) => ({
  intents: new Map([[1, { dustActions: { spends: fees.map((vFee) => ({ vFee })) }, actions: entryPoint === undefined ? [] : [{ entryPoint }] }]]),
});

describe('dustFeeOf', () => {
  it("reads a transaction's declared DUST fee and the circuit it calls", () => {
    expect(dustFeeOf(tx([D / 4n, D / 4n], 'settleBatch'))).toEqual({ circuit: 'settleBatch', specks: D / 2n });
    expect(dustFeeOf(tx([3n], new TextEncoder().encode('requestDraw')))).toEqual({ circuit: 'requestDraw', specks: 3n });
    expect(dustFeeOf(tx([]))).toBeUndefined();
    expect(dustFeeOf({})).toBeUndefined();
    expect(dustFeeOf(undefined)).toBeUndefined();
  });
});

describe('DustMeter', () => {
  it('summarises per circuit and the last 24 hours, keeps a week, and survives a restart', () => {
    let now = Date.parse('2026-11-06T00:00:00Z');
    const file = join(mkdtempSync(join(tmpdir(), 'meter-')), 'keeper.status.json.fees.json');
    const m = new DustMeter(file, () => now);
    m.record('settleBatch', D);
    m.record('settleBatch', 3n * D);
    m.record('requestDraw', D / 2n);
    now += 25 * 3_600_000;
    m.record('finaliseDraw', D / 10n);
    const s = m.summary();
    expect(s.circuits.settleBatch).toEqual({ count: 2, avg_dust: 2, last_dust: 3 });
    expect(s.last_24h_txs).toBe(1);
    expect(s.last_24h_dust).toBeCloseTo(0.1);
    // a new process reads the same records
    expect(new DustMeter(file, () => now).summary()).toEqual(s);
    now += 7 * 86_400_000;
    m.record('requestDraw', D);
    expect(Object.keys(m.summary().circuits)).toEqual(['requestDraw']);
  });
});

describe('meterDustFees', () => {
  it('measures what was sent successfully, and leaves the provider’s other methods working', async () => {
    class Provider {
      sent = 0;
      async submitTx(t: unknown) {
        this.sent += 1;
        if ((t as { fail?: boolean }).fail) throw new Error('refused');
        return 'txid';
      }
      hello() {
        return `sent ${this.sent}`;
      }
    }
    const p = new Provider();
    const m = new DustMeter(undefined, () => 0);
    const logged: string[] = [];
    const wrapped = meterDustFees({ midnightProvider: p, other: 1 }, m, { info: (x) => logged.push(x) });
    expect(await (wrapped.midnightProvider as Provider).submitTx(tx([D], 'payEntitlement'))).toBe('txid');
    await expect((wrapped.midnightProvider as Provider).submitTx({ ...tx([D], 'payEntitlement'), fail: true })).rejects.toThrow(/refused/);
    expect((wrapped.midnightProvider as Provider).hello()).toBe('sent 2');
    expect(wrapped.other).toBe(1);
    expect(m.summary().circuits.payEntitlement.count).toBe(1);
    expect(logged).toEqual(['fee for payEntitlement: 1.0000 DUST']);
  });
});

describe('dustBudget', () => {
  it("compares spending with what the wallet's NIGHT generates", () => {
    expect(DUST_PER_NIGHT_DAY).toBeCloseTo(0.714, 3);
    expect(METER_RATE).toBe(DUST_PER_NIGHT_DAY);
    const b = dustBudget(100, 50);
    expect(b.generatedPerDay).toBeCloseTo(71.4, 1);
    expect(b.outrunning).toBe(false);
    const c = dustBudget(10, 50);
    expect(c.outrunning).toBe(true);
    expect(c.nightNeeded).toBeCloseTo(50 * 1.5 / DUST_PER_NIGHT_DAY);
  });
});

describe('walletAddressesOf', () => {
  it("gives a wallet's NIGHT address and a DUST address that decodes on the same network", () => {
    const seed = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex');
    const a = walletAddressesOf('preprod', seed);
    expect(a.night).toBe(walletAddressOf('preprod', seed));
    expect(a.night.startsWith('mn_addr_preprod1')).toBe(true);
    expect(a.dust.startsWith('mn_dust_preprod1')).toBe(true);
    expect(() => MidnightBech32m.parse(a.dust).decode(DustAddress, 'preprod')).not.toThrow();
    expect(walletAddressesOf('preprod', seed)).toEqual(a);
  });
});
