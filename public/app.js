'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = c => USD.format((Number(c) || 0) / 100);
const clock = iso => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);

// Plain-language status names for first-time users.
const STATUS = {
  released: ['good', 'Paid'],
  refunded: ['warn', 'Refunded'],
  blocked: ['bad', 'Blocked'],
  rejected: ['pass', 'Not approved'],
  awaiting_approval: ['warn', 'Needs your OK'],
  held: ['live', 'Holding money'],
  locked: ['live', 'Working'],
  delivered: ['live', 'Delivered'],
  verifying: ['live', 'Checking quality'],
  disputed: ['live', 'Under dispute'],
};
const pill = status => { const [cls, label] = STATUS[status] || ['pass', status]; return `<span class="pill ${cls}">${esc(label)}</span>`; };
const FINAL = new Set(['released', 'refunded', 'blocked', 'rejected']);

const S = {
  config: null, agents: [], agentId: 'atlas', balances: null, mandate: null, policy: null, autoTopUp: null,
  escrows: new Map(), services: [], sellerDir: [], settlements: [], fundings: [],
  runs: new Map(), amount: 1, statusFilter: 'all', grids: {}, charts: {}, net: null, webhookCount: 0, ledgerIds: new Set(),
};

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// A seller id as buyer means a seller agent hired another agent (an agent chain).
const agentName = id => {
  if (id === 'api') return 'API / MCP agent';
  const a = S.agents.find(x => x.id === id);
  if (a) return a.name;
  const s = S.sellerDir.find(x => x.id === id);
  return s ? `${s.name} (hired by agent)` : id || 'Agent';
};
const agentGlyph = id => (id === 'api' ? 'API' : S.agents.find(a => a.id === id)?.glyph || S.sellerDir.find(s => s.id === id)?.glyph || '··');

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ? `${data.error}${data.debugId ? ` (PayPal debug id ${data.debugId})` : ''}` : `Request failed (${res.status})`);
  return data;
}

function notice(el, text, tone) {
  el.hidden = !text;
  el.className = `notice${tone ? ` ${tone}` : ''}`;
  el.textContent = text || '';
}
const announce = text => { $('announcer').textContent = text; };

function formatOutput(skill, o) {
  if (!o) return '';
  if (o.raw) return `Unreadable reply: ${o.raw}`;
  switch (skill) {
    case 'sentiment': return `${o.sentiment ?? '?'} ${pct(o.score)} · ${o.reason ?? ''}`;
    case 'keywords': return (o.keywords || []).join(', ');
    case 'classify': return `${o.category ?? '?'} (${pct(o.confidence)})`;
    case 'summarize': return o.summary ?? '';
    case 'emotion': return `${o.dominant ?? '?'} · ${(o.emotions || []).map(e => `${e.emotion} ${pct(e.score)}`).join(', ')}`;
    case 'aspect_sentiment': return (o.aspects || []).map(a => `${a.aspect}: ${a.sentiment}`).join(' · ');
    case 'sarcasm': return `${o.sarcastic ? 'Sarcastic' : 'Not sarcastic'} ${pct(o.confidence)} · ${o.real_meaning ?? ''}`;
    case 'toxicity': return `${o.toxic ? 'Toxic' : 'OK'} · ${o.severity ?? ''} · ${o.action ?? ''}${o.reason ? ` · ${o.reason}` : ''}`;
    case 'intent': return `${String(o.intent || '?').replace(/_/g, ' ')} ${pct(o.confidence)} · ${o.summary ?? ''}`;
    case 'urgency': return `${String(o.urgency || '?').toUpperCase()} ${pct(o.score)} · ${o.reason ?? ''}`;
    case 'brand_mentions': return (o.mentions || []).map(m => `${m.brand} (${m.sentiment})`).join(', ') || 'No brands mentioned';
    case 'review_summary': return `${o.overall ?? '?'} · ${o.summary ?? ''}`;
    case 'language_detect': return `${o.name ?? o.language ?? '?'} (${o.language ?? '?'}) ${pct(o.confidence)}`;
    case 'localize': return `${o.market ?? ''}: ${o.localized ?? ''}`;
    case 'research_brief': return (o.key_findings || []).join(' · ');
    case 'competitor_analysis': return `${(o.competitors || []).map(c => c.name).join(', ')} · ${o.takeaway ?? ''}`;
    case 'market_sizing': return `${o.market ?? ''}: ~$${Number(o.estimate_usd || 0).toLocaleString('en-US')} (${o.method ?? ''})`;
    case 'fact_check': return (o.claims || []).map(c => `${String(c.verdict || '?').toUpperCase()}: ${c.claim}`).join(' · ');
    case 'compare_options': return `Pick ${o.recommendation ?? '?'} · ${o.reason ?? ''}`;
    case 'news_digest': return `Top: ${o.top_story ?? '?'} · ${(o.themes || []).map(t => t.theme).join(', ')}`;
    case 'swot': return ['strengths', 'weaknesses', 'opportunities', 'threats'].map(k => `${k[0].toUpperCase()}: ${(o[k] || []).slice(0, 2).join('; ')}`).join(' · ');
    case 'due_diligence': return (o.questions || []).map(q => q.question).join(' · ');
    case 'chargeback_risk': return `${String(o.risk || '?').toUpperCase()} risk ${pct(o.score)} · ${o.action ?? ''} · ${(o.reasons || []).join('; ')}`;
    case 'scam_detect': return `${o.scam ? `SCAM (${o.type})` : 'Not a scam'} ${pct(o.confidence)} · ${(o.red_flags || []).join('; ')}`;
    case 'kyc_check': return `${o.complete ? 'Complete' : `Missing: ${(o.missing_fields || []).join(', ') || 'see concerns'}`} · ${o.next_step ?? ''}`;
    case 'refund_triage': return `${String(o.decision || '?').toUpperCase()}${o.refund_amount != null ? ` ${o.currency || ''} ${o.refund_amount}` : ''} · ${o.reason ?? ''}`;
    case 'mcc_suggest': return `MCC ${o.mcc ?? '?'} ${o.description ?? ''} (${pct(o.confidence)})`;
    case 'txn_clean': return (o.transactions || []).map(t => `${t.merchant}: ${t.clean_description}`).join(' · ');
    case 'seo_meta': return `${o.title ?? ''} · ${o.meta_description ?? ''}`;
    case 'subject_lines': case 'ad_copy': return (o.variants || []).map(v => v.subject || `${v.tone}: ${v.headline}`).join(' · ');
    case 'product_faq': return (o.faqs || []).map(f => `Q: ${f.q} A: ${f.a}`).join(' · ');
    case 'price_positioning': return `${o.position ?? '?'} at $${o.suggested_price_usd ?? '?'} · ${o.rationale ?? ''}`;
    case 'meeting_notes': return [...(o.decisions || []).map(d => `Decided: ${d}`), ...(o.action_items || []).map(a => `${a.owner || '?'}: ${a.task}`)].join(' · ');
    case 'contract_risk': return `Overall ${o.overall_risk ?? '?'} · ${(o.clauses || []).map(c => `${c.risk}: ${c.why}`).join(' · ')}`;
    case 'resume_match': return `${o.verdict ?? '?'} match ${pct(o.match_score)} · missing ${(o.missing_skills || []).join(', ') || 'nothing'}`;
    case 'plain_english': return o.rewrite ?? '';
    case 'code_explain': return `${o.language ?? ''}: ${o.summary ?? ''}`;
    case 'entities': return ['people', 'organizations', 'locations', 'dates']
      .map(k => (o[k] && o[k].length ? `${k}: ${o[k].join(', ')}` : null)).filter(Boolean).join(' · ') || 'No entities';
    case 'fraud_check': return `${String(o.risk || '?').toUpperCase()} risk ${pct(o.score)} · ${o.recommendation || ''} · ${(o.signals || []).join('; ')}`;
    case 'pii_redact': return o.redacted ?? '';
    case 'invoice_extract': return `${o.vendor ?? '?'} · ${o.currency ?? ''} ${o.total ?? '?'} · due ${o.due_date || 'n/a'}`;
    case 'expense_category': return `${o.category ?? '?'} (${pct(o.confidence)})${o.business_related === false ? ' · not business' : ''}`;
    case 'product_copy': return `${o.title ?? ''}: ${o.description ?? ''}`;
    case 'social_post': return `${o.post ?? ''} ${(o.hashtags || []).join(' ')}`;
    case 'support_reply': return o.reply ?? '';
    case 'action_items': return (o.tasks || []).map(t => `${t.task}${t.team ? ` (${t.team})` : ''}`).join(' · ');
    default: return String(skill || '').startsWith('translate') ? (o.translation ?? '') : JSON.stringify(o);
  }
}

