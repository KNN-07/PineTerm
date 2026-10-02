import type { FastifyInstance, FastifyRequest } from 'fastify';
import { emptyQuerySchema, errorResponses, idParamsSchema, mutationHeadersSchema, type CreateScript, type UpdateScript } from '@pineterm/contracts';
import { ApiError } from '../errors.js';
import '../types.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const timestamp = { type: 'integer', minimum: 0 } as const;
const number = { type: 'integer', minimum: 1 } as const;
const values = { type: 'object', maxProperties: 256, propertyNames: { type: 'string', minLength: 1, maxLength: 200, not: { enum: ['__proto__', 'prototype', 'constructor'] } }, additionalProperties: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'number' }, { type: 'boolean' }] } } as const;
const storedValues = { type: 'object', additionalProperties: values.additionalProperties } as const;
const commandProperties = { name: { type: 'string', minLength: 1, maxLength: 100 }, source: { type: 'string', minLength: 1, maxLength: 262144, description: 'Pine v5/v6 text, maximum 256 KiB UTF-8. Saving a draft does not assert compilation success.' }, inputs: values, props: values } as const;
const createSchema = { type: 'object', additionalProperties: false, required: ['name', 'source', 'inputs', 'props'], properties: commandProperties } as const;
const updateSchema = { ...createSchema, required: [...createSchema.required, 'revision'], properties: { ...commandProperties, revision: number } } as const;
const scriptSchema = { type: 'object', additionalProperties: false, required: ['id', 'name', 'revision', 'currentRevisionId', 'archivedAt', 'createdAt', 'updatedAt'], properties: { id: uuid, name: commandProperties.name, revision: number, currentRevisionId: uuid, archivedAt: { anyOf: [timestamp, { type: 'null' }] }, createdAt: timestamp, updatedAt: timestamp } } as const;
const revisionSchema = { type: 'object', additionalProperties: false, required: ['id', 'scriptId', 'revision', 'source', 'sourceHash', 'languageVersion', 'inputs', 'props', 'createdAt'], properties: { id: uuid, scriptId: uuid, revision: number, source: commandProperties.source, sourceHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, languageVersion: { type: 'integer', enum: [5, 6] }, inputs: storedValues, props: storedValues, createdAt: timestamp } } as const;
const responseSchema = { type: 'object', additionalProperties: false, required: ['script', 'revision'], properties: { script: scriptSchema, revision: revisionSchema } } as const;
async function rejectBody(request: FastifyRequest): Promise<void> { if (request.body !== undefined) throw new ApiError(400, 'INVALID_SCHEMA', 'This operation does not accept a request body.'); }

export async function registerScriptRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (routes) => {
    const readConfig = { security: { access: 'data' as const, scopes: ['scripts:read' as const] } };
    const adminConfig = { security: { access: 'admin' as const } };
    const readSecurity: Array<Record<string, readonly string[]>> = [{ adminSession: [] }, { bearerKey: ['scripts:read'] }];
    const mutationSecurity = [{ adminSession: [], csrfToken: [] }];
    routes.get('/api/v1/scripts', { config: readConfig, preValidation: rejectBody, schema: { operationId: 'listScripts', tags: ['Pine scripts'], security: readSecurity, querystring: emptyQuerySchema, response: { 200: { type: 'object', additionalProperties: false, required: ['scripts'], properties: { scripts: { type: 'array', items: scriptSchema } } }, ...errorResponses } } }, async () => ({ scripts: app.services.scripts.list() }));
    routes.post<{ Body: CreateScript }>('/api/v1/scripts', { config: adminConfig, bodyLimit: 2 * 1024 * 1024, schema: { operationId: 'createScript', tags: ['Pine scripts'], security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema, body: createSchema, response: { 201: responseSchema, ...errorResponses } } }, async (request, reply) => reply.code(201).send(app.services.scripts.create(request.body)));
    routes.get<{ Params: { id: string } }>('/api/v1/scripts/:id', { config: readConfig, preValidation: rejectBody, schema: { operationId: 'getScript', tags: ['Pine scripts'], security: readSecurity, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: responseSchema, ...errorResponses } } }, async (request) => app.services.scripts.get(request.params.id));
    routes.put<{ Params: { id: string }; Body: UpdateScript }>('/api/v1/scripts/:id', { config: adminConfig, bodyLimit: 2 * 1024 * 1024, schema: { operationId: 'reviseScript', tags: ['Pine scripts'], security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, body: updateSchema, response: { 200: responseSchema, ...errorResponses } } }, async (request) => app.services.scripts.update(request.params.id, request.body));
    routes.delete<{ Params: { id: string } }>('/api/v1/scripts/:id', { config: adminConfig, preValidation: rejectBody, schema: { operationId: 'archiveScript', tags: ['Pine scripts'], description: 'Archive the library entry. Immutable revision IDs remain readable and usable by existing jobs and future server references.', security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, response: { 204: { type: 'null' }, ...errorResponses } } }, async (request, reply) => { app.services.scripts.archive(request.params.id); return reply.code(204).send(); });
    routes.get<{ Params: { id: string } }>('/api/v1/scripts/:id/revisions', { config: readConfig, preValidation: rejectBody, schema: { operationId: 'listScriptRevisions', tags: ['Pine scripts'], security: readSecurity, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: { type: 'object', additionalProperties: false, required: ['revisions'], properties: { revisions: { type: 'array', items: revisionSchema } } }, ...errorResponses } } }, async (request) => ({ revisions: app.services.scripts.revisions(request.params.id) }));
  });
}
