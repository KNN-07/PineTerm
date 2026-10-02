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
import { PaperService } from './paper/PaperService.js';
import { registerPaperRoutes } from './paper/routes.js';
import { ReplayService } from './replay/ReplayService.js';
import { registerReplayRoutes } from './replay/routes.js';
import { AlertService } from './alerts/AlertService.js';
import { registerAlertRoutes } from './alerts/routes.js';
import { NotificationService, type NotificationOptions } from './notifications/NotificationService.js';
import { registerNotificationRoutes } from './notifications/routes.js';
import { ExecutionService } from './execution/ExecutionService.js';
import { registerExecutionRoutes } from './execution/routes.js';
import { AgentService } from './agent/AgentService.js';
import { registerAgentRoutes } from './agent/routes.js';
import { AgentDraftService } from './agent/AgentDraftService.js';
import { registerAgentDraftRoutes } from './agent/draftRoutes.js';
import './types.js';

export interface BuildAppOptions {
  config: Config;
  providers?: Readonly<Record<string, MarketTransport>>;
  clock?: () => number;
  notifications?: NotificationOptions;
}

export async function buildApp({ config, providers = {}, clock = Date.now, notifications: notificationOptions }: BuildAppOptions): Promise<FastifyInstance> {
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
  let paper: PaperService | undefined;
  let replay: ReplayService | undefined;
  let notifications: NotificationService | undefined;
  let alerts: AlertService | undefined;
  let execution: ExecutionService | undefined;
  let agent: AgentService | undefined;
  app.addHook('preClose', async () => { await agent?.close(); await alerts?.close(); await execution?.close(); await notifications?.close(); await replay?.close(); await paper?.close(); await pine?.close(); market?.close(); events.close(); });
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
    paper = new PaperService(db, market, clock, events);
    await paper.initialise();
    replay = new ReplayService(db, market, paper, clock, events);
    await replay.initialise();
    notifications = new NotificationService(db, secrets, config, clock, events, notificationOptions);
    execution = new ExecutionService(db, market, secrets, clock, events);
    await execution.initialise();
    alerts = new AlertService(db, market, pine, scripts, notifications, clock, events, execution);
    await notifications.initialise({
      status: () => `PineTerm server · ${new Date(clock()).toISOString()} · paper simulation · live handoff ${execution!.getPolicy().enabled ? 'ENABLED' : 'disabled'} · no direct exchange execution`,
      alerts: () => alerts!.list().map(alert => `${alert.name}: ${alert.enabled ? 'armed' : 'paused'} · ${alert.market.provider.toUpperCase()}:${alert.market.symbol} · ${alert.timeframe}${alert.pausedReason ? ` · ${alert.pausedReason}` : ''}`).join('\n') || 'No alerts configured.',
      positions: async () => {
        const portfolios = await Promise.all(paper!.listAccounts('live').filter(account => !account.archivedAt).map(account => paper!.getAccount(account.id)));
        const paperSummary = portfolios.map(view => `${view.account.name} · PAPER · cash ${view.account.cashBalance} ${view.account.quoteCurrency}\n${view.positions.map(position => `${position.market.provider.toUpperCase()}:${position.market.symbol} · owned ${position.quantity}`).join('\n')}`).join('\n\n') || 'No live paper accounts.';
        const external = execution!.reportedPositions().map(position => `${position.market.provider.toUpperCase()}:${position.market.symbol} · externally reported net fill delta ${position.netQuantity} · not exchange balances`).join('\n');
        return paperSummary + (external ? `\n\nEXTERNALLY REPORTED FILLS\n${external}` : '');
      },
    });
    await alerts.initialise();
    const agentDrafts = new AgentDraftService(db, pine, scripts, clock, events);
    agent = new AgentService(db, secrets, config, market, pine, paper, scripts, replay, agentDrafts, clock, events);
    await agent.initialise();
    app.decorate('db', db);
    app.decorate('security', security);
    app.decorate('events', events);
    app.decorate('services', { config, clock, providers: transports, secrets, market, pine, scripts, paper, replay, alerts, notifications, execution, agent, agentDrafts });
    app.decorateRequest('principal', null);
    installErrorHandling(app);
    for (const schema of sharedSchemas) app.addSchema(schema);
    await app.register(cookie, { secret: config.sessionSecret, algorithm: 'sha256', hook: 'onRequest' });
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'PineTerm API', version: packageInfo.version,
          description: 'Single-user self-hosted workspace. Scoped finance routes, venue-qualified market data, immutable Pine scripts, isolated simulation, server paper accounts/replay and durable alerts/notification delivery. No direct funded exchange execution.',
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
    await registerPaperRoutes(app);
    await registerReplayRoutes(app, replay);
    await registerAlertRoutes(app, alerts);
    await registerNotificationRoutes(app, notifications);
    await registerExecutionRoutes(app, execution);
    await registerAgentRoutes(app, agent, security);
    await registerAgentDraftRoutes(app);
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
