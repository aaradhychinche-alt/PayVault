'use strict';
/**
 * tests/simulator.test.js
 *
 * Automated tests for Chunk 1.5: Razorpay-Backed Settlement Simulation Layer.
 *
 * Validates:
 * 1. Razorpay payment becomes settlement record.
 * 2. Real Razorpay payment ID is preserved.
 * 3. Real Razorpay order ID is preserved.
 * 4. Real refund payment_id relationship is preserved.
 * 5. Settlement IDs are generated deterministically.
 * 6. Settlement UTRs are generated deterministically.
 * 7. Same input + same seed produces identical output.
 * 8. Different input produces different settlement records.
 * 9. Timing mismatch injection works.
 * 10. Missing order injection works.
 * 11. Duplicate injection works.
 * 12. Fee/tax variance injection works.
 * 13. Existing Chunk 1 tests still pass.
 * 14. Existing synthetic mode still works.
 * 15. Razorpay-backed mode works with zero payments gracefully.
 *
 * NOTE: Tests use a mocked adapter — no dependency on live Razorpay API uptime.
 */

const { simulateSettlementDataset } = require('../src/data/simulator');
const { reconcile }                 = require('../src/engine/reconcile');
const store                         = require('../src/store/dataStore');
const { normalizePayment, normalizeRefund, normalizeOrder } = require('../src/payments/adapter');

// ── Mock data fixtures ────────────────────────────────────────────────────────

const mockOrders = [
  { id: 'order_REAL001', amount: 50000, currency: 'INR', receipt: 'rcpt_r001', status: 'paid', created_at: 1753920000 },
  { id: 'order_REAL002', amount: 120000, currency: 'INR', receipt: 'rcpt_r002', status: 'paid', created_at: 1753923600 },
  { id: 'order_REAL003', amount: 250000, currency: 'INR', receipt: 'rcpt_r003', status: 'paid', created_at: 1753927200 },
  { id: 'order_REAL004', amount: 80000, currency: 'INR', receipt: 'rcpt_r004', status: 'paid', created_at: 1753930800 },
  { id: 'order_REAL005', amount: 150000, currency: 'INR', receipt: 'rcpt_r005', status: 'paid', created_at: 1753934400 },
].map(normalizeOrder);

const mockPayments = [
  { id: 'pay_REAL_AAA111', order_id: 'order_REAL001', amount: 50000, currency: 'INR', status: 'captured', method: 'card', created_at: 1753920100 },
  { id: 'pay_REAL_BBB222', order_id: 'order_REAL002', amount: 120000, currency: 'INR', status: 'captured', method: 'upi', created_at: 1753923700 },
  { id: 'pay_REAL_CCC333', order_id: 'order_REAL003', amount: 250000, currency: 'INR', status: 'captured', method: 'card', created_at: 1753927300 },
  { id: 'pay_REAL_DDD444', order_id: 'order_REAL004', amount: 80000, currency: 'INR', status: 'captured', method: 'netbanking', created_at: 1753930900 },
  { id: 'pay_REAL_EEE555', order_id: 'order_REAL005', amount: 150000, currency: 'INR', status: 'captured', method: 'wallet', created_at: 1753934500 },
].map(normalizePayment);

const mockRefunds = [
  { id: 'rfnd_REAL_RF1', payment_id: 'pay_REAL_AAA111', amount: 20000, currency: 'INR', status: 'processed', created_at: 1753925000 },
].map(normalizeRefund);

