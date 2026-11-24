import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { GatewayRuntime, OAuthAuthorizationCodeRecord, OAuthAuthorizeValidationResult, OAuthRefreshTokenRecord, StorageAdapter } from '../types/index.js';
import { GatewayError } from '../types/index.js';
import { hashToken, issueClientToken, randomToken } from './middleware.js';

const proofPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const challengePattern = /^[A-Za-z0-9_-]{43}$/;
const accessLifetime = 3600;
const refreshLifetime = 30 * 24 * 3600_000;

const registration = z.object({
  client_name: z.string().trim().min(1).max(200).default('MCP client'),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(16),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).length(1).default(['code']),
  token_endpoint_auth_method: z.literal('none').default('none'),
  scope: z.literal('mcp').optional(),
});

function validRedirect(value: string) {
  try {
    const url = new URL(value);
    return !value.includes('#') && !url.username && !url.password && (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
    );
  } catch { return false; }
}

function redirectMatches(value: string, registered: string) {
  if (!validRedirect(value)) return false;
  if (value === registered) return true;
  const uri = new URL(value);
  const reference = new URL(registered);
  if (uri.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(uri.hostname)) return false;
  uri.port = '';
  reference.port = '';
  return uri.href === reference.href;
}

function oauthError(error: string, error_description: string, status = 400) {
  return Response.json({ error, error_description }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function createOAuth(storage: StorageAdapter, publicUrl: string) {
  const exchanges = new Set<string>();

  async function validateOAuthAuthorize(params: URLSearchParams): Promise<OAuthAuthorizeValidationResult> {
    for (const key of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'profile', 'state', 'resource']) {
      if (params.getAll(key).length > 1) return { ok: false, error: 'invalid_request', description: 'Duplicate authorization parameter' };
    }
    const client = await storage.getOAuthClient(params.get('client_id') ?? '');
    const redirectUri = params.get('redirect_uri') ?? '';
    const codeChallenge = params.get('code_challenge') ?? '';
    const scope = params.get('scope') ?? 'mcp';
    const state = params.get('state') ?? undefined;
    const resource = params.get('resource');
    let resourceProfile: string | undefined;
    const resourcePrefix = `${publicUrl}/mcp/`;
    if (resource?.startsWith(resourcePrefix)) {
      try { resourceProfile = decodeURIComponent(resource.slice(resourcePrefix.length)); }
      catch { return { ok: false, error: 'invalid_target', description: 'Invalid MCP resource' }; }
    }
    const profile = await storage.getProfile(params.get('profile') ?? resourceProfile ?? 'default');
    if (!client || !client.redirectUris.some(uri => redirectMatches(redirectUri, uri))) {
      return { ok: false, error: 'invalid_request', description: 'Client or redirect URI is invalid' };
    }
    if (params.get('response_type') !== 'code') return { ok: false, error: 'unsupported_response_type', description: 'Use response_type=code' };
    if (scope !== 'mcp') return { ok: false, error: 'invalid_scope', description: 'Only the mcp scope is supported' };
    if (!challengePattern.test(codeChallenge) || params.get('code_challenge_method') !== 'S256' || !profile) {
      return { ok: false, error: 'invalid_request', description: 'A valid S256 PKCE challenge and profile are required' };
    }
    if (resource && !resourceMatches(resource, profile.id, profile.name)) {
      return { ok: false, error: 'invalid_target', description: 'Invalid MCP resource for this profile' };
    }
    return { ok: true, client, redirectUri, codeChallenge, scope, profileId: profile.id, state };
  }

  function resourceMatches(resource: string, profileId: string, profileName: string) {
    return ((profileId === 'default' && resource === `${publicUrl}/mcp`) ||
      [profileId, profileName].some(profile => resource === `${publicUrl}/mcp/${encodeURIComponent(profile)}`));
  }

  const approveOAuthAuthorize: GatewayRuntime['approveOAuthAuthorize'] = async input => {
    const validated = await validateOAuthAuthorize(new URLSearchParams({
      client_id: input.clientId, redirect_uri: input.redirectUri, code_challenge: input.codeChallenge,
      scope: input.scope, profile: input.profileId, response_type: 'code', code_challenge_method: 'S256',
    }));
    if (!validated.ok) throw new GatewayError('INVALID_INPUT', validated.description);
    const code = randomToken('af_code_');
    await storage.saveOAuthCode({
      codeHash: hashToken(code), clientId: input.clientId, redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge, codeChallengeMethod: 'S256', scope: input.scope, profileId: validated.profileId,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    const redirect = new URL(input.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('iss', publicUrl);
    if (input.state !== undefined) redirect.searchParams.set('state', input.state);
    return { redirectUrl: redirect.href };
  };

  async function handleOAuthRegister(request: Request) {
    if ((await storage.listOAuthClients()).length >= 100) {
      return oauthError('invalid_client_metadata', 'Maximum registered OAuth clients reached', 429);
    }
    const parsed = registration.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !parsed.data.redirect_uris.every(validRedirect) || !parsed.data.grant_types.includes('authorization_code')) {
      return oauthError('invalid_client_metadata', 'Register a public authorization-code client with valid redirect URIs');
    }
    const { client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method } = parsed.data;
    const clientId = randomUUID();
    await storage.upsertOAuthClient({
      clientId, clientName: client_name, redirectUris: redirect_uris, grantTypes: grant_types,
      responseTypes: response_types, tokenEndpointAuthMethod: token_endpoint_auth_method, createdAt: new Date().toISOString(),
    });
    return Response.json({ ...parsed.data, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) }, {
      status: 201, headers: { 'Cache-Control': 'no-store' },
    });
  }

  async function handleOAuthToken(request: Request) {
    if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get('content-type') ?? '')) {
      return oauthError('invalid_request', 'Use form-encoded token parameters');
    }
    const params = new URLSearchParams(await request.text());
    const grant = params.get('grant_type');
    if ([...new Set(params.keys())].some(key => params.getAll(key).length > 1)) return oauthError('invalid_request', 'Duplicate token parameter');
    if (grant !== 'authorization_code' && grant !== 'refresh_token') return oauthError('unsupported_grant_type', 'Unsupported token grant');
    const client = await storage.getOAuthClient(params.get('client_id') ?? '');
    if (!client) return oauthError('invalid_client', 'Unknown OAuth client');
    if (!client.grantTypes.includes(grant)) return oauthError('unauthorized_client', 'Grant is disabled for this client');
    const raw = params.get(grant === 'authorization_code' ? 'code' : 'refresh_token');
    const invalid = () => oauthError('invalid_grant', 'The credential is invalid, expired, or already used');
    if (!raw) return invalid();
    const hash = hashToken(raw);
    if (exchanges.has(hash)) return invalid();
    exchanges.add(hash);
    try {
      let credential: OAuthAuthorizationCodeRecord | OAuthRefreshTokenRecord | null;
      if (grant === 'authorization_code') {
        const verifier = params.get('code_verifier') ?? '';
        if (!proofPattern.test(verifier)) return invalid();
        const code = await storage.consumeOAuthCode(hash);
        if (!code || params.get('redirect_uri') !== code.redirectUri) return invalid();
        const actual = createHash('sha256').update(verifier).digest('base64url');
        if (!timingSafeEqual(Buffer.from(hashToken(actual)), Buffer.from(hashToken(code.codeChallenge)))) return invalid();
        credential = code;
      } else {
        const refresh = await storage.getOAuthRefreshTokenByHash(hash);
        if (refresh?.revokedAt) {
          const revokedAt = new Date().toISOString();
          await storage.revokeOAuthRefreshTokensByClient(refresh.clientId, revokedAt);
          for (const tok of await storage.listClientTokens()) {
            if (tok.clientId === refresh.clientId && !tok.revokedAt) {
              await storage.revokeClientToken(tok.id, revokedAt);
            }
          }
          return invalid();
        }
        credential = refresh;
      }
      if (!credential || credential.clientId !== client.clientId || !(Date.parse(credential.expiresAt) > Date.now())) return invalid();
      const profile = await storage.getProfile(credential.profileId);
      if (!profile || profile.id !== credential.profileId) return invalid();
      const resource = params.get('resource');
      if (resource && !resourceMatches(resource, profile.id, profile.name)) return oauthError('invalid_target', 'Invalid MCP resource for this profile');
      if (params.has('scope') && params.get('scope') !== credential.scope) return oauthError('invalid_scope', 'Requested scope is unavailable');
      if (grant === 'refresh_token') await storage.revokeOAuthRefreshToken(hash, new Date().toISOString());
      const access = await issueClientToken(storage, {
        label: client.clientName, profileId: profile.id, clientId: client.clientId, scopes: [credential.scope],
      }, Date.now() + accessLifetime * 1000);
      let refresh: string | undefined;
      if (client.grantTypes.includes('refresh_token')) {
        refresh = randomToken('af_refresh_');
        await storage.saveOAuthRefreshToken({
          tokenHash: hashToken(refresh), clientId: client.clientId, profileId: profile.id, scope: credential.scope,
          expiresAt: new Date(Date.now() + refreshLifetime).toISOString(), createdAt: new Date().toISOString(),
        });
      }
      return Response.json({ access_token: access.token, refresh_token: refresh, token_type: 'Bearer',
        expires_in: accessLifetime, scope: credential.scope }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    } finally {
      exchanges.delete(hash);
    }
  }

  return {
    validateOAuthAuthorize, approveOAuthAuthorize, handleOAuthRegister, handleOAuthToken,
    async handleOAuthProtectedResourceMetadata(request: Request) {
      const path = new URL(request.url).pathname;
      const prefix = '/.well-known/oauth-protected-resource/mcp/';
      const profileSuffix = path.startsWith(prefix) ? path.slice(prefix.length) : '';
      const resource = profileSuffix ? `${publicUrl}/mcp/${profileSuffix}` : `${publicUrl}/mcp`;
      return Response.json({ resource, authorization_servers: [publicUrl],
        bearer_methods_supported: ['header'], scopes_supported: ['mcp'] });
    },
    async handleOAuthAuthorizationServerMetadata() {
      return Response.json({ issuer: publicUrl, authorization_endpoint: `${publicUrl}/oauth/authorize`,
        token_endpoint: `${publicUrl}/oauth/token`, registration_endpoint: `${publicUrl}/oauth/register`,
        code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
        authorization_response_iss_parameter_supported: true });
    },
  };
}
