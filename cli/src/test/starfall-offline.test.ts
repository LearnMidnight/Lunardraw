import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { quickPick, Starfall } from '@lunardraw/contract';
import { DerivedSeeds, every, StarfallKeeper } from '@lunardraw/keeper';
import { generateOperatorSecret, generateOracleSecretKey, oraclePublicKey } from '@nightcast/contract';
import { onChainFingerprints } from '@nightcast/deploy';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { parseUserAddress } from '../starfall-commands.js';
import {
  MidnightStarfallChain,
  STARFALL_PRIVATE_STATE_ID,
  type StarfallCalls,
  type StarfallDeploymentRecord,
  starfallRecordParameters,
  verifyStarfall,
} from '../starfall.js';

type PrivateState = Starfall.SettlementPrivateState;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const OPERATOR = new Uint8Array(32).fill(9);

const setup = () => {
  const oracleSecretKey = generateOracleSecretKey();
  const organiserSecret = generateOperatorSecret();
  const settlementSecret = Starfall.randomScalar();
  const sim = new Starfall.SettlementSimulator({
    oracleSecretKey,
    organiserSecret,
    settlementSecret,
    operator: OPERATOR,
    minSales: 600n,
    maxSales: 30n * 86_400n,
    revealWindow: 1_800n,
    drawWindow: 1_800n,
    settleWindow: 7_200n,
  });
  return { sim, oracleSecretKey, organiserSecret, settlementSecret };
};

/**
 * midnight-js stand-ins backed by the simulator: callTx runs each circuit
 * with whatever the private state store holds, as midnight-js does.
 */
const fakeMidnight = (sim: InstanceType<typeof Starfall.SettlementSimulator>, initial: PrivateState) => {
  let state: PrivateState = initial;
  const seen: PrivateState[] = [];
  const store = {
    setContractAddress(address: string) {
      expect(address).toBe(sim.address);
    },
    async set(id: string, s: PrivateState) {
      expect(id).toBe(STARFALL_PRIVATE_STATE_ID);
      state = s;
    },
  };
  const calls: StarfallCalls = {
    callTx: {
      acceptOracleKey: async () => sim.acceptOracleKey(),
      requestDraw: async (n, seed, next) => {
        if (n === 0n) sim.openDraw(next.value.salesClose, next.value.seedCommitment, state);
        else if (next.is_some) sim.requestAndOpenNext(n, seed, next.value, state);
        else sim.requestDraw(n, seed, state);
      },
      fulfilDraw: async (n) => sim.fulfilDraw(n),
      computeNumbers: async (n, now) => sim.computeNumbers(n, now),
      settleBatch: async (n) => {
        seen.push(state);
        const s = state.settling;
        if (!s || s.drawId !== n) throw new Error('no decrypted tickets in private state');
        sim.settleBatch(n, s.tickets);
      },
      finaliseDraw: async (n) => sim.finaliseDraw(n),
      payEntitlement: async (id) => sim.payEntitlement(id),
      voidDraw: async (n) => sim.voidDraw(n),
      refundTicket: async (n, i) => sim.refundTicket(n, i),
      buyTickets: async (count, refundTo) => {
        const ts = state.pendingTickets ?? [];
        expect(BigInt(ts.length)).toBe(count);
        sim.buyTickets(ts, refundTo.bytes);
      },
    },
  };
  const publicData = { queryContractState: async () => ({ data: sim.publicState() }) };
  return { calls, store, publicData, seen, state: () => state };
};

describe('MidnightStarfallChain', () => {
  it("runs a whole draw through midnight-js's private state: decrypted tickets go in for each batch and come out after", async () => {
    const { sim, organiserSecret, settlementSecret } = setup();
    const base = { organiserSecret };
    const m = fakeMidnight(sim, base);
    const chain = new MidnightStarfallChain(m.calls, m.publicData, m.store, sim.address, base, 300, () => sim.now * 1000);
    expect(hex(chain.addressBytes)).toBe(hex(sim.addressBytes));
    const keeper = new StarfallKeeper({
      chain,
      seeds: new DerivedSeeds(organiserSecret, chain.addressBytes),
      settlementSecret,
      schedule: every(3_600),
      clock: () => sim.now * 1000,
    });
    expect((await keeper.tick()).done).toEqual(['open after 0']);
    const buyer = webcrypto.getRandomValues(new Uint8Array(32));
    const games = Array.from({ length: 30 }, () => Starfall.makeTicket(1n, quickPick(), buyer));
    for (let i = 0; i < games.length; i += 4) {
      await m.store.set(STARFALL_PRIVATE_STATE_ID, { pendingTickets: games.slice(i, i + 4) });
      await m.calls.callTx.buyTickets(BigInt(games.slice(i, i + 4).length), { bytes: buyer });
    }
    await m.store.set(STARFALL_PRIVATE_STATE_ID, base);
    sim.advance(Number(sim.getLedger().draws.lookup(1n).salesClose) - sim.now + 31);
    expect((await keeper.tick()).done).toEqual(['reveal 1']);
    sim.fulfilDraw(1n);
    expect((await keeper.tick()).done).toEqual(['compute 1']);
    expect((await keeper.tick()).done).toEqual(['settle 1 from 0']);
    expect((await keeper.tick()).done).toEqual(['settle 1 from 25']);
    expect((await keeper.tick()).done).toEqual(['finalise 1']);
    expect(sim.getLedger().draws.lookup(1n).status).toBe(Starfall.DrawStatus.settled);
    // Each batch saw every ticket of the draw, beside the organiser secret ...
    expect(m.seen).toHaveLength(2);
    for (const s of m.seen) {
      expect(s.settling?.tickets).toHaveLength(30);
      expect(s.organiserSecret).toBe(organiserSecret);
    }
    // ... and the private state is back to just the organiser secret.
    expect(m.state()).toEqual(base);
  }, 120_000);
});