const lastNote = e => (e.verdict?.reason) || [...(e.timeline || [])].reverse().find(t => t.note)?.note || '';

/* ---------- KPIs ---------- */
// A figure that changes ticks up into place (220ms, strong ease-out) so the eye catches which number moved.
// Reduced motion keeps the brief fade and drops the travel.
const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)');
function setFigure(id, text) {
  const el = $(id);
  if (el.textContent === text) return;
  const first = !el.dataset.set;
  el.textContent = text;
  el.dataset.set = '1';
  if (first || document.hidden || !el.animate) return;
  el.animate(REDUCE.matches
    ? [{ opacity: 0.4 }, { opacity: 1 }]
    : [{ opacity: 0.4, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
  { duration: REDUCE.matches ? 160 : 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
}

function renderKpis() {
  const b = S.balances, m = S.mandate;
  if (!b || !m) return;
  setFigure('kAvail', money(b.availableCents));
  $('kAvailSub').textContent = `${money(b.todayCommittedCents)} of ${money(m.dailyCapCents)} daily budget used`;
  $('kCapBar').style.width = `${Math.min(100, (b.todayCommittedCents / Math.max(1, m.dailyCapCents)) * 100)}%`;
  setFigure('kSpent', money(b.spentCents));
  $('kSpentSub').textContent = `${b.counts.released} payments approved`;
  setFigure('kRefund', money(b.judgeRefundedCents));
  $('kRefundSub').textContent = `${b.counts.refunded} caught by the quality check`;
  setFigure('kCompress', `${b.agentPayments} → ${b.paypalTransactions}`);
  setFigure('kFees', money(b.feesAvoidedCents));
  $('kFeesSub').textContent = `vs ${money(b.feeFixedCents)} fixed fee per PayPal payment`;
  const judged = b.counts.released + b.counts.refunded;
  setFigure('kPass', judged ? pct(b.counts.released / judged) : '—');
  $('kPassSub').textContent = judged ? `${judged} results checked` : 'No work checked yet';
  S.net?.setHub(b.heldCents ? `${money(b.heldCents)} held now` : `${b.agentPayments} payments settled`);
  S.net?.setPayPal(`${b.paypalTransactions} PayPal transactions`);
}

function fillMandate(force) {
  const m = S.mandate;
  if (!m) return;
  for (const [id, key] of [['mPerCall', 'perCallMaxCents'], ['mDaily', 'dailyCapCents'], ['mApprove', 'approvalThresholdCents']]) {
    if (force || document.activeElement !== $(id)) $(id).value = (m[key] / 100).toFixed(2);
  }
  if (force || document.activeElement !== $('mVelocity')) $('mVelocity').value = m.maxPerMinute;
}

/* ---------- Agent picker ---------- */
function renderAgents() {
  $('agentPicker').innerHTML = S.agents.map(a => `
    <button class="agent-opt" type="button" data-agent="${esc(a.id)}" aria-pressed="${a.id === S.agentId}">
      <span class="who"><span class="avatar">${esc(a.glyph)}</span><span><b>${esc(a.name)}</b><span class="role">${esc(a.role)}</span></span></span>
      <p>${esc(a.pitch)}</p>
    </button>`).join('');
  selectAgent(S.agentId);
}

function selectAgent(id) {
  const a = S.agents.find(x => x.id === id) || S.agents[0];
  if (!a) return;
  S.agentId = a.id;
  document.querySelectorAll('#agentPicker .agent-opt').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.agent === a.id)));
  $('goal').value = a.goal;
  $('docsHint').textContent = `Works on ${a.docs.length} sample ${a.inputLabel} (illustrative). Buys: ${a.buys.join(', ')}.`;
  $('runBtn').textContent = `Hire ${a.name}`;
}

$('agentPicker').addEventListener('click', e => {
  const b = e.target.closest('[data-agent]');
  if (b) selectAgent(b.dataset.agent);
});

/* ---------- Approvals ---------- */
function renderApprovals() {
  const pending = [...S.escrows.values()].filter(e => e.status === 'awaiting_approval');
  $('approvalsSection').hidden = pending.length === 0;
  $('approvals').innerHTML = pending.map(e => `
    <div class="approval" data-id="${esc(e.id)}">
      <span class="avatar">${esc(agentGlyph(e.channel))}</span>
      <div>
        <div class="t">${esc(agentName(e.channel))} wants to spend ${money(e.priceCents)} on ${esc(e.serviceName)} from ${esc(e.sellerName)}</div>
        <div class="d">${e.approvalReason ? `Asking because: ${esc(e.approvalReason)}. ` : ''}Agent's reason: ${esc(e.reason || 'none given')}</div>
      </div>
      <div class="tools">
        <button class="btn" type="button" data-decision="reject">Decline</button>
        <button class="btn primary" type="button" data-decision="approve">Approve ${money(e.priceCents)}</button>
      </div>
    </div>`).join('');
}

$('approvals').addEventListener('click', async ev => {
  const btn = ev.target.closest('button[data-decision]');
  if (!btn) return;
  const id = btn.closest('.approval').dataset.id;
  btn.disabled = true;
  try { await api('POST', `/api/approvals/${encodeURIComponent(id)}`, { decision: btn.dataset.decision }); }
  catch (e) { btn.disabled = false; announce(e.message); }
});

/* ---------- Activity log, run state, result ---------- */
function describeTool(entry) {
  const d = entry.data || {};
  if (entry.text === 'buy_service') {
    const svc = S.services.find(s => s.id === d.service_id);
    return `Buying <b>${esc(svc ? svc.name : d.service_id)}</b>${svc ? ` from ${esc(svc.sellerName)} for ${money(svc.priceCents)}` : ''}. <span class="muted">${esc(d.reason || '')}</span>`;
  }
  if (entry.text === 'search_services') return `Browsing the marketplace${d.query ? ` for <b>${esc(d.query)}</b>` : ''}`;
  if (entry.text === 'check_budget') return 'Checking the budget and your limits';
  if (entry.text === 'submit_report') return 'Handing in the finished result';
  return esc(entry.text);
}

function appendLog(entry, flash) {
  $('logEmpty').hidden = true;
  const li = document.createElement('li');
  if (flash) li.className = 'flash';
  let body, kind;
  if (entry.kind === 'tool') { body = describeTool(entry); kind = 'Action'; }
  else if (entry.kind === 'result') {
    kind = 'Outcome';
    body = `${pill(entry.data?.status)} ${esc(entry.text)}${entry.data?.cost_usd ? ` <span class="mono">−$${Number(entry.data.cost_usd).toFixed(2)}</span>` : ''}`;
  } else if (entry.kind === 'error') { kind = 'Problem'; body = `<span class="pill bad">Error</span> ${esc(entry.text)}`; }
  else if (entry.kind === 'risk') { kind = 'Risk engine'; body = `<span class="pill bad">Protection</span> ${esc(entry.text)}`; }
  else { kind = 'Thinking'; body = esc(entry.text); }
  const glyph = entry.kind === 'risk' ? '!' : agentGlyph(entry.agentId);
  li.innerHTML = `<span class="avatar sm">${esc(glyph)}</span><div><div class="meta"><span class="kind">${esc(kind)}</span><span class="time">${esc(clock(entry.at))}</span>${entry.agentName && entry.kind !== 'risk' ? `<span class="time">${esc(entry.agentName)}</span>` : ''}</div><div class="body">${body}</div></div>`;
  $('logList').appendChild(li);
  const box = $('logBox');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

function renderRun(run) {
  S.runs.set(run.id, run);
  const label = { running: 'is working', done: 'finished', stopped: 'stopped', failed: 'hit a problem' }[run.status] || run.status;
  $('runState').textContent = `${run.agentName || 'Agent'} ${label} · ${run.purchases} paid · ${run.refunds} refunded · ${money(run.spentCents)}`;
  $('runBtn').disabled = run.status === 'running';
  if (run.status === 'failed') $('runMsg').textContent = run.error || 'Run failed';
  if (run.report) {
    $('reportBody').className = 'report';
    $('reportBody').innerHTML = `<h4>${esc(run.report.title)}</h4>${esc(run.report.body)}`;
    $('reportMeta').textContent = `${run.agentName || ''} · ${money(run.spentCents)} spent`;
  }
}

/* ---------- Derived views: ticker, bars, seller cards, owed, network stats ---------- */
let derivedTimer = null;
const scheduleDerived = () => { clearTimeout(derivedTimer); derivedTimer = setTimeout(renderDerived, 120); };

function renderBars(el, rows) {
  const max = Math.max(1, ...rows.map(r => r.paid + r.refunded));
  el.innerHTML = rows.length ? rows.map(r => `
    <div class="bar-row" title="${esc(r.name)}: ${money(r.paid)} paid, ${money(r.refunded)} refunded">
      <span class="name">${esc(r.name)}</span>
      <span class="track"><i style="width:${(r.paid / max) * 100}%;background:var(--good)"></i><i style="width:${(r.refunded / max) * 100}%;background:var(--warn)"></i></span>
      <span class="val">${money(r.paid)}</span>
    </div>`).join('') : '<p class="none">No payments yet.</p>';
}

function group(list, keyFn, nameFn) {
  const m = new Map();
  for (const e of list) {
    const k = keyFn(e);
    const r = m.get(k) || { name: nameFn(e), paid: 0, refunded: 0 };
    if (e.status === 'released') r.paid += e.priceCents;
    if (e.status === 'refunded') r.refunded += e.priceCents;
    m.set(k, r);
  }
  return [...m.values()].filter(r => r.paid + r.refunded > 0).sort((a, b) => (b.paid + b.refunded) - (a.paid + a.refunded)).slice(0, 8);
}

function sellerRollup() {
  const by = new Map();
  for (const s of S.sellerDir) by.set(s.id, { ...s, passes: 0, fails: 0, calls: 0, services: 0, min: Infinity, max: 0, earned: 0, suspended: false });
  for (const svc of S.services) {
    const r = by.get(svc.sellerId) || { id: svc.sellerId, name: svc.sellerName, category: svc.sellerCategory || 'Independent seller', glyph: svc.sellerName.slice(0, 2).toUpperCase(), tagline: '', passes: 0, fails: 0, calls: 0, services: 0, min: Infinity, max: 0, earned: 0 };
    r.passes += svc.passes; r.fails += svc.fails; r.calls += svc.calls; r.services += 1;
    r.min = Math.min(r.min, svc.priceCents); r.max = Math.max(r.max, svc.priceCents);
    r.suspended = svc.status === 'suspended';
    r.suspendedReason = svc.suspendedReason;
    by.set(svc.sellerId, r);
  }
  for (const e of S.escrows.values()) if (e.status === 'released' && by.has(e.sellerId)) by.get(e.sellerId).earned += e.priceCents;
  return [...by.values()].map(r => ({ ...r, judged: r.passes + r.fails, passRate: r.passes + r.fails ? r.passes / (r.passes + r.fails) : null }));
}

/* ---------- Trends (AG Charts) ----------
   Colours come from validated chart steps (dataviz validator: lightness band, CVD, contrast), picked
   per theme rather than flipped. Paid and refunded sit at ΔE 6.5 for protan readers, so refunded also
   carries a dashed line and both lines are labelled at their ends. Quality vs price is one series in
   the PayPal-blue accent: one hue on the main data element. */
const CHART_STEPS = {
  dark: { paid: '#25a15f', refunded: '#cc8212', accent: '#009cde' },
  light: { paid: '#1a7f4b', refunded: '#9a5b00', accent: '#0070e0' },
};
const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const tok = name => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

function chartTheme(fills = []) {
  const ink2 = tok('ink-2'), line = tok('line');
  const axis = { label: { color: ink2, fontSize: 12, fontFamily: 'Inter, system-ui, sans-serif' }, line: { enabled: false }, tick: { enabled: false },
    gridLine: { style: [{ stroke: line, lineDash: [3, 4] }] }, title: { enabled: false } };
  return {
    baseTheme: isDark() ? 'ag-default-dark' : 'ag-default',
    palette: { fills, strokes: fills },
    overrides: { common: {
      background: { visible: false },
      padding: { top: 8, right: 16, bottom: 4, left: 4 },
      legend: { item: { label: { color: ink2, fontSize: 12 } } },
      axes: { number: axis, time: axis },
    } },
  };
}

const finalAt = e => new Date([...(e.timeline || [])].reverse().find(t => t.status === e.status)?.at || e.createdAt).getTime();

function spendOptions(escrows) {
  const c = CHART_STEPS[isDark() ? 'dark' : 'light'];
  const done = escrows.filter(e => e.status === 'released' || e.status === 'refunded').sort((a, b) => finalAt(a) - finalAt(b));
  let paid = 0, refunded = 0;
  // x is the running count of judged payments: runs span days with idle gaps, so clock time
  // would squash every run into a vertical step.
  const data = done.map((e, i) => {
    if (e.status === 'released') paid += e.priceCents; else refunded += e.priceCents;
    return { n: i + 1, at: finalAt(e), paid: paid / 100, refunded: refunded / 100, what: `${e.serviceName} from ${e.sellerName}`, ok: e.status === 'released' };
  });
  const tip = key => ({ renderer: ({ datum }) => ({
    title: `Payment ${datum.n} · ${clock(new Date(datum.at).toISOString())}`,
    content: `${esc(datum.what)}: ${datum.ok ? 'paid' : 'refunded'}<br>${key === 'paid' ? 'Paid' : 'Refunded'} so far: ${USD.format(datum[key])}`,
  }) });
  const line = (key, name, stroke, dash) => ({
    type: 'line', xKey: 'n', yKey: key, yName: `${name} · ${USD.format(key === 'paid' ? paid / 100 : refunded / 100)}`,
    stroke, strokeWidth: 2, lineDash: dash, marker: { enabled: false, fill: stroke, stroke }, tooltip: tip(key),
  });
  return {
    container: $('chartSpend'), theme: chartTheme([c.paid, c.refunded]), data,
    series: [line('paid', 'Paid for good work', c.paid, []), line('refunded', 'Refunded for bad work', c.refunded, [6, 4])],
    axes: [
      { type: 'number', position: 'bottom', nice: false, min: 1, max: Math.max(2, data.length), label: { formatter: ({ value }) => `#${Math.round(value)}` }, title: { enabled: true, text: 'Judged payments, in order', color: tok('ink-2'), fontSize: 12 }, gridLine: { enabled: false } },
      { type: 'number', position: 'left', nice: true, min: 0, label: { formatter: ({ value }) => USD.format(value) } },
    ],
    legend: { position: 'bottom' },
  };
}

function qualityOptions(escrows) {
  const c = CHART_STEPS[isDark() ? 'dark' : 'light'];
  const by = new Map();
  for (const e of escrows) {
    if (e.status !== 'released' && e.status !== 'refunded') continue;
    const r = by.get(e.sellerId) || { name: e.sellerName, jobs: 0, passed: 0, cents: 0 };
    r.jobs += 1; r.cents += e.priceCents; if (e.status === 'released') r.passed += 1;
    by.set(e.sellerId, r);
  }
  const data = [...by.values()].map(r => ({ name: r.name, price: r.cents / r.jobs, pass: Math.round((r.passed / r.jobs) * 100), jobs: r.jobs }));
  return {
    container: $('chartQuality'), theme: chartTheme([c.accent]), data,
    series: [{
      type: 'bubble', xKey: 'price', yKey: 'pass', sizeKey: 'jobs', labelKey: 'name',
      xName: 'Average price', yName: 'Passed the check', sizeName: 'Checked jobs',
      fill: c.accent, fillOpacity: 0.28, stroke: c.accent, strokeWidth: 2, size: 8, maxSize: 34,
      label: { enabled: true, color: tok('ink'), fontSize: 12 },
      tooltip: { renderer: ({ datum }) => ({ title: esc(datum.name), content: `${datum.pass}% passed · ${datum.jobs} checked<br>Average price ${USD.format(datum.price / 100)}` }) },
    }],
    axes: [
      { type: 'number', position: 'bottom', nice: true, min: 0, label: { formatter: ({ value }) => `${value}¢` } },
      { type: 'number', position: 'left', min: 0, max: 112, interval: { step: 20 }, label: { formatter: ({ value }) => (value > 100 ? '' : `${value}%`) } },
    ],
    legend: { enabled: false },
  };
}

function renderTrends(escrows) {
  const lib = window.agCharts?.AgCharts;
  const section = document.querySelector('.trends');
  if (!lib || !section) return;
  const judged = escrows.some(e => e.status === 'released' || e.status === 'refunded');
  section.hidden = false;
  $('trendsEmpty').hidden = judged;
  $('chartSpend').hidden = !judged;
  $('chartQuality').hidden = !judged;
  if (!judged) return;
  const spend = spendOptions(escrows), quality = qualityOptions(escrows);
  S.charts = S.charts || {};
  if (S.charts.spend) S.charts.spend.update(spend); else S.charts.spend = lib.create(spend);
  if (S.charts.quality) S.charts.quality.update(quality); else S.charts.quality = lib.create(quality);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderTrends([...S.escrows.values()]));

function renderDerived() {
  const escrows = [...S.escrows.values()];
  renderTrends(escrows);

  const finals = escrows.filter(e => FINAL.has(e.status)).slice(-16).reverse();
  const ticks = finals.map(e => `<span class="tick">${pill(e.status)} <b>${esc(agentName(e.channel))}</b> → ${esc(e.sellerName)} · ${esc(e.serviceName)} <span class="amt">${money(e.priceCents)}</span></span>`).join('');
  $('tickerTrack').innerHTML = ticks ? ticks + ticks : '<span class="tick muted">Payments between agents will stream here.</span>';

  renderBars($('barsSeller'), group(escrows, e => e.sellerId, e => e.sellerName));
  renderBars($('barsBuyer'), group(escrows, e => e.channel, e => agentName(e.channel)));
  renderBars($('barsGroup'), group(escrows, e => S.services.find(s => s.id === e.serviceId)?.group || 'Other', e => S.services.find(s => s.id === e.serviceId)?.group || 'Other'));

  const count = st => escrows.filter(e => st.includes(e.status)).length;
  const paidList = escrows.filter(e => e.status === 'released');
  const timed = escrows.filter(e => e.latencyMs != null);
  $('moneyTotals').innerHTML = [
    ['Approved', count(['released'])],
    ['Refunded', count(['refunded'])],
    ['Blocked', count(['blocked', 'rejected'])],
    ['Avg price', paidList.length ? money(Math.round(paidList.reduce((a, e) => a + e.priceCents, 0) / paidList.length)) : '—'],
    ['Avg delivery', timed.length ? `${(timed.reduce((a, e) => a + e.latencyMs, 0) / timed.length / 1000).toFixed(1)}s` : '—'],
  ].map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('');

  const sellers = sellerRollup();
  $('marketCount').textContent = `${sellers.length} AI agents selling ${S.services.length} services`;
  $('sellerCards').innerHTML = sellers.map(s => `
    <div class="card seller${s.suspended ? ' suspended' : ''}">
      <div class="top"><span class="avatar">${esc(s.glyph)}</span><div><b>${esc(s.name)}</b><span class="cat">${esc(s.category)}</span></div></div>
      <p>${esc(s.tagline || '')}</p>
      <div class="stats">
        <div><span>Services</span><strong>${s.services}</strong></div>
        <div><span>Price</span><strong>${s.services ? (s.min === s.max ? money(s.min) : `${money(s.min)}–${money(s.max).slice(1)}`) : '—'}</strong></div>
        <div><span>Pass rate</span><strong>${pct(s.passRate)}</strong></div>
      </div>
      <div class="status-line">
        ${s.suspended ? `<span class="pill bad">Suspended</span><button class="cell-btn" type="button" data-reinstate="${esc(s.id)}">Reinstate</button>`
          : `<span class="pill good">Active</span>${s.simulatedFaults ? '<span class="pill warn">Simulated low quality</span>' : s.external ? '<span class="pill pass">External</span>' : ''}`}
        <span class="small muted mono jobs">${s.calls} jobs · ${money(s.earned)}</span>
      </div>
    </div>`).join('');

  if (S.net) {
    for (const s of sellers) S.net.updateSeller(s.id, { passRate: s.passRate, judged: s.judged, suspended: s.suspended, earned: s.earned });
  }

  const owed = {};
  for (const e of escrows) if (e.status === 'released') owed[e.sellerId] = (owed[e.sellerId] || { name: e.sellerName, cents: 0 }), owed[e.sellerId].cents += e.priceCents;
  const paidOut = S.settlements.filter(s => s.kind === 'payout' && !['failed', 'REGION_BLOCKED'].includes(s.status)).reduce((a, s) => a + s.cents, 0);
  const totalOwed = Math.max(0, Object.values(owed).reduce((a, o) => a + o.cents, 0) - paidOut);
  $('owedList').innerHTML = totalOwed > 0
    ? Object.values(owed).sort((a, b) => b.cents - a.cents).map(o => `<div class="owed-row"><span>${esc(o.name)}</span><span>${money(o.cents)}</span></div>`).join('') + `<div class="owed-row"><b>Still owed</b><b class="mono">${money(totalOwed)}</b></div>`
    : `<p class="muted small">${paidOut ? `All approved work paid out (${money(paidOut)}).` : 'Nothing owed yet.'}</p>`;
}

$('sellerCards').addEventListener('click', async e => {
  const id = e.target.closest('[data-reinstate]')?.dataset.reinstate;
  if (!id) return;
  try { await api('POST', `/api/sellers/${encodeURIComponent(id)}/reinstate`); } catch (err) { announce(err.message); }
});

/* ---------- Grids ---------- */
const meter = (v, tone) => (v == null ? '<span class="cell-dim">—</span>'
  : `<span class="meter"><span class="track"><i style="width:${Math.round(v * 100)}%;background:var(${tone})"></i></span><span class="val">${pct(v)}</span></span>`);

function ledgerTotals() {
  let paid = 0, refunded = 0, count = 0;
  for (const e of S.escrows.values()) {
    count++;
    if (e.status === 'released') paid += e.priceCents;
    if (e.status === 'refunded') refunded += e.priceCents;
  }
  return [{ id: '__total', pinned: true, serviceName: `${count} payments`, sellerName: `${money(refunded)} refunded`, priceCents: paid }];
}

// Column views: "simple" for first-time users, "detailed" for an audit. Remembered per browser.
const LEDGER_VIEWS = {
  simple: ['createdAt', 'status', 'channel', 'serviceName', 'sellerName', 'priceCents', 'why', 'delivered'],
  detailed: ['createdAt', 'status', 'channel', 'serviceName', 'sellerName', 'priceCents', 'quality', 'why', 'delivered', 'latency', 'chain', 'escrowId'],
};

function applyLedgerView(view) {
  const show = new Set(LEDGER_VIEWS[view] || LEDGER_VIEWS.simple);
  S.grids.ledger.applyColumnState({ state: S.grids.ledger.getColumns().map(c => ({ colId: c.getColId(), hide: !show.has(c.getColId()) })) });
  document.querySelectorAll('#viewCtrl button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  store.set('agentpay.ledgerView', view);
}

function makeLedgerGrid() {
  const textFilter = { filter: 'agTextColumnFilter', floatingFilter: true, suppressHeaderMenuButton: true };
  return agGrid.createGrid($('ledgerGrid'), {
    columnDefs: [
      { colId: 'createdAt', field: 'createdAt', headerName: 'Time', width: 132, sort: 'desc', cellRenderer: p => (p.data.pinned ? 'Total' : `<span class="cell-mono">${esc(clock(p.value))}</span>`) },
      { colId: 'status', field: 'status', headerName: 'Status', width: 158, enableCellChangeFlash: true, cellRenderer: p => (p.data.pinned ? '' : pill(p.value)) },
      { colId: 'channel', field: 'channel', headerName: 'Buyer', width: 170, ...textFilter, valueGetter: p => (p.data.pinned ? '' : agentName(p.data.channel)) },
      { colId: 'serviceName', field: 'serviceName', headerName: 'Service', width: 190, ...textFilter },
      { colId: 'sellerName', field: 'sellerName', headerName: 'Seller', width: 140, ...textFilter },
      { colId: 'priceCents', field: 'priceCents', headerName: 'Price', width: 110, type: 'rightAligned', cellClass: 'cell-mono', filter: 'agNumberColumnFilter', floatingFilter: true, suppressHeaderMenuButton: true,
        filterValueGetter: p => p.data.priceCents / 100, valueFormatter: p => money(p.value) },
      { colId: 'quality', headerName: 'Quality', width: 140, valueGetter: p => p.data.verdict?.score ?? null,
        cellRenderer: p => (p.data.pinned ? '' : meter(p.value, p.data.verdict?.pass ? '--good' : '--bad')) },
      { colId: 'why', headerName: 'Why', flex: 1.3, minWidth: 260, valueGetter: p => (p.data.pinned ? '' : lastNote(p.data)), tooltipValueGetter: p => p.value,
        cellRenderer: p => `<span class="cell-muted">${esc(p.value)}</span>` },
      { colId: 'delivered', headerName: 'What was delivered', flex: 1.4, minWidth: 260, valueGetter: p => formatOutput(p.data.skill, p.data.output), tooltipValueGetter: p => p.value,
        cellRenderer: p => esc(p.value) },
      { colId: 'latency', field: 'latencyMs', headerName: 'Delivery', width: 110, type: 'rightAligned', cellClass: 'cell-mono', valueFormatter: p => (p.value == null ? '—' : `${(p.value / 1000).toFixed(1)}s`) },
      { colId: 'chain', field: 'parentEscrowId', headerName: 'Hired by', width: 150, valueFormatter: p => (p.value ? `Agent chain` : '') },
      { colId: 'escrowId', field: 'id', headerName: 'Escrow ID', width: 170, cellClass: 'cell-mono', valueFormatter: p => (p.data.pinned ? '' : p.value) },
    ],
    defaultColDef: { resizable: true, sortable: true },
    rowData: [], getRowId: p => p.data.id,
    rowHeight: 46, headerHeight: 42, floatingFiltersHeight: 38, animateRows: true, suppressCellFocus: true, tooltipShowDelay: 300,
    asyncTransactionWaitMillis: 60,
    rowClassRules: {
      'row-refunded': p => p.data?.status === 'refunded',
      'row-blocked': p => ['blocked', 'rejected'].includes(p.data?.status),
      'row-disputed': p => p.data?.status === 'disputed',
      'row-chain': p => !!p.data?.parentEscrowId,
    },
    pagination: true, paginationPageSize: 50, paginationPageSizeSelector: [25, 50, 100],
    pinnedBottomRowData: ledgerTotals(),
    isExternalFilterPresent: () => S.statusFilter !== 'all',
    doesExternalFilterPass: node => (S.statusFilter === 'blocked' ? ['blocked', 'rejected'].includes(node.data.status) : node.data.status === S.statusFilter),
    overlayNoRowsTemplate: '<span class="muted">No payments yet. Hire an agent to fill this.</span>',
    onRowClicked: e => { if (!e.data.pinned) openDrawer(e.data.id); },
  });
}

// Ledger rows stream in fast during a run, so they go through AG Grid's batched async transactions.
function upsertLedger(row) {
  if (S.ledgerIds.has(row.id)) S.grids.ledger.applyTransactionAsync({ update: [row] });
  else { S.ledgerIds.add(row.id); S.grids.ledger.applyTransactionAsync({ add: [row] }); }
}

function makeMarketGrid() {
  return agGrid.createGrid($('marketGrid'), {
    columnDefs: [
      { field: 'group', headerName: 'Type of work', width: 170 },
      { field: 'name', headerName: 'Service', width: 200 },
      { field: 'sellerName', headerName: 'Seller', width: 140 },
      { field: 'status', headerName: 'Status', width: 130, enableCellChangeFlash: true, tooltipValueGetter: p => p.data.suspendedReason || '',
        cellRenderer: p => (p.value === 'suspended' ? '<span class="pill bad">Suspended</span>' : '<span class="pill good">Active</span>') },
      { field: 'priceCents', headerName: 'Price', width: 92, type: 'rightAligned', cellClass: 'cell-mono', valueFormatter: p => money(p.value) },
      { field: 'passRate', headerName: 'Pass rate', width: 170, cellRenderer: p => meter(p.value, p.value != null && p.value < 0.7 ? '--bad' : '--good') },
      { field: 'calls', headerName: 'Jobs', width: 84, type: 'rightAligned', cellClass: 'cell-mono', enableCellChangeFlash: true },
      { headerName: 'Real cost per good result', width: 210, type: 'rightAligned', cellClass: 'cell-mono', headerTooltip: 'Price divided by pass rate: what one good result really costs',
        valueGetter: p => (p.data.passRate ? p.data.priceCents / p.data.passRate : null), valueFormatter: p => (p.value == null ? '—' : money(Math.round(p.value))) },
      { field: 'description', headerName: 'What you get', flex: 1, minWidth: 300, tooltipField: 'description', cellClass: 'cell-muted' },
    ],
    defaultColDef: { resizable: true, sortable: true, filter: true },
    rowData: [], getRowId: p => p.data.id, rowHeight: 44, headerHeight: 42, suppressCellFocus: true, tooltipShowDelay: 300,
  });
}

function settleRows() {
  const sim = S.fundings.filter(f => f.source === 'simulated').map(f => ({
    id: f.id, at: f.at, kind: 'credit', source: 'simulated', paypalId: null, cents: f.cents, status: 'SIMULATED', detail: 'Demo credit, no PayPal transaction',
  }));
  return [...S.settlements, ...sim];
}

function makeSettleGrid() {
  const kindLabel = { capture: 'Top-up from you', auto_capture: 'Auto top-up (approved once)', refund: 'Refund to you', payout: 'Payout to sellers', credit: 'Demo credit' };
  return agGrid.createGrid($('settleGrid'), {
    columnDefs: [
      { field: 'at', headerName: 'Time', width: 132, sort: 'desc', cellRenderer: p => `<span class="cell-mono">${esc(clock(p.value))}</span>` },
      { field: 'kind', headerName: 'What', width: 170, valueFormatter: p => kindLabel[p.value] || p.value },
      { field: 'source', headerName: 'Rail', width: 110, cellRenderer: p => (p.value === 'paypal' ? '<span class="pill info">PayPal</span>' : '<span class="pill pass">Simulated</span>') },
      { field: 'cents', headerName: 'Amount', width: 100, type: 'rightAligned', cellClass: 'cell-mono', valueFormatter: p => money(p.value) },
      { field: 'status', headerName: 'Status', width: 140, enableCellChangeFlash: true, cellRenderer: p => {
        const s = String(p.value || '');
        const tone = s === 'failed' ? 'bad' : s === 'REGION_BLOCKED' ? 'warn' : /COMPLETED|SUCCESS|released/i.test(s) ? 'good' : /PENDING|PROCESSING/i.test(s) ? 'live' : 'pass';
        return `<span class="pill ${tone}">${esc(s)}</span>`;
      } },
      { field: 'paypalId', headerName: 'PayPal ID', width: 200, cellRenderer: p => (p.value ? `<span class="cell-mono">${esc(p.value)}</span>` : '<span class="cell-dim">—</span>') },
      { field: 'detail', headerName: 'Detail', flex: 1, minWidth: 240, tooltipField: 'detail', cellClass: 'cell-muted' },
    ],
    defaultColDef: { resizable: true, sortable: true },
    rowData: [], getRowId: p => p.data.id, rowHeight: 44, headerHeight: 42, suppressCellFocus: true, tooltipShowDelay: 300,
    overlayNoRowsTemplate: '<span class="muted">Nothing yet. Top-ups, payouts and refunds appear here with their PayPal IDs.</span>',
  });
}

function upsert(grid, row) {
  if (grid.getRowNode(row.id)) grid.applyTransaction({ update: [row] });
  else grid.applyTransaction({ add: [row] });
}

/* ---------- Drawer ---------- */
function openDrawer(id) {
  const e = S.escrows.get(id);
  if (!e) return;
  const v = e.verdict;
  const parent = e.parentEscrowId ? S.escrows.get(e.parentEscrowId) : null;
  const children = [...S.escrows.values()].filter(x => x.parentEscrowId === e.id);
  const chain = parent
    ? `<p class="chain-note">Agent chain: ${esc(e.sellerName)} was hired by ${esc(parent.sellerName)} while doing ${esc(parent.serviceName)} for ${esc(agentName(parent.channel))}. Your limits and rules applied to this purchase too.</p>`
    : children.length ? `<p class="chain-note">Agent chain: to finish this job, ${esc(e.sellerName)} hired ${children.map(c => `${esc(c.sellerName)} (${esc(c.serviceName)}, ${money(c.priceCents)}, ${esc((STATUS[c.status] || [0, c.status])[1])})`).join(', ')}.</p>` : '';
  let disputeBox = '';
  if (e.dispute?.outcome) {
    disputeBox = `<div class="dispute"><b>Your dispute was ${e.dispute.outcome === 'upheld' ? 'upheld: money taken back' : 'rejected'}</b><span class="small muted">You said: "${esc(e.dispute.complaint)}"</span><span>${esc(e.dispute.reason || '')}</span></div>`;
  } else if (e.status === 'disputed') {
    disputeBox = '<div class="dispute"><b>Dispute under review</b><span class="small muted">The AI reviewer is re-checking this delivery against your complaint.</span></div>';
  } else if (e.status === 'released' && !e.settled) {
    disputeBox = `<form class="dispute" data-dispute="${esc(e.id)}"><b>Something wrong with this work?</b><span class="small muted">Dispute it before you pay out. The AI reviewer re-checks the delivery with your complaint and takes the money back if you are right.</span>
      <textarea name="complaint" rows="2" maxlength="500" placeholder="For example: the translation drops the price and the second sentence."></textarea>
      <div class="tools"><button class="btn" type="submit">Dispute ${money(e.priceCents)}</button><span class="small muted" data-dispute-msg></span></div></form>`;
  } else if (e.status === 'released' && e.settled) {
    disputeBox = '<div class="dispute"><span class="small muted">Paid out to the seller on PayPal. The dispute window for this payment has closed.</span></div>';
  }
  $('drawerRoot').innerHTML = `
    <div class="drawer-backdrop" data-close></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle" data-id="${esc(e.id)}">
      <button class="btn close" type="button" data-close>Close</button>
      <p class="eyebrow">${esc(agentName(e.channel))} bought from ${esc(e.sellerName)}</p>
      <h2 id="drawerTitle">${esc(e.serviceName)} · ${money(e.priceCents)}</h2>
      <div class="verdict">${pill(e.status)} ${v ? `<b>Quality check: ${v.pass ? 'passed' : 'failed'} (${pct(v.score)})</b><br>${esc(v.reason)}` : esc(lastNote(e))}</div>
      ${chain}
      ${disputeBox}
      <dl>
        <dt>Agent's reason</dt><dd>${esc(e.reason || '—')}</dd>
        <dt>Time to deliver</dt><dd class="mono">${e.latencyMs == null ? '—' : `${e.latencyMs.toLocaleString()} ms`}</dd>
      </dl>
      <p class="eyebrow">What was sent</p>
      <pre>${esc(e.input)}</pre>
      <p class="eyebrow">What came back</p>
      <pre>${esc(e.output ? formatOutput(e.skill, e.output) : 'Nothing delivered')}</pre>
      <p class="eyebrow">Step by step</p>
      <ol class="timeline">${(e.timeline || []).map(t => `<li><span class="when">${esc(clock(t.at))}</span>${pill(t.status)} ${esc(t.note || '')}</li>`).join('')}</ol>
      <details>
        <summary>Technical details</summary>
        <dl><dt>Escrow ID</dt><dd class="mono">${esc(e.id)}</dd><dt>Run</dt><dd class="mono">${esc(e.runId || '—')}</dd><dt>Check method</dt><dd>${esc(v?.method || '—')}</dd></dl>
        <p class="eyebrow">402 price quote (PAYMENT-REQUIRED)</p>
        <pre>${esc(e.quote ? JSON.stringify(e.quote, null, 2) : 'No quote')}</pre>
        <p class="eyebrow">Seller receipt (PAYMENT-RESPONSE)</p>
        <pre>${esc(e.receipt ? JSON.stringify(e.receipt, null, 2) : 'No receipt')}</pre>
        <p class="eyebrow">Raw delivery</p>
        <pre>${esc(e.output ? JSON.stringify(e.output, null, 2) : '—')}</pre>
      </details>
    </aside>`;
  $('drawerRoot').querySelector('.drawer .close').focus();
}
$('drawerRoot').addEventListener('click', ev => { if (ev.target.closest('[data-close]')) $('drawerRoot').innerHTML = ''; });
$('drawerRoot').addEventListener('submit', async ev => {
  const form = ev.target.closest('[data-dispute]');
  if (!form) return;
  ev.preventDefault();
  const msg = form.querySelector('[data-dispute-msg]');
  const btn = form.querySelector('button');
  btn.disabled = true;
  msg.textContent = 'Sending to the AI reviewer';
  try {
    const r = await api('POST', `/api/escrows/${encodeURIComponent(form.dataset.dispute)}/dispute`, { complaint: form.complaint.value });
    msg.textContent = r.status === 'refunded' ? 'Upheld. The money is back in your wallet.' : 'Rejected. See the reason above.';
  } catch (e) { msg.textContent = e.message; btn.disabled = false; }
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') $('drawerRoot').innerHTML = ''; });

/* ---------- State sync ---------- */
function applyEscrow(e) {
  const prev = S.escrows.get(e.id)?.status;
  S.escrows.set(e.id, e);
  upsertLedger(e);
  S.grids.ledger.setGridOption('pinnedBottomRowData', ledgerTotals());
  S.net?.onEscrow({ ...e, buyerName: agentName(e.channel) }, prev);
  if (!prev && e.parentEscrowId) {
    const hirer = S.sellerDir.find(s => s.id === e.channel)?.name || 'A seller';
    appendLog({ kind: 'chain', at: e.createdAt, text: `${hirer} hired ${e.sellerName} for ${e.serviceName} (${money(e.priceCents)}) to finish your job. Your limits and rules apply.` }, true);
  }
  if (e.status === 'refunded' && prev === 'disputed') S.net?.narrate(`Dispute upheld: ${money(e.priceCents)} taken back from ${e.sellerName}`);
  if (e.status === 'awaiting_approval' && prev !== e.status) announce(`${agentName(e.channel)} needs your approval for ${money(e.priceCents)}`);
  renderApprovals();
  if ($('drawerRoot').querySelector(`.drawer[data-id="${CSS.escape(e.id)}"]`)) openDrawer(e.id);
  scheduleDerived();
}

function applyService(svc) {
  const i = S.services.findIndex(s => s.id === svc.id);
  if (i >= 0) S.services[i] = svc; else S.services.push(svc);
  upsert(S.grids.market, svc);
  scheduleDerived();
}

function applySettlement(d) {
  const i = S.settlements.findIndex(s => s.id === d.id);
  if (i >= 0) S.settlements[i] = d; else S.settlements.push(d);
  upsert(S.grids.settle, d);
  S.net?.onSettlement(d);
  scheduleDerived();
}

function handle(evt) {
  $('lastEvent').textContent = `Last update ${clock(evt.at)}`;
  const d = evt.data;
  switch (evt.type) {
    case 'escrow': applyEscrow(d); break;
    case 'balances': S.balances = d; renderKpis(); break;
    case 'mandate': S.mandate = d; fillMandate(false); renderKpis(); break;
    case 'service': applyService(d); break;
    case 'settlement': applySettlement(d); break;
    case 'funding':
      S.fundings.push(d);
      if (d.source === 'simulated') { upsert(S.grids.settle, settleRows().find(r => r.id === d.id)); S.net?.send('paypal', 'hub', getComputedStyle(document.documentElement).getPropertyValue('--ink-2'), { size: 6 }); }
      break;
    case 'risk':
      appendLog({ kind: 'risk', at: evt.at, text: d.kind === 'seller_suspended' ? `${d.sellerName} has been suspended. ${d.reason}.` : `${d.sellerName} was reinstated on probation.` }, true);
      S.net?.narrate(d.kind === 'seller_suspended' ? `Risk engine suspended ${d.sellerName}` : `${d.sellerName} reinstated`);
      announce(d.kind === 'seller_suspended' ? `${d.sellerName} suspended by the risk engine` : `${d.sellerName} reinstated`);
      break;
    case 'run': renderRun(d); break;
    case 'agent_log': appendLog(d, true); break;
    case 'webhook': S.webhookCount += 1; renderWebhooks(); break;
    case 'policy': S.policy = d; renderRules(); break;
    case 'autotopup': S.autoTopUp = d && { ...d, chargesToday: (d.charges || []).filter(c => c.at.startsWith(new Date().toISOString().slice(0, 10))).length }; renderAutoTopUp(); break;
    case 'sellers': S.sellerDir = d; syncNetworkAgents(); scheduleDerived(); break;
    default: break;
  }
}

function syncNetworkAgents() {
  const sellers = sellerRollup();
  const shown = [...sellers.filter(s => !s.custom), ...sellers.filter(s => s.custom).slice(-4)];
  // Each seller sits in the department of the work it sells most, so the map reads as clusters.
  const DEPT = { 'Translate': 'Translation', 'Understand text': 'Text & sentiment', 'Research': 'Research', 'Risk & compliance': 'Risk & finance', 'Finance ops': 'Risk & finance', 'Create': 'Create', 'Customer support': 'Support & work', 'Work & productivity': 'Support & work' };
  const ORDER = ['Translation', 'Text & sentiment', 'Research', 'Risk & finance', 'Create', 'Support & work', 'Low cost', 'Community', 'Other'];
  const dept = s => {
    if (s.custom) return 'Community';
    if (s.simulatedFaults) return 'Low cost';
    const count = {};
    for (const svc of S.services) if (svc.sellerId === s.id) { const d = DEPT[svc.group] || 'Other'; count[d] = (count[d] || 0) + 1; }
    return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other';
  };
  const nodes = shown.map(s => ({ id: s.id, name: s.name, glyph: s.glyph, category: s.category, group: dept(s), services: s.services }))
    .sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
  S.net?.setAgents(
    [...S.agents.map(a => ({ id: a.id, name: a.name, glyph: a.glyph, role: a.role })), { id: 'api', name: 'Outside agents', glyph: 'API', role: 'MCP and API' }],
    nodes,
  );
  const langs = new Set(S.services.filter(s => String(s.skill).startsWith('translate')).map(s => s.skill)).size;
  $('networkStats').innerHTML = [
    [S.agents.length + 1, 'buyers'], [sellers.length, 'sellers'], [S.services.length, 'services'],
    [new Set(S.services.map(s => s.skill)).size, 'skills'], [langs, 'languages'],
  ].map(([v, k]) => `<span><b>${v}</b>${k}</span>`).join('');
}

function renderRules() {
  const p = S.policy;
  $('rulesClear').hidden = !p;
  if (p && document.activeElement !== $('rulesText')) $('rulesText').value = p.text;
  $('rulesList').innerHTML = p
    ? p.summary.map(s => `<li>${esc(s)}<span class="src">Claude</span></li>`).join('') + (p.unsupported || []).map(s => `<li class="unsupported">Could not apply: ${esc(s)}</li>`).join('')
    : '';
}

function renderAutoTopUp() {
  const a = S.autoTopUp;
  const box = $('autoTopUpStatus');
  box.hidden = !a?.enabled;
  if (a?.enabled) {
    box.innerHTML = `<span><b class="brand-paypal">Auto top-up on</b> · ${money(a.amountCents)} from ${esc(a.payer || 'your PayPal')} ${esc(a.vaultHint || '')} · ${a.chargesToday || 0} today</span><button class="link-btn" type="button" id="autoTopUpOff">Turn off</button>`;
  }
}

async function loadState() {
  const st = await api('GET', '/api/state');
  S.balances = st.balances; S.mandate = st.mandate; S.services = st.services; S.sellerDir = st.sellerDirectory || [];
  S.settlements = st.settlements; S.fundings = st.fundings; S.policy = st.policy; S.autoTopUp = st.autoTopUp;
  S.escrows = new Map(st.escrows.map(e => [e.id, e]));
  S.ledgerIds = new Set(st.escrows.map(e => e.id));
  S.grids.ledger.setGridOption('rowData', st.escrows);
  $('walletText').textContent = S.config.walletMode === 'per-visitor' ? 'Your private demo wallet' : 'Owner wallet';
  renderRules();
  renderAutoTopUp();
  S.grids.ledger.setGridOption('pinnedBottomRowData', ledgerTotals());
  S.grids.market.setGridOption('rowData', [...st.services].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name) || a.priceCents - b.priceCents));
  S.grids.settle.setGridOption('rowData', settleRows());
  $('logList').innerHTML = '';
  $('logEmpty').hidden = st.logs.length > 0;
  st.logs.forEach(l => appendLog(l, false));
  st.runs.forEach(renderRun);
  S.webhookCount = (st.webhooks || []).length;
  renderWebhooks();
  fillMandate(true);
  renderKpis();
  renderApprovals();
  syncNetworkAgents();
  renderDerived();
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('connText').textContent = 'Live'; $('liveDot').style.background = 'var(--good)'; loadState().catch(() => {}); };
  es.onerror = () => { $('connText').textContent = 'Reconnecting'; $('liveDot').style.background = 'var(--warn)'; };
  es.onmessage = m => { try { handle(JSON.parse(m.data)); } catch (err) { console.error(err); } };
}

function renderWebhooks() {
  if (!S.config) return;
  $('webhookText').textContent = S.config.webhooks ? `Webhooks on · ${S.webhookCount} verified` : 'Webhooks off';
}

/* ---------- PayPal funding ---------- */
function loadPayPalSdk(clientId) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('The PayPal button could not load. Check your connection and refresh.'));
    document.head.appendChild(s);
  });
}

