'use strict';
/**
 * src/store/dataStore.js
 *
 * In-memory data store for the Reconciliation & Exception engine.
 * Supports:
 *   MODE A — SYNTHETIC (via reset(), 79 deterministic benchmark cases)
 *   MODE B — RAZORPAY_BACKED / LIVE (clean live transactions created via Checkout or synced from Test Mode)
 *
 * Structure:
 *   REAL TRANSACTIONS:      payments, orders, refunds
 *   SIMULATED SETTLEMENT:   settlementRecords, settlementBatches (simulated per Razorpay recon schema)
 *   MERCHANT BOOKS:         merchantOrders, merchantLedger
 *   DERIVED RESULTS:        reconciliationResults, exceptions (computed by deterministic engine)
 *   EVALUATION ONLY:        _groundTruth (never sent to public AI layer)
 */

const fs = require('fs');
const path = require('path');
const { generateDataset, calcFee }  = require('../data/generator');
const { simulateSettlementDataset } = require('../data/simulator');
const { reconcile }                 = require('../engine/reconcile');
const { createSettlementRecord }    = require('../models/settlementRecord');
const { createMerchantOrder }       = require('../models/merchantOrder');
const { createMerchantLedger }      = require('../models/merchantLedger');
const {
  CaseStatus,
  createResolutionRecord,
  createAuditEvent,
  isValidResolutionReason,
} = require('../models/resolution');
const genericPaymentAdapter         = require('../payments/adapter');

function getPayPalStoreFile() {
  return process.env.PAYPAL_STORE_PATH || path.join(__dirname, '../data/paypal_store.json');
}

const IN_FLIGHT_TIMEOUT_MS = parseInt(process.env.IDEMPOTENCY_TIMEOUT_MS, 10) || 60000; // 60s timeout

function _loadPayPalDiskState() {
  const storeFile = getPayPalStoreFile();
  try {
    if (fs.existsSync(storeFile)) {
      const raw = fs.readFileSync(storeFile, 'utf8');
      const data = JSON.parse(raw);
      return {
        orders: Array.isArray(data.orders) ? data.orders : [],
        captures: Array.isArray(data.captures) ? data.captures : [],
        idempotency: Array.isArray(data.idempotency) ? data.idempotency : [],
        webhook_events: Array.isArray(data.webhook_events) ? data.webhook_events : [],
        resource_states: Array.isArray(data.resource_states) ? data.resource_states : [],
      };
    }
  } catch (err) {
    // Non-fatal
  }
  return { orders: [], captures: [], idempotency: [], webhook_events: [], resource_states: [] };
}

