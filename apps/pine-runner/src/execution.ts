import { Decimal } from 'decimal.js';
import { Indicator, PineTS, type Context } from 'pinets';
import type { PineExecutionResult, PineRunRequest, PineValidateRequest, PineValidation, PineDiagnostic, StrategyTrade, EquityPoint } from '../../../packages/contracts/src/pine.js';
import { PINE_TS_PROVIDER_POLICY, pineSourceVersion } from '../../../packages/contracts/src/pine.js';
import { closeTime, RunnerError, SnapshotProvider } from './provider.js';

export function diagnostic(error: unknown): PineDiagnostic {
  const detail = error as { code?: string; message?: string; line?: number; column?: number; lineNumber?: number };
  return { code: error instanceof RunnerError ? error.code : 'PINE_DIAGNOSTIC', message: String(detail?.message ?? 'Pine compilation or execution failed.').slice(0, 4096),
    ...(Number.isInteger(detail?.line ?? detail?.lineNumber) ? { line: detail.line ?? detail.lineNumber } : {}),
    ...(Number.isInteger(detail?.column) ? { column: detail.column } : {}) };
}

export function compile(job: PineValidateRequest | PineRunRequest): { indicator: Indicator; validation: PineValidation } {
  if (typeof job.source !== 'string' || pineSourceVersion(job.source) === null || Buffer.byteLength(job.source) > 256 * 1024) throw new RunnerError('UNSUPPORTED_SOURCE', 'Provide at most 256 KiB of Pine v5/v6 source text.');
  const indicator = new Indicator(job.source);
  indicator.prepare();
  const declarationType = indicator.getDeclarationType();
  if (!declarationType) throw new RunnerError('UNSUPPORTED_DECLARATION', 'A Pine indicator() or strategy() declaration is required.');
  const inputs: PineValidation['inputs'] = indicator.getInputsMeta();
  const props: PineValidation['props'] = indicator.getPropsMeta().map((meta: PineValidation['props'][number]) => {
    const declared = indicator.prop[meta.name];
    return { ...meta, defval: declared === undefined ? meta.defval ?? null : declared };
  });
  const overridden = new Set<string>();
  for (const [key, value] of Object.entries(job.inputs)) {
    const meta = inputs.find((input) => input.id === key || input.varId === key);
    if (!meta) throw new RunnerError('INVALID_INPUT', `Unknown input declaration id or variable: ${key}`);
    if (overridden.has(meta.id)) throw new RunnerError('INVALID_INPUT', `Input ${meta.id} was overridden more than once.`);
    overridden.add(meta.id);
    // Using the declaration ID also avoids a display title colliding with another variable name.
    indicator.input[meta.id] = value;
  }
  for (const [key, value] of Object.entries(job.props)) {
    if (!props.some((prop) => prop.name === key && prop.mutable)) throw new RunnerError('INVALID_PROP', `Unknown or immutable declaration property: ${key}`);
    indicator.prop[key] = value;
  }
  return { indicator, validation: { valid: true, declarationType, inputs, props, diagnostics: [], warnings: [{ message: PINE_TS_PROVIDER_POLICY, method: 'provider_policy' }] } };
}

function money(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Decimal(value).toFixed() : null;
}

function tradeResult(trade: NonNullable<Context['strategy']>['closedtrades'][number]): StrategyTrade {
  const quantity = money(Math.abs(trade.size));
  const entryPrice = money(trade.entry_price);
  if (quantity === null || entryPrice === null || !Number.isSafeInteger(trade.entry_time) || !Number.isInteger(trade.entry_bar_index)) throw new RunnerError('INVALID_STRATEGY_RESULT', 'The runtime returned invalid trade quantity, price or timestamp.');
  return { id: trade.id, entryId: trade.entry_id, exitId: trade.exit_id ?? null, side: trade.size < 0 ? 'short' : 'long', quantity,
    entryPrice, exitPrice: money(trade.exit_price), entryTime: trade.entry_time, exitTime: trade.exit_time ?? null,
    entryBarIndex: trade.entry_bar_index, exitBarIndex: trade.exit_bar_index ?? null, profit: money(trade.profit), commission: money(trade.commission), status: trade.status };
}

