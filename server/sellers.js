const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { INTERNAL_URL, PREMIUM_SELLER_EMAIL, BUDGET_SELLER_EMAIL } = require('./config');
const { SKILLS, parseOutput } = require('./skills');
const { ask } = require('./claude');
const { paywall } = require('../sdk/seller');

const proEmail = id => process.env[`${id.toUpperCase()}_EMAIL`] || PREMIUM_SELLER_EMAIL;
const budgetEmail = id => process.env[`${id.toUpperCase()}_EMAIL`] || BUDGET_SELLER_EMAIL;

// Prices in cents. Two sellers are simulated low-quality agents: a share of their deliveries is
// deliberately bad so the quality check and risk engine have real failures to catch.
const SELLERS = [
  {
    id: 'lexica', name: 'Lexica Pro', category: 'Language analyst', glyph: 'LX', email: proEmail('lexica'), faultRate: 0,
    tagline: 'Careful reading of news, reports and documents',
    catalog: { sentiment: 2, keywords: 2, classify: 3, summarize: 4, entities: 5, translate: 6, brand_mentions: 3 },
  },
  {
    id: 'polyglot', name: 'Polyglot', category: 'Translator', glyph: 'PG', email: proEmail('polyglot'), faultRate: 0,
    tagline: 'Native-quality translation into the big business languages',
    catalog: { translate: 4, translate_es: 3, translate_ja: 4, translate_fr: 3, translate_ar: 4, translate_de: 3, translate_pt: 3, translate_en: 2 },
  },
  {
    id: 'babel', name: 'Babel', category: 'Global translation house', glyph: 'BL', email: proEmail('babel'), faultRate: 0,
    tagline: '14 languages plus full market localization',
    catalog: {
      translate_fr: 4, translate_ar: 5, translate_de: 4, translate_pt: 3, translate_zh: 5, translate_ko: 5, translate_it: 3,
      translate_ru: 4, translate_tr: 4, translate_id: 3, translate_es: 3, translate_en: 2, language_detect: 1, localize: 6,
    },
  },
  {
    id: 'vani', name: 'Vani', category: 'Indian languages', glyph: 'VN', email: proEmail('vani'), faultRate: 0,
    tagline: 'Hindi, Tamil, Telugu and Bengali by native speakers',
    catalog: { translate: 3, translate_ta: 4, translate_te: 4, translate_bn: 4, translate_en: 2, language_detect: 1 },
  },
  {
    id: 'pulse', name: 'Pulse', category: 'Sentiment lab', glyph: 'PL', email: proEmail('pulse'), faultRate: 0,
    tagline: 'Emotion, sarcasm and aspect-level opinion mining',
    catalog: { sentiment: 2, emotion: 2, aspect_sentiment: 3, sarcasm: 2, intent: 2, urgency: 1, brand_mentions: 3, review_summary: 3 },
  },
  {
    id: 'scholar', name: 'Scholar', category: 'Research firm', glyph: 'SC', email: proEmail('scholar'), faultRate: 0,
    tagline: 'Analyst-grade briefs, market sizing and competitor intelligence',
    catalog: { research_brief: 7, competitor_analysis: 7, market_sizing: 8, compare_options: 5, swot: 5, due_diligence: 6, news_digest: 4 },
  },
  {
    id: 'veritas', name: 'Veritas', category: 'Fact-check desk', glyph: 'VT', email: proEmail('veritas'), faultRate: 0,
    tagline: 'Every claim checked, every verdict explained',
    catalog: { fact_check: 4, news_digest: 4, sarcasm: 2, research_brief: 8 },
  },
  {
    id: 'sentinel', name: 'Sentinel', category: 'Risk & compliance', glyph: 'SN', email: proEmail('sentinel'), faultRate: 0,
    tagline: 'Fraud, scams, chargebacks and personal-data protection',
    catalog: { fraud_check: 4, pii_redact: 3, chargeback_risk: 4, scam_detect: 3, kyc_check: 4, toxicity: 2 },
  },
  {
    id: 'ledgerly', name: 'Ledgerly', category: 'Finance operations', glyph: 'LD', email: proEmail('ledgerly'), faultRate: 0,
    tagline: 'Invoices, refunds and statements turned into clean accounting data',
    catalog: { invoice_extract: 4, expense_category: 2, entities: 3, refund_triage: 3, mcc_suggest: 2, txn_clean: 1 },
  },
  {
    id: 'muse', name: 'Muse', category: 'Creative studio', glyph: 'MU', email: proEmail('muse'), faultRate: 0,
    tagline: 'Copy, ads, SEO and pricing that stick to the facts',
    catalog: { product_copy: 3, social_post: 2, summarize: 3, seo_meta: 2, subject_lines: 2, ad_copy: 3, product_faq: 3, price_positioning: 4 },
  },
  {
    id: 'concierge', name: 'Concierge', category: 'Customer support', glyph: 'CG', email: proEmail('concierge'), faultRate: 0,
    tagline: 'Replies in the customer\'s language, hiring translators when needed',
    catalog: { support_reply: 3, action_items: 2, sentiment: 2, intent: 2, urgency: 1 },
  },
  {
    id: 'briefcase', name: 'Briefcase', category: 'Workplace assistant', glyph: 'BC', email: proEmail('briefcase'), faultRate: 0,
    tagline: 'Meetings, contracts, hiring and code, explained simply',
    catalog: { meeting_notes: 3, contract_risk: 6, resume_match: 4, plain_english: 2, code_explain: 4, action_items: 2 },
  },
  {
    id: 'budgetbot', name: 'BudgetBot', category: 'Generalist (low cost)', glyph: 'BB', email: budgetEmail('budgetbot'), faultRate: 0.5,
    tagline: 'Lowest prices on the market',
    catalog: { sentiment: 1, summarize: 1, entities: 2, translate: 2, product_copy: 1, support_reply: 1, research_brief: 3, fact_check: 2, emotion: 1, swot: 2 },
  },
  {
    id: 'quicklingo', name: 'QuickLingo', category: 'Translator (low cost)', glyph: 'QL', email: budgetEmail('quicklingo'), faultRate: 0.4,
    tagline: 'Instant translations, cheap',
    catalog: { translate: 2, translate_es: 1, translate_ja: 2, translate_fr: 1, translate_ar: 2, translate_de: 1, translate_zh: 2, translate_pt: 1 },
  },
];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

