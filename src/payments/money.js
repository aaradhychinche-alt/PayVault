'use strict';
/**
 * src/payments/money.js
 *
 * Currency-aware integer minor-unit financial arithmetic and validation.
 *
 * All monetary amounts in PayVault must be stored and processed as integer minor units
 * (e.g. cents for USD/EUR, paise for INR, pence for GBP, yen for JPY) to guarantee
 * zero floating-point drift and strict reconciliation integrity.
 */

// ISO-4217 minor unit decimal places (scales)
const CURRENCY_SCALES = {
  USD: 2, // 1 USD = 100 cents
  EUR: 2, // 1 EUR = 100 cents
  INR: 2, // 1 INR = 100 paise
  GBP: 2, // 1 GBP = 100 pence
  CAD: 2,
  AUD: 2,
  SGD: 2,
  JPY: 0, // 1 JPY = 1 yen (no minor unit)
  KRW: 0,
};

const DEFAULT_CURRENCY = 'USD';

/**
 * Get decimal scale for a given currency code.
 * @param {string} currency
 * @returns {number}
 */
function getCurrencyScale(currency = DEFAULT_CURRENCY) {
  const code = (currency || DEFAULT_CURRENCY).toUpperCase();
  return CURRENCY_SCALES[code] !== undefined ? CURRENCY_SCALES[code] : 2;
}

/**
 * Convert a decimal number or string to integer minor units (e.g. 10.50 USD -> 1050 cents).
 * @param {number|string} decimalValue
 * @param {string} currency
 * @returns {number} integer minor units
 */
function toMinorUnits(decimalValue, currency = DEFAULT_CURRENCY) {
  if (decimalValue === null || decimalValue === undefined || decimalValue === '') {
    throw new Error('Amount value is required for minor unit conversion.');
  }

  const num = typeof decimalValue === 'string' ? parseFloat(decimalValue) : Number(decimalValue);
  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`Invalid numeric amount for conversion: ${decimalValue}`);
  }

  const scale = getCurrencyScale(currency);
  const factor = Math.pow(10, scale);
  // Math.round handles floating point imprecision like 19.99 * 100 = 1998.9999999999998
  return Math.round(num * factor);
}

/**
 * Convert integer minor units to a standardized decimal string (e.g. 1050 cents -> "10.50").
 * @param {number} minorUnits
 * @param {string} currency
 * @returns {string}
 */
function toDecimalString(minorUnits, currency = DEFAULT_CURRENCY) {
  if (typeof minorUnits !== 'number' || isNaN(minorUnits) || !isFinite(minorUnits)) {
    throw new Error(`Invalid minor units for decimal string formatting: ${minorUnits}`);
  }

  const scale = getCurrencyScale(currency);
  const factor = Math.pow(10, scale);
  const decimal = minorUnits / factor;
  return decimal.toFixed(scale);
}

/**
 * Format money with currency symbol for display.
 * @param {number} minorUnits
 * @param {string} currency
 * @returns {string}
 */
function formatMoney(minorUnits, currency = DEFAULT_CURRENCY) {
  if (minorUnits === null || minorUnits === undefined || isNaN(minorUnits)) {
    return '—';
  }

  const curr = (currency || DEFAULT_CURRENCY).toUpperCase();
  const scale = getCurrencyScale(curr);
  const decimal = minorUnits / Math.pow(10, scale);

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: curr,
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    }).format(decimal);
  } catch {
    return `${curr} ${decimal.toFixed(scale)}`;
  }
}

/**
 * Strictly verify that two monetary values match in currency and integer minor amount.
 * Throws an error on mismatch.
 *
 * @param {Object} expected - { amount: number (minor units), currency: string }
 * @param {Object} actual   - { amount: number (minor units), currency: string }
 * @param {string} [context]
 */
function assertExactMatch(expected, actual, context = 'Amount verification') {
  if (!expected || !actual) {
    throw new Error(`${context}: Both expected and actual monetary objects must be provided.`);
  }

  const expCurr = (expected.currency || DEFAULT_CURRENCY).toUpperCase();
  const actCurr = (actual.currency || DEFAULT_CURRENCY).toUpperCase();

  if (expCurr !== actCurr) {
    throw new Error(`${context}: Currency mismatch. Expected ${expCurr}, got ${actCurr}.`);
  }

  const expAmount = Math.round(Number(expected.amount));
  const actAmount = Math.round(Number(actual.amount));

  if (expAmount !== actAmount) {
    throw new Error(
      `${context}: Exact amount mismatch. Expected ${expAmount} minor units (${toDecimalString(expAmount, expCurr)} ${expCurr}), ` +
      `got ${actAmount} minor units (${toDecimalString(actAmount, actCurr)} ${actCurr}).`
    );
  }

  return true;
}

module.exports = {
  CURRENCY_SCALES,
  DEFAULT_CURRENCY,
  getCurrencyScale,
  toMinorUnits,
  toDecimalString,
  formatMoney,
  assertExactMatch,
};
