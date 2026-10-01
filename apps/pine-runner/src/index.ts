import { createInterface } from 'node:readline';
import { PineTS, Indicator } from 'pinets';

if (process.argv.includes('--health')) {
  console.log(JSON.stringify({ engine: 'PineTS', version: '0.10.0', isolated: true }));
  process.exit(0);
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try {
    if (Buffer.byteLength(line) > 20 * 1024 * 1024) throw new Error('Runner input exceeds 20 MiB');
    const job = JSON.parse(line);
    if (job.type !== 'run' || typeof job.source !== 'string' || !/^\s*\/\/@version=[56]\b/.test(job.source)) throw new Error('Only Pine v5/v6 run commands are supported');
    if (Buffer.byteLength(job.source) > 256 * 1024 || !Array.isArray(job.bars) || job.bars.length > 50000) throw new Error('Run budget exceeded');
    const bars = job.bars.map((bar: {time: number; open: number; high: number; low: number; close: number; volume: number}, i: number) => ({ ...bar, openTime: bar.time, closeTime: job.bars[i + 1]?.time ?? job.to }));
    const pine = new PineTS(bars, job.market?.symbol, job.timeframe, bars.length, job.from, job.to);
    const indicator = new Indicator(job.source);
    for (const [key, value] of Object.entries(job.inputs ?? {})) indicator.input[key] = value;
    for (const [key, value] of Object.entries(job.props ?? {})) indicator.prop[key] = value;
    const result = await pine.run(indicator);
    console.log(JSON.stringify({ type: 'result', jobId: job.jobId, plots: result.plots }, (_key, value) => typeof value === 'number' && !Number.isFinite(value) ? null : value));
  } catch (error) {
    console.log(JSON.stringify({ type: 'error', error: { code: 'PINE_DIAGNOSTIC', message: error instanceof Error ? error.message : 'Pine run failed' } }));
  }
}
