const crypto = require('crypto');
const { client, MODEL } = require('./claude');
const { publish } = require('./events');
const { MAX_RUNS_PER_DAY, MAX_RUNS_PER_WALLET_PER_DAY } = require('./config');
const registry = require('./registry');
const ledger = require('./ledger');
const market = require('./market');
const { AGENTS, byId } = require('./agents');

const systemPrompt = agent => `You are ${agent.name}, an AI ${agent.role.toLowerCase()} agent. You get your work done by buying AI services from other agents on the AgentPay marketplace. Every purchase is paid from a PayPal-funded wallet that a human owner controls through spending limits and plain-English rules.

How the market works:
- Each service has a price and a reputation: the share of past deliveries that passed AgentPay's AI quality check. "new" means no history yet.
- Money is held in escrow and released to the seller only if the delivery passes the check. Failed work is refunded to the wallet.
- Some purchases wait for the owner's approval (large amounts, or because of the owner's rules).
- Some sellers are agents themselves and may hire other agents to finish your job; that cost is charged under the same rules.

Rules:
- Call check_budget and search_services before buying. check_budget also lists the owner's rules; follow them.
- Weigh price against reputation. A cheap seller that fails often costs more because the work has to be bought again.
- Buy only what the goal needs. Combine several texts into one call when the service accepts any amount of text.
- If a purchase is refunded, decide whether to retry with a different seller.
- Skip sellers whose status is "suspended": the risk engine has blocked them for failing quality checks.
- If a limit or rule blocks a purchase, adapt or skip it. Never try to work around the owner's limits.
- Never do a service's work yourself (no own translations, summaries, sentiment or entity lists). If you could not buy something, say in the result that it is missing and why.
- Before each purchase, give your reasoning in one short sentence.
- Finish by calling submit_report with a result of at most 200 words for the owner, built only from outputs you bought, ending with the total you spent.`;

const TOOLS = [
  {
    name: 'check_budget',
    description: 'Wallet balance, the owner\'s spending limits and the owner\'s plain-English rules.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_services',
    description: 'Search the marketplace. Returns service_id, seller, price, reputation, status and the service contract.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Skill or keyword, e.g. "sentiment". Empty lists everything.' } } },
  },
  {
    name: 'buy_service',
    description: 'Pay for one call to a service and get the checked output. Runs the 402 quote, limits and rules, escrow, owner approval when needed, and the AI quality check.',
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string' },
        text: { type: 'string', description: 'The input text to send to the seller.' },
        reason: { type: 'string', description: 'One sentence on why this seller and why now.' },
      },
      required: ['service_id', 'text', 'reason'],
    },
  },
  {
    name: 'submit_report',
    description: 'Finish the task with the final result for the owner.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, report: { type: 'string' } },
      required: ['title', 'report'],
    },
  },
];

const runs = [];
const active = new Map(); // walletId -> run

function log(run, kind, text, data) {
  const entry = { runId: run.id, walletId: run.walletId, agentId: run.agentId, agentName: run.agentName, kind, text, data: data || null, at: new Date().toISOString() };
  run.log.push(entry);
  publish('agent_log', entry, run.walletId);
}

function updateRun(run, patch) {
  Object.assign(run, patch);
  const { log: _ignored, ...summary } = run;
  publish('run', summary, run.walletId);
}

async function executeTool(run, name, input) {
  const wallet = ledger.wallet(run.walletId);
  if (name === 'check_budget') {
    const b = wallet.balances();
    const m = wallet.mandate;
    return {
      wallet_available_usd: b.availableCents / 100,
      spent_today_usd: b.todayCommittedCents / 100,
      daily_cap_usd: m.dailyCapCents / 100,
      per_call_max_usd: m.perCallMaxCents / 100,
      approval_threshold_usd: m.approvalThresholdCents / 100,
      auto_top_up: wallet.autoTopUp?.enabled ? 'on: the wallet refills from PayPal within the daily cap' : 'off',
      owner_rules: wallet.policy?.summary?.length ? wallet.policy.summary : 'none',
    };
  }
  if (name === 'search_services') {
    // With 100+ listings, an empty search returns a compact catalog so the agent can narrow down.
    if (!String(input.query || '').trim()) {
      const all = registry.list('');
      const bySkill = new Map();
      for (const s of all) {
        const row = bySkill.get(s.skill) || { skill: s.skill, service: s.name, type_of_work: s.group, sellers: 0, from_usd: Infinity };
        row.sellers += 1;
        row.from_usd = Math.min(row.from_usd, s.priceCents / 100);
        bySkill.set(s.skill, row);
      }
      return { note: 'Search again with a service name or skill to see sellers, reputation and the contract.', services: [...bySkill.values()] };
    }
    return registry.list(input.query || '').map(s => ({
      service_id: s.id, service: s.name, seller: s.sellerName, price_usd: s.priceCents / 100,
      reputation: s.passRate == null ? 'new' : `${Math.round(s.passRate * 100)}% passed (${s.passes + s.fails} checked)`,
      status: s.status,
      contract: s.description,
    }));
  }
  if (name === 'buy_service') {
    const r = await market.purchase({ wallet, serviceId: input.service_id, text: input.text, reason: input.reason, runId: run.id, channel: run.agentId });
    if (r.status === 'released') { run.purchases += 1; run.spentCents += Math.round(r.cost_usd * 100); }
    if (r.status === 'refunded') run.refunds += 1;
    updateRun(run, {});
    return r;
  }
  if (name === 'submit_report') {
    updateRun(run, { report: { title: String(input.title || 'Result'), body: String(input.report || '') } });
    return { ok: true };
  }
  return { error: `Unknown tool ${name}` };
}

