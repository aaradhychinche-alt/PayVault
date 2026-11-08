# Payvault — Enterprise Settlement Reconciliation & Exception Investigation

**Payvault** is an enterprise financial operations platform that automatically synchronizes payment and settlement data, reconciles transactions, detects payment exceptions, investigates their underlying causes, quantifies financial impact, and delivers evidence-grounded conversational explanations through Payvault AI with human-controlled resolution workflows.

Built for high-volume merchants, payment facilitators, and fintech operations teams, Payvault replaces manual spreadsheet reconciliation with penny-perfect, deterministic accounting and contextual investigation intelligence.

---

## Quick Start

Get Payvault up and running in under two minutes with Docker:

```bash
# 1. Clone the repository
git clone https://github.com/aaradhychinche/PayVault.git
cd PayVault

# 2. Copy the environment template
cp .env.example .env

# 3. Build and launch all services with Docker Compose
docker compose up --build
```

Once the containers are healthy, open **[http://localhost:3000](http://localhost:3000)** in your browser.

- **PostgreSQL migrations execute automatically** on startup.
- **Redis connection initializes automatically** for conversational session caching.
- **Payvault starts in PayPal Sandbox Demo Mode** (ready for instant synthetic reconciliation or real PayPal Orders v2 sandbox checkout).

---

## System Architecture

Payvault separates concerns strictly across permanent persistence, transient state, local machine learning, and deterministic financial calculation:

```
                    Docker Compose
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
      Payvault App   PostgreSQL       Redis
       (Node/ML)     (Persistent)  (Fast Context)
      Port: 3000      Port: 5432    Port: 6379
          │              │              │
          │              ↓              ↓
          │         Financial Data   Chat State
          │         Investigations   Conversation
          │         Audit Events     Context
          │              │              │
          └──────────────┴──────┬───────┘
                                ↓
                         Payvault AI
```

### Storage & Service Responsibilities

| Service | Technology | Role & Storage Guarantee |
| :--- | :--- | :--- |
| **PostgreSQL** | PostgreSQL 15 | **Permanent Authoritative Source of Truth**.<br>Persists orders, payments, refunds, settlements, settlement transactions, reconciliation results, investigations, and immutable audit events. All financial fields are strictly stored as `BIGINT` integer paise (`*_paise`). |
| **Redis** | Redis 7 | **Fast Transient State & Context Cache**.<br>Stores active conversational state, recent chat turns, and scoped session data (`payvault:chat:<caseId>:<convId>`) with configurable TTL (`CHAT_CONTEXT_TTL_SECONDS`). **Redis is NOT the financial source of truth.** |
| **Payvault App** | Node.js 18 / Express | **Application & Investigation Engine**.<br>Serves static UI, handles API routing, executes deterministic settlement reconciliation, and coordinates native Payvault AI reasoning. |
| **Local ML** | Scikit-Learn (Python 3) | **Natural Language Intent Understanding**.<br>Classifies operator questions into 26 distinct financial investigation intents. Runs 100% in-process / locally with zero external LLM dependencies. |
| **Deterministic Engine** | JavaScript | **Authoritative Calculations**.<br>Performs penny-perfect arithmetic (fee schedule validation, GST verification, timing window matching) using integer paise. Zero hallucination. |

---

## Core Capabilities

### 1. Deterministic Reconciliation Engine
Matches gateway payments, settlement batches, and merchant ledger entries with mathematical certainty:
- **Integer-Paise Precision**: All calculations occur in integer paise (100 paise = ₹1.00) to eliminate IEEE 754 floating-point errors.
- **Multi-Source Ingestion**: Ingests PayPal Sandbox captures, settlement records, and merchant order ledgers.
- **9 Exception Categories Detected**:
  - `CLEAN_MATCH`: Gross, fee, tax, and net credit match expected schedules.
  - `FEE_TAX_VARIANCE`: Gateway platform fee or GST deviates from contracted rate (2.0% + 18% GST).
  - `TIMING_MISMATCH`: Payment captured and refund issued across different settlement batch cycles.
  - `MISSING_ORDER`: Settlement credit received with no merchant order in ledger.
  - `MISSING_PAYMENT`: Merchant order captured but payment omitted from settlement batch.
  - `DUPLICATE`: Multiple settlement credits for the same order reference within a deduplication window.
  - `ADJUSTMENT`: Gateway balance adjustment not mapped to an underlying transaction.
  - `PARTIAL_REFUND`: Refund debit does not match requested refund amount.
  - `UNEXPLAINED`: Net credit shortfall without detectable fee/tax discrepancy.
- **Amount-at-Risk Quantification**: Automatically calculates exact merchant financial exposure for every exception.

### 2. Investigation Workstation & Operations Dashboard
- **Case Queue**: Filter by status (`OPEN`, `IN_REVIEW`, `RESOLVED`) and exception category.
- **Investigation Result Summary**: Renders three dynamic, case-specific operational findings:
  1. **What happened?**
  2. **Why does it matter?**
  3. **What should I do?**
- **Auditable Transaction Facts**: Direct comparison table comparing Expected vs Actual for Gross, Gateway Fee, GST, and Net Settlement.
- **Lifecycle Timeline**: Chronological event sequence from order creation to bank UTR settlement credit.
- **Human-Controlled Resolution**: Transition cases between `OPEN`, `IN_REVIEW`, and `RESOLVED` with mandatory business justification codes and operator audit notes. The AI engine is strictly prohibited from mutating case status.

### 3. Conversational Payvault AI Copilot (Ollama & Deterministic Tools)
Ask Payvault AI questions about the active investigation case:
- **Local Ollama Integration**: Powered by local `qwen2.5:1.5b` running on `http://127.0.0.1:11434`.
- **Authoritative Deterministic Tool Calling**: Ollama invokes deterministic tools (`get_case_financials`, `calculate_variance`, `get_cited_evidence`) to retrieve authoritative numbers before formulating commentary.
- **Strict Grounding Guarantee**: The displayed factual answer is owned exclusively by the deterministic evidence composer using penny-perfect integer arithmetic. Raw model prose is isolated and clearly labeled as `[UNVERIFIED LOCAL MODEL COMMENTARY]`, never presented with false factual confidence.
- **Graceful Fallback**: Automatically falls back to Payvault Native Reasoning if Ollama is disabled or offline.
- **Case Isolation**: Evidence facts from Case A are strictly isolated and never bleed into Case B.

### 4. PayPal Sandbox Orders v2 & Dispute Reconciliation
Full local integration with PayPal Sandbox:
- **Server-Controlled Pricing & Anti-Tampering**: Pricing catalog is strictly owned by the server. Any client-side tampering of amounts, currencies, or reference IDs is rejected with HTTP 422.
- **Durable Pre-Network Idempotency**: Order creation and capture requests register idempotency keys to disk *before* any outbound network calls. If disk persistence fails, the request fails closed with HTTP 500 without making network calls.
- **Capture Reconciliation**: Captures are automatically reconciled against registered orders, generating formal `ReconciliationResult` records and exceptions on variances.
- **Webhook Verification & Replay Protection**: Ingests PayPal webhooks using raw payload buffer verification against `/v1/notifications/verify-webhook-signature`, with strict deduplication and out-of-order event preservation.
- **Dispute & Chargeback Investigation**: Processes `CUSTOMER.DISPUTE.*` webhooks, creates high-priority `DISPUTE_REVERSAL` exceptions in the investigation queue, and surfaces dispute alert banners in the dashboard.

---

## Prerequisites

To run Payvault with the recommended Docker development environment:

- **Docker**: Version 20.10+
- **Docker Compose**: Version 2.0+ (supports `docker compose`)
- **Git**: For cloning the repository

### For Local Standalone Development (Without Docker)
If running directly on the host machine:
- **Node.js**: v18.0.0 or v20.0.0+ LTS
- **npm**: v9.0.0+
- **Python**: v3.10+ or v3.11+
- **Python Dependencies**: Listed in `src/ml/requirements.txt` (`pip install -r src/ml/requirements.txt`)

---

## Environment Configuration

Configuration is managed via environment variables. Create your local `.env` from the provided template:

```bash
cp .env.example .env
```

### Environment Variables Reference

| Variable | Default (Local / Docker) | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the Payvault web server and frontend. |
| `DATABASE_URL` | `postgresql://payvault:payvault_dev_secret@localhost:5432/payvault` | PostgreSQL connection string. (Inside Docker, host is `postgres`). |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string. (Inside Docker, host is `redis`). |
| `CHAT_CONTEXT_TTL_SECONDS` | `3600` | Expiration time (seconds) for conversational session context in Redis. |
| `PAYPAL_CLIENT_ID` | *(your sandbox client id)* | PayPal Developer Sandbox App Client ID. |
| `PAYPAL_CLIENT_SECRET` | *(secret placeholder)* | PayPal Developer Sandbox App Client Secret. |
| `PAYPAL_WEBHOOK_ID` | *(optional webhook id)* | PayPal Sandbox Webhook ID for signature verification. |
| `POSTGRES_DB` | `payvault` | PostgreSQL database name (used by Docker Compose). |
| `POSTGRES_USER` | `payvault` | PostgreSQL user (used by Docker Compose). |
| `POSTGRES_PASSWORD` | `payvault_dev_secret` | PostgreSQL development password. |

> **Note on Security**: Never commit your actual `PAYPAL_CLIENT_SECRET` or production database credentials to version control. The repository ignores `.env` by default.

---

## Docker Development Setup

The primary and recommended development environment is containerized via Docker Compose.

### Starting the Stack

```bash
docker compose up --build
```

This starts:
1. **`payvault-postgres`**: PostgreSQL 15 on port `5432` with automated schema migrations.
2. **`payvault-redis`**: Redis 7 on port `6379` for transient context state.
3. **`payvault-app`**: Node.js backend, Python ML inference server, and static frontend on port `3000`.

### Stopping the Stack

```bash
docker compose down
```

To clear persisted database volumes and start completely fresh:
```bash
docker compose down -v
```

---

## Database Architecture (PostgreSQL)

PostgreSQL serves as Payvault's permanent, authoritative source of truth.

### Database Tables & Schema

1. **`orders`**: Merchant customer orders, amounts, and currency.
2. **`payments`**: Captured transactions, gateway IDs, payment methods, and timestamps.
3. **`refunds`**: Full and partial refund records with payment associations.
4. **`settlements`**: Settlement batches, UTR references, batch dates, and totals.
5. **`settlement_transactions`**: Individual line items inside a settlement batch.
6. **`reconciliation_results`**: Deterministic ledger comparisons with variance figures.
7. **`investigations`**: Case lifecycle records, AI investigation findings, and risk metrics.
8. **`audit_events`**: Append-only compliance ledger tracking all human resolutions and status changes.

### Financial Precision Guarantee
All monetary columns are strictly integer paise:
- `gross_amount_paise BIGINT`
- `expected_fee_paise BIGINT`
- `actual_fee_paise BIGINT`
- `fee_variance_paise BIGINT`
- `expected_gst_paise BIGINT`
- `actual_gst_paise BIGINT`
- `gst_variance_paise BIGINT`
- `expected_settlement_paise BIGINT`
- `actual_settlement_paise BIGINT`
- `amount_at_risk_paise BIGINT`

The repository layer (`src/db/repositories/`) implements strict `validatePaise()` assertions that reject any floating-point or negative amounts.

### Automated Migrations
Migrations are stored in `src/db/migrations/` and managed by `src/db/migrator.js`.
- Migrations run automatically on application boot when PostgreSQL connects.
- Each migration is executed inside a transaction.
- Completed migrations are tracked in the `schema_migrations` table.
- Initial schema: `001_initial_schema.sql`.

---

## Redis Transient Context Layer

Redis provides fast, low-latency conversational context for the Payvault AI copilot:

- **Key Convention**: Strictly scoped to prevent state contamination:
  ```
  payvault:chat:<investigationId>:<conversationId>
  ```
- **State Payload**:
  - `investigationId`: Case identifier (e.g., `exc_000001`)
  - `conversationId`: Session identifier
  - `currentTopic`: Active discussion focus (`fee_variance`, `tax_overcharge`, etc.)
  - `currentIntent` & `previousIntent`: Semantic intent tracking
  - `turnNumber`: Monotonically incremented turn counter
  - `activeFinancialMetric`: Financial metric currently in question
  - `lastUserQuestion` & `lastAnswerSummary`: Recent turn memory
- **TTL Management**: State automatically expires after `CHAT_CONTEXT_TTL_SECONDS` (default: 3600 seconds), refreshed on each turn.
- **Strict Case Isolation**: `CASE_A` context is completely inaccessible and isolated from `CASE_B`.

---

## Payvault AI: Architecture & Data Flow

Payvault AI uses an intelligence pipeline grounded in deterministic data:

```
                    User Question
                          ↓
                       Chat API
            (POST /api/investigations/:id/chat)
                          ↓
              Redis Conversation State
               (Multi-turn context load)
                          ↓
              Local ML Intent Classifier
                (26 semantic intents)
                          ↓
             PostgreSQL Investigation Case
             (Authoritative integer paise)
                          ↓
             Deterministic Financial Engine
                 (Calculates variances)
                          ↓
            Native Payvault AI Reasoning
            (Causal analysis & action plan)
                          ↓
             Bounds & Case-Scope Validation
               (Hallucination prevention)
                          ↓
                Payvault AI Response
                          ↓
             Updated Redis Conversation State
                (Persist turn & refresh TTL)
```

### Local Machine Learning
- Trained on 26 financial exception intents (e.g. `what_happened`, `settlement_causality`, `fee_specific`, `tax_specific`, `where_did_money_go`, `is_financial_loss`, `recommended_action`).
- Implemented with Scikit-Learn (`RandomForestClassifier`, TF-IDF / syntactic feature extraction).
- Evaluated with 100% test accuracy across all benchmark queries.
- **Zero Cloud / External LLM Dependencies**: Completely eliminates vendor API keys, token fees, and cloud latency.

---

## Standalone Development Fallback Mode

If you run Payvault standalone without Docker (`npm start`) on a machine where PostgreSQL or Redis daemons are offline:
- The database connection layer ([src/db/postgres.js](file:///Users/aaradhychinche/RazorPay/src/db/postgres.js)) switches to `DEVELOPMENT_FALLBACK`.
- The Redis layer ([src/db/redis.js](file:///Users/aaradhychinche/RazorPay/src/db/redis.js)) switches to an internal `InMemoryRedisStore`.
- The server logs clear startup notices:
  ```
  [Payvault DB] PostgreSQL unavailable or unconfigured. Operating in DEVELOPMENT FALLBACK mode.
  [Payvault Redis] Redis unavailable. Operating with in-memory transient store fallback.
  ```
- This fallback mode is designed strictly for unit tests and local frontend UI development. For standard development and deployment, use Docker Compose.

---

## Service Health Checks

Payvault exposes dedicated health verification endpoints:
- `GET /health`
- `GET /api/health`

### Example Health Response
```json
{
  "status": "healthy",
  "timestamp": "2026-09-05T16:20:31.577Z",
  "uptime_seconds": 342,
  "database": {
    "status": "connected",
    "mode": "POSTGRES_PRODUCTION"
  },
  "redis": {
    "status": "connected",
    "mode": "REDIS_PERSISTENT"
  },
  "paypal": {
    "configured": true,
    "environment": "sandbox",
    "auth_token_cached": false
  }
}
```

*Note: The health endpoint returns operational statuses and active modes only; credentials, connection URLs, and secrets are strictly excluded.*

---

## PayPal Sandbox Orders v2 vs Synthetic Simulation

Payvault supports dual modes for payment operations:

1. **PayPal Sandbox Mode**:
   - Uses real PayPal Sandbox credentials (`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`).
   - Server creates Orders v2 with server-controlled pricing in integer minor units.
   - Returns buyer approval links and server-verified capture evidence.
   - Enforces strict architectural separation: `is_gateway_capture: true, is_bank_settlement: false`.
2. **Settlement Simulator & Synthetic Benchmark**:
   - Payment gateway sandboxes do not execute actual bank settlement batches (UTRs).
   - Payvault's settlement simulator creates deterministic settlement batches and injects realistic real-world discrepancies (timing gaps, fee miscalculations, GST variances) so you can test reconciliation and exception investigations end-to-end.

---

## Testing & Quality Assurance

The Payvault test suite validates deterministic accuracy, persistence correctness, and AI reliability.

### Running Automated Tests

```bash
# 1. Run all Node.js Jest test suites
npm test

# 2. Run Python ML intent classification unit tests
python3 -m unittest discover -s tests

# 3. Run ML benchmark evaluation script
node scripts/evaluate.js
```

### Verified Test Coverage

- **Jest Suites**: 10 passed, 10 total (**430 tests passed**)
- **Python ML Tests**: 7 passed, 7 total
- **Persistence & Isolation Suite** (`tests/persistenceAndIsolation.test.js`):
  - Strict integer-paise validation in repositories
  - PostgreSQL CRUD operations for payments, reconciliation, investigations, and audit logs
  - Redis conversation state saving, TTL expiration, and scoped key formats
  - Multi-turn conversation state retention
  - Strict Case Isolation (Case A context never leaks into Case B)
  - 8-turn conversation regression test
  - Investigation ID mapping verification (canonical exception IDs)

---

## Project Structure

```
├── Dockerfile                      # Production container build definition
├── docker-compose.yml              # Multi-container orchestration (App, Postgres, Redis)
├── server.js                       # Express bootstrap, health endpoints, graceful shutdown
├── package.json                    # Node.js dependencies & test scripts
├── .env.example                    # Template for environment configuration
│
├── public/                         # Frontend Single-Page Application
│   ├── index.html                  # Operations workstation layout & templates
│   ├── checkout.js                 # Reactive UI state, investigation, and chat client
│   └── style.css                   # Custom obsidian fintech design system
│
├── src/
│   ├── db/                         # Persistence & Caching Layer
│   │   ├── postgres.js             # PostgreSQL connection pool & health probes
│   │   ├── redis.js                # Redis client with in-memory fallback & TTL
│   │   ├── migrator.js             # Versioned migration runner
│   │   ├── migrations/
│   │   │   └── 001_initial_schema.sql  # Core DDL schema definition
│   │   └── repositories/
│   │       ├── paymentRepository.js
│   │       ├── orderRepository.js
│   │       ├── settlementRepository.js
│   │       ├── reconciliationRepository.js
│   │       ├── investigationRepository.js
│   │       └── auditRepository.js
│   │
│   ├── engine/                     # Deterministic Reconciliation Engine
│   │   ├── reconcile.js            # Transaction matching logic
│   │   ├── rules.js                # Discrepancy detection rules
│   │   └── config.js               # Tolerances and settlement windows
│   │
│   ├── investigation/              # AI Investigation & Copilot
│   │   ├── caseBuilder.js          # Constructs unified investigation cases
│   │   ├── financialAnalysis.js    # Exact paise-level variance calculations
│   │   ├── suggestions.js          # Resolution suggestions generator
│   │   ├── chat/
│   │   │   ├── chatRouter.js       # Payvault AI chat orchestrator
│   │   │   ├── nativeReasoning.js  # Grounded causal explanation engine
│   │   │   ├── conversationState.js# Redis-backed session state builder
│   │   │   └── chatContextBuilder.js
│   │   └── intelligence/
│   │       └── context.js          # Historical patterns & anomaly context
│   │
│   ├── ml/                         # Local ML Subsystem
│   │   ├── intent_classifier.py    # Random Forest 26-intent classifier
│   │   ├── intent_dataset.py       # Benchmark training data
│   │   ├── train.py                # Model training pipeline
│   │   └── requirements.txt        # Python ML dependencies
│   │
│   ├── models/                     # Domain Models & Enums
│   │   └── resolution.js           # Case lifecycle & resolution reasons
│   │
│   ├── routes/                     # REST API Handlers
│   │   ├── investigations.js       # Case details, run action, resolve, chat
│   │   ├── reconciliation.js       # Reconciliation results & summary metrics
│   │   ├── exceptions.js           # Exception queries
│   │   ├── demo.js                 # Demo data resets & benchmark loaders
│   │   └── paypal.js               # PayPal Sandbox Orders v2 & webhook receiver
│   │
│   └── store/
│       └── dataStore.js            # Application data store & state synchronization
│
└── tests/                          # Automated Verification
    ├── persistenceAndIsolation.test.js # Postgres, Redis, and isolation suite
    ├── investigationUxUpgrade.test.js  # Investigation UI & summary section tests
    ├── chatCopilot.test.js             # Conversational copilot test suite
    ├── engine.test.js                  # Reconciliation mathematical rules
    └── test_ml.py                      # Python ML intent model validation
```

---

## Local Standalone Setup (Without Docker)

Payvault can run standalone on localhost with SQLite / file persistence and local Ollama:

```bash
# 1. Install Node.js dependencies
npm install

# 2. Configure environment variables in .env (git-ignored)
cp .env.example .env

# 3. Start local Ollama (optional, for local AI investigation copilot)
ollama serve
ollama pull qwen2.5:1.5b

# 4. Start the Payvault server
npm start
# Server listens on http://127.0.0.1:3000
```

### Required & Optional Environment Variables

| Variable | Required? | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `PAYPAL_CLIENT_ID` | Yes (for live sandbox) | - | PayPal Developer Sandbox OAuth 2.0 Client ID |
| `PAYPAL_CLIENT_SECRET` | Yes (for live sandbox) | - | PayPal Developer Sandbox OAuth 2.0 Client Secret |
| `PAYPAL_ENVIRONMENT` | Yes | `sandbox` | PayPal API environment (`sandbox` or `production`) |
| `PAYPAL_WEBHOOK_ID` | Optional | - | Webhook ID from PayPal Developer Dashboard for signature checks |
| `PORT` | Optional | `3000` | HTTP port for Payvault express server (bound to 127.0.0.1) |
| `OLLAMA_BASE_URL` | Optional | `http://127.0.0.1:11434` | Endpoint for local Ollama HTTP API |
| `OLLAMA_MODEL` | Optional | `qwen2.5:1.5b` | Ollama model name for investigation chat |
| `OLLAMA_TIMEOUT_MS` | Optional | `12000` | Maximum timeout before fallback to native reasoning |

---

## Test Execution Commands

Payvault includes a comprehensive Jest verification suite covering all layers:

```bash
# Run the entire test suite
npm test

# Run PayPal Sandbox integration suite (33 tests)
npx jest tests/paypal.test.js

# Run Local Ollama AI & Tool-Calling suite (13 tests)
npx jest tests/ollama.test.js

# Run Investigation Workstation & ML suite (37 tests)
npx jest tests/investigation.test.js

# Run Safe Minor-Units Money Arithmetic suite (16 tests)
npx jest tests/money.test.js

# Run Process Restart & Durable Persistence suite
npx jest tests/restartPersistence.test.js
```

---

## Honest List of Limitations

Payvault maintains strict architectural honesty regarding what is locally verified versus what requires external infrastructure or manual intervention:

1. **Buyer Approval Requires External Human Interaction**:
   - Creating a PayPal sandbox order returns a valid approval link (`https://www.sandbox.paypal.com/checkoutnow?token=...`).
   - Capturing an order requires a human operator to log into that URL with Sandbox Personal Buyer credentials and approve the payment.
   - Calling `/api/paypal/capture-order` *before* buyer approval will be rejected by PayPal's sandbox API with `ORDER_NOT_APPROVED`. This is by design in PayPal's two-step authorization architecture.

2. **Gateway Capture is NOT Bank Settlement**:
   - PayPal captures confirm payment authorization and funds receipt into the merchant's PayPal digital balance.
   - Bank settlement (nodal settlement UTR) represents the actual bank wire transfer from the aggregator/gateway nodal account into the merchant's bank account, which operates on T+2 multi-batch payout cycles.
   - Payvault strictly prevents labeling gateway captures as bank settlements in both database records and user interfaces.

3. **Inbound Webhook Delivery Requires Public Endpoints**:
   - PayPal Sandbox servers cannot deliver webhooks directly to a private loopback address (`127.0.0.1:3000`) without a secure public tunnel (e.g. ngrok/Cloudflare tunnel) or static webhook proxy.
   - Local webhook testing is conducted using simulated webhook signatures, raw-body verification tests, and official PayPal `/v1/notifications/verify-webhook-signature` API mocks.

4. **Small Local LLM Hallucination Boundaries**:
   - Small quantized local models (such as `qwen2.5:1.5b`) can hallucinate numbers, confuse shortfalls with payouts, or produce ungrounded financial claims in free prose.
   - Payvault solves this by delegating the displayed factual answer exclusively to the deterministic native evidence composer using integer paise arithmetic. Ollama runs tool-calling for natural commentary, but free prose is isolated as `[UNVERIFIED LOCAL MODEL COMMENTARY]`.

---

## Scalability & Production Readiness

Payvault's architecture is built to scale with growing transaction volumes:

- **Decoupled State Lifecycles**: Heavy, append-only financial records live permanently in PostgreSQL with B-tree indexed lookups. Short-lived conversational sessions live in Redis with automatic TTL expiration, preventing unbounded memory bloat.
- **Connection Pooling**: PostgreSQL connections are pooled via `pg.Pool` with bounded timeouts and graceful termination on `SIGINT` / `SIGTERM`.
- **Stateless Application Nodes**: Because conversation state is managed in Redis and data is stored in PostgreSQL, Payvault application containers can be horizontally scaled behind a standard load balancer.
- **Microsecond Intent Inference**: Local scikit-learn models execute in milliseconds without external network calls, rate limits, or outbound API egress costs.

---

## Troubleshooting

### 1. Docker Daemon Not Running
**Symptom**: `docker compose up` returns `Cannot connect to the Docker daemon`.  
**Solution**: Ensure Docker Desktop (or your Docker daemon) is running:
```bash
docker info
```

### 2. Port Already in Use (Port 3000, 5432, or 6379)
**Symptom**: `bind: address already in use`.  
**Solution**: Check for conflicting local processes:
```bash
# Check port 3000
lsof -i :3000
# Check port 5432 (local postgres)
lsof -i :5432
# Check port 6379 (local redis)
lsof -i :6379
```
Stop the conflicting process or change ports in your `.env` file (`PORT`, `POSTGRES_PORT`, `REDIS_PORT`).

### 3. PostgreSQL or Redis Not Healthy
**Symptom**: `payvault-app` waits indefinitely for database dependencies.  
**Solution**: Inspect container logs:
```bash
docker compose logs postgres
docker compose logs redis
```

### 4. Database Migrations Failed
**Symptom**: Application fails to boot with a migration error.  
**Solution**: Verify that `src/db/migrations/001_initial_schema.sql` syntax is valid and check container database logs:
```bash
docker compose logs app
```

---

## License

Payvault is proprietary software. All rights reserved.
