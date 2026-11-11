const { publish } = require('./events');
const { SUSPENSION_MINUTES } = require('./config');

// Risk engine: a seller whose verified pass rate falls below this after enough deliveries is suspended.
const MIN_JUDGED = 5;
const MIN_PASS_RATE = 0.4;

const services = new Map();
const sellers = new Map(); // id -> { id, name, email, external, suspended, suspendedReason, suspendedAt }

function registerSeller({ id, name, email, external, custom, category, tagline, glyph, simulatedFaults, createdAt }) {
  const prev = sellers.get(id);
  sellers.set(id, {
    id, name, email, external: !!external, custom: !!custom, createdAt: createdAt || prev?.createdAt || new Date().toISOString(),
    category: category || 'Independent seller', tagline: tagline || '', glyph: glyph || name.slice(0, 2).toUpperCase(),
    simulatedFaults: !!simulatedFaults,
    suspended: prev?.suspended || false, suspendedReason: prev?.suspendedReason || null, suspendedAt: prev?.suspendedAt || null,
  });
}

function listSellers() {
  return [...sellers.values()].map(s => {
    const st = sellerStats(s.id);
    const svc = [...services.values()].filter(x => x.sellerId === s.id);
    return {
      ...s, services: svc.length, calls: svc.reduce((a, x) => a + x.calls, 0),
      passRate: st.passRate, judged: st.judged,
      minPriceCents: svc.length ? Math.min(...svc.map(x => x.priceCents)) : null,
      maxPriceCents: svc.length ? Math.max(...svc.map(x => x.priceCents)) : null,
    };
  });
}

function register(s) {
  const prev = services.get(s.id);
  services.set(s.id, { calls: 0, passes: 0, fails: 0, totalMs: 0, ...prev, ...s });
}

function sellerStats(sellerId) {
  let passes = 0, fails = 0;
  for (const s of services.values()) if (s.sellerId === sellerId) { passes += s.passes; fails += s.fails; }
  return { passes, fails, judged: passes + fails, passRate: passes + fails ? passes / (passes + fails) : null };
}

function view(s) {
  const judged = s.passes + s.fails;
  const seller = sellers.get(s.sellerId);
  return {
    id: s.id, skill: s.skill, name: s.name, group: s.group || 'Other', description: s.description,
    sellerId: s.sellerId, sellerName: s.sellerName, sellerEmail: s.sellerEmail, endpoint: s.endpoint,
    sellerCategory: seller?.category || null,
    external: !!seller?.external,
    priceCents: s.priceCents, calls: s.calls, passes: s.passes, fails: s.fails,
    passRate: judged ? s.passes / judged : null,
    avgMs: s.calls ? Math.round(s.totalMs / s.calls) : null,
    status: seller?.suspended ? 'suspended' : 'active',
    suspendedReason: seller?.suspended ? seller.suspendedReason : null,
  };
}

function get(id) { return services.get(id) || null; }
function getSeller(id) { return sellers.get(id) || null; }
function isSuspended(sellerId) { return !!sellers.get(sellerId)?.suspended; }

function list(query = '') {
  // Every word must appear somewhere in the listing, so "french translation" and "translate_fr" both work.
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return [...services.values()]
    .filter(s => {
      const hay = [s.name, s.skill, s.description, s.sellerName, s.group].join(' ').toLowerCase();
      return words.every(w => hay.includes(w));
    })
    .map(view);
}

function publishSeller(sellerId) {
  for (const s of services.values()) if (s.sellerId === sellerId) publish('service', view(s));
}

function record(id, { pass, ms }) {
  const s = services.get(id);
  if (!s) return;
  s.calls += 1;
  s.totalMs += ms || 0;
  if (pass === true) s.passes += 1;
  if (pass === false) s.fails += 1;
  publish('service', view(s));

  const seller = sellers.get(s.sellerId);
  const st = sellerStats(s.sellerId);
  checkSuspension(s.sellerId);
}

function checkSuspension(sellerId) {
  const seller = sellers.get(sellerId);
  const st = sellerStats(sellerId);
  if (seller && !seller.suspended && st.judged >= MIN_JUDGED && st.passRate < MIN_PASS_RATE) {
    seller.suspended = true;
    seller.suspendedAt = new Date().toISOString();
    seller.suspendedReason = `Verified pass rate ${Math.round(st.passRate * 100)}% over ${st.judged} deliveries is below the ${Math.round(MIN_PASS_RATE * 100)}% floor`;
    publish('risk', { kind: 'seller_suspended', sellerId: seller.id, sellerName: seller.name, reason: seller.suspendedReason });
    publishSeller(seller.id);
  }
}

// An upheld owner dispute turns an earlier pass into a fail, which can trigger suspension.
function recordDisputeUpheld(id) {
  const s = services.get(id);
  if (!s) return;
  if (s.passes > 0) s.passes -= 1;
  s.fails += 1;
  publish('service', view(s));
  checkSuspension(s.sellerId);
}

// Suspensions expire into probation (fresh counters) after SUSPENSION_MINUTES.
setInterval(() => {
  const cutoff = Date.now() - SUSPENSION_MINUTES * 60000;
  for (const seller of sellers.values()) {
    if (seller.suspended && Date.parse(seller.suspendedAt) < cutoff) reinstate(seller.id, 'probation');
  }
}, 30000).unref();

// Reinstated sellers start a fresh probation: their counters reset.
function reinstate(sellerId, by = 'owner') {
  const seller = sellers.get(sellerId);
  if (!seller) return false;
  seller.suspended = false;
  seller.suspendedReason = null;
  seller.suspendedAt = null;
  for (const s of services.values()) if (s.sellerId === sellerId) Object.assign(s, { calls: 0, passes: 0, fails: 0, totalMs: 0 });
  publish('risk', { kind: 'seller_reinstated', sellerId, sellerName: seller.name, by });
  publishSeller(sellerId);
  return true;
}

function dump() {
  return { services: [...services.values()], sellers: [...sellers.values()] };
}

function restore(snap) {
  if (!snap) return;
  for (const s of snap.sellers || []) {
    if (s.external || s.custom || sellers.has(s.id)) sellers.set(s.id, { ...sellers.get(s.id), ...s });
  }
  for (const s of snap.services || []) {
    if (services.has(s.id)) Object.assign(services.get(s.id), { calls: s.calls, passes: s.passes, fails: s.fails, totalMs: s.totalMs });
    else if (sellers.get(s.sellerId)?.external || sellers.get(s.sellerId)?.custom) services.set(s.id, s);
  }
}

function removeSeller(sellerId) {
  for (const [id, s] of services) if (s.sellerId === sellerId) services.delete(id);
  sellers.delete(sellerId);
}

module.exports = {
  register, registerSeller, removeSeller, listSellers, get, getSeller, list, record, recordDisputeUpheld, view,
  isSuspended, reinstate, sellerStats, dump, restore, MIN_JUDGED, MIN_PASS_RATE,
};
