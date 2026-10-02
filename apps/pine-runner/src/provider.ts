import { computeNextPeriodStart, TIMEFRAME_PERIOD_INFO, type IProvider, type ISymbolInfo, type Kline } from 'pinets';
import type { Bar, Instrument, MarketRef } from '../../../packages/contracts/src/market.js';
import type { PineDataRequest, PineDataResponse, PineRunRequest } from '../../../packages/contracts/src/pine.js';

export class RunnerError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function closeTime(time: number, timeframe: string): number {
  const period = TIMEFRAME_PERIOD_INFO[timeframe];
  if (!period) throw new RunnerError('UNSUPPORTED_TIMEFRAME', `Unsupported timeframe: ${timeframe}`);
  return computeNextPeriodStart(time, period.periodType, period.multiplier);
}

function symbolInfo(instrument: Instrument): ISymbolInfo {
  const tick = Number(instrument.tickSize);
  const step = Number(instrument.quantityStep);
  if (!Number.isFinite(tick) || tick <= 0 || !Number.isFinite(step) || step <= 0) throw new RunnerError('INVALID_METADATA', 'Instrument tick and quantity steps must be positive finite values.');
  const prefix = instrument.market.provider.toUpperCase();
  return {
    current_contract: '', description: instrument.name, isin: '', main_tickerid: `${prefix}:${instrument.market.symbol}`,
    prefix, root: instrument.baseCurrency, ticker: instrument.market.symbol, tickerid: `${prefix}:${instrument.market.symbol}`,
    type: 'crypto', basecurrency: instrument.baseCurrency, country: '', currency: instrument.quoteCurrency, timezone: 'Etc/UTC',
    employees: NaN, industry: '', sector: '', shareholders: NaN, shares_outstanding_float: NaN, shares_outstanding_total: NaN,
    expiration_date: NaN, session: '24x7', volumetype: 'base', mincontract: step, minmove: 1, mintick: tick, pointvalue: 1,
    pricescale: 1 / tick, recommendations_buy: NaN, recommendations_buy_strong: NaN, recommendations_date: NaN,
    recommendations_hold: NaN, recommendations_sell: NaN, recommendations_sell_strong: NaN, recommendations_total: NaN,
    target_price_average: NaN, target_price_date: NaN, target_price_estimates: NaN, target_price_high: NaN,
    target_price_low: NaN, target_price_median: NaN,
  };
}

function klines(bars: Bar[], timeframe: string): Kline[] {
  return bars.map(({ time, ...bar }) => ({ ...bar, openTime: time, closeTime: closeTime(time, timeframe),
    quoteAssetVolume: NaN, numberOfTrades: NaN, takerBuyBaseAssetVolume: NaN, takerBuyQuoteAssetVolume: NaN, ignore: 0 }));
}

/** Public IProvider adapter. It has no network path, and every secondary series comes from the host broker. */
export class SnapshotProvider implements IProvider {
  readonly #job: PineRunRequest;
  readonly #send: (message: PineDataRequest) => void;
  readonly #pending = new Map<string, PromiseWithResolvers<PineDataResponse>>();
  readonly #series = new Map<string, Promise<{ bars: Bar[]; symbolInfo: Instrument }>>();
  readonly #symbols = new Map<string, Instrument>();
  #sequence = 0;
  #barCount: number;

  constructor(job: PineRunRequest, send: (message: PineDataRequest) => void) {
    this.#job = job;
    this.#send = send;
    this.#barCount = job.bars.length;
    this.#symbols.set(job.market.symbol, job.symbolInfo);
    this.#series.set(`${job.market.symbol}/${job.timeframe}`, Promise.resolve({ bars: job.bars, symbolInfo: job.symbolInfo }));
  }

  configure(): void { throw new RunnerError('PROVIDER_CONFIGURATION_FORBIDDEN', 'Scripts cannot configure the snapshot provider.'); }