export async function execute(job: PineRunRequest, indicator: Indicator, validation: PineValidation, provider: SnapshotProvider, logs: string[]): Promise<PineExecutionResult> {
  if (!Array.isArray(job.bars) || !job.bars.length || job.bars.length > 50_000 || job.from >= job.to) throw new RunnerError('INVALID_SNAPSHOT', 'A bounded non-empty primary snapshot is required.');
  let previous = -1;
  for (const bar of job.bars) {
    if (!Number.isSafeInteger(bar.time) || bar.time < job.from || closeTime(bar.time, job.timeframe) > job.to || bar.time <= previous || ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) throw new RunnerError('INVALID_SNAPSHOT', 'Primary bars must be finite, unique, ascending and closed by the permitted cursor.');
    previous = bar.time;
  }
  for (const input of validation.inputs.filter((meta) => meta.type === 'symbol')) {
    const value = indicator.input[input.id];
    const venue = typeof value === 'string' ? /^([^:]+):/.exec(value)?.[1] : undefined;
    if (venue && venue.toLowerCase() !== job.market.provider) throw new RunnerError('CROSS_PROVIDER_REQUEST', 'Symbol inputs must use the selected provider.');
  }
  if (validation.declarationType === 'strategy') {
    const currency = indicator.prop.currency;
    if (currency !== job.symbolInfo.quoteCurrency) throw new RunnerError('FX_CONVERSION_UNSUPPORTED', `Strategy currency ${String(currency)} does not match instrument quote currency ${job.symbolInfo.quoteCurrency}. PineTS 0.10.0 does not resolve currency.NONE to the quote currency.`);
    if (indicator.prop.calc_bars_count !== 0) throw new RunnerError('PARTIAL_HISTORY_UNSUPPORTED', 'Backtests require calc_bars_count=0 so the full submitted interval is evaluated.');
  }
  const pine = new PineTS(provider, `${job.market.provider.toUpperCase()}:${job.market.symbol}`, job.timeframe, job.bars.length, job.from, job.to);
  pine.setAlertMode(job.alertMode ?? 'all');
  const equityCurve: EquityPoint[] = [];
  let context: Context | undefined;
  let index = 0;
  // Explicit eDate above disables live polling. Strategy state lives on the public fullContext, not page.strategy.
  for await (const page of pine.run(indicator, undefined, 1)) {
    context = page.fullContext;
    if (!context || index >= job.bars.length) throw new RunnerError('INVALID_ENGINE_PAGE', 'Runtime pagination did not match the frozen primary bars.');
    const state = context.strategy;
    if (state) equityCurve.push({ time: job.bars[index].time, equity: money(state.equity), drawdown: money(state.equity_peak - state.equity) });
    index++;
  }
  if (!context || index !== job.bars.length) throw new RunnerError('PARTIAL_EXECUTION', 'The runtime did not evaluate the complete submitted interval.');
  const state = context.strategy;
  if (validation.declarationType === 'strategy' && !state) throw new RunnerError('INVALID_STRATEGY_RESULT', 'Strategy execution did not return a strategy state.');
  if (state && state.account_currency !== job.symbolInfo.quoteCurrency) throw new RunnerError('FX_CONVERSION_UNSUPPORTED', 'Resolved strategy currency requires unsupported FX conversion.');
  const trades = state ? [...state.closedtrades, ...state.opentrades].map(tradeResult) : [];
  const feeValues = trades.map((trade) => trade.commission);
  const fees = feeValues.some((value) => value === null) ? null : feeValues.reduce<Decimal>((total, fee) => total.plus(fee!), new Decimal(0)).toFixed();
  const warnings: PineExecutionResult['warnings'] = [...(validation.warnings ?? []), ...context.warnings];
  if (/\bbarmerge\s*\.\s*lookahead_on\b/.test(job.source)) warnings.push({ message: 'This script uses lookahead_on. Historical values may repaint or include information unavailable at that bar; no no-repaint guarantee is made.' });
  if (state) warnings.push({ message: 'PineTS simulation: OCA sibling cancellation/reduction is not enforced; liquidation is approximate; FX conversion is unsupported; results can differ from TradingView.' });
  const initial = state ? money(state.initial_capital) : null;
  const final = state ? money(state.equity) : null;
  const loss = state ? Math.abs(state.grossloss) : 0;
  return { ...validation, engineVersion: '0.10.0',
    strategy: state ? { currency: state.account_currency, initialEquity: initial, finalEquity: final,
      netPnl: initial !== null && final !== null ? new Decimal(final).minus(initial).toFixed() : null, fees,
      maxDrawdown: money(state.max_drawdown), winRate: state.closedtrades.length ? state.wintrades / state.closedtrades.length * 100 : null,
      tradeCount: state.closedtrades.length, profitFactor: loss > 0 && Number.isFinite(state.grossprofit / loss) ? state.grossprofit / loss : null,
      positionSize: money(state.position_size) ?? (() => { throw new RunnerError('INVALID_STRATEGY_RESULT', 'Runtime position size is not finite.'); })() } : null,
    resolvedConfig: state ? { ...state.config, initial_capital: state.initial_capital, currency: state.account_currency } : { ...context.indicator },
    equityCurve, trades, plots: context.plots, alerts: context.alerts, warnings, logs };
}
