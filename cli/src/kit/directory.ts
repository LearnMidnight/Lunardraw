/**
 * Listing the agent in lunardraw.io's agent directory, if its owner opted in
 * (`lunardraw-agent list`). Reports are signed with the agent wallet's key and
 * carry its name, style and totals, never its numbers. See ../listing.ts.
 */
import { Starfall } from '@lunardraw/contract';
import type { StarfallView } from '@lunardraw/keeper';
import { agentReport, type DrawOutcome, signedListing, type Via, VIAS, walletSigner } from '../listing.js';
import { loadAgentState } from '../starfall-agent.js';
import { readStarfallRecord } from '../starfall.js';
import { DEFAULT_REGISTRY, type KitConfig, kitPaths } from './home.js';

const { DrawStatus } = Starfall;

/** The chain view's draws as outcomes (numbers and prizes). */
export const outcomesOf = (view: StarfallView): DrawOutcome[] =>
  view.draws.map((d) => ({
    num: Number(d.id),
    status: d.status === DrawStatus.voided ? 'void' : d.status === DrawStatus.settled ? 'settled' : d.status === DrawStatus.drawn ? 'drawn' : 'open',
    ...(d.status === DrawStatus.drawn || d.status === DrawStatus.settled ? { numbers: d.numbers, moonball: d.moonball } : {}),
    ...(d.status === DrawStatus.settled ? { prizes_star: d.prizes.map(Number) } : {}),
  }));

/** Which AI an owner names (--via), checked. */
export const viaOf = (v: string | undefined): Via => {
  const via = (v ?? 'other').toLowerCase();
  if (!(VIAS as readonly string[]).includes(via)) throw new Error(`--via must be one of ${VIAS.join(', ')}`);
  return via as Via;
};

/**
 * Send a listing report (or remove the listing). `view` gives the draws'
 * outcomes for the totals; without it, the totals count purchases only.
 */
export const sendListing = async (
  config: KitConfig,
  seed: string,
  action: 'list' | 'unlist',
  o: { home?: string; view?: StarfallView; listing?: KitConfig['listing']; fetcher?: typeof fetch } = {},
): Promise<string> => {
  const listing = o.listing ?? config.listing;
  if (!listing) throw new Error('this agent isn\'t listed: run `lunardraw-agent list --name <name>` first');
  const state = loadAgentState(kitPaths(o.home, config.network).state, readStarfallRecord(config.network).contractAddress);
  const report = agentReport(state, o.view ? outcomesOf(o.view) : [], Date.now());
  const signer = await walletSigner(seed, config.network);
  const contract = readStarfallRecord(config.network).contractAddress;
  const body = signedListing(signer, { network: config.network, action, name: listing.name, style: listing.style, via: viaOf(listing.via), contract, ...report });
  const url = `${(config.registry ?? DEFAULT_REGISTRY).replace(/\/$/, '')}/report`;
  const r = await (o.fetcher ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const answer = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: string; error?: string };
  if (!r.ok || !answer.ok) throw new Error(`the directory refused it: ${answer.error ?? `HTTP ${r.status}`}`);
  return answer.result ?? 'ok';
};

/** Best effort, for after a purchase or now and then: a failed report never stops play. */
export const refreshListing = async (config: KitConfig, seed: string, o: { home?: string; view?: StarfallView; log?: (m: string) => void } = {}): Promise<void> => {
  if (!config.listing) return;
  try {
    await sendListing(config, seed, 'list', o);
  } catch (err) {
    o.log?.(`(couldn't update the directory listing: ${err instanceof Error ? err.message : String(err)})`);
  }
};
