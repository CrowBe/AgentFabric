import type { Hono } from 'hono';
import { createGatewayRuntime } from '../runtime/index.js';
import { createApp } from '../server/app.js';
import { D1StorageAdapter, type D1DatabaseLike } from '../storage/d1.js';
import { D1SecretStore } from '../storage/d1-secrets.js';
import { MemoryStorageAdapter, MemoryTraceStore } from '../storage/memory.js';
import { InMemorySecretStore } from '../storage/secrets.js';
import type {
  GatewayRuntime,
  LlmAssistConfig,
  RuntimeOptions,
  SecretStore,
  StorageAdapter,
  TraceStore,
} from '../types/index.js';

export interface WorkerEnv {
  AGENTFABRIC_PUBLIC_URL?: string;
  AGENTFABRIC_OPERATOR_TOKEN?: string;
  AGENTFABRIC_MASTER_KEY?: string;
  AGENTFABRIC_ALLOW_EPHEMERAL?: string;
  AGENTFABRIC_LLM_API_URL?: string;
  AGENTFABRIC_LLM_API_KEY_SECRET?: string;
  AGENTFABRIC_LLM_MODEL?: string;
  AGENTFABRIC_LLM_PROVIDER?: string;
  DB?: D1DatabaseLike;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  [binding: string]: unknown;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface WorkerOptions {
  storage?: StorageAdapter;
  traceStore?: TraceStore;
  secrets?: SecretStore;
  createRuntime?: (options: RuntimeOptions) => Promise<GatewayRuntime>;
}

interface Booted {
  runtime: GatewayRuntime;
  app: Hono;
}

const API_PATHS = ['/api', '/mcp', '/oauth', '/auth', '/.well-known', '/healthz'];

const needsMasterKey = (options: WorkerOptions, env: WorkerEnv): boolean =>
  Boolean(env.DB) && !options.secrets && !options.createRuntime;

const isGatewayPath = (pathname: string): boolean =>
  API_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

const json = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const WORKER_UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', WORKER_UI_CSP);
  headers.set('x-frame-options', 'DENY');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function llmFromEnv(env: WorkerEnv): LlmAssistConfig | undefined {
  const config: LlmAssistConfig = {
    ...(env.AGENTFABRIC_LLM_API_URL ? { apiUrl: env.AGENTFABRIC_LLM_API_URL } : {}),
    ...(env.AGENTFABRIC_LLM_API_KEY_SECRET
      ? { apiKeySecretName: env.AGENTFABRIC_LLM_API_KEY_SECRET }
      : {}),
    ...(env.AGENTFABRIC_LLM_MODEL ? { model: env.AGENTFABRIC_LLM_MODEL } : {}),
    ...(env.AGENTFABRIC_LLM_PROVIDER === 'openai' ||
    env.AGENTFABRIC_LLM_PROVIDER === 'anthropic'
      ? { provider: env.AGENTFABRIC_LLM_PROVIDER }
      : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

export function createWorker(options: WorkerOptions = {}): {
  fetch(request: Request, env: WorkerEnv, ctx?: WorkerExecutionContext): Promise<Response>;
} {
  let booted: Promise<Booted> | undefined;

  const resolveStorage = async (env: WorkerEnv): Promise<StorageAdapter | undefined> => {
    if (options.storage) return options.storage;
    if (env.DB) return D1StorageAdapter.open(env.DB);
    if (env.AGENTFABRIC_ALLOW_EPHEMERAL === '1') return new MemoryStorageAdapter();
    if (options.createRuntime) return undefined;
    throw new Error('Durable storage binding DB is required unless AGENTFABRIC_ALLOW_EPHEMERAL=1');
  };

  const resolveSecrets = async (env: WorkerEnv): Promise<SecretStore> => {
    if (options.secrets) return options.secrets;
    const masterKey = env.AGENTFABRIC_MASTER_KEY?.trim() ? env.AGENTFABRIC_MASTER_KEY : undefined;
    if (env.DB && masterKey) return D1SecretStore.open(env.DB, masterKey);
    if (needsMasterKey(options, env)) {
      throw new Error('AGENTFABRIC_MASTER_KEY is required to encrypt secrets in D1');
    }
    return new InMemorySecretStore();
  };

  const boot = (request: Request, env: WorkerEnv): Promise<Booted> => {
    booted ??= (async () => {
      const operatorToken = env.AGENTFABRIC_OPERATOR_TOKEN;
      if (!operatorToken) {
        throw new Error('AGENTFABRIC_OPERATOR_TOKEN is not configured');
      }
      const storage = await resolveStorage(env);
      const traceStore = options.traceStore ?? new MemoryTraceStore();
      const secrets = await resolveSecrets(env);
      const publicUrl = (env.AGENTFABRIC_PUBLIC_URL ?? new URL(request.url).origin).replace(
        /\/+$/,
        '',
      );
      const llm = llmFromEnv(env);
      const runtime = await (options.createRuntime ?? createGatewayRuntime)({
        mode: 'remote',
        homeDir: '/agentfabric',
        publicUrl,
        operatorToken,
        ...(storage ? { storage } : {}),
        traceStore,
        secrets,
        ...(llm ? { llm } : {}),
      });
      return { runtime, app: createApp(runtime, { staticDir: false }) };
    })();
    booted.catch(() => {
      booted = undefined;
    });
    return booted;
  };

  return {
    async fetch(request, env, _ctx) {
      const { pathname } = new URL(request.url);
      if (!env.AGENTFABRIC_OPERATOR_TOKEN) {
        return json(
          503,
          'INTERNAL_ERROR',
          'Gateway is not configured: set the AGENTFABRIC_OPERATOR_TOKEN secret',
        );
      }
      if (
        !options.storage &&
        !env.DB &&
        env.AGENTFABRIC_ALLOW_EPHEMERAL !== '1' &&
        !options.createRuntime
      ) {
        return json(
          503,
          'INTERNAL_ERROR',
          'Durable Cloudflare D1 binding DB is not configured (set DB or AGENTFABRIC_ALLOW_EPHEMERAL=1)',
        );
      }
      if (needsMasterKey(options, env) && !env.AGENTFABRIC_MASTER_KEY?.trim()) {
        return json(
          503,
          'INTERNAL_ERROR',
          'Gateway is not configured: set the AGENTFABRIC_MASTER_KEY secret to encrypt secrets stored in D1',
        );
      }
      if (
        env.ASSETS &&
        (request.method === 'GET' || request.method === 'HEAD') &&
        !isGatewayPath(pathname)
      ) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return withSecurityHeaders(asset);
        const spa = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
        return withSecurityHeaders(spa);
      }
      let instance: Booted;
      try {
        instance = await boot(request, env);
      } catch {
        return json(503, 'INTERNAL_ERROR', 'Gateway failed to start');
      }
      return instance.app.fetch(request);
    },
  };
}

export default createWorker();