async function loop(run) {
  const agent = byId(run.agentId);
  const docs = run.documents.map((d, i) => `D${i + 1}. ${d}`).join('\n');
  const messages = [{ role: 'user', content: `Goal: ${run.goal}\n\nInputs (${run.customInputs ? 'provided by the owner' : agent.inputLabel}):\n${docs}` }];
  const system = systemPrompt(agent);
  let nudged = false;

  for (let turn = 0; turn < 40; turn++) {
    const msg = await client.messages.create({ model: MODEL, max_tokens: 4000, system, tools: TOOLS, messages });
    messages.push({ role: 'assistant', content: msg.content });

    for (const b of msg.content) if (b.type === 'text' && b.text.trim()) log(run, 'thought', b.text.trim());

    const uses = msg.content.filter(b => b.type === 'tool_use');
    if (!uses.length) {
      if (run.report || nudged) return;
      nudged = true;
      messages.push({ role: 'user', content: 'Call submit_report now with your result.' });
      continue;
    }

    const results = [];
    for (const u of uses) {
      log(run, 'tool', u.name, u.input);
      let out;
      try { out = await executeTool(run, u.name, u.input || {}); } catch (e) { out = { error: e.message }; }
      if (u.name === 'buy_service') log(run, 'result', out.note || out.status, out);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
    if (run.report) return;
  }
  log(run, 'error', 'Stopped after 40 turns');
}

const day = () => new Date().toISOString().slice(0, 10);

function start({ wallet, agentId, goal, documents }) {
  const busy = active.get(wallet.id);
  if (busy) throw Object.assign(new Error(`${busy.agentName} is already working. Wait for it to finish`), { status: 409 });
  if (runs.filter(r => r.startedAt.startsWith(day())).length >= MAX_RUNS_PER_DAY) throw Object.assign(new Error(`The demo's daily limit of ${MAX_RUNS_PER_DAY} agent runs is reached. Please come back tomorrow`), { status: 429 });
  if (runs.filter(r => r.walletId === wallet.id && r.startedAt.startsWith(day())).length >= MAX_RUNS_PER_WALLET_PER_DAY) throw Object.assign(new Error(`You have used today's ${MAX_RUNS_PER_WALLET_PER_DAY} agent runs`), { status: 429 });
  if (wallet.balances().availableCents <= 0 && !wallet.autoTopUp?.enabled) throw Object.assign(new Error('The wallet is empty. Add funds with PayPal first'), { status: 402 });

  const agent = byId(agentId);
  const custom = Array.isArray(documents) && documents.some(d => typeof d === 'string' && d.trim());
  const docs = custom ? documents.filter(d => typeof d === 'string' && d.trim()).slice(0, 8).map(d => d.trim().slice(0, 1500)) : agent.docs;
  const run = {
    id: `run_${crypto.randomBytes(4).toString('hex')}`, walletId: wallet.id,
    agentId: agent.id, agentName: agent.name, agentRole: agent.role, customInputs: custom,
    goal: (typeof goal === 'string' && goal.trim() ? goal.trim() : agent.goal).slice(0, 800),
    documents: docs, status: 'running', startedAt: new Date().toISOString(), endedAt: null,
    purchases: 0, refunds: 0, spentCents: 0, report: null, error: null, log: [],
  };
  runs.push(run);
  if (runs.length > 500) runs.splice(0, runs.length - 500);
  active.set(wallet.id, run);
  updateRun(run, {});
  log(run, 'thought', `${agent.name} received the job: ${docs.length} ${custom ? 'inputs you provided' : agent.inputLabel} to work through.`);

  loop(run)
    .then(() => updateRun(run, { status: run.report ? 'done' : 'stopped', endedAt: new Date().toISOString() }))
    .catch(e => { log(run, 'error', e.message); updateRun(run, { status: 'failed', error: e.message, endedAt: new Date().toISOString() }); })
    .finally(() => { active.delete(wallet.id); });

  return run;
}

const forWallet = walletId => runs.filter(r => r.walletId === walletId);

function dump() {
  return { runs: runs.slice(-200).map(r => ({ ...r, log: r.log.slice(-120) })) };
}

function restore(snap) {
  for (const r of snap?.runs || []) {
    if (r.status === 'running') Object.assign(r, { status: 'stopped', endedAt: r.endedAt || new Date().toISOString(), error: 'Server restarted during the run' });
    r.walletId = r.walletId || 'default';
    runs.push(r);
  }
}

const publicAgents = () => AGENTS.map(a => ({ id: a.id, name: a.name, glyph: a.glyph, role: a.role, pitch: a.pitch, buys: a.buys, goal: a.goal, inputLabel: a.inputLabel, docs: a.docs }));

module.exports = {
  start, dump, restore, agents: publicAgents,
  runs: walletId => forWallet(walletId).map(({ log: l, ...r }) => r),
  logs: walletId => forWallet(walletId).flatMap(r => r.log).slice(-400),
};
