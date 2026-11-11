const axios = require('axios');
const { INTERNAL_URL } = require('./config');
const registry = require('./registry');
const ledger = require('./ledger');
const judge = require('./judge');
const policy = require('./policy');
const paypal = require('./paypal');
const x402 = require('../sdk/x402');

const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_AUTO_TOPUPS_PER_DAY = 3;

const endpointUrl = svc => (/^https?:\/\//.test(svc.endpoint) ? svc.endpoint : `${INTERNAL_URL}${svc.endpoint}`);

function result(wallet, escrow, extra = {}) {
  const b = wallet.balances();
  return {
    escrow_id: escrow?.id || null,
    status: escrow?.status || 'error',
    cost_usd: escrow?.status === 'released' ? escrow.priceCents / 100 : 0,
    wallet_available_usd: b.availableCents / 100,
    ...extra,
  };
}

const decode = (res, header) => {
  try {
    const h = res.headers?.[header.toLowerCase()];
    return h ? x402.decode(h) : null;
  } catch {
    return null;
  }
};

// Owner approved once (PayPal Vault). Top up from the saved account when the wallet runs dry,
// never beyond the daily budget and at most a few times a day.
async function autoTopUp(wallet, neededCents) {
  const a = wallet.autoTopUp;
  if (!a?.enabled) return null;
  const today = ledger.today();
  if (a.charges.filter(c => c.at.startsWith(today)).length >= MAX_AUTO_TOPUPS_PER_DAY) return { error: `Auto top-up limit of ${MAX_AUTO_TOPUPS_PER_DAY} per day reached` };
  const cents = Math.max(a.amountCents, neededCents);
  try {
    const c = await paypal.chargeVault(a.vaultId, cents, wallet.id);
    if (!['COMPLETED', 'PENDING'].includes(c.captureStatus)) return { error: `PayPal returned ${c.captureStatus || c.status}` };
    a.charges.push({ at: new Date().toISOString(), cents: c.cents, captureId: c.captureId });
    wallet.addFunding({ source: 'paypal', orderId: c.orderId, captureId: c.captureId, cents: c.cents, status: c.captureStatus, payer: c.payer || a.payer, auto: true });
    wallet.addSettlement({ kind: 'auto_capture', source: 'paypal', paypalId: c.captureId, cents: c.cents, status: c.captureStatus, detail: 'Automatic top-up from your saved PayPal account (approved once)' });
    wallet.setAutoTopUp(a);
    return { cents: c.cents };
  } catch (e) {
    return { error: `${e.issue || e.name}: ${e.message}` };
  }
}

// 402 quote -> risk engine -> owner rules -> mandate (auto top-up) -> escrow -> approval -> paid retry -> AI check.
async function purchase({ wallet, serviceId, text, reason, runId, channel = 'agent', parentEscrowId = null }) {
  const svc = registry.get(serviceId);
  if (!svc) return { status: 'error', note: `Unknown service_id "${serviceId}". Call search_services first.` };
  if (typeof text !== 'string' || !text.trim()) return { status: 'error', note: 'text is required' };
  if (text.length > 6000) return { status: 'error', note: 'text is longer than 6000 characters' };

  const base = {
    runId: runId || null, channel, parentEscrowId, serviceId: svc.id, serviceName: svc.name, skill: svc.skill, group: svc.group,
    sellerId: svc.sellerId, sellerName: svc.sellerName, sellerEmail: svc.sellerEmail,
    priceCents: svc.priceCents, input: text, reason: reason ? String(reason).slice(0, 300) : null,
    quote: null, receipt: null,
  };
  const block = note => result(wallet, wallet.createEscrow(base, 'blocked', note), { note });

  if (registry.isSuspended(svc.sellerId)) return block(`Seller suspended by the AgentPay risk engine: ${registry.getSeller(svc.sellerId).suspendedReason}`);

  const quoteRes = await axios.post(endpointUrl(svc), { text }, { timeout: 10000, validateStatus: () => true })
    .catch(err => ({ status: 0, headers: {}, data: { error: err.message } }));
  const challenge = quoteRes.status === 402 ? (decode(quoteRes, x402.HEADERS.required) || quoteRes.data) : null;
  const accepted = challenge?.accepts?.find(a => a.scheme === x402.SCHEME);
  if (!accepted) return block(quoteRes.status === 402 ? 'Seller does not accept the paypal-escrow scheme' : `Seller did not return a 402 quote (HTTP ${quoteRes.status})`);
  base.quote = accepted;
  if (Number(accepted.amount) !== svc.priceCents || accepted.asset !== 'USD') {
    return block(`Seller quoted ${accepted.amount} ${accepted.asset} cents but lists ${ledger.usd(svc.priceCents)}. Blocked as bait pricing`);
  }

  const rules = policy.evaluate(wallet, svc);
  if (rules.block) return block(rules.block);

  let check = wallet.policyCheck(svc.priceCents);
  if (!check.ok && check.code === 'funds') {
    const topUp = await autoTopUp(wallet, svc.priceCents);
    if (topUp?.cents) check = wallet.policyCheck(svc.priceCents);
    else if (topUp?.error) check = { ...check, reason: `${check.reason}. Auto top-up failed: ${topUp.error}` };
  }
  if (!check.ok) {
    const e = wallet.createEscrow(base, 'blocked', check.reason);
    return result(wallet, e, { note: `Blocked by the owner's limits: ${check.reason}` });
  }

  let escrow = wallet.createEscrow(base, 'held', `402 quote of ${ledger.usd(svc.priceCents)} accepted, funds held`);

  const approvalWhy = svc.priceCents >= wallet.mandate.approvalThresholdCents
    ? `At or above the ${ledger.usd(wallet.mandate.approvalThresholdCents)} approval threshold`
    : rules.approve;
  if (approvalWhy) {
    wallet.setStatus(escrow.id, 'awaiting_approval', { approvalReason: approvalWhy }, approvalWhy);
    const decision = await ledger.waitForApproval(escrow.id, APPROVAL_TIMEOUT_MS);
    if (!decision.approved) {
      escrow = wallet.setStatus(escrow.id, 'rejected', {}, decision.note);
      return result(wallet, escrow, { note: decision.note });
    }
    wallet.setStatus(escrow.id, 'held', {}, decision.note);
  }

  wallet.setStatus(escrow.id, 'locked', {}, 'Payment signature issued to seller');

  const started = Date.now();
  const delivery = await axios.post(endpointUrl(svc), { text }, {
    headers: { [x402.HEADERS.signature]: x402.encode(x402.paymentPayload(accepted, escrow.id)) },
    timeout: 240000,
    validateStatus: () => true,
  }).catch(err => ({ status: 0, headers: {}, data: { error: err.message } }));
  const latencyMs = Date.now() - started;
  const receipt = decode(delivery, x402.HEADERS.response);

  if (delivery.status !== 200) {
    const note = `Seller failed to deliver (${delivery.data?.error || `HTTP ${delivery.status}`}). Funds returned`;
    escrow = wallet.setStatus(escrow.id, 'refunded', { latencyMs, receipt, verdict: { pass: false, score: 0, reason: note, method: 'delivery' } }, note);
    registry.record(svc.id, { pass: false, ms: latencyMs });
    return result(wallet, escrow, { note });
  }

  const output = delivery.data.output;
  wallet.setStatus(escrow.id, 'delivered', { output, latencyMs, receipt }, 'Work delivered with x402 payment receipt');
  wallet.setStatus(escrow.id, 'verifying', {}, 'AI quality check running');

  let verdict;
  try {
    verdict = await judge.verify(svc, text, output);
  } catch (err) {
    verdict = { pass: false, score: 0, reason: `Quality check unavailable (${err.message}). Funds returned to be safe`, method: 'ai' };
  }

  escrow = wallet.setStatus(escrow.id, verdict.pass ? 'released' : 'refunded', { verdict },
    verdict.pass ? `Quality check passed. ${ledger.usd(svc.priceCents)} released to ${svc.sellerName}` : `Quality check failed. ${ledger.usd(svc.priceCents)} returned to wallet`);
  registry.record(svc.id, { pass: verdict.pass, ms: latencyMs });

  return result(wallet, escrow, {
    verifier: verdict,
    output: verdict.pass ? output : undefined,
    note: verdict.pass ? 'Delivered and verified' : `Refunded: ${verdict.reason}`,
  });
}

// Owner dispute: possible on released work until it is paid out. An upheld dispute claws the money back.
async function dispute(wallet, escrowId, complaint) {
  const e = wallet.getEscrow(escrowId);
  if (!e) throw Object.assign(new Error('Payment not found'), { status: 404 });
  if (e.status !== 'released') throw Object.assign(new Error('Only paid work can be disputed'), { status: 409 });
  if (e.settled) throw Object.assign(new Error('This payment was already paid out to the seller, so the dispute window has closed'), { status: 409 });
  const text = String(complaint || '').trim();
  if (text.length < 8) throw Object.assign(new Error('Tell us what is wrong in a sentence'), { status: 400 });
  const svc = registry.get(e.serviceId);

  wallet.setStatus(e.id, 'disputed', { dispute: { complaint: text.slice(0, 500), openedAt: new Date().toISOString(), outcome: null } }, `Owner disputed: "${text.slice(0, 140)}"`);
  let review;
  try {
    review = await judge.reviewDispute(svc, e.input, e.output, text);
  } catch (err) {
    review = { upheld: false, reason: `Review unavailable (${err.message}). Payment stays released; try again` };
  }
  const outcome = { ...e.dispute, outcome: review.upheld ? 'upheld' : 'rejected', reason: review.reason, decidedAt: new Date().toISOString() };
  if (review.upheld) {
    registry.recordDisputeUpheld(svc.id);
    return wallet.setStatus(e.id, 'refunded', { dispute: outcome, verdict: { ...e.verdict, pass: false, reason: `Dispute upheld: ${review.reason}`, method: 'dispute' } },
      `Dispute upheld. ${ledger.usd(e.priceCents)} taken back from ${e.sellerName}`);
  }
  return wallet.setStatus(e.id, 'released', { dispute: outcome }, `Dispute rejected: ${review.reason}`);
}

// x402 facilitator check: is this escrow token valid payment for these requirements?
function verifyPayment(paymentPayload, requirements) {
  if (!paymentPayload || paymentPayload.scheme !== x402.SCHEME) return { isValid: false, invalidReason: 'Unsupported scheme' };
  const found = ledger.findEscrow(paymentPayload.payload?.escrowId);
  if (!found) return { isValid: false, invalidReason: 'Unknown escrow' };
  const e = found.escrow;
  if (e.status !== 'locked') return { isValid: false, invalidReason: `Escrow is ${e.status}` };
  if (e.serviceId !== requirements?.extra?.serviceId) return { isValid: false, invalidReason: 'Escrow is for a different service' };
  if (e.priceCents !== Number(requirements?.amount)) return { isValid: false, invalidReason: 'Escrow amount does not match the price' };
  return { isValid: true, payer: found.wallet.id };
}

module.exports = { purchase, dispute, verifyPayment, autoTopUp };