function faultyOutput(skill, text) {
  // Translations that just echo the input (and skip the language tag) fail the format check.
  if (skill.startsWith('translate')) return { translation: text };
  switch (skill) {
    case 'sentiment': return { sentiment: 'positive', score: 0.99, reason: 'The text looks good overall.' };
    case 'summarize': return { summary: 'This text discusses various topics that may be of interest to readers.' };
    case 'entities': return { people: [], organizations: [], locations: [], dates: [] };
    case 'product_copy': return { title: 'Great Product', description: 'This is a great product that you will love. It has many features and is perfect for everyone. Buy it today and enjoy it.' };
    case 'support_reply': return { reply: 'Thank you for contacting us. We have received your message and will get back to you soon.' };
    // Generic answers that pass the format check, so only the AI quality check can catch them.
    case 'research_brief': return { question: 'The question asked', key_findings: ['The market is growing', 'There are several competitors', 'More research is needed'], evidence: ['General industry trends'], open_questions: [], confidence: 'high' };
    case 'fact_check': return { claims: [{ claim: 'The claims in the text', verdict: 'true', reason: 'They sound correct.' }] };
    case 'emotion': return { emotions: [{ emotion: 'joy', score: 0.99 }], dominant: 'joy', evidence: 'n/a' };
    case 'swot': return { strengths: ['Good product'], weaknesses: ['Some issues'], opportunities: ['Growth'], threats: ['Competition'] };
    default: return {};
  }
}

const LANGUAGE_NAME = {
  es: 'Spanish', hi: 'Hindi', ja: 'Japanese', fr: 'French', ar: 'Arabic', de: 'German', pt: 'Portuguese', zh: 'Chinese',
  ko: 'Korean', it: 'Italian', ru: 'Russian', tr: 'Turkish', id: 'Indonesian', ta: 'Tamil', te: 'Telugu', bn: 'Bengali',
};
const TRANSLATE_SKILL = Object.fromEntries(Object.keys(LANGUAGE_NAME).map(c => [c, c === 'hi' ? 'translate' : `translate_${c}`]));

// Agent chain: Concierge is itself an agent. For customers who write in another language it drafts
// in English, then hires the best-rated translator through AgentPay. The sub-purchase is paid from
// the same owner's wallet and must pass the same limits and rules, so governance follows the chain.
async function conciergeReply(text, parentEscrowId) {
  const draft = parseOutput(await ask(
    'Draft a reply to this customer message in English. Address their specific issue, be empathetic and concise, state the next step, and do not promise anything you cannot know. Also detect the language the customer wrote in. Reply with JSON only: {"reply":"...","customer_language":"ISO 639-1 code such as en, es, fr, ar, de, hi"}',
    text,
  ));
  const lang = draft.customer_language;
  const skill = TRANSLATE_SKILL[lang];
  if (!skill || !draft.reply) return { reply: draft.reply, language: lang || 'en' };

  const { data: services } = await axios.get(`${INTERNAL_URL}/api/internal/services`, { params: { skill }, timeout: 5000 });
  const score = s => (s.passRate == null ? 0.8 : s.passRate) / s.priceCents;
  const best = services.filter(s => s.status === 'active' && s.sellerId !== 'concierge').sort((a, b) => score(b) - score(a))[0];
  if (!best) return { reply: draft.reply, language: lang, subcontract: { note: `No ${LANGUAGE_NAME[lang]} translator available` } };

  const { data: r } = await axios.post(`${INTERNAL_URL}/api/internal/subcontract`, {
    parentEscrowId, serviceId: best.id, text: draft.reply,
    reason: `Customer wrote in ${LANGUAGE_NAME[lang]}; hiring ${best.sellerName} to translate my reply`,
  }, { timeout: 230000 });
  if (r.status === 'released' && r.output?.translation) {
    return { reply: r.output.translation, reply_en: draft.reply, language: lang, subcontract: { seller: best.sellerName, service: best.name, escrowId: r.escrow_id, costCents: Math.round(r.cost_usd * 100) } };
  }
  return { reply: draft.reply, language: lang, subcontract: { seller: best.sellerName, service: best.name, escrowId: r.escrow_id, note: `Translation not delivered (${r.status}); replied in English` } };
}

