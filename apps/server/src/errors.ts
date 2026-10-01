import type { FastifyError, FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../packages/contracts/src/index.js';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'The server could not complete this request.';
    let details: unknown;
    if (error instanceof ApiError) {
      status = error.statusCode;
      code = error.code;
      message = error.message;
      details = error.details;
      if (error.retryAfter !== undefined) reply.header('Retry-After', String(error.retryAfter));
    } else if (error.validation) {
      status = 400;
      code = 'INVALID_SCHEMA';
      message = 'The request does not match the API schema.';
      details = error.validation.map((issue) => ({ path: issue.instancePath, keyword: issue.keyword, message: issue.message }));
    } else if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 400) {
      status = 400;
      code = 'INVALID_REQUEST';
      message = 'Provide a valid request body with the supported content type and size.';
    } else if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
      status = 409;
      code = 'STATE_CONFLICT';
      message = 'This request conflicts with persisted state.';
    } else if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
      status = 503;
      code = 'DATABASE_UNAVAILABLE';
      message = 'The database is busy. Retry shortly.';
      reply.header('Retry-After', '1');
    } else if (error.statusCode === 404) {
      status = 404;
      code = 'NOT_FOUND';
      message = 'The requested resource was not found.';
    }
    if (status === 500) {
      // Never log raw SQL/body/provider errors: future integrations can include credentials in them.
      request.log.error({ errorCode: error.code ?? 'UNKNOWN', errorName: error.name }, 'Request failed');
    }
    const body: ErrorEnvelope = { error: { code, message, ...(details === undefined ? {} : { details }) } };
    reply.header('Cache-Control', 'no-store').status(status).send(body);
  });
}
