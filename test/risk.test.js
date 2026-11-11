const test = require('node:test');
const assert = require('node:assert');
const registry = require('../server/registry');

test('risk engine suspends a seller below the pass-rate floor, reinstate resets probation', () => {
  registry.registerSeller({ id: 'shady', name: 'Shady', email: 's@x.com', external: true });
  registry.register({ id: 'shady.summarize', skill: 'summarize', name: 'Text Summarization', description: '', sellerId: 'shady', sellerName: 'Shady', sellerEmail: 's@x.com', priceCents: 1, endpoint: 'http://x' });

  for (const pass of [false, true, false, false]) registry.record('shady.summarize', { pass, ms: 10 });
  assert.strictEqual(registry.isSuspended('shady'), false, 'not judged enough yet');

  registry.record('shady.summarize', { pass: false, ms: 10 });
  assert.strictEqual(registry.isSuspended('shady'), true);
  assert.match(registry.getSeller('shady').suspendedReason, /20% over 5/);
  assert.strictEqual(registry.view(registry.get('shady.summarize')).status, 'suspended');

  registry.reinstate('shady');
  assert.strictEqual(registry.isSuspended('shady'), false);
  assert.strictEqual(registry.get('shady.summarize').calls, 0);
});

test('a good seller stays active', () => {
  registry.registerSeller({ id: 'good', name: 'Good', email: 'g@x.com', external: true });
  registry.register({ id: 'good.summarize', skill: 'summarize', name: 'Text Summarization', description: '', sellerId: 'good', sellerName: 'Good', sellerEmail: 'g@x.com', priceCents: 1, endpoint: 'http://x' });
  for (let i = 0; i < 10; i++) registry.record('good.summarize', { pass: i !== 3, ms: 10 });
  assert.strictEqual(registry.isSuspended('good'), false);
});
