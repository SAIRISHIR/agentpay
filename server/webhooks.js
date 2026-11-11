const paypal = require('./paypal');
const ledger = require('./ledger');
const { publish } = require('./events');
const { PAYPAL_WEBHOOK_ID } = require('./config');

const seen = new Set();
const log = [];

function idFor(event) {
  const r = event.resource || {};
  if (event.event_type?.startsWith('PAYMENT.PAYOUTSBATCH')) return r.batch_header?.payout_batch_id;
  if (event.event_type?.startsWith('PAYMENT.PAYOUTS-ITEM')) return r.payout_batch_id;
  return r.id;
}

function statusFor(event) {
  const r = event.resource || {};
  if (event.event_type?.startsWith('PAYMENT.PAYOUTSBATCH')) return r.batch_header?.batch_status;
  if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') return 'COMPLETED';
  return r.status || null;
}

// Handles a PayPal webhook: verify the signature with PayPal, dedupe by event id,
// then update the matching settlement row (capture, refund or payout batch).
async function handle(headers, rawBody) {
  if (!PAYPAL_WEBHOOK_ID) return { status: 503, body: { error: 'Webhook verification is not configured (set PAYPAL_WEBHOOK_ID)' } };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'Body is not JSON' } }; }

  const ok = await paypal.verifyWebhookSignature(headers, event, PAYPAL_WEBHOOK_ID).catch(() => false);
  if (!ok) return { status: 401, body: { error: 'Signature verification failed' } };
  if (seen.has(event.id)) return { status: 200, body: { duplicate: true } };
  seen.add(event.id);

  const paypalId = idFor(event);
  const status = statusFor(event);
  let matched = null;
  let walletId = null;
  if (paypalId) {
    for (const w of ledger.allWallets()) {
      const rec = w.settlements.find(s => s.paypalId === paypalId);
      if (!rec) continue;
      walletId = w.id;
      matched = status && rec.status !== status ? w.updateSettlement(rec.id, { status, webhook: event.event_type }) : rec;
      break;
    }
  }
  const entry = { id: event.id, type: event.event_type, paypalId, status, matched: !!matched, walletId, at: new Date().toISOString() };
  log.push(entry);
  if (log.length > 200) log.shift();
  publish('webhook', entry, walletId);
  return { status: 200, body: { received: true } };
}

module.exports = { handle, log: walletId => log.filter(e => e.walletId === walletId), enabled: () => !!PAYPAL_WEBHOOK_ID };
