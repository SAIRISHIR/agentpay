const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { bus, publish } = require('./events');
const registry = require('./registry');
const ledger = require('./ledger');
const paypal = require('./paypal');
const buyer = require('./buyer');
const market = require('./market');
const settlement = require('./settlement');
const webhooks = require('./webhooks');
const persist = require('./persist');
const policy = require('./policy');
const { SKILLS } = require('./skills');
const sellers = require('./sellers');
const x402 = require('../sdk/x402');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.static(path.join(__dirname, '..', 'public')));

sellers.registerSellers(app, registry);

const snapshot = persist.load();
if (snapshot) {
  sellers.restoreCustomSellers(registry, snapshot.customSellers);
  registry.restore(snapshot.registry);
  if (Array.isArray(snapshot.ledger)) ledger.restoreAll(snapshot.ledger);
  else if (snapshot.ledger) ledger.restoreAll([{ ...snapshot.ledger, id: 'default' }]);
  buyer.restore(snapshot.buyer);
}
bus.on('evt', () => persist.schedule(() => ({
  ledger: ledger.dumpAll(), registry: registry.dump(), buyer: buyer.dump(), customSellers: sellers.dumpCustomSellers(),
})));

const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  const status = e.status >= 400 && e.status < 600 ? e.status : 500;
  res.status(status).json({ error: e.message, issue: e.issue || null, debugId: e.debugId || null });
});

const centsFrom = (v, min, max) => {
  const cents = Math.round(Number(v) * 100);
  if (!Number.isFinite(cents) || cents < min || cents > max) throw httpError(400, `Amount must be between $${(min / 100).toFixed(2)} and $${(max / 100).toFixed(2)}`);
  return cents;
};

