import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { AGENT_TOOL_NAMES, TIMEFRAMES, emptyQuerySchema, errorResponses, idParamsSchema, marketRefSchema, mutationHeadersSchema, type AgentEvent, type AgentMessageRequest, type UpdateAgentConfig } from '@pineterm/contracts';
import type { AgentService } from './AgentService.js';
import type { SecurityBoundary } from '../security.js';
import { ApiError } from '../errors.js';
import { agentDraftSchema } from './draftRoutes.js';
import '../types.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const time = { type: 'integer', minimum: 0 } as const;
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const tokenLimit = { type: 'integer', minimum: 1, maximum: 2_000_000 } as const;
const nullableNumber = { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] } as const;
const tool = { type: 'string', enum: AGENT_TOOL_NAMES } as const;
export const agentConfigSchema = { type: 'object', additionalProperties: false, required: ['configured','revision','provider','model','baseUrl','authMode','apiKeyConfigured','contextWindow','maxTokens'], properties: { configured: { type: 'boolean' }, revision: time, provider: nullableText, model: nullableText, baseUrl: nullableText, authMode: { type: 'string', enum: ['api-key','none'] }, apiKeyConfigured: { type: 'boolean' }, contextWindow: { anyOf: [tokenLimit, { type: 'null' }] }, maxTokens: { anyOf: [tokenLimit, { type: 'null' }] } } } as const;
const statusSchema = { type: 'object', additionalProperties: false, required: ['configured','available','reason','provider','model','tools','authority'], properties: { configured: { type: 'boolean' }, available: { type: 'boolean' }, reason: nullableText, provider: nullableText, model: nullableText, tools: { type: 'array', minItems: 8, maxItems: 8, uniqueItems: true, items: tool }, authority: { const: 'analysis-and-drafts', type: 'string' } } } as const;
const usageSchema = { type: 'object', additionalProperties: false, required: ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens','costUsd'], properties: { inputTokens: nullableNumber, outputTokens: nullableNumber, cacheReadTokens: nullableNumber, cacheWriteTokens: nullableNumber, totalTokens: nullableNumber, costUsd: nullableNumber } } as const;
const provenanceSchema = { type: 'object', additionalProperties: false, required: ['tool'], properties: { tool, market: marketRefSchema, timeframe: { type: 'string', enum: TIMEFRAMES }, from: time, to: time, asOf: time, status: { type: 'string', maxLength: 100 }, scriptRevisionId: uuid, paperAccountId: uuid, jobId: uuid, draftId: uuid } } as const;
const messageSchema = { type: 'object', additionalProperties: false, required: ['id','role','text','createdAt'], properties: { id: { type: 'string' }, role: { type: 'string', enum: ['user','assistant','tool'] }, text: { type: 'string' }, createdAt: time, tool, provenance: provenanceSchema, usage: usageSchema, error: { type: 'boolean' } } } as const;
const recordProperties = { id: uuid, title: { type: 'string', minLength: 1, maxLength: 100 }, provider: { type: 'string' }, model: { type: 'string' }, state: { type: 'string', enum: ['idle','running'] }, createdAt: time, updatedAt: time } as const;
const recordRequired = ['id','title','provider','model','state','createdAt','updatedAt'] as const;
const recordSchema = { type: 'object', additionalProperties: false, required: recordRequired, properties: recordProperties } as const;
export const agentSessionSchema = { type: 'object', additionalProperties: false, required: [...recordRequired,'messages','drafts'], properties: { ...recordProperties, messages: { type: 'array', items: messageSchema }, drafts: { type: 'array', items: agentDraftSchema } } } as const;
const sessionResponse = { type: 'object', additionalProperties: false, required: ['session'], properties: { session: agentSessionSchema } } as const;
const contextSchema = { type: 'object', additionalProperties: false, required: ['market','timeframe'], properties: { market: marketRefSchema, timeframe: { type: 'string', enum: TIMEFRAMES }, scriptRevisionId: uuid, paperAccountId: uuid, replaySessionId: uuid } } as const;
const commonEvent = { id: { type: 'integer', minimum: 1 }, sessionId: uuid, turnId: uuid } as const;
/** Registered in OpenAPI; SSE sends one named agent frame containing this discriminated union. */
export const agentEventSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['id','type','sessionId','turnId','text'], properties: { ...commonEvent, type: { const: 'text_delta' }, text: { type: 'string' } } },
  { type: 'object', additionalProperties: false, required: ['id','type','sessionId','turnId','tool','text'], properties: { ...commonEvent, type: { enum: ['tool_start','tool_progress','tool_end'] }, tool, text: { type: 'string' }, provenance: provenanceSchema } },
  { type: 'object', additionalProperties: false, required: ['id','type','sessionId','turnId','draftId'], properties: { ...commonEvent, type: { const: 'draft' }, draftId: uuid } },
  { type: 'object', additionalProperties: false, required: ['id','type','sessionId','turnId','code','message'], properties: { ...commonEvent, type: { const: 'error' }, code: { type: 'string' }, message: { type: 'string' } } },
  { type: 'object', additionalProperties: false, required: ['id','type','sessionId','turnId','state'], properties: { ...commonEvent, type: { const: 'settled' }, state: { enum: ['completed','cancelled','failed'] }, usage: usageSchema } },
] } as const;
async function noBody(request: FastifyRequest): Promise<void> { if (request.body !== undefined) throw new ApiError(400, 'INVALID_SCHEMA', 'This operation does not accept a body.'); }

