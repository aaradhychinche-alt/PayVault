'use strict';
/**
 * src/paypal/webhook.js
 *
 * PayPal Sandbox Webhook Processing:
 * - Signature verification against official PayPal API (/v1/notifications/verify-webhook-signature)
 * - Safe event deduplication (idempotent webhook replay protection)
 * - Out-of-order event sequence handling
 * - Dedicated handling of refunds & reversals with REVIEW_REQUIRED flags
 *
 * NEVER labels a capture as bank settlement.
 */

const { defaultPayPalClient } = require('./client');
const { toMinorUnits } = require('../payments/money');
const store = require('../store/dataStore');

// Processed event tracking for in-memory and durable deduplication
const _processedEvents = new Map(); // eventId -> { timestamp, eventType, summary }
const _resourceStates = new Map();  // resourceId -> { latestStatus, history: [] }

/**
 * Reset webhook state (primarily for tests).
 */
function resetWebhookState() {
  _processedEvents.clear();
  _resourceStates.clear();
  if (store.resetWebhookStorage) {
    store.resetWebhookStorage();
  }
}

/**
 * Verify a PayPal webhook signature using PayPal's verification endpoint.
 *
 * @param {Object} params
 * @param {PayPalClient} [params.client]
 * @param {Object} params.headers - HTTP headers from the webhook request
 * @param {Object|string} params.body - Raw or parsed webhook payload
 * @param {string} [params.webhookId] - Optional webhook ID override
 * @returns {Promise<{ verified: boolean, reason?: string }>}
 */
async function verifyWebhookSignature(params = {}) {
  const client = params.client || defaultPayPalClient;
  const { headers, webhookId } = params;
  const body = params.body !== undefined ? params.body : params.rawBody;

  const targetWebhookId = webhookId || client.webhookId;

  // Header extraction (case-insensitive)
  const getHeader = (name) => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers || {})) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  };

  const authAlgo = getHeader('paypal-auth-algo');
  const certUrl = getHeader('paypal-cert-url');
  const transmissionId = getHeader('paypal-transmission-id');
  const transmissionSig = getHeader('paypal-transmission-sig');
  const transmissionTime = getHeader('paypal-transmission-time');

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    return {
      verified: false,
      reason: 'MISSING_PAYPAL_SIGNATURE_HEADERS',
    };
  }

  // Safety check on certUrl: must be from paypal.com
  try {
    const parsedCertUrl = new URL(certUrl);
    if (!parsedCertUrl.hostname.endsWith('.paypal.com')) {
      return { verified: false, reason: 'INVALID_CERT_URL_HOST' };
    }
  } catch {
    return { verified: false, reason: 'MALFORMED_CERT_URL' };
  }

  // If webhookId is not set, fail closed unconditionally
  if (!targetWebhookId) {
    return {
      verified: false,
      reason: 'PAYPAL_WEBHOOK_ID_NOT_CONFIGURED',
    };
  }

  // Raw-body and string payload handling
  let webhookEvent;
  if (Buffer.isBuffer(body)) {
    try {
      webhookEvent = JSON.parse(body.toString('utf8'));
    } catch {
      return { verified: false, reason: 'MALFORMED_WEBHOOK_JSON_BODY' };
    }
  } else if (typeof body === 'string') {
    try {
      webhookEvent = JSON.parse(body);
    } catch {
      return { verified: false, reason: 'MALFORMED_WEBHOOK_JSON_BODY' };
    }
  } else if (body && typeof body === 'object') {
    webhookEvent = body;
  } else {
    return { verified: false, reason: 'EMPTY_OR_INVALID_BODY' };
  }

  const verificationPayload = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: targetWebhookId,
    webhook_event: webhookEvent,
  };

  try {
    const res = await client.request({
      endpoint: '/v1/notifications/verify-webhook-signature',
      method: 'POST',
      data: verificationPayload,
    });

    const isVerified = res.data?.verification_status === 'SUCCESS';
    return {
      verified: isVerified,
      status: res.data?.verification_status || 'FAILURE',
      reason: isVerified ? null : 'PAYPAL_REJECTED_SIGNATURE',
    };
  } catch (err) {
    return {
      verified: false,
      reason: `VERIFICATION_API_ERROR: ${err.message}`,
    };
  }
}

/**
 * Process a verified PayPal Webhook event safely.
 *
 * Handles:
 * - Event deduplication
 * - Out-of-order execution
 * - Refund / reversal review flags
 *
 * @param {Object} event - Parsed PayPal event JSON
 * @param {Object} [options]
 * @returns {{ status: string, action_taken: string, details: Object }}
 */
