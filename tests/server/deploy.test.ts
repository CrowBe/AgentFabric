import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorker } from '../../src/deploy/cloudflare.js';
import { formatBanner, loadOperatorToken, startNodeServer, type RunningNodeServer } from '../../src/deploy/node.js';
import { getRecipe, instantiateRecipe, listRecipes } from '../../src/deploy/recipes.js';
import { createMockRuntime } from '../../src/testing/mock-runtime.js';
import type { RuntimeOptions } from '../../src/types/index.js';

describe('starter recipes', () => {
  it('only ships the six generic recipes with operator-agnostic defaults', () => {
    const ids = listRecipes().map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    const text = JSON.stringify(listRecipes());
    expect(text).not.toMatch(/crowbe|gmail|slack|github\.com\/[a-z]/i);
  });

  it('builds read-only defaults for CLI wrappers and shared folders', () => {
    const cli = instantiateRecipe('cli-wrapper-readonly', {
      name: 'log',
      toolName: 'git_log',
      description: 'Recent commits',
      command: 'git',
      argsTemplate: 'log\n--oneline',
    }).input;
    expect(cli.config).toMatchObject({ kind: 'cli_wrapper', envAllowlist: [], outputMode: 'text', maxOutputBytes: 65536 });
    const folder = instantiateRecipe('shared-workspace-folder', {
      name: 'notes',
      shareName: 'notes',
      rootPath: '/tmp/notes',
    }).input;
    expect(folder.config).toMatchObject({ kind: 'shared_folder', readOnly: true });
  });

  it('rejects wrongly typed values', () => {
    expect(() => instantiateRecipe('agent-skill', { name: 5 })).toThrow(/string/);
    expect(() => instantiateRecipe('shared-workspace-folder', { name: 'n', shareName: 's', rootPath: '/x', readOnly: 'maybe' })).toThrow(/true or false/);
    expect(() => instantiateRecipe('shared-workspace-folder', { name: 'n', shareName: 's', rootPath: '/x', maxFileBytes: -4 })).toThrow(/positive/);
    expect(getRecipe('ghost')).toBeUndefined();
    expect(() => instantiateRecipe('ghost', {})).toThrow(/not found/);
  });
});

