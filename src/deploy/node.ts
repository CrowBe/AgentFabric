import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createGatewayRuntime } from '../runtime/index.js';
import { createApp } from '../server/app.js';
import type {
  GatewayMode,
  GatewayRuntime,
  LlmAssistConfig,
  RuntimeOptions,
} from '../types/index.js';

export const DEFAULT_PORT = 7432;
export const DEFAULT_HOST = '127.0.0.1';
const OPERATOR_TOKEN_FILE = 'operator-token';

export interface NodeServerOptions {
  port?: number;
  host?: string;
  /** Defaults to `$AGENTFABRIC_HOME` or `~/.agentfabric` (always outside the repository). */
  homeDir?: string;
  publicUrl?: string;
  mode?: GatewayMode;
  operatorToken?: string;
  staticDir?: string | false;
  llm?: LlmAssistConfig;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Test seam; defaults to the real runtime. */
  createRuntime?: (options: RuntimeOptions) => Promise<GatewayRuntime>;
}

export interface RunningNodeServer {
  runtime: GatewayRuntime;
  host: string;
  port: number;
  url: string;
  mcpUrl: string;
  operatorToken: string;
  close(): Promise<void>;
}

export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTFABRIC_HOME || path.join(os.homedir(), '.agentfabric');
}

/**
 * Operator token precedence: explicit option, `AGENTFABRIC_OPERATOR_TOKEN`, the token file in
 * the home directory, otherwise a fresh random token persisted there with owner-only access.
 */
export async function loadOperatorToken(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  if (env.AGENTFABRIC_OPERATOR_TOKEN) return env.AGENTFABRIC_OPERATOR_TOKEN;
  const file = path.join(homeDir, OPERATOR_TOKEN_FILE);
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // First run: create below.
  }
  const token = `afop_${randomBytes(32).toString('base64url')}`;
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}

function llmFromEnv(env: NodeJS.ProcessEnv): LlmAssistConfig | undefined {
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

function defaultStaticDir(): string {
  const beside = fileURLToPath(new URL('../web', import.meta.url));
  if (existsSync(path.join(beside, 'index.html'))) return beside;
  return path.resolve('dist/web');
}

export async function startNodeServer(
  options: NodeServerOptions = {},
): Promise<RunningNodeServer> {
  const env = options.env ?? process.env;
  const host = options.host ?? env.AGENTFABRIC_HOST ?? DEFAULT_HOST;
  const requestedPort =
    options.port ?? (env.AGENTFABRIC_PORT ? Number(env.AGENTFABRIC_PORT) : DEFAULT_PORT);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`Invalid port '${requestedPort}'`);
  }
  const homeDir = options.homeDir ?? resolveHomeDir(env);
  const mode: GatewayMode =
    options.mode ?? (env.AGENTFABRIC_MODE === 'remote' ? 'remote' : 'local');
  const operatorToken = await loadOperatorToken(homeDir, env, options.operatorToken);
  const llm = options.llm ?? llmFromEnv(env);

  // The public URL needs the bound port, so port 0 resolves it after listening.
  const publicUrlFromEnv = options.publicUrl ?? env.AGENTFABRIC_PUBLIC_URL;
  const buildRuntime = options.createRuntime ?? createGatewayRuntime;

  let handler: (request: Request) => Response | Promise<Response> = () =>
    new Response('Gateway is starting', { status: 503 });

  const server = serve({
    fetch: (request: Request) => handler(request),
    port: requestedPort,
    hostname: host,
  });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const boundPort = (server.address() as AddressInfo).port;

  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${boundPort}`;

  let runtime: GatewayRuntime;
  try {
    runtime = await buildRuntime({
      mode,
      homeDir,
      publicUrl: (publicUrlFromEnv ?? url).replace(/\/+$/, ''),
      operatorToken,
      ...(llm ? { llm } : {}),
    });
    const hono = createApp(runtime, {
      staticDir: options.staticDir ?? defaultStaticDir(),
    });
    handler = (request) => hono.fetch(request);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  const ready = runtime;
  return {
    runtime: ready,
    host,
    port: boundPort,
    url,
    mcpUrl: `${ready.publicUrl}/mcp`,
    operatorToken,
    async close() {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ready.close();
    },
  };
}

export function formatBanner(server: RunningNodeServer): string {
  const rule = '─'.repeat(64);
  return [
    rule,
    ' AgentFabric gateway is running',
    rule,
    ` Mode           ${server.runtime.mode}`,
    ` MCP URL        ${server.mcpUrl}`,
    ` Web UI         ${server.url}/`,
    ` Operator token ${server.operatorToken}`,
    ` Home           ${server.runtime.homeDir}`,
    rule,
    ' Keep the operator token private. Open the Web UI and paste it when asked.',
    ' Stop with Ctrl+C.',
    rule,
  ].join('\n');
}

/** Start the gateway, print the banner, and resolve once SIGINT/SIGTERM has shut it down. */
export async function runNodeServer(options: NodeServerOptions = {}): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const server = await startNodeServer(options);
  log(formatBanner(server));
  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (closing) return;
      closing = true;
      log(`\nReceived ${signal}, shutting down…`);
      server
        .close()
        .catch((error: unknown) => {
          log(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