  receive(response: PineDataResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) throw new RunnerError('INVALID_PROTOCOL', 'Unsolicited data response.');
    this.#pending.delete(response.id);
    if (response.error) pending.reject(new RunnerError(response.error.code, response.error.message));
    else pending.resolve(response);
  }

  #market(ticker: string): MarketRef {
    if (typeof ticker !== 'string' || ticker.includes(';')) throw new RunnerError('UNSUPPORTED_TICKER', 'Only raw instrument tickers are supported by the backtest broker.');
    const parts = ticker.split(':');
    if (parts.length > 2 || (parts.length === 2 && parts[0].toLowerCase() !== this.#job.market.provider)) throw new RunnerError('CROSS_PROVIDER_REQUEST', 'Secondary data must use the selected provider.');
    const symbol = parts.at(-1)!;
    if (!symbol || symbol.length > 100) throw new RunnerError('INVALID_SYMBOL', 'Secondary data must use a valid symbol.');
    return { provider: this.#job.market.provider, symbol };
  }

  async #load(market: MarketRef, timeframe: string): Promise<{ bars: Bar[]; symbolInfo: Instrument }> {
    const key = `${market.symbol}/${timeframe}`;
    let series = this.#series.get(key);
    if (!series) {
      if (this.#series.size >= 21) throw new RunnerError('SECONDARY_SERIES_BUDGET', 'At most 20 distinct secondary series are allowed.');
      const deferred = Promise.withResolvers<PineDataResponse>();
      const id = String(++this.#sequence);
      this.#pending.set(id, deferred);
      series = deferred.promise.then((response) => {
        const { bars, symbolInfo: instrument } = response;
        if (!Array.isArray(bars) || !instrument || instrument.market.provider !== market.provider || instrument.market.symbol !== market.symbol) throw new RunnerError('INVALID_PROTOCOL', 'Data response must contain matching frozen bars and instrument metadata.');
        if (this.#barCount + bars.length > 50_000) throw new RunnerError('BAR_BUDGET_EXCEEDED', 'Primary and secondary snapshots exceed 50,000 bars.');
        let previous = -1;
        for (const bar of bars) {
          if (!Number.isSafeInteger(bar.time) || bar.time < this.#job.from || closeTime(bar.time, timeframe) > this.#job.to || bar.time <= previous || ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) throw new RunnerError('INVALID_PROTOCOL', 'Secondary bars must be finite, ascending, unique and closed within the permitted horizon.');
          previous = bar.time;
        }
        this.#barCount += bars.length;
        this.#symbols.set(market.symbol, instrument);
        return { bars, symbolInfo: instrument };
      });
      this.#series.set(key, series);
      this.#send({ type: 'data_request', id, market, timeframe, from: this.#job.from, to: this.#job.to, limit: 50_000 });
    }
    return series;
  }

  async getMarketData(tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number): Promise<Kline[]> {
    const market = this.#market(tickerId);
    const tf = timeframe === '1D' ? 'D' : timeframe === '1W' ? 'W' : timeframe === '1M' ? 'M' : timeframe;
    closeTime(this.#job.from, tf);
    const snapshot = await this.#load(market, tf);
    // PineTS may request a tail again; serve only the frozen snapshot, clipped to this run's close cursor.
    const from = Math.max(this.#job.from, sDate ?? this.#job.from);
    const to = Math.min(this.#job.to, eDate ?? this.#job.to);
    const bars = snapshot.bars.filter((bar) => bar.time >= from && closeTime(bar.time, tf) <= to);
    return klines(limit === undefined ? bars : bars.slice(-Math.max(0, limit)), tf);
  }

  async getSymbolInfo(tickerId: string): Promise<ISymbolInfo> {
    const market = this.#market(tickerId);
    const instrument = this.#symbols.get(market.symbol) ?? (await this.#load(market, this.#job.timeframe)).symbolInfo;
    if (instrument.quoteCurrency !== this.#job.symbolInfo.quoteCurrency) throw new RunnerError('FX_CONVERSION_UNSUPPORTED', 'Secondary instruments requiring currency conversion are not supported.');
    return symbolInfo(instrument);
  }
}
