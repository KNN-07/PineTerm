import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { emptyQuerySchema, errorResponses, idParamsSchema, mutationHeadersSchema } from '../../../../packages/contracts/src/index.js';
import { marketRefSchema, type MarketRef } from '../../../../packages/contracts/src/market.js';
import type { CreateWatchlist, CreateWorkspace, UpdateWatchlist, UpdateWorkspace, Watchlist, Workspace } from '../../../../packages/contracts/src/workspace.js';
import { ApiError } from '../errors.js';
import '../types.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const nameSchema = { type: 'string', minLength: 1, maxLength: 100 } as const;
const revisionSchema = { type: 'integer', minimum: 1 } as const;
const timestampSchema = { type: 'integer', minimum: 0 } as const;
// Vela owns its state format. Neither validation nor response serialization may filter its fields.
const stateSchema = { type: 'object', additionalProperties: true } as const;
const workspaceProperties = { name: nameSchema, velaState: stateSchema, uiState: stateSchema } as const;
const watchlistProperties = {
  name: nameSchema,
  items: { type: 'array', uniqueItems: true, items: marketRefSchema },
} as const;
const resourceProperties = {
  id: { type: 'string', format: 'uuid' }, revision: revisionSchema,
  createdAt: timestampSchema, updatedAt: timestampSchema,
} as const;
const workspaceSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'name', 'revision', 'velaState', 'uiState', 'createdAt', 'updatedAt'],
  properties: { ...resourceProperties, ...workspaceProperties },
} as const;
const watchlistSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'name', 'revision', 'items', 'createdAt', 'updatedAt'],
  properties: { ...resourceProperties, ...watchlistProperties },
} as const;
const workspaceResponse = {
  type: 'object', additionalProperties: false, required: ['workspace'], properties: { workspace: workspaceSchema },
} as const;
const watchlistResponse = {
  type: 'object', additionalProperties: false, required: ['watchlist'], properties: { watchlist: watchlistSchema },
} as const;
const createWorkspaceSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'velaState', 'uiState'], properties: workspaceProperties,
} as const;
const updateWorkspaceSchema = {
  ...createWorkspaceSchema, required: ['name', 'velaState', 'uiState', 'revision'],
  properties: { ...workspaceProperties, revision: revisionSchema },
} as const;
const createWatchlistSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'items'], properties: watchlistProperties,
} as const;
const updateWatchlistSchema = {
  ...createWatchlistSchema, required: ['name', 'items', 'revision'],
  properties: { ...watchlistProperties, revision: revisionSchema },
} as const;

interface WorkspaceRow {
  id: string;
  name: string;
  revision: number;
  vela_state_json: string;
  ui_state_json: string;
  created_at: number;
  updated_at: number;
}
interface WatchlistRow {
  id: string;
  name: string;
  revision: number;
  created_at: number;
  updated_at: number;
}
interface WatchlistItemRow extends MarketRef { watchlist_id: string }
interface ResourceParams { id: string }

function workspaceFromRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id, name: row.name, revision: row.revision,
    velaState: JSON.parse(row.vela_state_json) as Workspace['velaState'],
    uiState: JSON.parse(row.ui_state_json) as Workspace['uiState'],
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function watchlistFromRow(row: WatchlistRow, items: MarketRef[]): Watchlist {
  return {
    id: row.id, name: row.name, revision: row.revision, items,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function rejectBody(request: FastifyRequest): Promise<void> {
  if (request.body !== undefined) throw new ApiError(400, 'INVALID_SCHEMA', 'This operation does not accept a request body.');
}

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (routes) => {
    const config = { security: { access: 'admin' as const } };
    const adminSecurity = [{ adminSession: [] }];
    const mutationSecurity = [{ adminSession: [], csrfToken: [] }];
    const workspaceById = app.db.prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?');
    const workspaceRows = app.db.prepare<[], WorkspaceRow>('SELECT * FROM workspaces ORDER BY updated_at DESC,id');
    const createWorkspace = app.db.prepare('INSERT INTO workspaces(id,name,revision,vela_state_json,ui_state_json,created_at,updated_at) VALUES (?,?,1,?,?,?,?)');
    const updateWorkspace = app.db.prepare('UPDATE workspaces SET name = ?,vela_state_json = ?,ui_state_json = ?,revision = revision + 1,updated_at = ? WHERE id = ? AND revision = ?');
    const deleteWorkspace = app.db.prepare('DELETE FROM workspaces WHERE id = ?');
    const watchlistById = app.db.prepare<[string], WatchlistRow>('SELECT * FROM watchlists WHERE id = ?');
    const watchlistRows = app.db.prepare<[], WatchlistRow>('SELECT * FROM watchlists ORDER BY updated_at DESC,id');
    const itemsByWatchlist = app.db.prepare<[string], MarketRef>('SELECT provider,symbol FROM watchlist_items WHERE watchlist_id = ? ORDER BY position');
    const allItems = app.db.prepare<[], WatchlistItemRow>('SELECT watchlist_id,provider,symbol FROM watchlist_items ORDER BY watchlist_id,position');
    const createWatchlist = app.db.prepare('INSERT INTO watchlists(id,name,revision,created_at,updated_at) VALUES (?,?,1,?,?)');
    const updateWatchlist = app.db.prepare('UPDATE watchlists SET name = ?,revision = revision + 1,updated_at = ? WHERE id = ? AND revision = ?');
    const deleteWatchlist = app.db.prepare('DELETE FROM watchlists WHERE id = ?');
    const deleteItems = app.db.prepare('DELETE FROM watchlist_items WHERE watchlist_id = ?');
    const createItem = app.db.prepare('INSERT INTO watchlist_items(id,watchlist_id,position,provider,symbol) VALUES (?,?,?,?,?)');

    const requireWorkspace = (id: string): WorkspaceRow => {
      const row = workspaceById.get(id);
      if (!row) throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'The workspace does not exist.');
      return row;
    };
    const requireWatchlist = (id: string): WatchlistRow => {
      const row = watchlistById.get(id);
      if (!row) throw new ApiError(404, 'WATCHLIST_NOT_FOUND', 'The watchlist does not exist.');
      return row;
    };

    routes.get('/api/v1/workspaces', {
      config,
      schema: {
        operationId: 'listWorkspaces', tags: ['Workspaces'], summary: 'List named workspaces with complete chart and UI state',
        security: adminSecurity, querystring: emptyQuerySchema,
        response: {
          200: { type: 'object', additionalProperties: false, required: ['workspaces'], properties: { workspaces: { type: 'array', items: workspaceSchema } } },
          ...errorResponses,
        },
      },
    }, async () => ({ workspaces: workspaceRows.all().map(workspaceFromRow) }));

    routes.post<{ Body: CreateWorkspace }>('/api/v1/workspaces', {
      config, bodyLimit: MAX_BODY_BYTES,
      schema: {
        operationId: 'createWorkspace', tags: ['Workspaces'], summary: 'Create a named workspace without altering opaque chart state',
        description: 'Complete JSON body is limited to 2 MiB. Vela and UI state objects are preserved without version validation or field filtering.',
        security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema, body: createWorkspaceSchema,
        response: { 201: workspaceResponse, ...errorResponses },
      },
    }, async (request, reply) => {
      const { name, velaState, uiState } = request.body;
      const velaJson = JSON.stringify(velaState);
      const uiJson = JSON.stringify(uiState);
      const { workspace, event } = app.db.transaction(() => {
        const id = randomUUID();
        const now = app.services.clock();
        createWorkspace.run(id, name, velaJson, uiJson, now, now);
        return { workspace: workspaceFromRow(requireWorkspace(id)), event: app.events.record('workspaces.changed', id, 1) };
      }).immediate();
      app.events.emit(event);
      return reply.code(201).send({ workspace });
    });

    routes.get<{ Params: ResourceParams }>('/api/v1/workspaces/:id', {
      config,
      schema: {
        operationId: 'getWorkspace', tags: ['Workspaces'], summary: 'Read the complete saved workspace, including unsupported chart state',
        security: adminSecurity, params: idParamsSchema, querystring: emptyQuerySchema,
        response: { 200: workspaceResponse, ...errorResponses },
      },
    }, async (request) => ({ workspace: workspaceFromRow(requireWorkspace(request.params.id)) }));

    routes.put<{ Params: ResourceParams; Body: UpdateWorkspace }>('/api/v1/workspaces/:id', {
      config, bodyLimit: MAX_BODY_BYTES,
      schema: {
        operationId: 'updateWorkspace', tags: ['Workspaces'], summary: 'Replace workspace state only at its current revision',
        description: 'Complete JSON body is limited to 2 MiB. A stale revision returns 409 with details.currentRevision; no state is overwritten.',
        security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, body: updateWorkspaceSchema,
        response: { 200: workspaceResponse, ...errorResponses },
      },
    }, async (request) => {
      const { id } = request.params;
      const { name, revision, velaState, uiState } = request.body;
      const velaJson = JSON.stringify(velaState);
      const uiJson = JSON.stringify(uiState);
      const { workspace, event } = app.db.transaction(() => {
        requireWorkspace(id);
        const updated = updateWorkspace.run(name, velaJson, uiJson, app.services.clock(), id, revision);
        const current = requireWorkspace(id);
        if (updated.changes === 0) throw new ApiError(409, 'REVISION_CONFLICT', 'The workspace was changed by another save. Reload it or save a copy.', { currentRevision: current.revision });
        return { workspace: workspaceFromRow(current), event: app.events.record('workspaces.changed', id, current.revision) };
      }).immediate();
      app.events.emit(event);
      return { workspace };
    });

    routes.delete<{ Params: ResourceParams }>('/api/v1/workspaces/:id', {
      config, preValidation: rejectBody,
      schema: {
        operationId: 'deleteWorkspace', tags: ['Workspaces'], summary: 'Delete a saved workspace',
        security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema,
        response: { 204: { type: 'null' }, ...errorResponses },
      },
    }, async (request, reply) => {
      const event = app.db.transaction(() => {
        const current = requireWorkspace(request.params.id);
        deleteWorkspace.run(current.id);
        return app.events.record('workspaces.changed', current.id, current.revision + 1);
      }).immediate();
      app.events.emit(event);
      return reply.code(204).send();
    });

    routes.get('/api/v1/watchlists', {
      config,
      schema: {
        operationId: 'listWatchlists', tags: ['Watchlists'], summary: 'List named watchlists with their exact provider-qualified item order',
        security: adminSecurity, querystring: emptyQuerySchema,
        response: {
          200: { type: 'object', additionalProperties: false, required: ['watchlists'], properties: { watchlists: { type: 'array', items: watchlistSchema } } },
          ...errorResponses,
        },
      },
    }, async () => app.db.transaction(() => {
      const rows = watchlistRows.all();
      const items = new Map<string, MarketRef[]>();
      for (const row of allItems.all()) {
        let ordered = items.get(row.watchlist_id);
        if (!ordered) { ordered = []; items.set(row.watchlist_id, ordered); }
        ordered.push({ provider: row.provider, symbol: row.symbol });
      }
      return { watchlists: rows.map((row) => watchlistFromRow(row, items.get(row.id) ?? [])) };
    })());

    routes.post<{ Body: CreateWatchlist }>('/api/v1/watchlists', {
      config, bodyLimit: MAX_BODY_BYTES,
      schema: {
        operationId: 'createWatchlist', tags: ['Watchlists'], summary: 'Create an ordered watchlist of existing venue-qualified markets',
        description: 'Complete JSON body is limited to 2 MiB. Duplicate provider/symbol pairs and unknown instruments are rejected atomically.',
        security: mutationSecurity, headers: mutationHeadersSchema, querystring: emptyQuerySchema, body: createWatchlistSchema,
        response: { 201: watchlistResponse, ...errorResponses },
      },
    }, async (request, reply) => {
      const { name, items } = request.body;
      for (const item of items) await app.services.market.getInstrument(item);
      const { watchlist, event } = app.db.transaction(() => {
        const id = randomUUID();
        const now = app.services.clock();
        createWatchlist.run(id, name, now, now);
        for (const [position, item] of items.entries()) createItem.run(randomUUID(), id, position, item.provider, item.symbol);
        return { watchlist: watchlistFromRow(requireWatchlist(id), itemsByWatchlist.all(id)), event: app.events.record('watchlists.changed', id, 1) };
      }).immediate();
      app.events.emit(event);
      return reply.code(201).send({ watchlist });
    });

    routes.get<{ Params: ResourceParams }>('/api/v1/watchlists/:id', {
      config,
      schema: {
        operationId: 'getWatchlist', tags: ['Watchlists'], summary: 'Read a watchlist and its ordered venue-qualified items',
        security: adminSecurity, params: idParamsSchema, querystring: emptyQuerySchema,
        response: { 200: watchlistResponse, ...errorResponses },
      },
    }, async (request) => app.db.transaction(() => ({ watchlist: watchlistFromRow(requireWatchlist(request.params.id), itemsByWatchlist.all(request.params.id)) }))());

    routes.put<{ Params: ResourceParams; Body: UpdateWatchlist }>('/api/v1/watchlists/:id', {
      config, bodyLimit: MAX_BODY_BYTES,
      schema: {
        operationId: 'updateWatchlist', tags: ['Watchlists'], summary: 'Rename or replace watchlist order only at its current revision',
        description: 'Complete JSON body is limited to 2 MiB. All items must exist and be unique. A stale revision returns 409 with details.currentRevision; item positions are replaced in one transaction.',
        security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema, body: updateWatchlistSchema,
        response: { 200: watchlistResponse, ...errorResponses },
      },
    }, async (request) => {
      const { id } = request.params;
      const { name, items, revision } = request.body;
      const previous = requireWatchlist(id);
      if (previous.revision !== revision) throw new ApiError(409, 'REVISION_CONFLICT', 'The watchlist was changed by another save. Reload it or save a copy.', { currentRevision: previous.revision });
      for (const item of items) await app.services.market.getInstrument(item);
      const { watchlist, event } = app.db.transaction(() => {
        requireWatchlist(id);
        const updated = updateWatchlist.run(name, app.services.clock(), id, revision);
        const current = requireWatchlist(id);
        if (updated.changes === 0) throw new ApiError(409, 'REVISION_CONFLICT', 'The watchlist was changed by another save. Reload it or save a copy.', { currentRevision: current.revision });
        deleteItems.run(id);
        for (const [position, item] of items.entries()) createItem.run(randomUUID(), id, position, item.provider, item.symbol);
        return { watchlist: watchlistFromRow(current, itemsByWatchlist.all(id)), event: app.events.record('watchlists.changed', id, current.revision) };
      }).immediate();
      app.events.emit(event);
      return { watchlist };
    });

    routes.delete<{ Params: ResourceParams }>('/api/v1/watchlists/:id', {
      config, preValidation: rejectBody,
      schema: {
        operationId: 'deleteWatchlist', tags: ['Watchlists'], summary: 'Delete a watchlist and all its item rows',
        security: mutationSecurity, headers: mutationHeadersSchema, params: idParamsSchema, querystring: emptyQuerySchema,
        response: { 204: { type: 'null' }, ...errorResponses },
      },
    }, async (request, reply) => {
      const event = app.db.transaction(() => {
        const current = requireWatchlist(request.params.id);
        deleteWatchlist.run(current.id);
        return app.events.record('watchlists.changed', current.id, current.revision + 1);
      }).immediate();
      app.events.emit(event);
      return reply.code(204).send();
    });
  });
}
