import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PineDataRequest, PineDataResponse, PineDiagnostic, PineExecutionResult, PineRunRequest, PineValidateRequest, PineValidation } from '../../../../packages/contracts/src/pine.js';
import { ApiError } from '../errors.js';

const MAX_BYTES = 20 * 1024 * 1024;
export const RUNNER_IMAGE = 'pineterm-pine-runner:local';
const isolation = ['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--user', '1000:1000'];
export class PineRunnerError extends Error {
  constructor(readonly diagnostic: PineDiagnostic) { super(diagnostic.message); }
}
export interface RunnerOutcome { validation: PineValidation; result: PineExecutionResult | null }
export type DataBroker = (request: PineDataRequest) => Promise<PineDataResponse>;

async function removeContainer(name: string): Promise<void> {
  const cleanup = spawn('docker', ['rm', '-f', name], { stdio: ['ignore', 'ignore', 'pipe'] });
  const deferred = Promise.withResolvers<void>();
  let stderr = '';
  const timer = setTimeout(() => {
    cleanup.kill('SIGKILL');
    deferred.reject(new ApiError(503, 'RUNNER_CLEANUP_FAILED', 'Runner termination could not be confirmed. Check the Docker daemon before submitting more Pine work.'));
  }, 10000);
  cleanup.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
  cleanup.on('error', () => {
    clearTimeout(timer);
    deferred.reject(new ApiError(503, 'RUNNER_CLEANUP_FAILED', 'Docker is unavailable while terminating the runner.'));
  });
  cleanup.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0 || /No such (?:container|object)/i.test(stderr)) { deferred.resolve(); return; }
    // Docker's --rm can already own removal. Confirm process termination, not a second rm acknowledgement.
    const inspect = spawn('docker', ['inspect', '--format', '{{.State.Running}}', name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let state = ''; let error = '';
    const deadline = setTimeout(() => { inspect.kill('SIGKILL'); deferred.reject(new ApiError(503, 'RUNNER_CLEANUP_FAILED', 'Runner termination confirmation timed out.')); }, 5000);
    inspect.stdout.on('data', (chunk: Buffer) => { state = (state + chunk.toString('utf8')).slice(-4096); });
    inspect.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString('utf8')).slice(-4096); });
    inspect.on('error', () => { clearTimeout(deadline); deferred.reject(new ApiError(503, 'RUNNER_CLEANUP_FAILED', 'Runner termination could not be inspected.')); });
    inspect.on('close', (status) => {
      clearTimeout(deadline);
      if ((status === 0 && state.trim() === 'false') || /No such (?:container|object)/i.test(error)) deferred.resolve();
      else deferred.reject(new ApiError(503, 'RUNNER_CLEANUP_FAILED', 'The runner may still be evaluating. Check Docker before submitting more Pine work.'));
    });
  });
  await deferred.promise;
}

/** Docker availability is environmental, never an invalid-source response or privileged fallback. */
export async function runnerAvailable(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new PineRunnerError({ code: 'CANCELLED', message: 'Pine execution was cancelled.' });
  const name = `pineterm-health-${randomUUID()}`;
  const process = spawn('docker', ['run', '--rm', '--name', name, ...isolation, RUNNER_IMAGE, '--health'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const deferred = Promise.withResolvers<void>();
  let output = '';
  let failure: Error | undefined;
  let cleanup: Promise<Error | undefined> | undefined;
  const remove = () => cleanup ??= removeContainer(name).then(() => undefined, error => error as Error);
  const cancel = () => { failure = new PineRunnerError({ code: 'CANCELLED', message: 'Pine execution was cancelled.' }); void remove(); process.kill('SIGKILL'); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    process.kill('SIGKILL');
    failure = new ApiError(503, 'RUNNER_UNAVAILABLE', 'Docker or the Pine runner image is unavailable. Run npm run runner:build and verify the Docker daemon.');
    void remove();
  }, 10_000);
  process.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 4096) process.kill('SIGKILL'); });
  process.stderr.resume();
  process.on('error', () => deferred.reject(new ApiError(503, 'RUNNER_UNAVAILABLE', 'Docker is unavailable. Install/start Docker and build the Pine runner image.')));
  process.on('close', (code) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (failure) { void remove().then(error => deferred.reject(error ?? failure)); return; }
    if (code !== 0) deferred.reject(new ApiError(503, 'RUNNER_UNAVAILABLE', 'Docker or the Pine runner image is unavailable. Run npm run runner:build and verify the Docker daemon.'));
    else {
      try {
        const health = JSON.parse(output.trim()) as { version?: string; isolated?: boolean };
        if (health.version !== '0.10.0' || health.isolated !== true) throw new Error();
        deferred.resolve();
      } catch { deferred.reject(new ApiError(503, 'RUNNER_UNAVAILABLE', 'The runner image does not expose the pinned PineTS 0.10.0 protocol. Rebuild it.')); }
    }
  });
  return deferred.promise;
}

