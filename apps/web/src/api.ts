import type {
  ApiKeyList,
  ApiMetadata,
  CreateApiKeyBody,
  CreateApiKeyResponse,
  ErrorEnvelope,
  Session,
} from '@pineterm/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred. Please try again.';
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = value.error;
  return !!error && typeof error === 'object'
    && 'code' in error && typeof error.code === 'string'
    && 'message' in error && typeof error.message === 'string';
}

export class ApiClient {
  private csrfToken: string | null = null;

  private async request<T>(
    path: string,
    options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; csrf?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.csrf) {
      if (!this.csrfToken) throw new ApiError(401, 'SESSION_REQUIRED', 'Please sign in again.');
      headers.set('x-csrf-token', this.csrfToken);
    }

    let response: Response;
    try {
      response = await fetch(`/api/v1${path}`, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ApiError(0, 'NETWORK_UNAVAILABLE', 'Cannot reach the PineTerm server. Check the connection and try again.');
    }

    if (response.status === 401) this.csrfToken = null;
    if (response.status === 204 && response.ok) return undefined as T;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(response.status, 'INVALID_RESPONSE', `The server returned an unreadable response (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      if (isErrorEnvelope(payload)) {
        throw new ApiError(response.status, payload.error.code, payload.error.message, payload.error.details);
      }
      throw new ApiError(response.status, 'HTTP_ERROR', `The request failed (HTTP ${response.status}).`);
    }
    return payload as T;
  }

  async getSession(signal?: AbortSignal): Promise<Session | null> {
    try {
      const session = await this.request<Session>('/session', { signal });
      this.csrfToken = session.csrfToken;
      return session;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }

  async login(password: string): Promise<Session> {
    const session = await this.request<Session>('/session', { method: 'POST', body: { password } });
    this.csrfToken = session.csrfToken;
    return session;
  }

  async logout(): Promise<void> {
    await this.request<void>('/session', { method: 'DELETE', csrf: true });
    this.csrfToken = null;
  }

  getMetadata(signal?: AbortSignal): Promise<ApiMetadata> {
    return this.request<ApiMetadata>('/meta', { signal });
  }

  listApiKeys(signal?: AbortSignal): Promise<ApiKeyList> {
    return this.request<ApiKeyList>('/api-keys', { signal });
  }

  createApiKey(body: CreateApiKeyBody): Promise<CreateApiKeyResponse> {
    return this.request<CreateApiKeyResponse>('/api-keys', { method: 'POST', body, csrf: true });
  }

  revokeApiKey(id: string): Promise<void> {
    return this.request<void>(`/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE', csrf: true });
  }
}
