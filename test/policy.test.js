const test = require('node:test');
const assert = require('node:assert');
const registry = require('../server/registry');
const ledger = require('../server/ledger');
const policy = require('../server/policy');

registry.registerSeller({ id: 'cheap', name: 'Cheap', email: 'c@x.com' });
registry.registerSeller({ id: 'good', name: 'Good', email: 'g@x.com' });
const svc = (id, sellerId, group, priceCents) => {
  registry.register({ id, skill: 'translate_es', name: 'Spanish Translation', group, description: '', sellerId, sellerName: sellerId, sellerEmail: 'x@x.com', priceCents, endpoint: 'http://x' });
  return registry.get(id);
};
const cheapEs = svc('cheap.translate_es', 'cheap', 'Translate', 1);
const goodEs = svc('good.translate_es', 'good', 'Translate', 4);

test('compiled rules are whitelisted: unknown types, sellers and groups are dropped', () => {
  const ids = new Set(['cheap', 'good']);
  assert.deepStrictEqual(policy.validRule({ type: 'block_seller', seller: 'cheap' }, ids), { type: 'block_seller', seller: 'cheap' });
  assert.strictEqual(policy.validRule({ type: 'block_seller', seller: 'nobody' }, ids), null);
  assert.strictEqual(policy.validRule({ type: 'wire_money_to', who: 'me' }, ids), null);
  assert.strictEqual(policy.validRule({ type: 'group_daily_cap', group: 'Gambling', usd: 1 }, ids), null);
  assert.strictEqual(policy.validRule({ type: 'approve_above', usd: -1 }, ids), null);
});

test('rules block, cap and ask for approval as written', () => {
  const w = ledger.wallet('t_policy');
  w.setPolicy({ rules: [
    { type: 'block_seller', seller: 'cheap' },
    { type: 'group_daily_cap', group: 'Translate', usd: 0.05 },
    { type: 'approve_new_sellers' },
  ] });
  assert.match(policy.evaluate(w, cheapEs).block, /Never buy from Cheap/);
  const first = policy.evaluate(w, goodEs);
  assert.strictEqual(first.block, null);
  assert.match(first.approve, /track record/);

  const e = w.createEscrow({ serviceId: goodEs.id, serviceName: 'x', skill: 'translate_es', sellerId: 'good', sellerName: 'good', sellerEmail: 'g@x.com', input: 'hi', priceCents: 4 }, 'held');
  w.setStatus(e.id, 'released');
  assert.match(policy.evaluate(w, goodEs).block, /at most \$0.05 per day on Translate/);
});
