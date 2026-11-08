'use strict';

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;

console.log('[Payvault Boot] Gateway: PayPal Sandbox (Exclusive Live Provider)');

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: false }));

// Serve static frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

// ── Chunk 1: Reconciliation Foundation routes ─────────────────────────────────
const reconciliationRoutes = require('./src/routes/reconciliation');
const exceptionsRoutes     = require('./src/routes/exceptions');
const demoRoutes           = require('./src/routes/demo');
const investigationsRoutes = require('./src/routes/investigations');
const paypalRoutes         = require('./src/routes/paypal');
const { defaultPayPalClient } = require('./src/paypal/client');
const store                = require('./src/store/dataStore');
const postgres             = require('./src/db/postgres');
const redis                = require('./src/db/redis');
const migrator             = require('./src/db/migrator');

app.use('/api/reconciliation', reconciliationRoutes);
app.use('/api/exceptions',     exceptionsRoutes);
app.use('/api/demo',           demoRoutes);
app.use('/api/investigations', investigationsRoutes);
app.use('/api/paypal',         paypalRoutes);

// ── GET /api/health — System & Infrastructure Health Check ────────────────────
const handleHealth = (req, res) => {
  const pgConnected = postgres.isAvailable();
  const redisConnected = redis.isAvailable();
  const paypalStatus = defaultPayPalClient.getStatus();

  return res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    database: {
      status: pgConnected ? 'connected' : 'unavailable',
      mode: postgres.getMode(),
    },
    redis: {
      status: redisConnected ? 'connected' : 'unavailable',
      mode: redis.getMode(),
    },
    paypal: paypalStatus,
  });
};

app.get('/api/health', handleHealth);
app.get('/health',     handleHealth);

// ── GET /api/config/status — Safe diagnostic status ──────────────────────────
app.get('/api/config/status', (req, res) => {
  const currentStore = store.getStore();
  const paypalStatus = defaultPayPalClient.getStatus();

  return res.json({
    paypal: paypalStatus,
    mode: currentStore.mode,
    active_records_count: currentStore.settlementRecords.length,
    active_exceptions_count: currentStore.exceptions.length,
    active_paypal_captures_count: currentStore.paypalCaptures.length,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ── GET /api/payments — List user/synced payments ────────────────────────────
app.get('/api/payments', (req, res) => {
  try {
    const payments = store.getPayments();
    return res.json({ count: payments.length, payments });
  } catch (err) {
    console.error('[GET /api/payments] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch payments.' });
  }
});

// ── GET /api/settlements — List settlement batches with aggregate financials ──
app.get('/api/settlements', (req, res) => {
  try {
    const batches = store.getSettlementBatches();
    const records = store.getSettlementRecords();

    const batchesWithDetails = batches.map(b => {
      const batchRecords = records.filter(r => r.settlement_id === b.id);
      const gross = batchRecords.reduce((s, r) => s + (r.amount || 0), 0);
      const credit = batchRecords.reduce((s, r) => s + (r.credit || 0), 0);
      const fee = batchRecords.reduce((s, r) => s + (r.fee || 0), 0);
      const tax = batchRecords.reduce((s, r) => s + (r.tax || 0), 0);

      return {
        ...b,
        records_count: batchRecords.length,
        total_gross_paise: gross,
        total_gross_inr: (gross / 100).toFixed(2),
        total_credit_paise: credit,
        total_credit_inr: (credit / 100).toFixed(2),
        total_fee_paise: fee,
        total_fee_inr: (fee / 100).toFixed(2),
        total_tax_paise: tax,
        total_tax_inr: (tax / 100).toFixed(2),
        records: batchRecords,
      };
    });

    return res.json({ count: batches.length, batches: batchesWithDetails, records });
  } catch (err) {
    console.error('[GET /api/settlements] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch settlements.' });
  }
});

// ── LOCAL DEMO PAYMENT (Offline / Zero-Credential Flow) ──────────────────────
/**
 * POST /api/payments/local
 * Body: { amount: number (in paise), payment_method, customer_ref, description, anomaly_type }
 * Immediately creates payment, generates settlement record, and runs reconciliation.
 */
app.post('/api/payments/local', (req, res) => {
  try {
    const {
      amount,
      payment_method = 'card',
      customer_ref,
      description,
      anomaly_type = 'CLEAN_MATCH',
    } = req.body;

    if (!amount || typeof amount !== 'number' || isNaN(amount) || amount < 100 || amount > 50000000) {
      return res.status(400).json({
        error: 'Amount must be a valid number between ₹1.00 (100 paise) and ₹5,00,000.00 (50,000,000 paise).',
      });
    }

    const amountPaise = Math.round(amount);
    const timeSuffix = Date.now().toString(36);
    const randSuffix = Math.random().toString(36).slice(2, 6);
    const paymentId = `pay_local_${timeSuffix}_${randSuffix}`;
    const orderId = customer_ref || `order_local_${timeSuffix}`;

    // Ingest directly into Payvault's deterministic pipeline
    const ingested = store.addPaymentTransaction({
      payment_id:   paymentId,
      id:           paymentId,
      order_id:     orderId,
      amount_paise: amountPaise,
      currency:     'INR',
      method:       payment_method,
      receipt:      `rcpt_local_${timeSuffix}`,
      description:  description || `Local payment for ${orderId}`,
      anomaly:      anomaly_type,
      created_at:   Math.floor(Date.now() / 1000),
    });

    const isException = !!ingested.exception || ingested.reconciliation_result?.status === 'EXCEPTION';

    return res.status(200).json({
      success:               true,
      mode:                  'LOCAL_DEMO',
      id:                    paymentId,
      payment_id:            paymentId,
      order_id:              orderId,
      amount:                amountPaise,
      amount_paise:          amountPaise,
      gross_amount_inr:      (amountPaise / 100).toFixed(2),
      settlement_record:     ingested.settlement_record,
      reconciliation_result: ingested.reconciliation_result,
      is_exception:          isException,
      exception:             ingested.exception,
      message:               isException
        ? `Payment processed with discrepancy (${ingested.exception?.category || 'Exception'}). Investigation created.`
        : 'Payment successfully processed and cleanly reconciled.',
      summary:               store.getSummary(),
    });
  } catch (err) {
    console.error('[payments/local] Error:', err);
    return res.status(500).json({ error: 'Failed to process local demo payment.' });
  }
});

async function initDatabases() {
  const pgConnected = await postgres.checkConnection();
  if (pgConnected) {
    try {
      await migrator.runMigrations();
      console.log('[Payvault Boot] Database migrations verified.');
    } catch (err) {
      console.error('[Payvault Boot] Error running migrations:', err.message);
    }
  }
  await redis.checkConnection();
}

async function handleShutdown(signal) {
  console.log(`\n[Payvault] Received ${signal}. Shutting down gracefully...`);
  try {
    await postgres.close();
    await redis.close();
    console.log('[Payvault] Database connections cleanly closed.');
  } catch (err) {
    console.error('[Payvault] Error during database shutdown:', err.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// ── Start server ──────────────────────────────────────────────────────────────
if (require.main === module) {
  initDatabases().finally(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀  PayVault autonomous server running at http://localhost:${PORT} (PayPal-Only)\n`);
    });
  });
}

module.exports = app;
module.exports.initDatabases = initDatabases;
