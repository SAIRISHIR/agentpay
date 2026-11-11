const test = require('node:test');
const assert = require('node:assert');
const { SKILLS } = require('../server/skills');
const { SELLERS } = require('../server/sellers');

test('every service a seller lists has a contract, and every contract has a seller', () => {
  const sold = new Set();
  for (const s of SELLERS) {
    for (const [skill, cents] of Object.entries(s.catalog)) {
      assert.ok(SKILLS[skill], `${s.id} sells unknown skill ${skill}`);
      assert.ok(Number.isInteger(cents) && cents >= 1 && cents <= 10, `${s.id}.${skill} price must be 1-10 cents`);
      sold.add(skill);
    }
  }
  for (const k of Object.keys(SKILLS)) assert.ok(sold.has(k), `${k} has no seller`);
  for (const [k, v] of Object.entries(SKILLS)) {
    assert.ok(v.name && v.group && v.description && v.prompt && typeof v.validate === 'function', `${k} contract is incomplete`);
  }
});

test('translations must be tagged with the right language and use the right script', () => {
  const v = k => SKILLS[k].validate;
  assert.strictEqual(v('translate_fr')({ translation: 'Bonjour à tous', language: 'fr' }), null);
  assert.match(v('translate_fr')({ translation: 'Hello everyone' }), /French/, 'an echo without a language tag fails');
  assert.strictEqual(v('translate_ar')({ translation: 'مرحبا بالجميع', language: 'ar' }), null);
  assert.match(v('translate_ar')({ translation: 'Marhaba', language: 'ar' }), /Arabic script/);
  assert.match(v('translate_ko')({ translation: 'Hello', language: 'ko' }), /Hangul/);
  assert.strictEqual(v('translate_en')({ translation: 'Hello', language: 'en', source_language: 'fr' }), null);
});

test('research and risk contracts reject thin or inconsistent work', () => {
  assert.match(SKILLS.research_brief.validate({ question: 'Should we launch?', key_findings: ['One'], evidence: ['x'], confidence: 'high' }), /3 key findings/);
  assert.match(SKILLS.scam_detect.validate({ scam: true, type: 'phishing', confidence: 0.9, red_flags: [], advice: 'Do not click the link.' }), /red flag/);
  assert.match(SKILLS.swot.validate({ strengths: ['a'], weaknesses: [], opportunities: ['b'], threats: ['c'] }), /each of the four/);
  assert.match(SKILLS.mcc_suggest.validate({ mcc: '58', description: 'Restaurants', confidence: 0.8 }), /4 digits/);
  assert.strictEqual(SKILLS.refund_triage.validate({ decision: 'approve', reason: 'Duplicate charge confirmed.', refund_amount: 49.99 }), null);
});