const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const bearer = req => (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

// Agent and seller APIs need the API key. Without one configured, only local callers are allowed.
function requireApiKey(req) {
  if (!config.API_KEY) {
    if (!isLoopback(req)) throw httpError(403, 'Remote agent access is disabled. Set AGENTPAY_API_KEY on the server');
    return;
  }
  const got = Buffer.from(bearer(req));
  const want = Buffer.from(config.API_KEY);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw httpError(401, 'Missing or invalid API key');
}

/* ---------- Wallet per visitor ---------- */

const COOKIE = 'ap_wallet';
const readCookie = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

// Shared mode: one owner wallet. Per-visitor mode: an httpOnly cookie gives each browser a private wallet.
// API-key callers (MCP server, SDKs) always use the owner's default wallet.
function resolveWallet(req, res) {
  if (config.WALLET_MODE === 'shared' || bearer(req)) return ledger.wallet('default');
  let id = readCookie(req);
  if (!/^w_[a-f0-9]{16}$/.test(id || '')) {
    id = `w_${crypto.randomBytes(8).toString('hex')}`;
    res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}${req.secure ? '; Secure' : ''}`);
  }
  return ledger.wallet(id);
}

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/internal') || req.path.startsWith('/x402') || req.path.startsWith('/webhooks')) return next();
  req.wallet = resolveWallet(req, res);
  req.wallet.touch();
  return next();
});

/* ---------- Dashboard data ---------- */

app.get('/api/config', (req, res) => res.json({
  paypalClientId: config.PAYPAL_CLIENT_ID,
  paypalConfigured: paypal.configured(),
  network: x402.network(),
  demoFunding: config.DEMO_FUNDING,
  walletMode: config.WALLET_MODE,
  model: config.MODEL,
  webhooks: webhooks.enabled(),
  apiKeyRequired: !!config.API_KEY,
  agents: buyer.agents(),
  skills: Object.entries(SKILLS).map(([id, s]) => ({ id, name: s.name, group: s.group })),
  feeFixedCents: config.FEE_FIXED_CENTS,
}));

app.get('/api/state', (req, res) => {
  const w = req.wallet;
  res.json({
    walletId: w.id,
    balances: w.balances(),
    mandate: w.mandate,
    policy: w.policy,
    autoTopUp: w.publicAutoTopUp(),
    escrows: [...w.escrows.values()].slice(-500),
    services: registry.list(),
    sellerDirectory: registry.listSellers(),
    fundings: w.fundings,
    settlements: w.settlements,
    runs: buyer.runs(w.id),
    logs: buyer.logs(w.id),
    webhooks: webhooks.log(w.id),
    pendingApprovals: ledger.pendingApprovals(w.id),
  });
});

app.get('/api/events', (req, res) => {
  const walletId = req.wallet.id;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = evt => { if (!evt.walletId || evt.walletId === walletId) res.write(`data: ${JSON.stringify(evt)}\n\n`); };
  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  bus.on('evt', send);
  req.on('close', () => { clearInterval(beat); bus.off('evt', send); });
});

/* ---------- Open protocol: discovery and x402 facilitator ---------- */

app.get('/.well-known/agentpay.json', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  res.json({
    name: 'AgentPay',
    description: 'PayPal-settled payment rail for AI agents',
    protocol: { transport: 'x402 v2 headers', scheme: x402.SCHEME, network: x402.network(), headers: x402.HEADERS },
    facilitator: { verify: `${origin}/api/x402/verify` },
    buyerApi: { services: `${origin}/api/services`, wallet: `${origin}/api/wallet`, purchase: `${origin}/api/purchase`, auth: 'Authorization: Bearer <AGENTPAY_API_KEY>' },
    sellerApi: { register: `${origin}/api/sellers/register`, skills: Object.keys(SKILLS) },
    services: registry.list().map(s => ({ id: s.id, name: s.name, seller: s.sellerName, priceCents: s.priceCents, passRate: s.passRate, status: s.status, endpoint: /^https?:/.test(s.endpoint) ? s.endpoint : `${origin}${s.endpoint}` })),
  });
});

app.post('/api/x402/verify', (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body || {};
  res.json(market.verifyPayment(paymentPayload, paymentRequirements));
});

/* ---------- Agent chains (sellers hiring sellers), loopback only ---------- */

app.get('/api/internal/services', (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: 'internal' });
  res.json(registry.list().filter(s => !req.query.skill || s.skill === req.query.skill));
});

app.post('/api/internal/subcontract', wrap(async (req, res) => {
  if (!isLoopback(req)) throw httpError(403, 'internal');
  const { parentEscrowId, serviceId, text, reason } = req.body || {};
  const parent = ledger.findEscrow(parentEscrowId);
  if (!parent || parent.escrow.status !== 'locked') throw httpError(409, 'Subcontracting needs a live parent payment');
  res.json(await market.purchase({
    wallet: parent.wallet, serviceId, text, reason,
    runId: parent.escrow.runId, channel: parent.escrow.sellerId, parentEscrowId,
  }));
}));

/* ---------- Buyer API for outside agents (MCP server, SDKs) ---------- */

app.get('/api/services', (req, res) => res.json(registry.list(String(req.query.q || ''))));

app.get('/api/wallet', (req, res) => {
  const w = req.wallet;
  const b = w.balances();
  const m = w.mandate;
  res.json({
    walletId: w.id,
    availableUsd: b.availableCents / 100, spentTodayUsd: b.todayCommittedCents / 100,
    dailyCapUsd: m.dailyCapCents / 100, perCallMaxUsd: m.perCallMaxCents / 100,
    approvalThresholdUsd: m.approvalThresholdCents / 100, maxPerMinute: m.maxPerMinute,
    rules: w.policy?.summary || [],
  });
});

const idempotent = new Map();
app.post('/api/purchase', wrap(async (req, res) => {
  requireApiKey(req);
  const { service_id: serviceId, text, reason } = req.body || {};
  const key = req.get('Idempotency-Key');
  if (key && idempotent.has(key)) return res.json(await idempotent.get(key));
  const work = market.purchase({ wallet: req.wallet, serviceId, text, reason, channel: 'api' });
  if (key) {
    idempotent.set(key, work);
    setTimeout(() => idempotent.delete(key), 24 * 3600 * 1000).unref();
  }
  res.json(await work);
}));

/* ---------- Seller API ---------- */

app.post('/api/sellers/register', wrap(async (req, res) => {
  requireApiKey(req);
  const { seller, services } = req.body || {};
  const id = String(seller?.id || '').toLowerCase();
  if (!/^[a-z0-9-]{3,32}$/.test(id)) throw httpError(400, 'seller.id must be 3-32 lowercase letters, digits or dashes');
  if (sellers.SELLERS.some(s => s.id === id) || id.startsWith('c-')) throw httpError(409, 'That seller id is reserved');
  if (!seller.name || !/^[^@\s]+@[^@\s]+$/.test(seller.email || '')) throw httpError(400, 'seller.name and a PayPal seller.email are required');
  if (!Array.isArray(services) || !services.length || services.length > 20) throw httpError(400, 'services must be a list of 1-20 entries');

  const rows = services.map(s => {
    if (!SKILLS[s.skill]) throw httpError(400, `Unknown skill "${s.skill}". Use one of: ${Object.keys(SKILLS).join(', ')}`);
    const priceCents = centsFrom(s.price_usd, 1, 100);
    let url;
    try { url = new URL(s.endpoint); } catch { throw httpError(400, `Invalid endpoint for ${s.skill}`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'Endpoints must be http or https');
    return { id: `${id}.${s.skill}`, skill: s.skill, name: SKILLS[s.skill].name, group: SKILLS[s.skill].group, description: SKILLS[s.skill].description, sellerId: id, sellerName: String(seller.name).slice(0, 60), sellerEmail: seller.email, priceCents, endpoint: url.toString() };
  });

  registry.registerSeller({ id, name: rows[0].sellerName, email: seller.email, external: true, category: 'External seller' });
  rows.forEach(r => registry.register(r));
  rows.forEach(r => publish('service', registry.view(registry.get(r.id))));
  publish('sellers', registry.listSellers());
  res.status(201).json({ seller: id, services: rows.map(r => r.id), facilitator: `${req.protocol}://${req.get('host')}` });
}));

