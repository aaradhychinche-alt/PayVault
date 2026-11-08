# PayVault: PayPal Sandbox + Local Ollama Upgrade
> **Hackathon Alignment**: [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/rules)
> **Theme**: Autonomous Settlement Reconciliation & Exception Copilot using PayPal Developer Sandbox + Local Ollama LLM (`qwen2.5:1.5b`).

---

## 1. Executive Summary

PayVault has been upgraded from a single-gateway prototype to an enterprise payment reconciliation and investigation workstation featuring:
1. **PayPal Sandbox Orders v2 (Primary Demo Gateway)**: Server-controlled pricing, returned buyer approval link, server-verified capture execution, and visible order/capture evidence. Starts seamlessly with **zero Razorpay credentials required**.
2. **Financial Integrity & Verification**: Strict currency-aware integer minor units (cents/paise) via `src/payments/money.js`. Server-side validation against tampered amounts, currencies, and references.
3. **Idempotent Retry Keys**: Client and server persist stable `PayPal-Request-Id` headers prior to outbound network calls.
4. **Webhook Processing**: Cryptographic signature verification via `/v1/notifications/verify-webhook-signature`, event deduplication (`event.id`), out-of-order handling, and automatic flagging of refunds/reversals with `REVIEW_REQUIRED`.
5. **Gateway Capture vs. Bank Settlement Distinction**: Architectural guarantee that payment captures are recorded as gateway transactions held in transit—never mislabeled as bank settlement batches or nodal credits.
6. **Local Ollama Integration**: Grounded case investigation chat powered by actual local Ollama inference (`qwen2.5:1.5b` on `http://127.0.0.1:11434`), citing structured evidence IDs (`[EV-01]` to `[EV-08]`) with zero invented figures and explicit native fallback.

---

## 2. Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │          PayVault Dashboard            │
                      │  (http://localhost:3000 — Clean UX)    │
                      └──────────────────┬─────────────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 │                                               │
                 ▼                                               ▼
     ┌───────────────────────┐                       ┌───────────────────────┐
     │  PayPal Orders v2     │                       │  Investigation Chat   │
     │  Sandbox Integration  │                       │  Ask Payvault AI      │
     └───────────┬───────────┘                       └───────────┬───────────┘
                 │                                               │
      ┌──────────┴──────────┐                         ┌──────────┴──────────┐
      │                     │                         │                     │
      ▼                     ▼                         ▼                     ▼
┌───────────────┐     ┌───────────────┐         ┌───────────────┐     ┌───────────────┐
│ Server Orders │     │ Webhook       │         │ Local Ollama  │     │ Payvault      │
│ v2 + Capture  │     │ Verification  │         │ (qwen2.5:1.5b)│     │ Native AI     │
│ (api-m.sandbox)     │ & Deduplicat. │         │ (localhost)   │     │ (Deterministic│
│ Minor Units   │     │ (Refund Flags)│         │ Evidence Cited│     │ Fallback)     │
└───────────────┘     └───────────────┘         └───────────────┘     └───────────────┘
```

---

## 3. Environment Variables Configuration

Create or update `.env` in `PayVault/PayVault/`:

```bash
# ── Server Port ─────────────────────────────────────────────────────────────
PORT=3000

# ── PayPal Developer Sandbox Credentials ────────────────────────────────────
# Obtain these from: https://developer.paypal.com/dashboard/applications/sandbox
PAYPAL_CLIENT_ID=your_sandbox_client_id_here
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret_here
PAYPAL_WEBHOOK_ID=your_sandbox_webhook_id_here
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
PAYPAL_ENVIRONMENT=sandbox

# ── Local Ollama LLM Configuration ──────────────────────────────────────────
# Uses local Ollama runtime on host (100% private, no cloud API calls)
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:1.5b
ENABLE_OLLAMA=true
OLLAMA_TIMEOUT_MS=12000

# ── Optional Legacy Gateway (Not Required to Run) ───────────────────────────
# RAZORPAY_KEY_ID=
# RAZORPAY_KEY_SECRET=
```

---

## 4. API Endpoints Reference

### PayPal Sandbox Checkout
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/paypal/status` | Returns masked configuration diagnostics & capture counts |
| `GET` | `/api/paypal/products` | Returns server-controlled product catalog & integer minor pricing |
| `POST` | `/api/paypal/create-order` | Creates Orders v2 with stable idempotency key & buyer approval URL |
| `POST` | `/api/paypal/capture-order` | Executes capture, verifies minor amount/currency/reference anti-tamper |
| `GET` | `/api/paypal/orders/:id` | Retrieves registered order and capture evidence |
| `GET` | `/api/paypal/transactions` | Lists captured PayPal sandbox transactions (separate from legacy) |
| `POST` | `/api/paypal/webhook` | Verifies signature, deduplicates event IDs, flags refunds for review |

### Investigation & Ollama Copilot
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/investigations` | Lists active reconciliation exception cases |
| `GET` | `/api/investigations/:id` | Returns complete case fact-pack with evidence traceability |
| `POST` | `/api/investigations/:id/chat` | Case-aware chat routing to local Ollama with `[EV-xx]` citations |
| `POST` | `/api/investigations/:id/run` | Runs autonomous ML investigation & transitions case to IN_REVIEW |
| `POST` | `/api/investigations/:id/resolve` | Records human-authorized resolution justification |

---

## 5. Verification & Test Evidence

### Complete Test Run (13 Suites, 458 Tests Passing)
```bash
npm test
```
```
PASS tests/engine.test.js
PASS tests/caseLifecycle.test.js
PASS tests/investigation.test.js
PASS tests/investigationUxUpgrade.test.js
PASS tests/intelligence.test.js
PASS tests/persistenceAndIsolation.test.js
PASS tests/generalizationTest.test.js
PASS tests/chatCopilot.test.js
PASS tests/livePaymentFlow.test.js
PASS tests/simulator.test.js
PASS tests/money.test.js
PASS tests/paypal.test.js
PASS tests/ollama.test.js

Test Suites: 13 passed, 13 total
Tests:       458 passed, 458 total
Snapshots:   0 total
Time:        30.877 s
```

### Real Local Inference Proof (`tests/ollama.test.js`)
```
[REAL OLLAMA TEST] Running inference on model: qwen2.5:1.5b
[REAL OLLAMA RESPONSE]: The platform fee overcharge is ₹25.00, as the gateway deducted 4.5% fee instead of the contracted 2.0%. This discrepancy led to a net settlement shortfall of ₹29.50, resulting in the case being flagged for review and correction.
```