async function setupPayPal() {
  const box = $('fundNotice');
  if (!S.config.paypalConfigured) { notice(box, 'PayPal keys are missing on the server. Add them to .env to enable real top-ups.', 'bad'); return; }
  try {
    await loadPayPalSdk(S.config.paypalClientId);
    window.paypal.Buttons({
      style: { layout: 'horizontal', color: 'black', shape: 'rect', label: 'paypal', height: 44, tagline: false },
      createOrder: async () => (await api('POST', '/api/funding/orders', { amount: S.amount, autoTopUp: $('autoTopUp').checked })).id,
      onApprove: async data => {
        notice(box, 'Confirming your payment with PayPal');
        try {
          const r = await api('POST', `/api/funding/orders/${encodeURIComponent(data.orderID)}/capture`);
          const auto = r.autoTopUp?.enabled ? ' Auto top-up is on: you will not need to approve again.' : r.autoTopUp?.error ? ` Auto top-up not enabled: ${r.autoTopUp.error}` : '';
          notice(box, `Added ${money(r.funding.cents)} from ${r.funding.payer || 'your PayPal account'}. PayPal capture ${r.funding.captureId}.${auto}`, r.autoTopUp?.error ? '' : 'good');
        } catch (e) { notice(box, `PayPal could not complete the payment: ${e.message}`, 'bad'); }
      },
      onCancel: () => notice(box, 'Top-up cancelled. Nothing was charged.'),
      onError: err => notice(box, `PayPal error: ${err?.message || err}`, 'bad'),
    }).render('#paypalButtons');
  } catch (e) {
    notice(box, e.message, 'bad');
  }
}