export async function runDocker(request: PineRunRequest | PineValidateRequest, broker: DataBroker | undefined, signal: AbortSignal): Promise<RunnerOutcome> {
  if (signal.aborted) throw new PineRunnerError({ code: 'CANCELLED', message: 'Pine execution was cancelled.' });
  const name = `pineterm-run-${randomUUID()}`;
  const process = spawn('docker', ['run', '--rm', '-i', '--name', name, '--label', `pineterm.jobId=${request.jobId}`, ...isolation, RUNNER_IMAGE], { stdio: ['pipe', 'pipe', 'pipe'] });
  const deferred = Promise.withResolvers<RunnerOutcome>();
  let buffered: Buffer = Buffer.alloc(0);
  let bytes = 0;
  let compiled: PineValidation | undefined;
  let outcome: RunnerOutcome | undefined;
  let failure: Error | undefined;
  let terminal = false;
  let dataRequests = 0;
  let cleanup: Promise<Error | undefined> | undefined;
  const remove = () => cleanup ??= removeContainer(name).then(() => undefined, error => error as Error);
  const killContainer = () => {
    void remove();
    process.kill('SIGKILL');
  };
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    killContainer();
  };
  const cancelled = () => fail(new PineRunnerError({ code: 'CANCELLED', message: 'Pine execution was cancelled.' }));
  signal.addEventListener('abort', cancelled, { once: true });
  const compileTimer = setTimeout(() => fail(new PineRunnerError({ code: 'COMPILE_TIMEOUT', message: 'Pine compilation exceeded 10 seconds.' })), 10_000);
  const wholeTimer = setTimeout(() => fail(new PineRunnerError({ code: 'EXECUTION_TIMEOUT', message: 'Pine execution exceeded 60 seconds.' })), 60_000);
  const writeFrame = (message: unknown) => {
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > MAX_BYTES) { fail(new PineRunnerError({ code: 'INPUT_BUDGET_EXCEEDED', message: 'Runner input frame exceeds 20 MiB.' })); return; }
    process.stdin.write(frame, (error) => { if (error && !terminal && !failure) fail(new ApiError(503, 'RUNNER_UNAVAILABLE', 'The Docker runner input channel is unavailable.')); });
  };
  process.stdin.on('error', () => { if (!terminal && !failure) fail(new ApiError(503, 'RUNNER_UNAVAILABLE', 'The Docker runner input channel is unavailable.')); });
  process.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) { fail(new PineRunnerError({ code: 'OUTPUT_BUDGET_EXCEEDED', message: 'Runner output exceeds 20 MiB.' })); return; }
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    let newline: number;
    while ((newline = buffered.indexOf(10)) !== -1) {
      const line = buffered.subarray(0, newline).toString('utf8');
      buffered = buffered.subarray(newline + 1);
      try {
        const message = JSON.parse(line) as { type: string; jobId?: string; validation?: PineValidation; result?: PineExecutionResult; error?: PineDiagnostic } & Partial<Omit<PineDataRequest, 'type'>>;
        if (terminal) throw new Error('Output after terminal response.');
        if (message.type === 'data_request') {
          if (!compiled || !broker || request.type !== 'run' || ++dataRequests > 20 || typeof message.id !== 'string' || !message.market || !message.timeframe || !Number.isSafeInteger(message.from) || !Number.isSafeInteger(message.to) || !Number.isSafeInteger(message.limit)) throw new Error('Invalid secondary data request.');
          void broker(message as PineDataRequest).then((response) => { if (!failure && !terminal) writeFrame(response); }).catch((error: unknown) => {
            const diagnostic = error instanceof ApiError ? { code: error.code, message: error.message } : error instanceof PineRunnerError ? error.diagnostic : { code: 'DATA_UNAVAILABLE', message: 'Secondary snapshot is unavailable.' };
            if (!failure && !terminal) {
              writeFrame({ type: 'data_response', id: message.id, error: diagnostic });
              // A script's ignore_invalid_symbol cannot turn missing snapshots into a complete-looking report.
              fail(new PineRunnerError(diagnostic));
            }
          });
        } else {
          if (message.jobId !== request.jobId) throw new Error('Runner job ID mismatch.');
          if (message.type === 'compiled') {
            if (compiled || !message.validation || message.validation.valid !== true || !['indicator', 'strategy'].includes(message.validation.declarationType ?? '') || !Array.isArray(message.validation.inputs) || !Array.isArray(message.validation.props)) throw new Error('Invalid compilation response.');
            compiled = message.validation;
            clearTimeout(compileTimer);
            if (request.type === 'validate') { terminal = true; outcome = { validation: compiled, result: null }; process.stdin.end(); }
          } else if (message.type === 'result') {
            if (!compiled || request.type !== 'run' || !message.result || message.result.engineVersion !== '0.10.0' || message.result.valid !== true || !Array.isArray(message.result.equityCurve) || !Array.isArray(message.result.trades) || !Array.isArray(message.result.warnings)) throw new Error('Invalid execution response.');
            outcome = { validation: compiled, result: message.result };
            terminal = true;
            process.stdin.end();
          } else if (message.type === 'error' && message.error && typeof message.error.code === 'string' && typeof message.error.message === 'string') {
            terminal = true;
            failure = new PineRunnerError(message.error);
            process.stdin.end();
          } else throw new Error('Unknown runner frame.');
        }
      } catch { fail(new PineRunnerError({ code: 'INVALID_RUNNER_PROTOCOL', message: 'Runner returned malformed or unexpected NDJSON.' })); return; }
    }
  });
  process.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BYTES) fail(new PineRunnerError({ code: 'OUTPUT_BUDGET_EXCEEDED', message: 'Runner output exceeds 20 MiB.' })); });
  process.on('error', () => { failure = new ApiError(503, 'RUNNER_UNAVAILABLE', 'Docker is unavailable. No Pine source was executed in the API process.'); });
  process.on('close', (code) => {
    clearTimeout(compileTimer); clearTimeout(wholeTimer); signal.removeEventListener('abort', cancelled);
    if (failure) void remove().then(error => deferred.reject(error ?? failure));
    else if (code !== 0 || !outcome || buffered.length) deferred.reject(new ApiError(503, 'RUNNER_UNAVAILABLE', 'The isolated runner exited without a complete result. Verify Docker and rebuild its image.'));
    else deferred.resolve(outcome);
  });
  writeFrame(request);
  return deferred.promise;
}