function _savePayPalDiskState(throwOnError = false) {
  if (!_store) return;
  const storeFile = getPayPalStoreFile();
  const dir = path.dirname(storeFile);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const ordersArray = Array.from((_store.paypalOrders || new Map()).values());
    const capturesArray = _store.paypalCaptures || [];
    const idempotencyArray = Array.from((_store.paypalIdempotency || new Map()).entries());
    const webhookEventsArray = Array.from((_store.paypalWebhookEvents || new Map()).entries());
    const resourceStatesArray = Array.from((_store.paypalResourceStates || new Map()).entries());

    const payload = {
      orders: ordersArray,
      captures: capturesArray,
      idempotency: idempotencyArray,
      webhook_events: webhookEventsArray,
      resource_states: resourceStatesArray,
      updated_at: new Date().toISOString(),
    };
    const tmpFile = `${storeFile}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpFile, storeFile);
  } catch (err) {
    console.error('[dataStore] Failed to save PayPal store to disk:', err.message);
    if (throwOnError) {
      throw err;
    }
  }
}

function _clearPayPalDiskState() {
  const storeFile = getPayPalStoreFile();
  try {
    if (fs.existsSync(storeFile)) {
      fs.unlinkSync(storeFile);
    }
  } catch (err) {
    // Non-fatal
  }
}

let _store = null;

/**
 * Initialize an empty live store.
 * Used on server startup and clean session resets so the UI starts with 0 random records.
 */
function initEmpty(mode = 'LIVE', options = {}) {
  const shouldLoadDisk = options.loadDisk === true || (process.env.NODE_ENV !== 'test' && options.loadDisk !== false);
  const disk = shouldLoadDisk ? _loadPayPalDiskState() : { orders: [], captures: [], idempotency: [], webhook_events: [], resource_states: [] };

  const paypalOrders = new Map();
  for (const ord of disk.orders) {
    if (ord && ord.order_id) {
      paypalOrders.set(ord.order_id, ord);
    }
  }

  const paypalIdempotency = new Map();
  for (const item of disk.idempotency) {
    let key, val;
    if (Array.isArray(item)) {
      [key, val] = item;
    } else if (item && item.key) {
      key = item.key;
      val = item;
    }
    if (key && val) {
      // RESTART AUDIT RECOVERY: Any in-flight lock saved prior to process exit was interrupted
      if (val.status === 'IN_FLIGHT') {
        val.status = 'INTERRUPTED_RETRYABLE';
        val.recovered_on_restart = true;
      }
      paypalIdempotency.set(key, val);
    }
  }

  const paypalWebhookEvents = new Map();
  for (const item of (disk.webhook_events || [])) {
    if (Array.isArray(item) && item[0]) {
      paypalWebhookEvents.set(item[0], item[1]);
    }
  }

  const paypalResourceStates = new Map();
  for (const item of (disk.resource_states || [])) {
    if (Array.isArray(item) && item[0]) {
      paypalResourceStates.set(item[0], item[1]);
    }
  }

  _store = {
    mode,
    data_source:           'razorpay_test_mode',
    settlement_source:     'simulated',
    simulation_version:    '1.0',
    settlementRecords:     [],
    merchantOrders:        [],
    merchantLedger:        [],
    settlementBatches:     [],
    reconciliationResults: [],
    exceptions:            [],
    payments:              [],
    paypalOrders,
    paypalCaptures:        disk.captures,
    paypalIdempotency,
    paypalWebhookEvents,
    paypalResourceStates,
    caseStatus:            new Map(),
    aiInvestigations:      new Map(),
    auditTrail:            [],
    _groundTruth:          new Map(),
    _resetAt:              Date.now(),
    stats: {
      orders_count:   0,
      payments_count: 0,
      refunds_count:  0,
    },
  };
  return _store;
}

/**
 * Reset to full deterministic synthetic benchmark (Mode A, 79 records).
 * Retained for automated tests and benchmark evaluation.
 */
function reset() {
  const dataset = generateDataset();
  const { results, exceptions } = reconcile(dataset);

  const preservedOrders = _store?.paypalOrders || new Map();
  const preservedCaptures = _store?.paypalCaptures || [];
  const preservedIdem = _store?.paypalIdempotency || new Map();

  _store = {
    mode:                  'SYNTHETIC',
    data_source:           'synthetic',
    settlement_source:     'synthetic',
    simulation_version:    '1.0',
    settlementRecords:     dataset.settlementRecords,
    merchantOrders:        dataset.merchantOrders,
    merchantLedger:        dataset.merchantLedger,
    settlementBatches:     dataset.settlementBatches,
    reconciliationResults: results,
    exceptions,
    payments:              dataset.settlementRecords.filter(r => r.type === 'payment'),
    paypalOrders:          preservedOrders,
    paypalCaptures:        preservedCaptures,
    paypalIdempotency:     preservedIdem,
    caseStatus:            new Map(),
    aiInvestigations:      new Map(),
    auditTrail:            [],
    _groundTruth:          dataset.groundTruth,
    _resetAt:              Date.now(),
    stats: {
      orders_count:   dataset.merchantOrders.length,
      payments_count: dataset.settlementRecords.filter(r => r.type === 'payment').length,
      refunds_count:  dataset.settlementRecords.filter(r => r.type === 'refund').length,
    },
  };

  return _store;
}

/**
 * Lazily initialise the store on first access (defaults to clean LIVE mode).
 */
function getStore() {
  if (!_store) initEmpty('LIVE');
  if (!_store.caseStatus) _store.caseStatus = new Map();
  if (!_store.aiInvestigations) _store.aiInvestigations = new Map();
  if (!_store.auditTrail) _store.auditTrail = [];
  if (!_store.paypalOrders) _store.paypalOrders = new Map();
  if (!_store.paypalCaptures) _store.paypalCaptures = [];
  if (!_store.paypalIdempotency) _store.paypalIdempotency = new Map();
  return _store;
}

/**
 * Append a real user payment into the reconciliation store.
 * Automatically generates a schema-accurate simulated settlement record and runs reconciliation.
 *
 * @param {Object} paymentData
 * @returns {Object} { success, payment_id, settlement_record, reconciliation_result, exception, status }
 */
function addPaymentTransaction(paymentData = {}) {
  const payment_id   = paymentData.payment_id || paymentData.id;
  const order_id     = paymentData.order_id || null;
  const amount_paise = paymentData.amount_paise || paymentData.amount;
  const currency     = paymentData.currency || 'INR';
  const method       = paymentData.method || 'card';
  const receipt      = paymentData.receipt || (paymentData.notes && paymentData.notes.receipt) || null;
  const description  = paymentData.description || null;
  const email        = paymentData.email || null;
  const customer_name = paymentData.customer_name || null;
  const anomaly      = paymentData.anomaly || paymentData.simulate_exception || null;
  const created_at   = paymentData.created_at || Math.floor(Date.now() / 1000);

  const s = getStore();

  // If in synthetic benchmark mode, switch to LIVE mode so new user payments start fresh
  if (s.mode === 'SYNTHETIC') {
    initEmpty('LIVE');
  }

  const store = getStore();

  // Idempotency: avoid creating duplicate settlement records for the same payment_id
  const existingSR = store.settlementRecords.find(r => r.entity_id === payment_id);
  if (existingSR) {
    const existingRecon = store.reconciliationResults.find(r => r.settlement_entity_id === payment_id);
    return {
      success: true,
      duplicate: true,
      settlement_record: existingSR,
      reconciliation_result: existingRecon,
      status: existingRecon ? existingRecon.status : 'MATCHED',
    };
  }

  // Ensure an active settlement batch exists
  if (!store.settlementBatches || store.settlementBatches.length === 0) {
    const batchId = `setl_live_${Date.now().toString(36)}`;
    const settledAt = created_at + 172800; // T+2 simulated clearing
    store.settlementBatches.push({
      index: 0,
      id: batchId,
      utr: `UTR${created_at}${String(payment_id).slice(-4)}`,
      settled_at: settledAt,
      created_at: created_at,
    });
  }

  const batch = store.settlementBatches[0];
  const paymentCount = store.settlementRecords.filter(r => r.type === 'payment').length + 1;
  const moSeq = paymentCount;
  const moId = `mo_live_${moSeq}`;
  const ledId = `ledger_live_${moSeq}`;
  const orderReceipt = receipt || `rcpt_live_${moSeq}`;

  // Standard platform fee (2%) and GST (18% of fee)
  const { fee: defaultFee, tax: defaultTax, net: defaultNet } = calcFee(amount_paise);

  let scenario = anomaly || 'CLEAN_MATCH';
  let effectiveFee = defaultFee;
  let effectiveTax = defaultTax;
  let effectiveCredit = defaultNet;
  let omitOrderId = false;
  let duplicateClone = false;
  let unexplainedShortfall = 0;

  if (scenario === 'FEE_TAX_VARIANCE') {
    effectiveFee = defaultFee + 2500; // +₹25 fee discrepancy
    effectiveTax = Math.round(effectiveFee * 0.18);
    effectiveCredit = amount_paise - effectiveFee - effectiveTax;
  } else if (scenario === 'MISSING_ORDER') {
    omitOrderId = true;
  } else if (scenario === 'DUPLICATE') {
    duplicateClone = true;
  } else if (scenario === 'UNEXPLAINED') {
    unexplainedShortfall = 3500; // ₹35 unexplained shortfall
    effectiveCredit = defaultNet - unexplainedShortfall;
  }

  // 1. Create simulated SettlementRecord
  const sr = createSettlementRecord({
    entity_id: payment_id,
    type: 'payment',
    debit: 0,
    credit: effectiveCredit,
    amount: amount_paise,
    currency,
    fee: effectiveFee,
    tax: effectiveTax,
    settled: true,
    created_at,
    settled_at: batch.settled_at,
    settlement_id: batch.id,
    settlement_utr: batch.utr,
    order_id: omitOrderId ? null : (order_id || null),
    order_receipt: omitOrderId ? null : orderReceipt,
    method,
    _batch_index: 0,
    _scenario: scenario,
    _source: 'razorpay_test_mode',
  });
  store.settlementRecords.push(sr);

  // 2. Create MerchantOrder (unless MISSING_ORDER where order was omitted)
  if (!omitOrderId) {
    const mo = createMerchantOrder({
      id: moId,
      razorpay_order_id: order_id || `order_${moSeq}`,
      amount: amount_paise,
      currency,
      customer_email: email || `customer_${moSeq}@example.com`,
      customer_name: customer_name || `Customer ${moSeq}`,
      description: description || `Order for payment ${payment_id}`,
      created_at,
      status: 'paid',
      receipt: orderReceipt,
      _expected_classification: scenario,
    });
    store.merchantOrders.push(mo);

    // 3. Create MerchantLedger
    const le = createMerchantLedger({
      id: ledId,
      merchant_order_id: moId,
      expected_amount: defaultNet,
      posted_amount: effectiveCredit,
      status: scenario === 'UNEXPLAINED' ? 'discrepancy' : 'posted',
      posted_at: batch.settled_at,
      reference: payment_id,
      description: `Settlement posted for order ${moId} (Real payment: ${payment_id})`,
    });
    store.merchantLedger.push(le);
  }

  // If DUPLICATE scenario: clone a duplicate settlement credit
  if (duplicateClone) {
    const dupPayId = `pay_dup_${Date.now().toString(36)}`;
    const dupSr = createSettlementRecord({
      entity_id: dupPayId,
      type: 'payment',
      debit: 0,
      credit: effectiveCredit,
      amount: amount_paise,
      currency,
      fee: effectiveFee,
      tax: effectiveTax,
      settled: true,
      created_at: created_at + 120,
      settled_at: batch.settled_at,
      settlement_id: batch.id,
      settlement_utr: batch.utr,
      order_id: order_id || null,
      order_receipt: orderReceipt,
      method,
      _batch_index: 0,
      _scenario: 'DUPLICATE',
      _source: 'razorpay_test_mode_duplicate_injection',
    });
    store.settlementRecords.push(dupSr);
  }

  // If ADJUSTMENT scenario: add an unlinked gateway adjustment
  if (scenario === 'ADJUSTMENT') {
    const adjId = `adj_live_${Date.now().toString(36)}`;
    const adjSr = createSettlementRecord({
      entity_id: adjId,
      type: 'adjustment',
      debit: 0,
      credit: 1500, // ₹15.00 adjustment
      amount: 1500,
      currency,
      fee: 0,
      tax: 0,
      settled: true,
      created_at,
      settled_at: batch.settled_at,
      settlement_id: batch.id,
      settlement_utr: batch.utr,
      order_id: null,
      order_receipt: null,
      method: 'adjustment',
      _batch_index: 0,
      _scenario: 'ADJUSTMENT',
      _source: 'razorpay_test_mode_adjustment_injection',
    });
    store.settlementRecords.push(adjSr);
  }

  // Record in payments array
  store.payments = store.payments || [];
  store.payments.push({
    id: payment_id,
    payment_id,
    order_id,
    amount: amount_paise,
    amount_paise,
    amount_inr: (amount_paise / 100).toFixed(2),
    currency,
    method,
    receipt: orderReceipt,
    status: 'captured',
    created_at,
    settlement_status: 'EXPECTED_T2',
    settlement_id: batch.id,
    settled_at: batch.settled_at,
    net_credit: effectiveCredit,
    fee: effectiveFee,
    tax: effectiveTax,
    scenario,
  });

  // Deterministic Reconciliation
  const { results, exceptions } = reconcile({
    settlementRecords: store.settlementRecords,
    merchantOrders:    store.merchantOrders,
    merchantLedger:    store.merchantLedger,
    settlementBatches: store.settlementBatches,
  });

  store.reconciliationResults = results;
  store.exceptions = exceptions;
  store.stats = {
    orders_count:   store.merchantOrders.length,
    payments_count: store.settlementRecords.filter(r => r.type === 'payment').length,
    refunds_count:  store.settlementRecords.filter(r => r.type === 'refund').length,
  };

  const reconRes = store.reconciliationResults.find(r => r.payment_entity_id === payment_id || r.settlement_entity_id === payment_id || (sr && r.settlement_record_id === sr.id));
  const exc = store.exceptions.find(e => e.settlement_record_id === payment_id || (sr && e.settlement_record_id === sr.id) || (reconRes && e.reconciliation_result_id === reconRes.id));

  return {
    success: true,
    payment_id,
    order_id,
    amount_paise,
    currency,
    method,
    settlement_record: sr,
    reconciliation_result: reconRes,
    reconciliation_status: exc ? exc.category : (reconRes ? reconRes.status : 'MATCHED'),
    exception: exc || null,
    status: reconRes ? reconRes.status : 'MATCHED',
  };
}

/**
 * Sync from real Razorpay Test Mode idempotently (Mode B).
 */
async function syncRazorpay(adapter = null, options = {}) {
  const adp = adapter || genericPaymentAdapter;
  const { orders, payments, refunds } = await adp.fetchAllTransactions();

  const store = getStore();

  // If in synthetic mode or empty, simulate dataset directly
  if (store.mode === 'SYNTHETIC' || store.settlementRecords.length === 0) {
    const dataset = simulateSettlementDataset({ orders, payments, refunds }, options);
    const { results, exceptions } = reconcile(dataset);

    _store = {
      mode:                  'RAZORPAY_BACKED',
      data_source:           'razorpay_test_mode',
      settlement_source:     'simulated',
      simulation_version:    '1.0',
      settlementRecords:     dataset.settlementRecords,
      merchantOrders:        dataset.merchantOrders,
      merchantLedger:        dataset.merchantLedger,
      settlementBatches:     dataset.settlementBatches,
      reconciliationResults: results,
      exceptions,
      payments:              payments,
      _groundTruth:          dataset.groundTruth,
      _resetAt:              Date.now(),
      stats: {
        orders_count:   orders.length,
        payments_count: payments.length,
        refunds_count:  refunds.length,
      },
    };

    return _store;
  }

  // If already in LIVE mode, merge newly discovered payments idempotently
  const existingIds = new Set(store.settlementRecords.map(r => r.entity_id));
  for (const pay of payments) {
    if (!existingIds.has(pay.id)) {
      addPaymentTransaction({
        payment_id: pay.id,
        order_id: pay.order_id,
        amount_paise: pay.amount,
        currency: pay.currency,
        method: pay.method,
        created_at: pay.created_at,
      });
    }
  }

  return _store;
}

// ── Public Accessors ──────────────────────────────────────────────────────────

function getSettlementRecords()     { return getStore().settlementRecords; }
function getMerchantOrders()        { return getStore().merchantOrders; }
function getMerchantLedger()        { return getStore().merchantLedger; }
function getSettlementBatches()     { return getStore().settlementBatches; }
function getReconciliationResults() { return getStore().reconciliationResults; }
function getExceptions()            { return getStore().exceptions; }
function getPayments() {
  const store = getStore();
  if (store.payments && store.payments.length > 0) {
    return store.payments.map(p => ({
      id: p.id || p.payment_id,
      payment_id: p.payment_id || p.id,
      order_id: p.order_id,
      amount: p.amount || p.amount_paise || 0,
      amount_paise: p.amount_paise || p.amount || 0,
      amount_inr: ((p.amount_paise || p.amount || 0) / 100).toFixed(2),
      currency: p.currency || 'INR',
      method: p.method || 'card',
      status: p.status || 'captured',
      created_at: p.created_at,
      settlement_status: p.settlement_status || 'EXPECTED_T2',
      settlement_id: p.settlement_id,
      settled_at: p.settled_at,
      fee: p.fee || 0,
      tax: p.tax || 0,
      net_credit: p.net_credit || 0,
      scenario: p.scenario || 'CLEAN_MATCH',
    }));
  }
  return (store.settlementRecords || [])
    .filter(r => r.type === 'payment')
    .map(r => ({
      id: r.entity_id || r.id,
      payment_id: r.entity_id || r.id,
      order_id: r.order_id,
      amount: r.amount || 0,
      amount_paise: r.amount || 0,
      amount_inr: ((r.amount || 0) / 100).toFixed(2),
      currency: r.currency || 'INR',
      method: r.method || 'card',
      status: 'captured',
      created_at: r.created_at,
      settlement_status: r.settled ? 'SETTLED' : 'EXPECTED_T2',
      settlement_id: r.settlement_id,
      settled_at: r.settled_at,
      fee: r.fee || 0,
      tax: r.tax || 0,
      net_credit: r.credit || 0,
      scenario: r._scenario || 'CLEAN_MATCH',
    }));
}
function getMode()                  { return getStore().mode; }
function clear()                    { return initEmpty('LIVE'); }

/** EVALUATION ONLY — do not expose via API */
function _getGroundTruth()          { return getStore()._groundTruth; }

/**
 * Look up a full exception with all source records attached.
 */
function getExceptionDetail(excId) {
  const store = getStore();
  const exc   = store.exceptions.find(e => e.id === excId);
  if (!exc) return null;

  const result = store.reconciliationResults.find(r => r.id === exc.reconciliation_result_id);
  if (!result) return null;

  const settlementRecord = store.settlementRecords.find(
    sr => sr.entity_id === result.settlement_entity_id,
  ) || null;

  const merchantOrder = result.merchant_order_id
    ? store.merchantOrders.find(mo => mo.id === result.merchant_order_id)
    : null;

  const merchantLedgerEntry = result.merchant_ledger_id
    ? store.merchantLedger.find(le => le.id === result.merchant_ledger_id)
    : null;

  const refundRecords = (result.refund_entity_ids || []).map(
    rid => store.settlementRecords.find(sr => sr.entity_id === rid),
  ).filter(Boolean);

  return {
    exception:             exc,
    reconciliation_result: result,
    settlement_record:     settlementRecord,
    merchant_order:        merchantOrder,
    merchant_ledger:       merchantLedgerEntry,
    refund_records:        refundRecords,
    data_sources: {
      mode: store.mode,
      razorpay_side: {
        source: store.data_source,
        settlement_status: store.settlement_source,
        settlement_record: settlementRecord,
        refund_records:    refundRecords,
      },
      merchant_side: {
        order:  merchantOrder,
        ledger: merchantLedgerEntry,
      },
      derived: {
        reconciliation_result: result,
        exception:             exc,
      },
    },
  };
}

/**
 * Get lifecycle status & resolution record for an exception case.
 * Returns default { status: 'OPEN', resolution: null } if not explicitly updated.
 */
function getCaseLifecycle(caseId) {
  const store = getStore();
  const entry = store.caseStatus.get(caseId);
  if (entry) return entry;
  return {
    case_id:    caseId,
    status:     CaseStatus.OPEN,
    resolution: null,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Transition a case to IN_REVIEW (e.g. when an investigation is started).
 */
function setCaseInReview(caseId, actor = 'user', notes = 'AI investigation initiated') {
  const store = getStore();
  const current = getCaseLifecycle(caseId);

  // If already resolved, do not auto-demote to IN_REVIEW
  if (current.status === CaseStatus.RESOLVED) {
    return current;
  }

  if (current.status !== CaseStatus.IN_REVIEW) {
    const updated = {
      case_id:    caseId,
      status:     CaseStatus.IN_REVIEW,
      resolution: null,
      updated_at: Math.floor(Date.now() / 1000),
    };
    store.caseStatus.set(caseId, updated);

    const auditEvt = createAuditEvent({
      case_id:         caseId,
      action:          'START_REVIEW',
      previous_status: current.status,
      new_status:      CaseStatus.IN_REVIEW,
      notes,
      performed_by:    actor,
    });
    store.auditTrail.push(auditEvt);
    return updated;
  }

  return current;
}

/**
 * Resolve an exception case.
 */
function resolveCase(caseId, { resolution_reason, resolution_notes = '', resolved_by = 'user' } = {}) {
  const store = getStore();
  const exc = store.exceptions.find(e => e.id === caseId);
  if (!exc) {
    throw new Error(`Exception case '${caseId}' not found.`);
  }

  if (!isValidResolutionReason(resolution_reason)) {
    throw new Error(`Invalid resolution_reason '${resolution_reason}'. Must be one of valid ResolutionReason enum values.`);
  }

  const current = getCaseLifecycle(caseId);
  const now = Math.floor(Date.now() / 1000);
  const resolutionRecord = createResolutionRecord({
    case_id:           caseId,
    resolution_reason,
    resolution_notes,
    resolved_by,
    resolved_at:       now,
  });

  const updated = {
    case_id:    caseId,
    status:     CaseStatus.RESOLVED,
    resolution: resolutionRecord,
    updated_at: now,
  };
  store.caseStatus.set(caseId, updated);

  const auditEvt = createAuditEvent({
    case_id:           caseId,
    action:            'RESOLVED',
    previous_status:   current.status,
    new_status:        CaseStatus.RESOLVED,
    resolution_reason,
    notes:             resolution_notes,
    performed_by:      resolved_by,
    created_at:        now,
  });
  store.auditTrail.push(auditEvt);

  return updated;
}

/**
 * Reopen a resolved case back to OPEN while preserving previous resolution in audit history.
 */
function reopenCase(caseId, { reopen_notes = '', reopened_by = 'user' } = {}) {
  const store = getStore();
  const exc = store.exceptions.find(e => e.id === caseId);
  if (!exc) {
    throw new Error(`Exception case '${caseId}' not found.`);
  }

  const current = getCaseLifecycle(caseId);
  if (current.status !== CaseStatus.RESOLVED) {
    throw new Error(`Case '${caseId}' is not in RESOLVED status (current status: ${current.status}).`);
  }

  const now = Math.floor(Date.now() / 1000);
  const updated = {
    case_id:    caseId,
    status:     CaseStatus.OPEN,
    resolution: null, // Active resolution cleared, but preserved in audit trail!
    updated_at: now,
  };
  store.caseStatus.set(caseId, updated);

  const auditEvt = createAuditEvent({
    case_id:           caseId,
    action:            'REOPENED',
    previous_status:   CaseStatus.RESOLVED,
    new_status:        CaseStatus.OPEN,
    notes:             reopen_notes || 'Case reopened by operator.',
    performed_by:      reopened_by,
    created_at:        now,
  });
  store.auditTrail.push(auditEvt);

  return updated;
}

/**
 * Get audit trail for a specific case.
 */
function getCaseAuditTrail(caseId) {
  const store = getStore();
  return store.auditTrail.filter(a => a.case_id === caseId);
}

/**
 * Get all audit events across all cases.
 */
function getAllAuditEvents() {
  const store = getStore();
  return [...store.auditTrail];
}

/**
 * Save an AI investigation analysis result for a case.
 */
function saveAiInvestigation(caseId, result) {
  const store = getStore();
  if (!store.aiInvestigations) store.aiInvestigations = new Map();
  store.aiInvestigations.set(caseId, result);
  return result;
}

/**
 * Retrieve saved AI investigation analysis result for a case.
 */
function getAiInvestigation(caseId) {
  const store = getStore();
  if (!store.aiInvestigations) return null;
  return store.aiInvestigations.get(caseId) || null;
}

/**
 * Compute summary statistics for GET /api/reconciliation/summary.
 */
function getSummary() {
  const store = getStore();
  const results    = store.reconciliationResults || [];
  const exceptions = store.exceptions || [];

  const totalRecords = store.settlementRecords.length;
  const matched = results.filter(r => r.status === 'MATCHED').length;
  const partiallyMatched = results.filter(r => r.status === 'PARTIALLY_MATCHED').length;
  const exceptionCount = results.filter(r => r.status === 'EXCEPTION').length;

  const totalAmount = store.settlementRecords
    .filter(sr => sr.type === 'payment')
    .reduce((s, sr) => s + sr.amount, 0);

  // Lifecycle breakdown
  let exceptionsOpen = 0;
  let exceptionsInReview = 0;
  let exceptionsResolved = 0;
  let amountAtRiskOpen = 0;
  let amountAtRiskResolved = 0;
  let amountAtRiskTotal = 0;

  for (const exc of exceptions) {
    const lifecycle = getCaseLifecycle(exc.id);
    const amount = exc.amount_at_risk || 0;
    amountAtRiskTotal += amount;

    if (lifecycle.status === CaseStatus.RESOLVED) {
      exceptionsResolved++;
      amountAtRiskResolved += amount;
    } else if (lifecycle.status === CaseStatus.IN_REVIEW) {
      exceptionsInReview++;
      amountAtRiskOpen += amount;
    } else {
      exceptionsOpen++;
      amountAtRiskOpen += amount;
    }
  }

  const exceptionsByCategory = {};
  for (const exc of exceptions) {
    exceptionsByCategory[exc.category] = (exceptionsByCategory[exc.category] || 0) + 1;
  }

  const dataNote = store.mode === 'SYNTHETIC'
    ? 'SYNTHETIC DATA — Razorpay Test Mode does not provide completed settlement batches. These records are schema-accurate synthetic replicas for demonstration purposes.'
    : 'RAZORPAY TEST MODE + SIMULATED SETTLEMENTS — Transaction data (orders, payments, refunds) is sourced from Razorpay Test Mode; settlement lifecycle and settlement records are simulated because Razorpay Test Mode does not execute the production settlement pipeline.';

  return {
    mode:                          store.mode,
    data_source:                   store.data_source,
    settlement_source:             store.settlement_source,
    simulation_version:            store.simulation_version,
    total_settlement_records:      totalRecords,
    merchant_orders:               store.merchantOrders.length,
    merchant_ledger_entries:       store.merchantLedger.length,
    reconciliation_results:        results.length,
    matched,
    partially_matched:             partiallyMatched,
    exceptions:                    exceptionCount,
    exceptions_total:              exceptions.length,
    exceptions_open:               exceptionsOpen,
    exceptions_in_review:          exceptionsInReview,
    exceptions_resolved:           exceptionsResolved,
    total_amount_paise:            totalAmount,
    total_amount_reconciled_paise: totalAmount,
    total_amount_inr:              (totalAmount / 100).toFixed(2),
    // Active unresolved exposure (backwards compatible field + new explicit fields)
    amount_at_risk_paise:          amountAtRiskOpen,
    total_amount_at_risk_paise:    amountAtRiskTotal,
    amount_at_risk_inr:            (amountAtRiskOpen / 100).toFixed(2),
    amount_at_risk_open_paise:     amountAtRiskOpen,
    amount_at_risk_open_inr:       (amountAtRiskOpen / 100).toFixed(2),
    amount_at_risk_resolved_paise: amountAtRiskResolved,
    amount_at_risk_resolved_inr:   (amountAtRiskResolved / 100).toFixed(2),
    amount_at_risk_total_paise:    amountAtRiskTotal,
    amount_at_risk_total_inr:      (amountAtRiskTotal / 100).toFixed(2),
    exception_categories:          exceptionsByCategory,
    settlement_batches:            store.settlementBatches.length,
    last_reset_at:                 store._resetAt,
    stats:                         store.stats,
    data_note:                     dataNote,
  };
}

// ── PayPal Sandbox Integration Storage ───────────────────────────────────────
function addPayPalOrder(order) {
  const s = getStore();
  if (!order || !order.order_id) {
    throw new Error('addPayPalOrder requires an order object with order_id.');
  }
  s.paypalOrders.set(order.order_id, {
    ...order,
    status: order.status || 'CREATED',
    registered_at: order.registered_at || Date.now(),
  });
  _savePayPalDiskState();
  return s.paypalOrders.get(order.order_id);
}

function getPayPalOrder(orderId) {
  const s = getStore();
  return s.paypalOrders.get(orderId) || null;
}

function getPayPalOrders() {
  const s = getStore();
  return Array.from(s.paypalOrders.values());
}

function addPayPalCapture(capture) {
  const s = getStore();
  if (!capture || !capture.capture_id) {
    throw new Error('addPayPalCapture requires a capture object with capture_id.');
  }

  // Update order status if order_id is present
  if (capture.order_id && s.paypalOrders.has(capture.order_id)) {
    const ord = s.paypalOrders.get(capture.order_id);
    ord.status = 'COMPLETED';
    ord.capture_id = capture.capture_id;
    ord.captured_at = Date.now();
  }

  // Idempotency: avoid duplicate captures
  const existing = s.paypalCaptures.find(c => c.capture_id === capture.capture_id);
  if (existing) {
    _savePayPalDiskState();
    return existing;
  }

  const record = {
    ...capture,
    gateway: 'PAYPAL_SANDBOX',
    is_gateway_capture: true,
    is_bank_settlement: false, // strictly maintain distinction
    captured_at: capture.create_time || new Date().toISOString(),
    ingested_at: Date.now(),
  };

  s.paypalCaptures.unshift(record);

  // Append audit event for traceability
  s.auditTrail.push({
    event_id: `audit_pp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    event_type: 'PAYPAL_CAPTURE_RECORDED',
    entity_id: capture.capture_id,
    order_id: capture.order_id,
    details: {
      amount_minor: capture.amount_minor,
      currency: capture.currency,
      status: capture.capture_status,
      idempotency_key: capture.idempotency_key,
    },
    created_at: new Date().toISOString(),
  });

  _savePayPalDiskState();
  return record;
}

