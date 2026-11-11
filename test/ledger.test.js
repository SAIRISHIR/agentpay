const test = require('node:test');
const assert = require('node:assert');
const ledger = require('../server/ledger');

const base = { serviceId: 's.x', serviceName: 'X', skill: 'summarize', sellerId: 's', sellerName: 'S', sellerEmail: 's@x.com', input: 'hi' };

test('mandate blocks per-call, daily cap, velocity and empty wallet (with a cure code for funds)', () => {
  const w = ledger.wallet('t_mandate');
  w.setMandate({ perCallMax: 0.05, dailyCap: 0.10, approvalThreshold: 0.05, maxPerMinute: 2 });
  const empty = w.policyCheck(5);
  assert.strictEqual(empty.code, 'funds');

  w.addFunding({ source: 'simulated', cents: 100, status: 'SIMULATED' });
  assert.strictEqual(w.policyCheck(5).ok, true);
  assert.strictEqual(w.policyCheck(6).code, 'per_call');

  const a = w.createEscrow({ ...base, priceCents: 5 }, 'held');
  w.setStatus(a.id, 'released');
  const b = w.createEscrow({ ...base, priceCents: 4 }, 'held');
  w.setStatus(b.id, 'refunded');
  assert.strictEqual(w.policyCheck(5).code, 'velocity');

  w.setMandate({ perCallMax: 0.05, dailyCap: 0.08, approvalThreshold: 0.05, maxPerMinute: 30 });
  assert.strictEqual(w.policyCheck(5).code, 'daily', '5 released + 5 new exceeds an 8 cent cap; refunded work does not count');
  assert.strictEqual(w.policyCheck(3).ok, true);
});

test('balances: refunds return money, releases spend it, fees avoided counts batched payments', () => {
  const b = ledger.wallet('t_mandate').balances();
  assert.strictEqual(b.fundedCents, 100);
  assert.strictEqual(b.spentCents, 5);
  assert.strictEqual(b.judgeRefundedCents, 4);
  assert.strictEqual(b.availableCents, 95);
  assert.strictEqual(b.agentPayments, 2);
  assert.strictEqual(b.feesAvoidedCents, 2 * b.feeFixedCents);
});

test('wallets are isolated from each other, and escrows are findable globally', () => {
  const a = ledger.wallet('t_a');
  const b = ledger.wallet('t_b');
  a.addFunding({ source: 'simulated', cents: 300, status: 'SIMULATED' });
  const e = a.createEscrow({ ...base, priceCents: 2 }, 'locked');
  assert.strictEqual(b.balances().fundedCents, 0);
  assert.strictEqual(b.getEscrow(e.id), null);
  assert.strictEqual(ledger.findEscrow(e.id).wallet.id, 't_a');
});

test('restore refunds in-flight escrows and keeps disputed payments released', () => {
  const w = ledger.wallet('t_restore');
  const live = w.createEscrow({ ...base, priceCents: 1 }, 'locked');
  const disputed = w.createEscrow({ ...base, priceCents: 2 }, 'disputed');
  const snap = JSON.parse(JSON.stringify(ledger.dumpAll()));
  ledger.restoreAll(snap);
  const r = ledger.wallet('t_restore');
  assert.strictEqual(r.getEscrow(live.id).status, 'refunded');
  assert.match(r.getEscrow(live.id).verdict.reason, /restarted/);
  assert.strictEqual(r.getEscrow(disputed.id).status, 'released');
});
