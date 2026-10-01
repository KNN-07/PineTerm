import type { FastifyInstance, FastifyRequest } from 'fastify';
import packageInfo from '../../../package.json' with { type: 'json' };
import {
  emptyQuerySchema, errorResponses, idParamsSchema, mutationHeadersSchema,
  type ApiMetadata, type CreateApiKeyBody, type InvalidationEvent, type LoginBody,
} from '../../../packages/contracts/src/index.js';
import { ApiError } from './errors.js';
import type { Config } from './config.js';
import './types.js';

async function rejectBody(request: FastifyRequest): Promise<void> {
  if (request.body !== undefined) throw new ApiError(400, 'INVALID_SCHEMA', 'This operation does not accept a request body.');
}

export function registerRoutes(app: FastifyInstance, config: Config): void {
  const adminSecurity = [{ adminSession: [] }];
  const mutationSecurity = [{ adminSession: [], csrfToken: [] }];

  app.get('/api/v1/meta', {
    config: { security: { access: 'public' } },
    schema: {
      operationId: 'getMetadata', tags: ['Application'], summary: 'Read application readiness and deployed source revision',
      security: [], querystring: emptyQuerySchema,
      response: { 200: { $ref: 'ApiMetadata#' }, ...errorResponses },
    },
  }, async (): Promise<ApiMetadata> => ({
    name: 'PineTerm', version: packageInfo.version, sourceUrl: config.sourceUrl,
    sourceRevision: config.sourceRevision, license: 'AGPL-3.0-only', milestone: 2,
    capabilities: ['session', 'api-keys', 'about', 'market-data', 'historical-datasets'],
  }));

  app.post<{ Body: LoginBody }>('/api/v1/session', {
    config: { security: { access: 'public' } },
    schema: {
      operationId: 'createSession', tags: ['Session'], summary: 'Log in as the single administrator',
      description: 'Requires the configured Origin. Five attempts per source IP and fifty globally per 15 minutes. Session expires after 12 hours.',
      security: [], body: { $ref: 'LoginBody#' }, headers: mutationHeadersSchema, querystring: emptyQuerySchema,
      response: { 200: { $ref: 'Session#' }, ...errorResponses },
    },
  }, async (request, reply) => app.security.login(request, reply, request.body.password));

  app.get('/api/v1/session', {
    config: { security: { access: 'admin' } },
    schema: {
      operationId: 'getSession', tags: ['Session'], summary: 'Get current admin authentication and CSRF token',
      security: adminSecurity, querystring: emptyQuerySchema,
      response: { 200: { $ref: 'Session#' }, ...errorResponses },
    },
  }, async (request) => {
    const principal = request.principal;
    if (!principal || principal.kind !== 'session') throw new ApiError(401, 'UNAUTHENTICATED', 'An active admin session is required.');
    return { authenticated: true, csrfToken: app.security.csrfToken(principal.sessionHash) };
  });

  app.delete('/api/v1/session', {
    config: { security: { access: 'admin' } }, preValidation: rejectBody,
    schema: {
      operationId: 'deleteSession', tags: ['Session'], summary: 'Revoke the session and clear its cookie',
      security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema,
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (request, reply) => {
    app.security.logout(request, reply);
    if (request.principal?.kind === 'session') app.events.closeSession(request.principal.sessionHash);
    reply.code(204).send();
  });

  app.get('/api/v1/api-keys', {
    config: { security: { access: 'admin' } },
    schema: {
      operationId: 'listApiKeys', tags: ['API keys'], summary: 'List key metadata, including revocations; never tokens',
      security: adminSecurity, querystring: emptyQuerySchema,
      response: { 200: { $ref: 'ApiKeyList#' }, ...errorResponses },
    },
  }, async () => ({ keys: app.security.listKeys() }));

  app.post<{ Body: CreateApiKeyBody }>('/api/v1/api-keys', {
    config: { security: { access: 'admin' } },
    schema: {
      operationId: 'createApiKey', tags: ['API keys'], summary: 'Issue a scoped key, showing its token once',
      description: 'Executor scopes require an existing executor ID. Keys cannot manage security policy or other keys. Copy the returned token now: only its hash is persisted.',
      security: mutationSecurity, headers: mutationHeadersSchema, body: { $ref: 'CreateApiKeyBody#' }, querystring: emptyQuerySchema,
      response: { 201: { $ref: 'CreateApiKeyResponse#' }, ...errorResponses },
    },
  }, async (request, reply) => {
    const { result, event } = app.db.transaction(() => {
      const result = app.security.createKey(request.body);
      const event = app.events.record('api-keys.changed', result.key.id, 1);
      return { result, event };
    }).immediate();
    app.events.emit(event);
    return reply.code(201).send(result);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/api-keys/:id', {
    config: { security: { access: 'admin' } }, preValidation: rejectBody,
    schema: {
      operationId: 'revokeApiKey', tags: ['API keys'], summary: 'Revoke a key immediately; repeated revocation is idempotent',
      security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema,
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (request, reply) => {
    const event = app.db.transaction((): InvalidationEvent | null => {
      if (!app.security.revokeKey(request.params.id)) return null;
      return app.events.record('api-keys.changed', request.params.id, 2);
    }).immediate();
    if (event) app.events.emit(event);
    reply.code(204).send();
  });

  app.get('/api/v1/events', {
    config: { security: { access: 'admin' } },
    schema: {
      operationId: 'adminEvents', tags: ['Events'], summary: 'Stream admin invalidations without secrets or resource contents',
      description: 'SSE event name is invalidation; JSON data matches InvalidationEvent. Refetch authorized resource routes on every connection. Last-Event-ID replays up to 500 events retained for 24 hours. Expired/revoked sessions disconnect.',
      security: adminSecurity, querystring: emptyQuerySchema,
      headers: {
        type: 'object', properties: { 'last-event-id': { type: 'string', format: 'uuid' } }, additionalProperties: true,
      },
      response: {
        200: { description: 'Server-sent invalidations', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        ...errorResponses,
      },
    },
  }, async (request, reply) => app.events.connect(request, reply, app.security));

  app.get('/api/v1/openapi.json', {
    config: { security: { access: 'public' } },
    schema: {
      operationId: 'getOpenApi', tags: ['Application'], summary: 'Read full API schemas and authentication requirements',
      security: [], querystring: emptyQuerySchema,
      response: {
        200: {
          type: 'object', required: ['openapi', 'info', 'paths'],
          properties: {
            openapi: { type: 'string' },
            info: { type: 'object', additionalProperties: true },
            paths: { type: 'object', additionalProperties: true },
            components: { type: 'object', additionalProperties: true },
          }, additionalProperties: true,
        },
        ...errorResponses,
      },
    },
  }, async () => app.swagger());
}
