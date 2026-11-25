import { GatewayError, type AuthTicketRecord, type GatewayMode, type SecretStore, type SourceRecord,
  type StorageAdapter } from '../types/index.js';
import { hashToken, randomToken } from './middleware.js';

export const MAX_SECRET_LENGTH = 16 * 1024;

export function sourceSecretNames(source: Pick<SourceRecord, 'authConfig'>) {
  const auth = source.authConfig;
  return [...new Set([
    ...(auth.oauth?.clientSecretName ? [auth.oauth.clientSecretName] : []),
    ...(auth.requiredSecrets ?? []), ...Object.values(auth.envMap ?? {}), ...(auth.secretName ? [auth.secretName] : []),
  ])];
}

function ticketUsable(record: AuthTicketRecord | null, source: SourceRecord): record is AuthTicketRecord {
  if (!record) return false;
  return Date.parse(record.expiresAt) > Date.now() && (!record.sourceUpdatedAt || record.sourceUpdatedAt === source.updatedAt);
}

export function createAuthHandoffs(storage: StorageAdapter, secrets: SecretStore, publicUrl: string, mode: GatewayMode) {
  return {
    async issue(source: SourceRecord, message: string) {
      const ticket = randomToken('af_ticket_');
      const reason = secrets.redact(message);
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      await storage.saveAuthTicket({ ticketHash: hashToken(ticket), sourceId: source.id, sourceUpdatedAt: source.updatedAt,
        reason, expiresAt, createdAt: new Date().toISOString() });
      return {
        sourceId: source.id, reason, expiresAt,
        authUrl: `${publicUrl}/auth/connect/${encodeURIComponent(source.id)}?ticket=${ticket}`,
        cliCommand: mode === 'local' && source.kind === 'cli_wrapper'
          ? source.authConfig.cliLoginCommand && secrets.redact(source.authConfig.cliLoginCommand) : undefined,
      };
    },
    async validate(sourceId: string, ticket: string) {
      const [source, record] = await Promise.all([storage.getSource(sourceId), storage.getAuthTicket(sourceId, hashToken(ticket))]);
      if (!source || !ticketUsable(record, source)) return { valid: false };
      return { valid: true, source, reason: record.reason };
    },
    async consumeForOAuth(source: SourceRecord, ticket: string, clientSecret?: string) {
      const name = source.authConfig.oauth?.clientSecretName;
      if (clientSecret !== undefined && (!name || !clientSecret.length || clientSecret.length > MAX_SECRET_LENGTH)) {
        throw new GatewayError('INVALID_INPUT', 'Unexpected or invalid OAuth client secret');
      }
      if (name && source.authConfig.oauth?.clientId && !clientSecret && !await secrets.get(name)) {
        throw new GatewayError('AUTH_REQUIRED', 'An OAuth client secret is required');
      }
      const record = await storage.consumeAuthTicket(source.id, hashToken(ticket));
      if (!ticketUsable(record, source)) throw new GatewayError('FORBIDDEN', 'Invalid or expired auth ticket');
      if (name && clientSecret) await secrets.set(name, clientSecret);
    },
    async complete(sourceId: string, ticket: string, values: Record<string, string>) {
      const source = await storage.getSource(sourceId);
      if (!source) throw new GatewayError('UNAUTHORIZED', 'Invalid auth ticket');
      const names = sourceSecretNames(source);
      const entries = Object.entries(values);
      if (!entries.length || entries.some(([name, value]) => !names.includes(name) || typeof value !== 'string'
        || !value.length || value.length > MAX_SECRET_LENGTH)) {
        throw new GatewayError('INVALID_INPUT', 'Unexpected, empty, or oversized source credential');
      }
      const record = await storage.consumeAuthTicket(sourceId, hashToken(ticket));
      if (!ticketUsable(record, source)) throw new GatewayError('UNAUTHORIZED', 'Invalid or expired auth ticket');
      for (const [name, value] of entries) await secrets.set(name, value);
      return source;
    },
  };
}
