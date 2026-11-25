import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../../src/auth/middleware.js';
import { createGatewayRuntime } from '../../src/runtime/index.js';
import { MemoryStorageAdapter, MemoryTraceStore } from '../../src/storage/memory.js';
import { validateSourceConfig } from '../../src/storage/portability.js';
import { InMemorySecretStore } from '../../src/storage/secrets.js';
import type { RuntimeOptions, UpstreamOAuthConfig } from '../../src/types/index.js';
import { mcpResponse } from '../e2e/fixtures/mcp-responses.mjs';

const publicUrl = 'https://fabric.example';
const redirectUri = publicUrl + '/auth/oauth/callback';
const providerSecret = 'provider-client-secret';
const operatorSecret = 'credential : +/% with spaces';
const initialAccess = 'first-access-credential';
const initialRefresh = 'first-refresh-credential';
const rotatedRefresh = 'rotated-refresh-credential';
const authorizationCode = 'fixture-authorization-code';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function provider() {
  const fixture = {
    origin: '', paths: [] as string[], registrations: [] as Record<string, unknown>[],
    exchanges: [] as { params: URLSearchParams; authorization?: string }[],
    refreshes: [] as { params: URLSearchParams; authorization?: string }[],
    credentials: [] as { auth?: string; header?: string | string[] }[],
    validAccess: initialAccess, scopes: ['read', 'write'], failRefresh: false, rejectMcp: false,
    rejectAlways: false, failDiscovery: false, onlyChallenge: false, issuerMismatch: false, noS256: false,
    publicRegistration: false, refreshOmitsToken: false,
  };
  const server = createServer((request, response) => {
    async function reply() {
      const { pathname } = new URL(request.url!, fixture.origin);
      fixture.paths.push(pathname);
      const json = (data: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      };
      const issuer = fixture.origin + '/tenant';
      if ((!fixture.onlyChallenge && pathname === '/.well-known/oauth-protected-resource/mcp') || pathname === '/resource-metadata') {
        return json({ resource: fixture.origin + '/resource', authorization_servers: [issuer], scopes_supported: fixture.scopes });
      }
      if (pathname === '/.well-known/oauth-authorization-server/tenant') {
        return json({
          issuer: fixture.issuerMismatch ? fixture.origin + '/another' : issuer,
          authorization_endpoint: fixture.origin + '/authorize',
          token_endpoint: fixture.origin + '/token',
          registration_endpoint: fixture.origin + '/register',
          code_challenge_methods_supported: fixture.noS256 ? ['plain'] : ['S256'],
        });
      }
      if (pathname === '/register') {
        fixture.registrations.push(JSON.parse(await body(request)));
        return json({ client_id: 'dynamic-client',
          ...(fixture.publicRegistration ? {} : { client_secret: providerSecret }) }, 201);
      }
      if (pathname === '/token') {
        const params = new URLSearchParams(await body(request));
        const authorization = request.headers.authorization;
        if (params.get('grant_type') === 'authorization_code') {
          fixture.exchanges.push({ params, authorization });
          if (params.get('code') !== authorizationCode) {
            return json({ error: 'invalid_grant', error_description: providerSecret + ' ' + params.get('code') }, 400);
          }
          fixture.validAccess = initialAccess;
          return json({ access_token: initialAccess, refresh_token: initialRefresh, expires_in: 3600, scope: 'read' });
        }
        fixture.refreshes.push({ params, authorization });
        await new Promise(resolve => setTimeout(resolve, 20));
        if (fixture.failRefresh) return json({ error: 'invalid_grant', error_description: initialRefresh }, 400);
        fixture.validAccess = 'refreshed-access-credential-' + fixture.refreshes.length;
        fixture.rejectMcp = false;
        return json({ access_token: fixture.validAccess, token_type: 'Bearer', expires_in: 3600,
          ...(fixture.refreshOmitsToken ? {} : { refresh_token: rotatedRefresh }) });
      }
      if (pathname === '/mcp') {
        const auth = request.headers.authorization;
        fixture.credentials.push({ auth, header: request.headers['x-fixture'] });
        if (fixture.rejectMcp || fixture.rejectAlways || auth !== 'Bearer ' + fixture.validAccess) {
          response.writeHead(401, { 'WWW-Authenticate': `Bearer error_description="ignored resource_metadata=https://example.invalid/misleading", RESOURCE_METADATA="${fixture.origin}/resource-metadata"` }).end();
          return;
        }
        if (fixture.failDiscovery) return response.writeHead(503).end();
        if (request.method !== 'POST') return response.writeHead(405).end();
        const rpc = JSON.parse(await body(request));
        if (rpc.id === undefined) return response.writeHead(202).end();
        return json(mcpResponse(rpc, 'oauth'));
      }
      return response.writeHead(404).end();
    }
    void reply().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fixture.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return fixture;
}

async function start(options: Partial<RuntimeOptions> = {}) {
  const storage = new MemoryStorageAdapter();
  const secrets = new InMemorySecretStore();
  const runtime = await createGatewayRuntime({
    mode: 'local', homeDir: '/unused', publicUrl, storage, secrets, traceStore: new MemoryTraceStore(), ...options,
  });
  cleanup.push(() => runtime.close());
  const { token } = await runtime.createToken({ profileId: 'default', label: 'test' });
  async function source(url: string, oauth: UpstreamOAuthConfig = {}, id = 'remote') {
    return runtime.createSource({
      id, name: 'Fixture MCP', kind: 'mcp_http', config: { kind: 'mcp_http', url, headers: { 'x-fixture': 'static' } },
      authConfig: { kind: 'oauth2', oauth }, refreshPolicy: { mode: 'manual' },
    });
  }
  async function call(value = 'hello') {
    const response = await runtime.handleMcpRequest(new Request(publicUrl + '/mcp', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: value, method: 'tools/call', params: { name: 'oauth_echo', arguments: { value } } }),
    }), null);
    return response.json();
  }
  async function authorize(id = 'remote') {
    const start = await runtime.startUpstreamOAuth(id);
    const url = new URL(start.authorizeUrl);
    const params = new URLSearchParams({ state: url.searchParams.get('state')!, code: authorizationCode });
    return { start, url, params, finish: () => runtime.completeUpstreamOAuth(params) };
  }
  return { runtime, storage, secrets, source, call, authorize };
}

