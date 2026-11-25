import { z } from 'zod';

export const oauthProtocolParams = [
  'client_id', 'client_secret', 'redirect_uri', 'response_type', 'state', 'code_challenge',
  'code_challenge_method', 'code_verifier', 'grant_type', 'code', 'refresh_token', 'scope', 'resource',
];

const secretKey = /secret|password|token|credential/i;
const managedPrefixes = ['oauth.access:', 'oauth.refresh:', 'oauth.client_secret:'] as const;

export const managedOAuthSecretName = (prefix: (typeof managedPrefixes)[number], sourceId: string) => prefix + sourceId;

export function isManagedOAuthSecretName(name: string) {
  const lower = name.toLowerCase();
  return managedPrefixes.some(prefix => lower.startsWith(prefix));
}
const reservedParams = new Set(oauthProtocolParams);

export function isExtraOAuthParam(key: string) {
  return !reservedParams.has(key.toLowerCase()) && !secretKey.test(key);
}

export function isCredentialFreeOAuthUrl(url: URL) {
  return !url.username && !url.password && !url.href.includes('#')
    && ![...url.searchParams.keys()].some(key => secretKey.test(key));
}

const oauthUrl = z.url({ protocol: /^https?$/ }).refine(value => {
  try { return isCredentialFreeOAuthUrl(new URL(value)); } catch { return false; }
}, 'OAuth URLs must be free of fragments and credentials');

export const oauthAuthMethodSchema = z.enum(['none', 'client_secret_post', 'client_secret_basic']);

export const upstreamOAuthSchema = z.strictObject({
  authorizationEndpoint: oauthUrl.optional(),
  tokenEndpoint: oauthUrl.optional(),
  registrationEndpoint: oauthUrl.optional(),
  clientId: z.string().min(1).max(512).optional(),
  clientSecretName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, 'Invalid secret name').optional(),
  scopes: z.array(z.string().min(1).max(512)).max(64).optional(),
  extraAuthParams: z.record(z.string().min(1).max(64).refine(isExtraOAuthParam, 'Reserved OAuth parameter'), z.string().max(1024)).optional(),
  tokenEndpointAuthMethod: oauthAuthMethodSchema.optional(),
  resource: oauthUrl.optional(),
});
