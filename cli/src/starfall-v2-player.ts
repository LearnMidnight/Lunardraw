/**
 * A Starfall v2 player for the rehearsal: a program with its own wallet that plays every v2 draw,
 * so settlement, prizes and syndicates run on chain before the real deployment.
 *
 * In each draw on sale it
 *   - buys one ticket of `games` QuickPick games in the draw's format (7 from its range, a Moonball
 *     from 1 to its Moonballs) for itself;
 *   - runs a syndicate: creates one of `members.length` shares for `syndicateGames` games, takes one
 *     share for each member (paid to the member's address: the house agents', so a syndicate's prize
 *     and refunds reach separate wallets), and buys the syndicate's games. In every other draw it
 *     buys one game fewer than the syndicate was funded for, so the unspent game is refunded to the
 *     members after sales close.
 *
 * One step a pass (`nextStep`, pure, so it can be tested without a chain), each kept in a state
 * file once it has landed, so a restart carries on where it was and never pays twice.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, webcrypto } from 'node:crypto';
import type { StarfallView } from '@lunardraw/keeper';

/* eslint-disable @typescript-eslint/no-explicit-any -- the generated v2 module is loaded at run time */
type Module = any;

export type PlayerOptions = {
  /** QuickPick games in the player's own ticket each draw (1 to 12). */
  games: number;
  /** The syndicate's members' addresses (32 bytes each), one share each; none: no syndicate. */
  members: Uint8Array[];
  /** Games the syndicate is funded for (default 2). */
  syndicateGames: number;
  /** Don't start anything when sales close within this many seconds (default 1200). */
  marginSecs?: number;
};

export type DrawState = {
  /** The player's own ticket landed. */
  bought?: boolean;
  /** The syndicate this player created for the draw, and how far it got. */
  syndicate?: { id: string; joined: number; bought: boolean };
};

export type PlayerState = {
  contract: string;
  /** The secret behind this player's syndicates' creator commitment (hex; test money only). */
  syndicateSecret: string;
  draws: Record<string, DrawState>;
};

export const newPlayerState = (contract: string): PlayerState => ({ contract, syndicateSecret: randomBytes(32).toString('hex'), draws: {} });

/** The player's state for `contract`; a state for another deployment is moved aside. */
export const loadPlayerState = (path: string, contract: string): PlayerState => {
  if (!existsSync(path)) return newPlayerState(contract);
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as PlayerState;
    if (s.contract?.toLowerCase() === contract.toLowerCase() && s.syndicateSecret) return { ...s, draws: s.draws ?? {} };
    renameSync(path, `${path}.${(s.contract ?? 'earlier').slice(0, 16)}.json`);
  } catch {
    // unreadable: start again
  }
  return newPlayerState(contract);
};

export const savePlayerState = (path: string, s: PlayerState): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

export type Step =
  | { kind: 'buy'; draw: bigint; games: number }
  | { kind: 'create'; draw: bigint; shares: number; games: number; sharePrice: bigint; joinDeadline: bigint }
  | { kind: 'join'; draw: bigint; syndicate: bigint; member: number }
  | { kind: 'buySyndicate'; draw: bigint; syndicate: bigint; games: number };

/**
 * What to do next for the draw on sale, or null. The syndicate comes first (its members must join
 * before its join deadline, ten minutes before sales close), then the player's own ticket.
 */
export const nextStep = (view: StarfallView, nowSecs: number, s: PlayerState, o: PlayerOptions): Step | null => {
  const now = BigInt(Math.floor(nowSecs));
  const d = view.draws.find((x) => x.status === 0 && !x.final && x.salesClose > now + BigInt(o.marginSecs ?? 1200));
  if (!d) return null;
  const ds = s.draws[d.id.toString()] ?? {};
  const shares = o.members.length;
  if (shares > 0) {
    const sy = ds.syndicate;
    if (!sy) {
      // shares x share price = games x ticket price
      const total = view.ticketPrice * BigInt(o.syndicateGames);
      if (total % BigInt(shares) !== 0n) throw new Error(`${o.syndicateGames} game(s) don't split into ${shares} equal shares`);
      return { kind: 'create', draw: d.id, shares, games: o.syndicateGames, sharePrice: total / BigInt(shares), joinDeadline: d.salesClose - 600n };
    }
    if (sy.joined < shares) return { kind: 'join', draw: d.id, syndicate: BigInt(sy.id), member: sy.joined };
    // In every other draw one game fewer than funded: the unspent game is refunded after the close.
    if (!sy.bought) return { kind: 'buySyndicate', draw: d.id, syndicate: BigInt(sy.id), games: d.id % 2n === 0n ? o.syndicateGames : Math.max(1, o.syndicateGames - 1) };
  }
  if (!ds.bought) return { kind: 'buy', draw: d.id, games: o.games };
  return null;
};

