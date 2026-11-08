'use strict';
/**
 * src/routes/paypal.js
 *
 * REST API Routes for PayPal Sandbox Integration:
 * - GET  /api/paypal/status         — Safe diagnostic status (masked client ID)
 * - GET  /api/paypal/products       — Server-controlled product catalog & pricing
 * - POST /api/paypal/create-order   — Create Orders v2 with approval link & idempotency
 * - POST /api/paypal/capture-order  — Capture order, verify amount & anti-tamper
 * - GET  /api/paypal/orders/:id     — Order & capture evidence
 * - GET  /api/paypal/transactions   — List captured PayPal Sandbox transactions
 * - POST /api/paypal/webhook        — Webhook receiver with signature verification & deduplication
 */

const express = require('express');
const router = express.Router();
const store = require('../store/dataStore');
const { defaultPayPalClient } = require('../paypal/client');
const { SERVER_CATALOG, resolveServerPrice, createOrder, captureOrder } = require('../paypal/orders');
const { verifyWebhookSignature, processWebhookEvent } = require('../paypal/webhook');
const { formatMoney, toDecimalString } = require('../payments/money');

// ── GET /api/paypal/status ────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  try {
    const status = defaultPayPalClient.getStatus();
    const captures = store.getPayPalCaptures();
    const orders = store.getPayPalOrders();

    return res.json({
      ...status,
      active_paypal_orders_count: orders.length,
      active_paypal_captures_count: captures.length,
      products_available: Object.keys(SERVER_CATALOG).length,
    });
  } catch (err) {
    console.error('[paypal/status] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve PayPal status.' });
  }
});

// ── GET /api/paypal/products ──────────────────────────────────────────────────
router.get('/products', (req, res) => {
  try {
    const products = Object.values(SERVER_CATALOG).map(p => ({
      id: p.id,
      name: p.name,
      amount_minor: p.amount_minor || null,
      amount_decimal: p.amount_minor ? toDecimalString(p.amount_minor, p.currency) : null,
      currency: p.currency,
      description: p.description,
      formatted: p.amount_minor ? formatMoney(p.amount_minor, p.currency) : null,
    }));
    return res.json({ products });
  } catch (err) {
    console.error('[paypal/products] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve product catalog.' });
  }
});

// ── POST /api/paypal/create-order ─────────────────────────────────────────────
router.post('/create-order', async (req, res) => {
  try {
    const {
      product_id = 'TIER_STARTER',
      amount_minor,
      currency = 'USD',
      reference_id,
      idempotency_key,
      return_url,
      cancel_url,
    } = req.body || {};

    const client = defaultPayPalClient;

    // Check if client is configured
    if (!client.isConfigured()) {
      return res.status(503).json({
        error: 'PayPal Sandbox is not configured. Please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.',
        configured: false,
      });
    }

    // Resolve and canonicalize catalog pricing & integer minor units BEFORE idempotency registration
    let resolvedPrice;
    try {
      resolvedPrice = resolveServerPrice({
        productId: product_id,
        amountMinor: typeof amount_minor === 'number' ? amount_minor : null,
        currency,
      });
    } catch (priceErr) {
      return res.status(400).json({ error: priceErr.message });
    }

    // Persist stable idempotency key before network call
    const effectiveIdempotencyKey = idempotency_key || `req_order_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    let effectiveReferenceId = reference_id;

    // Check pre-network idempotency registry
    const existingIdem = store.getIdempotencyRecord(effectiveIdempotencyKey);
    if (existingIdem) {
      // Validate complete canonicalized payload to prevent payload tampering/conflict with existing idempotency key
      const meta = existingIdem.metadata || {};
      const normCurrency = resolvedPrice.currency.toUpperCase();
      const metaCurrency = (meta.currency || 'USD').toUpperCase();

      const typeMismatch = meta.type && meta.type !== 'CREATE_ORDER';
      const productMismatch = meta.productId && meta.productId !== resolvedPrice.productId;
      const currencyMismatch = meta.currency && metaCurrency !== normCurrency;
      const amountMismatch = meta.amountMinor !== undefined && meta.amountMinor !== null && meta.amountMinor !== resolvedPrice.amountMinor;
      const referenceMismatch = meta.referenceId && reference_id && meta.referenceId !== reference_id;

      if (typeMismatch || productMismatch || currencyMismatch || amountMismatch || referenceMismatch) {
        return res.status(422).json({
          error: 'Idempotency key payload conflict: provided request parameters do not match original idempotency key registration.',
          idempotency_key: effectiveIdempotencyKey,
          registered_metadata: meta,
          mismatches: {
            ...(referenceMismatch && { reference_id: { expected: meta.referenceId, received: reference_id } }),
            ...(productMismatch && { product_id: { expected: meta.productId, received: resolvedPrice.productId } }),
            ...(currencyMismatch && { currency: { expected: meta.currency, received: resolvedPrice.currency } }),
            ...(amountMismatch && { amount_minor: { expected: meta.amountMinor, received: resolvedPrice.amountMinor } }),
          },
        });
      }

      if (existingIdem.status === 'COMPLETED' && existingIdem.response) {
        return res.status(200).json({
          ...existingIdem.response,
          idempotent_replay: true,
        });
      }
      if (existingIdem.status === 'IN_FLIGHT') {
        return res.status(409).json({
          error: 'A create-order request with this idempotency key is already in flight.',
          idempotency_key: effectiveIdempotencyKey,
        });
      }

      // On retry recovery (e.g. TIMED_OUT, INTERRUPTED_RETRYABLE, FAILED), preserve original operation identity
      if (meta.referenceId) {
        effectiveReferenceId = meta.referenceId;
      }
    }

    // Ensure reference ID is canonicalized before network call
    if (!effectiveReferenceId) {
      effectiveReferenceId = `pv_ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    }

    // Durable registration BEFORE outbound network call — fails closed on persistence error
    store.registerIdempotencyKey(effectiveIdempotencyKey, {
      type: 'CREATE_ORDER',
      productId: resolvedPrice.productId,
      amountMinor: resolvedPrice.amountMinor, // Complete canonicalized integer minor units (never undefined/null)
      currency: resolvedPrice.currency,
      referenceId: effectiveReferenceId,     // Complete canonicalized reference ID
      description: resolvedPrice.description,
    });

    try {
      const orderResult = await createOrder({
        client,
        productId: resolvedPrice.productId,
        amountMinor: resolvedPrice.amountMinor,
        currency: resolvedPrice.currency,
        referenceId: effectiveReferenceId,
        idempotencyKey: effectiveIdempotencyKey,
        returnUrl: return_url,
        cancelUrl: cancel_url,
      });

      // Store order in server dataStore with CREATED status
      store.addPayPalOrder(orderResult);

      const responsePayload = {
        success: true,
        order_id: orderResult.order_id,
        status: orderResult.status,
        amount_minor: orderResult.amount_minor,
        amount_decimal: orderResult.amount_decimal,
        currency: orderResult.currency,
        reference_id: orderResult.reference_id,
        approve_url: orderResult.approve_url,
        idempotency_key: orderResult.idempotency_key,
        message: 'PayPal Sandbox order created successfully.',
      };

      store.completeIdempotencyKey(effectiveIdempotencyKey, responsePayload);

      console.log(`[PayPal] Order created: ${orderResult.order_id} | ${orderResult.amount_decimal} ${orderResult.currency} | Approve: ${orderResult.approve_url ? 'YES' : 'NONE'}`);

      return res.status(200).json(responsePayload);
    } catch (createErr) {
      store.failIdempotencyKey(effectiveIdempotencyKey, createErr);
      throw createErr;
    }
  } catch (err) {
    console.error('[paypal/create-order] Error:', err);
    return res.status(500).json({
      error: err.message || 'Failed to create PayPal order.',
    });
  }
});

