import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { INVALIDATION_TYPES, type InvalidationEvent, type InvalidationType } from '../../../packages/contracts/src/index.js';
import type { AppDatabase } from './database.js';
import { ApiError } from './errors.js';
import type { SecurityBoundary } from './security.js';

interface EventRow {
  id: string;
  type: InvalidationType;
  resource_id: string;
  revision: number;
}

interface Client {
  response: ServerResponse;
  sessionHash: string;
  timer: NodeJS.Timeout;
}

/** Record inside the resource transaction; emit only after it commits. No payload may contain resource data. */
export class InvalidationHub {
  readonly #db: AppDatabase;
  readonly #clock: () => number;
  readonly #clients = new Set<Client>();
  readonly #record;
  readonly #replay;
  readonly #sequence;

  constructor(db: AppDatabase, clock: () => number) {
    this.#db = db;
    this.#clock = clock;
    this.#record = db.prepare('INSERT INTO invalidation_events(id, type, resource_id, revision, created_at) VALUES (?, ?, ?, ?, ?)');
    this.#sequence = db.prepare<[string], { sequence: number }>('SELECT sequence FROM invalidation_events WHERE id = ?');
    this.#replay = db.prepare<[number], EventRow>('SELECT id, type, resource_id, revision FROM invalidation_events WHERE sequence > ? ORDER BY sequence LIMIT 501');
  }

  record(type: InvalidationType, resourceId: string, revision: number): InvalidationEvent {
    if (!INVALIDATION_TYPES.includes(type) || !/^[a-f0-9-]{36}$/.test(resourceId) || !Number.isInteger(revision) || revision < 1) {
      throw new Error('Invalid invalidation metadata.');
    }
    const event: InvalidationEvent = { id: randomUUID(), type, resourceId, revision };
    this.#record.run(event.id, type, resourceId, revision, this.#clock());
    this.#db.prepare('DELETE FROM invalidation_events WHERE created_at < ?').run(this.#clock() - 24 * 60 * 60 * 1000);
    return event;
  }

  emit(event: InvalidationEvent): void {
    // Serialize the allowlisted wire fields explicitly; a caller cannot accidentally stream secrets.
    const frame = `id: ${event.id}\nevent: invalidation\ndata: ${JSON.stringify({ id: event.id, type: event.type, resourceId: event.resourceId, revision: event.revision })}\n\n`;
    for (const client of this.#clients) {
      if (!client.response.write(frame)) client.response.end();
    }
  }

  connect(request: FastifyRequest, reply: FastifyReply, security: SecurityBoundary): void {
    const principal = request.principal;
    if (!principal || principal.kind !== 'session') throw new ApiError(403, 'ADMIN_SESSION_REQUIRED', 'The admin event stream requires a browser session.');
    let sessionClients = 0;
    for (const client of this.#clients) if (client.sessionHash === principal.sessionHash) sessionClients++;
    if (this.#clients.size >= 32 || sessionClients >= 4) throw new ApiError(429, 'STREAM_LIMIT', 'Too many event streams are open.', undefined, 5);
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, Array.isArray(value) ? value.map(String) : String(value));
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.hijack();
    reply.raw.write('retry: 3000\n: connected; refetch authorized resources on every connection\n\n');
    const lastId = request.headers['last-event-id'];
    if (typeof lastId === 'string' && /^[a-f0-9-]{36}$/.test(lastId)) {
      const cursor = this.#sequence.get(lastId);
      const events = cursor ? this.#replay.all(cursor.sequence) : [];
      if (!cursor || events.length > 500) {
        reply.raw.write(': event history unavailable; refetch authorized resources\n\n');
      } else {
        for (const event of events) {
          const wire: InvalidationEvent = { id: event.id, type: event.type, resourceId: event.resource_id, revision: event.revision };
          if (!reply.raw.write(`id: ${wire.id}\nevent: invalidation\ndata: ${JSON.stringify(wire)}\n\n`)) {
            reply.raw.end();
            return;
          }
        }
      }
    }
    const client: Client = {
      response: reply.raw,
      sessionHash: principal.sessionHash,
      timer: setInterval(() => {
        if (!security.isSessionActive(principal.sessionHash) || !reply.raw.write(': keepalive\n\n')) reply.raw.end();
      }, 15_000),
    };
    client.timer.unref();
    this.#clients.add(client);
    reply.raw.on('close', () => {
      clearInterval(client.timer);
      this.#clients.delete(client);
    });
  }

  closeSession(sessionHash: string): void {
    for (const client of this.#clients) if (client.sessionHash === sessionHash) client.response.end();
  }

  close(): void {
    for (const client of this.#clients) {
      clearInterval(client.timer);
      client.response.end();
    }
    this.#clients.clear();
  }
}
