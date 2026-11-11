const test = require('node:test');
const assert = require('node:assert');
const { SKILLS, parseOutput } = require('../server/skills');

test('sentiment contract rejects generic or malformed output', () => {
  const v = SKILLS.sentiment.validate;
  assert.strictEqual(v({ sentiment: 'negative', score: 0.8, reason: 'The S&P 500 fell 1.8% after the hike.' }), null);
  assert.match(v({ sentiment: 'great', score: 0.8, reason: 'long enough reason' }), /sentiment/);
  assert.match(v({ sentiment: 'positive', score: 2, reason: 'long enough reason' }), /Score/);
});

test('translation must be Hindi (Devanagari)', () => {
  const v = SKILLS.translate.validate;
  assert.match(v({ translation: 'The Fed raised rates.' }), /not in Hindi/);
  assert.strictEqual(v({ translation: 'फेडरल रिज़र्व ने ब्याज दरें बढ़ाईं।' }), null);
});

test('redaction catches leftover emails and phones but not dates or order numbers', () => {
  const v = SKILLS.pii_redact.validate;
  assert.strictEqual(v({ redacted: '[REDACTED] was charged twice for order #55120 on 2026-11-15.', removed: ['name'] }), null);
  assert.match(v({ redacted: 'Call [REDACTED] at +91 98765 43210', removed: [] }), /phone/);
  assert.match(v({ redacted: 'Write to ana.g@example.com', removed: [] }), /email/);
});

test('fraud check needs evidence for risky verdicts', () => {
  const v = SKILLS.fraud_check.validate;
  assert.match(v({ risk: 'high', score: 0.9, signals: [], recommendation: 'block' }), /warning sign/);
  assert.strictEqual(v({ risk: 'high', score: 0.97, signals: ['look-alike domain micros0ft-support.com'], recommendation: 'block' }), null);
});

test('entities must contain something', () => {
  assert.match(SKILLS.entities.validate({ people: [], organizations: [], locations: [], dates: [] }), /No entities/);
  assert.strictEqual(SKILLS.entities.validate({ people: ['Elon Musk'], organizations: ['Tesla'], locations: [], dates: [] }), null);
});

test('parseOutput tolerates code fences and prose', () => {
  assert.deepStrictEqual(parseOutput('```json\n{"summary":"x"}\n```'), { summary: 'x' });
  assert.deepStrictEqual(parseOutput('Here you go: {"summary":"y"} thanks'), { summary: 'y' });
  assert.ok(parseOutput('not json at all').raw);
});