describe('upstream OAuth', () => {
  it('discovers protected resource and path-based issuer metadata, registers, exchanges PKCE, and routes MCP calls', async () => {
    const upstream = await provider();
    const { runtime, source, authorize, call, storage, secrets } = await start();
    expect((await source(upstream.origin + '/mcp')).health).toBe('auth_required');
    expect((await runtime.testSource('remote')).authHandoff?.authUrl).toContain('/auth/connect/remote?ticket=');
    const { start: result, url, params, finish } = await authorize();
    expect(result.redirectUri).toBe(redirectUri);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'dynamic-client', response_type: 'code', redirect_uri: redirectUri, resource: upstream.origin + '/resource',
      code_challenge_method: 'S256', scope: 'read write',
    });
    expect(url.pathname).toBe('/authorize');
    expect(upstream.paths.slice(0, 3)).toEqual(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server/tenant', '/register']);
    expect(upstream.registrations).toEqual([{
      client_name: 'AgentFabric', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none',
    }]);

    params.set('iss', upstream.origin + '/tenant');
    const completions = await Promise.allSettled([finish(), finish()]);
    expect(completions).toContainEqual({ status: 'fulfilled', value: expect.objectContaining({
      source: expect.objectContaining({ health: 'healthy' }), capabilityCount: 3,
    }) });
    expect(completions).toContainEqual({ status: 'rejected', reason: expect.objectContaining({ code: 'UNAUTHORIZED' }) });
    expect(upstream.exchanges).toHaveLength(1);
    const exchange = upstream.exchanges[0].params;
    expect(Object.fromEntries(exchange)).toMatchObject({
      grant_type: 'authorization_code', code: authorizationCode, redirect_uri: redirectUri, resource: upstream.origin + '/resource',
      client_id: 'dynamic-client', client_secret: providerSecret,
    });
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect((await call()).result.content).toEqual([{ type: 'text', text: 'oauth:hello' }]);
    expect(upstream.credentials.every(({ auth, header }) => auth === 'Bearer ' + initialAccess && header === 'static')).toBe(true);
    const status = await runtime.getUpstreamOAuthStatus('remote');
    expect(status).toMatchObject({ configured: true, connected: true, redirectUri, hasRefreshToken: true, scope: 'read', clientId: 'dynamic-client' });
    const objects = [await runtime.getSource('remote'), await runtime.exportConfig(), status, await storage.getUpstreamOAuthToken('remote')];
    for (const value of [initialAccess, initialRefresh, providerSecret, authorizationCode, exchange.get('code_verifier')]) {
      expect(JSON.stringify(objects)).not.toContain(value);
    }
    const pending = await authorize();
    expect(upstream.registrations).toHaveLength(1);
    await runtime.deleteSource('remote');
    expect(await secrets.listMetadata()).toEqual([]);
    expect(await storage.getUpstreamOAuthToken('remote')).toBeNull();
    await expect(pending.finish()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each(['client_secret_post', 'client_secret_basic'] as const)('uses explicit endpoints and %s without an implicit resource', async method => {
    const upstream = await provider();
    const { runtime, source, authorize, secrets } = await start();
    const clientId = 'configured : +/% client';
    await source(upstream.origin + '/mcp', {
      authorizationEndpoint: upstream.origin + '/authorize?resource=https://ignored.example&display=page',
      tokenEndpoint: upstream.origin + '/token', clientId, clientSecretName: 'operator-secret',
      tokenEndpointAuthMethod: method, scopes: ['custom'], extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    });
    await expect(runtime.startUpstreamOAuth('remote')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const handoff = (await runtime.testSource('remote')).authHandoff!;
    const ticket = new URL(handoff.authUrl).searchParams.get('ticket')!;
    await expect(runtime.startUpstreamOAuth('remote', { ticket, clientSecret: 'x'.repeat(16_385) }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(runtime.startUpstreamOAuth('remote', { ticket })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const started = await runtime.startUpstreamOAuth('remote', { ticket, clientSecret: operatorSecret });
    await expect(runtime.startUpstreamOAuth('remote', { ticket, clientSecret: operatorSecret })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const url = new URL(started.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: clientId, scope: 'custom', access_type: 'offline', prompt: 'consent', display: 'page' });
    expect(url.searchParams.has('resource')).toBe(false);
    await runtime.completeUpstreamOAuth(new URLSearchParams({ state: url.searchParams.get('state')!, code: authorizationCode }));
    const [{ params, authorization }] = upstream.exchanges;
    expect(params.has('resource')).toBe(false);
    expect(upstream.paths.some(path => path.startsWith('/.well-known'))).toBe(false);
    if (method === 'client_secret_post') {
      expect(params.get('client_id')).toBe(clientId);
      expect(params.get('client_secret')).toBe(operatorSecret);
      expect(authorization).toBeUndefined();
    } else {
      expect(params.has('client_id')).toBe(false);
      expect(params.has('client_secret')).toBe(false);
      expect(Buffer.from(authorization!.slice(6), 'base64').toString()).toBe(
        'configured+%3A+%2B%2F%25+client:credential+%3A+%2B%2F%25+with+spaces');
    }
    expect(JSON.stringify([await runtime.getSource('remote'), await runtime.exportConfig(), await runtime.getUpstreamOAuthStatus('remote')]))
      .not.toContain(operatorSecret);
    const pending = await authorize();
    await runtime.disconnectUpstreamOAuth('remote');
    expect(await secrets.get('operator-secret')).toBe(operatorSecret);
    expect(await runtime.getSource('remote')).toMatchObject({ health: 'auth_required', lastError: 'Upstream OAuth disconnected' });
    await expect(pending.finish()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await runtime.deleteSource('remote');
    expect(await secrets.get('operator-secret')).toBe(operatorSecret);
  });

  it('coalesces proactive and reactive refreshes, rotates and retains refresh tokens, and uses the cached challenge', async () => {
    const upstream = await provider();
    const { runtime, source, authorize, call, storage, secrets } = await start();
    await source(upstream.origin + '/mcp');
    await (await authorize()).finish();
    const tokenRecord = (await storage.getUpstreamOAuthToken('remote'))!;
    await storage.upsertUpstreamOAuthToken({ ...tokenRecord, expiresAt: new Date(Date.now() + 20_000).toISOString() });
    const proactive = await Promise.all([call('a'), call('b'), call('c')]);
    expect(proactive.map(reply => reply.result?.content[0].text)).toEqual(['oauth:a', 'oauth:b', 'oauth:c']);
    expect(upstream.refreshes).toHaveLength(1);
    expect(upstream.refreshes[0].params.get('refresh_token')).toBe(initialRefresh);
    expect(await secrets.get('oauth.refresh:remote')).toBe(rotatedRefresh);

    upstream.rejectMcp = true;
    upstream.refreshOmitsToken = true;
    const reactive = await Promise.all([call('d'), call('e')]);
    expect(reactive.map(reply => reply.result?.content[0].text)).toEqual(['oauth:d', 'oauth:e']);
    expect(upstream.refreshes).toHaveLength(2);
    expect(upstream.refreshes[1].params.get('refresh_token')).toBe(rotatedRefresh);
    expect(await secrets.get('oauth.refresh:remote')).toBe(rotatedRefresh);
    expect((await runtime.getUpstreamOAuthStatus('remote')).hasRefreshToken).toBe(true);

    upstream.onlyChallenge = true;
    const before = upstream.paths.length;
    await authorize();
    expect(upstream.paths.slice(before)[0]).toBe('/resource-metadata');
  });

  it('fails closed on invalid_grant, marks the source auth_required, and returns a handoff', async () => {
    const upstream = await provider();
    const { runtime, source, authorize, call, storage, secrets } = await start();
    await source(upstream.origin + '/mcp');
    await (await authorize()).finish();
    upstream.rejectMcp = true;
    upstream.failRefresh = true;
    const result = await call();
    expect(result.error.data).toMatchObject({ code: 'AUTH_REQUIRED',
      authHandoff: { authUrl: expect.stringContaining('/auth/connect/remote?ticket=') } });
    expect(JSON.stringify(result)).not.toContain(initialRefresh);
    expect(await runtime.getSource('remote')).toMatchObject({ health: 'auth_required' });
    expect(await runtime.getUpstreamOAuthStatus('remote')).toMatchObject({ connected: false, hasRefreshToken: false });
    expect(await secrets.has('oauth.access:remote')).toBe(false);
    expect(await secrets.has('oauth.refresh:remote')).toBe(false);
    expect((await storage.getUpstreamOAuthToken('remote'))?.refreshSecretName).toBeUndefined();
    await authorize();
    expect(upstream.refreshes).toHaveLength(1);
  });

  it('retries a rejected MCP request once and keeps saved credentials if capability discovery fails', async () => {
    const upstream = await provider();
    const { runtime, source, authorize, call } = await start();
    await source(upstream.origin + '/mcp');
    upstream.failDiscovery = true;
    expect(await (await authorize()).finish()).toMatchObject({ capabilityCount: 0, refreshError: expect.any(String) });
    expect(await runtime.getUpstreamOAuthStatus('remote')).toMatchObject({ connected: true });
    upstream.failDiscovery = false;
    await runtime.refreshSource('remote');
    upstream.rejectAlways = true;
    const before = upstream.credentials.length;
    expect((await call()).error.data.code).toBe('AUTH_REQUIRED');
    expect(upstream.refreshes).toHaveLength(1);
    expect(upstream.credentials.slice(before)).toHaveLength(2);
  });

  it('consumes denied and expired sessions and blocks mismatched issuers and broken PKCE', async () => {
    const upstream = await provider();
    const { runtime, source, authorize, storage, secrets } = await start();
    await source(upstream.origin + '/mcp');
    await secrets.set('private-marker', 'redact-this-private-value');
    await expect(runtime.completeUpstreamOAuth(new URLSearchParams())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(runtime.completeUpstreamOAuth(new URLSearchParams({ state: 'fake' }))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const expired = await authorize();
    const key = hashToken(expired.params.get('state')!);
    const record = (await storage.consumeUpstreamOAuthState(key))!;
    await storage.saveUpstreamOAuthState({ ...record, expiresAt: new Date(0).toISOString() });
    await expect(expired.finish()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await storage.consumeUpstreamOAuthState(key)).toBeNull();

    const denied = await authorize();
    denied.params.set('error', 'access_denied');
    denied.params.set('error_description', authorizationCode + ' redact-this-private-value');
    await expect(denied.finish()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED', message: 'Upstream OAuth provider denied authorization: access_denied: [REDACTED] [REDACTED]',
    });
    await expect(denied.finish()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const wrongIssuer = await authorize();
    wrongIssuer.params.set('iss', upstream.origin + '/other');
    await expect(wrongIssuer.finish()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const failingExchange = await authorize();
    failingExchange.params.set('code', 'raw-rejected-code');
    await expect(failingExchange.finish()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED', message: 'Upstream OAuth token exchange failed',
    });
    expect(upstream.exchanges).toHaveLength(1);
    upstream.issuerMismatch = true;
    await expect(authorize()).rejects.toThrow('issuer metadata does not match');
    upstream.issuerMismatch = false;
    upstream.noS256 = true;
    await expect(authorize()).rejects.toThrow('does not support S256 PKCE');
  });

  it('clears pending registration on disconnect and invalidates credentials when the source origin changes', async () => {
    const upstream = await provider();
    const { runtime, source, authorize, secrets } = await start();
    await source(upstream.origin + '/mcp');
    const pending = await authorize();
    expect(await secrets.has('oauth.client_secret:remote')).toBe(true);
    await runtime.disconnectUpstreamOAuth('remote');
    expect(await secrets.has('oauth.client_secret:remote')).toBe(false);
    await expect(pending.finish()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await (await authorize()).finish();
    const other = await provider();
    const stale = await authorize();
    await runtime.updateSource('remote', { config: { kind: 'mcp_http', url: other.origin + '/mcp' } });
    expect(await runtime.getUpstreamOAuthStatus('remote')).toMatchObject({ configured: true, connected: false });
    expect(await secrets.listMetadata()).toEqual([]);
    await expect(stale.finish()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(other.credentials).toEqual([]);
  });

  it('resets upstream OAuth when a same-origin URL path or query changes, by edit or by import', async () => {
    const upstream = await provider();
    const { runtime, source, authorize, secrets } = await start();
    await source(upstream.origin + '/mcp');
    await (await authorize()).finish();
    expect(await runtime.getUpstreamOAuthStatus('remote')).toMatchObject({ connected: true });
    await runtime.updateSource('remote', { config: { kind: 'mcp_http', url: upstream.origin + '/mcp/v2', headers: { 'x-fixture': 'static' } } });
    expect(await runtime.getUpstreamOAuthStatus('remote')).toMatchObject({ connected: false });
    expect(await secrets.listMetadata()).toEqual([]);

    await runtime.updateSource('remote', { config: { kind: 'mcp_http', url: upstream.origin + '/mcp', headers: { 'x-fixture': 'static' } } });
    await (await authorize()).finish();
    expect(await runtime.getUpstreamOAuthStatus('remote')).toMatchObject({ connected: true });
    const bundle = await runtime.exportConfig();
    const moved = { ...bundle, sources: bundle.sources.map(item => item.id === 'remote' && item.config.kind === 'mcp_http'
      ? { ...item, config: { ...item.config, url: upstream.origin + '/mcp?region=eu' } } : item) };
    await runtime.importConfig(moved, { merge: true });
    expect(await runtime.getUpstreamOAuthStatus('remote')).toMatchObject({ connected: false });
    expect(await secrets.listMetadata()).toEqual([]);
  });

  it('does not use or overwrite an unrelated vault entry reserved by its operator', async () => {
    const upstream = await provider();
    const { runtime, source, authorize, secrets } = await start();
    await runtime.setSecret('oauth.access:remote', 'operator-managed-credential');
    await source(upstream.origin + '/mcp');
    const pending = await authorize();
    expect(await runtime.getUpstreamOAuthStatus('remote')).toMatchObject({ connected: false });
    expect((await runtime.testSource('remote')).health).toBe('auth_required');
    await expect(pending.finish()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(upstream.credentials).toEqual([]);
    await runtime.deleteSource('remote');
    expect(await secrets.get('oauth.access:remote')).toBe('operator-managed-credential');
  });

  it('supports public dynamic registration and legacy static oauth2 bearer credentials', async () => {
    const upstream = await provider();
    upstream.publicRegistration = true;
    const { runtime, source, authorize, secrets, call } = await start();
    await source(upstream.origin + '/mcp');
    await (await authorize()).finish();
    expect(upstream.exchanges[0].params.get('client_id')).toBe('dynamic-client');
    expect(upstream.exchanges[0].params.has('client_secret')).toBe(false);
    expect(await secrets.has('oauth.client_secret:remote')).toBe(false);
    await runtime.deleteSource('remote');
    await runtime.setSecret('legacy-token', initialAccess);
    const legacy = await runtime.createSource({ id: 'legacy', name: 'Legacy', kind: 'mcp_http',
      config: { kind: 'mcp_http', url: upstream.origin + '/mcp' }, authConfig: { kind: 'oauth2', secretName: 'legacy-token' } });
    expect(legacy.health).toBe('healthy');
    expect(await runtime.getUpstreamOAuthStatus('legacy')).toMatchObject({ configured: false, connected: false });
    expect((await call()).result.content[0].text).toBe('oauth:hello');
  });
});

describe('upstream OAuth URL and configuration boundaries', () => {
  const input = { id: 'oauth', name: 'OAuth', kind: 'mcp_http', enabled: true, refreshPolicy: { mode: 'manual' },
    config: { kind: 'mcp_http', url: 'https://example.com/mcp' } };

  it('rejects raw credentials, protocol parameter overrides and interactive auth on other source kinds', async () => {
    const config = (oauth: unknown) => ({ ...input, authConfig: { kind: 'oauth2', oauth } });
    const secrets = new InMemorySecretStore();
    await secrets.set('private', 'a-known-raw-secret');
    for (const oauth of [
      { clientSecret: 'raw' }, { extraAuthParams: { AUTHORIZATION_TOKEN: 'raw' } },
      { extraAuthParams: { CLIENT_ID: 'override' } }, { extraAuthParams: { resource: 'override' } },
      { extraAuthParams: { prompt: 'a-known-raw-secret' } },
      { authorizationEndpoint: 'https://user:pass@example.com' },
      { tokenEndpoint: 'https://example.com/token#' }, { tokenEndpoint: 'https://example.com/token?client_secret=raw' },
    ]) expect(() => validateSourceConfig(config(oauth), secrets)).toThrow();
    expect(() => validateSourceConfig({ ...input, authConfig: { kind: 'none', oauth: {} } })).toThrow();
    expect(() => validateSourceConfig({ ...input, authConfig: { kind: 'oauth2' } })).toThrow();
    expect(() => validateSourceConfig({ ...config({}), kind: 'skill',
      config: { kind: 'skill', slug: 'demo', title: 'Demo', description: '', content: '' } }))
      .toThrow('Interactive OAuth is only supported for mcp_http sources');
  });

  it.each(['http://198.51.100.1/token', 'https://169.254.169.254/token', 'http://localhost/token',
    'https://127.0.0.1/token', 'https://[::ffff:169.254.169.254]/token'])('blocks unsafe OAuth destination %s', async endpoint => {
    const { runtime, source } = await start();
    await source('https://example.com/mcp', { authorizationEndpoint: endpoint, tokenEndpoint: endpoint, clientId: 'client' });
    await expect(runtime.startUpstreamOAuth('remote')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('uses only validated loopback addresses for a localhost token endpoint', async () => {
    const upstream = await provider();
    const { source, authorize } = await start();
    const localhost = upstream.origin.replace('127.0.0.1', 'localhost');
    await source(upstream.origin + '/mcp', { authorizationEndpoint: localhost + '/authorize',
      tokenEndpoint: localhost + '/token', clientId: 'client' });
    expect((await (await authorize()).finish()).capabilityCount).toBe(3);
    expect(upstream.exchanges).toHaveLength(1);
  });

  it('allows injected HTTP loopback only with the explicit option for a remote source', async () => {
    const { source, authorize } = await start({ allowInsecureLocalOAuth: true, oauthFetch: async () => new Response(null, { status: 404 }) });
    await source('https://example.com/mcp', { authorizationEndpoint: 'http://localhost/authorize',
      tokenEndpoint: 'http://localhost/token', clientId: 'client' });
    expect((await authorize()).url.origin).toBe('http://localhost');
  });

  it('refuses redirects and oversized token responses without saving credentials', async () => {
    const requests: Request[] = [];
    let redirect = true;
    const { runtime, source, authorize } = await start({ oauthFetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (redirect) return Response.redirect('https://blocked.example/token');
      return Response.json({ access_token: 'x'.repeat(256 * 1024) });
    } });
    await source('https://example.com/mcp', { authorizationEndpoint: 'https://example.com/authorize',
      tokenEndpoint: 'https://example.com/token', clientId: 'client' });
    await expect((await authorize()).finish()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    redirect = false;
    await expect((await authorize()).finish()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.redirect === 'error' && request.url === 'https://example.com/token')).toBe(true);
    expect(await runtime.getUpstreamOAuthStatus('remote')).toMatchObject({ connected: false });
  });

  it('refuses source vault references to gateway-managed OAuth credentials of any source', async () => {
    const upstream = await provider();
    const { runtime, source, authorize } = await start();
    await source(upstream.origin + '/mcp');
    await (await authorize()).finish();
    const mcp = { kind: 'mcp_http' as const, url: upstream.origin + '/mcp' };
    const attempts = [
      { kind: 'bearer_secret' as const, secretName: 'oauth.access:remote' },
      { kind: 'header_secret' as const, secretName: 'OAuth.Refresh:remote', headerName: 'x-token' },
      { kind: 'oauth2' as const, oauth: { clientId: 'client', clientSecretName: 'oauth.refresh:remote',
        authorizationEndpoint: upstream.origin + '/authorize', tokenEndpoint: upstream.origin + '/token' } },
      { kind: 'oauth2' as const, oauth: { clientId: 'client', clientSecretName: 'oauth.client_secret:remote',
        authorizationEndpoint: upstream.origin + '/authorize', tokenEndpoint: upstream.origin + '/token' } },
      { kind: 'none' as const, requiredSecrets: ['oauth.access:remote'] },
    ];
    for (const authConfig of attempts) {
      await expect(runtime.createSource({ id: 'thief', name: 'Thief', kind: 'mcp_http', config: mcp, authConfig,
        refreshPolicy: { mode: 'manual' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(runtime.createSource({ id: 'thief', name: 'Thief', kind: 'mcp_stdio',
      config: { kind: 'mcp_stdio', command: 'node', args: [] },
      authConfig: { kind: 'env_secrets', envMap: { TOKEN: 'oauth.access:remote' } } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const bundle = await runtime.exportConfig();
    bundle.sources.push({ id: 'thief', name: 'Thief', kind: 'mcp_http', enabled: true, config: mcp,
      authConfig: { kind: 'bearer_secret', secretName: 'oauth.access:remote' }, refreshPolicy: { mode: 'on_connect' } });
    await expect(runtime.importConfig(bundle, { merge: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await runtime.getSource('thief')).toBeNull();
    expect(upstream.credentials.every(({ auth }) => auth === 'Bearer ' + initialAccess)).toBe(true);
    expect(upstream.credentials.length).toBeGreaterThan(0);
  });
});
