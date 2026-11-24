import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GatewayError, type ClientTokenRecord, type ProfileRecord, type StorageAdapter } from '../types/index.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const randomToken = (prefix: string) => prefix + randomBytes(32).toString('base64url');

function equal(candidate: string | null, token: string) {
  return candidate !== null && timingSafeEqual(Buffer.from(hashToken(candidate), 'hex'), Buffer.from(hashToken(token), 'hex'));
}

function bearer(request: Request) {
  return request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/i)?.[1] ?? null;
}

export function authenticateOperator(request: Request, token: string) {
  return Boolean(token) && (equal(bearer(request), token) || equal(request.headers.get('x-operator-token'), token));
}

export async function issueClientToken(
  storage: StorageAdapter,
  input: { label: string; profileId: string; scopes?: string[] },
  expiresAt?: number,
): Promise<{ token: string; record: ClientTokenRecord }> {
  const token = randomToken(expiresAt === undefined ? 'af_tok_' : `af_tok_o${expiresAt.toString(36)}.`);
  const record = {
    id: randomUUID(), label: input.label, profileId: input.profileId,
    tokenPrefix: token.slice(0, 12), scopes: input.scopes ?? ['mcp'], createdAt: new Date().toISOString(),
  };
  await storage.upsertClientToken({ ...record, tokenHash: hashToken(token) });
  return { token, record };
}

export async function authenticateClient(request: Request, profileName: string | null, storage: StorageAdapter) {
  const raw = bearer(request);
  const record = raw && await storage.getClientTokenByHash(hashToken(raw));
  const expiry = raw?.match(/^af_tok_o([a-z0-9]+)\./)?.[1];
  if (!record || record.revokedAt || (expiry && parseInt(expiry, 36) <= Date.now())) {
    throw new GatewayError('UNAUTHORIZED', 'A valid bearer token is required');
  }
  const profile = await storage.getProfile(profileName ?? 'default');
  if (!profile || profile.id !== record.profileId || !record.scopes.includes('mcp')) {
    throw new GatewayError('FORBIDDEN', 'This token cannot access the requested MCP profile');
  }
  await storage.markClientTokenUsed(record.id, new Date().toISOString()).catch(() => {});
  return { profile, principal: record.id, expiry: expiry ? parseInt(expiry, 36) : undefined };
}

export type ClientIdentity = { profile: ProfileRecord; principal: string; expiry?: number };

export function challenge(publicUrl: string) {
  return `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`;
}
