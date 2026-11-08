'use strict';
/**
 * tests/paypal.test.js
 *
 * Focused tests for PayPal Sandbox Integration:
 * - Server-controlled pricing & catalog anti-tampering
 * - Orders v2 creation with idempotency & approval link
 * - Capture execution & verification (amount, currency, reference)
 * - Anti-tamper rejection (tampered amount / currency / reference)
 * - Architectural distinction: Gateway Capture vs Bank Settlement
 * - Webhook signature verification, deduplication & out-of-order handling
 * - Refund / reversal preservation with review flags
 * - HTTP API endpoints via supertest
 */

const request = require('supertest');
const app = require('../server');
const store = require('../src/store/dataStore');
const { PayPalClient } = require('../src/paypal/client');
const {
  SERVER_CATALOG,
  resolveServerPrice,
  createOrder,
  captureOrder,
} = require('../src/paypal/orders');
const {
  verifyWebhookSignature,
  processWebhookEvent,
  resetWebhookState,
} = require('../src/paypal/webhook');

describe('PayPal Sandbox Integration Suite', () => {
  beforeEach(() => {
    store.initEmpty('LIVE');
    resetWebhookState();
  });

  describe('1. Server-Controlled Pricing & Anti-Tampering', () => {
    test('resolves standard fixed catalog products correctly', () => {
      const starter = resolveServerPrice({ productId: 'TIER_STARTER' });
      expect(starter.amountMinor).toBe(1000); // $10.00
      expect(starter.currency).toBe('USD');

      const pro = resolveServerPrice({ productId: 'TIER_PROFESSIONAL' });
      expect(pro.amountMinor).toBe(2500); // $25.00

      const ent = resolveServerPrice({ productId: 'TIER_ENTERPRISE' });
      expect(ent.amountMinor).toBe(10000); // $100.00
    });

    test('rejects unknown product IDs', () => {
      expect(() => resolveServerPrice({ productId: 'NON_EXISTENT_PROD' })).toThrow(/Unknown product ID/);
    });

    test('validates custom amount bounds strictly', () => {
      // Valid custom amount ($15.00 = 1500 minor units)
      const validCustom = resolveServerPrice({ productId: 'CUSTOM_DEMO', amountMinor: 1500 });
      expect(validCustom.amountMinor).toBe(1500);

      // Below minimum ($0.50 = 50 minor units < 100)
      expect(() => resolveServerPrice({ productId: 'CUSTOM_DEMO', amountMinor: 50 })).toThrow(
        /Amount must be between 100 minor units/
      );

      // Above maximum ($6,000.00 = 600000 minor units > 500000)
      expect(() => resolveServerPrice({ productId: 'CUSTOM_DEMO', amountMinor: 600000 })).toThrow(
        /Amount must be between 100 minor units/
      );
    });
  });

  describe('2. Orders v2 Creation, Idempotency & Approval Link', () => {
    test('creates an order with stable idempotency key and extracts approval link', async () => {
      // Mock client that returns a valid PayPal Orders v2 response
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          status: 201,
          headers: {},
          data: {
            id: 'ORDER-TEST-12345',
            status: 'CREATED',
            links: [
              { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-TEST-12345' },
              { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TEST-12345' },
            ],
          },
        }),
      };

      const result = await createOrder({
        client: mockClient,
        productId: 'TIER_STARTER',
        referenceId: 'ref_user_order_001',
        idempotencyKey: 'idemp_key_stable_001',
      });

      expect(result.order_id).toBe('ORDER-TEST-12345');
      expect(result.status).toBe('CREATED');
      expect(result.amount_minor).toBe(1000);
      expect(result.amount_decimal).toBe('10.00');
      expect(result.currency).toBe('USD');
      expect(result.approve_url).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TEST-12345');
      expect(result.idempotency_key).toBe('idemp_key_stable_001');

      // Verify request arguments passed to PayPal
      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/v2/checkout/orders',
          method: 'POST',
          idempotencyKey: 'idemp_key_stable_001',
          data: expect.objectContaining({
            intent: 'CAPTURE',
            purchase_units: expect.arrayContaining([
              expect.objectContaining({
                reference_id: 'ref_user_order_001',
                amount: { currency_code: 'USD', value: '10.00', breakdown: { item_total: { currency_code: 'USD', value: '10.00' } } },
              }),
            ]),
          }),
        })
      );
    });
  });

  describe('3. Order Capture Execution & Strict Financial Verification', () => {
    test('captures order successfully and verifies exact amount & currency', async () => {
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          status: 201,
          headers: {},
          data: {
            id: 'ORDER-TEST-12345',
            status: 'COMPLETED',
            purchase_units: [
              {
                reference_id: 'ref_user_order_001',
                payments: {
                  captures: [
                    {
                      id: 'CAP-TEST-99999',
                      status: 'COMPLETED',
                      amount: { currency_code: 'USD', value: '10.00' },
                      seller_protection: { status: 'ELIGIBLE' },
                      create_time: '2026-10-29T00:00:00Z',
                    },
                  ],
                },
              },
            ],
          },
        }),
      };

      const captureResult = await captureOrder({
        client: mockClient,
        orderId: 'ORDER-TEST-12345',
        expectedOrder: {
          amountMinor: 1000,
          currency: 'USD',
          referenceId: 'ref_user_order_001',
        },
      });

      expect(captureResult.success).toBe(true);
      expect(captureResult.capture_id).toBe('CAP-TEST-99999');
      expect(captureResult.capture_status).toBe('COMPLETED');
      expect(captureResult.amount_minor).toBe(1000);
      expect(captureResult.currency).toBe('USD');
      expect(captureResult.seller_protection_status).toBe('ELIGIBLE');

      // Architectural distinction check: Gateway capture ONLY, never bank settlement
      expect(captureResult.is_gateway_capture).toBe(true);
      expect(captureResult.is_bank_settlement).toBe(false);
    });

    test('rejects capture if captured amount differs from registered order (tampered amount)', async () => {
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          status: 201,
          data: {
            id: 'ORDER-TAMPER-001',
            purchase_units: [
              {
                reference_id: 'ref_expected_001',
                payments: {
                  captures: [
                    {
                      id: 'CAP-TAMPER-001',
                      status: 'COMPLETED',
                      amount: { currency_code: 'USD', value: '5.00' }, // Expected 10.00!
                    },
                  ],
                },
              },
            ],
          },
        }),
      };

      await expect(
        captureOrder({
          client: mockClient,
          orderId: 'ORDER-TAMPER-001',
          expectedOrder: {
            amountMinor: 1000, // Expected 1000 cents ($10.00)
            currency: 'USD',
            referenceId: 'ref_expected_001',
          },
        })
      ).rejects.toThrow(/Exact amount mismatch/);
    });

    test('rejects capture if captured currency differs from registered order (tampered currency)', async () => {
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          status: 201,
          data: {
            id: 'ORDER-TAMPER-002',
            purchase_units: [
              {
                reference_id: 'ref_expected_002',
                payments: {
                  captures: [
                    {
                      id: 'CAP-TAMPER-002',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '10.00' }, // Expected USD!
                    },
                  ],
                },
              },
            ],
          },
        }),
      };

      await expect(
        captureOrder({
          client: mockClient,
          orderId: 'ORDER-TAMPER-002',
          expectedOrder: {
            amountMinor: 1000,
            currency: 'USD',
            referenceId: 'ref_expected_002',
          },
        })
      ).rejects.toThrow(/Currency mismatch/);
    });

    test('rejects capture if reference ID differs (ownership / order reference tampering)', async () => {
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          status: 201,
          data: {
            id: 'ORDER-TAMPER-003',
            purchase_units: [
              {
                reference_id: 'DIFFERENT_MERCHANT_REF',
                payments: {
                  captures: [{ id: 'CAP-003', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } }],
                },
              },
            ],
          },
        }),
      };

      await expect(
        captureOrder({
          client: mockClient,
          orderId: 'ORDER-TAMPER-003',
          expectedOrder: {
            amountMinor: 1000,
            currency: 'USD',
            referenceId: 'EXPECTED_MERCHANT_REF',
          },
        })
      ).rejects.toThrow(/Tampered order reference/);
    });
  });

  describe('4. Webhook Signature Verification, Deduplication & Safe Handling', () => {
    test('rejects webhooks with missing signature headers', async () => {
      const res = await verifyWebhookSignature({
        headers: {},
        body: { id: 'WH-001' },
      });
      expect(res.verified).toBe(false);
      expect(res.reason).toBe('MISSING_PAYPAL_SIGNATURE_HEADERS');
    });

    test('rejects cert_url pointing outside paypal.com domain (security check)', async () => {
      const res = await verifyWebhookSignature({
        headers: {
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': 'https://evil-attacker.com/cert.pem',
          'paypal-transmission-id': 'trans-123',
          'paypal-transmission-sig': 'sig-123',
          'paypal-transmission-time': '2026-10-29T00:00:00Z',
        },
        body: { id: 'WH-002' },
      });
      expect(res.verified).toBe(false);
      expect(res.reason).toBe('INVALID_CERT_URL_HOST');
    });

    test('fails closed when PAYPAL_WEBHOOK_ID is unset, even with forged x-paypal-test-signature header', async () => {
      const { defaultPayPalClient } = require('../src/paypal/client');
      const origWebhookId = defaultPayPalClient.webhookId;
      defaultPayPalClient.webhookId = null;

      const res = await verifyWebhookSignature({
        headers: {
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
          'paypal-transmission-id': 'trans-123',
          'paypal-transmission-sig': 'sig-123',
          'paypal-transmission-time': '2026-10-29T00:00:00Z',
          'x-paypal-test-signature': 'valid',
        },
        body: { id: 'WH-FORGED-001' },
      });

      expect(res.verified).toBe(false);
      expect(res.reason).toBe('PAYPAL_WEBHOOK_ID_NOT_CONFIGURED');
      expect(res.test_bypass).toBeUndefined();

      defaultPayPalClient.webhookId = origWebhookId;
    });

    test('deduplicates duplicate webhook event IDs safely', () => {
      const event = {
        id: 'WH-EVENT-DEDUP-001',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-001',
          amount: { currency_code: 'USD', value: '25.00' },
        },
      };

      // First delivery: processes normally
      const res1 = processWebhookEvent(event);
      expect(res1.status).toBe('PROCESSED');
      expect(res1.action_taken).toBe('CAPTURE_RECORDED');

      // Duplicate delivery (retry): safely ignored without reprocessing
      const res2 = processWebhookEvent(event);
      expect(res2.status).toBe('DUPLICATE_IGNORED');
      expect(res2.event_id).toBe('WH-EVENT-DEDUP-001');
    });

    test('flags refund and reversal events with REVIEW_REQUIRED and sets exception flag', () => {
      const refundEvent = {
        id: 'WH-EVENT-REFUND-001',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'CAP-REFUNDED-001',
          amount: { currency_code: 'USD', value: '10.00' },
        },
      };

      const result = processWebhookEvent(refundEvent);
      expect(result.status).toBe('PROCESSED');
      expect(result.review_required).toBe(true);
      expect(result.exception_type).toBe('PARTIAL_REFUND');
      expect(result.is_bank_settlement).toBe(false);
    });

    test('handles out-of-order webhook sequence gracefully', () => {
      const captureCompleted = {
        id: 'WH-OUT-OF-ORDER-001',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'ORD-OOO-1', amount: { currency_code: 'USD', value: '10.00' } },
      };
      const orderApproved = {
        id: 'WH-OUT-OF-ORDER-002',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: 'ORD-OOO-1', amount: { currency_code: 'USD', value: '10.00' } },
      };

      // Capture event arrives FIRST
      const resCap = processWebhookEvent(captureCompleted);
      expect(resCap.status).toBe('PROCESSED');

      // Order approved event arrives LATER (out-of-order)
      const resApp = processWebhookEvent(orderApproved);
      expect(resApp.status).toBe('PROCESSED');
    });
  });

  describe('5. HTTP API Endpoints & Data Persistence', () => {
    test('GET /api/paypal/status returns safe diagnostic status', async () => {
      const res = await request(app).get('/api/paypal/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('configured');
      expect(res.body).toHaveProperty('environment');
      expect(res.body).toHaveProperty('products_available');
    });

    test('GET /api/paypal/products returns server-controlled catalog', async () => {
      const res = await request(app).get('/api/paypal/products');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.products)).toBe(true);
      const starter = res.body.products.find(p => p.id === 'TIER_STARTER');
      expect(starter).toBeDefined();
      expect(starter.amount_minor).toBe(1000);
      expect(starter.currency).toBe('USD');
    });

    test('DataStore persists PayPal orders and captures across calls', () => {
      const order = {
        order_id: 'STORE-ORD-001',
        amount_minor: 2500,
        amount_decimal: '25.00',
        currency: 'USD',
        status: 'CREATED',
      };
      store.addPayPalOrder(order);

      const retrievedOrder = store.getPayPalOrder('STORE-ORD-001');
      expect(retrievedOrder).toBeDefined();
      expect(retrievedOrder.amount_minor).toBe(2500);

      const capture = {
        order_id: 'STORE-ORD-001',
        capture_id: 'STORE-CAP-001',
        capture_status: 'COMPLETED',
        amount_minor: 2500,
        currency: 'USD',
        idempotency_key: 'idemp_cap_store_001',
      };
      store.addPayPalCapture(capture);

      const captures = store.getPayPalCaptures();
      expect(captures.length).toBe(1);
      expect(captures[0].capture_id).toBe('STORE-CAP-001');
      expect(captures[0].is_gateway_capture).toBe(true);
      expect(captures[0].is_bank_settlement).toBe(false);

      // Order status should be transitioned to COMPLETED
      const updatedOrder = store.getPayPalOrder('STORE-ORD-001');
      expect(updatedOrder.status).toBe('COMPLETED');
    });

    test('rejects capture of un-owned or unknown order with 404 (ownership verification)', async () => {
      // Mock PayPal configured
      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);

      const res = await request(app)
        .post('/api/paypal/capture-order')
        .send({ order_id: 'UNOWNED-ORDER-999' });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/was not created by this merchant/i);

      jest.restoreAllMocks();
    });

    test('rejects concurrent request with 409 Conflict when idempotency key is already in flight', async () => {
      const inFlightKey = 'idemp_inflight_test_key_001';
      store.registerIdempotencyKey(inFlightKey, { type: 'CREATE_ORDER' });

      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);

      const res = await request(app)
        .post('/api/paypal/create-order')
        .send({ idempotency_key: inFlightKey });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already in flight/i);

      jest.restoreAllMocks();
    });

    test('survives process restart and restores orders, captures and idempotency from disk', () => {
      store._clearPayPalDiskState();

      // Seed an order and capture in current process
      const order = {
        order_id: 'RESTART-ORD-777',
        amount_minor: 5000,
        amount_decimal: '50.00',
        currency: 'USD',
        status: 'CREATED',
      };
      store.addPayPalOrder(order);

      const capture = {
        order_id: 'RESTART-ORD-777',
        capture_id: 'RESTART-CAP-777',
        capture_status: 'COMPLETED',
        amount_minor: 5000,
        currency: 'USD',
        idempotency_key: 'idemp_restart_777',
      };
      store.addPayPalCapture(capture);
      store.registerIdempotencyKey('idemp_restart_777', { note: 'test' });
      store.completeIdempotencyKey('idemp_restart_777', { success: true });

      // SIMULATE PROCESS RESTART:
      // Clear memory cache and re-initialize with disk loading enabled
      store.initEmpty('LIVE', { loadDisk: true });

      // Verify that after restart, orders and captures were preserved and restored
      const restoredOrder = store.getPayPalOrder('RESTART-ORD-777');
      expect(restoredOrder).toBeDefined();
      expect(restoredOrder.order_id).toBe('RESTART-ORD-777');
      expect(restoredOrder.status).toBe('COMPLETED');

      const restoredCaptures = store.getPayPalCaptures();
      const matchedCap = restoredCaptures.find(c => c.capture_id === 'RESTART-CAP-777');
      expect(matchedCap).toBeDefined();
      expect(matchedCap.amount_minor).toBe(5000);

      const restoredIdem = store.getIdempotencyRecord('idemp_restart_777');
      expect(restoredIdem).toBeDefined();
      expect(restoredIdem.status).toBe('COMPLETED');

      // Cleanup
      store._clearPayPalDiskState();
    });

    test('preserves terminal REFUNDED status when a delayed capture webhook arrives (out-of-order)', () => {
      const refundEvent = {
        id: 'WH-OOO-REFUND-001',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: 'RES-ORDER-TERMINAL-01', amount: { currency_code: 'USD', value: '10.00' } },
      };
      const lateCapture = {
        id: 'WH-OOO-LATE-CAP-001',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'RES-ORDER-TERMINAL-01', amount: { currency_code: 'USD', value: '10.00' } },
      };

      // Refund arrives first
      processWebhookEvent(refundEvent);
      const { _resourceStates } = require('../src/paypal/webhook');
      expect(_resourceStates.get('RES-ORDER-TERMINAL-01').latestStatus).toBe('REFUNDED');

      // Delayed capture arrives later: must NOT overwrite REFUNDED to CAPTURED
      processWebhookEvent(lateCapture);
      expect(_resourceStates.get('RES-ORDER-TERMINAL-01').latestStatus).toBe('REFUNDED');
    });
  });

  describe('7. Route-Level Idempotency Retry Recovery & Payload Anti-Tampering', () => {
    test('POST /api/paypal/create-order: rejects request with 422 if idempotency key payload is tampered', async () => {
      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);

      const tamperKey = 'idemp_key_tamper_create_001';
      // Register with TIER_STARTER ($10.00)
      store.registerIdempotencyKey(tamperKey, {
        type: 'CREATE_ORDER',
        productId: 'TIER_STARTER',
        currency: 'USD',
        amountMinor: 1000,
      });

      // Attempt to reuse the same key for TIER_ENTERPRISE ($100.00)
      const res = await request(app)
        .post('/api/paypal/create-order')
        .send({
          idempotency_key: tamperKey,
          product_id: 'TIER_ENTERPRISE',
          currency: 'USD',
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/Idempotency key payload conflict/i);
      expect(res.body.idempotency_key).toBe(tamperKey);
      expect(res.body.registered_metadata.productId).toBe('TIER_STARTER');

      jest.restoreAllMocks();
    });

    test('POST /api/paypal/create-order: on retry after timeout or restart, reuses EXACT SAME persisted PayPal-Request-Id', async () => {
      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);

      const retryKey = 'idemp_key_create_retry_888';
      store.registerIdempotencyKey(retryKey, {
        type: 'CREATE_ORDER',
        productId: 'TIER_STARTER',
        currency: 'USD',
        amountMinor: 1000,
        referenceId: 'ref_persisted_retry_001',
      });
      // Mark as TIMED_OUT (simulating client retry after timeout)
      const record = store.getIdempotencyRecord(retryKey);
      record.status = 'TIMED_OUT';

      const requestSpy = jest.spyOn(defaultPayPalClient, 'request').mockResolvedValue({
        status: 201,
        headers: {},
        data: {
          id: 'ORD-RETRY-SUCCESS-888',
          status: 'CREATED',
          links: [
            { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD-RETRY-SUCCESS-888' },
          ],
        },
      });

      const res = await request(app)
        .post('/api/paypal/create-order')
        .send({
          idempotency_key: retryKey,
          product_id: 'TIER_STARTER',
          currency: 'USD',
        });

      expect(res.status).toBe(200);
      expect(res.body.order_id).toBe('ORD-RETRY-SUCCESS-888');
      expect(res.body.idempotency_key).toBe(retryKey);

      // Verify that request was invoked with the EXACT SAME idempotencyKey (used for PayPal-Request-Id header)
      expect(requestSpy).toHaveBeenCalledTimes(1);
      const callArgs = requestSpy.mock.calls[0][0];
      expect(callArgs.endpoint).toBe('/v2/checkout/orders');
      expect(callArgs.idempotencyKey).toBe(retryKey); // strict same-key reuse, never new random string
      expect(callArgs.data.purchase_units[0].reference_id).toBe('ref_persisted_retry_001');

      jest.restoreAllMocks();
    });

    test('POST /api/paypal/capture-order: rejects request with 422 if capture idempotency key is reused for different order_id', async () => {
      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);

      // Seed two orders
      store.addPayPalOrder({
        order_id: 'ORD-CAP-OWNED-001',
        amount_minor: 1000,
        currency: 'USD',
        status: 'CREATED',
      });
      store.addPayPalOrder({
        order_id: 'ORD-CAP-OWNED-002',
        amount_minor: 1000,
        currency: 'USD',
        status: 'CREATED',
      });

      const captureKey = 'idemp_key_capture_tamper_001';
      store.registerIdempotencyKey(captureKey, {
        type: 'CAPTURE_ORDER',
        order_id: 'ORD-CAP-OWNED-001',
      });

      // Attempt to reuse key for a different order ID
      const res = await request(app)
        .post('/api/paypal/capture-order')
        .send({
          order_id: 'ORD-CAP-OWNED-002',
          idempotency_key: captureKey,
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/Idempotency key payload conflict/i);
      expect(res.body.idempotency_key).toBe(captureKey);
      expect(res.body.registered_metadata.order_id).toBe('ORD-CAP-OWNED-001');

      jest.restoreAllMocks();
    });

    test('POST /api/paypal/capture-order: on retry after restart (INTERRUPTED_RETRYABLE), reuses EXACT SAME persisted capture PayPal-Request-Id', async () => {
      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);

      const orderId = 'ORD-CAP-RETRY-999';
      store.addPayPalOrder({
        order_id: orderId,
        amount_minor: 2500,
        amount_decimal: '25.00',
        currency: 'USD',
        reference_id: 'ref_cap_retry_999',
        status: 'CREATED',
      });

      const captureRetryKey = 'idemp_key_cap_retry_999';
      store.registerIdempotencyKey(captureRetryKey, {
        type: 'CAPTURE_ORDER',
        order_id: orderId,
      });

      // Mark as INTERRUPTED_RETRYABLE (as set by dataStore upon detecting in-flight key during restart)
      const record = store.getIdempotencyRecord(captureRetryKey);
      record.status = 'INTERRUPTED_RETRYABLE';

      const requestSpy = jest.spyOn(defaultPayPalClient, 'request').mockResolvedValue({
        status: 201,
        headers: {},
        data: {
          id: orderId,
          status: 'COMPLETED',
          purchase_units: [
            {
              reference_id: 'ref_cap_retry_999',
              payments: {
                captures: [
                  {
                    id: 'CAP-RESTORED-999',
                    status: 'COMPLETED',
                    amount: {
                      currency_code: 'USD',
                      value: '25.00',
                    },
                    create_time: '2026-10-29T10:00:00Z',
                  },
                ],
              },
            },
          ],
        },
      });

      const res = await request(app)
        .post('/api/paypal/capture-order')
        .send({
          order_id: orderId,
          idempotency_key: captureRetryKey,
        });

      expect(res.status).toBe(200);
      expect(res.body.capture_id).toBe('CAP-RESTORED-999');
      expect(res.body.is_gateway_capture).toBe(true);
      expect(res.body.is_bank_settlement).toBe(false);

      // Verify that request was called with the EXACT SAME capture idempotency key
      expect(requestSpy).toHaveBeenCalledTimes(1);
      const callArgs = requestSpy.mock.calls[0][0];
      expect(callArgs.endpoint).toBe(`/v2/checkout/orders/${orderId}/capture`);
      expect(callArgs.idempotencyKey).toBe(captureRetryKey);

      jest.restoreAllMocks();
    });

    test('POST /api/paypal/create-order: fails closed before outbound network when durable persistence fails (failure injection)', async () => {
      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);

      const networkSpy = jest.spyOn(defaultPayPalClient, 'request').mockResolvedValue({
        status: 201,
        data: { id: 'ORD-SHOULD-NEVER-BE-CALLED' },
      });

      // Inject disk write failure during pre-network registration
      const failKey = 'idemp_key_disk_fail_001';
      const saveSpy = jest.spyOn(store, '_savePayPalDiskState').mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device, write error');
      });

      const res = await request(app)
        .post('/api/paypal/create-order')
        .send({
          idempotency_key: failKey,
          product_id: 'TIER_STARTER',
          currency: 'USD',
        });

      // Assert fail-closed response
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Durable persistence failed/i);

      // Verify ZERO network calls were made to PayPal
      expect(networkSpy).toHaveBeenCalledTimes(0);

      // Verify safe state rollback: in-memory map has no dangling corrupted entry
      const rolledBack = store.getIdempotencyRecord(failKey);
      expect(rolledBack).toBeNull();

      saveSpy.mockRestore();
      jest.restoreAllMocks();
    });

    test('POST /api/paypal/create-order: rejects changed reference_id on same idempotency key with 422 Unprocessable Entity', async () => {
      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);

      const key = 'idemp_key_ref_tamper_999';
      store.registerIdempotencyKey(key, {
        type: 'CREATE_ORDER',
        productId: 'TIER_STARTER',
        amountMinor: 1000,
        currency: 'USD',
        referenceId: 'ref_original_alpha_1',
      });

      // Attempt to reuse key with changed reference_id
      const res = await request(app)
        .post('/api/paypal/create-order')
        .send({
          idempotency_key: key,
          product_id: 'TIER_STARTER',
          currency: 'USD',
          reference_id: 'ref_tampered_beta_2',
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/Idempotency key payload conflict/i);
      expect(res.body.mismatches).toBeDefined();
      expect(res.body.mismatches.reference_id).toEqual({
        expected: 'ref_original_alpha_1',
        received: 'ref_tampered_beta_2',
      });

      jest.restoreAllMocks();
    });

    test('POST /api/paypal/create-order: persists complete resolved catalog amount & reference across restart with no missing metadata', async () => {
      store._clearPayPalDiskState();

      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);
      jest.spyOn(defaultPayPalClient, 'request').mockResolvedValue({
        status: 201,
        headers: {},
        data: {
          id: 'ORD-CATALOG-RESTART-001',
          status: 'CREATED',
          links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/approve' }],
        },
      });

      const key = 'idemp_key_complete_resolved_001';

      // Send request for fixed catalog product without passing amount_minor
      const res1 = await request(app)
        .post('/api/paypal/create-order')
        .send({
          idempotency_key: key,
          product_id: 'TIER_PROFESSIONAL', // $25.00 -> 2500 minor units
          currency: 'USD',
          reference_id: 'ref_complete_canon_001',
        });

      expect(res1.status).toBe(200);

      // Verify BEFORE restart: complete resolved payload was stored (amountMinor is 2500, not undefined/null)
      const beforeRecord = store.getIdempotencyRecord(key);
      expect(beforeRecord).toBeDefined();
      expect(beforeRecord.metadata.productId).toBe('TIER_PROFESSIONAL');
      expect(beforeRecord.metadata.amountMinor).toBe(2500); // Complete catalog minor units
      expect(beforeRecord.metadata.referenceId).toBe('ref_complete_canon_001');

      // SIMULATE PROCESS RESTART:
      store.initEmpty('LIVE', { loadDisk: true });

      // Verify AFTER restart: complete metadata is fully preserved
      const restoredRecord = store.getIdempotencyRecord(key);
      expect(restoredRecord).toBeDefined();
      expect(restoredRecord.metadata.productId).toBe('TIER_PROFESSIONAL');
      expect(restoredRecord.metadata.amountMinor).toBe(2500);
      expect(restoredRecord.metadata.referenceId).toBe('ref_complete_canon_001');

      // Retry after restart with same key replays idempotently
      const res2 = await request(app)
        .post('/api/paypal/create-order')
        .send({
          idempotency_key: key,
          product_id: 'TIER_PROFESSIONAL',
          currency: 'USD',
          reference_id: 'ref_complete_canon_001',
        });

      expect(res2.status).toBe(200);
      expect(res2.body.idempotent_replay).toBe(true);

      store._clearPayPalDiskState();
      jest.restoreAllMocks();
    });
  });

  describe('9. Webhook Raw-Body Handling, Dispute Lifecycle & Reconciliation', () => {
    test('verifyWebhookSignature handles raw Buffer body and parsed object body identically', async () => {
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          data: { verification_status: 'SUCCESS' },
        }),
      };

      const webhookEvent = {
        id: 'WH-TEST-BUFFER-001',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'CAP-BUFFER-001', amount: { value: '10.00', currency_code: 'USD' } },
      };

      const rawBuffer = Buffer.from(JSON.stringify(webhookEvent), 'utf8');
      const headers = {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
        'paypal-transmission-id': 'trans-buf-123',
        'paypal-transmission-sig': 'sig-buf-123',
        'paypal-transmission-time': '2026-11-05T12:00:00Z',
      };

      const resBuffer = await verifyWebhookSignature({
        client: mockClient,
        webhookId: 'WH_CONFIG_ID_001',
        rawBody: rawBuffer,
        headers,
      });

      expect(resBuffer.verified).toBe(true);
      expect(mockClient.request).toHaveBeenCalledTimes(1);

      // Verify second call with JSON string body
      const resString = await verifyWebhookSignature({
        client: mockClient,
        webhookId: 'WH_CONFIG_ID_001',
        rawBody: JSON.stringify(webhookEvent),
        headers,
      });

      expect(resString.verified).toBe(true);
    });

    test('processWebhookEvent handles CUSTOMER.DISPUTE.CREATED and records audit exception', async () => {
      const disputeEvent = {
        id: 'WH-DISP-CREATE-001',
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        resource_type: 'dispute',
        resource: {
          dispute_id: 'PP-D-88291',
          dispute_amount: { value: '25.00', currency_code: 'USD' },
          reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          status: 'UNDER_REVIEW',
          disputed_transactions: [{ seller_transaction_id: 'CAP-DISPUTED-001' }],
        },
      };

      const result = await processWebhookEvent(disputeEvent);
      expect(result.processed).toBe(true);
      expect(result.event_type).toBe('CUSTOMER.DISPUTE.CREATED');
      expect(result.dispute_id).toBe('PP-D-88291');

      // Verify dispute exception registered in store
      const storeState = store.getStore();
      const dispExc = storeState.exceptions.find(e => e.order_id === 'PP-D-88291');
      expect(dispExc).toBeDefined();
      expect(dispExc.category).toBe('DISPUTE_REVERSAL');
      expect(dispExc.amount_at_risk).toBe(2500); // $25.00 in minor units
      expect(dispExc.priority).toBe('HIGH');

      // Verify audit trail recorded dispute
      const auditEntry = storeState.auditTrail.find(a => a.entity_id === 'PP-D-88291');
      expect(auditEntry).toBeDefined();
      expect(auditEntry.action).toBe('DISPUTE_OPENED_REVIEW_REQUIRED');
    });

    test('reconcilePayPalCapture: cleanly matches capture against registered order', () => {
      // Register an order in store
      store.registerPayPalOrder({
        order_id: 'ORD-RECON-MATCH-001',
        amount_minor: 1000,
        currency: 'USD',
        status: 'APPROVED',
      });

      const capture = {
        capture_id: 'CAP-RECON-MATCH-001',
        order_id: 'ORD-RECON-MATCH-001',
        amount_minor: 1000,
        currency: 'USD',
        status: 'COMPLETED',
      };

      const recon = store.reconcilePayPalCapture(capture);
      expect(recon).toBeDefined();
      expect(recon.status).toBe('MATCHED');
      expect(recon.amount_paise).toBe(1000);
      expect(recon.currency).toBe('USD');

      // Verify audit trail logged completion
      const storeState = store.getStore();
      const audit = storeState.auditTrail.find(a => a.entity_id === 'CAP-RECON-MATCH-001');
      expect(audit).toBeDefined();
      expect(audit.event_type).toBe('PAYPAL_RECONCILIATION_COMPLETED');
      expect(audit.details.status).toBe('MATCHED');
    });

    test('reconcilePayPalCapture: flags amount variance and generates FEE_TAX_VARIANCE exception', () => {
      // Order registered for $10.00 (1000 minor units)
      store.registerPayPalOrder({
        order_id: 'ORD-RECON-DIFF-001',
        amount_minor: 1000,
        currency: 'USD',
        status: 'APPROVED',
      });

      // Gateway captured only $8.50 (850 minor units)
      const capture = {
        capture_id: 'CAP-RECON-DIFF-001',
        order_id: 'ORD-RECON-DIFF-001',
        amount_minor: 850,
        currency: 'USD',
        status: 'COMPLETED',
      };

      const recon = store.reconcilePayPalCapture(capture);
      expect(recon.status).toBe('EXCEPTION');
      expect(recon.exception_id).toBeDefined();

      const storeState = store.getStore();
      const exc = storeState.exceptions.find(e => e.id === recon.exception_id);
      expect(exc).toBeDefined();
      expect(exc.category).toBe('FEE_TAX_VARIANCE');
      expect(exc.amount_at_risk).toBe(150); // 1000 - 850
      expect(exc.status).toBe('OPEN');
    });

    test('POST /api/paypal/capture-order: triggers reconciliation on successful capture', async () => {
      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);

      // Register matching order
      store.registerPayPalOrder({
        order_id: 'ORD-LIVE-RECON-777',
        amount_minor: 2500,
        currency: 'USD',
        status: 'APPROVED',
        reference_id: 'ref_live_recon_777',
      });

      jest.spyOn(defaultPayPalClient, 'request').mockResolvedValue({
        status: 201,
        headers: {},
        data: {
          id: 'ORD-LIVE-RECON-777',
          status: 'COMPLETED',
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: 'CAP-AUTO-RECON-777',
                    status: 'COMPLETED',
                    amount: { value: '25.00', currency_code: 'USD' },
                    custom_id: 'ref_live_recon_777',
                  },
                ],
              },
            },
          ],
        },
      });

      const res = await request(app)
        .post('/api/paypal/capture-order')
        .send({
          order_id: 'ORD-LIVE-RECON-777',
          idempotency_key: 'idemp_cap_recon_777',
        });

      expect(res.status).toBe(200);
      expect(res.body.capture_id).toBe('CAP-AUTO-RECON-777');
      expect(res.body.capture_status).toBe('COMPLETED');

      // Verify reconciliation occurred automatically
      const storeState = store.getStore();
      const recon = storeState.reconciliationResults.find(r => r.settlement_entity_id === 'CAP-AUTO-RECON-777');
      expect(recon).toBeDefined();
      expect(recon.status).toBe('MATCHED');

      jest.restoreAllMocks();
    });

    test('POST /api/paypal/capture-order: fails closed with 500 when pre-network disk persistence throws', async () => {
      const { defaultPayPalClient } = require('../src/paypal/client');
      jest.spyOn(defaultPayPalClient, 'isConfigured').mockReturnValue(true);
      const networkSpy = jest.spyOn(defaultPayPalClient, 'request');

      // Pre-register order in store so ownership verification passes
      store.addPayPalOrder({
        order_id: 'ORD-FAIL-CLOSED-999',
        amount_minor: 1000,
        currency: 'USD',
        status: 'APPROVED',
      });

      // Force registerIdempotencyKey to fail (simulating disk full / permission failure)
      const regSpy = jest.spyOn(store, 'registerIdempotencyKey').mockImplementation(() => {
        throw new Error('EACCES: disk persistence failure on idempotency registration');
      });

      const res = await request(app)
        .post('/api/paypal/capture-order')
        .send({
          order_id: 'ORD-FAIL-CLOSED-999',
          idempotency_key: 'idemp_fail_closed_999',
        });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Durable persistence failed|Failed to persist/i);

      // Verify FAIL-CLOSED integrity: zero outbound PayPal network calls were made
      expect(networkSpy).not.toHaveBeenCalled();

      regSpy.mockRestore();
      jest.restoreAllMocks();
    });
  });
});