// ── POST /api/paypal/capture-order ────────────────────────────────────────────
router.post('/capture-order', async (req, res) => {
  try {
    const { order_id, idempotency_key } = req.body || {};

    if (!order_id || typeof order_id !== 'string') {
      return res.status(400).json({ error: 'order_id is required.' });
    }

    const client = defaultPayPalClient;
    if (!client.isConfigured()) {
      return res.status(503).json({
        error: 'PayPal Sandbox is not configured. Please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.',
      });
    }

    // Retrieve registered order for strict ownership & anti-tamper verification
    const existingOrder = store.getPayPalOrder(order_id);
    if (!existingOrder) {
      return res.status(404).json({
        error: `Order '${order_id}' was not created by this merchant or not found. Capture rejected for ownership verification.`,
        order_id,
      });
    }

    // If order was already captured, return idempotent response
    if (existingOrder.status === 'COMPLETED' && existingOrder.capture_id) {
      const existingCapture = store.getPayPalCaptures().find(c => c.capture_id === existingOrder.capture_id);
      if (existingCapture) {
        return res.status(200).json({
          success: true,
          idempotent_replay: true,
          ...existingCapture,
          message: 'Order already captured. Returning existing capture record.',
        });
      }
    }

    // Stable capture idempotency key
    const effectiveCaptureIdempotencyKey = idempotency_key || `req_cap_${order_id}_${Date.now().toString(36)}`;

    // Check pre-network idempotency registry
    const existingIdem = store.getIdempotencyRecord(effectiveCaptureIdempotencyKey);
    if (existingIdem) {
      // Validate original payload to prevent payload tampering/conflict
      const meta = existingIdem.metadata || {};
      const isPayloadMatch =
        (!meta.type || meta.type === 'CAPTURE_ORDER') &&
        (!meta.order_id || meta.order_id === order_id);

      if (!isPayloadMatch) {
        return res.status(422).json({
          error: 'Idempotency key payload conflict: capture request order_id does not match the original idempotency registration.',
          idempotency_key: effectiveCaptureIdempotencyKey,
          registered_metadata: meta,
        });
      }

      if (existingIdem.status === 'COMPLETED' && existingIdem.response) {
        return res.status(200).json({
          ...existingIdem.response,
          idempotent_replay: true,
        });
      }
      if (existingIdem.status === 'IN_FLIGHT') {
        return res.status(409).json({
          error: 'A capture request with this idempotency key is already in flight.',
          idempotency_key: effectiveCaptureIdempotencyKey,
        });
      }
    }

    // Durable registration BEFORE outbound network call — fails closed on persistence error
    try {
      store.registerIdempotencyKey(effectiveCaptureIdempotencyKey, {
        type: 'CAPTURE_ORDER',
        order_id,
      });
    } catch (persistErr) {
      return res.status(500).json({
        error: `Durable persistence failed: unable to register capture idempotency key '${effectiveCaptureIdempotencyKey}' before network call: ${persistErr.message}`,
        idempotency_key: effectiveCaptureIdempotencyKey,
      });
    }

    const expectedOrder = {
      amountMinor: existingOrder.amount_minor,
      currency: existingOrder.currency,
      referenceId: existingOrder.reference_id,
    };

    try {
      // Execute capture via PayPal Orders v2
      const captureResult = await captureOrder({
        client,
        orderId: order_id,
        idempotencyKey: effectiveCaptureIdempotencyKey,
        expectedOrder,
      });

      // Ingest into store as verified PayPal Sandbox gateway capture
      const savedRecord = store.addPayPalCapture(captureResult);
      if (typeof store.reconcilePayPalCapture === 'function') {
        store.reconcilePayPalCapture(captureResult);
      }

      const responsePayload = {
        success: true,
        capture_id: captureResult.capture_id,
        order_id: captureResult.order_id,
        capture_status: captureResult.capture_status,
        amount_minor: captureResult.amount_minor,
        amount_decimal: captureResult.amount_decimal,
        currency: captureResult.currency,
        reference_id: captureResult.reference_id,
        seller_protection_status: captureResult.seller_protection_status,
        gateway: 'PAYPAL_SANDBOX',
        is_gateway_capture: true,
        is_bank_settlement: false, // strictly maintain distinction
        create_time: captureResult.create_time,
        message: 'Payment captured successfully via PayPal Sandbox (Gateway Capture confirmed).',
        evidence: {
          order_id: captureResult.order_id,
          capture_id: captureResult.capture_id,
          status: captureResult.capture_status,
          amount: `${captureResult.amount_decimal} ${captureResult.currency}`,
          type: 'PAYPAL_GATEWAY_CAPTURE',
          is_bank_settlement: false,
        },
      };

      store.completeIdempotencyKey(effectiveCaptureIdempotencyKey, responsePayload);

      console.log(`[PayPal] Order captured: ${order_id} -> Capture: ${captureResult.capture_id} (${captureResult.amount_decimal} ${captureResult.currency})`);

      return res.status(200).json(responsePayload);
    } catch (captureErr) {
      store.failIdempotencyKey(effectiveCaptureIdempotencyKey, captureErr);
      throw captureErr;
    }
  } catch (err) {
    console.error('[paypal/capture-order] Error:', err);
    return res.status(500).json({
      error: err.message || 'Failed to capture PayPal order.',
    });
  }
});

