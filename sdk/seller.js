// Put any Express route behind a PayPal-settled paywall:
//   app.post('/translate', paywall({ facilitator, serviceId, priceCents, payTo }), handler)
// Unpaid calls get HTTP 402 with a quote. Paid calls carry an escrow token that the
// AgentPay facilitator verifies before the handler runs.

const x402 = require('./x402');

function paywall({ facilitator, serviceId, priceCents, payTo, description = '' }) {
  if (!facilitator || !serviceId || !Number.isInteger(priceCents) || priceCents < 1 || !payTo) {
    throw new Error('paywall needs facilitator, serviceId, priceCents (integer cents >= 1) and payTo');
  }
  const base = facilitator.replace(/\/$/, '');

  return async function agentPayPaywall(req, res, next) {
    const accepted = x402.requirements({ serviceId, priceCents, payTo, facilitator: base });
    const required = x402.paymentRequired({
      resourceUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      description,
      accepts: [accepted],
    });
    const challenge = (error) => {
      const body = error ? { ...required, error } : required;
      res.set(x402.HEADERS.required, x402.encode(body));
      return res.status(402).json(body);
    };

    const header = req.get(x402.HEADERS.signature);
    if (!header) return challenge();

    let payment;
    try { payment = x402.decode(header); } catch { return challenge('Payment header is not valid base64 JSON'); }

    let verdict;
    try {
      const r = await fetch(`${base}/api/x402/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPayload: payment, paymentRequirements: accepted }),
        signal: AbortSignal.timeout(5000),
      });
      verdict = await r.json();
    } catch (e) {
      return challenge(`Facilitator unreachable: ${e.message}`);
    }
    if (!verdict.isValid) return challenge(verdict.invalidReason || 'Payment rejected by facilitator');

    res.set(x402.HEADERS.response, x402.encode({
      success: true,
      transaction: payment.payload.escrowId,
      network: accepted.network,
      payer: verdict.payer || null,
      note: 'Funds held in escrow; released after AgentPay verification',
    }));
    req.agentpay = { escrowId: payment.payload.escrowId, serviceId, priceCents };
    return next();
  };
}

module.exports = { paywall, x402 };
