/**
 * The MCP server's tools. The wallet is opened once, when the server starts,
 * and kept open while it runs (opening takes a few minutes; a purchase 2-3).
 */
import { loadAgentState } from '../starfall-agent.js';
import { ensureWallet, hasBlockfrost, kitHome, kitPaths, limitsWhere, loadConfig, tNight, useHome } from './home.js';
import { readStarfallRecord } from '../starfall.js';
import { gameOf, hasKitV2, kitV2StatePath, ledgerFormat, loadKitV2State, openSyndicatesOf, readKitV2Record, ticketsReportV2, v2ChoiceOf } from './player-v2.js';
import { readOverviewV2, readV2 } from './v2-chain.js';
import { deploymentWatch, outdatedText } from './freshness.js';
import { type Tool } from './mcp.js';
import { toolDef } from './tool-defs.js';
import { refreshListing } from './directory.js';
import { walletAddressOf } from '@nightcast/deploy';
import { type OpenHooks, type Player, readOverview, ticketsReport, withPlayer } from './player.js';
import { FAUCET, syncFraction } from './setup.js';
import { setLive, setOnBlockfrost, settingsLink, settingsServing } from './settings.js';

const DIVISIONS = ['7 + Moonball', '7', '6 + Moonball', '6', '5 + Moonball', '4 + Moonball', '5', '3 + Moonball', '2 + Moonball'];

/**
 * `answerMs`: how long a slow tool (buying, opening the wallet) waits before
 * answering "on its way" (AI apps give up on a tool call after about a minute);
 * Infinity waits until it's done (the library).
 */
