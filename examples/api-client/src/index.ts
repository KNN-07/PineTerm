import type { BarPage, BarRange, CreatePaperAccount, MarketRef, PaperAccountView, PaperFill, PaperOrder, PaperOrderRequest, Quote } from '@pineterm/contracts';

export interface FinanceClientOptions { url: string; token: string; timeoutMs?: number; fetch?: typeof globalThis.fetch }
export interface FinanceRequest { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; idempotencyKey?: string; signal?: AbortSignal }
export interface FinanceBarsQuery extends MarketRef, BarRange { timeframe: string }
export class FinanceApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = 'FinanceApiError'; }
}

/** No automatic mutation retries: consumers retain their exact idempotency/report keys after ambiguous transport failures. */
export class FinanceClient {
  readonly url: string;
  private readonly origin: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly transport: typeof globalThis.fetch;
  constructor(options: FinanceClientOptions) {
    const origin = new URL(options.url);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Finance API URL must be an HTTP(S) origin without URL credentials, path, query or fragment.');
    if (!/^ptk_[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error('Provide a scoped PineTerm bearer key, never an administrator password.');
    this.origin = origin; this.url = origin.origin; this.token = options.token; this.timeoutMs = options.timeoutMs ?? 30000; this.transport = options.fetch ?? globalThis.fetch;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000) throw new Error('Client request timeout must be 1–120000 ms.');
  }
  async request<T>(path: string, options: FinanceRequest = {}): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')) throw new Error('Use a relative /api/v1 resource path.');
    const target = new URL('/api/v1' + path, this.origin);
    if (target.origin !== this.origin.origin || !target.pathname.startsWith('/api/v1/')) throw new Error('Finance API requests cannot select another host or escape /api/v1.');
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
    const response = await this.transport(target, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    if (response.status === 204) return undefined as T;
    const reader = response.body?.getReader();
    if (!reader) throw new FinanceApiError(response.status, 'UNREADABLE_RESPONSE', 'The finance API returned no JSON body.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 32 * 1024 * 1024) { await reader.cancel(); throw new FinanceApiError(response.status, 'RESPONSE_TOO_LARGE', 'Finance API response exceeds 32 MiB.'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new FinanceApiError(response.status, 'UNREADABLE_RESPONSE', 'The finance API returned an unreadable JSON response.'); }
    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && 'message' in error && typeof error.message === 'string') throw new FinanceApiError(response.status, error.code, error.message, 'details' in error ? error.details : undefined);
      throw new FinanceApiError(response.status, 'HTTP_ERROR', `Finance API returned HTTP ${response.status}.`);
    }
    return body as T;
  }
  getBars(query: FinanceBarsQuery): Promise<BarPage> {
    const parameters = new URLSearchParams({ provider: query.provider, symbol: query.symbol, timeframe: query.timeframe });
    for (const key of ['from', 'to', 'limit'] as const) if (query[key] !== undefined) parameters.set(key, String(query[key]));
    return this.request('/bars?' + parameters);
  }
  getQuote(market: MarketRef): Promise<Quote> { return this.request('/quotes?' + new URLSearchParams({ provider: market.provider, symbol: market.symbol })); }
  createPaperAccount(body: CreatePaperAccount): Promise<PaperAccountView> { return this.request('/paper/accounts', { method: 'POST', body }); }
  getPaperAccount(id: string): Promise<PaperAccountView> { return this.request('/paper/accounts/' + encodeURIComponent(id)); }
  async placePaperOrder(body: PaperOrderRequest, idempotencyKey: string): Promise<PaperOrder> { return (await this.request<{ order: PaperOrder }>('/paper/orders', { method: 'POST', body, idempotencyKey })).order; }
  async cancelPaperOrder(id: string): Promise<PaperOrder> { return (await this.request<{ order: PaperOrder }>('/paper/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })).order; }
  async getPaperFills(accountId: string): Promise<PaperFill[]> { return (await this.request<{ fills: PaperFill[] }>('/paper/fills?' + new URLSearchParams({ accountId }))).fills; }
}
