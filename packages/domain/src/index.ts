import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** Canonical non-exponent decimal wire values; callers enforce instrument steps. */
export function financialDecimal(value: string): Decimal {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value) || value === '-0') {
    throw new Error('Expected a canonical decimal string');
  }
  const result = new Decimal(value);
  if (!result.isFinite()) throw new Error('Expected a finite decimal');
  return result;
}

export function decimalString(value: Decimal): string {
  if (!value.isFinite()) throw new Error('Cannot serialize a nonfinite financial value');
  return value.isZero() ? '0' : value.toFixed();
}
