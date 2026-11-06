import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { quickPick, Starfall } from '@lunardraw/contract';
import { DerivedSeeds, every, StarfallKeeper, type StarfallView } from '@lunardraw/keeper';
import { generateOperatorSecret, generateOracleSecretKey, oraclePublicKey } from '@nightcast/contract';
import { onChainFingerprints } from '@nightcast/deploy';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { pureCircuits as v0 } from '@lunardraw/contract';
import { buyEntries, describeEntry, describeTickets, entriesBought, lastDrawMarker, organiserCheck, parseUserAddress, starfallOrganiserCommitment, windDownStatus } from '../starfall-commands.js';
import {
  buyGames,
  BuyStopped,
  MidnightStarfallChain,
  onChainCheck,
  pendingReverter,
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
    // A full batch and part of the next (an even number: they're bought two at a time).
    const count = Number(Starfall.pureCircuits.batchSize()) + 8;
    const games = Array.from({ length: count }, () => Starfall.makeTicket(1n, quickPick(), buyer));
    for (let i = 0; i < games.length; i += 2) {
      await m.store.set(STARFALL_PRIVATE_STATE_ID, { pendingTickets: games.slice(i, i + 2) });
      await m.calls.callTx.buyTickets(BigInt(games.slice(i, i + 2).length), { bytes: buyer });
    }
    await m.store.set(STARFALL_PRIVATE_STATE_ID, base);
    sim.advance(Number(sim.getLedger().draws.lookup(1n).salesClose) - sim.now + 31);
    expect((await keeper.tick()).done).toEqual(['reveal 1']);
    sim.fulfilDraw(1n);
    expect((await keeper.tick()).done).toEqual(['compute 1']);
    expect((await keeper.tick()).done).toEqual(['settle 1 from 0']);
    expect((await keeper.tick()).done).toEqual([`settle 1 from ${Starfall.pureCircuits.batchSize()}`]);
    expect((await keeper.tick()).done).toEqual(['finalise 1']);
    expect(sim.getLedger().draws.lookup(1n).status).toBe(Starfall.DrawStatus.settled);
    // Each batch saw every ticket of the draw, beside the organiser secret ...
    expect(m.seen).toHaveLength(2);
    for (const s of m.seen) {
      expect(s.settling?.tickets).toHaveLength(count);
      expect(s.organiserSecret).toBe(organiserSecret);
    }
    // ... and the private state is back to just the organiser secret.
    expect(m.state()).toEqual(base);
  }, 120_000);

  it('gives back the id midnight-js reports for a transaction (the feed links to it), or nothing when there is none', async () => {
    const { sim, organiserSecret } = setup();
    const m = fakeMidnight(sim, { organiserSecret });
    const calls = {
      callTx: { ...m.calls.callTx, computeNumbers: async () => ({ public: { txId: '00ab12' } }), voidDraw: async () => undefined },
    } as unknown as StarfallCalls;
    const chain = new MidnightStarfallChain(calls, m.publicData, m.store, sim.address);
    expect(await chain.computeNumbers(1n)).toBe('00ab12');
    expect(await chain.voidDraw(1n)).toBeUndefined();
  });
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

