const crypto = require('crypto');
const { publish } = require('./events');
const { DEFAULT_MANDATE, FEE_FIXED_CENTS, MAX_WALLETS } = require('./config');

const toCents = usd => Math.round(Number(usd) * 100);
const usd = cents => `$${(cents / 100).toFixed(2)}`;
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();
const newId = prefix => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

const ACTIVE = new Set(['held', 'awaiting_approval', 'locked', 'delivered', 'verifying', 'disputed']);

const defaultMandate = () => ({
  perCallMaxCents: toCents(DEFAULT_MANDATE.perCallMax),
  dailyCapCents: toCents(DEFAULT_MANDATE.dailyCap),
  approvalThresholdCents: toCents(DEFAULT_MANDATE.approvalThreshold),
  maxPerMinute: Math.round(DEFAULT_MANDATE.maxPerMinute),
});

const wallets = new Map();
const escrowIndex = new Map(); // escrowId -> walletId
const approvals = new Map();   // escrowId -> { resolve, timer }

class Wallet {
  constructor(id) {
    this.id = id;
    this.createdAt = now();
    this.lastSeen = now();
    this.mandate = defaultMandate();
    this.policy = null;     // { text, rules, summary, unsupported, compiledAt }
    this.autoTopUp = null;  // { vaultId, customerId, payer, amountCents, enabled, charges: [{at, cents}] }
    this.fundings = [];     // { id, source, orderId, captureId, cents, refundedCents, status, payer, at }
    this.escrows = new Map();
    this.settlements = [];  // { id, kind, source, paypalId, cents, status, detail, at }
    this.paidOutCents = {}; // sellerId -> cents
  }

  emit(type, data) { publish(type, data, this.id); }
  touch() { this.lastSeen = now(); }

  balances() {
    let fundedCents = 0, refundedOutCents = 0;
    for (const f of this.fundings) { fundedCents += f.cents; refundedOutCents += f.refundedCents; }
    let heldCents = 0, spentCents = 0, judgeRefundedCents = 0, todayCommittedCents = 0;
    let released = 0, refunded = 0, blocked = 0, disputed = 0;
    for (const e of this.escrows.values()) {
      if (ACTIVE.has(e.status)) heldCents += e.priceCents;
      if (e.status === 'released') { spentCents += e.priceCents; released++; }
      if (e.status === 'refunded') { judgeRefundedCents += e.priceCents; refunded++; }
      if (e.status === 'blocked' || e.status === 'rejected') blocked++;
      if (e.dispute) disputed++;
      if ((ACTIVE.has(e.status) || e.status === 'released') && e.day === today()) todayCommittedCents += e.priceCents;
    }
    const paidOut = Object.values(this.paidOutCents).reduce((a, b) => a + b, 0);
    const paypalTransactions = this.settlements.filter(s => s.source === 'paypal' && !['failed', 'REGION_BLOCKED'].includes(s.status)).length;
    const agentPayments = released + refunded;
    return {
      fundedCents, refundedOutCents, heldCents, spentCents, judgeRefundedCents, todayCommittedCents,
      availableCents: fundedCents - refundedOutCents - heldCents - spentCents,
      owedToSellersCents: spentCents - paidOut,
      counts: { total: this.escrows.size, released, refunded, blocked, disputed },
      agentPayments,
      paypalTransactions,
      feesAvoidedCents: Math.max(0, agentPayments - paypalTransactions) * FEE_FIXED_CENTS,
      feeFixedCents: FEE_FIXED_CENTS,
    };
  }

  purchasesLastMinute() {
    const since = Date.now() - 60000;
    let n = 0;
    for (const e of this.escrows.values()) if (e.status !== 'blocked' && Date.parse(e.createdAt) >= since) n++;
    return n;
  }

