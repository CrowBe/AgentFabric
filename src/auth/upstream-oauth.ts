import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TcpNetConnectOpts } from 'node:net';
import { z } from 'zod';
import { publicWebhookAddress } from '../mcp/events.js';
import { GatewayError, type SecretStore, type SourceRecord, type StorageAdapter,
  type UpstreamOAuthStateRecord, type UpstreamOAuthStatus, type UpstreamOAuthTokenRecord } from '../types/index.js';
import { isCredentialFreeOAuthUrl, managedOAuthSecretName, oauthAuthMethodSchema, oauthProtocolParams } from '../validation/upstream-oauth.js';
import { hashToken, randomToken } from './middleware.js';

const responseLimit = 256 * 1024;
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
const jsonObject = z.record(z.string(), z.unknown());
const tokenResponse = z.object({
  access_token: z.string().regex(/^[\x21-\x7e]+$/),
  refresh_token: z.string().optional(),
  token_type: z.string().min(1).max(64).optional(),
  scope: z.string().optional(),
  expires_in: z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)])
    .pipe(z.number().min(0).max(8e12)).optional(),
});
const registrationResponse = z.object({
  client_id: z.string().min(1).max(512),
  client_secret: z.string().min(1).optional(),
  token_endpoint_auth_method: oauthAuthMethodSchema.optional(),
});

type Client = Pick<UpstreamOAuthTokenRecord, 'clientId' | 'clientSecretName' | 'dcrClientSecretName' | 'tokenEndpointAuthMethod'>;
type Metadata = Pick<UpstreamOAuthStateRecord, 'authorizationEndpoint' | 'tokenEndpoint' | 'issuer' | 'resource'> & {
  registrationEndpoint?: string;
  discoveredScopes?: string[];
};
type JsonResponse = { status: number; data?: Record<string, unknown> };

const accessName = (id: string) => managedOAuthSecretName('oauth.access:', id);
const refreshName = (id: string) => managedOAuthSecretName('oauth.refresh:', id);
const dcrName = (id: string) => managedOAuthSecretName('oauth.client_secret:', id);
const refreshError = () => new GatewayError('AUTH_REQUIRED', 'Upstream OAuth token refresh failed; re-authorization required');

function configuration(source: SourceRecord) {
  if (source.config.kind !== 'mcp_http' || source.authConfig.kind !== 'oauth2' || !source.authConfig.oauth) {
    throw new GatewayError('INVALID_INPUT', 'Source is not configured for upstream OAuth');
  }
  return source.authConfig.oauth;
}

function formEncode(value: string) {
  return new URLSearchParams([['', value]]).toString().slice(1);
}

function parseObject(text: string) {
  try { return jsonObject.parse(JSON.parse(text)); } catch { return undefined; }
}

function scopes(value: unknown) {
  return Array.isArray(value) && value.every(scope => typeof scope === 'string') ? value as string[] : undefined;
}

function string(value: unknown) {
  return typeof value === 'string' && value.length ? value : undefined;
}

function success(status: number) {
  return status >= 200 && status < 300;
}

