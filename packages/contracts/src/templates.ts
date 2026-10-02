export interface PineTemplate { id: string; name: string; kind: 'indicator' | 'strategy'; overlay: boolean; source: string }

export const PINE_TEMPLATES: readonly PineTemplate[] = [
  { id: 'sma', name: 'PineTerm SMA', kind: 'indicator', overlay: true, source: `//@version=6
indicator("PineTerm SMA", overlay=true)
length = input.int(20, "Length", minval=1)
plot(ta.sma(close, length), "SMA", color=color.teal, linewidth=2)
` },
  { id: 'ema', name: 'PineTerm EMA', kind: 'indicator', overlay: true, source: `//@version=6
indicator("PineTerm EMA", overlay=true)
length = input.int(20, "Length", minval=1)
plot(ta.ema(close, length), "EMA", color=color.orange, linewidth=2)
` },
  { id: 'rsi', name: 'PineTerm RSI', kind: 'indicator', overlay: false, source: `//@version=6
indicator("PineTerm RSI", overlay=false)
length = input.int(14, "Length", minval=1)
plot(ta.rsi(close, length), "RSI", color=color.teal)
hline(70, "Upper", color=color.gray)
hline(30, "Lower", color=color.gray)
` },
  { id: 'macd', name: 'PineTerm MACD', kind: 'indicator', overlay: false, source: `//@version=6
indicator("PineTerm MACD", overlay=false)
fastLength = input.int(12, "Fast length", minval=1)
slowLength = input.int(26, "Slow length", minval=1)
signalLength = input.int(9, "Signal length", minval=1)
[macdLine, signalLine, histogram] = ta.macd(close, fastLength, slowLength, signalLength)
plot(histogram, "Histogram", style=plot.style_histogram, color=color.teal)
plot(macdLine, "MACD", color=color.teal)
plot(signalLine, "Signal", color=color.orange)
` },
  { id: 'bollinger', name: 'PineTerm Bollinger Bands', kind: 'indicator', overlay: true, source: `//@version=6
indicator("PineTerm Bollinger Bands", overlay=true)
length = input.int(20, "Length", minval=1)
multiplier = input.float(2.0, "Deviation", minval=0.1, step=0.1)
basis = ta.sma(close, length)
deviation = multiplier * ta.stdev(close, length)
plot(basis, "Basis", color=color.orange)
upper = plot(basis + deviation, "Upper", color=color.teal)
lower = plot(basis - deviation, "Lower", color=color.teal)
fill(upper, lower, color=color.new(color.teal, 90))
` },
  { id: 'volume', name: 'PineTerm Volume', kind: 'indicator', overlay: false, source: `//@version=6
indicator("PineTerm Volume", overlay=false, format=format.volume)
length = input.int(20, "Average length", minval=1)
plot(volume, "Volume", style=plot.style_columns, color=close >= open ? color.teal : color.red)
plot(ta.sma(volume, length), "Average", color=color.orange)
` },
  { id: 'ema-cross', name: 'PineTerm EMA crossover', kind: 'strategy', overlay: true, source: `//@version=6
strategy("PineTerm EMA crossover", overlay=true, initial_capital=10000, currency="USD", default_qty_type=strategy.fixed, default_qty_value=1, commission_type=strategy.commission.percent, commission_value=0.1, slippage=0, process_orders_on_close=false)
fastLength = input.int(9, "Fast length", minval=1)
slowLength = input.int(21, "Slow length", minval=1)
fast = ta.ema(close, fastLength)
slow = ta.ema(close, slowLength)
plot(fast, "Fast EMA", color=color.teal)
plot(slow, "Slow EMA", color=color.orange)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")
` },
];

/** Currency is fixed only when making a NEW template; imported/saved source is never rewritten. */
export function createPineTemplate(id: string, quoteCurrency: string): PineTemplate {
  const template = PINE_TEMPLATES.find((entry) => entry.id === id);
  if (!template) throw new Error('Unknown PineTerm template.');
  if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(quoteCurrency)) throw new Error('Select an instrument with valid quote currency metadata.');
  return { ...template, source: template.kind === 'strategy' ? template.source.replace('currency="USD"', `currency="${quoteCurrency}"`) : template.source };
}