function reconcilePayPalCapture(capture) {
  const s = getStore();
  if (!capture || !capture.capture_id) return null;

  const ord = capture.order_id ? s.paypalOrders.get(capture.order_id) : null;
  const isMatch = !!(ord && ord.amount_minor === capture.amount_minor && ord.currency === capture.currency);

  let excId = null;
  if (!isMatch) {
    excId = `exc_pp_${capture.capture_id.slice(-6)}`;
    const existingExc = s.exceptions.find(e => e.id === excId);
    if (!existingExc) {
      s.exceptions.unshift({
        id: excId,
        case_id: excId,
        category: ord ? 'FEE_TAX_VARIANCE' : 'MISSING_ORDER',
        amount_at_risk: ord ? Math.abs(ord.amount_minor - capture.amount_minor) : capture.amount_minor,
        currency: capture.currency,
        status: 'OPEN',
        priority: 'HIGH',
        reconciliation_result_id: `recon_pp_${capture.capture_id}`,
        order_id: capture.order_id,
        description: ord
          ? `PayPal capture amount variance for order ${capture.order_id} (Expected: ${ord.amount_minor}, Captured: ${capture.amount_minor})`
          : `PayPal capture with missing registered order ${capture.order_id}`,
        created_at: Math.floor(Date.now() / 1000),
        source: 'PAYPAL_SANDBOX_RECON',
      });
    }
  }

  const reconResult = {
    id: `recon_pp_${capture.capture_id}`,
    settlement_entity_id: capture.capture_id,
    merchant_order_id: capture.order_id,
    amount_paise: capture.amount_minor,
    currency: capture.currency,
    gateway: 'PAYPAL_SANDBOX',
    status: isMatch ? 'MATCHED' : 'EXCEPTION',
    exception_id: excId,
    created_at: Math.floor(Date.now() / 1000),
  };

  const existingIdx = s.reconciliationResults.findIndex(r => r.id === reconResult.id);
  if (existingIdx >= 0) {
    s.reconciliationResults[existingIdx] = reconResult;
  } else {
    s.reconciliationResults.unshift(reconResult);
  }

  s.auditTrail.push({
    event_id: `audit_recon_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    case_id: excId,
    action: 'PAYPAL_RECONCILED',
    event_type: 'PAYPAL_RECONCILIATION_COMPLETED',
    entity_id: capture.capture_id,
    order_id: capture.order_id,
    details: {
      status: reconResult.status,
      amount_minor: capture.amount_minor,
      currency: capture.currency,
      is_gateway_capture: true,
    },
    performed_by: 'Payvault Deterministic Recon Engine',
    created_at: Date.now(),
  });

  _savePayPalDiskState();
  return reconResult;
}

function recordDisputeAudit(disputeData = {}) {
  const s = getStore();
  const eventId = disputeData.event_id || `evt_${Date.now()}`;
  const excId = `exc_disp_${eventId.slice(-8)}`;

  s.auditTrail.push({
    event_id: `audit_disp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    case_id: excId,
    action: disputeData.action_taken || 'DISPUTE_LOGGED',
    event_type: disputeData.event_type || 'PAYPAL_DISPUTE_RECORDED',
    entity_id: disputeData.resource_id,
    details: {
      event_id: eventId,
      amount_minor: disputeData.amount_minor,
      currency: disputeData.currency,
      ...disputeData.details,
    },
    performed_by: 'PayPal Sandbox Webhook Receiver',
    created_at: Date.now(),
  });

  if (disputeData.review_required) {
    const existingExc = s.exceptions.find(e => e.id === excId || (disputeData.resource_id && e.order_id === disputeData.resource_id));
    if (!existingExc) {
      s.exceptions.unshift({
        id: excId,
        case_id: excId,
        category: disputeData.exception_type || 'DISPUTE_REVERSAL',
        amount_at_risk: disputeData.amount_minor || 0,
        currency: disputeData.currency || 'USD',
        status: 'OPEN',
        priority: 'HIGH',
        order_id: disputeData.resource_id,
        description: `PayPal Dispute / Reversal: ${disputeData.details?.reason || disputeData.action_taken || 'Under Review'}`,
        reconciliation_result_id: `recon_${disputeData.resource_id}`,
        created_at: Math.floor(Date.now() / 1000),
        source: 'PAYPAL_SANDBOX_WEBHOOK',
      });
    }
  }

  _savePayPalDiskState();
}

