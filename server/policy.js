// Plain-English spending rules: Claude compiles the owner's words into a small, whitelisted rule set
// that the server enforces on every purchase. Anything Claude cannot express is reported, never guessed.
const { ask, parseJson } = require('./claude');
const { SKILLS } = require('./skills');
const registry = require('./registry');

const GROUPS = [...new Set(Object.values(SKILLS).map(s => s.group))];
const usd = c => `$${(c / 100).toFixed(2)}`;
const cents = v => Math.round(Number(v) * 100);

const RULE_TYPES = {
  block_seller: 'Never buy from a seller: {"type":"block_seller","seller":"<seller id>"}',
  only_sellers: 'Only buy from these sellers: {"type":"only_sellers","sellers":["<id>",...]}',
  group_daily_cap: 'Daily spending cap for a type of work: {"type":"group_daily_cap","group":"<group>","usd":0.30}',
  max_price_for_group: 'Max price per purchase for a type of work: {"type":"max_price_for_group","group":"<group>","usd":0.03}',
  min_pass_rate: 'Avoid sellers below a verified pass rate once they have history: {"type":"min_pass_rate","value":0.6,"min_judged":3}',
  approve_new_sellers: 'Ask the owner before buying from a seller with fewer than 3 checked results: {"type":"approve_new_sellers"}',
  approve_group: 'Ask the owner before any purchase of a type of work: {"type":"approve_group","group":"<group>"}',
  approve_above: 'Ask the owner before purchases at or above a price: {"type":"approve_above","usd":0.04}',
};

function validRule(r, sellerIds) {
  if (!r || typeof r !== 'object' || !RULE_TYPES[r.type]) return null;
  const money = v => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 100;
  switch (r.type) {
    case 'block_seller': return sellerIds.has(r.seller) ? { type: r.type, seller: r.seller } : null;
    case 'only_sellers': {
      const list = (Array.isArray(r.sellers) ? r.sellers : []).filter(s => sellerIds.has(s));
      return list.length ? { type: r.type, sellers: list } : null;
    }
    case 'group_daily_cap':
    case 'max_price_for_group': return GROUPS.includes(r.group) && money(r.usd) ? { type: r.type, group: r.group, usd: Number(r.usd) } : null;
    case 'min_pass_rate': {
      const v = Number(r.value);
      return v > 0 && v <= 1 ? { type: r.type, value: v, min_judged: Math.max(1, Math.min(20, Math.round(Number(r.min_judged) || 3))) } : null;
    }
    case 'approve_new_sellers': return { type: r.type };
    case 'approve_group': return GROUPS.includes(r.group) ? { type: r.type, group: r.group } : null;
    case 'approve_above': return money(r.usd) ? { type: r.type, usd: Number(r.usd) } : null;
    default: return null;
  }
}

function describe(r) {
  const name = id => registry.getSeller(id)?.name || id;
  switch (r.type) {
    case 'block_seller': return `Never buy from ${name(r.seller)}`;
    case 'only_sellers': return `Only buy from ${r.sellers.map(name).join(', ')}`;
    case 'group_daily_cap': return `Spend at most ${usd(cents(r.usd))} per day on ${r.group}`;
    case 'max_price_for_group': return `Pay at most ${usd(cents(r.usd))} per ${r.group} purchase`;
    case 'min_pass_rate': return `Skip sellers below ${Math.round(r.value * 100)}% pass rate after ${r.min_judged} checked results`;
    case 'approve_new_sellers': return 'Ask me before using a seller without a track record';
    case 'approve_group': return `Ask me before any ${r.group} purchase`;
    case 'approve_above': return `Ask me before purchases of ${usd(cents(r.usd))} or more`;
    default: return r.type;
  }
}

async function compile(text) {
  const sellers = registry.listSellers();
  const sellerIds = new Set(sellers.map(s => s.id));
  const instructions = `You turn a business owner's spending instructions for their AI agents into JSON rules. Use only these rule types:
${Object.values(RULE_TYPES).map(t => `- ${t}`).join('\n')}

Sellers (use the id): ${sellers.map(s => `${s.id} = ${s.name} (${s.category})`).join('; ')}
Types of work (use exactly): ${GROUPS.join('; ')}

Map each instruction to the closest rule. Never invent a rule type. Put anything you cannot express in "unsupported".
Reply with JSON only: {"rules":[...],"unsupported":["instruction you could not express"]}`;
  const raw = await ask(instructions, String(text).slice(0, 1000), { maxTokens: 1500 });
  const parsed = parseJson(raw);
  const rules = (Array.isArray(parsed.rules) ? parsed.rules : []).map(r => validRule(r, sellerIds)).filter(Boolean).slice(0, 12);
  return {
    text: String(text).slice(0, 1000),
    rules,
    summary: rules.map(describe),
    unsupported: (Array.isArray(parsed.unsupported) ? parsed.unsupported : []).map(String).slice(0, 6),
    compiledAt: new Date().toISOString(),
  };
}

// Returns { block, approve } reasons for a purchase. Both null means the rules allow it outright.
function evaluate(wallet, svc) {
  const rules = wallet.policy?.rules || [];
  let approve = null;
  const today = new Date().toISOString().slice(0, 10);
  const groupSpendToday = group => {
    let total = 0;
    for (const e of wallet.escrows.values()) {
      if (e.day !== today || !['released', 'held', 'awaiting_approval', 'locked', 'delivered', 'verifying', 'disputed'].includes(e.status)) continue;
      if (registry.get(e.serviceId)?.group === group) total += e.priceCents;
    }
    return total;
  };
  const stats = registry.sellerStats(svc.sellerId);
  for (const r of rules) {
    const why = `Your rule: "${describe(r)}"`;
    if (r.type === 'block_seller' && svc.sellerId === r.seller) return { block: why, approve: null };
    if (r.type === 'only_sellers' && !r.sellers.includes(svc.sellerId)) return { block: why, approve: null };
    if (r.type === 'max_price_for_group' && svc.group === r.group && svc.priceCents > cents(r.usd)) return { block: why, approve: null };
    if (r.type === 'group_daily_cap' && svc.group === r.group && groupSpendToday(r.group) + svc.priceCents > cents(r.usd)) return { block: why, approve: null };
    if (r.type === 'min_pass_rate' && stats.judged >= r.min_judged && stats.passRate < r.value) return { block: why, approve: null };
    if (!approve && r.type === 'approve_new_sellers' && stats.judged < 3) approve = why;
    if (!approve && r.type === 'approve_group' && svc.group === r.group) approve = why;
    if (!approve && r.type === 'approve_above' && svc.priceCents >= cents(r.usd)) approve = why;
  }
  return { block: null, approve };
}

module.exports = { compile, evaluate, validRule, describe, GROUPS };