/* ---------- Controls ---------- */
function segmented(groupId, attr, onPick) {
  $(groupId).addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    $(groupId).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    onPick(b.dataset[attr]);
  });
}

segmented('amountCtrl', 'amount', v => { S.amount = Number(v); });
segmented('statusCtrl', 'status', v => { S.statusFilter = v; S.grids.ledger.onFilterChanged(); });
$('ledgerSearch').addEventListener('input', e => S.grids.ledger.setGridOption('quickFilterText', e.target.value));
$('exportCsv').addEventListener('click', () => S.grids.ledger.exportDataAsCsv({
  fileName: `agentpay-payments-${new Date().toISOString().slice(0, 10)}.csv`,
  processCellCallback: p => (p.column.getColDef().field === 'priceCents' ? (p.value / 100).toFixed(2) : p.value),
}));

$('simFund').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/funding/simulated', { amount: S.amount });
    notice($('fundNotice'), `Added ${money(r.funding.cents)} of demo credit. This is not a PayPal payment.`);
  } catch (e) { notice($('fundNotice'), e.message, 'bad'); }
});

$('mandateForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const body = { perCallMax: $('mPerCall').value, dailyCap: $('mDaily').value, approvalThreshold: $('mApprove').value, maxPerMinute: $('mVelocity').value };
  try { await api('PUT', '/api/mandate', body); $('mandateMsg').textContent = 'Saved. Applies from the next purchase.'; }
  catch (e) { $('mandateMsg').textContent = e.message; }
});

