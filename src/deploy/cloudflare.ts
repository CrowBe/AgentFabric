import type { Hono } from 'hono';
import { createGatewayRuntime } from '../runtime/index.js';
import { createApp } from '../server/app.js';
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
  AGENTFABRIC_LLM_API_URL?: string;
  AGENTFABRIC_LLM_API_KEY_SECRET?: string;
  AGENTFABRIC_LLM_MODEL?: string;
  AGENTFABRIC_LLM_PROVIDER?: string;
  /** Workers Static Assets binding serving the built web UI (`dist/web`). */
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
  /** Test seam; defaults to the real runtime. */
  createRuntime?: (options: RuntimeOptions) => Promise<GatewayRuntime>;
}

interface Booted {
  runtime: GatewayRuntime;
  app: Hono;
}

const API_PATHS = ['/api', '/mcp', '/oauth', '/auth', '/.well-known', '/healthz'];

const isGatewayPath = (pathname: string): boolean =>
  API_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

const json = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

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

/**
 * Optional in-memory defaults. They are loaded lazily by specifier so this adapter builds
 * and runs even when the storage package ships them under a different layout; in that case
 * the runtime applies its own defaults. In-memory state does not survive isolate recycling,
 * so durable deployments must inject a persistent StorageAdapter.
 */
async function memoryDefaults(): Promise<Pick<WorkerOptions, 'storage' | 'traceStore'>> {
  const specifier = '../storage/memory.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    const Storage = mod.MemoryStorageAdapter as (new () => StorageAdapter) | undefined;
    const Trace = mod.MemoryTraceStore as (new () => TraceStore) | undefined;
    return {
      ...(Storage ? { storage: new Storage() } : {}),
      ...(Trace ? { traceStore: new Trace() } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Cloudflare Workers adapter. Always runs in `remote` mode, so local CLI sources and local
 * folder shares are refused by the runtime. The runtime boots lazily on the first request.
 */
export function createWorker(options: WorkerOptions = {}): {
  fetch(request: Request, env: WorkerEnv, ctx?: WorkerExecutionContext): Promise<Response>;
} {
  let booted: Promise<Booted> | undefined;

  const boot = (request: Request, env: WorkerEnv): Promise<Booted> => {
    booted ??= (async () => {
      const operatorToken = env.AGENTFABRIC_OPERATOR_TOKEN;
      if (!operatorToken) {
        throw new Error('AGENTFABRIC_OPERATOR_TOKEN is not configured');
      }
      const defaults =
        options.storage || options.traceStore ? {} : await memoryDefaults();
      const publicUrl = (env.AGENTFABRIC_PUBLIC_URL ?? new URL(request.url).origin).replace(
        /\/+$/,
        '',
      );
      const llm = llmFromEnv(env);
      const storage = options.storage ?? defaults.storage;
      const traceStore = options.traceStore ?? defaults.traceStore;
      const runtime = await (options.createRuntime ?? createGatewayRuntime)({
        mode: 'remote',
        homeDir: '/agentfabric',
        publicUrl,
        operatorToken,
        ...(storage ? { storage } : {}),
        ...(traceStore ? { traceStore } : {}),
        ...(options.secrets ? { secrets: options.secrets } : {}),
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
        env.ASSETS &&
        (request.method === 'GET' || request.method === 'HEAD') &&
        !isGatewayPath(pathname)
      ) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
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
