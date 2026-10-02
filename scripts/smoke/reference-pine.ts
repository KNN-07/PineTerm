import { Indicator, PineTS } from 'pinets';
import type { Instrument } from '../../packages/contracts/src/market.js';
import { FIXTURE_START } from '../../tests/fixtures/market.js';
import { FIXTURE_TO, ROUND_TRIP_SOURCE, referenceProvider } from '../../tests/fixtures/pine.js';

const chunks: Buffer[] = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 32 * 1024) throw new Error('Reference fixture command exceeds its budget');
  chunks.push(chunk);
}
const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { instrument: Instrument; slippage: number; initialCapital: number };
if (![0, 1].includes(request.slippage) || ![1000, 2000].includes(request.initialCapital)) throw new Error('Only the trusted deterministic acceptance cases can run in this comparison process');
const pine = new PineTS(referenceProvider(request.instrument), `CSV:${request.instrument.market.symbol}`, '1', 6, FIXTURE_START, FIXTURE_TO);
const indicator = new Indicator(ROUND_TRIP_SOURCE);
indicator.prop.slippage = request.slippage;
indicator.prop.initial_capital = request.initialCapital;
const context = await pine.run(indicator);
if (!context.strategy) throw new Error('Trusted strategy returned no simulation state');
console.log(JSON.stringify({ equity: context.strategy.equity, positionSize: context.strategy.position_size, trades: context.strategy.closedtrades.map((trade: { entry_price: number; exit_price?: number; entry_bar_index: number; exit_bar_index?: number; commission?: number }) => ({ entryPrice: trade.entry_price, exitPrice: trade.exit_price, entryBarIndex: trade.entry_bar_index, exitBarIndex: trade.exit_bar_index, commission: trade.commission })) }));