$('autoTopUpStatus').addEventListener('click', async e => {
  if (!e.target.closest('#autoTopUpOff')) return;
  try { await api('DELETE', '/api/funding/auto-topup'); notice($('fundNotice'), 'Auto top-up is off and the saved PayPal permission was removed.'); }
  catch (err) { notice($('fundNotice'), err.message, 'bad'); }
});

$('rulesApply').addEventListener('click', async () => {
  const btn = $('rulesApply');
  btn.disabled = true;
  $('rulesMsg').textContent = 'Claude is turning your words into rules';
  try {
    const p = await api('POST', '/api/policy', { text: $('rulesText').value });
    $('rulesMsg').textContent = `${p.rules.length} rule${p.rules.length === 1 ? '' : 's'} active. Every purchase is checked against them.`;
  } catch (e) { $('rulesMsg').textContent = e.message; }
  btn.disabled = false;
});

$('rulesClear').addEventListener('click', async () => {
  try { await api('DELETE', '/api/policy'); $('rulesText').value = ''; $('rulesMsg').textContent = 'Rules removed.'; } catch (e) { $('rulesMsg').textContent = e.message; }
});

$('ownInputs').addEventListener('change', e => {
  $('ownInputsBox').hidden = !e.target.checked;
  if (e.target.checked) $('inputs').focus();
});

