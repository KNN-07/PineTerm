import type { Config } from './config.js';
import type { AppDatabase } from './database.js';
import type { InvalidationHub } from './events.js';
import type { Principal, RouteSecurity, SecurityBoundary } from './security.js';
import type { SecretStore } from './secrets.js';

export interface ServerServices {
  config: Config;
  clock: () => number;
  providers: Readonly<Record<string, unknown>>;
  secrets: SecretStore;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: AppDatabase;
    security: SecurityBoundary;
    events: InvalidationHub;
    services: ServerServices;
  }

  interface FastifyRequest {
    principal: Principal | null;
  }

  interface FastifyContextConfig {
    security?: RouteSecurity;
  }
}
