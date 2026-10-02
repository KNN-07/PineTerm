import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { compile, execute } from '../../apps/pine-runner/src/execution.js';
import { SnapshotProvider } from '../../apps/pine-runner/src/provider.js';
import { runDocker } from '../../apps/server/src/pine/DockerRunner.js';
import type { Instrument, PineRunRequest } from '../../packages/contracts/src/index.js';
import { FIXTURE_BARS, FIXTURE_START } from '../fixtures/market.js';
import { DUPLICATE_INPUT_SOURCE, FIXTURE_TO, ROUND_TRIP_SOURCE, SMA_SOURCE } from '../fixtures/pine.js';

const instrument: Instrument = { market: { provider: 'csv', symbol: '00000000-0000-4000-8000-000000000001' }, name: 'Trusted six-bar fixture', baseCurrency: 'BTC', quoteCurrency: 'USD', tickSize: '0.01', quantityStep: '1', timeframes: ['1', '5'] };
async function run(source: string, inputs: Record<string, number> = {}, props: Record<string, number | string> = {}) {
  const job: PineRunRequest = { type: 'run', jobId: randomUUID(), source, inputs, props, market: instrument.market, timeframe: '1', from: FIXTURE_START, to: FIXTURE_TO, bars: FIXTURE_BARS.map(bar => ({ ...bar })), symbolInfo: instrument };
  const prepared = compile(job);
  const provider = new SnapshotProvider(job, () => { throw new Error('This trusted primary-series test must not request secondary data'); });
  return execute(job, prepared.indicator, prepared.validation, provider, []);
}

describe('PineTS simulation financial boundaries', () => {
  it('exposes source-declared settings instead of hidden runtime defaults', () => {
    const strategy = compile({ type: 'validate', jobId: randomUUID(), source: ROUND_TRIP_SOURCE, inputs: {}, props: {} });
    expect(strategy.validation.props.find(prop => prop.name === 'initial_capital')?.defval).toBe(1000);
    expect(strategy.validation.props.find(prop => prop.name === 'commission_value')?.defval).toBe(1);
    const overlay = compile({ type: 'validate', jobId: randomUUID(), source: '//@version=6\nindicator("Placement",overlay=true)\nplot(close)', inputs: {}, props: {} });
    expect(overlay.validation.props.find(prop => prop.name === 'overlay')?.defval).toBe(true);
  });
  it.each([[0, 1000, '10', '14', 1002], [1, 1000, '10.01', '13.99', 1001.98], [1, 2000, '10.01', '13.99', 2001.98]] as const)('preserves fills/costs and explicit overrides at slippage %i capital %i', async (slippage, capital, entry, exit, equity) => {
    const result = await run(ROUND_TRIP_SOURCE, {}, { slippage, initial_capital: capital });
    expect(result.strategy?.tradeCount).toBe(1);
    expect(result.strategy?.fees).toBe('2');
    expect(result.strategy?.positionSize).toBe('0');
    expect(Number(result.strategy?.finalEquity)).toBeCloseTo(equity, 8);
    expect(result.resolvedConfig.initial_capital).toBe(capital);
    expect(result.trades[0]).toMatchObject({ entryPrice: entry, exitPrice: exit, entryBarIndex: 1, exitBarIndex: 4, quantity: '1', commission: '2', status: 'closed' });
    expect(result.equityCurve.map(point => point.time)).toEqual(FIXTURE_BARS.map(bar => bar.time));
    expect(result.strategy?.profitFactor).toBeNull();
  });
  it('overrides independent variable identities despite duplicate display titles', async () => {
    const defaultSma = await run(SMA_SOURCE);
    const changedSma = await run(SMA_SOURCE, { length: 3 });
    expect(defaultSma.plots.SMA.data[2].value).toBe(11);
    expect(Number(changedSma.plots.SMA.data[2].value)).toBeCloseTo(32 / 3, 8);
    expect((await run(DUPLICATE_INPUT_SOURCE, { fast: 4, slow: 7 })).plots.Sum.data[2].value).toBe(11);
    expect(() => compile({ type: 'validate', jobId: randomUUID(), source: DUPLICATE_INPUT_SOURCE, inputs: { Length: 4 }, props: {} })).toThrow();
  });
  it('rejects FX conversion instead of equating strategy currency to the market quote', async () => {
    await expect(run(ROUND_TRIP_SOURCE, {}, { currency: 'EUR' })).rejects.toMatchObject({ code: 'FX_CONVERSION_UNSUPPORTED' });
    await expect(run(ROUND_TRIP_SOURCE, {}, { currency: 'NONE' })).rejects.toMatchObject({ code: 'FX_CONVERSION_UNSUPPORTED' });
  });
  it('does not accept future completed secondary candles from its broker', async () => {
    const job: PineRunRequest = { type: 'run', jobId: randomUUID(), source: SMA_SOURCE, inputs: {}, props: {}, market: instrument.market, timeframe: '1', from: FIXTURE_START, to: FIXTURE_START + 240000, bars: FIXTURE_BARS.slice(0, 4), symbolInfo: instrument };
    let provider: SnapshotProvider;
    provider = new SnapshotProvider(job, request => provider.receive({ type: 'data_response', id: request.id, symbolInfo: instrument, bars: [{ time: FIXTURE_START, open: 10, high: 15, low: 9, close: 14, volume: 5 }] }));
    await expect(provider.getMarketData(instrument.market.symbol, '5')).rejects.toMatchObject({ code: 'INVALID_PROTOCOL' });
  });
  it('terminates an evaluating container before cancellation settles', async () => {
    const controller = new AbortController();
    const job: PineRunRequest = { type: 'run', jobId: randomUUID(), source: '//@version=6\nindicator("Cancellation boundary")\nplot(request.security(syminfo.tickerid,"5",close,lookahead=barmerge.lookahead_off))', inputs: {}, props: {}, market: instrument.market, timeframe: '1', from: FIXTURE_START, to: FIXTURE_TO, bars: FIXTURE_BARS, symbolInfo: instrument };
    const result = runDocker(job, async request => {
      controller.abort();
      return { type: 'data_response', id: request.id, error: { code: 'CANCELLED', message: 'Fixture cancels at the actual broker boundary' } };
    }, controller.signal);
    await expect(result).rejects.toMatchObject({ diagnostic: { code: 'CANCELLED' } });
    const remaining = spawnSync('docker', ['ps', '-q', '--filter', `label=pineterm.jobId=${job.jobId}`], { encoding: 'utf8', timeout: 10000 });
    expect(remaining.status).toBe(0);
    expect(remaining.stdout.trim()).toBe('');
  }, 20000);
});
