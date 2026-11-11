// x402 v2 transport (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE, base64 JSON)
// with a "paypal-escrow" scheme: the payment is an AgentPay escrow funded and settled through PayPal.

const SCHEME = 'paypal-escrow';
const HEADERS = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
};

const network = (paypalBase = process.env.PAYPAL_BASE || '') => (/sandbox/.test(paypalBase) || !paypalBase ? 'paypal-sandbox' : 'paypal');

const encode = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const decode = str => JSON.parse(Buffer.from(String(str), 'base64').toString('utf8'));

function requirements({ serviceId, priceCents, payTo, facilitator, maxTimeoutSeconds = 60 }) {
  return {
    scheme: SCHEME,
    network: network(),
    amount: String(priceCents),
    asset: 'USD',
    payTo,
    maxTimeoutSeconds,
    extra: {
      serviceId,
      decimals: 2,
      priceUsd: (priceCents / 100).toFixed(2),
      facilitator,
      settlement: 'Escrow released only after AI verification; settled in PayPal batches',
    },
  };
}

function paymentRequired({ resourceUrl, description, accepts, error = 'Payment required' }) {
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description, mimeType: 'application/json' },
    accepts,
  };
}

function paymentPayload(accepted, escrowId) {
  return { x402Version: 2, scheme: SCHEME, network: accepted.network, accepted, payload: { escrowId } };
}

module.exports = { SCHEME, HEADERS, network, encode, decode, requirements, paymentRequired, paymentPayload };
