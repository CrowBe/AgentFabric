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
  it('only ships the eight generic recipes with operator-agnostic defaults', () => {
    const ids = listRecipes().map((r) => r.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    const text = JSON.stringify(listRecipes());
    expect(text).not.toMatch(/crowbe|gmail|slack|github\.com\/[a-z]/i);
  });

  it('builds an OAuth source with manual refresh and parses authorization parameters', () => {
    const defaults = { name: 'Remote', url: 'https://example.com/mcp' };
    expect(instantiateRecipe('mcp-http-oauth', defaults).input).toMatchObject({
      kind: 'mcp_http', authConfig: { kind: 'oauth2', oauth: {} }, refreshPolicy: { mode: 'manual' },
    });
    const { input } = instantiateRecipe('mcp-http-oauth', {
      ...defaults, scopes: 'read, write', clientId: 'client', clientSecretName: 'vault-name',
      authorizationEndpoint: 'https://auth.example.com/authorize', tokenEndpoint: 'https://auth.example.com/token',
      extraAuthParams: 'access_type=offline\nprompt=consent\nlogin_hint=subject=a',
    });
    expect(input.authConfig?.oauth).toEqual({
      scopes: ['read', 'write'], clientId: 'client', clientSecretName: 'vault-name',
      authorizationEndpoint: 'https://auth.example.com/authorize', tokenEndpoint: 'https://auth.example.com/token',
      extraAuthParams: { access_type: 'offline', prompt: 'consent', login_hint: 'subject=a' },
    });
    for (const extraAuthParams of ['prompt', '=value', ['client_id=override'], ['access_token=raw'], 1]) {
      expect(() => instantiateRecipe('mcp-http-oauth', { ...defaults, extraAuthParams })).toThrow();
    }
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

  it('fails closed without durable storage unless AGENTFABRIC_ALLOW_EPHEMERAL=1, and sets CSP on UI assets', async () => {
    const bare = createWorker();
    const denied = await bare.fetch(new Request('https://x.dev/healthz'), env);
    expect(denied.status).toBe(503);
    expect(await denied.text()).toContain('AGENTFABRIC_ALLOW_EPHEMERAL');

    const allowed = createWorker();
    const assets = {
      fetch: async () => new Response('<title>Worker UI</title>', { headers: { 'content-type': 'text/html' } }),
    };
    const ephEnv = { ...env, AGENTFABRIC_ALLOW_EPHEMERAL: '1', ASSETS: assets };
    const ui = await allowed.fetch(new Request('https://x.dev/'), ephEnv);
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(ui.headers.get('x-frame-options')).toBe('DENY');

    const health = await allowed.fetch(new Request('https://x.dev/healthz'), ephEnv);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, mode: 'remote', version: '0.1.0' });
  });

  const sqliteD1 = async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sqlite = new DatabaseSync(':memory:');
    const wrap = (query: string, bound: unknown[] = []) => ({
      bind: (...values: unknown[]) => wrap(query, values),
      all: async <T = Record<string, unknown>>() => ({
        results: sqlite.prepare(query).all(...(bound as never[])) as T[],
      }),
      first: async <T = Record<string, unknown>>() =>
        (sqlite.prepare(query).get(...(bound as never[])) as T | undefined) ?? null,
      run: async () => sqlite.prepare(query).run(...(bound as never[])),
    });
    const d1 = {
      prepare: (query: string) => wrap(query),
      batch: async (stmts: Array<{ run(): Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())),
    };
    return { sqlite, d1 };
  };
  const operator = { authorization: 'Bearer cf-token', 'content-type': 'application/json' };
  const masterKey = 'cf-master-key-0123456789abcdef';

  it('persists gateway state via Cloudflare D1StorageAdapter', async () => {
    const { D1StorageAdapter } = await import('../../src/storage/d1.js');
    const { sqlite, d1 } = await sqliteD1();
    const worker = createWorker();
    const d1Env = { ...env, AGENTFABRIC_MASTER_KEY: masterKey, DB: d1 };
    const created = await worker.fetch(
      new Request('https://x.dev/api/profiles', {
        method: 'POST',
        headers: operator,
        body: JSON.stringify({ name: 'd1-profile' }),
      }),
      d1Env,
    );
    expect(created.status).toBe(201);

    const reopened = await D1StorageAdapter.open(d1);
    expect(await reopened.getProfile('d1-profile')).toMatchObject({ name: 'd1-profile' });
    sqlite.close();
  });

  it('orders D1 event occurrences ascending by default and descending on request', async () => {
    const { D1StorageAdapter } = await import('../../src/storage/d1.js');
    const { sqlite, d1 } = await sqliteD1();
    const storage = await D1StorageAdapter.open(d1);
    for (const cursor of [1, 2, 10]) {
      await storage.appendEventOccurrence({ eventId: `e${cursor}`, name: 'tick', sourceId: 'gateway',
        timestamp: new Date(cursor * 1000).toISOString(), data: {}, cursor: String(cursor) });
    }
    expect((await storage.listEventOccurrences({ limit: 2 })).map((event) => event.cursor)).toEqual(['1', '2']);
    expect((await storage.listEventOccurrences({ limit: 2, order: 'desc' })).map((event) => event.cursor)).toEqual(['10', '2']);
    sqlite.close();
  });

  it('routes every Worker request through the gateway so UI security headers always apply', async () => {
    const config = JSON.parse(await readFile(path.join(process.cwd(), 'wrangler.jsonc'), 'utf8'));
    expect(config.assets).toMatchObject({ binding: 'ASSETS', run_worker_first: true });
  });

  it('fails closed before boot when DB is bound without AGENTFABRIC_MASTER_KEY', async () => {
    const { sqlite, d1 } = await sqliteD1();
    for (const key of [undefined, '', '   ']) {
      const res = await createWorker().fetch(
        new Request('https://x.dev/healthz'),
        { ...env, DB: d1, ...(key === undefined ? {} : { AGENTFABRIC_MASTER_KEY: key }) },
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('AGENTFABRIC_MASTER_KEY');
    }
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    sqlite.close();
  });

  it('persists encrypted secrets in D1 across Worker isolates', async () => {
    const { sqlite, d1 } = await sqliteD1();
    const d1Env = { ...env, AGENTFABRIC_MASTER_KEY: masterKey, DB: d1 };
    const put = await createWorker().fetch(
      new Request('https://x.dev/api/secrets/upstream-token', {
        method: 'PUT',
        headers: operator,
        body: JSON.stringify({ value: 'durable-secret-value', description: 'Upstream API' }),
      }),
      d1Env,
    );
    expect(put.status).toBe(200);
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM secrets_vault').all())).not.toContain('durable-secret-value');

    const listed = await createWorker().fetch(
      new Request('https://x.dev/api/secrets', { headers: operator }),
      d1Env,
    );
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(JSON.parse(body).secrets).toMatchObject([{ name: 'upstream-token', description: 'Upstream API' }]);
    expect(body).not.toContain('durable-secret-value');

    const wrongKey = await createWorker().fetch(
      new Request('https://x.dev/api/secrets', { headers: operator }),
      { ...d1Env, AGENTFABRIC_MASTER_KEY: 'a-different-master-key' },
    );
    expect(wrongKey.status).toBe(503);
    const wrongBody = await wrongKey.text();
    expect(wrongBody).toContain('Gateway failed to start');
    expect(wrongBody).not.toMatch(/durable-secret-value|upstream-token|a-different-master-key/);
    sqlite.close();
  });
});
