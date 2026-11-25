import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, vi } from 'vitest';
import { startNodeServer, type NodeServerOptions, type RunningNodeServer } from '../../src/deploy/node.js';
import type { CompositeSourceConfig, CreateSourceInput, GatewayErrorCode, SourceAuthConfig, SourceRecord } from '../../src/types/index.js';
import { startHttpMcp } from './fixtures/http.js';
import { echoSchema } from './fixtures/mcp-responses.mjs';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, 'E2E cleanup failed');
});

export function track<T extends { close(): Promise<void> }>(resource: T) {
  cleanup.push(() => resource.close());
  return resource;
}

export async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'agentfabric-e2e-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

export async function startGateway(options: NodeServerOptions = {}) {
  vi.stubEnv('AGENTFABRIC_MASTER_KEY', undefined);
  const homeDir = options.homeDir ?? await tempDir();
  const server = await startNodeServer({ port: 0, staticDir: false, env: {}, ...options, homeDir });
  let closing: Promise<void> | undefined;
  return track({ ...server, homeDir, close: () => closing ??= server.close() });
}

export function httpMcp(options?: Parameters<typeof startHttpMcp>[0]) {
  return startHttpMcp(options).then(track);
}

export async function json<T>(response: Response, status = 200): Promise<T> {
  const body: T = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

export function operatorRequest(server: RunningNodeServer, path: string, method = 'GET', body?: unknown) {
  return fetch(server.url + '/api' + path, {
    method, signal: AbortSignal.timeout(8000), headers: {
      authorization: `Bearer ${server.operatorToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function api<T = unknown>(server: RunningNodeServer, path: string, method = 'GET', body?: unknown, status = 200) {
  return json<T>(await operatorRequest(server, path, method, body), status);
}

export async function addSource(server: RunningNodeServer, input: CreateSourceInput) {
  return (await api<{ source: SourceRecord }>(server, '/sources', 'POST', input, 201)).source;
}

export async function clientToken(server: RunningNodeServer, profileId = 'default') {
  return (await api<{ token: string }>(server, '/tokens', 'POST', { profileId, label: 'E2E client' }, 201)).token;
}

type Params = Record<string, unknown>;
interface RpcError { code: number; message: string; data: { code?: GatewayErrorCode; [key: string]: unknown } }
interface Reply<T> { jsonrpc: '2.0'; id: number | string | null; result?: T; error?: RpcError }
interface ToolResult<T> { content: { type: string; text?: string }[]; structuredContent?: T; isError?: boolean }

export function mcpClient(server: RunningNodeServer, token?: string, profile?: string) {
  let sequence = 0;
  const request = (method: string, params: Params = {}, headers: HeadersInit = {}) => {
    const id = ++sequence;
    const wireHeaders = new Headers(headers);
    wireHeaders.set('accept', 'application/json, text/event-stream');
    wireHeaders.set('content-type', 'application/json');
    if (token) wireHeaders.set('authorization', `Bearer ${token}`);
    const url = profile ? `${server.mcpUrl}/${encodeURIComponent(profile)}` : server.mcpUrl;
    const response = fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(8000), headers: wireHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    return { id, response };
  };
  const reply = async <T>(method: string, params?: Params, status?: number) => {
    const { id, response } = request(method, params);
    const body = await json<Reply<T>>(await response, status);
    if (body.id !== null) expect(body.id).toBe(id);
    return body;
  };
  const result = async <T = unknown>(method: string, params?: Params) => {
    const { result, error } = await reply<T>(method, params);
    expect(error).toBeUndefined();
    if (result === undefined) throw new Error(`Missing MCP result for ${method}`);
    return result;
  };
  return {
    request, reply, result,
    tool: <T = unknown>(name: string, args?: Params) => result<ToolResult<T>>('tools/call', { name, arguments: args }),
    async toolNames() {
      return (await result<{ tools: { name: string }[] }>('tools/list')).tools.map(tool => tool.name);
    },
    async error(method: string, params: Params, code: GatewayErrorCode, status = 200) {
      const { error, result } = await reply(method, params, status);
      expect(result).toBeUndefined();
      expect(error).toMatchObject({ data: { code } });
      if (!error) throw new Error(`Missing MCP error for ${method}`);
      return error;
    },
  };
}

export async function callsIn(path: string) {
  try { return (await readFile(path, 'utf8')).trimEnd().split('\n'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
export function stdioSource(root: string, options: { id?: string; crash?: boolean; auth?: SourceAuthConfig } = {}) {
  const id = options.id ?? 'stdio';
  const log = join(root, `${id}.calls`);
  const input: CreateSourceInput = {
    id, name: id, kind: 'mcp_stdio', authConfig: options.auth,
    config: { kind: 'mcp_stdio', cwd: root, command: process.execPath, args: [fixture('stdio.mjs'), log,
      ...(options.crash ? ['crash-on-call'] : [])], timeoutMs: 3000 },
  };
  return { input, calls: () => callsIn(log) };
}

export function httpSource(mcpUrl: string, id = 'http'): CreateSourceInput {
  return { id, name: id, kind: 'mcp_http', config: { kind: 'mcp_http', url: mcpUrl, timeoutMs: 3000 } };
}

export function cliSource(root: string) {
  const log = join(root, 'cli.calls');
  const input: CreateSourceInput = {
    id: 'cli', name: 'CLI echo', kind: 'cli_wrapper', config: {
      kind: 'cli_wrapper', toolName: 'cli_echo', description: 'Echo a value through an executable', cwd: root,
      command: process.execPath, argsTemplate: [fixture('cli.mjs'), log, '{{value}}'], inputSchema: echoSchema,
    },
  };
  return { input, calls: () => callsIn(log) };
}

export function composite(toolName: string, target: string): CompositeSourceConfig {
  return {
    kind: 'composite', toolName, description: 'Echo through a pooled tool', inputSchema: echoSchema,
    steps: [{ id: 'echo', capability: target, argumentsTemplate: { value: '{{input.value}}' } }],
    outputTemplate: { value: '{{steps.echo.content.0.text}}' },
  };
}

export async function openSse(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  if (!response.body) throw new Error('Missing SSE body');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  return {
    async next() {
      while (!buffered.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE ended before the expected frame');
        buffered += chunk.value.replaceAll('\r\n', '\n');
      }
      const end = buffered.indexOf('\n\n');
      const lines = buffered.slice(0, end).split('\n');
      buffered = buffered.slice(end + 2);
      const id = lines.find(line => line.startsWith('id: '))?.slice(4);
      const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      return { id, message: JSON.parse(data) as { method?: string; id?: number; params?: Params } };
    },
    close: () => reader.cancel(),
  };
}