export const mcpTools = (o: { answerMs?: number } = {}): Tool[] => {
  const config = loadConfig();
  useHome(config);
  /** The config as it is now: the owner may change the limits while the agent runs. */
  const current = () => {
    try {
      return loadConfig();
    } catch {
      return config;
    }
  };
  // whether the game packed in this kit is still Starfall's (freshness.ts)
  const fresh = deploymentWatch(() => (hasKitV2(config.network) ? readKitV2Record(config.network) : readStarfallRecord(config.network)).contractAddress, config.network);
  /** The kit plays an old Starfall contract: the answer to give instead of buying (or undefined: go ahead). */
  const outdatedAnswer = async () => {
    const f = await fresh();
    return f.state === 'outdated' ? { text: JSON.stringify({ status: 'not bought: this agent plays an old Starfall contract', note: outdatedText(f) }, null, 2), isError: true } : undefined;
  };
  /** The price of a game and its split, from the packed deployment record. */
  const priceText = (): string => {
    try {
      const p = (readStarfallRecord(config.network) as unknown as { parameters?: { ticketPrice?: string; feePerGame?: string } }).parameters ?? {};
      const price = BigInt(p.ticketPrice ?? '0');
      const fee = BigInt(p.feePerGame ?? '0');
      if (price > 0n) return `${tNight(price)} a game (${tNight(price - fee)} to the prize pool, ${tNight(fee)} operator fee)`;
    } catch {
      /* no record: say it without the number */
    }
    return 'about 1 tNIGHT a game (lunardraw_draw_on_sale gives the exact price)';
  };
  /** Starfall (v2): the price of a game and its split, from the chain once read (the kit's record has no price). */
  const priceTextV2 = (): string => '1.3 tNIGHT a game (1 tNIGHT to the prize pool, 0.2 operator fee, 0.1 to the Treasury that tops up jackpots); lunardraw_draw_on_sale gives the exact price';
  const hasV2 = hasKitV2(config.network);
  const ready = () => {
    if (!hasBlockfrost(kitHome(), config.network)) {
      throw new Error(
        'The agent has no Blockfrost project id yet (a free key that lets it read Midnight Preprod). The owner gets one at https://blockfrost.io ' +
          '(Add project, network "Midnight Preprod", copy the Project ID) and puts it in the Lunardraw extension\'s settings in Claude ' +
          '(Settings, Extensions, Lunardraw, Configure), or runs `lunardraw-agent setup` in a terminal.',
      );
    }
  };

  // How far the wallet is from ready, for answers while it opens (a new wallet's first sync takes hours)
  type Stage = { phase: 'opening' | 'syncing' | 'waiting for tNIGHT' | 'waiting for DUST' | 'ready'; synced?: number };
  let stage: Stage = { phase: 'opening' };
  const hooks: OpenHooks = {
    onWallet: (w) => {
      stage = { phase: 'syncing', synced: 0 };
      const sub = w.wallet.state().subscribe((s: unknown) => {
        if (stage.phase === 'syncing') stage = { phase: 'syncing', synced: syncFraction(s) };
      });
      void player?.finally(() => sub.unsubscribe()).catch(() => undefined);
    },
    onNoFunds: () => (stage = { phase: 'waiting for tNIGHT', synced: 1 }),
    onWaitingForDust: () => (stage = { phase: 'waiting for DUST', synced: 1 }),
  };
  /** What to tell the owner while the wallet isn't ready. */
  const notReady = (): Record<string, unknown> => {
    const address = walletAddressOf(config.network, ensureWallet().seed);
    const faucet = FAUCET[config.network];
    switch (stage.phase) {
      case 'syncing': {
        const pct = Math.floor((stage.synced ?? 0) * 100);
        return {
          address,
          status: `syncing with Midnight Preprod: ${pct}%`,
          note:
            pct < 95
              ? `A new wallet's first sync reads the whole Preprod chain and takes a few hours (it saves its progress; later starts take minutes). Nothing to do but wait and keep this app open. Meanwhile the owner can fund it: paste the address into ${faucet} and ask for tNIGHT (free test tokens).`
              : 'Catching up with the chain: a minute or two.',
        };
      }
      case 'waiting for tNIGHT':
        return { address, status: 'synced, waiting for tNIGHT', note: `The wallet holds no tNIGHT yet. The owner pastes the address into the faucet, ${faucet}, ticks the captcha and asks for tNIGHT (free, no value). The agent notices it arriving by itself.` };
      case 'waiting for DUST':
        return { address, status: 'got tNIGHT, waiting for DUST', note: 'It registered its tNIGHT for DUST, the token that pays the fees; the first DUST usually comes within a few minutes. Then it can buy.' };
      default:
        return { address, status: 'opening', note: 'The wallet is opening (a few minutes the first time in a session). Ask again in a minute.' };
    }
  };
  /** Not worth starting a purchase: the wallet is hours away, or has nothing to pay with. */
  const farFromReady = () => stage.phase === 'waiting for tNIGHT' || stage.phase === 'waiting for DUST' || (stage.phase === 'syncing' && (stage.synced ?? 0) < 0.95);

  // one wallet for the server's life, opened when first needed
  let player: Promise<Player> | undefined;
  let release: () => void = () => undefined;
  const openPlayer = (progress: (m: string) => void): Promise<Player> => {
    ready();
    if (!player) {
      progress('opening the wallet (a few minutes)');
      player = new Promise<Player>((resolve, reject) => {
        withPlayer(
          config,
          ensureWallet().seed,
          (p) => {
            stage = { phase: 'ready', synced: 1 };
            resolve(p);
            return new Promise<void>((done) => (release = done));
          },
          undefined,
          hooks,
        ).catch((err) => {
          stage = { phase: 'opening' };
          player = undefined;
          reject(err);
        });
      });
    }
    return player;
  };
  process.once('exit', () => release());
  // Start opening the wallet as soon as the server starts (an AI app starts it when
  // the app opens), so the first purchase doesn't wait 5 minutes for it on top of
  // the purchase itself; many agents give up on a tool call long before that.
  // LUNARDRAW_AGENT_LAZY=1 waits for the first call instead.
  if (process.env.LUNARDRAW_AGENT_LAZY !== '1' && hasBlockfrost(kitHome(), config.network)) {
    setTimeout(() => void openPlayer(() => undefined).catch(() => undefined), 0).unref?.();
  }

  // If the owner listed the agent in lunardraw.io's directory, keep it up to date
  // (and shown as online) while the server runs, and after each purchase.
  // (read afresh each time: the owner may list it, rename it or take it out on the settings page)
  const listingTick = async () => {
    const c = current();
    if (!c.listing || !hasBlockfrost(kitHome(), c.network)) return;
    const view = (await readOverview(c).catch(() => undefined))?.view;
    await refreshListing(c, ensureWallet().seed, { view, log: (m) => process.stderr.write(m + '\n') });
  };
  if (config.listing) setTimeout(() => void listingTick(), 5_000).unref?.();
  setInterval(() => void listingTick(), 30 * 60_000).unref?.();

  // A purchase takes 2-3 minutes, but many AI apps give up on a tool call after
  // about a minute (Claude reaching a computer's tools: 60 s, seen 5 Nov 2026).
  // So the buy tool answers within ANSWER_MS and, if the purchase isn't done
  // by then, carries on in the background; my_tickets says how it's going.
  const answerMs = o.answerMs ?? Number(process.env.LUNARDRAW_AGENT_ANSWER_MS ?? 45_000);
  // (setTimeout can't wait forever: a longer wait than about 24 days fires at once)
  const lateAfter = <T>(late: T) => new Promise<T>((r) => (Number.isFinite(answerMs) && answerMs < 2 ** 31 ? setTimeout(() => r(late), answerMs).unref?.() : undefined));
  type Purchase = { started: string; games: number; state: 'buying' | 'done' | 'failed'; outcome?: unknown; error?: string };
  let purchase: Purchase | undefined;

  // keep the client informed during long calls
  const ticking = async <T>(progress: (m: string) => void, what: string, work: Promise<T>): Promise<T> => {
    const t = setInterval(() => progress(`${what}…`), 15_000);
    try {
      return await work;
    } finally {
      clearInterval(t);
    }
  };

  /** A slow call (a purchase, joining a syndicate): answers within ANSWER_MS, or "on its way" and finishes by itself. */
  const slow = async (games: number, progress: (m: string) => void, run: (tell: (m: string) => void) => Promise<{ bought?: number; of?: number } & object>) => {
    if (purchase?.state === 'buying') {
      return {
        text: JSON.stringify({ status: 'a purchase is already on its way', started: purchase.started, games: purchase.games, next: "Don't buy again yet: call lunardraw_my_tickets in a minute or two to see it land." }, null, 2),
      };
    }
    const mine: Purchase = { started: new Date().toISOString(), games, state: 'buying' };
    purchase = mine;
    let answered = false;
    const tell = (m: string) => {
      if (!answered) progress(m);
    };
    const work = run(tell);
    const ok = (o: { bought?: number }) => o.bought === undefined || o.bought > 0;
    work.then(
      (outcome) => {
        Object.assign(mine, { state: ok(outcome) ? 'done' : 'failed', outcome });
        if (ok(outcome)) void listingTick();
      },
      (err: unknown) => Object.assign(mine, { state: 'failed', error: err instanceof Error ? err.message : String(err) }),
    );
    const late = Symbol('late');
    const first = await Promise.race([work, lateAfter(late)]);
    answered = true;
    if (first === late) {
      return {
        text: JSON.stringify(
          {
            status: 'buying',
            games,
            note: "The purchase is on its way and finishes by itself (2-3 minutes in all). Don't buy again: call lunardraw_my_tickets in about 3 minutes to see the numbers.",
          },
          null,
          2,
        ),
      };
    }
    return { text: JSON.stringify(first, null, 2), isError: first.bought !== undefined && first.of !== undefined && first.bought < first.of };
  };
  // a Blockfrost key saved on the settings page: start opening (and syncing) the wallet straight away
  setOnBlockfrost(() => {
    if (process.env.LUNARDRAW_AGENT_LAZY !== '1') void openPlayer(() => undefined).catch(() => undefined);
  });
  // the settings page shows how the wallet is doing (settings.ts)
  setLive(async () => {
    if (stage.phase !== 'ready' || !player) return { phase: stage.phase, synced: stage.synced };
    const { night, dust } = await (await player).balances();
    return { phase: 'ready', synced: 1, tNight: Number(night) / 1e6, dust: Number(dust) / 1e15 };
  });

  /** Not ready to buy: the answer to give instead (or undefined: go ahead). */
  const notReadyAnswer = () => (farFromReady() ? { text: JSON.stringify({ status: 'not ready to buy yet: nothing was bought', ...notReady() }, null, 2), isError: true } : undefined);
  const v2Player = (tell: (m: string) => void) => ticking(tell, 'opening the wallet', openPlayer(tell)).then((p) => p.v2());
  /** Classic, while it still has a draw to sell or results to give: its overview, or undefined once it has ended. */
  const classicOverview = async () => {
    const { overview } = await readOverview(config);
    return overview.ended ? undefined : overview;
  };

  return [
    {
      ...toolDef('lunardraw_setup'),
      run: async () => {
        const c = current();
        const home = kitHome();
        const address = walletAddressOf(c.network, ensureWallet().seed);
        const key = hasBlockfrost(home, c.network);
        const syncing = key && stage.phase === 'syncing' ? Math.floor((stage.synced ?? 0) * 100) : undefined;
        const port = settingsServing.port;
        const steps = [
          `1. Blockfrost key: ${key ? 'done' : 'missing (the owner pastes it on the settings page: free at blockfrost.io, a "Midnight Preprod" project)'}`,
          `2. Test tNIGHT: the wallet's address is ${address}; free tNIGHT from ${FAUCET[c.network]}`,
          `3. The wallet: ${!key ? 'starts syncing once the key is saved' : stage.phase === 'ready' ? 'synced and ready to play' : syncing !== undefined ? `first sync ${syncing}% (a few hours the first time; keep this app open)` : stage.phase}`,
          `4. On lunardraw.io: ${c.listing ? `shown as ${c.listing.name} (https://lunardraw.io/agents/)` : 'not shown (the owner can turn it on and pick a name on the settings page)'}`,
          `5. Spending limits: ${c.limits.perDraw} tNIGHT a draw, ${c.limits.perDay} tNIGHT in any 24 hours`,
        ];
        const link = port ? settingsLink(port) : undefined;
        return {
          text: [
            'Starfall agent setup',
            ...steps,
            '',
            link
              ? `The owner's settings page (open it on the computer this agent runs on; the link works for 2 hours): ${link}\nThere they paste the Blockfrost key, copy the address for the faucet, watch the sync, choose the agent's name on lunardraw.io and set the spending limits. Give them this link as it is; you can't change these settings yourself.`
              : "The settings page isn't available from this app right now: the owner can run `lunardraw-agent settings` in a terminal on the computer the agent runs on.",
          ].join('\n'),
        };
      },
    },
    {
      ...toolDef('lunardraw_how_to_play'),
      run: async () => ({
        text: [
          "Starfall: Lunardraw's lottery on the Midnight Preprod test network (tNIGHT test tokens, no real value). A draw every day at 20:00 Brisbane time (10:00 UTC).",
          ...(hasV2
            ? [
                'A game: 7 numbers in the draw\'s format, which grows with sales: from 7 of 1-20 with no Moonball up to 7 of 1-45 with a Moonball from 1-20. lunardraw_draw_on_sale gives the draw on sale\'s format.',
                `${priceTextV2()}. The jackpot is fixed before a draw sells (Division 1 pays what was carried in); each draw's sales build the next jackpot.`,
                'Prize divisions: 1: 7 (+ Moonball); 2: 7; 3: 6 + Moonball; 4: 6; 5: 5 + Moonball; 6: 4 + Moonball; 7: 5; 8: 3 + Moonball; 9: 2 + Moonball. In a draw with no Moonball, 7, 6, 5 and 4 right win Divisions 1, 3, 5 and 6.',
                'Entries: QuickPick games, your own 7 numbers, a System (8-12 numbers, every 7 of them), a Pick (5 or 6 numbers completed every way), and Moonball Sweep (every Moonball, in a draw that has one).',
                'Syndicates: groups that buy many games together; each member gets a share of any prize by their shares. lunardraw_syndicates lists the open ones, lunardraw_join_syndicate buys shares. One that isn\'t filled by its deadline refunds its members.',
                'Starfall Classic (the first Starfall, 7 of 1-35 + a Moonball of 1-20) ended with its final draw on 27 Nov 2026 and can no longer be bought; lunardraw_my_tickets still shows what this agent played and won in it.',
              ]
            : [`A game: 7 numbers from 1-35 and a Moonball from 1-20. ${priceText()}.`, 'Entries: QuickPick games or packages, your own numbers, a System (8-12 numbers), a Pick (5 or 6 numbers), and Moonball Sweep.']),
          'Numbers come from Nightcast verifiable randomness; anyone can check every draw.',
          'Prizes and refunds (if a draw is cancelled) are paid to the wallet automatically. Nothing to claim.',
          `Spending limits set by the owner, across both games: ${current().limits.perDraw} tNIGHT a draw, ${current().limits.perDay} tNIGHT in any 24 hours. They can't be changed from here; the owner sets them ${limitsWhere()}.`,
        ].join('\n'),
      }),
    },
    {
      ...toolDef('lunardraw_draw_on_sale'),
      run: async () => {
        ready();
        const [v2, classic, f] = await Promise.all([
          hasV2 ? readOverviewV2(config).then((r) => r.overview) : Promise.resolve(undefined),
          classicOverview().catch(() => undefined),
          fresh(),
        ]);
        const notice = f.state === 'outdated' ? { notice: outdatedText(f) } : {};
        const body = v2
          ? { ...v2, game: "Starfall, Lunardraw's lottery on the Midnight Preprod test network", ...notice, ...(classic ? { classic: { note: 'Starfall Classic, no longer sold: its final draw is being drawn and paid', ...classic } } : {}) }
          : { game: "Starfall, Lunardraw's lottery on the Midnight Preprod test network", ...notice, ...(classic ?? (await readOverview(config)).overview) };
        return { text: JSON.stringify(body, null, 2) };
      },
    },
    {
      ...toolDef('lunardraw_wallet'),
      run: async (_a, progress) => {
        // answer within ANSWER_MS too: opening the wallet can take minutes, and AI apps give up long before
        const opening = openPlayer(progress);
        const late = Symbol('late');
        const first = await ticking(progress, 'opening the wallet', Promise.race([opening, lateAfter(late)]));
        if (first === late) return { text: JSON.stringify({ ...notReady(), limits: current().limits }, null, 2) };
        const p = first;
        const { night, dust } = await p.balances();
        return { text: JSON.stringify({ address: p.address, tNight: Number(night) / 1e6, dust: (Number(dust) / 1e15).toFixed(2), limits: current().limits }, null, 2) };
      },
    },
    {
      ...toolDef('lunardraw_buy_tickets'),
      run: async (args, progress) => {
        gameOf(args, hasV2); // Starfall; "classic" is refused by name (it ended on 27 Nov 2026)
        const choice = v2ChoiceOf(args);
        ready();
        const old = await outdatedAnswer();
        if (old) return old;
        const wait = notReadyAnswer();
        if (wait) return wait;
        return slow(choice.numbers ? 1 : (choice.games ?? 1), progress, (tell) => v2Player(tell).then((v) => ticking(tell, 'buying', v.buy(choice, tell))));
      },
    },
    {
      ...toolDef('lunardraw_my_tickets'),
      run: async () => {
        ready();
        const state = loadAgentState(kitPaths(kitHome(), config.network).state);
        const view = state.purchases.length ? (await readOverview(config)).view : undefined;
        const classic = ticketsReport(state, view, Date.now());
        let starfall: unknown;
        if (hasV2) {
          const record = readKitV2Record(config.network);
          const s = loadKitV2State(kitV2StatePath(kitHome()), record.contractAddress);
          const r = s.purchases.length || s.syndicates.length ? await readV2(config.network) : undefined;
          starfall = ticketsReportV2(
            r?.k.v2.G,
            s,
            r?.view,
            (d) => ledgerFormat(r?.l, d),
            (id) => (r?.l.syndicates.member(id) ? r.l.syndicates.lookup(id) : undefined),
            Date.now(),
          );
        }
        // a purchase still on its way (or how the last one ended), so nobody buys twice
        const latest = purchase && {
          purchase: {
            state: purchase.state,
            started: purchase.started,
            games: purchase.games,
            ...(purchase.error ? { error: purchase.error } : {}),
            ...(purchase.outcome ? { outcome: purchase.outcome } : {}),
            ...(purchase.state === 'buying' ? { note: 'still on its way: check again in a minute' } : {}),
          },
        };
        const body = starfall ? { ...latest, starfall, classic } : { ...latest, ...classic };
        return { text: JSON.stringify(body, null, 2) };
      },
    },
    {
      ...toolDef('lunardraw_syndicates'),
      run: async () => {
        ready();
        if (!hasV2) return { text: JSON.stringify({ syndicates: [], note: 'This kit carries no Starfall game for this network: update it (npm install -g @lunardraw/agent).' }, null, 2) };
        const { overview, l } = await readOverviewV2(config);
        const draw = overview.onSale ? BigInt(overview.onSale.draw) : undefined;
        const syndicates = openSyndicatesOf(l, draw, Date.now() / 1000);
        return {
          text: JSON.stringify(
            {
              draw: overview.onSale?.draw ?? null,
              syndicates,
              note: syndicates.length
                ? 'Join one with lunardraw_join_syndicate (its number and how many shares). Prizes are shared by shares and paid to each member automatically.'
                : overview.onSale
                  ? 'No syndicate is taking members in this draw right now (lunardraw.io lists them too).'
                  : 'No draw is on sale right now.',
            },
            null,
            2,
          ),
        };
      },
    },
    {
      ...toolDef('lunardraw_join_syndicate'),
      run: async (args, progress) => {
        if (!hasV2) return { text: 'This kit carries no Starfall game for this network: update it (npm install -g @lunardraw/agent).', isError: true };
        const syndicate = Number(args.syndicate);
        const shares = args.shares === undefined ? 1 : Number(args.shares);
        if (!Number.isInteger(syndicate) || syndicate < 0) throw new Error('syndicate: its number, from lunardraw_syndicates');
        if (!Number.isInteger(shares) || shares < 1) throw new Error('shares: 1 or more');
        ready();
        const old = await outdatedAnswer();
        if (old) return old;
        const wait = notReadyAnswer();
        if (wait) return wait;
        return slow(0, progress, (tell) => v2Player(tell).then((v) => ticking(tell, 'joining', v.join(syndicate, shares, tell))));
      },
    },
  ];
};
