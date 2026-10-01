import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_KEY_SCOPES, type ApiKey, type ApiKeyScope, type CreateApiKeyBody, type CreateApiKeyResponse, type Session } from '../../../packages/contracts/src/index.js';
import type { Config } from './config.js';
import type { AppDatabase } from './database.js';
import { ApiError } from './errors.js';
import { constantTimeEqual, hashToken, signMaterial } from './secrets.js';

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SAFE_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true };

export type Principal =
  | { kind: 'session'; sessionHash: string; expiresAt: number }
  | { kind: 'api-key'; keyId: string; scopes: ApiKeyScope[]; executorId: string | null };

export type RouteSecurity =
  | { access: 'public' }
  | { access: 'admin' }
  | { access: 'data'; scopes: readonly ApiKeyScope[]; executorIdParam?: string };

interface SessionRow {
  id_hash: string;
  expires_at: number;
}

interface KeyRow {
  id: string;
  name: string;
  scopes_json: string;
  executor_id: string | null;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

interface LoginBucket {
  window_start: number;
  attempts: number;
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error);
    else resolve(key);
  });
  return promise;
}

function publicKey(row: KeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    scopes: JSON.parse(row.scopes_json) as ApiKeyScope[],
    executorId: row.executor_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

/** The sole HTTP/session/API-key policy boundary, reused by future data routes and upgrades. */
export class SecurityBoundary {
  readonly cookieName: string;
  readonly #config: Config;
  readonly #db: AppDatabase;
  readonly #clock: () => number;
  readonly #salt: Buffer;
  readonly #passwordHash: Buffer;
  readonly #sessionByHash;
  readonly #deleteSession;
  readonly #keyByHash;
  readonly #touchKey;
  readonly #bucketById;

  private constructor(config: Config, db: AppDatabase, clock: () => number, salt: Buffer, passwordHash: Buffer) {
    this.#config = config;
    this.#db = db;
    this.#clock = clock;
    this.#salt = salt;
    this.#passwordHash = passwordHash;
    this.cookieName = config.publicOrigin.startsWith('https:') ? '__Host-pineterm_session' : 'pineterm_session';
    this.#sessionByHash = db.prepare<[string], SessionRow>('SELECT id_hash, expires_at FROM sessions WHERE id_hash = ?');
    this.#deleteSession = db.prepare('DELETE FROM sessions WHERE id_hash = ?');
    this.#keyByHash = db.prepare<[string], KeyRow>('SELECT id, name, scopes_json, executor_id, created_at, revoked_at, last_used_at FROM api_keys WHERE token_hash = ?');
    this.#touchKey = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
    this.#bucketById = db.prepare<[string], LoginBucket>('SELECT window_start, attempts FROM login_attempts WHERE bucket = ?');
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(clock());
  }

  static async create(config: Config, db: AppDatabase, clock: () => number): Promise<SecurityBoundary> {
    const salt = randomBytes(32);
    const passwordHash = await derivePassword(config.adminPassword, salt);
    return new SecurityBoundary(config, db, clock, salt, passwordHash);
  }

  assertOrigin(request: FastifyRequest, required = true): void {
    const origin = request.headers.origin;
    if ((required && !origin) || (origin !== undefined && origin !== this.#config.publicOrigin)) {
      throw new ApiError(403, 'ORIGIN_FORBIDDEN', 'Use the configured PineTerm origin for this request.');
    }
  }

  #sessionFromCookie(request: FastifyRequest): Principal & { kind: 'session' } | null {
    const cookie = request.cookies[this.cookieName];
    if (!cookie || cookie.length > 256) return null;
    const unsigned = request.unsignCookie(cookie);
    if (!unsigned.valid || !unsigned.value || !/^[A-Za-z0-9_-]{43}$/.test(unsigned.value)) return null;
    const idHash = hashToken(unsigned.value);
    const session = this.#sessionByHash.get(idHash);
    if (!session) return null;
    if (session.expires_at <= this.#clock()) {
      this.#deleteSession.run(idHash);
      return null;
    }
    return { kind: 'session', sessionHash: idHash, expiresAt: session.expires_at };
  }

  authenticate(request: FastifyRequest): Principal {
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const match = /^Bearer (ptk_[A-Za-z0-9_-]{43})$/.exec(authorization);
      if (!match) throw new ApiError(401, 'UNAUTHENTICATED', 'Provide a valid bearer API key.');
      const key = this.#keyByHash.get(hashToken(match[1]));
      if (!key || key.revoked_at !== null) throw new ApiError(401, 'UNAUTHENTICATED', 'This API key is invalid or revoked.');
      const scopes: unknown = JSON.parse(key.scopes_json);
      if (!Array.isArray(scopes) || !scopes.length || !scopes.every((scope) => API_KEY_SCOPES.includes(scope))) {
        throw new ApiError(503, 'SECURITY_STATE_INVALID', 'The API key has invalid persisted scopes.');
      }
      this.#touchKey.run(this.#clock(), key.id);
      return { kind: 'api-key', keyId: key.id, scopes: scopes as ApiKeyScope[], executorId: key.executor_id };
    }
    const principal = this.#sessionFromCookie(request);
    if (!principal) throw new ApiError(401, 'UNAUTHENTICATED', 'Log in to PineTerm or provide a scoped bearer API key.');
    return principal;
  }

  authorize(request: FastifyRequest, policy: RouteSecurity): Principal | null {
    this.assertOrigin(request, false);
    if (policy.access === 'public') {
      if (!SAFE_METHODS[request.method]) this.assertOrigin(request);
      return null;
    }
    if (policy.access === 'admin' && request.headers.authorization !== undefined) {
      throw new ApiError(403, 'ADMIN_SESSION_REQUIRED', 'This operation requires an admin browser session, not an API key.');
    }
    const principal = this.authenticate(request);
    if (principal.kind === 'session') {
      if (!SAFE_METHODS[request.method]) {
        this.assertOrigin(request);
        const token = request.headers['x-csrf-token'];
        if (typeof token !== 'string' || !constantTimeEqual(token, this.csrfToken(principal.sessionHash))) {
          throw new ApiError(403, 'CSRF_FORBIDDEN', 'Provide the current session CSRF token in x-csrf-token.');
        }
      }
    } else {
      if (policy.access !== 'data' || !policy.scopes.length || !policy.scopes.every((scope) => principal.scopes.includes(scope))) {
        throw new ApiError(403, 'SCOPE_FORBIDDEN', 'This API key does not have the required scopes.');
      }
      if (policy.executorIdParam) {
        const params = request.params as Record<string, unknown>;
        if (!principal.executorId || principal.executorId !== params[policy.executorIdParam]) {
          throw new ApiError(403, 'EXECUTOR_FORBIDDEN', 'This key is bound to a different executor.');
        }
      }
    }
    request.principal = principal;
    return principal;
  }

  authorizeWebSocket(request: FastifyRequest, scopes: readonly ApiKeyScope[]): Principal {
    this.assertOrigin(request);
    return this.authorize(request, { access: 'data', scopes })!;
  }

  requireAdmin(request: FastifyRequest): Principal & { kind: 'session' } {
    const principal = this.authorize(request, { access: 'admin' });
    if (!principal || principal.kind !== 'session') throw new ApiError(403, 'ADMIN_SESSION_REQUIRED', 'An admin session is required.');
    return principal;
  }

  requireExecutor(request: FastifyRequest, executorId: string, scope: 'executor:claim' | 'executor:report'): Principal & { kind: 'api-key' } {
    const principal = this.authorize(request, { access: 'data', scopes: [scope] });
    if (!principal || principal.kind !== 'api-key' || principal.executorId !== executorId) {
      throw new ApiError(403, 'EXECUTOR_FORBIDDEN', 'An API key bound to this executor is required.');
    }
    return principal;
  }

  csrfToken(sessionHash: string): string {
    return signMaterial(this.#config.sessionSecret, 'csrf', sessionHash);
  }

  isSessionActive(sessionHash: string): boolean {
    const session = this.#sessionByHash.get(sessionHash);
    return !!session && session.expires_at > this.#clock();
  }

  #reserveLoginAttempt(request: FastifyRequest): void {
    const now = this.#clock();
    const ipBucket = signMaterial(this.#config.sessionSecret, 'login-ip', request.ip);
    const buckets = [{ id: ipBucket, limit: 5 }, { id: 'global', limit: 50 }];
    this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM login_attempts WHERE window_start <= ?').run(now - LOGIN_WINDOW_MS);
      for (const bucket of buckets) {
        const row = this.#bucketById.get(bucket.id);
        if (row && row.attempts >= bucket.limit) {
          const retryAfter = Math.max(1, Math.ceil((row.window_start + LOGIN_WINDOW_MS - now) / 1000));
          throw new ApiError(429, 'LOGIN_RATE_LIMITED', 'Too many login attempts. Wait before trying again.', undefined, retryAfter);
        }
      }
      const increment = this.#db.prepare(`INSERT INTO login_attempts(bucket, window_start, attempts) VALUES (?, ?, 1)
        ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1`);
      for (const bucket of buckets) increment.run(bucket.id, now);
    }).immediate();
  }

  async login(request: FastifyRequest, reply: FastifyReply, password: string): Promise<Session> {
    this.#reserveLoginAttempt(request);
    const derived = await derivePassword(password, this.#salt);
    const matches = timingSafeEqual(derived, this.#passwordHash);
    derived.fill(0);
    if (!matches) throw new ApiError(401, 'INVALID_CREDENTIALS', 'The admin password is incorrect.');
    const token = randomBytes(32).toString('base64url');
    const idHash = hashToken(token);
    const now = this.#clock();
    const existing = this.#sessionFromCookie(request);
    this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      if (existing) this.#deleteSession.run(existing.sessionHash);
      this.#db.prepare('INSERT INTO sessions(id_hash, created_at, expires_at) VALUES (?, ?, ?)').run(idHash, now, now + SESSION_LIFETIME_MS);
      this.#db.prepare('DELETE FROM sessions WHERE id_hash IN (SELECT id_hash FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 32)').run();
    }).immediate();
    reply.setCookie(this.cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: this.#config.publicOrigin.startsWith('https:'),
      signed: true,
      maxAge: SESSION_LIFETIME_MS / 1000,
      expires: new Date(now + SESSION_LIFETIME_MS),
    });
    return { authenticated: true, csrfToken: this.csrfToken(idHash) };
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const principal = request.principal;
    if (!principal || principal.kind !== 'session') throw new ApiError(401, 'UNAUTHENTICATED', 'An active session is required.');
    this.#deleteSession.run(principal.sessionHash);
    reply.clearCookie(this.cookieName, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: this.#config.publicOrigin.startsWith('https:'),
    });
  }

  listKeys(): ApiKey[] {
    return this.#db.prepare<[], KeyRow>('SELECT id, name, scopes_json, executor_id, created_at, revoked_at, last_used_at FROM api_keys ORDER BY created_at DESC, id').all().map(publicKey);
  }

  createKey(body: CreateApiKeyBody): CreateApiKeyResponse {
    const executorScope = body.scopes.some((scope) => scope === 'executor:claim' || scope === 'executor:report');
    if (executorScope !== !!body.executorId) {
      throw new ApiError(400, 'INVALID_SCHEMA', 'Executor scopes require executorId; other keys must not provide executorId.');
    }
    if (body.executorId && !this.#db.prepare('SELECT id FROM executors WHERE id = ? AND archived_at IS NULL').get(body.executorId)) {
      throw new ApiError(404, 'EXECUTOR_NOT_FOUND', 'Create the executor before issuing its bound API key.');
    }
    const token = `ptk_${randomBytes(32).toString('base64url')}`;
    const key: ApiKey = {
      id: randomUUID(), name: body.name.trim(), scopes: [...body.scopes], executorId: body.executorId ?? null,
      createdAt: this.#clock(), revokedAt: null, lastUsedAt: null,
    };
    this.#db.prepare('INSERT INTO api_keys(id, name, token_hash, scopes_json, executor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key.id, key.name, hashToken(token), JSON.stringify(key.scopes), key.executorId, key.createdAt);
    return { key, token };
  }

  revokeKey(id: string): boolean {
    const key = this.#db.prepare<[string], { revoked_at: number | null }>('SELECT revoked_at FROM api_keys WHERE id = ?').get(id);
    if (!key) throw new ApiError(404, 'API_KEY_NOT_FOUND', 'The API key was not found.');
    if (key.revoked_at !== null) return false;
    this.#db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(this.#clock(), id);
    return true;
  }

  dispose(): void {
    this.#salt.fill(0);
    this.#passwordHash.fill(0);
  }
}
