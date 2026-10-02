import type { Config } from './config.js';
import type { AppDatabase } from './database.js';
import type { InvalidationHub } from './events.js';
import type { Principal, RouteSecurity, SecurityBoundary } from './security.js';
import type { SecretStore } from './secrets.js';
import type { MarketService } from './market/MarketService.js';
import type { PineService } from './pine/PineService.js';
import type { ScriptService } from './scripts/ScriptService.js';
import type { PaperService } from './paper/PaperService.js';
import type { ReplayService } from './replay/ReplayService.js';

export interface ServerServices {
  config: Config;
  clock: () => number;
  providers: Readonly<Record<string, unknown>>;
  secrets: SecretStore;
  market: MarketService;
  pine: PineService;
  scripts: ScriptService;
  paper: PaperService;
  replay: ReplayService;
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