function getPayPalCaptures() {
  const s = getStore();
  return s.paypalCaptures;
}

// ── Durable Pre-Network Idempotency Key Registry ──────────────────────────────
function registerIdempotencyKey(key, metadata = {}) {
  const s = getStore();
  if (!key) throw new Error('registerIdempotencyKey requires a key string.');
  if (!s.paypalIdempotency) s.paypalIdempotency = new Map();

  const previous = s.paypalIdempotency.get(key);
  const record = {
    key,
    status: 'IN_FLIGHT',
    metadata,
    created_at: Date.now(),
  };
  s.paypalIdempotency.set(key, record);

  try {
    (module.exports._savePayPalDiskState || _savePayPalDiskState)(true);
  } catch (err) {
    // Rollback in-memory state on persistence failure so safe state is restored
    if (previous !== undefined) {
      s.paypalIdempotency.set(key, previous);
    } else {
      s.paypalIdempotency.delete(key);
    }
    throw new Error(`Durable persistence failed: unable to register idempotency key '${key}' before network call: ${err.message}`);
  }

  return record;
}

function getIdempotencyRecord(key) {
  const s = getStore();
  if (!s.paypalIdempotency) s.paypalIdempotency = new Map();
  const rec = s.paypalIdempotency.get(key);
  if (!rec) return null;

  // Auto-expire stale IN_FLIGHT requests after timeout so retries are never permanently blocked
  if (rec.status === 'IN_FLIGHT' && rec.created_at && (Date.now() - rec.created_at > IN_FLIGHT_TIMEOUT_MS)) {
    rec.status = 'TIMED_OUT';
    rec.expired = true;
    _savePayPalDiskState();
  }
  return rec;
}