export async function registerAgentRoutes(app: FastifyInstance, service: AgentService, security: SecurityBoundary): Promise<void> {
  app.addSchema({ $id: 'AgentEvent', ...agentEventSchema });
  const clients = new Map<string, number>(); const connections = new Set<ServerResponse>(); let count = 0;
  app.addHook('preClose', async () => { for (const response of connections) response.end(); });
  await app.register(async routes => {
    const config = { security: { access: 'admin' as const } }; const readSecurity = [{ adminSession: [] }]; const mutationSecurity = [{ adminSession: [], csrfToken: [] }];
    const common = { config, schema: { tags: ['Agent'], security: readSecurity, querystring: emptyQuerySchema } };
    routes.get('/api/v1/agent/config', { ...common, preValidation: noBody, schema: { ...common.schema, operationId: 'getAgentConfig', summary: 'Read model configuration, never the encrypted key', response: { 200: agentConfigSchema, ...errorResponses } } }, async () => service.getConfig());
    routes.put<{ Body: UpdateAgentConfig }>('/api/v1/agent/config', { config, schema: { tags: ['Agent'], operationId: 'updateAgentConfig', security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: ['revision','provider','model','authMode'], properties: { revision: time, provider: { type: 'string', minLength: 1, maxLength: 64 }, model: { type: 'string', minLength: 1, maxLength: 200 }, apiKey: { type: 'string', minLength: 1, maxLength: 8192, writeOnly: true }, baseUrl: nullableText, authMode: { type: 'string', enum: ['api-key','none'] }, contextWindow: tokenLimit, maxTokens: tokenLimit } }, response: { 200: agentConfigSchema, ...errorResponses } } }, async request => service.updateConfig(request.body));
    routes.delete('/api/v1/agent/config', { config, preValidation: noBody, schema: { tags: ['Agent'], operationId: 'deleteAgentConfig', security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema, response: { 204: { type: 'null' }, ...errorResponses } } }, async (_request, reply) => { await service.deleteConfig(); return reply.code(204).send(); });
    routes.get('/api/v1/agent/status', { ...common, preValidation: noBody, schema: { ...common.schema, operationId: 'getAgentStatus', response: { 200: statusSchema, ...errorResponses } } }, async () => service.status());
    routes.get('/api/v1/agent/models', { ...common, preValidation: noBody, schema: { ...common.schema, operationId: 'listAgentModels', response: { 200: { type: 'object', additionalProperties: false, required: ['models'], properties: { models: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['provider','id','name','contextWindow','maxTokens'], properties: { provider: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, contextWindow: tokenLimit, maxTokens: tokenLimit } } } } }, ...errorResponses } } }, async () => ({ models: service.models() }));
    routes.get('/api/v1/agent/sessions', { ...common, preValidation: noBody, schema: { ...common.schema, operationId: 'listAgentSessions', response: { 200: { type: 'object', additionalProperties: false, required: ['sessions'], properties: { sessions: { type: 'array', items: recordSchema } } }, ...errorResponses } } }, async () => ({ sessions: service.listSessions() }));
    routes.post<{ Body: { title?: string } }>('/api/v1/agent/sessions', { config, schema: { tags: ['Agent'], operationId: 'createAgentSession', security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 100 } } }, response: { 201: sessionResponse, ...errorResponses } } }, async (request, reply) => reply.code(201).send({ session: await service.createSession(request.body.title) }));
    routes.get<{ Params: { id: string } }>('/api/v1/agent/sessions/:id', { ...common, preValidation: noBody, schema: { ...common.schema, operationId: 'getAgentSession', params: idParamsSchema, response: { 200: sessionResponse, ...errorResponses } } }, async request => ({ session: service.getSession(request.params.id) }));
    routes.post<{ Params: { id: string }; Body: AgentMessageRequest }>('/api/v1/agent/sessions/:id/messages', { config, bodyLimit: 64 * 1024, schema: { tags: ['Agent'], operationId: 'sendAgentMessage', security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: ['text','context'], properties: { text: { type: 'string', minLength: 1, maxLength: 32768 }, context: contextSchema } }, response: { 202: { type: 'object', additionalProperties: false, required: ['turnId'], properties: { turnId: uuid } }, ...errorResponses } } }, async (request, reply) => reply.code(202).send(await service.message(request.params.id, request.body)));
    routes.post<{ Params: { id: string } }>('/api/v1/agent/sessions/:id/cancel', { config, preValidation: noBody, schema: { tags: ['Agent'], operationId: 'cancelAgentTurn', security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: sessionResponse, ...errorResponses } } }, async request => ({ session: await service.cancel(request.params.id) }));
    routes.get<{ Params: { id: string } }>('/api/v1/agent/sessions/:id/events', { ...common, preValidation: noBody, schema: { ...common.schema, operationId: 'streamAgentEvents', params: idParamsSchema, headers: { type: 'object', properties: { 'last-event-id': { type: 'string', pattern: '^[0-9]{1,16}$' } } }, description: 'Authenticated SSE: event agent, numeric id and JSON AgentEvent. Reconnect with Last-Event-ID. Refetch the authorized transcript after every connection and settled event. Slow consumers are closed rather than buffered; replay resumes from the last successfully received ID.', response: { 200: { type: 'string' }, ...errorResponses } } }, async (request, reply) => {
      const principal = request.principal;
      if (!principal || principal.kind !== 'session') throw new ApiError(403, 'ADMIN_SESSION_REQUIRED', 'Agent events require an admin browser session.');
      if (count >= 32 || (clients.get(principal.sessionHash) ?? 0) >= 4) throw new ApiError(429, 'AGENT_STREAM_LIMIT', 'Too many agent streams are open.');
      const rawCursor = request.headers['last-event-id']; let cursor = typeof rawCursor === 'string' ? Number(rawCursor) : 0;
      if (!Number.isSafeInteger(cursor)) throw new ApiError(400, 'INVALID_EVENT_CURSOR', 'Last-Event-ID must be a safe integer.');
      const replay = service.eventsSince(request.params.id, cursor);
      const send = (event: AgentEvent) => {
        if (!security.isSessionActive(principal.sessionHash)) { reply.raw.end(); return; }
        if (event.id <= cursor || reply.raw.destroyed || reply.raw.writableEnded) return;
        const frame = `id: ${event.id}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
        if (reply.raw.writableLength + Buffer.byteLength(frame) > 128 * 1024 || !reply.raw.write(frame)) { reply.raw.end(); return; }
        cursor = event.id;
      };
      const unsubscribe = service.subscribe(request.params.id, send); count++; clients.set(principal.sessionHash, (clients.get(principal.sessionHash) ?? 0) + 1);
      for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, Array.isArray(value) ? value.map(String) : String(value));
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); reply.hijack();
      connections.add(reply.raw);
      reply.raw.write('retry: 2000\n: connected; refetch saved transcript\n\n');
      let batch = replay;
      while (batch.length && !reply.raw.writableEnded && !reply.raw.destroyed) { for (const event of batch) send(event); if (batch.length < 501) break; batch = service.eventsSince(request.params.id, cursor); }
      const timer = setInterval(() => { if (!security.isSessionActive(principal.sessionHash) || !reply.raw.write(': keepalive\n\n')) reply.raw.end(); }, 15_000); timer.unref();
      reply.raw.on('close', () => { clearInterval(timer); unsubscribe(); connections.delete(reply.raw); count--; const next = (clients.get(principal.sessionHash) ?? 1) - 1; if (next) clients.set(principal.sessionHash, next); else clients.delete(principal.sessionHash); });
    });
  });
}
