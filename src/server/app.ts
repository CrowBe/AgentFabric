import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { GatewayError, type GatewayRuntime } from '../types/index.js';
import { createApi, createOperatorGuard } from './api.js';
import { mountAuthPages } from './auth-pages.js';
import { createStaticHandler } from './static.js';

export const GATEWAY_VERSION = '0.1.0';

export interface CreateAppOptions {
  /** Directory of the built web UI. Defaults to `dist/web`; `false` disables UI serving. */
  staticDir?: string | false;
}

const API_PREFIXES = ['/api', '/mcp', '/oauth', '/.well-known', '/healthz'];

function wantsJson(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function errorBody(code: string, message: string): Record<string, unknown> {
  return { error: { code, message } };
}

export function createApp(
  runtime: GatewayRuntime,
  options: CreateAppOptions = {},
): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    try {
      c.res.headers.set('x-content-type-options', 'nosniff');
    } catch {
      // Immutable upstream response headers; the runtime owns them.
    }
  });

  // MCP clients and OAuth discovery may be driven from browser-based tools. These
  // endpoints use bearer tokens, never cookies, so open CORS does not widen access.
  const mcpCors = cors({
    origin: '*',
    allowHeaders: [
      'authorization',
      'content-type',
      'accept',
      'mcp-session-id',
      'mcp-protocol-version',
      'last-event-id',
    ],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['mcp-session-id', 'www-authenticate'],
  });
  for (const path of [
    '/mcp',
    '/mcp/*',
    '/.well-known/*',
    '/oauth/register',
    '/oauth/token',
  ]) {
    app.use(path, mcpCors);
  }

  app.get('/healthz', (c) =>
    c.json({ ok: true, mode: runtime.mode, version: GATEWAY_VERSION }),
  );

  app.get('/.well-known/oauth-protected-resource', (c) =>
    runtime.handleOAuthProtectedResourceMetadata(c.req.raw),
  );
  app.get('/.well-known/oauth-protected-resource/*', (c) =>
    runtime.handleOAuthProtectedResourceMetadata(c.req.raw),
  );
  app.get('/.well-known/oauth-authorization-server', (c) =>
    runtime.handleOAuthAuthorizationServerMetadata(c.req.raw),
  );
  const rejectOversized = (maxSize: number) =>
    bodyLimit({
      maxSize,
      onError: (c) => c.json(errorBody('INVALID_INPUT', 'Request body too large'), 413),
    });

  app.use('/oauth/*', rejectOversized(64 * 1024));
  app.use('/mcp', rejectOversized(2 * 1024 * 1024));
  app.use('/mcp/*', rejectOversized(2 * 1024 * 1024));

  app.post('/oauth/register', (c) => runtime.handleOAuthRegister(c.req.raw));
  app.post('/oauth/token', (c) => runtime.handleOAuthToken(c.req.raw));
  mountAuthPages(app, runtime);

  app.all('/mcp', (c) => runtime.handleMcpRequest(c.req.raw, null));
  app.all('/mcp/:profile', (c) =>
    runtime.handleMcpRequest(c.req.raw, c.req.param('profile')),
  );

  app.use('/api/*', createOperatorGuard(runtime));
  app.route('/api', createApi(runtime));

  const staticDir = options.staticDir === undefined ? 'dist/web' : options.staticDir;
  const serveUi = staticDir === false ? undefined : createStaticHandler(staticDir);

  app.notFound((c) => {
    if (wantsJson(c.req.path) || !serveUi) {
      return c.json(errorBody('NOT_FOUND', 'Not found'), 404);
    }
    return serveUi(c, async () => undefined);
  });

  app.onError((err, c) => {
    if (err instanceof GatewayError) {
      return c.json(err.toJSON(), err.httpStatus as ContentfulStatusCode);
    }
    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      return c.json(errorBody(status === 401 ? 'UNAUTHORIZED' : 'INVALID_INPUT', err.message), status);
    }
    console.error(`[agentfabric] unhandled ${c.req.method} ${c.req.path}: ${err.name}`);
    return c.json(errorBody('INTERNAL_ERROR', 'Internal server error'), 500);
  });

  return app;
}