segmented('viewCtrl', 'view', v => applyLedgerView(v));

$('listForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const msg = $('lfMsg');
  msg.textContent = 'Listing';
  try {
    await api('POST', '/api/sellers/quick-register', { name: $('lfName').value, skill: $('lfSkill').value, price_usd: $('lfPrice').value, email: $('lfEmail').value || undefined });
    msg.textContent = `Listed. Agents can hire ${$('lfName').value} now.`;
    $('lfName').value = '';
  } catch (e) { msg.textContent = e.message; }
});

$('runBtn').addEventListener('click', async () => {
  $('runMsg').textContent = '';
  const documents = $('ownInputs').checked ? $('inputs').value.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean) : undefined;
  if ($('ownInputs').checked && !documents.length) { $('runMsg').textContent = 'Paste at least one input, or untick "Use my own inputs".'; return; }
  $('runBtn').disabled = true;
  try {
    await api('POST', '/api/agent/run', { agentId: S.agentId, goal: $('goal').value, documents });
    $('runMsg').textContent = '';
    $('reportBody').className = 'report muted';
    $('reportBody').textContent = 'Working. The result appears here when the agent finishes.';
    $('reportMeta').textContent = '';
    document.getElementById('live').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('runMsg').textContent = e.message;
    $('runBtn').disabled = false;
  }
});

