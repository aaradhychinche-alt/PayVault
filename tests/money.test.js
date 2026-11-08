'use strict';
/**
 * tests/money.test.js
 *
 * Focused tests for currency-aware integer minor-unit financial arithmetic,
 * floating-point drift prevention, and exact amount anti-tamper assertions.
 */

const {
  CURRENCY_SCALES,
  getCurrencyScale,
  toMinorUnits,
  toDecimalString,
  formatMoney,
  assertExactMatch,
} = require('../src/payments/money');

describe('Currency-Aware Integer Minor-Unit Money Module', () => {
  describe('Scales and Minor Units', () => {
    test('returns correct decimal scale for major currencies', () => {
      expect(getCurrencyScale('USD')).toBe(2);
      expect(getCurrencyScale('EUR')).toBe(2);
      expect(getCurrencyScale('INR')).toBe(2);
      expect(getCurrencyScale('GBP')).toBe(2);
      expect(getCurrencyScale('JPY')).toBe(0); // Zero-scale currency
    });

    test('converts decimal amounts to integer minor units without float drift', () => {
      expect(toMinorUnits('10.00', 'USD')).toBe(1000);
      expect(toMinorUnits(10.50, 'USD')).toBe(1050);
      expect(toMinorUnits('19.99', 'USD')).toBe(1999);
      expect(toMinorUnits(123.45, 'INR')).toBe(12345);
      expect(toMinorUnits('500', 'JPY')).toBe(500);
    });

    test('converts integer minor units to standardized decimal strings', () => {
      expect(toDecimalString(1000, 'USD')).toBe('10.00');
      expect(toDecimalString(1050, 'USD')).toBe('10.50');
      expect(toDecimalString(1999, 'USD')).toBe('19.99');
      expect(toDecimalString(12345, 'INR')).toBe('123.45');
      expect(toDecimalString(500, 'JPY')).toBe('500');
    });

    test('rejects invalid inputs gracefully', () => {
      expect(() => toMinorUnits(null, 'USD')).toThrow();
      expect(() => toMinorUnits('not-a-number', 'USD')).toThrow();
      expect(() => toDecimalString(NaN, 'USD')).toThrow();
    });
  });

  describe('Anti-Tampering & Exact Match Verification', () => {
    test('passes when expected and actual amounts and currencies match exactly', () => {
      const expected = { amount: 2500, currency: 'USD' };
      const actual = { amount: 2500, currency: 'USD' };
      expect(assertExactMatch(expected, actual)).toBe(true);
    });

    test('rejects tampered amount (even 1 minor unit / 1 cent difference)', () => {
      const expected = { amount: 2500, currency: 'USD' };
      const actual = { amount: 2499, currency: 'USD' }; // 1 cent less
      expect(() => assertExactMatch(expected, actual, 'Payment Verification')).toThrow(
        /Exact amount mismatch/
      );
    });

    test('rejects tampered currency (e.g. attempting to pay in INR instead of USD)', () => {
      const expected = { amount: 2500, currency: 'USD' };
      const actual = { amount: 2500, currency: 'INR' };
      expect(() => assertExactMatch(expected, actual, 'Currency Check')).toThrow(
        /Currency mismatch/
      );
    });
  });
});