// One-click listing from the dashboard: AgentPay hosts the endpoint (Claude-powered) behind the same paywall.
const quickRegisterLog = [];
app.post('/api/sellers/quick-register', wrap(async (req, res) => {
  const since = Date.now() - 3600 * 1000;
  while (quickRegisterLog.length && quickRegisterLog[0] < since) quickRegisterLog.shift();
  if (quickRegisterLog.length >= 30) throw httpError(429, 'Too many new sellers this hour. Try again later');
  const { name, email, skill, price_usd: price, tagline } = req.body || {};
  const cleanName = String(name || '').replace(/[^\p{L}\p{N} .&'-]/gu, '').trim().slice(0, 40);
  if (cleanName.length < 2) throw httpError(400, 'Give your seller a name (2-40 characters)');
  if (!SKILLS[skill]) throw httpError(400, 'Pick a skill to sell');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'That PayPal email does not look right');
  const priceCents = centsFrom(price, 1, 10);
  if (registry.listSellers().some(s => s.name.toLowerCase() === cleanName.toLowerCase())) throw httpError(409, 'A seller with that name already exists');
  quickRegisterLog.push(Date.now());
  const seller = sellers.createCustomSeller(registry, {
    name: cleanName, email: email ? String(email).slice(0, 120) : '', skill, priceCents,
    tagline: String(tagline || '').slice(0, 90) || `${SKILLS[skill].name} by a community seller`,
  }, config.MAX_CUSTOM_SELLERS);
  publish('sellers', registry.listSellers());
  for (const s of registry.list()) if (s.sellerId === seller.id) publish('service', s);
  res.status(201).json({ seller: seller.id, service: `${seller.id}.${skill}` });
}));

app.post('/api/sellers/:id/reinstate', wrap(async (req, res) => {
  if (!registry.reinstate(req.params.id)) throw httpError(404, 'Unknown seller');
  res.json({ ok: true });
}));

/* ---------- Owner controls ---------- */

app.get('/api/escrow/:id', (req, res) => {
  const e = req.wallet.getEscrow(req.params.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  res.json({ id: e.id, status: e.status, serviceId: e.serviceId, priceCents: e.priceCents });
});

app.put('/api/mandate', wrap((req, res) => {
  const { perCallMax, dailyCap, approvalThreshold, maxPerMinute } = req.body || {};
  if ([perCallMax, dailyCap, approvalThreshold, maxPerMinute].some(v => v === '' || v == null || !Number.isFinite(Number(v)) || Number(v) <= 0)) {
    throw httpError(400, 'All limits must be positive numbers');
  }
  res.json(req.wallet.setMandate({ perCallMax, dailyCap, approvalThreshold, maxPerMinute }));
}));

app.post('/api/policy', wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (text.length < 5) throw httpError(400, 'Write at least one rule');
  let compiled;
  try { compiled = await policy.compile(text); } catch (e) { throw httpError(502, `Could not read those rules (${e.message}). Try rephrasing`); }
  if (!compiled.rules.length) throw httpError(422, `None of that could be turned into a rule${compiled.unsupported.length ? `: ${compiled.unsupported.join('; ')}` : ''}. Try e.g. "never use BudgetBot"`);
  res.json(req.wallet.setPolicy(compiled));
}));

app.delete('/api/policy', (req, res) => res.json({ policy: req.wallet.setPolicy(null) }));

app.post('/api/escrows/:id/dispute', wrap(async (req, res) => {
  const e = await market.dispute(req.wallet, req.params.id, req.body?.complaint);
  res.json({ status: e.status, dispute: e.dispute });
}));

const vaultRequests = new Map(); // orderId -> { walletId, cents }

