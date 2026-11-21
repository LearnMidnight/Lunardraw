import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, ensureWallet, type KitConfig, loadConfig, saveConfig } from '../kit/home.js';
import { serveSettingsOnly, setLive } from '../kit/settings.js';

const fresh = () => {
  const home = mkdtempSync(join(tmpdir(), 'kit-settings-'));
  saveConfig({ ...DEFAULT_CONFIG }, home);
  ensureWallet(home);
  return home;
};

const deps = (calls: string[]) => ({
  addressOf: async () => 'mn_addr_preprod1test',
  checkKey: async (id: string) => (id === 'preprodGOODKEY123' ? { ok: true } : { ok: false, why: 'Blockfrost doesn\'t accept that key.' }),
  list: async (_c: KitConfig, _s: string, action: 'list' | 'unlist', listing: KitConfig['listing']) => {
    calls.push(`${action} ${listing?.name}`);
    return 'listed';
  },
});

describe('the settings page', () => {
  it('needs the key from its link, and answers only this computer', async () => {
    const home = fresh();
    const page = await serveSettingsOnly({ home, ...deps([]) });
    try {
      const base = `http://127.0.0.1:${page.port}`;
      const key = new URL(page.link).hash.replace('#k=', '');
      expect(page.link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${page.port}/settings#k=[A-Za-z0-9_-]{32}$`));
      const html = await fetch(`${base}/settings`);
      expect(html.status).toBe(200);
      expect(html.headers.get('content-security-policy')).toMatch(/default-src 'none'.*connect-src 'self'/);
      expect(await html.text()).toMatch(/Show my agent on lunardraw\.io/);
      expect((await fetch(`${base}/settings/api`)).status).toBe(401);
      expect((await fetch(`${base}/settings/api`, { headers: { 'x-settings-key': 'wrong' } })).status).toBe(401);
      // another web page in the browser can't use it
      expect((await fetch(`${base}/settings/api`, { headers: { 'x-settings-key': key, origin: 'https://evil.example' } })).status).toBe(403);
      const s = (await (await fetch(`${base}/settings/api`, { headers: { 'x-settings-key': key } })).json()) as { address: string; limits: unknown; blockfrost: boolean; listing: unknown; wallet: unknown };
      expect(s).toMatchObject({ address: 'mn_addr_preprod1test', limits: DEFAULT_CONFIG.limits, blockfrost: false, listing: null });
    } finally {
      await page.close();
    }
  });

  it('saves the limits, the Blockfrost key and the listing, each on its own', async () => {
    const home = fresh();
    const calls: string[] = [];
    const page = await serveSettingsOnly({ home, ...deps(calls) });
    const key = new URL(page.link).hash.replace('#k=', '');
    const save = async (body: unknown) => {
      const r = await fetch(`http://127.0.0.1:${page.port}/settings/api`, { method: 'POST', headers: { 'x-settings-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return (await r.json()) as { saved: string[]; errors: string[]; state: { limits: unknown; blockfrost: boolean; listing: unknown } };
    };
    try {
      // the case that took ten steps by hand: 2,000 a draw, 5,000 a day
      let out = await save({ limits: { perDraw: '2,000', perDay: 5000 } });
      expect(out.errors).toEqual([]);
      expect(out.saved[0]).toMatch(/2000 tNIGHT a draw, 5000 tNIGHT a day/);
      expect(loadConfig(home).limits).toEqual({ perDraw: 2000, perDay: 5000 });

      // a bad key and a bad name are refused; the good limit change alongside still lands
      out = await save({ blockfrost: 'nope', limits: { perDraw: 40, perDay: 5000 }, listing: { name: 'x', via: 'claude' } });
      expect(out.errors.join(' ')).toMatch(/Blockfrost key: Blockfrost doesn't accept/);
      expect(out.errors.join(' ')).toMatch(/The name must be 2 to 20/);
      expect(loadConfig(home).limits).toEqual({ perDraw: 40, perDay: 5000 });
      expect(calls).toEqual([]);

      out = await save({ limits: { perDraw: -1 } });
      expect(out.errors[0]).toMatch(/from 0 to 1,000,000/);
      expect(loadConfig(home).limits.perDraw).toBe(40);

      out = await save({ blockfrost: 'preprodGOODKEY123', listing: { name: 'OmegaCandle', style: 'plays every night', via: 'claude' } });
      expect(out.errors).toEqual([]);
      expect(out.state.blockfrost).toBe(true);
      expect(out.state.listing).toEqual({ name: 'OmegaCandle', style: 'plays every night', via: 'claude' });
      expect(calls).toEqual(['list OmegaCandle']);

      // saving the same again sends nothing; turning it off unlists
      out = await save({ listing: { name: 'OmegaCandle', style: 'plays every night', via: 'claude' } });
      expect(out.saved).toEqual([]);
      out = await save({ listing: false });
      expect(out.saved[0]).toMatch(/Taken out/);
      expect(loadConfig(home).listing).toBeUndefined();
      expect(calls).toEqual(['list OmegaCandle', 'unlist OmegaCandle']);
    } finally {
      await page.close();
    }
  });

  it('shows how the running agent\'s wallet is doing', async () => {
    const home = fresh();
    writeFileSync(join(home, 'blockfrost-preprod.secret'), 'preprodGOODKEY123\n');
    setLive(async () => ({ phase: 'syncing', synced: 0.18 }));
    const page = await serveSettingsOnly({ home, ...deps([]) });
    const key = new URL(page.link).hash.replace('#k=', '');
    try {
      const s = (await (await fetch(`http://127.0.0.1:${page.port}/settings/api`, { headers: { 'x-settings-key': key } })).json()) as { wallet: unknown; blockfrost: boolean };
      expect(s.blockfrost).toBe(true);
      expect(s.wallet).toEqual({ phase: 'syncing', synced: 0.18 });
    } finally {
      await page.close();
    }
  });
});
