const axios = require('axios');
const crypto = require('crypto');
const { PAYPAL_BASE, PAYPAL_CLIENT_ID, PAYPAL_SECRET } = require('./config');

let token = { value: null, expiresAt: 0 };

class PayPalError extends Error {
  constructor(status, data) {
    const detail = data?.details?.[0];
    super(detail?.description || data?.message || data?.error_description || `PayPal request failed (${status})`);
    this.status = status;
    this.name = data?.name || detail?.issue || 'PAYPAL_ERROR';
    this.issue = detail?.issue || data?.name || null;
    this.debugId = data?.debug_id || null;
  }
}

async function accessToken() {
  if (token.value && Date.now() < token.expiresAt) return token.value;
  const res = await axios.post(`${PAYPAL_BASE}/v1/oauth2/token`, 'grant_type=client_credentials', {
    auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_SECRET },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  token = { value: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in - 60) * 1000 };
  return token.value;
}

async function call(method, path, body, requestId) {
  const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  try {
    const res = await axios({ method, url: `${PAYPAL_BASE}${path}`, data: body, headers, timeout: 20000 });
    return res.data;
  } catch (e) {
    if (e.response) throw new PayPalError(e.response.status, e.response.data);
    throw e;
  }
}

const money = cents => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) });

const purchaseUnit = (cents, walletId, description) => ({
  reference_id: walletId.slice(0, 256),
  custom_id: walletId.slice(0, 127),
  description,
  amount: money(cents),
});

// Owner tops up the agent wallet; the buyer approves in PayPal Checkout (JS SDK) before capture.
// With `vault`, the same approval also saves the PayPal account for merchant-initiated top-ups
// (Vault v3, "save PayPal with purchase", usage MERCHANT), so the owner approves only once.
function createWalletOrder(cents, walletId, { vault = false, returnUrl } = {}) {
  const body = {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(cents, walletId, 'AgentPay agent wallet top-up (spending mandate)')],
  };
  if (vault) {
    body.payment_source = {
      paypal: {
        attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } },
        experience_context: {
          return_url: returnUrl, cancel_url: returnUrl, shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW', brand_name: 'AgentPay',
        },
      },
    };
  }
  return call('POST', '/v2/checkout/orders', body, `topup-${crypto.randomUUID()}`);
}

function parseCapture(data) {
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  const vault = data.payment_source?.paypal?.attributes?.vault;
  return {
    orderId: data.id,
    status: data.status,
    captureId: capture?.id || null,
    captureStatus: capture?.status || null,
    cents: capture ? Math.round(Number(capture.amount.value) * 100) : 0,
    payer: data.payer?.email_address || data.payment_source?.paypal?.email_address || null,
    vaultId: vault?.id || null,
    vaultStatus: vault?.status || null,
    customerId: vault?.customer?.id || null,
  };
}

async function captureOrder(orderId) {
  return parseCapture(await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `capture-${orderId}`));
}

// Merchant-initiated top-up from the saved PayPal account: no buyer present, bounded by the owner's mandate.
async function chargeVault(vaultId, cents, walletId) {
  const data = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(cents, walletId, 'AgentPay automatic top-up (approved once by owner)')],
    payment_source: { paypal: { vault_id: vaultId } },
  }, `auto-topup-${crypto.randomUUID()}`);
  if (data.status === 'COMPLETED') return parseCapture(data);
  return captureOrder(data.id);
}

async function deleteVaultToken(vaultId) {
  await call('DELETE', `/v3/vault/payment-tokens/${encodeURIComponent(vaultId)}`);
}

// Unused mandate balance goes back to the owner's PayPal account.
async function refundCapture(captureId, cents, note) {
  const data = await call('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    amount: money(cents),
    note_to_payer: note.slice(0, 255),
  }, `refund-${captureId}-${cents}-${Date.now()}`);
  return { refundId: data.id, status: data.status };
}

// Verified seller earnings are paid out in one batch instead of one PayPal transaction per agent call.
async function payoutBatch(items, batchId) {
  const data = await call('POST', '/v1/payments/payouts', {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: 'AgentPay: verified agent earnings',
      email_message: 'Earnings for AI work that passed AgentPay verification.',
    },
    items: items.map(i => ({
      recipient_type: 'EMAIL',
      receiver: i.email,
      amount: { currency: 'USD', value: (i.cents / 100).toFixed(2) },
      note: i.note.slice(0, 4000),
      sender_item_id: i.id,
    })),
  });
  return { batchId: data.batch_header?.payout_batch_id, status: data.batch_header?.batch_status };
}

async function getPayoutBatch(batchId) {
  const data = await call('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
  return {
    status: data.batch_header?.batch_status,
    items: (data.items || []).map(i => ({ id: i.payout_item_id, status: i.transaction_status, receiver: i.payout_item?.receiver })),
  };
}

// PayPal signs every webhook; we ask PayPal to confirm the signature before trusting the event.
async function verifyWebhookSignature(headers, event, webhookId) {
  const data = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: event,
  });
  return data.verification_status === 'SUCCESS';
}

module.exports = {
  createWalletOrder, captureOrder, chargeVault, deleteVaultToken, refundCapture, payoutBatch, getPayoutBatch, verifyWebhookSignature,
  PayPalError, configured: () => !!(PAYPAL_CLIENT_ID && PAYPAL_SECRET),
};
