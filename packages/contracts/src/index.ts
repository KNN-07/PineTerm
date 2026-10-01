export const API_KEY_SCOPES = [
  'market:read',
  'scripts:read',
  'backtests:run',
  'paper:read',
  'paper:trade',
  'live:intent',
  'executor:claim',
  'executor:report',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export type DecimalString = string;

export interface Session {
  authenticated: true;
  csrfToken: string;
}

export interface LoginBody {
  password: string;
}

export interface ApiKey {
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  executorId: string | null;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface CreateApiKeyBody {
  name: string;
  scopes: ApiKeyScope[];
  executorId?: string;
}

export interface ApiKeyList {
  keys: ApiKey[];
}

export interface CreateApiKeyResponse {
  key: ApiKey;
  token: string;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ApiMetadata {
  name: 'PineTerm';
  version: string;
  sourceUrl: string;
  sourceRevision: string | null;
  license: 'AGPL-3.0-only';
  milestone: number;
  capabilities: string[];
}

export const INVALIDATION_TYPES = [
  'api-keys.changed',
  'paper.changed',
  'alerts.changed',
  'jobs.changed',
  'workspaces.changed',
  'watchlists.changed',
  'scripts.changed',
  'live-intents.changed',
] as const;

export type InvalidationType = (typeof INVALIDATION_TYPES)[number];

export interface InvalidationEvent {
  id: string;
  type: InvalidationType;
  resourceId: string;
  revision: number;
}

const uuid = { type: 'string', format: 'uuid' } as const;
const timestamp = { type: 'integer', minimum: 0 } as const;
const nullableTimestamp = { anyOf: [timestamp, { type: 'null' }] } as const;
const nullableUuid = { anyOf: [uuid, { type: 'null' }] } as const;

export const decimalStringSchema = {
  $id: 'DecimalString',
  type: 'string',
  pattern: '^(?:0|[1-9][0-9]*(?:\\.[0-9]*[1-9])?|0\\.[0-9]*[1-9]|-(?:[1-9][0-9]*(?:\\.[0-9]*[1-9])?|0\\.[0-9]*[1-9]))$',
  description: 'Canonical base-10 decimal: no exponent, leading zeros, trailing fractional zeros or negative zero.',
} as const;

export const errorSchema = {
  $id: 'ErrorEnvelope',
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
      },
    },
  },
} as const;

export const sessionSchema = {
  $id: 'Session',
  type: 'object',
  additionalProperties: false,
  required: ['authenticated', 'csrfToken'],
  properties: {
    authenticated: { type: 'boolean', const: true },
    csrfToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
  },
} as const;

export const loginBodySchema = {
  $id: 'LoginBody',
  type: 'object',
  additionalProperties: false,
  required: ['password'],
  properties: {
    password: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

export const apiKeySchema = {
  $id: 'ApiKey',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'scopes', 'executorId', 'createdAt', 'revokedAt', 'lastUsedAt'],
  properties: {
    id: uuid,
    name: { type: 'string', minLength: 1, maxLength: 100 },
    scopes: {
      type: 'array',
      minItems: 1,
      maxItems: API_KEY_SCOPES.length,
      uniqueItems: true,
      items: { type: 'string', enum: API_KEY_SCOPES },
    },
    executorId: nullableUuid,
    createdAt: timestamp,
    revokedAt: nullableTimestamp,
    lastUsedAt: nullableTimestamp,
  },
} as const;

export const createApiKeyBodySchema = {
  $id: 'CreateApiKeyBody',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'scopes'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
    scopes: apiKeySchema.properties.scopes,
    executorId: uuid,
  },
  allOf: [{
    if: { properties: { scopes: { type: 'array', contains: { enum: ['executor:claim', 'executor:report'] } } } },
    then: { required: ['executorId'] },
    else: { not: { required: ['executorId'] } },
  }],
} as const;

export const apiKeyListSchema = {
  $id: 'ApiKeyList',
  type: 'object',
  additionalProperties: false,
  required: ['keys'],
  properties: { keys: { type: 'array', items: { $ref: 'ApiKey#' } } },
} as const;

export const createApiKeyResponseSchema = {
  $id: 'CreateApiKeyResponse',
  type: 'object',
  additionalProperties: false,
  required: ['key', 'token'],
  properties: {
    key: { $ref: 'ApiKey#' },
    token: { type: 'string', pattern: '^ptk_[A-Za-z0-9_-]{43}$', description: 'Shown only in this response; store securely.' },
  },
} as const;

export const apiMetadataSchema = {
  $id: 'ApiMetadata',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'version', 'sourceUrl', 'sourceRevision', 'license', 'milestone', 'capabilities'],
  properties: {
    name: { type: 'string', const: 'PineTerm' },
    version: { type: 'string' },
    sourceUrl: { type: 'string', format: 'uri' },
    sourceRevision: { anyOf: [{ type: 'string', pattern: '^[a-f0-9]{40}$' }, { type: 'null' }] },
    license: { type: 'string', const: 'AGPL-3.0-only' },
    milestone: { type: 'integer', minimum: 1 },
    capabilities: { type: 'array', items: { type: 'string' }, uniqueItems: true },
  },
} as const;

export const invalidationEventSchema = {
  $id: 'InvalidationEvent',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'resourceId', 'revision'],
  properties: {
    id: uuid,
    type: { type: 'string', enum: INVALIDATION_TYPES },
    resourceId: uuid,
    revision: { type: 'integer', minimum: 1 },
  },
} as const;

export const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: uuid },
} as const;

export const mutationHeadersSchema = {
  type: 'object',
  properties: {
    origin: { type: 'string', maxLength: 2048 },
    'x-csrf-token': { type: 'string', maxLength: 256 },
  },
  additionalProperties: true,
} as const;

export const emptyQuerySchema = { type: 'object', additionalProperties: false, properties: {} } as const;

export const sharedSchemas = [
  decimalStringSchema,
  errorSchema,
  sessionSchema,
  loginBodySchema,
  apiKeySchema,
  createApiKeyBodySchema,
  apiKeyListSchema,
  createApiKeyResponseSchema,
  apiMetadataSchema,
  invalidationEventSchema,
] as const;

export const errorResponses = Object.fromEntries(
  [400, 401, 403, 404, 409, 422, 429, 500, 503].map((status) => [status, { $ref: 'ErrorEnvelope#' }]),
);
