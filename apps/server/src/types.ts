import type { Config } from './config.js';
import type { AppDatabase } from './database.js';
import type { InvalidationHub } from './events.js';
import type { Principal, RouteSecurity, SecurityBoundary } from './security.js';
import type { SecretStore } from './secrets.js';
import type { MarketService } from './market/MarketService.js';

export interface ServerServices {
  config: Config;
  clock: () => number;
  providers: Readonly<Record<string, unknown>>;
  secrets: SecretStore;
  market: MarketService;
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
