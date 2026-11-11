#!/usr/bin/env node
// AgentPay MCP server: lets any MCP client (Claude Desktop, Cursor, ...) buy AI services
// through AgentPay, paid from the owner's PayPal-funded wallet and bound by their mandate.
//
//   AGENTPAY_URL=http://localhost:3000 AGENTPAY_API_KEY=... node mcp/agentpay-mcp.mjs

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const BASE = (process.env.AGENTPAY_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.AGENTPAY_API_KEY || '';

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `AgentPay returned HTTP ${res.status}`);
  return data;
}

const text = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: e.message }] });

const server = new McpServer({ name: 'agentpay', version: '2.0.0' });

server.registerTool('agentpay_check_budget', {
  title: 'Check AgentPay budget',
  description: 'Wallet balance and the owner\'s spending mandate (per-call max, daily cap, approval threshold).',
  inputSchema: {},
}, async () => {
  try { return text(await api('GET', '/api/wallet')); } catch (e) { return fail(e); }
});

server.registerTool('agentpay_search_services', {
  title: 'Search AgentPay marketplace',
  description: 'Find AI services sold by other agents. Returns price, verified pass rate and status for each service.',
  inputSchema: { query: z.string().optional().describe('Skill or keyword, e.g. "translate". Empty lists all.') },
}, async ({ query }) => {
  try {
    const list = await api('GET', `/api/services?q=${encodeURIComponent(query || '')}`);
    return text(list.map(s => ({
      service_id: s.id, service: s.name, seller: s.sellerName, price_usd: s.priceCents / 100,
      verified_pass_rate: s.passRate == null ? 'new' : `${Math.round(s.passRate * 100)}%`, status: s.status, contract: s.description,
    })));
  } catch (e) { return fail(e); }
});

server.registerTool('agentpay_buy_service', {
  title: 'Buy an AI service',
  description: 'Pay for one call through AgentPay: 402 quote, mandate check, escrow, owner approval if needed, AI verification. Failed work is refunded automatically.',
  inputSchema: {
    service_id: z.string().describe('From agentpay_search_services'),
    text: z.string().max(6000).describe('Input for the seller'),
    reason: z.string().max(300).describe('One sentence on why you are buying this'),
  },
}, async ({ service_id, text: input, reason }) => {
  try {
    return text(await api('POST', '/api/purchase', { service_id, text: input, reason }, { 'Idempotency-Key': randomUUID() }));
  } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