  // code tells callers what failed: 'funds' can be cured by an auto top-up, the rest cannot.
  policyCheck(cents) {
    const b = this.balances();
    const m = this.mandate;
    if (cents > m.perCallMaxCents) return { ok: false, code: 'per_call', reason: `Price ${usd(cents)} is above the per-purchase limit of ${usd(m.perCallMaxCents)}` };
    if (b.todayCommittedCents + cents > m.dailyCapCents) return { ok: false, code: 'daily', reason: `Would exceed today's budget: ${usd(b.todayCommittedCents)} of ${usd(m.dailyCapCents)} already committed` };
    if (this.purchasesLastMinute() >= m.maxPerMinute) return { ok: false, code: 'velocity', reason: `Velocity limit: ${m.maxPerMinute} purchases per minute reached. Slow down and retry` };
    if (cents > b.availableCents) return { ok: false, code: 'funds', reason: `Wallet has ${usd(b.availableCents)} available. Add funds with PayPal to continue` };
    return { ok: true };
  }

  pushBalances() { this.emit('balances', this.balances()); }

  createEscrow(fields, status, note) {
    const e = { id: newId('esc'), walletId: this.id, createdAt: now(), day: today(), timeline: [], output: null, verdict: null, latencyMs: null, settled: false, dispute: null, ...fields, status };
    e.timeline.push({ status, at: e.createdAt, note: note || null });
    this.escrows.set(e.id, e);
    escrowIndex.set(e.id, this.id);
    this.emit('escrow', e);
    this.pushBalances();
    return e;
  }

  setStatus(id, status, patch = {}, note) {
    const e = this.escrows.get(id);
    Object.assign(e, patch, { status });
    e.timeline.push({ status, at: now(), note: note || null });
    this.emit('escrow', e);
    this.pushBalances();
    return e;
  }

  getEscrow(id) { return this.escrows.get(id) || null; }

  addFunding(f) {
    const funding = { id: newId('fund'), refundedCents: 0, at: now(), ...f };
    this.fundings.push(funding);
    this.emit('funding', funding);
    this.pushBalances();
    return funding;
  }

  addSettlement(s) {
    const rec = { id: newId('stl'), at: now(), ...s };
    this.settlements.push(rec);
    this.emit('settlement', rec);
    this.pushBalances();
    return rec;
  }

  updateSettlement(id, patch) {
    const rec = this.settlements.find(s => s.id === id);
    if (!rec) return null;
    Object.assign(rec, patch, { updatedAt: now() });
    this.emit('settlement', rec);
    this.pushBalances();
    return rec;
  }

