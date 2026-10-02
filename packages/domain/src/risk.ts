import { Decimal } from 'decimal.js';
import type { LiveAction } from '@pineterm/contracts';

// Commands are bounded to 100 characters. Products/sums remain exact instead of
// inheriting the lower precision used by chart/simulation arithmetic.
export const RiskDecimal = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_UP });
export function riskDecimal(value: string): Decimal {
  if (typeof value !== 'string' || value.length > 100 || !/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value) || value === '-0') throw new Error('Expected a bounded canonical decimal string.');
  return new RiskDecimal(value);
}
export function riskString(value: Decimal): string {
  if (!value.isFinite()) throw new Error('Nonfinite risk value.');
  return value.isZero() ? '0' : value.toFixed();
}
export function riskPositive(value: string): Decimal {
  const amount = riskDecimal(value);
  if (!amount.gt(0)) throw new Error('Amount must be positive.');
  return amount;
}
export function riskAligned(value: string, step: string): boolean { return riskPositive(value).mod(riskPositive(step)).isZero(); }
export interface ExecutionBounds { minimum: string | null; maximum: string | null; unitRiskPrice: string; notional: string }
export function executionBounds(action: LiveAction, referencePrice: string, deviationBps: string): ExecutionBounds {
  const price = riskPositive(referencePrice);
  const deviation = riskDecimal(deviationBps).div(10000);
  if (deviation.isNegative() || deviation.gte(1)) throw new Error('Deviation must be in [0,10000) bps.');
  const upper = price.mul(deviation.plus(1));
  const lower = price.mul(new RiskDecimal(1).minus(deviation));
  const unit = action.type === 'market' ? upper : RiskDecimal.max(price, riskPositive(action.limitPrice!));
  return {
    minimum: action.type === 'market' ? riskString(lower) : action.side === 'sell' ? action.limitPrice! : null,
    maximum: action.type === 'market' ? riskString(upper) : action.side === 'buy' ? action.limitPrice! : null,
    unitRiskPrice: riskString(unit), notional: riskString(unit.mul(riskPositive(action.quantity))),
  };
}
