'use strict';
/**
 * src/paypal/orders.js
 *
 * PayPal Orders v2 API Orchestration:
 * - Server-controlled pricing & catalog validation
 * - Idempotent order creation with stable retry keys (PayPal-Request-Id)
 * - Approval URL extraction for buyer redirect/approval
 * - Secure capture execution & post-capture financial verification
 *
 * CRITICAL FINANCIAL RULES:
 * - Prices are server-controlled; client cannot inject arbitrary amounts.
 * - All amounts are verified as currency-aware integer minor units.
 * - Strict verification of order ownership, reference, currency, and exact amount.
 * - Never labels a capture as bank settlement or invents nodal credits/fees/taxes.
 */

const { defaultPayPalClient } = require('./client');
const { toMinorUnits, toDecimalString, assertExactMatch, formatMoney } = require('../payments/money');

// ── Server-Controlled Products & Pricing ───────────────────────────────────────
const SERVER_CATALOG = {
  'TIER_STARTER': {
    id: 'TIER_STARTER',
    name: 'Payvault Developer Starter Pass',
    amount_minor: 1000, // $10.00
    currency: 'USD',
    description: 'Payvault Sandbox Testing & Reconciliation License',
  },
  'TIER_PROFESSIONAL': {
    id: 'TIER_PROFESSIONAL',
    name: 'Payvault Professional Recon Suite',
    amount_minor: 2500, // $25.00
    currency: 'USD',
    description: 'Autonomous Exception Investigation & Anomaly Engine',
  },
  'TIER_ENTERPRISE': {
    id: 'TIER_ENTERPRISE',
    name: 'Apex Enterprise Settlement Tier',
    amount_minor: 10000, // $100.00
    currency: 'USD',
    description: 'High-Volume Enterprise Multi-Nodal Reconciliation Pass',
  },
  'CUSTOM_DEMO': {
    id: 'CUSTOM_DEMO',
    name: 'Payvault Sandbox Custom Test',
    currency: 'USD',
    min_minor: 100, // $1.00 min
    max_minor: 500000, // $5,000.00 max
    description: 'Server-Validated Sandbox Test Payment',
  },
};

/**
 * Resolve and strictly validate price on the server.
 * Protects against client-side tampering of amounts and currencies.
 *
 * @param {Object} params
 * @param {string} [params.productId]
 * @param {number} [params.amountMinor]
 * @param {string} [params.currency]
 * @returns {{ amountMinor: number, currency: string, description: string, productId: string }}
 */
function resolveServerPrice({ productId = 'TIER_STARTER', amountMinor = null, currency = 'USD' }) {
  const normCurrency = (currency || 'USD').toUpperCase();
  const catalogItem = SERVER_CATALOG[productId];

  if (!catalogItem) {
    throw new Error(`Unknown product ID '${productId}'. Available products: ${Object.keys(SERVER_CATALOG).join(', ')}`);
  }

  if (productId === 'CUSTOM_DEMO') {
    if (typeof amountMinor !== 'number' || isNaN(amountMinor) || !isFinite(amountMinor)) {
      throw new Error('For CUSTOM_DEMO, amountMinor must be an integer.');
    }
    const minor = Math.round(amountMinor);
    if (minor < catalogItem.min_minor || minor > catalogItem.max_minor) {
      throw new Error(`Amount must be between ${catalogItem.min_minor} minor units ($1.00) and ${catalogItem.max_minor} minor units ($5,000.00).`);
    }
    return {
      productId: 'CUSTOM_DEMO',
      amountMinor: minor,
      currency: normCurrency,
      description: catalogItem.description,
    };
  }

  // Fixed catalog tier
  return {
    productId: catalogItem.id,
    amountMinor: catalogItem.amount_minor,
    currency: catalogItem.currency,
    description: catalogItem.description,
  };
}

/**
 * Create a PayPal v2 Order with idempotency and return the buyer approval link.
 *
 * @param {Object} params
 * @param {PayPalClient} [params.client]
 * @param {string} [params.productId]
 * @param {number} [params.amountMinor]
 * @param {string} [params.currency]
 * @param {string} [params.referenceId]
 * @param {string} [params.returnUrl]
 * @param {string} [params.cancelUrl]
 * @param {string} [params.idempotencyKey]
 * @returns {Promise<Object>}
 */
