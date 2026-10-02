#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { FinanceClient } from '../../api-client/src/index.js';
import { ExecutorClient } from './index.js';

async function main() {
  if (process.argv.slice(2).some(arg => !['--once', '--sandbox'].includes(arg))) throw new Error('Usage: executor-client [--once] [--sandbox]; configure credentials through environment, never command-line flags.');
  const required = ['PINETERM_EXECUTOR_URL', 'PINETERM_EXECUTOR_TOKEN', 'PINETERM_EXECUTOR_ID', 'PINETERM_EXECUTOR_DRIVER', 'PINETERM_EXECUTOR_STATE'] as const;
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error('Missing executor configuration: ' + missing.join(', ') + '. No default broker/driver is provided.');
  let args: unknown = [];
  if (process.env.PINETERM_EXECUTOR_DRIVER_ARGS) {
    try { args = JSON.parse(process.env.PINETERM_EXECUTOR_DRIVER_ARGS); } catch { throw new Error('PINETERM_EXECUTOR_DRIVER_ARGS must be a JSON string array.'); }
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('PINETERM_EXECUTOR_DRIVER_ARGS must be a JSON string array.');
  const pollMs = Number(process.env.PINETERM_EXECUTOR_POLL_MS ?? '1000');
  const timeoutMs = Number(process.env.PINETERM_EXECUTOR_TIMEOUT_MS ?? '10000');
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 30000) throw new Error('PINETERM_EXECUTOR_POLL_MS must be 100–30000 ms.');
  const client = new ExecutorClient({
    api: new FinanceClient({ url: process.env.PINETERM_EXECUTOR_URL!, token: process.env.PINETERM_EXECUTOR_TOKEN! }),
    executorId: process.env.PINETERM_EXECUTOR_ID!, driver: process.env.PINETERM_EXECUTOR_DRIVER!, statePath: process.env.PINETERM_EXECUTOR_STATE!, driverArgs: args, timeoutMs,
    requireSandbox: process.argv.includes('--sandbox'),
    onEvent: event => { process.stdout.write(JSON.stringify(event) + '\n'); },
  });
  const stop = new AbortController();
  const shutdown = () => { stop.abort(); void client.close(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try {
    do {
      try { const result = await client.cycle(); process.stdout.write(JSON.stringify({ type: 'cycle', ...result }) + '\n'); }
      catch {
        if (!stop.signal.aborted) { process.stderr.write('Executor cycle failed; durable orders will be reconciled, never resubmitted.\n'); if (process.argv.includes('--once')) process.exitCode = 1; }
      }
      if (process.argv.includes('--once') || stop.signal.aborted) break;
      try { await delay(pollMs, undefined, { signal: stop.signal }); } catch { break; }
    } while (!stop.signal.aborted);
  } finally { process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown); await client.close(); }
}
// Configuration failures contain names only. Never log API/driver exception messages or URLs.
void main().catch(() => {
  process.stderr.write('Executor startup refused. Required: PINETERM_EXECUTOR_URL, PINETERM_EXECUTOR_TOKEN, PINETERM_EXECUTOR_ID, PINETERM_EXECUTOR_DRIVER (absolute executable), PINETERM_EXECUTOR_STATE (absolute SQLite file in a private directory). Optional DRIVER_ARGS (JSON string array), TIMEOUT_MS and POLL_MS use the same PINETERM_EXECUTOR_ prefix. No production driver is bundled.\n');
  process.exitCode = 1;
});
