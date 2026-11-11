const crypto = require('crypto');
const paypal = require('./paypal');
const ledger = require('./ledger');

const settling = new Set();
const FINAL_PAYOUT = new Set(['SUCCESS', 'DENIED', 'CANCELED']);

// Payout batches finish asynchronously; follow the batch until PayPal reports a final status.
// Webhooks (server/webhooks.js) update the same record when they are configured.
function pollPayout(wallet, settlementId, batchId, attempt = 0) {
  if (attempt >= 24) return;
  const t = setTimeout(async () => {
    try {
      const b = await paypal.getPayoutBatch(batchId);
      const rec = wallet.settlements.find(s => s.id === settlementId);
      if (rec && b.status && rec.status !== b.status) wallet.updateSettlement(settlementId, { status: b.status, items: b.items });
      if (!FINAL_PAYOUT.has(b.status)) pollPayout(wallet, settlementId, batchId, attempt + 1);
    } catch {
      pollPayout(wallet, settlementId, batchId, attempt + 1);
    }
  }, 5000);
  t.unref();
}

// Refund what the agents did not spend. Spending consumes the oldest top-ups first,
// so refunds come from the newest captures.
async function refundUnused(wallet) {
  const b = wallet.balances();
  let toRefund = b.availableCents;
  if (toRefund <= 0) return [];

  let consumed = b.spentCents;
  const remaining = new Map();
  for (const f of wallet.fundings) {
    const usable = f.cents - f.refundedCents;
    const used = Math.min(usable, consumed);
    consumed -= used;
    remaining.set(f.id, usable - used);
  }

  const out = [];
  for (const f of [...wallet.fundings].reverse()) {
    if (toRefund <= 0) break;
    const cents = Math.min(remaining.get(f.id), toRefund);
    if (cents <= 0) continue;
    if (f.source === 'simulated') {
      f.refundedCents += cents;
      toRefund -= cents;
      out.push(wallet.addSettlement({ kind: 'refund', source: 'simulated', paypalId: null, cents, status: 'released', detail: 'Unused demo credit released' }));
      continue;
    }
    try {
      const r = await paypal.refundCapture(f.captureId, cents, 'AgentPay: unused agent budget returned to you.');
      f.refundedCents += cents;
      toRefund -= cents;
      out.push(wallet.addSettlement({ kind: 'refund', source: 'paypal', paypalId: r.refundId, cents, status: r.status, detail: `Refund of capture ${f.captureId}` }));
    } catch (e) {
      out.push(wallet.addSettlement({ kind: 'refund', source: 'paypal', paypalId: null, cents, status: 'failed', detail: `${e.issue || e.name}: ${e.message}` }));
    }
  }
  return out;
}

function markSettled(wallet, sellerIds) {
  for (const e of wallet.escrows.values()) {
    if (e.status === 'released' && !e.settled && sellerIds.has(e.sellerId)) {
      e.settled = true;
      wallet.emit('escrow', e);
    }
  }
}

async function payoutSellers(wallet) {
  const owed = wallet.sellerEarnings().filter(s => s.owedCents > 0);
  if (!owed.length) return [];
  const batchId = `agentpay_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const total = owed.reduce((a, s) => a + s.owedCents, 0);
  const sellers = owed.map(s => `${s.sellerName} ${ledger.usd(s.owedCents)} (${s.calls} calls)`).join(', ');
  try {
    const r = await paypal.payoutBatch(owed.map(s => ({
      id: `${s.sellerId}_${Date.now()}`, email: s.sellerEmail, cents: s.owedCents,
      note: `${s.calls} verified AgentPay calls`,
    })), batchId);
    for (const s of owed) wallet.paidOutCents[s.sellerId] = (wallet.paidOutCents[s.sellerId] || 0) + s.owedCents;
    markSettled(wallet, new Set(owed.map(s => s.sellerId)));
    const rec = wallet.addSettlement({ kind: 'payout', source: 'paypal', paypalId: r.batchId, cents: total, status: r.status, detail: sellers });
    pollPayout(wallet, rec.id, r.batchId);
    return [rec];
  } catch (e) {
    const region = e.issue === 'PAYOUT_NOT_AVAILABLE' || e.name === 'PAYOUT_NOT_AVAILABLE';
    return [wallet.addSettlement({
      kind: 'payout', source: 'paypal', paypalId: null, cents: total,
      status: region ? 'REGION_BLOCKED' : 'failed',
      detail: region
        ? `PayPal Payouts is not available for this sandbox merchant's country. Earnings stay owed: ${sellers}`
        : `${e.issue || e.name}: ${e.message}. Owed: ${sellers}`,
    })];
  }
}

async function settle(wallet) {
  if (settling.has(wallet.id)) throw new Error('A payout is already running for this wallet');
  const b = wallet.balances();
  if (b.heldCents > 0) throw new Error(`Wait for ${ledger.usd(b.heldCents)} of in-flight payments or disputes to finish`);
  settling.add(wallet.id);
  try {
    const payouts = await payoutSellers(wallet);
    const refunds = await refundUnused(wallet);
    return { payouts, refunds, balances: wallet.balances() };
  } finally {
    settling.delete(wallet.id);
  }
}

module.exports = { settle };
