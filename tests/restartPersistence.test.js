'use strict';
/**
 * tests/restartPersistence.test.js
 *
 * Real Separate-Process Restart & Recovery Verification:
 * - Real separate child process execution on an isolated temporary store
 * - Process 1 writes orders, captures, completed idempotency keys, in-flight keys, and webhook states, then exits
 * - Process 2 launches in a clean, separate OS process, restores state from disk
 * - Verifies durable recovery of:
 *   1. Orders & Captures
 *   2. In-flight idempotency recovery (no permanent IN_FLIGHT lock after process restart/timeout)
 *   3. Durable webhook deduplication across real process restarts
 *   4. Durable out-of-order terminal state protection (REFUNDED never downgraded by delayed capture)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Real Separate-Process Restart & Recovery Suite', () => {
  const tempStoreFile = path.join(os.tmpdir(), `payvault_proc_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);

  afterAll(() => {
    try {
      if (fs.existsSync(tempStoreFile)) {
        fs.unlinkSync(tempStoreFile);
      }
    } catch {
      // Non-fatal
    }
  });

  test('Process 1 writes state to temp store, exits; Process 2 restores and verifies durable state & in-flight recovery', () => {
    // ── STEP 1: Child Process 1 writes state and exits cleanly ─────────────────
    const proc1Script = `
      const store = require('./src/store/dataStore');
      const { processWebhookEvent } = require('./src/paypal/webhook');

      // Initialize with isolated disk store
      store.initEmpty('LIVE', { loadDisk: true });

      // 1. Add order
      store.addPayPalOrder({
        order_id: 'PROC1-ORDER-001',
        amount_minor: 5000,
        amount_decimal: '50.00',
        currency: 'USD',
        status: 'CREATED',
        reference_id: 'ref_proc1_001',
      });

      // 2. Add capture
      store.addPayPalCapture({
        order_id: 'PROC1-ORDER-001',
        capture_id: 'PROC1-CAP-001',
        capture_status: 'COMPLETED',
        amount_minor: 5000,
        currency: 'USD',
        idempotency_key: 'idemp_cap_proc1',
      });

      // 3. Register a completed idempotency key
      store.registerIdempotencyKey('idemp_completed_proc1', { type: 'CREATE_ORDER' });
      store.completeIdempotencyKey('idemp_completed_proc1', { success: true, order_id: 'PROC1-ORDER-001' });

      // 4. Register an in-flight key (simulating a crash / power loss mid-flight)
      store.registerIdempotencyKey('idemp_inflight_proc1', { type: 'CREATE_ORDER' });

      // 5. Process a webhook event
      processWebhookEvent({
        id: 'WH-PROC1-EVENT-001',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: 'RES-REFUND-PROC1', amount: { value: '50.00', currency_code: 'USD' } },
      });

      process.exit(0);
    `;

    execSync(`node -e "${proc1Script.replace(/"/g, '\\"')}"`, {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PAYPAL_STORE_PATH: tempStoreFile, NODE_ENV: 'production' },
      stdio: 'pipe',
    });

    // Verify temp file was written by Process 1
    expect(fs.existsSync(tempStoreFile)).toBe(true);

    // ── STEP 2: Child Process 2 starts in a new OS process, restores & verifies ─
    const proc2Script = `
      const store = require('./src/store/dataStore');
      const { processWebhookEvent } = require('./src/paypal/webhook');

      // Initialize clean in Process 2; should restore from disk
      store.initEmpty('LIVE', { loadDisk: true });

      // 1. Verify restored order
      const ord = store.getPayPalOrder('PROC1-ORDER-001');
      if (!ord || ord.status !== 'COMPLETED') {
        console.error('FAIL: Order not restored properly');
        process.exit(1);
      }

      // 2. Verify restored capture
      const caps = store.getPayPalCaptures();
      const cap = caps.find(c => c.capture_id === 'PROC1-CAP-001');
      if (!cap || cap.amount_minor !== 5000) {
        console.error('FAIL: Capture not restored properly');
        process.exit(2);
      }

      // 3. Verify completed idempotency key
      const compIdem = store.getIdempotencyRecord('idemp_completed_proc1');
      if (!compIdem || compIdem.status !== 'COMPLETED') {
        console.error('FAIL: Completed idempotency key not restored');
        process.exit(3);
      }

      // 4. Verify in-flight recovery (no permanent IN_FLIGHT lock after process restart)
      const inFlightIdem = store.getIdempotencyRecord('idemp_inflight_proc1');
      if (!inFlightIdem || inFlightIdem.status === 'IN_FLIGHT') {
        console.error('FAIL: In-flight key was not recovered from dead process; permanent lock detected!');
        process.exit(4);
      }
      if (inFlightIdem.status !== 'INTERRUPTED_RETRYABLE') {
        console.error('FAIL: In-flight key status expected INTERRUPTED_RETRYABLE, got: ' + inFlightIdem.status);
        process.exit(5);
      }

      // 5. Verify durable webhook deduplication across processes
      const dupWebhook = processWebhookEvent({
        id: 'WH-PROC1-EVENT-001',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: 'RES-REFUND-PROC1', amount: { value: '50.00', currency_code: 'USD' } },
      });
      if (dupWebhook.status !== 'DUPLICATE_IGNORED') {
        console.error('FAIL: Webhook duplicate was not ignored after restart!');
        process.exit(6);
      }

      // 6. Verify terminal out-of-order state protection across processes
      // Delayed capture completed webhook arrives after restart
      const delayedCapture = processWebhookEvent({
        id: 'WH-PROC2-DELAYED-CAP-001',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'RES-REFUND-PROC1', amount: { value: '50.00', currency_code: 'USD' } },
      });
      const resState = store.getResourceState('RES-REFUND-PROC1');
      if (!resState || resState.latestStatus !== 'REFUNDED') {
        console.error('FAIL: Terminal REFUNDED status was downgraded by delayed capture after restart! Got: ' + (resState && resState.latestStatus));
        process.exit(7);
      }

      console.log('ALL_PROCESS2_CHECKS_PASSED');
      process.exit(0);
    `;

    const out = execSync(`node -e "${proc2Script.replace(/"/g, '\\"')}"`, {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PAYPAL_STORE_PATH: tempStoreFile, NODE_ENV: 'production' },
      stdio: 'pipe',
    }).toString();

    expect(out).toContain('ALL_PROCESS2_CHECKS_PASSED');
  });

  test('Auto-expires stale IN_FLIGHT key after timeout period in the same process', () => {
    const store = require('../src/store/dataStore');
    store.initEmpty('LIVE', { loadDisk: false });

    // Register an in-flight key with a simulated old timestamp (> 60s ago)
    const oldKey = 'idemp_old_stale_key_001';
    store.registerIdempotencyKey(oldKey, { test: true });

    // Artificially age the record past the 60s timeout
    const rec = store.getStore().paypalIdempotency.get(oldKey);
    rec.created_at = Date.now() - 65000; // 65 seconds ago

    // Querying through getIdempotencyRecord should auto-transition it to TIMED_OUT
    const queried = store.getIdempotencyRecord(oldKey);
    expect(queried.status).toBe('TIMED_OUT');
    expect(queried.expired).toBe(true);

    // Re-registering the same key should now succeed and overwrite the stale lock
    const refreshed = store.registerIdempotencyKey(oldKey, { test: 'retry' });
    expect(refreshed.status).toBe('IN_FLIGHT');
  });
});
