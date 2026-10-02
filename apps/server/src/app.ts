import fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import packageInfo from '../../../package.json' with { type: 'json' };
import { sharedSchemas } from '../../../packages/contracts/src/index.js';
import type { Config } from './config.js';
import { openDatabase } from './database.js';
import { ApiError, installErrorHandling } from './errors.js';
import { InvalidationHub } from './events.js';
import { registerRoutes } from './routes.js';
import { SecurityBoundary } from './security.js';
import { SecretStore } from './secrets.js';
import type { MarketTransport } from '../../../packages/contracts/src/market.js';
import { MarketService } from './market/MarketService.js';
import { createTransports } from './market/providers.js';
import { registerMarketRoutes } from './market/routes.js';
import { registerWorkspaceRoutes } from './workspaces/routes.js';
import { PineService } from './pine/PineService.js';
import { registerPineRoutes } from './pine/routes.js';
import { ScriptService } from './scripts/ScriptService.js';
import { registerScriptRoutes } from './scripts/routes.js';
import './types.js';

export interface BuildAppOptions {
  config: Config;
  providers?: Readonly<Record<string, MarketTransport>>;
  clock?: () => number;
}

export async function buildApp({ config, providers = {}, clock = Date.now }: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: {
      level: 'info',
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]', 'password', 'token', 'secret', 'apiKey'], censor: '[REDACTED]' },
    },
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: 256 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
    forceCloseConnections: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: false } },
  });
  const db = openDatabase(config.dataDir, clock);
  const secrets = new SecretStore(config.secretKey);
  const events = new InvalidationHub(db, clock);
  let security: SecurityBoundary | undefined;
  let market: MarketService | undefined;
  let pine: PineService | undefined;
  app.addHook('preClose', async () => { await pine?.close(); market?.close(); events.close(); });
  app.addHook('onClose', async () => {
    security?.dispose();
    secrets.dispose();
    if (db.open) db.close();
  });
  try {
    security = await SecurityBoundary.create(config, db, clock);
    const transports = Object.keys(providers).length ? providers : createTransports(clock);
    market = new MarketService(db, transports, clock);
    pine = new PineService(db, market, clock, events);
    await pine.initialise();
    const scripts = new ScriptService(db, clock, events);
    app.decorate('db', db);
    app.decorate('security', security);
    app.decorate('events', events);
    app.decorate('services', { config, clock, providers: transports, secrets, market, pine, scripts });
    app.decorateRequest('principal', null);
    installErrorHandling(app);
    for (const schema of sharedSchemas) app.addSchema(schema);
    await app.register(cookie, { secret: config.sessionSecret, algorithm: 'sha256', hook: 'onRequest' });
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'PineTerm API', version: packageInfo.version,
          description: 'Single-user self-hosted workspace. Administrator sessions, scoped keys, durable invalidations, fixed-venue crypto feeds, OHLCV streaming and historical CSV datasets. Trading and agent services are not yet implemented.',
          license: { name: 'AGPL-3.0-only', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
        },
        servers: [{ url: config.publicOrigin }],
        components: {
          securitySchemes: {
            adminSession: { type: 'apiKey', in: 'cookie', name: security.cookieName, description: 'Signed HttpOnly SameSite=Strict administrator session.' },
            csrfToken: { type: 'apiKey', in: 'header', name: 'x-csrf-token', description: 'Current session CSRF token, required with exact configured Origin for browser mutations.' },
            bearerKey: { type: 'http', scheme: 'bearer', description: 'Scoped API key. Not accepted for admin/security operations; executor scopes bind to one executor.' },
          },
        },
      },
    });
    await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
    app.addHook('onRequest', async (request, reply) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'same-origin');
      reply.header('X-Frame-Options', 'DENY');
      if (request.url.startsWith('/api/')) {
        reply.header('Cache-Control', 'no-store');
        app.security.authorize(request, request.routeOptions.config.security ?? { access: 'admin' });
        if (request.headers.upgrade?.toLowerCase() === 'websocket') app.security.assertOrigin(request);
      } else {
        // The pinned PineTS Blob worker evaluates compiled Pine; previews are not a security sandbox.
        reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      }
    });
    registerRoutes(app, config);
    await registerMarketRoutes(app, market);
    await registerWorkspaceRoutes(app);
    await registerPineRoutes(app);
    await registerScriptRoutes(app);
    const hasWebBuild = existsSync(join(config.webDistDir, 'index.html'));
    if (config.mode === 'production' && !hasWebBuild) {
      throw new Error('Production web assets are missing. Run npm run build before npm start.');
    }
    if (hasWebBuild) {
      await app.register(staticFiles, {
        root: config.webDistDir, prefix: '/', dotfiles: 'deny', index: 'index.html',
        maxAge: 0, setHeaders: (response, filename) => {
          response.setHeader('Cache-Control', filename.includes(`${join(config.webDistDir, 'assets')}/`) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      });
    }
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split('?')[0];
      if (!pathname.startsWith('/api/') && (request.method === 'GET' || request.method === 'HEAD') && !extname(pathname) && (request.headers.accept?.includes('text/html') || pathname === '/')) {
        if (hasWebBuild) return reply.sendFile('index.html');
        throw new ApiError(503, 'WEB_BUILD_MISSING', 'Run npm run dev for development, or npm run build before npm start.');
      }
      throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
    });
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
