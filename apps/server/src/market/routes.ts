import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { emptyQuerySchema, errorResponses, mutationHeadersSchema } from '../../../../packages/contracts/src/index.js';
import { TIMEFRAMES, barSchema, marketRefSchema, type BarRange, type DatasetImport, type MarketEvent, type MarketRef } from '../../../../packages/contracts/src/market.js';
import { ApiError } from '../errors.js';
import '../types.js';
import { DATASET_FIELDS, MAX_DATASET_BYTES } from './datasets.js';
import type { MarketService } from './MarketService.js';

const timestamp = { type: 'integer', minimum: 0 } as const;
const provider = { type: 'string', enum: ['binance', 'coinbase', 'csv'] } as const;
const timeframe = { type: 'string', enum: TIMEFRAMES } as const;
const decimal = { type: 'string', pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]*[1-9])?$' } as const;
const nullableTimestamp = { anyOf: [timestamp, { type: 'null' }] } as const;
const marketQuery = { type: 'object', additionalProperties: false, required: ['provider', 'symbol'], properties: { provider, symbol: { type: 'string', minLength: 1, maxLength: 100 } } } as const;
const rangeProperties = {
  replaySessionId: { type: 'string', format: 'uuid', description: 'Active server replay session; only frozen bars closed by its acknowledged cursor are returned.' },
  timeframe,
  from: { type: 'string', pattern: '^(?:0|[1-9][0-9]*)$', description: 'Inclusive UTC epoch-ms bar open.' },
  to: { type: 'string', pattern: '^(?:0|[1-9][0-9]*)$', description: 'Exclusive UTC epoch-ms bar open; next page uses nextBefore.' },
  limit: { type: 'string', pattern: '^[1-9][0-9]{0,3}$', description: 'Newest bar count, default 500, maximum 5000.' },
} as const;
const barsQuery = { ...marketQuery, required: ['provider', 'symbol', 'timeframe'], properties: { ...marketQuery.properties, ...rangeProperties } } as const;
const quoteSchema = {
  type: 'object', additionalProperties: false, required: ['market', 'price', 'observedAt', 'status', 'changePercent'],
  properties: { market: marketRefSchema, price: decimal, observedAt: timestamp, status: { type: 'string', enum: ['live', 'stale', 'historical'] }, changePercent: { anyOf: [{ type: 'number' }, { type: 'null' }] } },
} as const;
const instrumentSchema = {
  type: 'object', additionalProperties: false, required: ['market', 'name', 'baseCurrency', 'quoteCurrency', 'tickSize', 'quantityStep', 'timeframes'],
  properties: { market: marketRefSchema, name: { type: 'string' }, baseCurrency: { type: 'string' }, quoteCurrency: { type: 'string' }, tickSize: decimal, quantityStep: decimal, timeframes: { type: 'array', items: timeframe } },
} as const;
const pageSchema = {
  type: 'object', additionalProperties: false, required: ['asOf', 'status', 'bars', 'nextBefore', 'gaps'],
  properties: {
    asOf: timestamp, status: { type: 'string', enum: ['live', 'stale', 'historical'] }, bars: { type: 'array', items: barSchema }, nextBefore: nullableTimestamp,
    gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: timestamp, to: timestamp } } },
    providerError: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, retryAfter: { type: 'number', minimum: 0 } } },
  },
} as const;
const datasetProperties = {
  name: { type: 'string', minLength: 1, maxLength: 100 }, baseCurrency: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9._-]{0,19}$' }, quoteCurrency: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9._-]{0,19}$' },
  timeframe, tickSize: { ...decimal, maxLength: 100 }, quantityStep: { ...decimal, maxLength: 100 },
} as const;
const datasetSchema = { type: 'object', additionalProperties: false, required: [...DATASET_FIELDS, 'id', 'rowCount', 'createdAt', 'sourceHash'], properties: { ...datasetProperties, id: { type: 'string', format: 'uuid' }, rowCount: { type: 'integer', minimum: 1 }, createdAt: timestamp, sourceHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } as const;
const commandVariant = (type: 'subscribe' | 'unsubscribe', channel: 'bars' | 'quotes') => ({
  type: 'object', additionalProperties: false, required: channel === 'bars' ? ['type', 'channel', 'market', 'timeframe'] : ['type', 'channel', 'market'],
  properties: { type: { type: 'string', const: type }, channel: { type: 'string', const: channel }, market: marketRefSchema, ...(channel === 'bars' ? { timeframe } : {}) },
});
const streamCommandSchema = { $id: 'MarketStreamCommand', oneOf: [commandVariant('subscribe', 'bars'), commandVariant('subscribe', 'quotes'), commandVariant('unsubscribe', 'bars'), commandVariant('unsubscribe', 'quotes')] };
const streamEventSchema = {
  $id: 'MarketStreamEvent', type: 'object', additionalProperties: false, required: ['type', 'subscriptionId', 'sequence', 'payload'],
  properties: { type: { type: 'string', enum: ['bar', 'quote', 'status'] }, subscriptionId: { type: 'string' }, sequence: { type: 'integer', minimum: 1 }, payload: { oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'bar', 'receivedAt'], properties: { kind: { type: 'string', enum: ['update', 'close'] }, bar: barSchema, receivedAt: timestamp } },
    quoteSchema,
    { type: 'object', additionalProperties: false, required: ['status', 'message', 'receivedAt'], properties: { status: { type: 'string', enum: ['live', 'stale', 'historical', 'unsubscribed', 'error'] }, message: { type: 'string' }, receivedAt: timestamp, code: { type: 'string' } } },
  ] } },
};
interface BarsQuery { provider: MarketRef['provider']; symbol: string; timeframe: string; replaySessionId?: string; from?: string; to?: string; limit?: string }
interface StreamCommand { type: 'subscribe' | 'unsubscribe'; channel: 'bars' | 'quotes'; market: MarketRef; timeframe?: string }