  setMandate({ perCallMax, dailyCap, approvalThreshold, maxPerMinute }) {
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, toCents(v)));
    this.mandate = {
      perCallMaxCents: clamp(perCallMax, 1, 1000),
      dailyCapCents: clamp(dailyCap, 1, 10000),
      approvalThresholdCents: clamp(approvalThreshold, 1, 1000),
      maxPerMinute: Math.min(600, Math.max(1, Math.round(Number(maxPerMinute) || this.mandate.maxPerMinute))),
    };
    this.emit('mandate', this.mandate);
    this.pushBalances();
    return this.mandate;
  }

  setPolicy(policy) {
    this.policy = policy;
    this.emit('policy', policy);
    return policy;
  }

  setAutoTopUp(cfg) {
    this.autoTopUp = cfg;
    this.emit('autotopup', cfg && { ...cfg, vaultId: undefined, customerId: undefined, vaultHint: cfg.vaultId ? `…${String(cfg.vaultId).slice(-4)}` : null });
    return cfg;
  }

  sellerEarnings() {
    const by = {};
    for (const e of this.escrows.values()) {
      if (e.status !== 'released') continue;
      by[e.sellerId] = by[e.sellerId] || { sellerId: e.sellerId, sellerName: e.sellerName, sellerEmail: e.sellerEmail, earnedCents: 0, calls: 0 };
      by[e.sellerId].earnedCents += e.priceCents;
      by[e.sellerId].calls += 1;
    }
    return Object.values(by).map(s => ({ ...s, paidOutCents: this.paidOutCents[s.sellerId] || 0, owedCents: s.earnedCents - (this.paidOutCents[s.sellerId] || 0) }));
  }

  publicAutoTopUp() {
    const a = this.autoTopUp;
    if (!a) return null;
    return { enabled: a.enabled, amountCents: a.amountCents, payer: a.payer, vaultHint: `…${String(a.vaultId).slice(-4)}`, chargesToday: a.charges.filter(c => c.at.startsWith(today())).length };
  }

  dump() {
    return {
      id: this.id, createdAt: this.createdAt, lastSeen: this.lastSeen, mandate: this.mandate, policy: this.policy, autoTopUp: this.autoTopUp,
      fundings: this.fundings, escrows: [...this.escrows.values()], settlements: this.settlements, paidOutCents: this.paidOutCents,
    };
  }

  // In-flight escrows cannot resume after a restart, so their funds go back to the wallet.
  restore(snap) {
    Object.assign(this, {
      createdAt: snap.createdAt || this.createdAt, lastSeen: snap.lastSeen || this.lastSeen,
      mandate: { ...this.mandate, ...snap.mandate }, policy: snap.policy || null, autoTopUp: snap.autoTopUp || null,
      fundings: snap.fundings || [], settlements: snap.settlements || [], paidOutCents: snap.paidOutCents || {},
    });
    this.escrows = new Map();
    for (const e of snap.escrows || []) {
      if (ACTIVE.has(e.status)) {
        const wasDispute = e.status === 'disputed';
        e.status = wasDispute ? 'released' : 'refunded';
        const note = wasDispute ? 'Server restarted during dispute review. Payment stays released; you can dispute again' : 'Server restarted mid-payment. Funds returned to wallet';
        if (!wasDispute) e.verdict = e.verdict || { pass: false, score: 0, reason: note, method: 'system' };
        e.timeline.push({ status: e.status, at: now(), note });
      }
      this.escrows.set(e.id, e);
      escrowIndex.set(e.id, this.id);
    }
  }
}

function evictIfNeeded() {
  if (wallets.size < MAX_WALLETS) return;
  const idle = [...wallets.values()]
    .filter(w => w.id !== 'default' && ![...w.escrows.values()].some(e => ACTIVE.has(e.status)))
    .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
  const victim = idle[0];
  if (!victim) return;
  for (const id of victim.escrows.keys()) escrowIndex.delete(id);
  wallets.delete(victim.id);
}

function wallet(id = 'default') {
  let w = wallets.get(id);
  if (!w) {
    evictIfNeeded();
    w = new Wallet(id);
    wallets.set(id, w);
  }
  return w;
}

function findEscrow(escrowId) {
  const w = wallets.get(escrowIndex.get(escrowId));
  const escrow = w?.getEscrow(escrowId);
  return escrow ? { wallet: w, escrow } : null;
}

function waitForApproval(id, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      approvals.delete(id);
      resolve({ approved: false, note: `No owner decision within ${Math.round(ms / 60000)} minutes` });
    }, ms);
    approvals.set(id, { resolve, timer });
  });
}

function decide(id, approved) {
  const a = approvals.get(id);
  if (!a) return false;
  clearTimeout(a.timer);
  approvals.delete(id);
  a.resolve({ approved, note: approved ? 'Approved by owner' : 'Declined by owner' });
  return true;
}

const pendingApprovals = walletId => [...approvals.keys()].filter(id => escrowIndex.get(id) === walletId);

function dumpAll() { return [...wallets.values()].map(w => w.dump()); }

function restoreAll(list) {
  for (const snap of Array.isArray(list) ? list : []) {
    if (!snap?.id) continue;
    const w = new Wallet(snap.id);
    w.restore(snap);
    wallets.set(w.id, w);
  }
}

function allWallets() { return [...wallets.values()]; }

module.exports = {
  Wallet, wallet, findEscrow, waitForApproval, decide, pendingApprovals, dumpAll, restoreAll, allWallets,
  toCents, usd, today, ACTIVE,
};
