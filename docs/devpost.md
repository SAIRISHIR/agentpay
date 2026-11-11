# Devpost submission text

Paste each section into the matching Devpost field.

## Tagline

The PayPal-settled payment rail for AI agents: open 402 protocol, AI-verified escrow, owner mandates, batched settlement.

## Inspiration

AI agents are starting to hire other AI agents: one summarizes, another translates, another extracts data. Each job is worth a cent or two. PayPal's new agentic commerce services let agents buy from merchants, but nothing lets an agent pay another agent on PayPal rails. That market is forming on stablecoin protocols instead, because a $0.02 payment cannot carry a $0.49 fixed fee, nobody can judge whether AI work was any good, and owners have no way to put limits on what their agents spend.

## What it does

AgentPay is a payment rail that brings agent-to-agent commerce onto PayPal.

The demo marketplace has **14 AI seller agents offering 103 services across 64 skills**: translation into 17 languages, sentiment and emotion analysis, research briefs, fact checks, fraud and scam screening, chargeback risk, invoice extraction, ad copy, contract review and more. **Eight buyer agents** do real jobs on it:

- **Atlas** writes investor briefs.
- **Vera** runs accounts payable and caught a planted phishing invoice.
- **Nova** launches products in Spanish and Japanese.
- **Echo** triages customer support while redacting personal data, and answers each customer in their own language.
- **Iris** researches a market launch, fact-checks the claims and briefs the team in Portuguese.
- **Mira** takes one launch to France, Saudi Arabia, Germany and Korea.
- **Rhea** works a fraud and disputes queue.
- **Juno** reads reviews in several languages and finds what customers really feel.

How the rail works:

- **Open protocol.** Sellers answer unpaid calls with HTTP 402 and a price quote, using x402 v2 headers and a new `paypal-escrow` scheme. Buyers pay into escrow and retry with a payment token that AgentPay verifies.
- **Automated buyer protection.** Every payment sits in escrow until Claude verifies the delivery against the service contract. Bad work is refunded in seconds with a plain-language reason.
- **Risk engine.** Sellers whose verified pass rate falls below 40% are suspended automatically. Bait pricing is blocked.
- **Spending mandate.** The owner sets a per-call max, a daily cap, a velocity limit, and an approval threshold where the agent pauses for a human.
- **Batched PayPal settlement.** The owner funds the agent wallet through PayPal Checkout. One Payouts batch pays all sellers for verified work, and unspent budget is refunded through the Refunds API.
- **Rules in plain English.** "Never use BudgetBot. Ask me before trying a new seller." Claude compiles the owner's sentence into whitelisted rules, and shows anything it could not express instead of guessing.
- **Agent chains.** Sellers are agents too: Concierge detects a customer's language and hires the best-rated translator through AgentPay, paid from the same wallet under the same rules.
- **Disputes.** The owner can dispute a paid delivery; Claude re-reviews it and an upheld dispute claws the money back.
- **Approve once with PayPal Vault.** The owner saves PayPal once; the wallet refills itself within the daily budget.
- **Open to any agent.** An MCP server lets Claude Desktop, Cursor or any MCP client buy under the owner's mandate. A three-line Express middleware lets any API sell, and anyone can list a hosted service from the dashboard.

In our test run, 14 agent payments settled in one PayPal payout batch, avoiding $6.37 in per-transaction fixed fees. The verifier refunded 4 bad deliveries before any seller was paid, and the risk engine suspended a seller at a 20% pass rate.

## How we built it

- **PayPal:** JS SDK Smart Buttons; Orders v2 create and capture; Payments v2 refunds; Payouts v1 create batch and get batch status; Vault v3 save-with-purchase and merchant-initiated charges; webhook signature verification; OAuth. All on the sandbox, with `PayPal-Request-Id` idempotency keys.
- **AI:** Claude Haiku via the Anthropic API in five roles: eight buyer agents that use tool use to plan, compare price against verified quality, buy and retry; fourteen seller agents performing 64 skills; the escrow verifier that releases or refunds each payment; the dispute reviewer; and the compiler that turns the owner's plain-English rules into checked policy.
- **Protocol and SDK:** x402 v2 transport with a `paypal-escrow` scheme, an x402 facilitator endpoint, a seller paywall middleware and a `/.well-known/agentpay.json` discovery document.
- **MCP:** a Model Context Protocol server built with the official SDK.
- **Backend:** Node.js and Express, with Server-Sent Events, atomic state snapshots and API-key auth.
- **Frontend:** AG Grid Community for the live escrow ledger, marketplace and settlement grids, AG Charts for the trends, and a canvas map of the live agent network, in a dark monochrome design with one PayPal-blue accent. Checked against the Web Interface Guidelines and WCAG AA contrast in light and dark mode.
- **Quality:** Node test runner suite and GitHub Actions CI on Node 20 and 22.

## Challenges we ran into

- **PayPal Payouts is not available to sandbox merchants in some countries.** Our first merchant account returned `PAYOUT_NOT_AVAILABLE`. We now detect and label this, and run on a US sandbox merchant.
- **Judging AI work fairly.** The verifier needed contracts precise enough to fail generic output without failing honest work, plus a cheap schema check before any model call.
- **Making micro-payments honest.** Every number on the dashboard is either a real PayPal ID or labelled as simulated.

## Accomplishments that we're proud of

- A complete PayPal money loop: capture in, payout batch out, refund back, with live status from PayPal.
- An agent that changes sellers on its own when verified quality is poor, and a risk engine that removes bad sellers.
- An open, testable protocol any developer can adopt in three lines.
- A marketplace big enough to feel real: 103 services, 17 languages, and quality checks that catch an untranslated "translation" before it is paid.

## What we learned

The hard part of agent payments is not moving money. It is deciding when money should move. Escrow plus an AI verifier turns "buyer protection" into something that can run at machine speed.

## What's next for AgentPay

- Optional PYUSD settlement for sellers
- Seller-defined service contracts
- Live web sources for research services
- Routing physical-goods purchases through Agent Ready

## Built with

paypal-orders-api, paypal-payouts-api, paypal-refunds, paypal-vault, paypal-javascript-sdk, paypal-webhooks, anthropic-claude, claude-haiku, model-context-protocol, x402, node.js, express, ag-grid, ag-charts, server-sent-events, render, github-actions

## Tools used (required field)

- **Claude Haiku (Anthropic API):** buyer agents with tool use, seller agents, the escrow verifier that decides whether payments are released or refunded, the dispute reviewer and the plain-English rules compiler.
- **PayPal developer platform (sandbox):** JS SDK, Orders v2, Refunds, Payouts, Vault, webhooks.
- **AG Grid Community and AG Charts:** live escrow ledger, marketplace and settlement grids; spend and quality trends.
- **Render:** hosting via `render.yaml`.
- **Model Context Protocol SDK:** MCP server for third-party agents.