app.post('/api/funding/orders', wrap(async (req, res) => {
  if (!paypal.configured()) throw httpError(503, 'PayPal credentials are not configured on the server');
  const cents = centsFrom(req.body?.amount, 100, 2000);
  const vault = req.body?.autoTopUp === true;
  const order = await paypal.createWalletOrder(cents, req.wallet.id, { vault, returnUrl: `${req.protocol}://${req.get('host')}/` });
  if (vault) vaultRequests.set(order.id, { walletId: req.wallet.id, cents });
  res.json({ id: order.id, status: order.status });
}));

app.post('/api/funding/orders/:id/capture', wrap(async (req, res) => {
  const w = req.wallet;
  const c = await paypal.captureOrder(req.params.id);
  if (c.captureStatus !== 'COMPLETED' && c.captureStatus !== 'PENDING') throw httpError(422, `Capture status is ${c.captureStatus || c.status}`);
  const funding = w.addFunding({ source: 'paypal', orderId: c.orderId, captureId: c.captureId, cents: c.cents, status: c.captureStatus, payer: c.payer });
  w.addSettlement({ kind: 'capture', source: 'paypal', paypalId: c.captureId, cents: c.cents, status: c.captureStatus, detail: `Wallet top-up, order ${c.orderId}` });
  const wanted = vaultRequests.get(c.orderId);
  vaultRequests.delete(c.orderId);
  let autoTopUp = null;
  if (wanted && wanted.walletId === w.id) {
    if (c.vaultId) {
      w.setAutoTopUp({ vaultId: c.vaultId, customerId: c.customerId, payer: c.payer, amountCents: wanted.cents, enabled: true, charges: [] });
      autoTopUp = { enabled: true };
    } else {
      autoTopUp = { enabled: false, error: 'PayPal did not save the account. Enable "Save payment methods" (Vault) for this app in the PayPal developer dashboard' };
    }
  }
  res.json({ funding, autoTopUp, balances: w.balances() });
}));

app.delete('/api/funding/auto-topup', wrap(async (req, res) => {
  const a = req.wallet.autoTopUp;
  if (a?.vaultId) await paypal.deleteVaultToken(a.vaultId).catch(() => {});
  req.wallet.setAutoTopUp(null);
  res.json({ ok: true });
}));

app.post('/api/funding/simulated', wrap(async (req, res) => {
  if (!config.DEMO_FUNDING) throw httpError(403, 'Demo credit is disabled on this server');
  const cents = centsFrom(req.body?.amount, 100, 500);
  const simulatedTotal = req.wallet.fundings.filter(f => f.source === 'simulated').reduce((a, f) => a + f.cents, 0);
  if (simulatedTotal + cents > 1000) throw httpError(429, 'Demo credit is limited to $10 per visitor');
  const funding = req.wallet.addFunding({ source: 'simulated', orderId: null, captureId: null, cents, status: 'SIMULATED', payer: null });
  res.json({ funding, balances: req.wallet.balances() });
}));

app.post('/api/settle', wrap(async (req, res) => {
  try {
    res.json(await settlement.settle(req.wallet));
  } catch (e) {
    throw Object.assign(e, { status: e.status || 409 });
  }
}));

app.post('/api/approvals/:id', wrap(async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== 'approve' && decision !== 'reject') throw httpError(400, 'decision must be "approve" or "reject"');
  if (!req.wallet.getEscrow(req.params.id) || !ledger.decide(req.params.id, decision === 'approve')) throw httpError(404, 'Nothing is waiting for approval with that id');
  res.json({ ok: true });
}));

app.post('/api/agent/run', wrap(async (req, res) => {
  const run = buyer.start({ wallet: req.wallet, agentId: req.body?.agentId, goal: req.body?.goal, documents: req.body?.documents });
  res.status(202).json({ id: run.id, status: run.status });
}));

app.post('/api/webhooks/paypal', wrap(async (req, res) => {
  const r = await webhooks.handle(req.headers, req.rawBody || '');
  res.status(r.status).json(r.body);
}));

app.listen(config.PORT, () => {
  console.log(`\nAgentPay running at http://localhost:${config.PORT}`);
  console.log(`PayPal: ${paypal.configured() ? config.PAYPAL_BASE : 'NOT CONFIGURED'} | Model: ${config.MODEL} | Demo credit: ${config.DEMO_FUNDING ? 'on' : 'off'} | Wallets: ${config.WALLET_MODE}`);
  console.log(`Services: ${registry.list().length} | Webhooks: ${webhooks.enabled() ? 'on' : 'off'} | Remote agents: ${config.API_KEY ? 'API key' : 'localhost only'} | State: ${config.PERSIST ? persist.FILE : 'memory'}`);
  if (snapshot) console.log(`Restored ${ledger.allWallets().length} wallet(s) from ${persist.FILE}`);
  console.log('');
});