describe('node deploy adapter', () => {
  const dirs: string[] = [];
  const servers: RunningNodeServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tmp = async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'af-home-'));
    dirs.push(d);
    return d;
  };

  it('persists a generated operator token with owner-only permissions and reuses it', async () => {
    const home = path.join(await tmp(), 'nested');
    const first = await loadOperatorToken(home, {});
    expect(first).toMatch(/^afop_/);
    const file = path.join(home, 'operator-token');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8')).trim()).toBe(first);
    expect(await loadOperatorToken(home, {})).toBe(first);
    expect(await loadOperatorToken(home, { AGENTFABRIC_OPERATOR_TOKEN: 'from-env' })).toBe('from-env');
    expect(await loadOperatorToken(home, {}, 'explicit')).toBe('explicit');
  });

  it('serves the gateway over HTTP with the operator API guarded', async () => {
    const home = await tmp();
    let seen: RuntimeOptions | undefined;
    const server = await startNodeServer({
      port: 0,
      homeDir: home,
      staticDir: false,
      env: {},
      createRuntime: async (options) => {
        seen = options;
        return createMockRuntime({ ...options, operatorToken: options.operatorToken });
      },
    });
    servers.push(server);
    expect(server.port).toBeGreaterThan(0);
    expect(seen?.mode).toBe('local');
    expect(seen?.homeDir).toBe(home);
    expect(seen?.publicUrl).toBe(server.url);
    expect(server.host).toBe('127.0.0.1');

    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${server.url}/api/status`)).status).toBe(401);
    const authed = await fetch(`${server.url}/api/status`, {
      headers: { authorization: `Bearer ${server.operatorToken}` },
    });
    expect(authed.status).toBe(200);

    const banner = formatBanner(server);
    expect(banner).toContain(`${server.url}/mcp`);
    expect(banner).toContain(server.operatorToken);
    expect(banner).toContain('local');
  });

  it('honours AGENTFABRIC_HOME and public URL overrides, and rejects bad ports', async () => {
    const home = await tmp();
    let seen: RuntimeOptions | undefined;
    const server = await startNodeServer({
      port: 0,
      staticDir: false,
      env: { AGENTFABRIC_HOME: home, AGENTFABRIC_PUBLIC_URL: 'https://gw.example.com/', AGENTFABRIC_MODE: 'remote' },
      createRuntime: async (options) => {
        seen = options;
        return createMockRuntime(options);
      },
    });
    servers.push(server);
    expect(seen).toMatchObject({ homeDir: home, publicUrl: 'https://gw.example.com', mode: 'remote' });
    await expect(startNodeServer({ port: 70000, env: {} })).rejects.toThrow(/Invalid port/);
  });

  it('releases the port and reports runtime start failures', async () => {
    const home = await tmp();
    await expect(
      startNodeServer({
        port: 0,
        homeDir: home,
        env: {},
        createRuntime: async () => {
          throw new Error('storage unavailable');
        },
      }),
    ).rejects.toThrow('storage unavailable');
  });
});

describe('cloudflare worker adapter', () => {
  const env = { AGENTFABRIC_OPERATOR_TOKEN: 'cf-token' };
  const makeWorker = () => {
    const created: RuntimeOptions[] = [];
    const worker = createWorker({
      createRuntime: async (options) => {
        created.push(options);
        return createMockRuntime({ ...options, operatorToken: options.operatorToken });
      },
    });
    return { worker, created };
  };

  it('boots lazily once in remote mode and serves the app', async () => {
    const { worker, created } = makeWorker();
    expect(created).toHaveLength(0);
    const res = await worker.fetch(new Request('https://gw.example.workers.dev/healthz'), env);
    expect(await res.json()).toEqual({ ok: true, mode: 'remote', version: '0.1.0' });
    await worker.fetch(new Request('https://gw.example.workers.dev/healthz'), env);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ mode: 'remote', publicUrl: 'https://gw.example.workers.dev', operatorToken: 'cf-token' });
  });

  it('honours AGENTFABRIC_PUBLIC_URL and guards the operator API', async () => {
    const { worker, created } = makeWorker();
    const denied = await worker.fetch(new Request('https://x.dev/api/status'), { ...env, AGENTFABRIC_PUBLIC_URL: 'https://gw.example.com/' });
    expect(denied.status).toBe(401);
    expect(created[0]?.publicUrl).toBe('https://gw.example.com');
    const ok = await worker.fetch(new Request('https://x.dev/api/status', { headers: { authorization: 'Bearer cf-token' } }), env);
    expect(ok.status).toBe(200);
  });

  it('fails closed when the operator token secret is missing', async () => {
    const { worker, created } = makeWorker();
    const res = await worker.fetch(new Request('https://x.dev/healthz'), {});
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('AGENTFABRIC_OPERATOR_TOKEN');
    expect(created).toHaveLength(0);
  });

  it('reports a failed boot as 503 without leaking details and retries on the next request', async () => {
    let attempts = 0;
    const worker = createWorker({
      createRuntime: async (options) => {
        attempts += 1;
        if (attempts === 1) throw new Error('db password=hunter2 refused');
        return createMockRuntime(options);
      },
    });
    const failed = await worker.fetch(new Request('https://x.dev/healthz'), env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('hunter2');
    expect((await worker.fetch(new Request('https://x.dev/healthz'), env)).status).toBe(200);
  });

  it('serves UI assets from the ASSETS binding with SPA fallback but never for gateway paths', async () => {
    const { worker } = makeWorker();
    const assets = {
      fetch: async (request: Request) => {
        const { pathname } = new URL(request.url);
        if (pathname === '/index.html') return new Response('<title>UI</title>');
        if (pathname === '/assets/a.js') return new Response('js');
        return new Response('nope', { status: 404 });
      },
    };
    const withAssets = { ...env, ASSETS: assets };
    expect(await (await worker.fetch(new Request('https://x.dev/assets/a.js'), withAssets)).text()).toBe('js');
    expect(await (await worker.fetch(new Request('https://x.dev/sources'), withAssets)).text()).toContain('<title>UI</title>');
    const api = await worker.fetch(new Request('https://x.dev/api/status'), withAssets);
    expect(api.status).toBe(401);
    const unknown = await worker.fetch(new Request('https://x.dev/mcp/a/b/c'), withAssets);
    expect(unknown.status).toBe(404);
  });

  it('exports a default module worker', async () => {
    const mod = await import('../../src/deploy/cloudflare.js');
    expect(typeof mod.default.fetch).toBe('function');
  });
});
