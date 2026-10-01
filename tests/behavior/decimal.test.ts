import { describe, expect, it } from 'vitest';
import { financialDecimal, decimalString } from '../../packages/domain/src/index.js';

describe('financial wire decimals', () => {
  it('preserves exact cash arithmetic beyond binary floating-point precision', () => {
    const balance = financialDecimal('9007199254740993.1');
    const price = financialDecimal('0.2');
    expect(decimalString(balance.minus(price.mul(3)))).toBe('9007199254740992.5');
  });
  it('rejects ambiguous and noncanonical command values', () => {
    for (const value of ['NaN', 'Infinity', '1e3', '-0', '01', '0.10', '.5', '1.']) {
      expect(() => financialDecimal(value)).toThrow();
    }
    expect(decimalString(financialDecimal('-0.25'))).toBe('-0.25');
  });
});
