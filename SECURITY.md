# Security

AgentPay runs on the **PayPal sandbox** only. It never handles real money or real card data.

## Keys and secrets

- PayPal and Anthropic keys are read from environment variables (`.env` locally, the Render dashboard in production). They are never committed: `.gitignore` excludes every `.env` file except the empty `.env.example` template.
- Keys stay on the server. The browser only ever receives the public PayPal client ID that the JavaScript SDK needs.
- Outside agents and seller registration must send `AGENTPAY_API_KEY`, compared in constant time. With no key set, only local callers are accepted.
- PayPal webhooks are trusted only after PayPal verifies their signature, and each event is processed once.

## Reporting a problem

Please open a GitHub issue without including any keys, or contact the maintainer through their GitHub profile.