async function settleNow(btn) {
  btn.disabled = true;
  const box = $('settleNotice');
  notice(box, 'Paying out through PayPal');
  try {
    const r = await api('POST', '/api/settle');
    const all = [...r.payouts, ...r.refunds];
    const label = { payout: 'Payout to sellers', refund: 'Refund to you' };
    const parts = all.map(s => {
      const head = `${label[s.kind] || s.kind} ${money(s.cents)}`;
      if (s.status === 'failed') return `${head} failed: ${s.detail}`;
      if (s.status === 'REGION_BLOCKED') return `${head} not sent: ${s.detail}`;
      if (s.source === 'simulated') return `${head} released (demo credit, no PayPal call)`;
      return `${head} sent on PayPal (${s.paypalId}, ${s.status})`;
    });
    const tone = all.some(s => s.status === 'failed') ? 'bad' : all.some(s => s.status === 'REGION_BLOCKED') ? '' : 'good';
    notice(box, parts.length ? parts.join(' · ') : 'Nothing to pay out: no approved work and no unspent money.', tone);
  } catch (e) { notice(box, e.message, 'bad'); }
  btn.disabled = false;
}
$('settleBtn').addEventListener('click', e => settleNow(e.currentTarget));
$('settleTop').addEventListener('click', e => { document.getElementById('settlement').scrollIntoView({ behavior: 'smooth' }); settleNow(e.currentTarget); });

/* ---------- Boot ---------- */
(async function boot() {
  S.grids.ledger = makeLedgerGrid();
  S.grids.market = makeMarketGrid();
  S.grids.settle = makeSettleGrid();
  S.net = new window.AgentNetwork($('network'), $('networkCaption'));
  try {
    S.config = await api('GET', '/api/config');
  } catch {
    $('connText').textContent = 'Server unreachable';
    return;
  }
  S.agents = S.config.agents || [];
  $('modelText').textContent = `AI: ${S.config.model}`;
  renderWebhooks();
  renderAgents();
  $('lfSkill').innerHTML = (S.config.skills || []).map(s => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.group)}</option>`).join('');
  applyLedgerView(store.get('agentpay.ledgerView') || 'simple');
  $('simBox').hidden = !S.config.demoFunding;
  setupPayPal();
  connect();
})();
