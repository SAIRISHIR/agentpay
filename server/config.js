require('dotenv').config();

const PORT = Number(process.env.PORT) || 3000;
const dollars = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

module.exports = {
  PORT,
  INTERNAL_URL: `http://127.0.0.1:${PORT}`,
  PAYPAL_BASE: process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com',
  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID || '',
  PAYPAL_SECRET: process.env.PAYPAL_SECRET || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  MODEL: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
  PREMIUM_SELLER_EMAIL: process.env.AGENT_B_EMAIL || 'premium-seller@sellers.test',
  BUDGET_SELLER_EMAIL: process.env.BUDGET_SELLER_EMAIL || 'budgetbot-seller@sellers.test',
  DEMO_FUNDING: process.env.DEMO_FUNDING !== 'false',
  // "shared": one owner wallet (local use). "per-visitor": every browser gets its own wallet (hosted demo).
  WALLET_MODE: process.env.WALLET_MODE === 'per-visitor' ? 'per-visitor' : 'shared',
  MAX_WALLETS: dollars(process.env.MAX_WALLETS, 300),
  MAX_RUNS_PER_WALLET_PER_DAY: dollars(process.env.MAX_RUNS_PER_WALLET_PER_DAY, 8),
  SUSPENSION_MINUTES: dollars(process.env.SUSPENSION_MINUTES, 30),
  MAX_CUSTOM_SELLERS: dollars(process.env.MAX_CUSTOM_SELLERS, 12),
  MAX_RUNS_PER_DAY: dollars(process.env.MAX_RUNS_PER_DAY, 30),
  API_KEY: process.env.AGENTPAY_API_KEY || '',
  PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID || '',
  DATA_DIR: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
  PERSIST: process.env.PERSIST !== 'false',
  // Counterfactual used for the "fees avoided" figure: US PayPal Checkout fixed fee per transaction.
  FEE_FIXED_CENTS: Math.round(dollars(process.env.FEE_FIXED_USD, 0.49) * 100),
  DEFAULT_MANDATE: {
    perCallMax: dollars(process.env.PER_CALL_MAX, 0.10),
    dailyCap: dollars(process.env.DAILY_SPEND_CAP, 1.00),
    approvalThreshold: dollars(process.env.APPROVAL_THRESHOLD, 0.05),
    maxPerMinute: dollars(process.env.MAX_BUYS_PER_MINUTE, 30),
  },
};