function processWebhookEvent(event, options = {}) {
  let parsedEvent = event;
  if (Buffer.isBuffer(event)) {
    try {
      parsedEvent = JSON.parse(event.toString('utf8'));
    } catch {
      throw new Error('Invalid webhook event: Malformed JSON Buffer.');
    }
  } else if (typeof event === 'string') {
    try {
      parsedEvent = JSON.parse(event);
    } catch {
      throw new Error('Invalid webhook event: Malformed JSON string.');
    }
  }

  if (!parsedEvent || !parsedEvent.id) {
    throw new Error('Invalid webhook event: Missing event ID.');
  }

  const eventId = parsedEvent.id;
  const eventType = parsedEvent.event_type || 'UNKNOWN';
  const resource = parsedEvent.resource || {};
  const resourceId = resource.id || resource.dispute_id || 'unknown';

  // ── Step 1: Durable Idempotency & Deduplication ──────────────────────────
  if (_processedEvents.has(eventId) || (store.getWebhookEvent && store.getWebhookEvent(eventId))) {
    return {
      status: 'DUPLICATE_IGNORED',
      event_id: eventId,
      event_type: eventType,
      message: `Event ${eventId} has already been processed. Skipping duplicate.`,
    };
  }

  // ── Step 2: Track Resource State & Out-of-Order History ─────────────────────
  let stateRecord = store.getResourceState ? store.getResourceState(resourceId) : null;
  if (!stateRecord) {
    stateRecord = _resourceStates.get(resourceId) || { latestStatus: null, events: [] };
  }
  stateRecord.events = stateRecord.events || [];
  stateRecord.events.push({
    eventId,
    eventType,
    timestamp: Date.now(),
    create_time: parsedEvent.create_time,
  });

  let actionTaken = 'LOGGED';
  let reviewRequired = false;
  let exceptionType = null;
  let parsedAmountMinor = null;
  let currency = 'USD';

  if (resource.amount) {
    currency = resource.amount.currency_code || 'USD';
    parsedAmountMinor = toMinorUnits(resource.amount.value, currency);
  } else if (resource.dispute_amount) {
    currency = resource.dispute_amount.currency_code || 'USD';
    parsedAmountMinor = toMinorUnits(resource.dispute_amount.value, currency);
  }

  // ── Step 3: Handle Event Types ─────────────────────────────────────────────
  switch (eventType) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      // Guard against out-of-order downgrade: Never overwrite terminal REFUNDED, REVERSED, or DISPUTED
      if (stateRecord.latestStatus !== 'REFUNDED' && stateRecord.latestStatus !== 'REVERSED' && stateRecord.latestStatus !== 'DISPUTED') {
        stateRecord.latestStatus = 'CAPTURED';
      }
      actionTaken = 'CAPTURE_RECORDED';
      break;

    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
      stateRecord.latestStatus = 'DENIED';
      actionTaken = 'CAPTURE_DENIED';
      reviewRequired = true;
      exceptionType = 'PAYMENT_DENIED';
      break;

    case 'PAYMENT.CAPTURE.REFUNDED':
      stateRecord.latestStatus = 'REFUNDED';
      actionTaken = 'REFUND_RECORDED_FOR_REVIEW';
      reviewRequired = true;
      exceptionType = 'PARTIAL_REFUND';
      break;

    case 'PAYMENT.CAPTURE.REVERSED':
      stateRecord.latestStatus = 'REVERSED';
      actionTaken = 'REVERSAL_FLAGGED_FOR_AUDIT';
      reviewRequired = true;
      exceptionType = 'DISPUTE_REVERSAL';
      break;

    case 'CUSTOMER.DISPUTE.CREATED':
      stateRecord.latestStatus = 'DISPUTED';
      actionTaken = 'DISPUTE_OPENED_REVIEW_REQUIRED';
      reviewRequired = true;
      exceptionType = 'DISPUTE_REVERSAL';
      break;

    case 'CUSTOMER.DISPUTE.RESOLVED':
      stateRecord.latestStatus = 'DISPUTE_RESOLVED';
      actionTaken = 'DISPUTE_RESOLVED';
      reviewRequired = false;
      break;

    case 'CUSTOMER.DISPUTE.UPDATED':
      if (stateRecord.latestStatus !== 'DISPUTE_RESOLVED') {
        stateRecord.latestStatus = 'DISPUTED';
      }
      actionTaken = 'DISPUTE_UPDATED';
      reviewRequired = true;
      exceptionType = 'DISPUTE_REVERSAL';
      break;

    case 'CHECKOUT.ORDER.APPROVED':
      // Guard against out-of-order downgrade: Never overwrite CAPTURED, REFUNDED, or REVERSED
      if (stateRecord.latestStatus !== 'CAPTURED' && stateRecord.latestStatus !== 'REFUNDED' && stateRecord.latestStatus !== 'REVERSED' && stateRecord.latestStatus !== 'DISPUTED') {
        stateRecord.latestStatus = 'APPROVED';
      }
      actionTaken = 'ORDER_APPROVED';
      break;

    default:
      actionTaken = `EVENT_${eventType}`;
      break;
  }

  const result = {
    status: 'PROCESSED',
    processed: true,
    event_id: eventId,
    event_type: eventType,
    resource_id: resourceId,
    dispute_id: resource.dispute_id || (eventType.startsWith('CUSTOMER.DISPUTE') ? resourceId : undefined),
    action_taken: actionTaken,
    review_required: reviewRequired,
    exception_type: exceptionType,
    amount_minor: parsedAmountMinor,
    currency,
    is_gateway_capture: true,
    is_bank_settlement: false, // strictly maintain distinction
    timestamp: Date.now(),
  };

  _processedEvents.set(eventId, result);
  _resourceStates.set(resourceId, stateRecord);

  if (store.recordWebhookEvent) {
    store.recordWebhookEvent(eventId, result);
  }
  if (store.setResourceState) {
    store.setResourceState(resourceId, stateRecord);
  }

  // ── Step 4: Record in Audit Trail & Exceptions for Operator Review ──────────
  if (store.recordDisputeAudit) {
    store.recordDisputeAudit({
      event_id: eventId,
      event_type: eventType,
      resource_id: resourceId,
      action_taken: actionTaken,
      exception_type: exceptionType,
      amount_minor: parsedAmountMinor,
      currency,
      review_required: reviewRequired,
      details: {
        reason: resource.reason || resource.dispute_reason || null,
        status: resource.status || stateRecord.latestStatus,
        dispute_id: resource.dispute_id || (eventType.startsWith('CUSTOMER.DISPUTE') ? resourceId : null),
      },
    });
  }

  return result;
}

module.exports = {
  verifyWebhookSignature,
  processWebhookEvent,
  resetWebhookState,
  _processedEvents,
  _resourceStates,
};
