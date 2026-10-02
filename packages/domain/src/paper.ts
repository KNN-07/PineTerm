import { Decimal } from 'decimal.js';
import type { Bar, PaperOrderRequest } from '@pineterm/contracts';
import { decimalString, financialDecimal } from './index.js';

const BASIS_POINTS = new Decimal(10_000);

export function positivePaperDecimal(value: string, label: string): Decimal {
  const amount = financialDecimal(value);
  if (!amount.isPositive()) throw new Error(`${label} must be positive.`);
  return amount;
}

export function paperStepAligned(value: Decimal, step: string): boolean {
  return value.mod(positivePaperDecimal(step, 'Instrument step')).isZero();
}

/** Fees and adverse slippage are decimal bps, not binary floating point percentages. */
export function paperFee(notional: Decimal, commissionBps: string): Decimal {
  return notional.mul(financialDecimal(commissionBps)).div(BASIS_POINTS);
}

export function paperExecutionPrice(price: Decimal, side: 'buy' | 'sell', slippageBps: string, limitPrice?: string): Decimal {
  const slip = financialDecimal(slippageBps).div(BASIS_POINTS);
  const adverse = price.mul(side === 'buy' ? slip.plus(1) : new Decimal(1).minus(slip));
  if (limitPrice === undefined) return adverse;
  const limit = financialDecimal(limitPrice);
  return side === 'buy' ? Decimal.min(adverse, limit) : Decimal.max(adverse, limit);
}

export function paperBuyReservation(order: PaperOrderRequest, reference: Decimal | null, commissionBps: string, slippageBps: string): Decimal {
  let price: Decimal;
  if (order.type === 'limit') price = financialDecimal(order.limitPrice!);
  else {
    if (reference === null) throw new Error('A fresh reference price is required.');
    price = order.type === 'stop' ? Decimal.max(reference, financialDecimal(order.stopPrice!)) : reference;
    price = paperExecutionPrice(price, 'buy', slippageBps);
  }
  const notional = financialDecimal(order.quantity).mul(price);
  return notional.plus(paperFee(notional, commissionBps));
}

export function paperQuotePrice(order: PaperOrderRequest, price: Decimal): Decimal | null {
  if (order.type === 'limit') {
    const limit = financialDecimal(order.limitPrice!);
    if (order.side === 'buy' ? price.gt(limit) : price.lt(limit)) return null;
  } else if (order.type === 'stop') {
    const stop = financialDecimal(order.stopPrice!);
    if (order.side === 'buy' ? price.lt(stop) : price.gt(stop)) return null;
  }
  return price;
}

/** Raw OHLC gap rules; this intentionally does not promise an intrabar path. */
export function paperReplayPrice(order: PaperOrderRequest, bar: Bar): Decimal | null {
  const open = new Decimal(bar.open);
  if (order.type === 'market') return open;
  if (order.type === 'limit') {
    const limit = financialDecimal(order.limitPrice!);
    if (order.side === 'buy') return new Decimal(bar.low).lte(limit) ? Decimal.min(open, limit) : null;
    return new Decimal(bar.high).gte(limit) ? Decimal.max(open, limit) : null;
  }
  const stop = financialDecimal(order.stopPrice!);
  if (order.side === 'buy') return new Decimal(bar.high).gte(stop) ? Decimal.max(open, stop) : null;
  return new Decimal(bar.low).lte(stop) ? Decimal.min(open, stop) : null;
}

export interface PaperSpotState { cashBalance: string; quantity: string; costBasis: string; realizedPnl: string }
export interface PaperSpotFill extends PaperSpotState { fee: string; cashDelta: string; realizedDelta: string }

/** A caller must check reservations/free funds transactionally before applying this transition. */
export function paperSpotFill(state: PaperSpotState, side: 'buy' | 'sell', quantity: Decimal, price: Decimal, commissionBps: string): PaperSpotFill {
  const cash = financialDecimal(state.cashBalance);
  const held = financialDecimal(state.quantity);
  const basis = financialDecimal(state.costBasis);
  const realized = financialDecimal(state.realizedPnl);
  const notional = quantity.mul(price);
  const fee = paperFee(notional, commissionBps);
  let cashDelta: Decimal; let nextQuantity: Decimal; let nextBasis: Decimal; let realizedDelta: Decimal;
  if (side === 'buy') {
    cashDelta = notional.plus(fee).negated();
    nextQuantity = held.plus(quantity);
    nextBasis = basis.minus(cashDelta);
    realizedDelta = new Decimal(0);
  } else {
    if (quantity.gt(held)) throw new Error('Spot accounts cannot sell unheld quantity.');
    const allocatedCost = quantity.eq(held) ? basis : basis.mul(quantity).div(held);
    cashDelta = notional.minus(fee);
    nextQuantity = held.minus(quantity);
    nextBasis = nextQuantity.isZero() ? new Decimal(0) : basis.minus(allocatedCost);
    realizedDelta = cashDelta.minus(allocatedCost);
  }
  const nextCash = cash.plus(cashDelta);
  if (nextCash.isNegative() || nextQuantity.isNegative()) throw new Error('Spot accounts cannot have negative cash or holdings.');
  return { cashBalance: decimalString(nextCash), quantity: decimalString(nextQuantity), costBasis: decimalString(nextBasis), realizedPnl: decimalString(realized.plus(realizedDelta)), fee: decimalString(fee), cashDelta: decimalString(cashDelta), realizedDelta: decimalString(realizedDelta) };
}