/** Record a step that landed. */
export const stepDone = (s: PlayerState, step: Step, syndicateId?: bigint): void => {
  const key = step.draw.toString();
  const ds = (s.draws[key] ??= {});
  if (step.kind === 'buy') ds.bought = true;
  if (step.kind === 'create') ds.syndicate = { id: String(syndicateId), joined: 0, bought: false };
  if (step.kind === 'join' && ds.syndicate) ds.syndicate.joined = step.member + 1;
  if (step.kind === 'buySyndicate' && ds.syndicate) ds.syndicate.bought = true;
};

// ------------------------------------------------------------------ tickets

const rand = (n: number): number => {
  const r = new Uint32Array(1);
  const lim = Math.floor(4_294_967_296 / n) * n;
  do webcrypto.getRandomValues(r);
  while (r[0]! >= lim);
  return r[0]! % n;
};

/** A QuickPick game in a format: 7 different numbers from 1 to `range`, sorted, and a Moonball (1 if the format has none). */
export const quickPickIn = (format: { range: number; moonballs: number }, pick: (n: number) => number = rand): { numbers: number[]; moonball: number } => {
  const set = new Set<number>();
  while (set.size < 7) set.add(pick(format.range) + 1);
  return { numbers: [...set].sort((a, b) => a - b), moonball: format.moonballs > 1 ? pick(format.moonballs) + 1 : 1 };
};

const le = (b: Uint8Array): bigint => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
};
const NO_LINE = { numbers: Array(7).fill(0n), moonball: 0n };
const NO_PAYEE = { lo: 0n, hi: 0n, share: 0n };
const salt = (): bigint => BigInt('0x' + randomBytes(31).toString('hex'));

/** A payee paid all of a ticket's prizes: the 32-byte address in two little-endian halves. */
export const payeeOf = (address: Uint8Array) => ({ lo: le(address.subarray(0, 16)), hi: le(address.subarray(16, 32)), share: 10000n });

/**
 * One v2 ticket holding `games` standard games (1 to 12: its entry and up to 11 lines), paid to
 * `payees` (a wallet's payee, or a syndicate's from the contract's syndicatePayees).
 */
export const ticketOf = (drawId: bigint, games: { numbers: number[]; moonball: number }[], payees: unknown[]) => {
  if (games.length < 1 || games.length > 12) throw new Error('a ticket holds 1 to 12 games');
  const [first, ...rest] = games as [{ numbers: number[]; moonball: number }, ...{ numbers: number[]; moonball: number }[]];
  return {
    drawId,
    entry: { kind: 0n, count: 7n, numbers: [...first.numbers, 0, 0, 0, 0, 0].map(BigInt), moonball: BigInt(first.moonball), sweep: false },
    lines: [...rest.map((g) => ({ numbers: g.numbers.map(BigInt), moonball: BigInt(g.moonball) })), ...Array(11 - rest.length).fill(NO_LINE)],
    payees,
    salt: salt(),
  };
};

/** An unused ticket slot (a purchase's other slots: buyTickets takes maxTickets() preimages). */
export const emptyV2Ticket = (drawId: bigint) => ({
  drawId,
  entry: { kind: 0n, count: 0n, numbers: Array(12).fill(0n), moonball: 0n, sweep: false },
  lines: Array(11).fill(NO_LINE),
  payees: [NO_PAYEE, NO_PAYEE, NO_PAYEE],
  salt: 0n,
});

/** What a step's purchase is, in tickets (one each here), from the draw's format. */
export const ticketsFor = (G: Module, step: Step, format: { range: number; moonballs: number }, me: Uint8Array) => {
  if (step.kind === 'buy') return [ticketOf(step.draw, Array.from({ length: step.games }, () => quickPickIn(format)), [payeeOf(me), NO_PAYEE, NO_PAYEE])];
  if (step.kind === 'buySyndicate') return [ticketOf(step.draw, Array.from({ length: step.games }, () => quickPickIn(format)), G.pureCircuits.syndicatePayees(step.syndicate))];
  return [];
};

export const describeStep = (s: Step): string => {
  switch (s.kind) {
    case 'buy':
      return `buy ${s.games} QuickPick game(s) in draw ${s.draw}`;
    case 'create':
      return `create a syndicate in draw ${s.draw}: ${s.shares} share(s) of ${Number(s.sharePrice) / 1e6} tNIGHT for ${s.games} game(s)`;
    case 'join':
      return `take share ${s.member + 1} of syndicate ${s.syndicate} (draw ${s.draw})`;
    case 'buySyndicate':
      return `buy syndicate ${s.syndicate}'s ${s.games} game(s) in draw ${s.draw}`;
  }
};
