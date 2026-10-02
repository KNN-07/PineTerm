import { PineWorkerEngine } from '@luxalgo/vela-pinets';
import { barClose } from '@luxalgo/vela/workspace';
import type { ExecutionHandlers, ExecutionRequest, ExecutionSession } from '@luxalgo/vela/plugin';
import { PineTermProvider, parseMarket } from './PineTermProvider.js';

/** Public engine seam: browser previews use the same selected-venue binding as isolated runs. */
export class ProviderLockedPineWorkerEngine extends PineWorkerEngine {
  constructor(private readonly providers: readonly PineTermProvider[]) { super(); }

  override execute(request: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
    const market = parseMarket(request.market.symbol);
    const provider = this.providers.find(item => item.provider === market?.provider);
    if (!market || !provider) throw new Error('Pine preview requires an explicit supported chart venue');
    const clippedBars = () => {
      const bars = request.getBars?.() ?? request.bars;
      return provider.replay ? bars.filter(bar => barClose(bar.time, request.market.timeframe) <= provider.replay!.cursor) : bars;
    };
    return super.execute({ ...request, bars: clippedBars(), getBars: clippedBars, mode: provider.replay ? 'static' : request.mode, fetchSeries: async (symbol, timeframe, range) => {
      const qualified = parseMarket(symbol);
      if (symbol.includes(':') && (!qualified || qualified.provider !== market.provider)) throw new Error('Secondary Pine series cannot select a different venue');
      const ticker = qualified?.symbol ?? symbol;
      if (!ticker || ticker.includes(';')) throw new Error('Secondary Pine series requires a supported raw instrument');
      const replay = provider.replay;
      const bars = await provider.getBars(ticker, timeframe, range);
      return replay ? bars.filter(bar => barClose(bar.time, timeframe) <= Math.min(range.to ?? replay.cursor, replay.cursor)) : bars;
    } }, { ...handlers, onAlert: alert => { if (!provider.replay) handlers.onAlert?.(alert); } });
  }
}