function completeIdempotencyKey(key, response) {
  const s = getStore();
  if (!s.paypalIdempotency) s.paypalIdempotency = new Map();
  const existing = s.paypalIdempotency.get(key) || { key, created_at: Date.now() };
  existing.status = 'COMPLETED';
  existing.response = response;
  existing.completed_at = Date.now();
  s.paypalIdempotency.set(key, existing);
  _savePayPalDiskState();
  return existing;
}

function failIdempotencyKey(key, error) {
  const s = getStore();
  if (!s.paypalIdempotency) s.paypalIdempotency = new Map();
  const existing = s.paypalIdempotency.get(key) || { key, created_at: Date.now() };
  existing.status = 'FAILED';
  existing.error = typeof error === 'string' ? error : error?.message || 'Unknown error';
  existing.failed_at = Date.now();
  s.paypalIdempotency.set(key, existing);
  _savePayPalDiskState();
  return existing;
}

// ── Durable Webhook Deduplication & Out-of-Order Resource State Registry ─────
function recordWebhookEvent(eventId, eventData) {
  const s = getStore();
  if (!s.paypalWebhookEvents) s.paypalWebhookEvents = new Map();
  s.paypalWebhookEvents.set(eventId, eventData);
  _savePayPalDiskState();
  return eventData;
}

