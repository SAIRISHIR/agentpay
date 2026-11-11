const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const x402 = require('../sdk/x402');
const { paywall } = require('../sdk/seller');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('x402 headers round-trip as base64 JSON', () => {
  const req = x402.requirements({ serviceId: 'acme.translate', priceCents: 3, payTo: 'a@b.com', facilitator: 'http://f' });
  assert.strictEqual(req.scheme, 'paypal-escrow');
  assert.strictEqual(req.amount, '3');
  assert.strictEqual(req.extra.priceUsd, '0.03');
  const payload = x402.paymentPayload(req, 'esc_1');
  assert.deepStrictEqual(x402.decode(x402.encode(payload)), payload);
});

test('paywall: 402 without payment, 402 on rejected payment, 200 with receipt on valid payment', async t => {
  const facilitator = express();
  facilitator.use(express.json());
  facilitator.post('/api/x402/verify', (req, res) => {
    const ok = req.body.paymentPayload?.payload?.escrowId === 'esc_good' && req.body.paymentRequirements?.amount === '3';
    res.json(ok ? { isValid: true, payer: 'wal_test' } : { isValid: false, invalidReason: 'Unknown escrow' });
  });
  const f = await listen(facilitator);

  const seller = express();
  seller.use(express.json());
  seller.post('/translate', paywall({ facilitator: f.url, serviceId: 'acme.translate', priceCents: 3, payTo: 'a@b.com' }),
    (req, res) => res.json({ output: 'ok', escrow: req.agentpay.escrowId }));
  const s = await listen(seller);
  t.after(() => { f.server.close(); s.server.close(); });

  const unpaid = await fetch(`${s.url}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hi"}' });
  assert.strictEqual(unpaid.status, 402);
  const challenge = x402.decode(unpaid.headers.get('payment-required'));
  assert.strictEqual(challenge.x402Version, 2);
  const accepted = challenge.accepts[0];
  assert.strictEqual(accepted.extra.serviceId, 'acme.translate');

  const bad = await fetch(`${s.url}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': x402.encode(x402.paymentPayload(accepted, 'esc_bad')) },
    body: '{"text":"hi"}',
  });
  assert.strictEqual(bad.status, 402);
  assert.strictEqual((await bad.json()).error, 'Unknown escrow');

  const good = await fetch(`${s.url}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': x402.encode(x402.paymentPayload(accepted, 'esc_good')) },
    body: '{"text":"hi"}',
  });
  assert.strictEqual(good.status, 200);
  assert.strictEqual((await good.json()).escrow, 'esc_good');
  const receipt = x402.decode(good.headers.get('payment-response'));
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.transaction, 'esc_good');
});

test('paywall rejects bad configuration', () => {
  assert.throws(() => paywall({ facilitator: 'http://f', serviceId: 'x', priceCents: 0.5, payTo: 'a@b.com' }));
});
