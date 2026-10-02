import type { FastifyInstance, FastifyRequest } from 'fastify';
import { emptyQuerySchema, errorResponses, idParamsSchema, mutationHeadersSchema } from '../../../../packages/contracts/src/index.js';
import type { BacktestRequest, PineValue } from '../../../../packages/contracts/src/pine.js';
import { ApiError } from '../errors.js';
import '../types.js';
import { backtestJobSchema, backtestRequestSchema, jobResponseSchema, pineValidationSchema, validateBodySchema } from './schemas.js';

async function rejectBody(request: FastifyRequest): Promise<void> {
  if (request.body !== undefined) throw new ApiError(400, 'INVALID_SCHEMA', 'This operation does not accept a request body.');
}

export async function registerPineRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (routes) => {
    const config = { security: { access: 'data' as const, scopes: ['backtests:run' as const] } };
    const security: Array<Record<string, readonly string[]>> = [{ adminSession: [] }, { bearerKey: ['backtests:run'] }];
    const mutationSecurity: Array<Record<string, readonly string[]>> = [{ adminSession: [], csrfToken: [] }, { bearerKey: ['backtests:run'] }];
    routes.post<{ Body: { source: string; inputs?: Record<string, PineValue>; props?: Record<string, PineValue> } }>('/api/v1/scripts/validate', {
      config, bodyLimit: 512 * 1024,
      schema: { operationId: 'validatePine', tags: ['Pine'], summary: 'Compile Pine v5/v6 and inspect declaration/input schemas in the isolated Docker runner',
        description: 'Compiler/override diagnostics return valid:false. Docker/image unavailability returns 503; source never runs in the API process. This is compilation/metadata validation, not a guarantee all runtime-dependent expressions succeed.',
        security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema, body: validateBodySchema, response: { 200: pineValidationSchema, ...errorResponses } },
    }, async (request) => app.services.pine.validate(request.body.source, request.body.inputs ?? {}, request.body.props ?? {}));
    routes.post<{ Body: BacktestRequest }>('/api/v1/backtests', {
      config, bodyLimit: 128 * 1024,
      schema: { operationId: 'createBacktest', tags: ['Backtests'], summary: 'Queue an immutable strategy backtest after complete confirmed-history preflight',
        description: 'Explicit overrides win over source declarations then PineTS defaults. Maximum two concurrent runner jobs, 50,000 primary+secondary bars, 20 secondary series, 10s compilation, 60s whole execution. Every selected range must be bar-aligned and fully covered. Only the selected data provider and raw confirmed bars are used. PineTS 0.10.0 strips request.security venue prefixes before its provider seam; dynamically constructed foreign-prefix intent cannot be verified, although this broker never switches actual provider.',
        security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema, body: backtestRequestSchema,
        response: { 202: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: { type: 'string', format: 'uuid' } } }, ...errorResponses } },
    }, async (request, reply) => reply.code(202).send({ jobId: await app.services.pine.submit(request.body) }));
    routes.get('/api/v1/backtests', { config,
      schema: { operationId: 'listBacktests', tags: ['Backtests'], summary: 'List the most recent 100 backtest job records; fetch a job by ID for immutable results', security, querystring: emptyQuerySchema,
        response: { 200: { type: 'object', additionalProperties: false, required: ['jobs'], properties: { jobs: { type: 'array', maxItems: 100, items: backtestJobSchema } } }, ...errorResponses } },
    }, async () => ({ jobs: app.services.pine.list() }));
    routes.get<{ Params: { id: string } }>('/api/v1/backtests/:id', { config,
      schema: { operationId: 'getBacktest', tags: ['Backtests'], summary: 'Read persisted job state, immutable results and complete provenance', security, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: jobResponseSchema, ...errorResponses } },
    }, async (request) => ({ job: app.services.pine.get(request.params.id) }));
    routes.post<{ Params: { id: string } }>('/api/v1/backtests/:id/cancel', { config, preValidation: rejectBody,
      schema: { operationId: 'cancelBacktest', tags: ['Backtests'], summary: 'Cancel a queued/running job and kill its isolated container', security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: jobResponseSchema, ...errorResponses } },
    }, async (request) => ({ job: await app.services.pine.cancel(request.params.id) }));
    routes.get<{ Params: { id: string } }>('/api/v1/backtests/:id/trades.csv', { config,
      schema: { operationId: 'exportBacktestTrades', tags: ['Backtests'], summary: 'Download all open and closed trades from a completed immutable result', security, params: idParamsSchema, querystring: emptyQuerySchema, response: { 200: { type: 'string' }, ...errorResponses } },
    }, async (request, reply) => {
      const job = app.services.pine.get(request.params.id);
      if (job.state !== 'succeeded' || !job.result) throw new ApiError(409, 'BACKTEST_NOT_COMPLETE', 'Trades are available only after a successful backtest.');
      const headers = ['id', 'entryId', 'exitId', 'side', 'quantity', 'entryPrice', 'exitPrice', 'entryTime', 'exitTime', 'entryBarIndex', 'exitBarIndex', 'profit', 'commission', 'status'] as const;
      const rows = job.result.trades.map((trade) => headers.map((key) => {
        const value = trade[key];
        if (value === null) return '';
        const text = String(value);
        // Quote all strings and neutralize spreadsheet formulas in user-owned order IDs.
        return typeof value === 'string' ? `"${(/^[=+@-]/.test(text) && (key === 'id' || key === 'entryId' || key === 'exitId') ? `'${text}` : text).replaceAll('"', '""')}"` : text;
      }).join(','));
      return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="pineterm-backtest-${job.id}.csv"`).send([headers.join(','), ...rows].join('\r\n') + '\r\n');
    });
  });
}
