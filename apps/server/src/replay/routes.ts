import type { FastifyInstance, FastifyRequest } from 'fastify';
import { emptyQuerySchema, errorResponses, idParamsSchema, marketRefSchema, mutationHeadersSchema, TIMEFRAMES, type ReplayRequest } from '@pineterm/contracts';
import { ApiError } from '../errors.js';
import type { ReplayService } from './ReplayService.js';
import '../types.js';

const timestamp = { type: 'integer', minimum: 0, maximum: 8_640_000_000_000_000 } as const;
const amount = { type: 'string', maxLength: 100, pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]*[1-9])?$' } as const;
const replayMarketSchema = { type: 'object', additionalProperties: false, required: ['market', 'timeframe'], properties: { market: marketRefSchema, timeframe: { type: 'string', enum: TIMEFRAMES } } } as const;
const sessionSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'accountId', 'state', 'markets', 'baseTimeframe', 'from', 'to', 'cursor', 'revision', 'createdAt', 'updatedAt'],
  properties: { id: { type: 'string', format: 'uuid' }, accountId: { type: 'string', format: 'uuid' }, state: { type: 'string', enum: ['active', 'stopped'] }, markets: { type: 'array', items: replayMarketSchema }, baseTimeframe: { type: 'string', enum: TIMEFRAMES }, from: timestamp, to: timestamp, cursor: timestamp, revision: { type: 'integer', minimum: 1 }, createdAt: timestamp, updatedAt: timestamp },
} as const;
const responseSchema = { type: 'object', additionalProperties: false, required: ['session'], properties: { session: sessionSchema } } as const;

export async function registerReplayRoutes(app: FastifyInstance, service: ReplayService): Promise<void> {
  await app.register(async routes => {
    const config = { security: { access: 'admin' as const } };
    const security = [{ adminSession: [] }];
    const mutationSecurity = [{ adminSession: [], csrfToken: [] }];
    routes.post<{ Body: ReplayRequest }>('/api/v1/replay-sessions', { config, schema: {
      operationId: 'createReplay', tags: ['Replay'], summary: 'Freeze a complete confirmed raw-history window and create a separate replay spot account',
      description: 'One to eight chart series, 50,000 frozen bars including secondary history. Window boundaries must align to every chart interval and share the smallest base clock. Missing candles reject the entire request, never silently shorten it. Other quote-currency charts remain chart-only; paper orders require an exact currency match. Replay is not authority for notifications or live executor intents.',
      security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema,
      body: { type: 'object', additionalProperties: false, required: ['markets', 'from', 'to', 'quoteCurrency'], properties: { markets: { type: 'array', minItems: 1, maxItems: 8, items: replayMarketSchema }, from: timestamp, to: timestamp, quoteCurrency: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9._-]{0,19}$' }, initialBalance: amount, commissionBps: amount, slippageBps: amount } },
      response: { 201: responseSchema, ...errorResponses },
    } }, async (request, reply) => reply.code(201).send({ session: await service.create(request.body) }));
    routes.get<{ Params: { id: string } }>('/api/v1/replay-sessions/:id', { config, schema: { operationId: 'getReplay', tags: ['Replay'], summary: 'Read the persisted acknowledged replay cursor and isolated account ID', security, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: responseSchema, ...errorResponses } } }, async request => ({ session: service.get(request.params.id) }));
    for (const action of ['step', 'stop'] as const) routes.post<{ Params: { id: string } }>(`/api/v1/replay-sessions/:id/${action}`, {
      config, preValidation: async (request: FastifyRequest) => { if (request.body !== undefined) throw new ApiError(400, 'INVALID_SCHEMA', 'This replay operation does not accept a body.'); },
      schema: { operationId: action === 'step' ? 'stepReplay' : 'stopReplay', tags: ['Replay'], summary: action === 'step' ? 'Atomically fill eligible replay orders against the next base-bar OHLC and acknowledge its close' : 'Stop replay, cancel pending orders and archive its isolated account without deleting history', security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: responseSchema, ...errorResponses } },
    }, async request => ({ session: service[action](request.params.id) }));
  });
}
