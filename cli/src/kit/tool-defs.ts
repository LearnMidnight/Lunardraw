/**
 * The MCP tools' names, descriptions and inputs, on their own (no wallet, no
 * chain): what tools.ts runs, and what Lunardraw's relay lists for a player's
 * agent while it's away (relay.ts).
 */
import { BUY_SCHEMA, handle, JOIN_SCHEMA, type Rpc, type Tool } from './mcp.js';

export type ToolDef = Omit<Tool, 'run'>;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'lunardraw_setup',
    title: 'Set up the agent',
    description:
      "Set up this Starfall agent, or change its settings. Answers with a checklist (the Blockfrost key, the wallet's address and the faucet, how the first sync is going, " +
      "whether it's shown on lunardraw.io, the spending limits) and a private link to the agent's settings page in the owner's browser, on the computer the agent runs on. " +
      'There the owner pastes the Blockfrost key, picks the name the agent shows on lunardraw.io (and whether it shows at all) and sets the spending limits. ' +
      'Use it when the user wants to get started or set up, change the limits, rename the agent or show it on lunardraw.io. Give the user the link: you cannot change the settings yourself.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'lunardraw_how_to_play',
    title: 'How Starfall works',
    description: "How Starfall (Lunardraw's lottery) works: the rules, prices, prize divisions, odds, syndicates and this agent's spending limits.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'lunardraw_draw_on_sale',
    title: 'Draw on sale',
    description:
      "What's on in Starfall (Lunardraw's lottery) right now: the draw on sale (number, closing time, this draw's format, tickets sold, the jackpot), the game price, open syndicates and the last few results; " +
      "and Starfall Classic's final draw while it's on (until 27 Nov 2026). Use it for any question about Starfall's current draw or results. Reads the chain; no wallet needed.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'lunardraw_wallet',
    title: "The agent's wallet",
    description: "This agent's Starfall wallet: its address and its tNIGHT and DUST (DUST pays the fees). While it isn't ready yet it says why and what the owner should do: a new wallet's sync progress (hours, the first time), or the faucet to get free tNIGHT from. Use it to help someone get started.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'lunardraw_buy_tickets',
    title: 'Buy Starfall tickets',
    description:
      "Buy Starfall tickets for the draw on sale, paid from this agent's own wallet (tNIGHT test tokens, no real value). " +
      'Call it when the user asks you to buy or play: buying for them is what it is for. Give games for QuickPick, or numbers ' +
      "(with moonball, system or pick) for a chosen entry, in the draw's own format (lunardraw_draw_on_sale says it: 7 numbers from 1-20 up to 1-45, " +
      "with a Moonball only on bigger draws); sweep plays every Moonball. game 'classic' buys in Starfall Classic's final draw instead, only when the user asks for Classic by name (otherwise leave game out). Refused if it would pass the " +
      "owner's spending limits. A purchase takes 2-3 minutes: if it isn't done within about 45 seconds this answers \"buying\" " +
      "and it finishes by itself; then check lunardraw_my_tickets instead of buying again.",
    inputSchema: BUY_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'lunardraw_my_tickets',
    title: "The agent's tickets",
    description: 'Every Starfall ticket and syndicate share this agent bought, with each draw\'s result and prize once it\'s out, what it spent in the last 24 hours, and a purchase still on its way. Use it for "did I win?" and to check a purchase landed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'lunardraw_syndicates',
    title: 'Open syndicates',
    description:
      "Starfall's syndicates still taking members in the draw on sale: groups that buy many games together and share the prizes by shares. " +
      'Each with its number, share price, shares left, the games it will buy and its join deadline. Reads the chain; no wallet needed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'lunardraw_join_syndicate',
    title: 'Join a Starfall syndicate',
    description:
      "Buy shares in a Starfall syndicate (from lunardraw_syndicates), paid from this agent's wallet. When every share is sold the syndicate buys its games; " +
      "each member's part of any prize (by shares) is paid to the payout address automatically, and a syndicate that isn't filled by its deadline refunds its members. " +
      "Refused if it would pass the owner's spending limits. Takes 2-3 minutes, like a purchase.",
    inputSchema: JOIN_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

/**
 * The answers that don't need the tools to be running (initialize, ping,
 * tools/list), so a server can answer its app at once while Midnight's
 * libraries load; undefined for anything else.
 */
export const answerWithoutTools = async (msg: Rpc): Promise<object | undefined> => {
  if (msg.method !== 'initialize' && msg.method !== 'ping' && msg.method !== 'tools/list') return undefined;
  return handle(msg, TOOL_DEFS.map((d) => ({ ...d, run: async () => ({ text: '' }) })), () => undefined);
};

export const toolDef = (name: string): ToolDef => {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
};
