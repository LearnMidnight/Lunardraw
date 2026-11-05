/**
 * The MCP tools' names, descriptions and inputs, on their own (no wallet, no
 * chain): what tools.ts runs, and what Lunardraw's relay lists for a player's
 * agent while it's away (relay.ts).
 */
import { BUY_SCHEMA, type Tool } from './mcp.js';

export type ToolDef = Omit<Tool, 'run'>;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'lunardraw_how_to_play',
    title: 'How Starfall works',
    description: 'How Starfall (Lunardraw\'s lottery) works: the rules, prices, prize divisions, odds and this agent\'s spending limits.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'lunardraw_draw_on_sale',
    title: 'Draw on sale',
    description: "What's on in Starfall (Lunardraw's lottery) right now: the draw on sale (number, closing time, tickets sold, jackpot estimate), the game price, and the last few results. Use it for any question about Starfall's current draw or results. Reads the chain; no wallet needed.",
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
      'Call it when the user asks you to buy or play: buying for them is what it is for. Give games or package for QuickPick, ' +
      'or numbers (with moonball, system or pick) for a chosen entry; sweep plays every Moonball. Refused if it would pass the ' +
      "owner's spending limits. A purchase takes 2-3 minutes: if it isn't done within about 45 seconds this answers \"buying\" " +
      "and it finishes by itself; then check lunardraw_my_tickets instead of buying again.",
    inputSchema: BUY_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'lunardraw_my_tickets',
    title: "The agent's tickets",
    description: 'Every Starfall ticket this agent bought, with each draw\'s result and prize once it\'s out, what it spent in the last 24 hours, and a purchase still on its way. Use it for "did I win?" and to check a purchase landed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

export const toolDef = (name: string): ToolDef => {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
};
