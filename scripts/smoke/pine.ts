import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { BacktestJob, Dataset, PineExecutionResult, PineValidation, ScriptRecord, ScriptRevision } from '../../packages/contracts/src/index.js';
import { FIXTURE_BARS, FIXTURE_CSV, FIXTURE_START } from '../../tests/fixtures/market.js';
import { DUPLICATE_INPUT_SOURCE, FIXTURE_TO, ROUND_TRIP_SOURCE, SMA_SOURCE } from '../../tests/fixtures/pine.js';

async function settledJob(url: string, id: string, headers: Record<string, string>): Promise<BacktestJob> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 70000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await fetch(url + '/api/v1/events', { headers, signal: controller.signal });
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    const initial = await (await fetch(url + '/api/v1/backtests/' + id, { headers })).json() as { job: BacktestJob };
    if (['succeeded', 'failed', 'cancelled'].includes(initial.job.state)) return initial.job;
    let text = '';
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Job event stream ended before a terminal state');
      text += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = text.indexOf('\n\n')) !== -1) {
        const frame = text.slice(0, end); text = text.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (event.type !== 'jobs.changed' || event.resourceId !== id) continue;
        const { job } = await (await fetch(url + '/api/v1/backtests/' + id, { headers })).json() as { job: BacktestJob };
        if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
      }
    }
  } finally {
    clearTimeout(timeout); controller.abort(); await reader?.cancel().catch(() => {});
  }
}