describe('verifyStarfall', () => {
  const vk = (s: string) => new TextEncoder().encode(s);
  const keys = { settleBatch: 'ks', buyTickets: 'kb' };
  const fps = onChainFingerprints({ operations: () => Object.keys(keys), operation: (n) => ({ verifierKey: vk(keys[n as 'settleBatch']) }) });
  const build = (authority = { committee: [] as string[], threshold: 1, counter: 1n }) => {
    const { sim, oracleSecretKey, organiserSecret, settlementSecret } = setup();
    const state = {
      maintenanceAuthority: authority,
      operations: () => Object.keys(keys),
      operation: (name: string) => ({ verifierKey: vk(keys[name as 'settleBatch']) }),
      data: sim.publicState(),
    };
    const record: StarfallDeploymentRecord = {
      contract: 'starfall',
      network: 'local',
      contractAddress: sim.address,
      deployedAt: '2026-10-26T00:00:00Z',
      compiler: { compiler: '0.31.1', language: '0.23.0', runtime: '0.16.0' },
      parameters: starfallRecordParameters({
        oraclePublicKey: oraclePublicKey(oracleSecretKey),
        organiserCommitment: Starfall.pureCircuits.organiserCommitmentOf(organiserSecret),
        backupCommitment: Starfall.pureCircuits.organiserCommitmentOf(sim.backupSecret),
        settlementKey: Starfall.pureCircuits.settlementPublicKey(settlementSecret),
        operator: OPERATOR,
        feePerGame: 200_000n,
        ticketPrice: 1_200_000n,
        minSales: 600n,
        maxSales: 30n * 86_400n,
        revealWindow: 1_800n,
        drawWindow: 1_800n,
        settleWindow: 7_200n,
      }),
      transactions: {},
      verifierKeys: fps,
    };
    return { state, record };
  };
  const failing = (checks: { name: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.name);

  it('passes a locked deployment that matches its record', () => {
    const { state, record } = build();
    expect(failing(verifyStarfall(record, state, fps))).toEqual([]);
  });

  it('fails on an unlocked authority, a different settlement key, operator or fee', () => {
    const unlocked = build({ committee: ['k'], threshold: 1, counter: 0n });
    expect(failing(verifyStarfall(unlocked.record, unlocked.state))).toEqual(['maintenance authority locked']);
    const { state, record } = build();
    const p = record.parameters;
    expect(failing(verifyStarfall({ ...record, parameters: { ...p, settlementKey: { x: '1', y: '2' } } }, state))).toEqual([
      'settlement key matches the record',
    ]);
    const other = { ...record, parameters: { ...p, operator: '00'.repeat(32), feePerGame: '100000' } };
    const checks = verifyStarfall(other, state);
    expect(failing(checks)).toEqual(['price, fee and windows match']);
    expect(checks.find((c) => !c.ok)!.detail).toMatch(/operator .*feePerGame 200000/);
    expect(failing(verifyStarfall(record, null))).toEqual(['contract exists']);
  });
});

describe('parseUserAddress', () => {
  it('reads mn_addr addresses and 64 hex characters', () => {
    const bytes = webcrypto.getRandomValues(new Uint8Array(32));
    const bech = MidnightBech32m.encode('preprod', new UnshieldedAddress(Buffer.from(bytes))).asString();
    expect(bech.startsWith('mn_addr_preprod1')).toBe(true);
    expect(hex(parseUserAddress(bech))).toBe(hex(bytes));
    expect(hex(parseUserAddress(hex(bytes)))).toBe(hex(bytes));
    expect(() => parseUserAddress('nonsense')).toThrow(/not an address/);
  });
});
