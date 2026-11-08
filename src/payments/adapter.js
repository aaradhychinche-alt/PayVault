'use strict';
/**
 * src/payments/adapter.js
 *
 * Generic transaction normalization adapter for historical payment records.
 * Normalizes payment responses into clean internal representations
 * with integer minor-unit amounts.
 *
 * Server-side only. Does not require external SDK dependencies.
 */

/**
 * Generic Order normalization.
 */
function normalizeOrder(order = {}) {
  return {
    id: order.id,
    amount: Math.round(Number(order.amount || 0)),
    currency: order.currency || 'INR',
    receipt: order.receipt || null,
    status: order.status || 'created',
    created_at: Number(order.created_at || Math.floor(Date.now() / 1000)),
    notes: order.notes && typeof order.notes === 'object' ? order.notes : null,
  };
}

/**
 * Generic Payment normalization.
 */
function normalizePayment(payment = {}) {
  return {
    id: payment.id,
    order_id: payment.order_id || null,
    amount: Math.round(Number(payment.amount || 0)),
    currency: payment.currency || 'INR',
    status: payment.status || 'captured',
    method: payment.method || null,
    card_network: payment.card ? payment.card.network || null : null,
    card_issuer: payment.card ? payment.card.issuer || null : null,
    card_type: payment.card ? payment.card.type || null : null,
    fee: payment.fee != null ? Math.round(Number(payment.fee)) : null,
    tax: payment.tax != null ? Math.round(Number(payment.tax)) : null,
    created_at: Number(payment.created_at || Math.floor(Date.now() / 1000)),
    notes: payment.notes && typeof payment.notes === 'object' ? payment.notes : null,
    description: payment.description || null,
    email: payment.email || null,
    contact: payment.contact || null,
  };
}

/**
 * Generic Refund normalization.
 */
function normalizeRefund(refund = {}) {
  return {
    id: refund.id,
    payment_id: refund.payment_id,
    amount: Math.round(Number(refund.amount || 0)),
    currency: refund.currency || 'INR',
    status: refund.status || 'processed',
    created_at: Number(refund.created_at || Math.floor(Date.now() / 1000)),
    notes: refund.notes && typeof refund.notes === 'object' ? refund.notes : null,
  };
}

/**
 * Fetch orders (generic fallback without live SDK).
 */
async function fetchOrders(options = {}, client = null) {
  if (client && client.orders && typeof client.orders.all === 'function') {
    const res = await client.orders.all(options);
    const items = res.items || [];
    return items.map(normalizeOrder);
  }
  return [];
}

/**
 * Fetch payments (generic fallback without live SDK).
 */
async function fetchPayments(options = {}, client = null) {
  if (client && client.payments && typeof client.payments.all === 'function') {
    const res = await client.payments.all(options);
    const items = res.items || [];
    return items.map(normalizePayment);
  }
  return [];
}

/**
 * Fetch refunds (generic fallback without live SDK).
 */
async function fetchRefunds(options = {}, client = null) {
  if (client && client.refunds && typeof client.refunds.all === 'function') {
    const res = await client.refunds.all(options);
    const items = res.items || [];
    return items.map(normalizeRefund);
  }
  return [];
}

/**
 * Fetch all available orders, payments, and refunds.
 */
async function fetchAllTransactions(client = null) {
  const [orders, payments, refunds] = await Promise.all([
    fetchOrders({ count: 100 }, client),
    fetchPayments({ count: 100 }, client),
    fetchRefunds({ count: 100 }, client),
  ]);

  return { orders, payments, refunds };
}

module.exports = {
  fetchOrders,
  fetchPayments,
  fetchRefunds,
  fetchAllTransactions,
  normalizeOrder,
  normalizePayment,
  normalizeRefund,
};