async function perform(seller, skill, text, ctx = {}) {
  if (seller.faultRate && hash(`${seller.id}:${skill}:${text}`) % 100 < seller.faultRate * 100) return faultyOutput(skill, text);
  if (seller.id === 'concierge' && skill === 'support_reply') return conciergeReply(text, ctx.escrowId);
  return parseOutput(await ask(SKILLS[skill].prompt, text));
}

const requireText = (req, res, next) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) return res.status(400).json({ error: 'text is required' });
  return next();
};

function sellerRouter(seller) {
  const router = express.Router();
  for (const [skill, priceCents] of Object.entries(seller.catalog)) {
    router.post(`/${skill}`, requireText, paywall({
      facilitator: INTERNAL_URL,
      serviceId: `${seller.id}.${skill}`,
      priceCents,
      payTo: seller.email,
      description: `${SKILLS[skill].name} by ${seller.name}`,
    }), async (req, res) => {
      try {
        res.json({ output: await perform(seller, skill, req.body.text, { escrowId: req.agentpay.escrowId }), seller: seller.name });
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    });
  }
  return router;
}

/* ---------- Community sellers: list an AI service from the dashboard, hosted by AgentPay ---------- */

const customSellers = new Map(); // id -> { id, name, email, tagline, glyph, catalog, createdAt }

function customRouter() {
  const router = express.Router();
  router.post('/:sellerId/:skill', requireText, (req, res, next) => {
    const seller = customSellers.get(req.params.sellerId);
    const priceCents = seller?.catalog[req.params.skill];
    if (!priceCents) return res.status(404).json({ error: 'unknown_service' });
    req.customSeller = seller;
    return paywall({
      facilitator: INTERNAL_URL,
      serviceId: `${seller.id}.${req.params.skill}`,
      priceCents,
      payTo: seller.email,
      description: `${SKILLS[req.params.skill].name} by ${seller.name}`,
    })(req, res, next);
  }, async (req, res) => {
    try {
      res.json({ output: await perform(req.customSeller, req.params.skill, req.body.text), seller: req.customSeller.name });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
  return router;
}

function addCustomSeller(registry, cfg) {
  const seller = { faultRate: 0, ...cfg };
  customSellers.set(seller.id, seller);
  registry.registerSeller({
    id: seller.id, name: seller.name, email: seller.email, custom: true, createdAt: seller.createdAt,
    category: 'Community seller', tagline: seller.tagline, glyph: seller.glyph,
  });
  for (const [skill, priceCents] of Object.entries(seller.catalog)) {
    registry.register({
      id: `${seller.id}.${skill}`, skill,
      name: SKILLS[skill].name, group: SKILLS[skill].group, description: SKILLS[skill].description,
      sellerId: seller.id, sellerName: seller.name, sellerEmail: seller.email,
      priceCents, endpoint: `/sellers/custom/${seller.id}/${skill}`,
    });
  }
  return seller;
}

function createCustomSeller(registry, { name, email, skill, priceCents, tagline }, maxSellers) {
  if (customSellers.size >= maxSellers) {
    const oldest = [...customSellers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    customSellers.delete(oldest.id);
    registry.removeSeller(oldest.id);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) || 'seller';
  const id = `c-${slug}-${crypto.randomBytes(2).toString('hex')}`;
  const glyph = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'CS';
  return addCustomSeller(registry, {
    id, name, email: email || `${id}@sellers.agentpay.test`, tagline, glyph,
    catalog: { [skill]: priceCents }, createdAt: new Date().toISOString(),
  });
}

const dumpCustomSellers = () => [...customSellers.values()];
const restoreCustomSellers = (registry, list) => (Array.isArray(list) ? list : []).forEach(s => addCustomSeller(registry, s));

function registerSellers(app, registry) {
  app.use('/sellers/custom', customRouter());
  for (const seller of SELLERS) {
    app.use(`/sellers/${seller.id}`, sellerRouter(seller));
    registry.registerSeller({
      id: seller.id, name: seller.name, email: seller.email, external: false,
      category: seller.category, tagline: seller.tagline, glyph: seller.glyph, simulatedFaults: seller.faultRate > 0,
    });
    for (const [skill, priceCents] of Object.entries(seller.catalog)) {
      registry.register({
        id: `${seller.id}.${skill}`, skill,
        name: SKILLS[skill].name, group: SKILLS[skill].group, description: SKILLS[skill].description,
        sellerId: seller.id, sellerName: seller.name, sellerEmail: seller.email,
        priceCents, endpoint: `/sellers/${seller.id}/${skill}`,
      });
    }
  }
}

module.exports = { registerSellers, createCustomSeller, dumpCustomSellers, restoreCustomSellers, SELLERS };