// ── GET /api/paypal/orders/:id ────────────────────────────────────────────────
router.get('/orders/:id', (req, res) => {
  try {
    const { id } = req.params;
    const order = store.getPayPalOrder(id);
    if (!order) {
      return res.status(404).json({ error: `PayPal order '${id}' not found.` });
    }

    const capture = order.capture_id
      ? store.getPayPalCaptures().find(c => c.capture_id === order.capture_id)
      : null;

    return res.json({
      order,
      capture: capture || null,
      is_gateway_capture: true,
      is_bank_settlement: false,
    });
  } catch (err) {
    console.error('[paypal/orders/:id] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve order details.' });
  }
});

// ── GET /api/paypal/transactions ──────────────────────────────────────────────
router.get('/transactions', (req, res) => {
  try {
    const captures = store.getPayPalCaptures();
    return res.json({
      count: captures.length,
      gateway: 'PAYPAL_SANDBOX',
      transactions: captures,
    });
  } catch (err) {
    console.error('[paypal/transactions] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve PayPal transactions.' });
  }
});

// ── POST /api/paypal/webhook ──────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  try {
    const headers = req.headers;
    const body = req.body;

    // Verify webhook signature
    const verification = await verifyWebhookSignature({
      headers,
      body,
    });

    if (!verification.verified) {
      console.warn('[PayPal Webhook] Signature verification failed:', verification.reason);
      return res.status(400).json({
        error: 'Invalid PayPal webhook signature.',
        reason: verification.reason,
      });
    }

    // Process event safely with deduplication
    const processingResult = processWebhookEvent(body);

    console.log(`[PayPal Webhook] Event processed: ${body.id} | Type: ${body.event_type} | Action: ${processingResult.action_taken}`);

    return res.status(200).json({
      success: true,
      result: processingResult,
    });
  } catch (err) {
    console.error('[paypal/webhook] Error:', err);
    return res.status(500).json({
      error: `Webhook processing error: ${err.message}`,
    });
  }
});

module.exports = router;
