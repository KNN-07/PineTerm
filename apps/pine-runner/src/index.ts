import { format } from 'node:util';
import type { PineDataResponse, PineRunRequest, PineValidateRequest } from '../../../packages/contracts/src/pine.js';
import { compile, diagnostic, execute } from './execution.js';
import { RunnerError, SnapshotProvider } from './provider.js';

const MAX_BYTES = 20 * 1024 * 1024;
const protocolWrite = process.stdout.write.bind(process.stdout);
let outputBytes = 0;
function send(message: unknown, terminal = false): void {
  const frame = JSON.stringify(message, (_key, value) => typeof value === 'number' && !Number.isFinite(value) ? null : value) + '\n';
  outputBytes += Buffer.byteLength(frame);
  if (outputBytes > MAX_BYTES) throw new RunnerError('OUTPUT_BUDGET_EXCEEDED', 'Runner protocol output exceeds 20 MiB.');
  if (terminal) protocolWrite(frame, () => process.exit(0));
  else protocolWrite(frame);
}

if (process.argv.includes('--health')) {
  send({ engine: 'PineTS', version: '0.10.0', isolated: true }, true);
} else {
  const logs: string[] = [];
  let logBytes = 0;
  const capture = (...values: unknown[]) => {
    const text = format(...values).slice(0, 4096);
    logBytes += Buffer.byteLength(text);
    if (logBytes > 256 * 1024) throw new RunnerError('LOG_BUDGET_EXCEEDED', 'Pine log output exceeds 256 KiB.');
    logs.push(text);
  };
  console.log = capture; console.info = capture; console.debug = capture; console.warn = capture; console.error = capture;
  // Reserve stdout for NDJSON even if an upstream logger writes directly rather than through console.
  process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    capture(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (typeof done === 'function') done();
    return true;
  }) as typeof process.stdout.write;
  let jobId = '';
  let started = false;
  let finished = false;
  let provider: SnapshotProvider | undefined;
  let buffered: Buffer = Buffer.alloc(0);
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    try { send({ type: 'error', jobId, error: diagnostic(error) }, true); }
    catch { protocolWrite(JSON.stringify({ type: 'error', jobId, error: { code: 'OUTPUT_BUDGET_EXCEEDED', message: 'Runner output budget exceeded.' } }) + '\n', () => process.exit(1)); }
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  process.stdin.on('data', (chunk: Buffer) => {
    if (finished) return;
    if (buffered.length + chunk.length > MAX_BYTES) { fail(new RunnerError('INPUT_BUDGET_EXCEEDED', 'Runner input frame exceeds 20 MiB.')); return; }
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    let end: number;
    while ((end = buffered.indexOf(10)) !== -1) {
      const line = buffered.subarray(0, end).toString('utf8');
      buffered = buffered.subarray(end + 1);
      try {
        const message = JSON.parse(line) as PineRunRequest | PineValidateRequest | PineDataResponse;
        if (message.type === 'data_response') {
          if (!provider || !started) throw new RunnerError('INVALID_PROTOCOL', 'Data response without a running job.');
          provider.receive(message);
          continue;
        }
        if (started || !['run', 'validate'].includes(message.type) || typeof message.jobId !== 'string' || !message.inputs || !message.props) throw new RunnerError('INVALID_PROTOCOL', 'One run or validate command is required.');
        started = true;
        jobId = message.jobId;
        const { indicator, validation } = compile(message);
        send({ type: 'compiled', jobId, validation }, message.type === 'validate');
        if (message.type === 'validate') { finished = true; continue; }
        provider = new SnapshotProvider(message, send);
        void execute(message, indicator, validation, provider, logs).then((result) => {
          if (finished) return;
          send({ type: 'result', jobId, result }, true);
          finished = true;
        }).catch(fail);
      } catch (error) { fail(error); break; }
    }
  });
  process.stdin.on('end', () => { if (!started || buffered.length) fail(new RunnerError('INVALID_PROTOCOL', 'Runner input ended without a complete command.')); });
}