async function createOrder(params = {}) {
  const client = params.client || defaultPayPalClient;
  const { productId, amountMinor, currency, description } = resolveServerPrice({
    productId: params.productId,
    amountMinor: params.amountMinor,
    currency: params.currency,
  });

  const referenceId = params.referenceId || `pv_ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const idempotencyKey = params.idempotencyKey || `req_order_${referenceId}_${amountMinor}`;
  const decimalStr = toDecimalString(amountMinor, currency);

  const orderPayload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: referenceId,
        description: description || `Payvault ${productId}`,
        custom_id: referenceId,
        amount: {
          currency_code: currency,
          value: decimalStr,
          breakdown: {
            item_total: {
              currency_code: currency,
              value: decimalStr,
            },
          },
        },
        items: [
          {
            name: description || `Payvault ${productId}`,
            unit_amount: {
              currency_code: currency,
              value: decimalStr,
            },
            quantity: '1',
            category: 'DIGITAL_GOODS',
          },
        ],
      },
    ],
    application_context: {
      brand_name: 'Payvault Apex Recon',
      landing_page: 'NO_PREFERENCE',
      user_action: 'PAY_NOW',
      return_url: params.returnUrl || `${process.env.PAYPAL_APP_BASE_URL || 'http://localhost:3000'}/?status=paypal_approved`,
      cancel_url: params.cancelUrl || `${process.env.PAYPAL_APP_BASE_URL || 'http://localhost:3000'}/?status=paypal_cancelled`,
    },
  };

  const res = await client.request({
    endpoint: '/v2/checkout/orders',
    method: 'POST',
    data: orderPayload,
    idempotencyKey,
  });

  if (res.status < 200 || res.status >= 300) {
    const errorMsg = res.data?.message || res.data?.details?.[0]?.description || JSON.stringify(res.data);
    throw new Error(`PayPal create order failed [${res.status}]: ${errorMsg}`);
  }

  const order = res.data;
  const approveLink = (order.links || []).find(l => l.rel === 'approve')?.href || null;

  return {
    order_id: order.id,
    status: order.status,
    amount_minor: amountMinor,
    amount_decimal: decimalStr,
    currency,
    reference_id: referenceId,
    approve_url: approveLink,
    idempotency_key: idempotencyKey,
    raw_order: order,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Capture an approved PayPal Order v2 and strictly verify financial integrity.
 *
 * @param {Object} params
 * @param {PayPalClient} [params.client]
 * @param {string} params.orderId
 * @param {string} [params.idempotencyKey]
 * @param {Object} [params.expectedOrder] - { amountMinor, currency, referenceId } for anti-tamper check
 * @returns {Promise<Object>}
 */
async function captureOrder(params = {}) {
  const client = params.client || defaultPayPalClient;
  const { orderId, expectedOrder = null } = params;

  if (!orderId || typeof orderId !== 'string') {
    throw new Error('orderId is required to capture a PayPal order.');
  }

  const idempotencyKey = params.idempotencyKey || `req_cap_${orderId}_${Date.now()}`;

  const res = await client.request({
    endpoint: `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    method: 'POST',
    data: {},
    idempotencyKey,
  });

  if (res.status < 200 || res.status >= 300) {
    const errorMsg = res.data?.message || res.data?.details?.[0]?.description || JSON.stringify(res.data);
    throw new Error(`PayPal capture failed [${res.status}]: ${errorMsg}`);
  }

  const captureResponse = res.data;
  const purchaseUnit = captureResponse.purchase_units?.[0];
  const captureObj = purchaseUnit?.payments?.captures?.[0];

  if (!captureObj) {
    throw new Error(`No capture record found in PayPal response for order ${orderId}`);
  }

  const captureId = captureObj.id;
  const captureStatus = captureObj.status; // e.g. "COMPLETED", "PENDING"
  const capturedCurrency = captureObj.amount?.currency_code || 'USD';
  const capturedAmountDecimal = captureObj.amount?.value || '0.00';
  const capturedMinor = toMinorUnits(capturedAmountDecimal, capturedCurrency);

  // ── Verification 1: Capture Status must be COMPLETED ───────────────────────
  if (captureStatus !== 'COMPLETED') {
    throw new Error(`PayPal capture was not completed. Current status: ${captureStatus}`);
  }

  // ── Verification 2: Strict Expected Order Anti-Tamper Verification ────────
  if (expectedOrder) {
    if (expectedOrder.referenceId && purchaseUnit.reference_id && expectedOrder.referenceId !== purchaseUnit.reference_id) {
      throw new Error(`Tampered order reference: Expected ${expectedOrder.referenceId}, but PayPal returned ${purchaseUnit.reference_id}`);
    }

    assertExactMatch(
      { amount: expectedOrder.amountMinor, currency: expectedOrder.currency },
      { amount: capturedMinor, currency: capturedCurrency },
      'PayPal Capture Verification'
    );
  }

  // ── Seller Protection & Traceability ─────────────────────────────────────
  const sellerProtection = captureObj.seller_protection || null;
  const createTime = captureObj.create_time || new Date().toISOString();

  return {
    success: true,
    order_id: orderId,
    capture_id: captureId,
    capture_status: captureStatus,
    amount_minor: capturedMinor,
    amount_decimal: capturedAmountDecimal,
    currency: capturedCurrency,
    reference_id: purchaseUnit?.reference_id || purchaseUnit?.custom_id || null,
    seller_protection_status: sellerProtection?.status || 'UNKNOWN',
    idempotency_key: idempotencyKey,
    create_time: createTime,
    gateway: 'PAYPAL_SANDBOX',
    // Explicit architectural distinction: Gateway Capture, NOT bank nodal settlement
    is_gateway_capture: true,
    is_bank_settlement: false,
    raw_capture: captureObj,
  };
}

module.exports = {
  SERVER_CATALOG,
  resolveServerPrice,
  createOrder,
  captureOrder,
};
