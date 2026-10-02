import { PineWorkerEngine } from '@luxalgo/vela-pinets';
import type { ExecutionHandlers, ExecutionRequest, ExecutionSession } from '@luxalgo/vela/plugin';
import { PineTermProvider, parseMarket } from './PineTermProvider.js';

/** Public engine seam: browser previews use the same selected-venue binding as isolated runs. */
export class ProviderLockedPineWorkerEngine extends PineWorkerEngine {
  constructor(private readonly providers: readonly PineTermProvider[]) { super(); }

  override execute(request: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
    const market = parseMarket(request.market.symbol);
    const provider = this.providers.find(item => item.provider === market?.provider);
    if (!market || !provider) throw new Error('Pine preview requires an explicit supported chart venue');
    return super.execute({ ...request, fetchSeries: (symbol, timeframe, range) => {
      const qualified = parseMarket(symbol);
      if (symbol.includes(':') && (!qualified || qualified.provider !== market.provider)) throw new Error('Secondary Pine series cannot select a different venue');
      const ticker = qualified?.symbol ?? symbol;
      if (!ticker || ticker.includes(';')) throw new Error('Secondary Pine series requires a supported raw instrument');
      return provider.getBars(ticker, timeframe, range);
    } }, handlers);
  }
}
