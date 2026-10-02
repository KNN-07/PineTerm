import type { IProvider, ISymbolInfo, Kline } from 'pinets';
import type { Instrument } from '../../packages/contracts/src/market.js';
import { FIXTURE_BARS, FIXTURE_START } from './market.js';

export const SMA_SOURCE = '//@version=6\nindicator("PineTerm SMA fixture")\nlength=input.int(2,"Length")\nplot(ta.sma(close,length),"SMA")\n';
export const DUPLICATE_INPUT_SOURCE = '//@version=6\nindicator("PineTerm distinct input fixture")\nfast=input.int(2,"Length")\nslow=input.int(3,"Length")\nplot(fast+slow,"Sum")\n';
export const ROUND_TRIP_SOURCE = `//@version=6
strategy("PineTerm deterministic round trip", initial_capital=1000,
     default_qty_type=strategy.fixed, default_qty_value=1,
     commission_type=strategy.commission.cash_per_order,
     commission_value=1, slippage=0, process_orders_on_close=false)
if bar_index == 0
    strategy.entry("L", strategy.long, 1)
if bar_index == 3
    strategy.close("L")
`;
export const FIXTURE_TO = FIXTURE_START + 360000;

/** Trusted unpaginated comparison only; never selected by the production application. */
export function referenceProvider(instrument: Instrument): IProvider {
  return {
    async getMarketData(ticker: string, timeframe: string, limit?: number, from?: number, to?: number): Promise<Kline[]> {
      if (ticker.split(':').at(-1) !== instrument.market.symbol || timeframe !== '1') throw new Error('Reference fixture only serves its explicit primary series');
      return FIXTURE_BARS.filter(bar => bar.time >= (from ?? FIXTURE_START) && bar.time < (to ?? FIXTURE_TO)).slice(-(limit ?? 6)).map(bar => ({ openTime: bar.time, closeTime: bar.time + 60000, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, quoteAssetVolume: NaN, numberOfTrades: NaN, takerBuyBaseAssetVolume: NaN, takerBuyQuoteAssetVolume: NaN, ignore: 0 }));
    },
    async getSymbolInfo(ticker: string): Promise<ISymbolInfo> {
      if (ticker.split(':').at(-1) !== instrument.market.symbol) throw new Error('Unknown reference fixture symbol');
      return {
        current_contract: '', description: instrument.name, isin: '', main_tickerid: ticker, prefix: instrument.market.provider.toUpperCase(), root: instrument.baseCurrency, ticker: instrument.market.symbol, tickerid: ticker, type: 'crypto', basecurrency: instrument.baseCurrency, country: '', currency: instrument.quoteCurrency, timezone: 'UTC', employees: NaN, industry: '', sector: '', shareholders: NaN, shares_outstanding_float: NaN, shares_outstanding_total: NaN, expiration_date: NaN, session: '24x7', volumetype: 'base', mincontract: Number(instrument.quantityStep), minmove: 1, mintick: Number(instrument.tickSize), pointvalue: 1, pricescale: 1 / Number(instrument.tickSize), recommendations_buy: NaN, recommendations_buy_strong: NaN, recommendations_date: NaN, recommendations_hold: NaN, recommendations_sell: NaN, recommendations_sell_strong: NaN, recommendations_total: NaN, target_price_average: NaN, target_price_date: NaN, target_price_estimates: NaN, target_price_high: NaN, target_price_low: NaN, target_price_median: NaN,
      };
    },
    configure() { throw new Error('Reference fixture has no configurable settings'); },
  };
}
