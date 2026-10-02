import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DriverReply, DriverRequest, ExternalFill } from '@pineterm/contracts';
import { riskDecimal, riskPositive } from '@pineterm/domain';

export class DriverError extends Error {
  constructor(readonly code: 'DRIVER_FAILED' | 'DRIVER_TIMEOUT' | 'DRIVER_OUTPUT' | 'DRIVER_ABORTED') { super(code); this.name = 'DriverError'; }
}
export function executable(path: string): string {
  if (!path || !isAbsolute(path)) throw new Error('An absolute operator-specified executable path is required; no default driver exists.');
  const resolved = realpathSync(path);
  if (!statSync(resolved).isFile()) throw new Error('The operator driver must be an executable file.');
  accessSync(resolved, constants.X_OK);
  return resolved;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DriverError('DRIVER_OUTPUT');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new DriverError('DRIVER_OUTPUT');
}
function text(value: unknown, maximum = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum; }
function time(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
export function driverReply(value: unknown): DriverReply {
  try {
    const row = object(value);
    keys(row, ['status', 'externalOrderId', 'fills', 'quote', 'reason', 'absenceConfirmed', 'environment', 'venue']);
    if (typeof row.status !== 'string' || !['not_submitted', 'acknowledged', 'partially_filled', 'filled', 'rejected', 'cancelled', 'expired', 'unknown'].includes(row.status) || !Array.isArray(row.fills) || row.fills.length > 1000) throw new DriverError('DRIVER_OUTPUT');
    if (row.externalOrderId !== undefined && !text(row.externalOrderId)) throw new DriverError('DRIVER_OUTPUT');
    if (row.reason !== undefined && !text(row.reason, 2048)) throw new DriverError('DRIVER_OUTPUT');
    if (row.absenceConfirmed !== undefined && typeof row.absenceConfirmed !== 'boolean') throw new DriverError('DRIVER_OUTPUT');
    if (row.environment !== undefined && (typeof row.environment !== 'string' || !['live', 'sandbox', 'testnet', 'recording'].includes(row.environment))) throw new DriverError('DRIVER_OUTPUT');
    if (row.venue !== undefined && !text(row.venue, 100)) throw new DriverError('DRIVER_OUTPUT');
    const ids = new Set<string>();
    const fills: ExternalFill[] = row.fills.map(value => {
      const fill = object(value); keys(fill, ['externalFillId', 'quantity', 'price', 'fee', 'currency', 'time']);
      if (!text(fill.externalFillId) || ids.has(fill.externalFillId) || !text(fill.currency, 32) || !time(fill.time)) throw new DriverError('DRIVER_OUTPUT');
      ids.add(fill.externalFillId);
      riskPositive(fill.quantity as string); riskPositive(fill.price as string); riskDecimal(fill.fee as string);
      return fill as unknown as ExternalFill;
    });
    if (row.quote !== undefined) {
      const quote = object(row.quote); keys(quote, ['market', 'price', 'observedAt']);
      const market = object(quote.market); keys(market, ['provider', 'symbol']);
      if (typeof market.provider !== 'string' || !['binance', 'coinbase'].includes(market.provider) || !text(market.symbol, 100) || !time(quote.observedAt)) throw new DriverError('DRIVER_OUTPUT');
      riskPositive(quote.price as string);
    }
    if (row.status === 'not_submitted' && fills.length) throw new DriverError('DRIVER_OUTPUT');
    if (row.status === 'partially_filled' && !fills.length) throw new DriverError('DRIVER_OUTPUT');
    return { ...row, fills } as unknown as DriverReply;
  } catch { throw new DriverError('DRIVER_OUTPUT'); }
}

/** Drivers must implement protected placement: market buys use maxExecutionPrice as a cap,
 * sells use minExecutionPrice as a floor, rounded conservatively to the venue tick.
 * A venue without protected market/IOC-limit semantics must be refused, never unbounded.
 * status is a clientOrderId lookup, not a new submission; not_submitted is authoritative
 * only when absenceConfirmed is true. stderr/stdout are never copied to application logs. */
export async function runDriver(path: string, args: string[], request: DriverRequest, timeoutMs: number, signal: AbortSignal): Promise<DriverReply> {
  if (signal.aborted) throw new DriverError('DRIVER_ABORTED');
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PINETERM_')));
  const { promise, resolve, reject } = Promise.withResolvers<DriverReply>();
  // A dedicated process group contains only this invocation and its descendants.
  const child = spawn(path, [...args, request.command], { shell: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: childEnv });
  const chunks: Buffer[] = []; let bytes = 0; let failure: DriverError | null = null;
  const termination = Promise.withResolvers<void>();
  let terminating = false;
  const terminateGroup = () => {
    if (terminating) return;
    terminating = true;
    if (!child.pid) { termination.resolve(); return; }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already gone. */ }
    setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already gone. */ }
      termination.resolve();
    }, 250);
  };
  const stop = (code: DriverError['code']) => {
    failure ??= new DriverError(code); terminateGroup();
  };
  const timer = setTimeout(() => stop('DRIVER_TIMEOUT'), timeoutMs);
  const abort = () => stop('DRIVER_ABORTED'); signal.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) stop('DRIVER_OUTPUT');
    else if (!failure) chunks.push(chunk);
  });
  child.stdin.on('error', () => stop('DRIVER_FAILED'));
  child.on('error', () => stop('DRIVER_FAILED'));
  child.on('close', code => {
    clearTimeout(timer); terminateGroup();
    void termination.promise.then(() => {
      signal.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new DriverError('DRIVER_FAILED')); return; }
      try { resolve(driverReply(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch { reject(new DriverError('DRIVER_OUTPUT')); }
    });
  });
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 1024 * 1024) stop('DRIVER_OUTPUT');
  else child.stdin.end(input + '\n');
  return promise;
}
