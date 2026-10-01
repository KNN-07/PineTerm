import { performance } from 'node:perf_hooks';
import { ApiError } from '../errors.js';

type Provider = 'binance' | 'coinbase';
interface Waiter { resolve: () => void; reject: (error: ApiError) => void; timer: NodeJS.Timeout }
export interface ProviderResponse { data: unknown; observedAt: number | null }

/** Shared per venue: bounded queue, concurrent requests, and spaced request starts. */
export class ProviderRequests {
  private active = 0;
  private nextStart = 0;
  private pausedUntil = 0;
  private closed = false;
  private waiters: Waiter[] = [];
  private controllers = new Set<AbortController>();

  constructor(private readonly provider: Provider, private readonly concurrency: number, private readonly spacingMs: number) {}

  private unavailable(message: string): ApiError {
    return new ApiError(503, 'PROVIDER_UNAVAILABLE', `${this.provider}: ${message}`, { provider: this.provider });
  }

  private check(): void {
    if (this.closed) throw this.unavailable('transport is closed.');
    const remaining = this.pausedUntil - performance.now();
    if (remaining > 0) throw new ApiError(429, 'PROVIDER_RATE_LIMIT', `${this.provider}: requests are rate limited.`, { provider: this.provider }, Math.ceil(remaining / 1000));
  }

  private async acquire(): Promise<void> {
    this.check();
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    if (this.waiters.length >= 128) throw this.unavailable('request queue is full.');
    const deferred = Promise.withResolvers<void>();
    const waiter: Waiter = {
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer: setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        deferred.reject(this.unavailable('request queue timed out.'));
      }, 8000),
    };
    this.waiters.push(waiter);
    await deferred.promise;
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    } else {
      this.active--;
    }
  }

  async get(url: URL): Promise<ProviderResponse> {
    await this.acquire();
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      for (;;) {
        this.check();
        const delay = this.nextStart - performance.now();
        if (delay <= 0) break;
        await this.delay(delay, controller.signal);
      }
      this.nextStart = performance.now() + this.spacingMs;
      const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
      if (response.status === 429 || (this.provider === 'binance' && response.status === 418)) {
        const raw = response.headers.get('retry-after');
        const seconds = raw !== null && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
        const date = raw === null ? NaN : Date.parse(raw);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : response.status === 418 ? 60000 : 1000;
        const retryAfter = Math.max(1, Math.ceil(delay / 1000));
        this.pausedUntil = Math.max(this.pausedUntil, performance.now() + retryAfter * 1000);
        await response.body?.cancel();
        throw new ApiError(429, 'PROVIDER_RATE_LIMIT', `${this.provider}: exchange returned HTTP ${response.status}.`, { provider: this.provider, httpStatus: response.status }, retryAfter);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(503, 'PROVIDER_UNAVAILABLE', `${this.provider}: exchange returned HTTP ${response.status}.`, { provider: this.provider, httpStatus: response.status });
      }
      const data: unknown = await response.json();
      const date = Date.parse(response.headers.get('date') ?? '');
      return { data, observedAt: Number.isFinite(date) ? date : null };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw this.unavailable(controller.signal.aborted ? 'request timed out or was cancelled.' : 'request failed or returned invalid JSON.');
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      this.release();
    }
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const deferred = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      deferred.resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      deferred.reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    await deferred.promise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.unavailable('transport is closed.'));
    }
    this.waiters = [];
    for (const controller of this.controllers) controller.abort();
  }
}