function getWebhookEvent(eventId) {
  const s = getStore();
  if (!s.paypalWebhookEvents) s.paypalWebhookEvents = new Map();
  return s.paypalWebhookEvents.get(eventId) || null;
}

function setResourceState(resourceId, stateData) {
  const s = getStore();
  if (!s.paypalResourceStates) s.paypalResourceStates = new Map();
  s.paypalResourceStates.set(resourceId, stateData);
  _savePayPalDiskState();
  return stateData;
}

function getResourceState(resourceId) {
  const s = getStore();
  if (!s.paypalResourceStates) s.paypalResourceStates = new Map();
  return s.paypalResourceStates.get(resourceId) || null;
}

function resetWebhookStorage() {
  const s = getStore();
  if (s.paypalWebhookEvents) s.paypalWebhookEvents.clear();
  if (s.paypalResourceStates) s.paypalResourceStates.clear();
  _savePayPalDiskState();
}

module.exports = {
  initEmpty,
  reset,
  clear,
  syncRazorpay,
  addPaymentTransaction,
  addPayPalOrder,
  registerPayPalOrder: addPayPalOrder,
  getPayPalOrder,
  getPayPalOrders,
  addPayPalCapture,
  getPayPalCaptures,
  reconcilePayPalCapture,
  recordDisputeAudit,
  registerIdempotencyKey,
  getIdempotencyRecord,
  completeIdempotencyKey,
  failIdempotencyKey,
  recordWebhookEvent,
  getWebhookEvent,
  setResourceState,
  getResourceState,
  resetWebhookStorage,
  _savePayPalDiskState,
  _loadPayPalDiskState,
  _clearPayPalDiskState,
  getPayPalStoreFile,
  IN_FLIGHT_TIMEOUT_MS,
  getStore,
  getPayPalCaptures,
  reconcilePayPalCapture,
  recordDisputeAudit,
  registerIdempotencyKey,
  getIdempotencyRecord,
  completeIdempotencyKey,
  failIdempotencyKey,
  _savePayPalDiskState,
  _loadPayPalDiskState,
  _clearPayPalDiskState,
  getStore,
  getMode,
  getSettlementRecords,
  getMerchantOrders,
  getMerchantLedger,
  getSettlementBatches,
  getReconciliationResults,
  getExceptions,
  getPayments,
  getExceptionDetail,
  getSummary,
  getCaseLifecycle,
  setCaseInReview,
  resolveCase,
  reopenCase,
  getCaseAuditTrail,
  getAllAuditEvents,
  saveAiInvestigation,
  getAiInvestigation,
  _getGroundTruth,
};