describe("Starfall's organiser commitment", () => {
  it("is Starfall's, not v0's, and the contract accepts it", () => {
    const { sim, organiserSecret } = setup();
    // The same secret gives different commitments in the two contracts (different domain tags).
    expect(hex(starfallOrganiserCommitment(organiserSecret))).not.toBe(hex(v0.organiserCommitmentOf(organiserSecret)));
    expect(organiserCheck(sim.getLedger(), organiserSecret).ok).toBe(true);
    const other = organiserCheck(sim.getLedger(), generateOperatorSecret());
    expect(other.ok).toBe(false);
    expect(other.detail).toMatch(/the contract's organiser is/);
  });
});

describe('winding a deployment down', () => {
  const view = (draws: { id: bigint; status: Starfall.DrawStatus; unrefunded?: bigint[] }[], paid = true) =>
    ({
      draws: draws.map((d) => ({ unrefunded: [], ...d })),
      entitlements: [{ id: new Uint8Array(32), drawId: 1n, games: [], paid }],
    }) as unknown as StarfallView;

  it('names the marker after the contract, so a new deployment is never wound down by an old one', () => {
    expect(lastDrawMarker('abc123')).toMatch(/lunardraw-state[/\\]starfall-abc123\.last-draw$/);
    expect(lastDrawMarker('abc123')).not.toBe(lastDrawMarker('def456'));
  });

  it('says safe to switch only when every draw is finished, paid and refunded', () => {
    const { settled, voided, drawn } = { settled: Starfall.DrawStatus.settled, voided: Starfall.DrawStatus.voided, drawn: Starfall.DrawStatus.drawn };
    expect(windDownStatus(view([{ id: 1n, status: settled }, { id: 2n, status: voided }]))).toMatch(/^Wound down: .* Safe to switch/);
    expect(windDownStatus(view([{ id: 1n, status: settled }, { id: 2n, status: drawn }]))).toBe(
      'Winding down: no new draws will open. Still in progress: draw 2.',
    );
    expect(windDownStatus(view([{ id: 1n, status: settled }], false))).toMatch(/in progress: payments or refunds/);
    expect(windDownStatus(view([{ id: 1n, status: voided, unrefunded: [0n] }]))).toMatch(/in progress: payments or refunds/);
  });
});

describe('buyGames', () => {
  const store = { setContractAddress() {}, async set() {} };
  // 40 tickets: 13 a purchase, so 13, 13, 13, then 1.
  const M = Number(Starfall.pureCircuits.maxTickets());
  const games = Array.from({ length: 40 }, () => Starfall.makeTicket(1n, quickPick(), OPERATOR));
  const calls = (buy: () => Promise<unknown>) => ({ callTx: { buyTickets: buy } }) as unknown as StarfallCalls;

  it("stops with what it bought when a purchase hangs, instead of waiting for ever", async () => {
    let n = 0;
    const hangs = calls(() => (++n === 2 ? new Promise(() => {}) : Promise.resolve()));
    const err = await buyGames(hangs, store, 'addr', games, OPERATOR, { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuyStopped);
    expect((err as BuyStopped).bought).toBe(M);
    expect((err as BuyStopped).of).toBe(40);
    expect((err as BuyStopped).message).toMatch(/didn't land/);
  });

  it('stops before sales close, and passes a failed purchase on with the count', async () => {
    const ok = calls(() => Promise.resolve());
    const late = await buyGames(ok, store, 'addr', games, OPERATOR, { stopAt: Date.now() / 1000 - 1 }).catch((e: unknown) => e);
    expect((late as BuyStopped).bought).toBe(0);
    expect((late as BuyStopped).message).toMatch(/sales close/);
    let n = 0;
    const fails = calls(() => (++n === 3 ? Promise.reject(new Error('sales have closed')) : Promise.resolve()));
    const err = await buyGames(fails, store, 'addr', games, OPERATOR).catch((e: unknown) => e);
    expect((err as BuyStopped).bought).toBe(2 * M);
    expect((err as BuyStopped).message).toBe('sales have closed');
    expect(await buyGames(ok, store, 'addr', games, OPERATOR)).toBe(Math.ceil(40 / M));
  });

  it("counts a purchase the wallet lost track of if the chain has it, and not if it doesn't", async () => {
    let n = 0;
    const hangs = calls(() => (++n === 2 ? new Promise(() => {}) : Promise.resolve()));
    const went = await buyGames(hangs, store, 'addr', games, OPERATOR, { timeoutMs: 50, onChain: async (p) => p.map(() => true) }).catch((e: unknown) => e);
    expect((went as BuyStopped).bought).toBe(2 * M);
    expect((went as BuyStopped).message).toMatch(/did go in/);
    n = 0;
    const lost = await buyGames(hangs, store, 'addr', games, OPERATOR, { timeoutMs: 50, onChain: async (p) => p.map(() => false) }).catch((e: unknown) => e);
    expect((lost as BuyStopped).bought).toBe(M);
    expect((lost as BuyStopped).message).toMatch(/didn't go in/);
    // one that didn't land gives the wallet its coins back; one that did, doesn't
    let reverts = 0;
    n = 0;
    await buyGames(hangs, store, 'addr', games, OPERATOR, { timeoutMs: 50, onChain: async (p) => p.map(() => false), onNotLanded: async () => void reverts++ }).catch(() => undefined);
    expect(reverts).toBe(1);
    n = 0;
    await buyGames(hangs, store, 'addr', games, OPERATOR, { timeoutMs: 50, onChain: async (p) => p.map(() => true), onNotLanded: async () => void reverts++ }).catch(() => undefined);
    expect(reverts).toBe(1);
    n = 0;
    const unknown = await buyGames(hangs, store, 'addr', games, OPERATOR, {
      timeoutMs: 50,
      onChain: async () => {
        throw new Error('indexer down');
      },
    }).catch((e: unknown) => e);
    expect((unknown as BuyStopped).bought).toBe(M);
    expect((unknown as BuyStopped).message).toMatch(/couldn't be checked/);
  });

  it("reverts the wallet's pending transactions, so the DUST a lost purchase held comes back", async () => {
    const reverted: unknown[] = [];
    const facade = {
      state: () => ({
        subscribe: (next: (s: { pending: { all: { tx: unknown }[] } }) => void) => {
          next({ pending: { all: [{ tx: 'tx-a' }, { tx: 'tx-b' }] } });
          return { unsubscribe: () => undefined };
        },
      }),
      revert: async (tx: unknown) => {
        if (tx === 'tx-b') throw new Error('already gone');
        reverted.push(tx);
      },
    };
    const said: string[] = [];
    await pendingReverter(facade, (m) => said.push(m))();
    expect(reverted).toEqual(['tx-a']);
    expect(said[0]).toMatch(/coins of 1 transaction/);
    // nothing pending: nothing to say
    await pendingReverter({ ...facade, state: () => ({ subscribe: (next: (s: object) => void) => (next({}), { unsubscribe: () => undefined }) }) }, (m) => said.push(m))();
    expect(said).toHaveLength(1);
  });

  it('finds bought games on the chain by their ticket commitments', async () => {
    const { sim } = setup();
    sim.openDraw(BigInt(sim.now + 3_600), new Uint8Array(32).fill(1));
    const me = webcrypto.getRandomValues(new Uint8Array(32));
    const bought = [Starfall.makeTicket(1n, quickPick(), me), Starfall.makeTicket(1n, quickPick(), me)];
    const notBought = Starfall.makeTicket(1n, quickPick(), me);
    sim.buyTickets(bought, me);
    const publicData = { queryContractState: async () => ({ data: sim.publicState() }) } as unknown as Parameters<typeof onChainCheck>[0];
    expect(await onChainCheck(publicData, sim.address)([...bought, notBought])).toEqual([true, true, false]);
  });
});

describe('buy: what to buy', () => {
  it('QuickPick games and packages, optionally PowerHit-style', () => {
    expect(buyEntries({})).toHaveLength(1);
    expect(buyEntries({ package: 'mini' })).toHaveLength(8);
    const hits = buyEntries({ games: '3', sweep: true });
    expect(hits.map((e) => Starfall.gamesOf(e))).toEqual([20, 20, 20]);
    expect(() => buyEntries({ package: 'huge' })).toThrow(/--package must be one of/);
    expect(() => buyEntries({ games: '0' })).toThrow(/1 to 1000/);
  });

  it('one chosen or random System or Pick, with or without Moonball Sweep', () => {
    const [system] = buyEntries({ system: '9' });
    expect(system.numbers).toHaveLength(9);
    expect(Starfall.gamesOf(system)).toBe(36);
    const [pick] = buyEntries({ pick: '5', sweep: true });
    expect(Starfall.gamesOf(pick)).toBe(8_700);
    expect(describeEntry(pick)).toMatch(/^Pick 5 \+ Moonball Sweep: .* \+ every Moonball \(8700 games\)$/);
    const [chosen] = buyEntries({ numbers: '35 3 9 14 21 27 33', moonball: '7' });
    expect(describeEntry(chosen)).toBe('standard: 3 9 14 21 27 33 35 + 7 (1 game)');
    const [system8] = buyEntries({ numbers: '1,2,3,4,5,6,7,8', moonball: '2' });
    expect(Starfall.entryName(system8)).toBe('System 8');
    const [pick6] = buyEntries({ pick: '6', numbers: '4 8 15 16 23 34', moonball: '1' });
    expect(Starfall.gamesOf(pick6)).toBe(29);
  });

  it('packs QuickPicks 12 to a ticket, lists each game, and knows which games a stopped purchase bought', () => {
    const me = new Uint8Array(32).fill(7);
    const entries = buyEntries({ package: 'maxi' });
    const tickets = Starfall.ticketsFor(1n, entries, me);
    expect(tickets.map(Starfall.ticketGames)).toEqual([12, 12, 12, 12, 2]);
    const listing = describeTickets(tickets).split('\n');
    expect(listing).toHaveLength(50);
    expect(listing[0]).toMatch(/^  ticket 1, game 1: standard: .* \(1 game\)$/);
    expect(listing[49]).toMatch(/^  ticket 5, game 2: standard: /);
    expect(describeTickets(Starfall.ticketsFor(1n, buyEntries({ system: '9' }), me))).toMatch(/^  ticket 1: System 9: /);
    // Stopped after 2 of 5 tickets: 24 of the 50 games are in.
    const done = entriesBought(tickets, 2);
    expect(done).toHaveLength(24);
    const key = (e: { numbers: number[]; moonball?: number }) => [...e.numbers].sort((a, b) => a - b).join(' ') + '/' + e.moonball;
    expect(done.map(key)).toEqual(entries.slice(0, 24).map(key));
  });

  it('refuses what the contract would', () => {
    expect(() => buyEntries({ system: '13' })).toThrow(/--system takes 8 to 12/);
    expect(() => buyEntries({ pick: '4' })).toThrow(/--pick takes 5 or 6/);
    expect(() => buyEntries({ system: '9', numbers: '1 2 3 4 5 6 7 8' })).toThrow(/needs 9 numbers/);
    expect(() => buyEntries({ system: '8', pick: '6' })).toThrow(/not both/);
    expect(() => buyEntries({ games: '2', system: '8' })).toThrow(/not both/);
    expect(() => buyEntries({ sweep: true, moonball: '3' })).toThrow(/leave out --moonball/);
    expect(() => buyEntries({ numbers: '1 2 3 4 5 6 36', moonball: '1' })).toThrow(/1\.\.35/);
    expect(() => buyEntries({ numbers: '1 2 3 4 5 6', moonball: '1' })).toThrow(/7 numbers/);
  });
});
