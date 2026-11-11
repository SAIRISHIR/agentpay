const test = require('node:test');
const assert = require('node:assert');
const paypal = require('../server/paypal');
const ledger = require('../server/ledger');
const settlement = require('../server/settlement');
const market = require('../server/market');

const calls = { refunds: [], payouts: [] };
paypal.refundCapture = async (captureId, cents) => { calls.refunds.push({ captureId, cents }); return { refundId: `R-${captureId}`, status: 'COMPLETED' }; };
paypal.payoutBatch = async (items, batchId) => { calls.payouts.push({ items, batchId }); return { batchId: 'BATCH1', status: 'PENDING' }; };
paypal.getPayoutBatch = async () => ({ status: 'SUCCESS', items: [] });

const base = { serviceId: 's.x', serviceName: 'X', skill: 'summarize', input: 'hi' };

test('settle pays verified earnings in one batch and refunds only unspent PayPal money', async () => {
  const w = ledger.wallet('t_settle');
  w.addFunding({ source: 'paypal', captureId: 'CAP_OLD', cents: 100, status: 'COMPLETED' });
  w.addFunding({ source: 'paypal', captureId: 'CAP_NEW', cents: 200, status: 'COMPLETED' });

  for (const [seller, cents, status] of [['lexica', 4, 'released'], ['lexica', 2, 'released'], ['budgetbot', 1, 'released'], ['budgetbot', 1, 'refunded']]) {
    const e = w.createEscrow({ ...base, sellerId: seller, sellerName: seller, sellerEmail: `${seller}@x.com`, priceCents: cents }, 'held');
    w.setStatus(e.id, status);
  }

  const r = await settlement.settle(w);

  assert.strictEqual(calls.payouts.length, 1, 'one PayPal payout batch for all sellers');
  const items = Object.fromEntries(calls.payouts[0].items.map(i => [i.email, i.cents]));
  assert.deepStrictEqual(items, { 'lexica@x.com': 6, 'budgetbot@x.com': 1 }, 'refunded work is never paid out');

  // 7 cents spent from the oldest capture; 293 cents unspent come back newest-first.
  assert.deepStrictEqual(calls.refunds, [{ captureId: 'CAP_NEW', cents: 200 }, { captureId: 'CAP_OLD', cents: 93 }]);
  assert.strictEqual(r.balances.availableCents, 0);
  assert.strictEqual(r.balances.owedToSellersCents, 0);
  assert.ok([...w.escrows.values()].filter(e => e.status === 'released').every(e => e.settled), 'paid-out escrows are marked settled');

  const again = await settlement.settle(w);
  assert.strictEqual(again.payouts.length + again.refunds.length, 0, 'settling twice moves nothing');
});

test('settled payments can no longer be disputed', async () => {
  const w = ledger.wallet('t_settle');
  const paid = [...w.escrows.values()].find(e => e.status === 'released');
  await assert.rejects(market.dispute(w, paid.id, 'This summary misses the key numbers'), /dispute window has closed/);
});

test('settle refuses while payments are in flight', async () => {
  const w = ledger.wallet('t_inflight');
  w.addFunding({ source: 'simulated', cents: 100, status: 'SIMULATED' });
  w.createEscrow({ ...base, sellerId: 'lexica', sellerName: 'lexica', sellerEmail: 'l@x.com', priceCents: 3 }, 'locked');
  await assert.rejects(settlement.settle(w), /in-flight/);
});
