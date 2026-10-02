import type { FastifyInstance, FastifyRequest } from 'fastify';
import { emptyQuerySchema, errorResponses, idParamsSchema, mutationHeadersSchema, type ApplyAgentDraft, type UpdateAgentDraft } from '@pineterm/contracts';
import { ApiError } from '../errors.js';
import { pineDiagnosticSchema, pineOverridesSchema, pineValidationSchema, storedOverridesSchema } from '../pine/schemas.js';
import '../types.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const time = { type: 'integer', minimum: 0 } as const;
const revisionNumber = { type: 'integer', minimum: 1 } as const;
const nullableUuid = { anyOf: [uuid, { type: 'null' }] } as const;
const source = { type: 'string', minLength: 1, maxLength: 262144 } as const;
const name = { type: 'string', minLength: 1, maxLength: 100 } as const;
const overrides = { ...pineOverridesSchema, propertyNames: { ...pineOverridesSchema.propertyNames, not: { type: 'string', enum: ['__proto__', 'constructor', 'prototype'] } } } as const;
export const agentDraftSchema = { type: 'object', additionalProperties: false, required: ['id', 'sessionId', 'name', 'revision', 'source', 'baseSource', 'scriptId', 'baseRevisionId', 'inputs', 'props', 'validation', 'diagnostics', 'appliedRevisionId', 'createdAt', 'updatedAt'], properties: { id: uuid, sessionId: uuid, name, revision: revisionNumber, source, baseSource: { anyOf: [source, { type: 'null' }] }, scriptId: nullableUuid, baseRevisionId: nullableUuid, inputs: storedOverridesSchema, props: storedOverridesSchema, validation: { anyOf: [pineValidationSchema, { type: 'null' }] }, diagnostics: { type: 'array', items: pineDiagnosticSchema }, appliedRevisionId: nullableUuid, createdAt: time, updatedAt: time } } as const;
const draftResponse = { type: 'object', additionalProperties: false, required: ['draft'], properties: { draft: agentDraftSchema } } as const;
const scriptSchema = { type: 'object', additionalProperties: false, required: ['id', 'name', 'revision', 'currentRevisionId', 'archivedAt', 'createdAt', 'updatedAt'], properties: { id: uuid, name, revision: revisionNumber, currentRevisionId: uuid, archivedAt: { anyOf: [time, { type: 'null' }] }, createdAt: time, updatedAt: time } } as const;
const revisionSchema = { type: 'object', additionalProperties: false, required: ['id', 'scriptId', 'revision', 'source', 'sourceHash', 'languageVersion', 'inputs', 'props', 'createdAt'], properties: { id: uuid, scriptId: uuid, revision: revisionNumber, source, sourceHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, languageVersion: { type: 'integer', enum: [5, 6] }, inputs: storedOverridesSchema, props: storedOverridesSchema, createdAt: time } } as const;
const appliedResponse = { type: 'object', additionalProperties: false, required: ['draft', 'script', 'revision'], properties: { draft: agentDraftSchema, script: scriptSchema, revision: revisionSchema } } as const;
const editBody = { type: 'object', additionalProperties: false, required: ['revision', 'name', 'source', 'inputs', 'props'], properties: { revision: revisionNumber, name, source, inputs: overrides, props: overrides } } as const;
const validateBody = { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: revisionNumber } } as const;
const applyBody = { type: 'object', additionalProperties: false, required: ['revision', 'mode', 'name'], properties: { revision: revisionNumber, mode: { type: 'string', enum: ['new', 'update'] }, name } } as const;
async function rejectBody(request: FastifyRequest): Promise<void> {
  if (request.body !== undefined) throw new ApiError(400, 'INVALID_SCHEMA', 'This operation does not accept a request body.');
}

export async function registerAgentDraftRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async routes => {
    const config = { security: { access: 'admin' as const } };
    const readSecurity = [{ adminSession: [] }]; const mutationSecurity = [{ adminSession: [], csrfToken: [] }];
    routes.get<{ Params: { id: string } }>('/api/v1/agent/drafts/:id', { config, preValidation: rejectBody, schema: { operationId: 'getAgentDraft', tags: ['Agent drafts'], security: readSecurity, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: draftResponse, ...errorResponses } } }, async request => ({ draft: app.services.agentDrafts.get(request.params.id) }));
    routes.put<{ Params: { id: string }; Body: UpdateAgentDraft }>('/api/v1/agent/drafts/:id', { config, bodyLimit: 2 * 1024 * 1024, schema: { operationId: 'editAgentDraft', tags: ['Agent drafts'], security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, body: editBody, response: { 200: draftResponse, ...errorResponses } } }, async request => ({ draft: app.services.agentDrafts.update(request.params.id, request.body) }));
    routes.post<{ Params: { id: string }; Body: { revision: number } }>('/api/v1/agent/drafts/:id/validate', { config, schema: { operationId: 'validateAgentDraft', tags: ['Agent drafts'], security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, body: validateBody, response: { 200: draftResponse, ...errorResponses } } }, async request => ({ draft: await app.services.agentDrafts.validate(request.params.id, request.body.revision) }));
    routes.post<{ Params: { id: string }; Body: ApplyAgentDraft }>('/api/v1/agent/drafts/:id/apply', { config, schema: { operationId: 'applyAgentDraft', tags: ['Agent drafts'], description: 'Publish only a successfully validated current draft. Explicit new/update choice; update checks the immutable base head. Identical repeated Apply returns the original revision.', security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, body: applyBody, response: { 200: appliedResponse, ...errorResponses } } }, async request => app.services.agentDrafts.apply(request.params.id, request.body));
    routes.get<{ Params: { id: string } }>('/api/v1/agent/sessions/:id/drafts', { config, preValidation: rejectBody, schema: { operationId: 'listAgentDrafts', tags: ['Agent drafts'], security: readSecurity, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: { type: 'object', additionalProperties: false, required: ['drafts'], properties: { drafts: { type: 'array', maxItems: 100, items: agentDraftSchema } } }, ...errorResponses } } }, async request => ({ drafts: app.services.agentDrafts.list(request.params.id) }));
  });
}