export async function runPineScenario(url: string, headers: Record<string, string>, app: FastifyInstance): Promise<void> {
  const { 'Content-Type': _contentType, ...plainHeaders } = headers;
  const form = new FormData();
  for (const [key, value] of Object.entries({ name: 'Pine deterministic fixture', baseCurrency: 'BTC', quoteCurrency: 'USD', timeframe: '1', tickSize: '0.01', quantityStep: '1' })) form.set(key, value);
  form.set('file', new Blob([FIXTURE_CSV]), 'pine-fixture.csv');
  const imported = await fetch(url + '/api/v1/datasets', { method: 'POST', headers: plainHeaders, body: form });
  assert.equal(imported.status, 201, await imported.clone().text());
  const { dataset } = await imported.json() as { dataset: Dataset };
  const market = { provider: 'csv' as const, symbol: dataset.id };
  const instrument = await app.services.market.getInstrument(market);

  const validate = await fetch(url + '/api/v1/scripts/validate', { method: 'POST', headers, body: JSON.stringify({ source: '// Original fixture comment\n' + SMA_SOURCE }) });
  assert.equal(validate.status, 200, await validate.clone().text());
  const metadata = await validate.json() as PineValidation;
  assert.equal(metadata.valid, true, JSON.stringify(metadata.diagnostics));
  assert.equal(metadata.inputs[0].varId, 'length');
  assert.ok(metadata.warnings?.some(warning => warning.method === 'provider_policy'));
  const run = async (source: string, inputs: Record<string, number>, to = FIXTURE_TO): Promise<PineExecutionResult> => app.services.pine.runSnapshot({ type: 'run', jobId: randomUUID(), source, inputs, props: {}, market, timeframe: '1', from: FIXTURE_START, to, bars: FIXTURE_BARS.filter(bar => bar.time + 60000 <= to), symbolInfo: instrument });
  const smaDefault = await run(SMA_SOURCE, {});
  const smaChanged = await run(SMA_SOURCE, { length: 3 });
  assert.equal(smaDefault.plots.SMA.data[2].value, 11);
  assert.ok(Math.abs(Number(smaChanged.plots.SMA.data[2].value) - 32 / 3) < 1e-8);
  const distinct = await run(DUPLICATE_INPUT_SOURCE, { fast: 4, slow: 7 });
  assert.equal(distinct.plots.Sum.data[2].value, 11);
  const ambiguous = await fetch(url + '/api/v1/scripts/validate', { method: 'POST', headers, body: JSON.stringify({ source: DUPLICATE_INPUT_SOURCE, inputs: { Length: 8 } }) });
  const ambiguousMetadata = await ambiguous.json() as PineValidation;
  assert.equal(ambiguousMetadata.valid, false);
  assert.equal(ambiguousMetadata.diagnostics[0].code, 'INVALID_INPUT');
  const bad = await fetch(url + '/api/v1/scripts/validate', { method: 'POST', headers, body: JSON.stringify({ source: '//@version=6\nindicator("Broken")\nplot(' }) });
  assert.equal(bad.status, 200);
  assert.equal((await bad.json() as PineValidation).valid, false);

  const created = await fetch(url + '/api/v1/scripts', { method: 'POST', headers, body: JSON.stringify({ name: 'Immutable deterministic strategy', source: ROUND_TRIP_SOURCE, inputs: {}, props: {} }) });
  assert.equal(created.status, 201, await created.clone().text());
  const saved = await created.json() as { script: ScriptRecord; revision: ScriptRevision };
  let firstJob: BacktestJob | undefined;
  for (const [slippage, initialCapital, expectedEquity] of [[0, 1000, 1002], [1, 1000, 1001.98], [1, 2000, 2001.98]]) {
    const body = { scriptRevisionId: saved.revision.id, market, timeframe: '1', from: FIXTURE_START, to: FIXTURE_TO, inputs: {}, props: { slippage, initial_capital: initialCapital } };
    const submitted = await fetch(url + '/api/v1/backtests', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(submitted.status, 202, await submitted.clone().text());
    const { jobId } = await submitted.json() as { jobId: string };
    const job = await settledJob(url, jobId, headers);
    assert.equal(job.state, 'succeeded', JSON.stringify(job.diagnostic));
    const result = job.result!;
    assert.equal(result.strategy?.tradeCount, 1);
    assert.equal(result.strategy?.fees, '2');
    assert.equal(result.strategy?.positionSize, '0');
    assert.ok(Math.abs(Number(result.strategy?.finalEquity) - expectedEquity) < 1e-8);
    assert.deepEqual(result.equityCurve.map(point => point.time), FIXTURE_BARS.map(bar => bar.time));
    const trade = result.trades[0];
    assert.equal(trade.entryBarIndex, 1); assert.equal(trade.exitBarIndex, 4);
    assert.equal(trade.entryPrice, slippage ? '10.01' : '10');
    assert.equal(trade.exitPrice, slippage ? '13.99' : '14');
    const reference = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/smoke/reference-pine.ts'], { cwd: process.cwd(), env: { PATH: process.env.PATH }, input: JSON.stringify({ instrument, slippage, initialCapital }), encoding: 'utf8', timeout: 15000 });
    assert.equal(reference.status, 0, reference.stderr);
    const complete = JSON.parse(reference.stdout);
    assert.ok(Math.abs(complete.equity - Number(result.strategy?.finalEquity)) < 1e-8);
    assert.deepEqual(complete.trades, result.trades.map(item => ({ entryPrice: Number(item.entryPrice), exitPrice: Number(item.exitPrice), entryBarIndex: item.entryBarIndex, exitBarIndex: item.exitBarIndex, commission: Number(item.commission) })));
    assert.equal(job.provenance?.sourceHash, saved.revision.sourceHash);
    assert.equal(job.provenance?.secondaryVenuePolicy, 'run-provider-only');
    console.log('pine: real Docker + HTTP strategy result', JSON.stringify({ slippage, initialCapital, finalEquity: result.strategy?.finalEquity, fees: result.strategy?.fees, entry: trade.entryPrice, exit: trade.exitPrice, closedTrades: result.strategy?.tradeCount, unpaginatedEquivalent: true }));
    firstJob ??= job;
  }

  const mtfSource = `//@version=6\nindicator("Provider-locked MTF fixture")\nvenue=input.string("COINBASE", "Computed prefix")\nsymbol=venue+":"+syminfo.ticker\nplot(request.security(symbol,"5",close,lookahead=barmerge.lookahead_off),"MTF")\n`;
  const before = await run(mtfSource, {}, FIXTURE_START + 240000);
  assert.equal(before.plots.MTF.data.at(-1)?.value, null);
  const closed = await run(mtfSource, {}, FIXTURE_START + 300000);
  assert.equal(closed.plots.MTF.data.at(-1)?.value, 14);
  assert.ok(closed.warnings.some(warning => warning.method === 'provider_policy'));
  console.log('pine: SMA 11 → 32/3, duplicate-title IDs independent, invalid source diagnosed; provider-locked MTF null at cursor 00:04 → 14 at 00:05');

  const renamed = await fetch(url + '/api/v1/scripts/' + saved.script.id, { method: 'PUT', headers, body: JSON.stringify({ name: 'Renamed strategy', revision: saved.script.revision, source: ROUND_TRIP_SOURCE.replace('strategy.long, 1)', 'strategy.long, 2)'), inputs: {}, props: {} }) });
  assert.equal(renamed.status, 200);
  assert.equal((await fetch(url + '/api/v1/scripts/' + saved.script.id, { method: 'DELETE', headers: plainHeaders })).status, 204);
  const retained = await (await fetch(url + '/api/v1/backtests/' + firstJob!.id, { headers })).json() as { job: BacktestJob };
  assert.equal(retained.job.result?.trades[0].quantity, '1');
  assert.equal(retained.job.provenance?.sourceHash, saved.revision.sourceHash);
  console.log('pine: successful immutable result retained original quantity/source provenance after script revision and archival');

  const busySource = '//@version=6\nstrategy("Bounded execution fixture", currency=currency.USD)\nfloat work = 0\nfor i = 0 to 499998\n    for j = 0 to 499998\n        work += 1\nplot(work)\n';
  const busyCreated = await fetch(url + '/api/v1/scripts', { method: 'POST', headers, body: JSON.stringify({ name: 'Cancellation / timeout fixture', source: busySource, inputs: {}, props: {} }) });
  assert.equal(busyCreated.status, 201);
  const busyRevision = (await busyCreated.json() as { revision: ScriptRevision }).revision;
  const pending = await fetch(url + '/api/v1/backtests', { method: 'POST', headers, body: JSON.stringify({ scriptRevisionId: busyRevision.id, market, timeframe: '1', from: FIXTURE_START, to: FIXTURE_TO, inputs: {}, props: {} }) });
  assert.equal(pending.status, 202, await pending.clone().text());
  const cancelledId = (await pending.json() as { jobId: string }).jobId;
  const cancelled = await fetch(url + '/api/v1/backtests/' + cancelledId + '/cancel', { method: 'POST', headers: plainHeaders });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json() as { job: BacktestJob }).job.state, 'cancelled');

  const boundedId = randomUUID();
  const bounded = app.services.pine.runSnapshot({ type: 'run', jobId: boundedId, source: busySource, inputs: {}, props: {}, market, timeframe: '1', from: FIXTURE_START, to: FIXTURE_TO, bars: FIXTURE_BARS, symbolInfo: instrument }).then(() => { throw new Error('Unbounded loop unexpectedly completed'); }, error => error);
  assert.equal((await fetch(url + '/api/v1/providers', { headers, signal: AbortSignal.timeout(5000) })).status, 200);
  const boundedError = await bounded;
  assert.ok(['EXECUTION_TIMEOUT', 'PINE_DIAGNOSTIC'].includes(boundedError.diagnostic?.code), boundedError.message);
  const remaining = spawnSync('docker', ['ps', '-q', '--filter', `label=pineterm.jobId=${boundedId}`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(remaining.status, 0, remaining.stderr);
  assert.equal(remaining.stdout.trim(), '');
  console.log('pine: cancelled job persisted cancelled; API remained responsive during bounded loop; observed', boundedError.diagnostic.code, 'with no evaluating container');
}