async function readBounded(response: Response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      length += value.byteLength;
      if (length > responseLimit) throw new Error('Response too large');
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function pinnedRequest(url: URL, addresses: { address: string; family: number }[],
  signal: AbortSignal, headers: Record<string, string>, body?: string): Promise<JsonResponse> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const options: RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily'> = {
    method: body === undefined ? 'GET' : 'POST', agent: false, signal, autoSelectFamily: true,
    lookup: (_hostname, query, done) => {
      if (query.all) done(null, addresses);
      else done(null, addresses[0].address, addresses[0].family);
    },
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) },
  };
  return new Promise((resolve, reject) => {
    const req = request(url, options, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        reject(new Error('Redirect refused'));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > responseLimit) req.destroy(new Error('Response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status, data: parseObject(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function createUpstreamOAuth({ storage, secrets, publicUrl, fetchImpl, allowInsecureLocalOAuth }: {
  storage: StorageAdapter;
  secrets: SecretStore;
  publicUrl: string;
  fetchImpl?: typeof fetch;
  allowInsecureLocalOAuth?: boolean;
}) {
  const redirectUri = `${publicUrl}/auth/oauth/callback`;
  const challenges = new Map<string, string>();
  const work = new Map<string, Promise<unknown>>();
  const refreshing = new Map<string, Promise<string>>();
  const stateClaims = new Set<Set<string>>();

  function serial<T>(id: string, operation: () => Promise<T>) {
    const previous = work.get(id);
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(operation);
    work.set(id, pending);
    return pending.finally(() => { if (work.get(id) === pending) work.delete(id); });
  }

  function oauthUrl(value: string, source: SourceRecord) {
    let url: URL;
    try { url = new URL(value); } catch { throw new GatewayError('INVALID_INPUT', 'Invalid upstream OAuth URL'); }
    if (!isCredentialFreeOAuthUrl(url)) throw new GatewayError('INVALID_INPUT', 'Invalid upstream OAuth URL');
    const local = loopback.has(url.hostname) && (allowInsecureLocalOAuth ||
      (source.config.kind === 'mcp_http' && loopback.has(new URL(source.config.url).hostname)));
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new GatewayError('INVALID_INPUT', 'Upstream OAuth URLs must use HTTPS or permitted HTTP loopback');
    }
    return { url, local };
  }

  async function assertSafeOAuthUrl(value: string, source: SourceRecord, signal = AbortSignal.timeout(10_000)) {
    const { url, local } = oauthUrl(value, source);
    if (fetchImpl) return { url };
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: { address: string; family: number }[];
    try {
      addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        void lookup(hostname, { all: true }).then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
    } catch {
      throw new GatewayError('INVALID_INPUT', 'Upstream OAuth host could not be resolved');
    }
    if (!addresses.length || addresses.some(({ address, family }) => local
      ? address !== '127.0.0.1' && address !== '::1'
      : !publicWebhookAddress(address, family))) {
      throw new GatewayError('INVALID_INPUT', 'Upstream OAuth host must resolve to a permitted IP address');
    }
    return { url, addresses };
  }

  const isWorkersRuntime = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

  async function requestJson(value: string, source: SourceRecord, headers: Record<string, string> = {}, body?: string) {
    const signal = AbortSignal.timeout(10_000);
    const { url, addresses } = await assertSafeOAuthUrl(value, source, signal);
    try {
      const requestHeaders = { Accept: 'application/json', ...headers };
      if (addresses && !isWorkersRuntime) return await pinnedRequest(url, addresses, signal, requestHeaders, body);
      const response = await (fetchImpl ?? fetch)(url, {
        method: body === undefined ? 'GET' : 'POST', headers: requestHeaders, body, redirect: 'error', signal,
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Redirect refused');
      }
      return { status: response.status, data: parseObject(await readBounded(response)) };
    } catch {
      throw new GatewayError('UPSTREAM_ERROR', 'Upstream OAuth request failed');
    }
  }

  async function discover(candidates: (string | undefined)[], source: SourceRecord) {
    for (const candidate of new Set(candidates)) {
      if (!candidate) continue;
      try {
        const { status, data } = await requestJson(candidate, source);
        if (success(status) && data) return data;
      } catch {
      }
    }
    return undefined;
  }

  async function resolveMetadata(source: SourceRecord): Promise<Metadata> {
    const oauth = configuration(source);
    if (source.config.kind !== 'mcp_http') throw new GatewayError('INVALID_INPUT', 'Expected an MCP HTTP source');
    const { url: mcpUrl } = oauthUrl(source.config.url, source);
    const explicit = oauth.authorizationEndpoint && oauth.tokenEndpoint;
    let metadata: Record<string, unknown> | undefined;
    let issuer: string | undefined;
    let resource = oauth.resource;
    let discoveredScopes: string[] | undefined;
    if (!explicit) {
      const base = `${mcpUrl.origin}/.well-known/oauth-protected-resource`;
      const protectedResource = await discover([
        challenges.get(source.id), base + (mcpUrl.pathname !== '/' ? mcpUrl.pathname : ''), base,
      ], source);
      const servers = protectedResource?.authorization_servers;
      const { url: issuerUrl } = await assertSafeOAuthUrl(
        (Array.isArray(servers) && string(servers[0])) || mcpUrl.origin, source,
      );
      if (issuerUrl.search) throw new GatewayError('INVALID_INPUT', 'Upstream OAuth issuer must be free of query parameters');
      issuer = issuerUrl.href.replace(/\/+$/, '');
      const path = issuerUrl.pathname.replace(/\/+$/, '');
      metadata = await discover([
        `${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuerUrl.origin}/.well-known/openid-configuration${path}`,
        path ? `${issuerUrl.origin}${path}/.well-known/openid-configuration` : undefined,
      ], source);
      if (metadata?.issuer !== undefined && string(metadata.issuer)?.replace(/\/+$/, '') !== issuer) {
        throw new GatewayError('UPSTREAM_ERROR', 'Upstream OAuth issuer metadata does not match');
      }
      const methods = metadata?.code_challenge_methods_supported;
      if (Array.isArray(methods) && !methods.includes('S256')) {
        throw new GatewayError('UPSTREAM_ERROR', 'Upstream OAuth server does not support S256 PKCE');
      }
      resource ??= string(protectedResource?.resource) ?? mcpUrl.href;
      discoveredScopes = scopes(protectedResource?.scopes_supported) ?? scopes(metadata?.scopes_supported);
    }
    const authorizationEndpoint = oauth.authorizationEndpoint ?? string(metadata?.authorization_endpoint);
    const tokenEndpoint = oauth.tokenEndpoint ?? string(metadata?.token_endpoint);
    const registrationEndpoint = oauth.registrationEndpoint ?? string(metadata?.registration_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) throw new GatewayError('UPSTREAM_ERROR', 'Upstream OAuth endpoints could not be discovered');
    await Promise.all([authorizationEndpoint, tokenEndpoint, registrationEndpoint].filter(value => value !== undefined)
      .map(value => assertSafeOAuthUrl(value, source)));
    if (resource) oauthUrl(resource, source);
    return { authorizationEndpoint, tokenEndpoint, registrationEndpoint, issuer, resource, discoveredScopes };
  }

  async function requiredSecret(name?: string) {
    const value = name && await secrets.get(name);
    if (!value) throw new GatewayError('AUTH_REQUIRED', name
      ? `Required vault secret '${name}' is missing` : 'Upstream OAuth requires a client secret');
    return value;
  }

  async function resolveClient(source: SourceRecord, metadata: Metadata): Promise<Client> {
    const oauth = configuration(source);
    if (oauth.clientId) {
      const method = oauth.tokenEndpointAuthMethod ?? (oauth.clientSecretName ? 'client_secret_post' : 'none');
      if (oauth.clientSecretName || method !== 'none') await requiredSecret(oauth.clientSecretName);
      return { clientId: oauth.clientId, clientSecretName: oauth.clientSecretName, tokenEndpointAuthMethod: method };
    }
    const existing = await storage.getUpstreamOAuthToken(source.id);
    if (existing && !existing.clientSecretName && existing.tokenEndpoint === metadata.tokenEndpoint && existing.issuer === metadata.issuer) {
      if (existing.dcrClientSecretName) await requiredSecret(existing.dcrClientSecretName);
      return { clientId: existing.clientId, dcrClientSecretName: existing.dcrClientSecretName,
        tokenEndpointAuthMethod: existing.tokenEndpointAuthMethod };
    }
    if (!metadata.registrationEndpoint) {
      throw new GatewayError('AUTH_REQUIRED', 'Upstream OAuth requires a pre-configured clientId (Dynamic Client Registration unavailable)');
    }
    if (existing) await clearCredentials(source.id, existing);
    const preferredMethod = oauth.tokenEndpointAuthMethod ?? 'none';
    const { status, data } = await requestJson(metadata.registrationEndpoint, source, { 'Content-Type': 'application/json' }, JSON.stringify({
      client_name: 'AgentFabric', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: preferredMethod,
    }));
    const registered = registrationResponse.safeParse(data);
    if (!success(status) || !registered.success) throw new GatewayError('UPSTREAM_ERROR', 'Upstream OAuth client registration failed');
    const { client_id, client_secret, token_endpoint_auth_method } = registered.data;
    const method = token_endpoint_auth_method ?? (client_secret ? 'client_secret_post' : 'none');
    if (method !== 'none' && !client_secret) throw new GatewayError('UPSTREAM_ERROR', 'Upstream OAuth registration did not provide a client secret');
    const dcrClientSecretName = client_secret ? dcrName(source.id) : undefined;
    const client = { clientId: client_id, dcrClientSecretName, tokenEndpointAuthMethod: method };
    if (dcrClientSecretName && client_secret) {
      if (await secrets.has(dcrClientSecretName)) throw new GatewayError('CONFLICT', 'Upstream OAuth vault name is already in use');
      await secrets.set(dcrClientSecretName, client_secret);
    }
    try {
      await storage.upsertUpstreamOAuthToken({
        ...client, sourceId: source.id, accessSecretName: accessName(source.id),
        authorizationEndpoint: metadata.authorizationEndpoint, tokenEndpoint: metadata.tokenEndpoint,
        issuer: metadata.issuer, resource: metadata.resource, tokenType: '', updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (dcrClientSecretName) await secrets.delete(dcrClientSecretName);
      throw error;
    }
    return client;
  }

  async function tokenRequest(source: SourceRecord, record: Client & { tokenEndpoint: string; resource?: string }, params: URLSearchParams) {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const method = record.tokenEndpointAuthMethod;
    if (method === 'none') params.set('client_id', record.clientId);
    else {
      const secret = await requiredSecret(record.clientSecretName ?? record.dcrClientSecretName);
      if (method === 'client_secret_basic') {
        headers.Authorization = 'Basic ' + Buffer.from(`${formEncode(record.clientId)}:${formEncode(secret)}`).toString('base64');
      } else {
        params.set('client_id', record.clientId);
        params.set('client_secret', secret);
      }
    }
    if (record.resource) params.set('resource', record.resource);
    return requestJson(record.tokenEndpoint, source, headers, params.toString());
  }

  async function saveTokens(record: UpstreamOAuthTokenRecord, data: z.output<typeof tokenResponse>,
    previous: UpstreamOAuthTokenRecord | null, preserveRefresh = false) {
    const refreshSecretName = refreshName(record.sourceId);
    const ownedAccess = !!previous?.tokenType && previous.accessSecretName === record.accessSecretName;
    const ownedRefresh = previous?.refreshSecretName === refreshSecretName;
    const clientSecretName = record.clientSecretName;
    if (clientSecretName === record.accessSecretName || clientSecretName === refreshSecretName
      || (!ownedAccess && await secrets.has(record.accessSecretName))
      || (data.refresh_token && !ownedRefresh && await secrets.has(refreshSecretName))) {
      throw new GatewayError('CONFLICT', 'Upstream OAuth vault name is already in use');
    }
    const nextRefreshName = data.refresh_token ? refreshSecretName : preserveRefresh ? previous?.refreshSecretName : undefined;
    const now = Date.now();
    try {
      if (data.refresh_token) await secrets.set(refreshSecretName, data.refresh_token);
      else if (!nextRefreshName && ownedRefresh) await secrets.delete(refreshSecretName);
      await secrets.set(record.accessSecretName, data.access_token);
      const next = {
        ...record, refreshSecretName: nextRefreshName, tokenType: data.token_type ?? record.tokenType,
        scope: data.scope === undefined ? record.scope : secrets.redact(data.scope), updatedAt: new Date(now).toISOString(),
        expiresAt: data.expires_in === undefined ? undefined : new Date(now + data.expires_in * 1000).toISOString(),
      };
      await storage.upsertUpstreamOAuthToken(next);
      return next;
    } catch (error) {
      await secrets.delete(record.accessSecretName);
      if (data.refresh_token && !ownedRefresh) await secrets.delete(refreshSecretName);
      throw error;
    }
  }

  async function clearCredentials(sourceId: string, record: UpstreamOAuthTokenRecord | null) {
    await storage.deleteUpstreamOAuthStatesBySource(sourceId);
    for (const claim of stateClaims) claim.add(sourceId);
    if (record?.tokenType && record.accessSecretName !== record.clientSecretName) {
      await secrets.delete(record.accessSecretName);
    }
    if (record?.refreshSecretName && record.refreshSecretName !== record.clientSecretName) {
      await secrets.delete(record.refreshSecretName);
    }
    if (record?.dcrClientSecretName && record.dcrClientSecretName !== record.clientSecretName) {
      await secrets.delete(record.dcrClientSecretName);
    }
    await storage.deleteUpstreamOAuthToken(sourceId);
  }

  return {
    recordWwwAuthenticate(sourceId: string, header: string) {
      const parameters = /(?:^|[\s,])([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
      for (const [, name, quoted, unquoted] of header.matchAll(parameters)) {
        const value = quoted?.replace(/\\(.)/g, '$1') ?? unquoted;
        if (name.toLowerCase() === 'resource_metadata' && value && value.length <= 4096) {
          challenges.set(sourceId, value);
          break;
        }
      }
    },

    startAuthorization(source: SourceRecord, prepare?: (current: SourceRecord) => Promise<void>) {
      return serial(source.id, async () => {
        const current = await storage.getSource(source.id);
        if (!current || current.updatedAt !== source.updatedAt) throw new GatewayError('CONFLICT', 'Source configuration changed');
        const oauth = configuration(current);
        await prepare?.(current);
        const metadata = await resolveMetadata(current);
        const client = await resolveClient(current, metadata);
        const codeVerifier = randomBytes(48).toString('base64url');
        const state = randomToken('af_oauth_state_');
        const scope = (oauth.scopes?.length ? oauth.scopes : metadata.discoveredScopes)?.join(' ') || undefined;
        const authorizeUrl = new URL(metadata.authorizationEndpoint);
        for (const key of [...authorizeUrl.searchParams.keys()]) {
          if (oauthProtocolParams.includes(key.toLowerCase())) authorizeUrl.searchParams.delete(key);
        }
        const authParams = {
          ...oauth.extraAuthParams, response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri, state,
          code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256',
          ...(scope ? { scope } : {}), ...(metadata.resource ? { resource: metadata.resource } : {}),
        };
        for (const [name, value] of Object.entries(authParams)) authorizeUrl.searchParams.set(name, value);
        await assertSafeOAuthUrl(authorizeUrl.href, current);
        const now = Math.max(Date.now(), Date.parse(current.updatedAt));
        await storage.saveUpstreamOAuthState({
          ...client, sourceId: current.id, stateHash: hashToken(state), codeVerifier, redirectUri, scope,
          authorizationEndpoint: metadata.authorizationEndpoint, tokenEndpoint: metadata.tokenEndpoint,
          issuer: metadata.issuer, resource: metadata.resource, createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 10 * 60_000).toISOString(),
        });
        return { authorizeUrl: authorizeUrl.href, redirectUri };
      });
    },

    async completeAuthorization(params: URLSearchParams) {
      const state = params.get('state');
      if (!state) throw new GatewayError('INVALID_INPUT', 'Missing OAuth state parameter');
      if (['state', 'code', 'error', 'error_description', 'iss'].some(key => params.getAll(key).length > 1)) {
        throw new GatewayError('INVALID_INPUT', 'Duplicate OAuth callback parameter');
      }
      const invalidSession = () => new GatewayError('UNAUTHORIZED', 'OAuth authorization session is invalid or expired');
      const resets = new Set<string>();
      stateClaims.add(resets);
      try {
        const record = await storage.consumeUpstreamOAuthState(hashToken(state));
        if (!record || !(Date.parse(record.expiresAt) > Date.now())) throw invalidSession();
        return await serial(record.sourceId, async () => {
          if (resets.has(record.sourceId)) throw invalidSession();
          stateClaims.delete(resets);
          const source = await storage.getSource(record.sourceId);
          if (!source || !source.authConfig.oauth || Date.parse(source.updatedAt) > Date.parse(record.createdAt)) throw invalidSession();
          configuration(source);
          const issuer = params.get('iss');
          if (issuer !== null && record.issuer && issuer.replace(/\/+$/, '') !== record.issuer) throw invalidSession();
          const code = params.get('code');
          const error = params.get('error');
          if (error) {
            const description = params.get('error_description');
            let message = `Upstream OAuth provider denied authorization: ${error}${description ? ': ' + description : ''}`;
            for (const sensitive of [state, code, record.codeVerifier, params.get('access_token'), params.get('refresh_token'), params.get('client_secret')]) {
              if (sensitive) message = message.replaceAll(sensitive, '[REDACTED]');
            }
            const clientSecretName = record.clientSecretName ?? record.dcrClientSecretName;
            const clientSecret = clientSecretName && await secrets.get(clientSecretName);
            if (clientSecret) message = message.replaceAll(clientSecret, '[REDACTED]');
            throw new GatewayError('AUTH_REQUIRED', secrets.redact(message));
          }
          if (!code) throw new GatewayError('INVALID_INPUT', 'Missing OAuth authorization code');
          const { status, data } = await tokenRequest(source, record, new URLSearchParams({
            grant_type: 'authorization_code', code, redirect_uri: record.redirectUri, code_verifier: record.codeVerifier,
          }));
          const parsed = tokenResponse.safeParse(data);
          if (!success(status) || !parsed.success) throw new GatewayError('AUTH_REQUIRED', 'Upstream OAuth token exchange failed');
          const previous = await storage.getUpstreamOAuthToken(source.id);
          const tokenRecord = await saveTokens({
            sourceId: source.id, accessSecretName: accessName(source.id),
            clientId: record.clientId, clientSecretName: record.clientSecretName, dcrClientSecretName: record.dcrClientSecretName,
            authorizationEndpoint: record.authorizationEndpoint, tokenEndpoint: record.tokenEndpoint, issuer: record.issuer,
            tokenEndpointAuthMethod: record.tokenEndpointAuthMethod, tokenType: 'Bearer', scope: record.scope,
            resource: record.resource, updatedAt: record.createdAt,
          }, parsed.data, previous);
          return { source, tokenRecord };
        });
      } finally {
        stateClaims.delete(resets);
      }
    },

    async getAccessToken(source: SourceRecord, { forceRefresh = false, rejectedToken }: { forceRefresh?: boolean; rejectedToken?: string } = {}) {
      const { config } = source;
      if (config.kind !== 'mcp_http') throw new GatewayError('INVALID_INPUT', 'Expected an MCP HTTP source');
      oauthUrl(config.url, source);
      const current = await storage.getSource(source.id);
      if (!current || current.updatedAt !== source.updatedAt) throw new GatewayError('AUTH_REQUIRED', 'Upstream OAuth authorization is required');
      const existing = refreshing.get(source.id);
      if (existing) return existing;
      await work.get(source.id)?.catch(() => {});
      if ((await storage.getSource(source.id))?.updatedAt !== source.updatedAt) {
        throw new GatewayError('AUTH_REQUIRED', 'Upstream OAuth authorization is required');
      }
      const record = await storage.getUpstreamOAuthToken(source.id);
      if (!record?.tokenType) throw new GatewayError('AUTH_REQUIRED', 'Upstream OAuth authorization is required');
      const accessToken = await secrets.get(record.accessSecretName);
      const valid = accessToken && (!record.expiresAt || Date.parse(record.expiresAt) - 60_000 > Date.now());
      if (valid && (!forceRefresh || (rejectedToken !== undefined && rejectedToken !== accessToken))) return accessToken;
      const pending = refreshing.get(source.id);
      if (pending) return pending;
      const refresh = serial(source.id, async () => {
        const latest = await storage.getUpstreamOAuthToken(source.id);
        if (!latest?.tokenType || (await storage.getSource(source.id))?.updatedAt !== source.updatedAt) {
          throw new GatewayError('AUTH_REQUIRED', 'Upstream OAuth authorization is required');
        }
        const latestAccess = await secrets.get(latest.accessSecretName);
        if (latestAccess && latestAccess !== (rejectedToken ?? accessToken)
          && (!latest.expiresAt || Date.parse(latest.expiresAt) - 60_000 > Date.now())) return latestAccess;
        const refreshToken = latest.refreshSecretName && await secrets.get(latest.refreshSecretName);
        if (!refreshToken) {
          await secrets.delete(latest.accessSecretName);
          throw new GatewayError('AUTH_REQUIRED', 'Upstream OAuth token expired; re-authorization required');
        }
        let response: JsonResponse;
        try {
          response = await tokenRequest(source, latest, new URLSearchParams({
            grant_type: 'refresh_token', refresh_token: refreshToken,
          }));
        } catch {
          await secrets.delete(latest.accessSecretName);
          throw refreshError();
        }
        const parsed = tokenResponse.safeParse(response.data);
        if (!success(response.status) || !parsed.success) {
          await secrets.delete(latest.accessSecretName);
          if (response.data?.error === 'invalid_grant') {
            await secrets.delete(refreshName(source.id));
            await storage.upsertUpstreamOAuthToken({ ...latest, refreshSecretName: undefined, expiresAt: undefined,
              updatedAt: new Date().toISOString() });
          }
          throw refreshError();
        }
        await saveTokens(latest, parsed.data, latest, true);
        return parsed.data.access_token;
      });
      refreshing.set(source.id, refresh);
      return refresh.finally(() => { if (refreshing.get(source.id) === refresh) refreshing.delete(source.id); });
    },

    disconnect(sourceId: string, afterDisconnect?: () => Promise<void>) {
      return serial(sourceId, async () => {
        challenges.delete(sourceId);
        await clearCredentials(sourceId, await storage.getUpstreamOAuthToken(sourceId));
        await afterDisconnect?.();
      });
    },

    async getStatus(source: SourceRecord): Promise<UpstreamOAuthStatus> {
      const oauth = source.authConfig.kind === 'oauth2' ? source.authConfig.oauth : undefined;
      const record = oauth ? await storage.getUpstreamOAuthToken(source.id) : null;
      const [hasAccess, hasRefreshToken] = await Promise.all([
        record?.tokenType ? secrets.has(record.accessSecretName) : false,
        record?.refreshSecretName ? secrets.has(record.refreshSecretName) : false,
      ]);
      const visible = (value?: string) => value === undefined ? undefined : secrets.redact(value);
      return {
        configured: !!oauth, connected: hasAccess && (hasRefreshToken || !record?.expiresAt || Date.parse(record.expiresAt) > Date.now()),
        redirectUri, hasRefreshToken, expiresAt: record?.expiresAt, scope: visible(record?.scope),
        clientId: visible(record?.clientId ?? oauth?.clientId),
        authorizationEndpoint: visible(record?.authorizationEndpoint ?? oauth?.authorizationEndpoint),
        tokenEndpoint: visible(record?.tokenEndpoint ?? oauth?.tokenEndpoint),
      };
    },
  };
}

export type UpstreamOAuthManager = ReturnType<typeof createUpstreamOAuth>;