describe('Chunk 1.5 — Settlement Simulator Suite', () => {

  beforeEach(() => {
    store.reset();
  });

  // 1. Razorpay payment becomes settlement record
  test('1. Real Razorpay payment generates a valid settlement record', () => {
    const dataset = simulateSettlementDataset({
      orders: [mockOrders[0]],
      payments: [mockPayments[0]],
      refunds: [],
    }, { injectExceptions: false });

    expect(dataset.settlementRecords.length).toBeGreaterThan(0);
    const sr = dataset.settlementRecords.find(r => r.entity_id === 'pay_REAL_AAA111');
    expect(sr).toBeDefined();
    expect(sr.type).toBe('payment');
    expect(sr.amount).toBe(50000);
    expect(sr.settled).toBe(true);
  });

  // 2. Real Razorpay payment ID is preserved
  test('2. Real Razorpay payment ID is preserved exactly', () => {
    const dataset = simulateSettlementDataset({
      orders: mockOrders,
      payments: mockPayments,
      refunds: mockRefunds,
    });

    const paymentIds = dataset.settlementRecords
      .filter(r => r.type === 'payment')
      .map(r => r.entity_id);

    expect(paymentIds).toContain('pay_REAL_AAA111');
    expect(paymentIds).toContain('pay_REAL_BBB222');
    expect(paymentIds).toContain('pay_REAL_CCC333');
    expect(paymentIds).toContain('pay_REAL_DDD444');
    expect(paymentIds).toContain('pay_REAL_EEE555');
  });

  // 3. Real Razorpay order ID is preserved
  test('3. Real Razorpay order ID is preserved on normal settlement records', () => {
    const dataset = simulateSettlementDataset({
      orders: [mockOrders[0]],
      payments: [mockPayments[0]],
      refunds: [],
    }, { injectExceptions: false });

    const sr = dataset.settlementRecords.find(r => r.entity_id === 'pay_REAL_AAA111');
    expect(sr.order_id).toBe('order_REAL001');
  });

  // 4. Real refund payment_id relationship is preserved
  test('4. Real refund payment_id relationship is preserved', () => {
    const dataset = simulateSettlementDataset({
      orders: mockOrders,
      payments: mockPayments,
      refunds: mockRefunds,
    });

    const refundSr = dataset.settlementRecords.find(r => r.entity_id === 'rfnd_REAL_RF1');
    expect(refundSr).toBeDefined();
    expect(refundSr.payment_id).toBe('pay_REAL_AAA111');
    expect(refundSr.type).toBe('refund');
    expect(refundSr.debit).toBe(20000);
  });

  // 5. Settlement IDs are generated deterministically
  test('5. Settlement IDs are generated deterministically', () => {
    const ds1 = simulateSettlementDataset({ orders: mockOrders, payments: mockPayments, refunds: mockRefunds }, { seed: 12345 });
    const ds2 = simulateSettlementDataset({ orders: mockOrders, payments: mockPayments, refunds: mockRefunds }, { seed: 12345 });

    expect(ds1.settlementBatches.length).toBe(ds2.settlementBatches.length);
    expect(ds1.settlementBatches[0].id).toBe(ds2.settlementBatches[0].id);
    expect(ds1.settlementRecords[0].settlement_id).toBe(ds2.settlementRecords[0].settlement_id);
  });

  // 6. Settlement UTRs are generated deterministically
  test('6. Settlement UTRs are generated deterministically', () => {
    const ds1 = simulateSettlementDataset({ orders: mockOrders, payments: mockPayments, refunds: mockRefunds }, { seed: 9999 });
    const ds2 = simulateSettlementDataset({ orders: mockOrders, payments: mockPayments, refunds: mockRefunds }, { seed: 9999 });

    expect(ds1.settlementBatches[0].utr).toBe(ds2.settlementBatches[0].utr);
    expect(ds1.settlementRecords[0].settlement_utr).toBe(ds2.settlementRecords[0].settlement_utr);
  });

  // 7. Same input + same seed produces identical output
  test('7. Same input + same seed produces identical output', () => {
    const ds1 = simulateSettlementDataset({ orders: mockOrders, payments: mockPayments, refunds: mockRefunds }, { seed: 42 });
    const ds2 = simulateSettlementDataset({ orders: mockOrders, payments: mockPayments, refunds: mockRefunds }, { seed: 42 });

    expect(ds1.settlementRecords.length).toBe(ds2.settlementRecords.length);
    expect(ds1.merchantOrders.length).toBe(ds2.merchantOrders.length);
    expect(ds1.settlementRecords.map(r => r.entity_id)).toEqual(ds2.settlementRecords.map(r => r.entity_id));
  });

  // 8. Different input produces different settlement records
  test('8. Different input produces different settlement records', () => {
    const altPayments = [
      { id: 'pay_ALT_999', order_id: 'order_ALT', amount: 99900, currency: 'INR', status: 'captured', method: 'card', created_at: 1753920000 },
    ].map(normalizePayment);

    const ds1 = simulateSettlementDataset({ orders: mockOrders, payments: mockPayments, refunds: [] }, { injectExceptions: false });
    const ds2 = simulateSettlementDataset({ orders: [], payments: altPayments, refunds: [] }, { injectExceptions: false });

    expect(ds1.settlementRecords[0].entity_id).not.toBe(ds2.settlementRecords[0].entity_id);
    expect(ds1.settlementRecords[0].amount).not.toBe(ds2.settlementRecords[0].amount);
  });

  // 9. Timing mismatch injection works
  test('9. Timing mismatch injection places payment and refund in different batches', () => {
    const dataset = simulateSettlementDataset({
      orders: mockOrders,
      payments: mockPayments,
      refunds: mockRefunds,
    }, { injectExceptions: true });

    const paySr  = dataset.settlementRecords.find(r => r.entity_id === 'pay_REAL_AAA111');
    const rfndSr = dataset.settlementRecords.find(r => r.entity_id === 'rfnd_REAL_RF1');

    expect(paySr).toBeDefined();
    expect(rfndSr).toBeDefined();
    expect(paySr.settlement_id).not.toBe(rfndSr.settlement_id);

    const { exceptions } = reconcile(dataset);
    const timingExc = exceptions.find(e => e.category === 'TIMING_MISMATCH');
    expect(timingExc).toBeDefined();
  });

  // 10. Missing order injection works
  test('10. Missing order injection clears order_id on target record', () => {
    const dataset = simulateSettlementDataset({
      orders: mockOrders,
      payments: mockPayments,
      refunds: mockRefunds,
    }, { injectExceptions: true });

    const missingOrderSr = dataset.settlementRecords.find(r => r.entity_id === mockPayments[2].id);
    expect(missingOrderSr.order_id).toBeNull();

    const { exceptions } = reconcile(dataset);
    const missingExc = exceptions.find(e => e.category === 'MISSING_ORDER');
    expect(missingExc).toBeDefined();
  });

  // 11. Duplicate injection works
  test('11. Duplicate injection clones a simulated settlement record within 300s window', () => {
    const dataset = simulateSettlementDataset({
      orders: mockOrders,
      payments: mockPayments,
      refunds: mockRefunds,
    }, { injectExceptions: true });

    const targetPayment = mockPayments[3];
    const dups = dataset.settlementRecords.filter(r => r.order_id === targetPayment.order_id && r.type === 'payment');
    expect(dups.length).toBe(2);

    const { exceptions } = reconcile(dataset);
    const dupExc = exceptions.find(e => e.category === 'DUPLICATE');
    expect(dupExc).toBeDefined();
  });

  // 12. Fee/tax variance injection works
  test('12. Fee/tax variance injection creates an exception for altered fee', () => {
    const dataset = simulateSettlementDataset({
      orders: mockOrders,
      payments: mockPayments,
      refunds: mockRefunds,
    }, { injectExceptions: true });

    const feeVarianceSr = dataset.settlementRecords.find(r => r.entity_id === mockPayments[1].id);
    expect(feeVarianceSr._scenario).toBe('FEE_TAX_VARIANCE');

    const { exceptions } = reconcile(dataset);
    const feeExc = exceptions.find(e => e.category === 'FEE_TAX_VARIANCE');
    expect(feeExc).toBeDefined();
  });

  // 13. Existing Chunk 1 tests still pass (verified via engine.test.js)
  test('13. Simulated dataset can be processed by the existing reconciliation engine', () => {
    const dataset = simulateSettlementDataset({
      orders: mockOrders,
      payments: mockPayments,
      refunds: mockRefunds,
    }, { injectExceptions: true });

    const { results, exceptions } = reconcile(dataset);
    expect(results.length).toBeGreaterThan(0);
    expect(exceptions.length).toBeGreaterThan(0);

    for (const res of results) {
      expect(res.id).toBeDefined();
      expect(res.status).toBeDefined();
      expect(res.reason).toBeDefined();
    }
  });

  // 14. Existing synthetic mode still works
  test('14. Existing Mode A (Synthetic reset) still works and sets mode=SYNTHETIC', () => {
    store.reset();
    expect(store.getMode()).toBe('SYNTHETIC');
    const summary = store.getSummary();
    expect(summary.mode).toBe('SYNTHETIC');
    expect(summary.data_source).toBe('synthetic');
    expect(summary.total_settlement_records).toBeGreaterThanOrEqual(60);
  });

  // 15. Razorpay-backed mode works with zero payments gracefully
  test('15. Razorpay-backed mode with zero payments returns empty dataset gracefully without crash', async () => {
    const mockAdapter = {
      fetchAllTransactions: async () => ({ orders: [], payments: [], refunds: [] }),
    };

    const updatedStore = await store.syncRazorpay(mockAdapter);
    expect(updatedStore.mode).toBe('RAZORPAY_BACKED');
    expect(updatedStore.settlementRecords.length).toBe(0);
    expect(updatedStore.exceptions.length).toBe(0);

    const summary = store.getSummary();
    expect(summary.total_settlement_records).toBe(0);
    expect(summary.exceptions).toBe(0);
  });

  test('16. syncRazorpay with realistic mocked adapter updates store and summary', async () => {
    const mockAdapter = {
      fetchAllTransactions: async () => ({
        orders: mockOrders,
        payments: mockPayments,
        refunds: mockRefunds,
      }),
    };

    const updatedStore = await store.syncRazorpay(mockAdapter);
    expect(updatedStore.mode).toBe('RAZORPAY_BACKED');
    expect(updatedStore.settlementRecords.length).toBeGreaterThan(0);

    const summary = store.getSummary();
    expect(summary.mode).toBe('RAZORPAY_BACKED');
    expect(summary.data_source).toBe('razorpay_test_mode');
    expect(summary.settlement_source).toBe('simulated');
    expect(summary.data_note).toContain('RAZORPAY TEST MODE + SIMULATED SETTLEMENTS');
  });

});