export async function registerMarketRoutes(app: FastifyInstance, service: MarketService): Promise<void> {
  app.addSchema(streamCommandSchema);
  app.addSchema(streamEventSchema);
  await app.register(async (routes) => {
    await routes.register(multipart, { limits: { fileSize: MAX_DATASET_BYTES, files: 1, fields: 6, parts: 7, fieldNameSize: 100, fieldSize: 1024 }, throwFileSizeLimit: true });
    const config = { security: { access: 'data' as const, scopes: ['market:read' as const] } };
    const security: Array<Record<string, readonly string[]>> = [{ adminSession: [] }, { bearerKey: ['market:read'] }];
    routes.get('/api/v1/providers', { config, schema: { operationId: 'listProviders', tags: ['Market data'], summary: 'List fixed-venue providers and historical imports', security, querystring: emptyQuerySchema, response: { 200: { type: 'object', additionalProperties: false, required: ['providers'], properties: { providers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'status', 'timeframes'], properties: { id: provider, name: { type: 'string' }, status: { type: 'string', enum: ['available', 'unavailable', 'historical'] }, timeframes: { type: 'array', items: timeframe } } } } } }, ...errorResponses } } }, async () => ({ providers: service.listProviders() }));
    routes.get<{ Querystring: { provider: string; q?: string } }>('/api/v1/markets', { config, schema: { operationId: 'listMarkets', tags: ['Market data'], summary: 'Find instruments without merging venues or quote currencies', security, querystring: { type: 'object', additionalProperties: false, required: ['provider'], properties: { provider, q: { type: 'string', maxLength: 100 } } }, response: { 200: { type: 'object', additionalProperties: false, required: ['markets'], properties: { markets: { type: 'array', items: instrumentSchema } } }, ...errorResponses } } }, async (request) => ({ markets: await service.listMarkets(request.query.provider, request.query.q) }));
    routes.get<{ Querystring: BarsQuery }>('/api/v1/bars', { config, schema: { operationId: 'getBars', tags: ['Market data'], summary: 'Read newest ascending unique OHLCV in a half-open range', description: 'Default limit 500, maximum 5000. Follow exclusive to=nextBefore until null. Gaps report missing native candles; aggregates never synthesize candles. Stale cached pages include providerError; an uncached provider failure is an error, not empty history.', security, querystring: barsQuery, response: { 200: pageSchema, ...errorResponses } } }, async (request) => {
      const query = request.query;
      const range: BarRange = { ...(query.from === undefined ? {} : { from: Number(query.from) }), ...(query.to === undefined ? {} : { to: Number(query.to) }), ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) };
      const market = { provider: query.provider, symbol: query.symbol };
      return query.replaySessionId ? app.services.replay.getBars(query.replaySessionId, market, query.timeframe, range) : service.getBars(market, query.timeframe, range);
    });
    routes.get<{ Querystring: { provider: MarketRef['provider']; symbol: string; replaySessionId?: string } }>('/api/v1/quotes', { config, schema: { operationId: 'getQuote', tags: ['Market data'], summary: 'Read latest observed price with explicit provenance and freshness', description: 'Not an executable bid/ask. Imported dataset closing prices are always historical and cannot feed live execution. With replaySessionId, only the latest revealed frozen close is returned; stopped sessions conflict.', security, querystring: { ...marketQuery, properties: { ...marketQuery.properties, replaySessionId: rangeProperties.replaySessionId } }, response: { 200: quoteSchema, ...errorResponses } } }, async (request) => request.query.replaySessionId ? app.services.replay.getQuote(request.query.replaySessionId, request.query) : service.getQuote(request.query));
    routes.get<{ Querystring: BarsQuery }>('/api/v1/bars.csv', { config, schema: { operationId: 'exportBarsCsv', tags: ['Market data'], summary: 'Export the same OHLCV page/range as the bars API', description: 'CSV uses UTC epoch-ms time. X-PineTerm-Next-Before contains the next exclusive page boundary when earlier rows remain. X-PineTerm-Data-Status and X-PineTerm-Provider-Error expose stale-provider failures.', security, querystring: barsQuery, produces: ['text/csv'], response: { 200: { type: 'string' }, ...errorResponses } } }, async (request, reply) => {
      const query = request.query;
      const market = { provider: query.provider, symbol: query.symbol };
      const range = { ...(query.from === undefined ? {} : { from: Number(query.from) }), ...(query.to === undefined ? {} : { to: Number(query.to) }), ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) };
      const page = query.replaySessionId ? await app.services.replay.getBars(query.replaySessionId, market, query.timeframe, range) : await service.getBars(market, query.timeframe, range);
      reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="pineterm-bars.csv"').header('X-PineTerm-Data-Status', page.status);
      if (page.nextBefore !== null) reply.header('X-PineTerm-Next-Before', String(page.nextBefore));
      if (page.providerError) reply.header('X-PineTerm-Provider-Error', page.providerError.code);
      return `time,open,high,low,close,volume\n${page.bars.map((bar) => `${bar.time},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`).join('\n')}${page.bars.length ? '\n' : ''}`;
    });
    routes.post<{ Body: DatasetImport & { file: string } }>('/api/v1/datasets', {
      bodyLimit: MAX_DATASET_BYTES + 16 * 1024,
      config: { security: { access: 'admin' } },
      preValidation: async (request: FastifyRequest) => {
        if (!request.isMultipart()) throw new ApiError(400, 'MULTIPART_REQUIRED', 'Upload the six metadata fields and one CSV file using multipart/form-data.');
        const body: Record<string, string> = {};
        try {
          for await (const part of request.parts()) {
            if (Object.hasOwn(body, part.fieldname)) throw new ApiError(400, 'INVALID_SCHEMA', 'Duplicate multipart fields are not accepted.');
            if (part.type === 'file') {
              if (part.fieldname !== 'file') {
                part.file.resume();
                throw new ApiError(400, 'INVALID_SCHEMA', 'The CSV file part must be named file.');
              }
              const buffer = await part.toBuffer();
              if (part.file.truncated) throw new ApiError(400, 'DATASET_TOO_LARGE', 'CSV files must not exceed 10 MiB.');
              try { body.file = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
              catch { throw new ApiError(400, 'INVALID_CSV_ENCODING', 'Upload a UTF-8 CSV file.'); }
            } else {
              if (!(DATASET_FIELDS as readonly string[]).includes(part.fieldname) || typeof part.value !== 'string' || part.fieldnameTruncated || part.valueTruncated) throw new ApiError(400, 'INVALID_SCHEMA', 'Provide only the six documented metadata fields and the CSV file.');
              body[part.fieldname] = part.value;
            }
          }
        } catch (error) {
          if (error instanceof ApiError) throw error;
          if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /LIMIT|TOO_LARGE|PROTOTYPE|MULTIPART/.test(error.code)) throw new ApiError(400, 'INVALID_MULTIPART', 'Upload six metadata fields and one UTF-8 CSV file of at most 10 MiB.');
          throw error;
        }
        request.body = body;
      },
      schema: { operationId: 'importDataset', tags: ['Historical datasets'], summary: 'Atomically import validated historical OHLCV CSV', description: 'Six text metadata fields plus one file part named file (max 10 MiB). Exact header time,open,high,low,close,volume. UTC ISO-8601 Z or epoch milliseconds; seconds are rejected. Duplicate/misaligned timestamps and impossible OHLC reject the entire import. Historical datasets cannot feed live execution.', security: [{ adminSession: [], csrfToken: [] }], consumes: ['multipart/form-data'], headers: mutationHeadersSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: [...DATASET_FIELDS, 'file'], properties: { ...datasetProperties, file: { type: 'string', minLength: 1, maxLength: MAX_DATASET_BYTES, description: 'CSV file part named file; UTF-8 bytes, not a JSON body.' } } }, response: { 201: { type: 'object', additionalProperties: false, required: ['dataset'], properties: { dataset: datasetSchema } }, ...errorResponses } },
    }, async (request, reply) => {
      const { file, ...meta } = request.body;
      return reply.code(201).send({ dataset: service.importDataset(meta, file) });
    });
    routes.get('/api/v1/stream', {
      websocket: true, config,
      schema: { operationId: 'streamMarketData', tags: ['Market data'], summary: 'Upgrade to authenticated reference-counted market streaming', description: 'Requires exact Origin and market:read or admin session. At most 16 subscriptions per socket. Client messages match MarketStreamCommand; server messages match MarketStreamEvent. Subscription ID is channel:provider:symbol:timeframe (quotes use 1). Sequence increases for every message within a subscription. Refetch bars after reconnect. Commands cannot include unsupported fields or a quotes timeframe.', security, querystring: emptyQuerySchema, response: { 101: { description: 'Authenticated WebSocket market events', type: 'null' }, ...errorResponses } },
      preValidation: async (request) => { app.security.authorizeWebSocket(request, ['market:read']); },
    }, (socket, request) => {
      const subscriptions = new Map<string, { stop: () => void; sequence: number; active: boolean }>();
      let socketSequence = 0;
      const validate = app.getSchema('MarketStreamCommand')!;
      const validCommand = app.validatorCompiler!({ schema: validate, method: 'GET', url: '/api/v1/stream', httpPart: 'body' });
      const send = (subscriptionId: string, type: 'bar' | 'quote' | 'status', payload: unknown): void => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Client must refetch after falling behind.'); return; }
        const entry = subscriptions.get(subscriptionId);
        const sequence = entry ? ++entry.sequence : ++socketSequence;
        socket.send(JSON.stringify({ type, subscriptionId, sequence, payload }));
      };
      const status = (id: string, state: string, message: string, code?: string): void => send(id, 'status', { status: state, message, receivedAt: app.services.clock(), ...(code ? { code } : {}) });
      const disconnect = (): void => {
        clearInterval(authTimer);
        for (const entry of subscriptions.values()) { entry.active = false; entry.stop(); }
        subscriptions.clear();
      };
      const authTimer = setInterval(() => {
        try { app.security.authorizeWebSocket(request, ['market:read']); }
        catch { socket.close(1008, 'Authentication expired or revoked.'); }
      }, 15_000);
      authTimer.unref();
      socket.on('close', disconnect);
      socket.on('error', disconnect);
      socket.on('message', (raw, binary) => {
        let command: StreamCommand;
        try {
          if (binary) throw new ApiError(400, 'INVALID_STREAM_COMMAND', 'Send a JSON text command.');
          const parsed: unknown = JSON.parse(raw.toString());
          const valid = validCommand(parsed);
          if (!valid) throw new ApiError(400, 'INVALID_STREAM_COMMAND', 'Command must match MarketStreamCommand without extra fields.');
          command = parsed as StreamCommand;
          app.security.authorizeWebSocket(request, ['market:read']);
        } catch (error) {
          status('', 'error', error instanceof ApiError ? error.message : 'Send a valid JSON stream command.', error instanceof ApiError ? error.code : 'INVALID_STREAM_COMMAND');
          return;
        }
        const id = `${command.channel}:${command.market.provider}:${command.market.symbol}:${command.timeframe ?? '1'}`;
        if (command.type === 'unsubscribe') {
          const entry = subscriptions.get(id);
          if (entry) {
            entry.active = false;
            entry.stop();
            status(id, 'unsubscribed', 'Subscription released.');
            subscriptions.delete(id);
          } else status(id, 'error', 'This subscription does not exist.', 'SUBSCRIPTION_NOT_FOUND');
          return;
        }
        if (subscriptions.has(id)) { status(id, 'live', 'Subscription already active.'); return; }
        if (subscriptions.size >= 16) { status(id, 'error', 'At most 16 subscriptions may be active.', 'SUBSCRIPTION_LIMIT'); return; }
        const entry = { stop: () => {}, sequence: 0, active: true };
        subscriptions.set(id, entry);
        try {
          if (command.market.provider === 'csv') {
            entry.stop = () => {};
            if (command.channel === 'quotes') {
              void service.getQuote(command.market).then((quote) => { if (entry.active) { send(id, 'quote', quote); status(id, 'historical', 'Imported closing price; no live feed.'); } }).catch((error: unknown) => { if (entry.active) { status(id, 'error', error instanceof ApiError ? error.message : 'Dataset unavailable.', error instanceof ApiError ? error.code : 'DATASET_UNAVAILABLE'); subscriptions.delete(id); } });
            } else {
              throw new ApiError(422, 'HISTORICAL_FEED', 'Imported datasets have no live stream; fetch historical bars.');
            }
          } else {
            const onEvent = (event: MarketEvent): void => {
              if (!entry.active) return;
              if (event.kind === 'status') send(id, 'status', { status: event.status, message: event.message, receivedAt: event.receivedAt });
              else if (command.channel === 'bars' && (event.kind === 'update' || event.kind === 'close')) send(id, 'bar', event);
              else if (command.channel === 'quotes' && event.kind === 'quote') send(id, 'quote', event.quote);
            };
            entry.stop = service.subscribeBars(command.market, command.timeframe ?? '1', onEvent);
            if (command.channel === 'quotes') void service.getQuote(command.market).then((quote) => { if (entry.active) send(id, 'quote', quote); }).catch((error: unknown) => { if (entry.active) status(id, 'stale', error instanceof ApiError ? error.message : 'Provider quote unavailable.', error instanceof ApiError ? error.code : 'PROVIDER_UNAVAILABLE'); });
          }
        } catch (error) {
          entry.active = false;
          entry.stop();
          status(id, 'error', error instanceof ApiError ? error.message : 'Provider subscription unavailable.', error instanceof ApiError ? error.code : 'PROVIDER_UNAVAILABLE');
          subscriptions.delete(id);
        }
      });
    });
  });
}
