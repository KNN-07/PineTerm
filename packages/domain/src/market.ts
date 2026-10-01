import { Decimal } from 'decimal.js';
import { TIMEFRAMES, type Bar, type BarGap, type Timeframe } from '../../contracts/src/market.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
export const NATIVE_TIMEFRAMES = ['1', '5', '15', '60', 'D'] as const;

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

export function fixedDuration(timeframe: string): number | null {
  if (timeframe === 'D') return DAY;
  if (timeframe === 'W') return 7 * DAY;
  if (timeframe === 'M') return null;
  if (!isTimeframe(timeframe)) throw new RangeError('Unsupported timeframe');
  return Number(timeframe) * MINUTE;
}

export function bucketStart(time: number, timeframe: string): number {
  if (timeframe === 'M') {
    const date = new Date(time);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  if (timeframe === 'W') return Math.floor((time + 3 * DAY) / (7 * DAY)) * 7 * DAY - 3 * DAY;
  return Math.floor(time / fixedDuration(timeframe)!) * fixedDuration(timeframe)!;
}

export function nextBucket(time: number, timeframe: string): number {
  const start = bucketStart(time, timeframe);
  if (timeframe === 'M') {
    const date = new Date(start);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return start + fixedDuration(timeframe)!;
}

/** Calendar aggregates require daily-or-finer input; weeks never divide months. */
export function canAggregate(base: string, target: string): boolean {
  if (!isTimeframe(base) || !isTimeframe(target)) return false;
  if (base === target) return true;
  if (base === 'M' || base === 'W') return false;
  const duration = fixedDuration(base)!;
  if (target === 'M') return duration <= DAY && DAY % duration === 0;
  const targetDuration = fixedDuration(target)!;
  return duration <= targetDuration && targetDuration % duration === 0;
}

export function availableTimeframes(base: string): string[] {
  return TIMEFRAMES.filter((target) => canAggregate(base, target));
}

export function nativeTimeframe(target: string): string {
  if (!isTimeframe(target)) throw new RangeError('Unsupported timeframe');
  return [...NATIVE_TIMEFRAMES].reverse().find((base) => canAggregate(base, target))!;
}

export function barIssue(bar: Bar): string | null {
  if (!Number.isSafeInteger(bar.time) || bar.time < 0 || bar.time > 8_640_000_000_000_000) return 'Time must be a nonnegative UTC epoch-millisecond integer.';
  if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) return 'OHLCV values must be finite numbers.';
  if (Math.min(bar.open, bar.high, bar.low, bar.close) <= 0) return 'OHLC prices must be positive.';
  if (bar.volume < 0) return 'Volume must be nonnegative.';
  if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close)) return 'High/low must contain open and close.';
  return null;
}

/** No synthetic candles: an incomplete bucket contains only its actual base observations. */
export function aggregateBars(bars: readonly Bar[], timeframe: string): Bar[] {
  const result: Bar[] = [];
  let volume = new Decimal(0);
  for (const bar of bars) {
    const time = bucketStart(bar.time, timeframe);
    let aggregate = result.at(-1);
    if (!aggregate || aggregate.time !== time) {
      aggregate = { ...bar, time };
      result.push(aggregate);
      volume = new Decimal(bar.volume);
    } else {
      aggregate.high = Math.max(aggregate.high, bar.high);
      aggregate.low = Math.min(aggregate.low, bar.low);
      aggregate.close = bar.close;
      volume = volume.plus(bar.volume);
      aggregate.volume = volume.toNumber();
    }
    if (!Number.isFinite(aggregate.volume)) throw new RangeError('Aggregated volume exceeds the finite wire range');
  }
  return result;
}

/** Missing base buckets remain explicit, including the edges of a bounded request. */
export function findGaps(bars: readonly Bar[], base: string, from?: number, to?: number): BarGap[] {
  const gaps: BarGap[] = [];
  let expected = from === undefined ? undefined : bucketStart(from, base);
  if (expected !== undefined && expected < from!) expected = nextBucket(expected, base);
  for (const bar of bars) {
    if (from !== undefined && bar.time < from) continue;
    if (to !== undefined && bar.time >= to) break;
    if (expected !== undefined && bar.time > expected) gaps.push({ from: expected, to: bar.time });
    expected = nextBucket(bar.time, base);
  }
  if (to !== undefined && expected !== undefined && expected < to) gaps.push({ from: expected, to });
  return gaps;
}

export function completeBucket(bars: readonly Bar[], base: string, target: string, confirmed: ReadonlySet<number>): boolean {
  if (!bars.length) return false;
  let expected = bucketStart(bars[0].time, target);
  const end = nextBucket(expected, target);
  for (const bar of bars) {
    if (bar.time !== expected || !confirmed.has(bar.time)) return false;
    expected = nextBucket(expected, base);
  }
  return expected === end;
}
